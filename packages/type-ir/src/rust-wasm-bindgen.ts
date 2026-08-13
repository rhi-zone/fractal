import { resolve, type TypeRef, type TypeShape } from "./index.ts";
import {
  isA,
  quote,
  toPascalCaseStripSeparators,
  toSnakeCaseStripSeparators,
} from "./codegen-helpers.ts";

// Rust codegen targeting wasm-bindgen (https://wasm-bindgen.github.io/wasm-bindgen/) —
// `#[wasm_bindgen]`-annotated structs/enums/functions that JS can call into
// once compiled to wasm. Generated snippets assume the caller has
// `use wasm_bindgen::prelude::*;` in scope, same convention rust-serde.ts
// uses for `use serde::{Serialize, Deserialize};` (declarations only, no
// import lines emitted).
//
// This is deliberately a SUBSET of type-ir's kinds. wasm-bindgen's ABI
// boundary — confirmed against the project's guide
// (https://github.com/rustwasm/wasm-bindgen, guide/src/reference/types/*
// and guide/src/reference/attributes/on-rust-exports/*, fetched 2026-08-03)
// — only crosses a fixed set of shapes:
//   - numeric widths, bool, String, JsValue, Option<T>, Result<T, E> as a
//     *return* type only, Vec<T>/Box<[T]> (T restricted to JsValue/imported
//     JS types/exported Rust types/String, plus numeric widths via
//     "boxed number slices" — bool is NOT in either list), and
//     `#[wasm_bindgen]`-exported struct/enum types.
//   - Structs need every crossed field `pub`; non-`Copy` fields (String,
//     Vec<_>, nested structs) need `#[wasm_bindgen(getter_with_clone)]`
//     (struct- or field-level), which requires the field type to impl
//     `Clone` — hence every struct here carries `#[derive(Clone)]`.
//   - Enums only cross cleanly when fieldless (C-style / string-discriminant
//     — `Variant = "wireValue"`). Newer wasm-bindgen versions support
//     "dynamic unions" (single-field tuple variants + order-dependent
//     runtime-witness dispatch), but that mechanism doesn't fit type-ir's
//     `union` kind: type-ir's tagged-union variants are multi-field
//     *objects*, not bare wrapped types, and an untagged union has no
//     natural variant ordering to dispatch on. See the `union` handler
//     below for what's thrown and why.
//   - HashMap<K, V>, arbitrary tuples, and nested containers (Vec<Vec<T>>,
//     Vec<HashMap<..>>, ...) are NOT directly ABI-crossable — wasm-bindgen's
//     own docs name these exact cases as needing the `serde-wasm-bindgen`
//     crate (JsValue + serde) instead, which is a real added dependency,
//     not a decision this projector makes on the caller's behalf.
//
// Kinds outside this subset THROW rather than degrade to a lossy
// placeholder — unlike every other projector in this package (rust-serde.ts,
// protobuf.ts, json-schema.ts, ...), which degrade genuinely-unsupported
// kinds to an honest opaque placeholder (`serde_json::Value`,
// `google.protobuf.Any`, `x-function: true`) because their target formats
// are pure data shapes with no compiled-code obligation. wasm-bindgen's
// output has to compile and its ABI boundary is a hard wall, not a
// best-effort data shape — silently emitting `JsValue` for, say, a `map`
// would compile but misrepresent a structured key/value type as opaque, and
// silently emitting Rust for an untagged union without doing dynamic-union
// dispatch bookkeeping would compile but be wrong at runtime. Throwing
// forces the caller to make the tradeoff explicitly (add
// serde-wasm-bindgen, restructure the type, or hand-write the binding).

