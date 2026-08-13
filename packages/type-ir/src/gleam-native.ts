// Gleam (https://gleam.run/) type-declaration projector. No prior survey of
// Gleam exists in this repo's docs/design/type-ir-survey.md — the following
// is established directly from Gleam's own documentation (The Gleam Language
// Tour, https://tour.gleam.run/, and gleam_stdlib's hexdocs) rather than
// carried over from another projector:
//
//   - Gleam's ONLY structural declaration mechanism is the custom type:
//     `pub type Name(a, b) { Ctor1(field: T) Ctor2(other: U) }`. There is no
//     separate "record" keyword — a record is just a custom type with a
//     single constructor and labelled fields
//     (https://tour.gleam.run/data-types/records/) — and there is no
//     anonymous/inline structural type of any kind: no inline `{ field: T }`
//     object-literal type, no inline union. Every `object`, `enum`, and
//     `union` TypeRef therefore has to be hoisted into its own named
//     top-level declaration, even when nested inside a field — the same
//     constraint rust-serde.ts's `bareType`/`decls` hoisting handles for Rust
//     (which also has no anonymous struct/enum), extended here to cover
//     records too (Elm, rust-serde.ts's structural analogue for hoisting, still
//     has inline anonymous records; Gleam does not).
//   - Generics: `pub type Box(a) { Box(value: a) }` — type parameters are
//     lowercase names in parens after the type name
//     (https://tour.gleam.run/data-types/custom-types/). Not used by this
//     projector's own generated declarations (TypeRef carries no notion of a
//     type PARAMETER, only concrete structure), but relevant to how `Option`/
//     `List`/`Dict` below are themselves generic.
//   - `Option(a)` (`Some(a)` / `None`) and `Result(value, error)` (`Ok(value)`
//     / `Error(error)`) are ordinary custom types from `gleam/option` and
//     Gleam's prelude respectively — Gleam has no null/undefined and no
//     built-in nullable sugar
//     (https://tour.gleam.run/standard-library/option-module/).
//   - Tuples: `#(a, b, ...)` at both value and type level, arbitrary arity
//     (https://tour.gleam.run/data-types/tuples/) — unlike Elm's 2/3-element
//     cap, no degrade-at-high-arity is needed.
//   - `List(a)` is Gleam's only sequence type; `Dict(k, v)` (from `gleam/dict`)
//     is its map type.
//   - `Dynamic` (from `gleam/dynamic`) is Gleam's escape hatch for data whose
//     type isn't known at compile time — the natural target for `unknown`,
//     matching the "opaque value" degrade convention every other projector
//     in this codebase uses for its own untyped-value construct.
//   - No subtyping, no interfaces/traits, no inheritance: a `type` is always
//     a leaf in a flat namespace. `intersection`, `instance`, and `interface`
//     all have to degrade or synthesize accordingly (see their handlers
//     below).
import { resolve, type TypeRef, type TypeShape } from "./index.ts";
import { toPascalCaseStripSeparators, toSnakeCaseStripSeparators } from "./codegen-helpers.ts";

// ============================================================================
// naming — Gleam requires snake_case for field labels/values, PascalCase for
// type names and constructors (https://tour.gleam.run/basics/custom-types/:
// "Both the type name and the names of the constructors start with uppercase
// letters"; labelled fields in every example in the Tour/stdlib are
// snake_case). IR field/member names are wire-format strings (arbitrary
// camelCase/kebab-case/whatever the source used) — converted here the same
// way rust-serde.ts converts for Rust's identical casing convention, but
// WITHOUT an equivalent to serde's `#[serde(rename = "...")]`: this projector
// emits type declarations only (no codec), so there is nothing to keep a
// wire-format name in sync with — the converted identifier is simply the
// declaration.
// ============================================================================

// Gleam's reserved words (collected from the Gleam Language Tour's keyword
// usages — `type`, `pub`, `fn`, `let`, `case`, `if`, `use`, `import`, `as`,
// `const`, `opaque`, `todo`, `panic`, `echo`, `assert` — Gleam has no
// documented raw-identifier escape for a colliding name, unlike Rust's
// `r#ident`, so a collision is resolved with a trailing underscore, the same
// safe fallback used where no native escape exists).
const GLEAM_KEYWORDS = new Set([
  "as",
  "assert",
  "auto",
  "case",
  "const",
  "delegate",
  "derive",
  "echo",
  "else",
  "fn",
  "if",
  "implement",
  "import",
  "let",
  "macro",
  "opaque",
  "panic",
  "pub",
  "test",
  "todo",
  "type",
  "use",
]);

function escapeGleamIdent(snakeName: string): string {
  return GLEAM_KEYWORDS.has(snakeName) ? `${snakeName}_` : snakeName;
}

function fieldLabel(name: string): string {
  return escapeGleamIdent(toSnakeCaseStripSeparators(name));
}

// ============================================================================
// bare (inline) type-expression rendering
// ============================================================================

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string;

const leaf =
  (type: string): Converter =>
  () =>
    type;

const handlers: Record<string, Converter> = {
  boolean: leaf("Bool"),
  number: leaf("Float"),
  integer: leaf("Int"),
  string: leaf("String"),
  // Gleam has no null/undefined — `Nil` is its single unit-like "no
  // meaningful value" value, the same role `()` plays in Elm/Rust's own leaf
  // handlers for `null`/`void`.
  null: leaf("Nil"),
  void: leaf("Nil"),
  // `Dynamic` (gleam/dynamic) — see file header.
  unknown: leaf("Dynamic"),
  // Gleam has no bottom/uninhabited type (no `Never`/`Infallible` analogue in
  // its prelude or stdlib) — degrades to `Nil`, the same honest-degrade
  // convention other projectors use when the target has no direct construct;
  // this one is lossier than most (Elm's `Never` and Rust's
  // `std::convert::Infallible` are both genuinely uninhabited, `Nil` is not),
  // flagged here rather than silently presented as an exact fit.
  never: leaf("Nil"),
  // A class instance carries only nominal identity (className/declarationFile),
  // never structure (see type-ir's TypeKinds.instance doc comment) —
  // referenced by className, trusting a type of that name is declared/
  // imported elsewhere, same convention rust-serde.ts's `instance` uses.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" };
    return `List(${toGleamType(s.element)})`;
  },
  // No streaming construct in Gleam's type system — materializes to List(T),
  // same honest-degrade convention rust-serde.ts/protobuf.ts use for `stream`.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" };
    return `List(${toGleamType(s.element)})`;
  },
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" };
    return `List(${toGleamType(s.element)})`;
  },
  // `#(a, b, ...)` — Gleam tuples have no arity cap (unlike Elm's 2/3-element
  // limit), so every arity renders directly.
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" };
    return `#(${s.elements.map(toGleamType).join(", ")})`;
  },
  // Dict(k, v) from gleam/dict.
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" };
    return `Dict(${toGleamType(s.key)}, ${toGleamType(s.value)})`;
  },
  // No naming context here — see the `bareType`/hoisting path below for the
  // real (named) declaration-generating case used inside field/element
  // positions that DO carry a name hint.
  object: (_shape, meta) =>
    typeof meta.typeName === "string" ? toPascalCaseStripSeparators(meta.typeName) : "Dynamic",
  enum: (_shape, meta) =>
    typeof meta.enumName === "string" ? toPascalCaseStripSeparators(meta.enumName) : "Dynamic",
  union: (_shape, meta) =>
    typeof meta.typeName === "string" ? toPascalCaseStripSeparators(meta.typeName) : "Dynamic",
  // Gleam has no literal-value type — degrades to the literal's base type,
  // the same lossy convention rust-serde.ts's `literal` handler uses.
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" };
    if (s.value === null) return "Nil";
    if (typeof s.value === "string") return "String";
    if (typeof s.value === "boolean") return "Bool";
    return Number.isInteger(s.value) ? "Int" : "Float";
  },
  ref: (shape) => toPascalCaseStripSeparators((shape as TypeShape & { kind: "ref" }).target),
  // No struct-merge/mixin construct in Gleam, and (unlike elm-json.ts, which
  // can splice merged fields into an INLINE anonymous record) no anonymous
  // record syntax to splice a merge into even if the field types were
  // combined — degrades to the first member's own rendering, the same
  // lossy convention rust-serde.ts's `intersection` handler uses for the
  // identical reason (Rust's field-position hoisting doesn't special-case
  // `intersection` either).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" };
    const [first] = s.members;
    return first === undefined ? "Dynamic" : toGleamType(first);
  },
  // Gleam function TYPES: `fn(ParamType, ...) -> ReturnType` — no parameter
  // names in type position (https://tour.gleam.run/functions/functions/'s
  // `fn` syntax, types-only form). `thisType`, if present, has no receiver
  // position in Gleam (functions are not methods of a type) — prepended as
  // a leading parameter, the same "no separate receiver syntax" degrade
  // typescript.ts/flow-native.ts use for `this` in structural function
  // types.
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" };
    const params = [
      ...(s.thisType === undefined ? [] : [s.thisType]),
      ...s.params.map((p) => p.type),
    ];
    return `fn(${params.map(toGleamType).join(", ")}) -> ${toGleamType(s.returnType)}`;
  },
  // `method` has no explicit entry — falls back to `function`'s fn(...) ->
  // R syntax via `registerParent("method", "function")` in index.ts (same
  // fallback rust-serde.ts/flow-native.ts rely on for `method`).
  //
  // Gleam has no interface/trait/mixin construct — but unlike `instance`
  // (pure nominal identity, no structure to preserve) an `interface`'s
  // `methods` map IS expressible: Gleam functions are first-class values, so
  // a record of function-typed fields is a faithful (if unenforced —
  // there's no vtable/dispatch, just a plain value) rendering rather than an
  // opaque degrade. Hoisted like `object` — see `bareType` below.
  interface: (_shape, meta) =>
    typeof meta.typeName === "string" ? toPascalCaseStripSeparators(meta.typeName) : "Dynamic",
};