const RUST_KEYWORDS = new Set([
  "type",
  "struct",
  "enum",
  "fn",
  "let",
  "mut",
  "ref",
  "self",
  "super",
  "crate",
  "mod",
  "pub",
  "use",
  "impl",
  "trait",
  "where",
  "loop",
  "while",
  "for",
  "if",
  "else",
  "match",
  "return",
  "break",
  "continue",
  "as",
  "in",
  "move",
  "box",
  "dyn",
  "abstract",
  "async",
  "await",
  "become",
  "const",
  "do",
  "extern",
  "final",
  "macro",
  "override",
  "priv",
  "static",
  "try",
  "typeof",
  "unsafe",
  "unsized",
  "virtual",
  "yield",
  "union",
]);

function escapeRustIdent(rustName: string): string {
  return RUST_KEYWORDS.has(rustName) ? `r#${rustName}` : rustName;
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string;

const leaf =
  (type: string): Converter =>
  () =>
    type;

/** A kind with no direct wasm-bindgen ABI mapping. Throws instead of
 * degrading — see the file-level doc comment for why this projector's
 * convention differs from every other projector in this package. */
function unsupported(kind: string, reason: string): Converter {
  return () => {
    throw new Error(`toWasmBindgen: "${kind}" has no direct wasm-bindgen mapping — ${reason}`);
  };
}

// Base inline-expression handlers — the wasm-bindgen analogue of
// rust-serde.ts's `handlers` map. Used for type positions with no naming
// context of their own (Vec elements not hoisted, ref/instance targets);
// `bareType` below is the field/param-context counterpart that hoists a
// named struct/enum declaration when one is needed.
const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("f64"),
  integer: leaf("i64"),
  int8: leaf("i8"),
  int16: leaf("i16"),
  int32: leaf("i32"),
  int64: leaf("i64"),
  uint8: leaf("u8"),
  uint16: leaf("u16"),
  uint32: leaf("u32"),
  uint64: leaf("u64"),
  float32: leaf("f32"),
  float64: leaf("f64"),
  string: leaf("String"),
  uuid: leaf("String"),
  uri: leaf("String"),
  email: leaf("String"),
  datetime: leaf("String"),
  date: leaf("String"),
  time: leaf("String"),
  duration: leaf("String"),
  bytes: leaf("Vec<u8>"),
  null: leaf("()"),
  void: leaf("()"),
  // JsValue is wasm-bindgen's actual "any JS value" primitive — a faithful,
  // fully ABI-crossable representation of "unknown", not a lossy escape
  // hatch the way rust-serde.ts's `serde_json::Value` fallback is for a
  // pure-data format.
  unknown: leaf("JsValue"),
  never: unsupported(
    "never",
    "no wasm-bindgen-documented Rust type represents the bottom/uninhabited type across the ABI (std::convert::Infallible, rust-serde.ts's own degrade target, is not among wasm-bindgen's documented crossable types)",
  ),
  // Purely nominal — referenced by className, trusting a `#[wasm_bindgen]`
  // struct/enum of that name is declared/exported elsewhere. Same
  // "Exported Rust types" ABI category Vec<T>/Option<T> accept.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => `Vec<${vecElementType((shape as TypeShape & { kind: "array" }).element)}>`,
  // No streaming construct crosses the wasm-bindgen ABI — materializes to
  // Vec<T>, same honest-degrade convention rust-serde.ts uses (a stream's
  // element type is still the closest structural analogue once the
  // asynchrony/laziness itself can't be preserved). Vec<T> genuinely IS a
  // valid, ABI-crossable representation, so this isn't a lossy placeholder.
  stream: (shape) => `Vec<${vecElementType((shape as TypeShape & { kind: "stream" }).element)}>`,
  page: (shape) => `Vec<${vecElementType((shape as TypeShape & { kind: "page" }).element)}>`,
  tuple: unsupported(
    "tuple",
    'Rust tuples are not among wasm-bindgen\'s documented ABI-crossable types (see guide/src/reference/types/*.md — no "tuple" entry); restructure as a named struct with named fields, or use serde-wasm-bindgen',
  ),
  map: unsupported(
    "map",
    "no direct HashMap<K, V> ABI crossing — wasm-bindgen's own guide (arbitrary-data-with-serde.md) names HashMap as one of the exact cases requiring the serde-wasm-bindgen crate as an added dependency; js_sys::Map is available for an opaque JS Map handle but doesn't carry type-ir's key/value element types",
  ),
  // No naming context here — see `bareType`'s hoisting path for the named
  // (real) struct-generating case. Anonymous object falls back to JsValue
  // (an honest "opaque object" representation, not a lossy struct-in-name-only).
  object: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "JsValue"),
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" };
    return typeof meta.enumName === "string" ? meta.enumName : `Enum${s.members.length}`;
  },
  union: unsupported(
    "union",
    "wasm-bindgen enums cross the ABI cleanly only when fieldless (string/numeric discriminants), or via the newer \"dynamic union\" mechanism restricted to single-field tuple variants with order-dependent runtime-witness dispatch. type-ir's tagged-union variants are multi-field objects (not bare wrapped types) and untagged unions carry no natural dispatch order — neither maps onto wasm-bindgen's enum forms without redesigning the variant shapes by hand, or depending on serde-wasm-bindgen to cross as JsValue",
  ),
  // Same base-scalar degrade rust-serde.ts uses — unlike that file's other
  // degrades, this one stays fully ABI-crossable (bool/String/i64/f64/())
  // rather than an opaque placeholder, so it's a legitimate simplification.
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" };
    if (s.value === null) return "()";
    if (typeof s.value === "string") return "String";
    if (typeof s.value === "boolean") return "bool";
    return Number.isInteger(s.value) ? "i64" : "f64";
  },
  // Name reference — same caveat as `instance` above (trusts a declaration
  // exists elsewhere with this exact name).
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  intersection: unsupported(
    "intersection",
    "no struct-merge/mixin construct in Rust. rust-serde.ts degrades this by taking the first member's type and silently dropping the rest — acceptable for a pure-data format, but silently dropping fields across a compiled JS/Rust ABI boundary would misrepresent the binding's actual shape, so this is surfaced explicitly instead",
  ),
  // Handled structurally by `toWasmBindgen`/`buildFunction` (a callable
  // needs a name to become a `#[wasm_bindgen] pub fn`) — not meaningful as
  // a bare inline type expression (e.g. a struct field holding a callback
  // would need js_sys::Function, which isn't verified/implemented here).
  function: unsupported(
    "function",
    "a callable TypeRef only becomes valid wasm-bindgen output as a named top-level declaration (see toWasmBindgen(ref, name)); as an inline type (e.g. a struct field holding a JS callback) it would need js_sys::Function, which this projector does not implement",
  ),
  method: unsupported(
    "method",
    "a method (function with a `thisType` receiver) belongs inside a #[wasm_bindgen] impl block tied to its receiver's own exported struct — that requires correlating the method with its receiver's struct declaration, which a single TypeRef->string conversion can't do. Project the containing type's struct first, then hand-write (or separately generate) the impl block for each of its `interface.methods` entries",
  ),
  interface: unsupported(
    "interface",
    "no service/trait-object construct crosses the wasm-bindgen ABI directly — an `interface`'s methods would each need their own #[wasm_bindgen] impl block on a concrete receiver type (see the `method` entry above), which isn't something a single TypeRef can express",
  ),
};