/** `meta.optional` (may be absent from the wire) and `meta.nullable` (present
 * but may carry JSON `null`) both collapse onto Gleam's single `Option(T)` —
 * Gleam has no null/undefined at all, so there is no second representation
 * for "missing key" distinct from "null value" the way JSON/TS-flavored
 * projectors might reach for; both map onto the one `Option` wrap rather than
 * `Option(Option(T))`. This mirrors rust-serde.ts's identical collapse of the
 * same two flags onto Rust's single `Option<T>` for the same reason (no
 * missing-vs-null distinction in the target). */
export function toGleamType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers);
  const base = converter === undefined ? "Dynamic" : converter(ref.shape, ref.meta);
  return ref.meta.optional === true || ref.meta.nullable === true ? `Option(${base})` : base;
}

// ============================================================================
// named-declaration hoisting — every `object`/`enum`/`union`/`interface`
// TypeRef reached from a field, array/list element, tuple slot, or map key/
// value gets its own top-level `pub type` declaration (Gleam has no inline
// structural syntax at all — see file header), collected into `decls` in
// first-encountered order. Mirrors rust-serde.ts's `bareType`/`decls`
// pattern, the closest existing structural analogue (Rust also lacks
// anonymous struct/enum syntax).
// ============================================================================

function bareType(nameHint: string, ref: TypeRef, decls: string[]): string {
  const kind = ref.shape.kind;
  const name = toPascalCaseStripSeparators(nameHint);
  if (kind === "object") {
    decls.push(buildRecord(name, ref, decls));
    return name;
  }
  if (kind === "enum") {
    decls.push(buildEnum(name, ref));
    return name;
  }
  if (kind === "union") {
    decls.push(
      typeof ref.meta.discriminator === "string"
        ? buildTaggedUnion(name, ref, decls)
        : buildPositionalUnion(name, ref, decls),
    );
    return name;
  }
  if (kind === "interface") {
    decls.push(buildInterfaceRecord(name, ref));
    return name;
  }
  if (kind === "array" || kind === "stream" || kind === "page") {
    const s = ref.shape as TypeShape & { kind: "array" | "stream" | "page" };
    const elementKind = s.element.shape.kind;
    if (
      elementKind === "object" ||
      elementKind === "enum" ||
      elementKind === "union" ||
      elementKind === "interface"
    ) {
      return `List(${bareType(nameHint, s.element, decls)})`;
    }
    return `List(${toGleamType(s.element)})`;
  }
  const converter = resolve(kind, handlers);
  return converter === undefined ? "Dynamic" : converter(ref.shape, ref.meta);
}