/** Kinds allowed as a Vec<T>/Box<[T]> element per wasm-bindgen's documented
 * ABI-crossable categories (guide/src/reference/types/boxed-slices.md +
 * boxed-number-slices.md): JsValues, imported JS types, exported Rust types
 * (struct/enum/instance/ref), Strings, and numeric widths. Notably `bool` is
 * NOT in either documented list, and nested containers (array-of-array,
 * array-of-bytes i.e. Vec<Vec<u8>>, array-of-map, ...) are excluded even
 * though their non-Vec inline type would otherwise resolve fine. */
function vecElementType(element: TypeRef): string {
  const kind = element.shape.kind;
  if (kind === "boolean") {
    throw new Error(
      'toWasmBindgen: Vec<bool> has no documented wasm-bindgen ABI mapping — wasm-bindgen\'s Vec<T>/Box<[T]> guide lists JsValue/imported JS types/exported Rust types/String, plus numeric widths via "boxed number slices", but not bool; wrap elements as JsValue (e.g. via serde-wasm-bindgen) or model as Vec<u8>/a bitset instead',
    );
  }
  if (kind === "array" || kind === "stream" || kind === "page") {
    throw new Error(
      'toWasmBindgen: nested Vec<Vec<T>> (an "array"/"stream"/"page" element inside another) is not directly ABI-crossable — wasm-bindgen\'s own guide (arbitrary-data-with-serde.md) cites this exact shape as requiring the serde-wasm-bindgen crate',
    );
  }
  if (kind === "bytes") {
    throw new Error(
      'toWasmBindgen: Vec<Vec<u8>> (an "array" of "bytes") is not directly ABI-crossable, for the same reason nested Vec<Vec<T>> generally isn\'t — requires serde-wasm-bindgen',
    );
  }
  return toWasmBindgenType(element);
}

/** Inline wasm-bindgen Rust type expression for `ref`, wrapping in
 * `Option<T>` when `meta.optional` or `meta.nullable` is set (both collapse
 * onto Rust's single `Option<T>`, same convention rust-serde.ts uses — JS
 * doesn't distinguish "missing"/"null" at wasm-bindgen's Option<T> boundary
 * either). Throws for any kind with no direct ABI mapping — see the
 * `unsupported` handlers above and the file-level doc comment. */
export function toWasmBindgenType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers);
  if (converter === undefined) {
    throw new Error(
      `toWasmBindgen: unhandled kind "${ref.shape.kind}" (no handler and no known ancestor)`,
    );
  }
  const base = converter(ref.shape, ref.meta);
  const optional = ref.meta.optional === true || ref.meta.nullable === true;
  return optional ? `Option<${base}>` : base;
}

/**
 * Field/param-context inline type: same as `toWasmBindgenType`, except
 * `object`/`enum` hoist a fresh named declaration into `decls` under
 * `nameHint` (PascalCase) instead of falling back to a generic placeholder —
 * mirroring rust-serde.ts's `bareType` (Rust, like FlatBuffers, has no
 * anonymous nested struct/enum syntax). `Vec<object>`/`Vec<enum>` hoist the
 * element type under the same name hint and wrap it in `Vec<...>`. `union`
 * still throws even in this context — see the `union` handler above.
 */
function bareType(nameHint: string, ref: TypeRef, decls: string[]): string {
  const kind = ref.shape.kind;
  if (isA(kind, "object")) {
    decls.push(buildStruct(nameHint, ref, decls));
    return nameHint;
  }
  if (kind === "enum") {
    decls.push(buildEnum(nameHint, ref));
    return nameHint;
  }
  if (kind === "array" || kind === "stream" || kind === "page") {
    const s = ref.shape as TypeShape & { kind: "array" | "stream" | "page"; element: TypeRef };
    const elementKind = s.element.shape.kind;
    if (isA(elementKind, "object") || elementKind === "enum") {
      return `Vec<${bareType(nameHint, s.element, decls)}>`;
    }
    return `Vec<${vecElementType(s.element)}>`;
  }
  const converter = resolve(kind, handlers);
  if (converter === undefined) {
    throw new Error(`toWasmBindgen: unhandled kind "${kind}" (no handler and no known ancestor)`);
  }
  return converter(ref.shape, ref.meta);
}