/** Field type honoring `optional`/`nullable`'s single-`Option` collapse (see
 * `toGleamType`), but hoisting nested object/enum/union/interface under a
 * name derived from the field itself. */
function fieldType(nameHint: string, fieldRef: TypeRef, decls: string[]): string {
  const bare = bareType(nameHint, fieldRef, decls);
  return fieldRef.meta.optional === true || fieldRef.meta.nullable === true
    ? `Option(${bare})`
    : bare;
}

function docComment(meta: Readonly<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  const description = typeof meta.description === "string" ? meta.description : undefined;
  if (description !== undefined) {
    for (const line of description.split("\n")) lines.push(`/// ${line}`);
  }
  const deprecated = meta.deprecated;
  if (deprecated === true) {
    lines.push(`@deprecated("Deprecated.")`);
  } else if (typeof deprecated === "string") {
    lines.push(`@deprecated(${JSON.stringify(deprecated)})`);
  }
  return lines;
}

function buildRecord(name: string, ref: TypeRef, decls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "object" };
  const entries = Object.entries(shape.fields);
  const lines = [...docComment(ref.meta), `pub type ${name} {`];
  if (entries.length === 0) {
    lines.push(`  ${name}`);
  } else {
    const fields = entries.map(
      ([fieldName, fieldRef]) =>
        `${fieldLabel(fieldName)}: ${fieldType(`${name}${toPascalCaseStripSeparators(fieldName)}`, fieldRef, decls)}`,
    );
    lines.push(`  ${name}(${fields.join(", ")})`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** A record of function-typed fields — see the `interface` handler above for
 * why this is a faithful rendering rather than an opaque degrade. */
function buildInterfaceRecord(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "interface" };
  const entries = Object.entries(shape.methods);
  const lines = [...docComment(ref.meta), `pub type ${name} {`];
  const fields = entries.map(
    ([methodName, methodRef]) => `${fieldLabel(methodName)}: ${toGleamType(methodRef)}`,
  );
  lines.push(fields.length === 0 ? `  ${name}` : `  ${name}(${fields.join(", ")})`);
  lines.push("}");
  return lines.join("\n");
}

function buildEnum(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "enum" };
  const lines = [...docComment(ref.meta), `pub type ${name} {`];
  for (const member of shape.members) {
    lines.push(`  ${toPascalCaseStripSeparators(member)}`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** A tagged union: every variant is an `object` sharing `meta.discriminator`
 * as a literal-string field (same convention elm-json.ts's/rust-serde.ts's
 * own tagged-union renderers key off). Renders one constructor per variant,
 * named from the discriminant's literal value, carrying the variant's
 * remaining fields as labelled constructor fields — the discriminator field
 * itself is dropped, since the constructor tag already encodes it. Unlike
 * elm-json.ts's analogous `renderTaggedUnion` (which returns `string |
 * undefined` so its caller can fall through to the positional-union form),
 * this function always succeeds: `toGleam`/`bareType` only call it once
 * `meta.discriminator` is confirmed to be a string, and a variant that
 * doesn't itself carry a literal-string value for that field falls back to a
 * synthesized `VariantN` name rather than aborting the whole union. */
function buildTaggedUnion(name: string, ref: TypeRef, decls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "union" };
  const discriminator = ref.meta.discriminator as string;
  const lines = [...docComment(ref.meta), `pub type ${name} {`];

  shape.variants.forEach((variant, i) => {
    if (variant.shape.kind !== "object") {
      lines.push(`  ${name}Variant${i}(${bareType(`${name}Variant${i}`, variant, decls)})`);
      return;
    }
    const variantShape = variant.shape as TypeShape & { kind: "object" };
    const tagField = variantShape.fields[discriminator];
    const tagValue =
      tagField !== undefined &&
      tagField.shape.kind === "literal" &&
      typeof (tagField.shape as { value: unknown }).value === "string"
        ? ((tagField.shape as { value: string }).value as string)
        : `Variant${i}`;
    const ctorName = toPascalCaseStripSeparators(tagValue);
    const otherFields = Object.entries(variantShape.fields).filter(([k]) => k !== discriminator);
    if (otherFields.length === 0) {
      lines.push(`  ${ctorName}`);
      return;
    }
    const fields = otherFields.map(
      ([fieldName, fieldRef]) =>
        `${fieldLabel(fieldName)}: ${fieldType(`${name}${ctorName}${toPascalCaseStripSeparators(fieldName)}`, fieldRef, decls)}`,
    );
    lines.push(`  ${ctorName}(${fields.join(", ")})`);
  });

  lines.push("}");
  return lines.join("\n");
}

/** The general (untagged) union fallback — one positionally-named
 * constructor per variant (`Variant0`, `Variant1`, ...), each wrapping that
 * variant's own rendered type as a single unlabelled constructor argument.
 * Same synthesized-name convention rust-serde.ts's `buildUntaggedEnum`/
 * elm-json.ts's `renderPositionalUnion` use for their own no-native-untagged-
 * union targets — Gleam, like Rust and Elm, has no anonymous/untagged sum
 * type, so a union with no shared discriminator has no encoding other than a
 * synthesized tag. */
function buildPositionalUnion(name: string, ref: TypeRef, decls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "union" };
  const lines = [...docComment(ref.meta), `pub type ${name} {`];
  shape.variants.forEach((variant, i) => {
    const ctorName = `Variant${i}`;
    lines.push(`  ${ctorName}(${bareType(`${name}${ctorName}`, variant, decls)})`);
  });
  lines.push("}");
  return lines.join("\n");
}

/**
 * Lower a `TypeRef` to idiomatic Gleam source. With `name`, emits a named
 * top-level `pub type` declaration — a record (single labelled constructor)
 * for `object`, a record-of-functions for `interface`, a nullary-constructor
 * custom type for `enum`, a tagged or positional custom type for `union` —
 * preceded by any declarations hoisted out of nested fields/elements (Gleam
 * has no anonymous structural syntax at all — see the file header comment).
 * For any other kind (primitives, `array`, `tuple`, `map`, `ref`, ...), emits
 * a type alias (`pub type Name = ...`) to the inline expression.
 *
 * Without `name`, returns just the inline type expression for `ref`
 * (`toGleamType`) — the building block other projections (or a caller
 * assembling its own declarations) can plug into their own source.
 */
export function toGleam(ref: TypeRef, name?: string): string {
  if (name === undefined) return toGleamType(ref);

  const decls: string[] = [];
  const typeName = toPascalCaseStripSeparators(name);
  const kind = ref.shape.kind;
  let mainDecl: string;
  if (kind === "object") {
    mainDecl = buildRecord(typeName, ref, decls);
  } else if (kind === "interface") {
    mainDecl = buildInterfaceRecord(typeName, ref);
  } else if (kind === "enum") {
    mainDecl = buildEnum(typeName, ref);
  } else if (kind === "union") {
    mainDecl =
      typeof ref.meta.discriminator === "string"
        ? buildTaggedUnion(typeName, ref, decls)
        : buildPositionalUnion(typeName, ref, decls);
  } else {
    mainDecl = [...docComment(ref.meta), `pub type ${typeName} = ${toGleamType(ref)}`].join("\n");
  }

  return [...decls, mainDecl].join("\n\n");
}