/** Field type + `js_name`/`readonly` attribute lines needed alongside it.
 * `meta.readonly` maps directly onto wasm-bindgen's own `readonly` field
 * attribute (both mean "no JS-side setter"). A field/param name that
 * doesn't round-trip through `toSnakeCase` gets `#[wasm_bindgen(js_name =
 * "...")]`, mirroring rust-serde.ts's `#[serde(rename = "...")]` for the
 * same reason (wire-format name preserved, Rust identifier stays idiomatic) —
 * confirmed via wasm-bindgen's js_name.md, which documents this exact
 * attribute on both struct fields and function/method parameters. */
function fieldType(
  fieldName: string,
  fieldRef: TypeRef,
  decls: string[],
): { type: string; rustName: string; ident: string; attrs: string[] } {
  const bare = bareType(toPascalCaseStripSeparators(fieldName), fieldRef, decls);
  const optional = fieldRef.meta.optional === true || fieldRef.meta.nullable === true;
  const type = optional ? `Option<${bare}>` : bare;
  const rustName = toSnakeCaseStripSeparators(fieldName);
  const ident = escapeRustIdent(rustName);
  const attrs: string[] = [];
  if (rustName !== fieldName || ident !== rustName) attrs.push(`js_name = ${quote(fieldName)}`);
  if (fieldRef.meta.readonly === true) attrs.push("readonly");
  return { type, rustName, ident, attrs };
}

function docComment(indent: string, meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`${indent}/// ${meta.description}`] : [];
}

// `#[derive(Clone)]` is required for `getter_with_clone` (wasm-bindgen's
// generated getters need Clone when a field isn't Copy — String, Vec<_>,
// nested exported structs never are). Applied unconditionally rather than
// per-field for simplicity; every field type this projector emits (leaf
// primitives, String, Vec<T>, other #[derive(Clone)] structs, JsValue) is
// Clone.
function buildStruct(name: string, ref: TypeRef, decls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "object" };
  const lines: string[] = [...docComment("", ref.meta)];
  if (ref.meta.deprecated === true) lines.push("#[deprecated]");
  lines.push("#[derive(Clone)]", "#[wasm_bindgen(getter_with_clone)]", `pub struct ${name} {`);

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const { type, ident, attrs } = fieldType(fieldName, fieldRef, decls);
    lines.push(...docComment("    ", fieldRef.meta));
    if (attrs.length > 0) lines.push(`    #[wasm_bindgen(${attrs.join(", ")})]`);
    if (fieldRef.meta.deprecated === true) lines.push("    #[deprecated]");
    lines.push(`    pub ${ident}: ${type},`);
  }

  lines.push("}");
  return lines.join("\n");
}

// Fieldless / string-discriminant enum — matches wasm-bindgen's own
// "String Discriminants" form (guide/src/reference/types/enums.md) exactly:
// `Variant = "wireValue"`, preserving the IR member's exact wire string as
// the JS-visible value without a separate rename attribute.
function buildEnum(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "enum" };
  const lines: string[] = [...docComment("", ref.meta), "#[wasm_bindgen]", `pub enum ${name} {`];

  for (const member of shape.members) {
    const variant = toPascalCaseStripSeparators(member);
    lines.push(`    ${variant} = ${quote(member)},`);
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Free function (`function` kind with no `thisType`) as a
 * `#[wasm_bindgen] pub fn`. Body is a `todo!()` stub — type-ir carries no
 * implementation, only the signature, so the honest output is a signature
 * that compiles and panics if called before the caller fills it in (the
 * standard Rust scaffolding idiom; there's no valid free-standing
 * signature-only Rust syntax outside a trait). `method` (thisType present)
 * is rejected earlier, in `toWasmBindgen`.
 */
function buildFunction(name: string, ref: TypeRef, decls: string[]): string {
  const shape = ref.shape as TypeShape & {
    kind: "function";
    params: readonly { name: string; type: TypeRef }[];
    returnType: TypeRef;
  };
  const fnName = toSnakeCaseStripSeparators(name);
  const attrs: string[] = [];
  if (fnName !== name) attrs.push(`js_name = ${quote(name)}`);

  const params = shape.params.map((p) => {
    const bare = bareType(toPascalCaseStripSeparators(p.name), p.type, decls);
    const optional = p.type.meta.optional === true || p.type.meta.nullable === true;
    const type = optional ? `Option<${bare}>` : bare;
    const rustName = toSnakeCaseStripSeparators(p.name);
    const ident = escapeRustIdent(rustName);
    const rename =
      rustName !== p.name || ident !== rustName
        ? `#[wasm_bindgen(js_name = ${quote(p.name)})] `
        : "";
    return `${rename}${ident}: ${type}`;
  });

  const isVoidReturn =
    shape.returnType.shape.kind === "void" || shape.returnType.shape.kind === "null";
  const returnType = isVoidReturn
    ? ""
    : ` -> ${bareType(`${toPascalCaseStripSeparators(name)}Return`, shape.returnType, decls)}`;

  const lines: string[] = [...docComment("", ref.meta)];
  lines.push(attrs.length > 0 ? `#[wasm_bindgen(${attrs.join(", ")})]` : "#[wasm_bindgen]");
  lines.push(`pub fn ${fnName}(${params.join(", ")})${returnType} {`);
  lines.push(`    todo!(${quote(`implement ${fnName}`)})`);
  lines.push("}");
  return lines.join("\n");
}

/**
 * Lower a `TypeRef` to wasm-bindgen-annotated Rust source. With `name`,
 * emits a named top-level declaration — `struct` for `object`, `enum` for
 * `enum` (fieldless/string-discriminant), a `#[wasm_bindgen] pub fn` for
 * `function` (throws for `method` — see the `method` handler doc), or a
 * `pub type` alias for anything else (primitives, `array`, ...) — preceded
 * by any struct/enum declarations hoisted out of nested fields/params (see
 * `bareType`). Without `name`, returns just the inline type expression for
 * `ref` (`toWasmBindgenType`).
 *
 * Throws for any kind (or nested kind) with no direct wasm-bindgen ABI
 * mapping — see the file-level doc comment for the full unsupported list
 * and why this projector throws instead of degrading.
 */
export function toWasmBindgen(ref: TypeRef, name?: string): string {
  const kind = ref.shape.kind;

  if (kind === "function") {
    const shape = ref.shape as TypeShape & { kind: "function"; thisType?: TypeRef };
    if (shape.thisType !== undefined) {
      throw new Error(
        'toWasmBindgen: "function" with a thisType (an implicit/explicit receiver) has no free-function wasm-bindgen mapping — see the "method" handler for why',
      );
    }
    if (name === undefined) {
      throw new Error(
        'toWasmBindgen: "function" requires a name — wasm-bindgen exports are named JS bindings, not anonymous inline types',
      );
    }
    const decls: string[] = [];
    const fn = buildFunction(name, ref, decls);
    return [...decls, fn].join("\n\n");
  }

  if (kind === "method") {
    // Delegates to the shared explanatory message the inline-position
    // `method` handler throws.
    handlers.method!(ref.shape, ref.meta);
  }

  if (name === undefined) return toWasmBindgenType(ref);

  const decls: string[] = [];
  let mainDecl: string;
  if (isA(kind, "object")) {
    mainDecl = buildStruct(name, ref, decls);
  } else if (kind === "enum") {
    mainDecl = buildEnum(name, ref);
  } else if (kind === "union") {
    // Delegates to the shared explanatory message the inline-position
    // `union` handler throws.
    handlers.union!(ref.shape, ref.meta);
    mainDecl = ""; // unreachable — handlers.union always throws
  } else {
    mainDecl = `pub type ${name} = ${toWasmBindgenType(ref)};`;
  }

  return [...decls, mainDecl].join("\n\n");
}
