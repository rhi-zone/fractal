import { resolve, type TypeRef, type TypeShape } from "./index.ts";
import { flowTsDocComment, quote } from "./codegen-helpers.ts";

// `defNames` — the set of shared/recursive `defs` entry names in scope for
// this render (see type-ir's `TypeRefDocument.defs`/compile.ts's
// `compileDefs`) — is threaded through every recursive `toTypeScript` call
// below so the `ref` handler can tell "a ref to a known def, render the
// locally-declared alias" apart from "a ref to something else entirely,
// render the bare (unimportable) name" (see `ref`'s own doc comment).
// Defaults to an empty set, so a call site that doesn't pass `defNames`
// renders every `ref` as an unimported bare name.
type Converter = (shape: TypeShape, defNames: ReadonlySet<string>) => string;

const leaf =
  (type: string): Converter =>
  () =>
    type;

/** A bare (unquoted) identifier is only valid TS/JS member-name syntax for
 * names matching this shape — anything else (a hyphen, a leading digit, …)
 * needs a quoted string literal key instead. Real-world trigger: DOM/fetch
 * builtins expose a `"set-cookie"` member (`Headers`'s multi-value getter
 * family) — emitting `set-cookie?: string[]` unquoted inside an object/
 * interface type annotation is a syntax error (`TS1005`/parser "Unexpected
 * -"), not just unidiomatic. */
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Render `name` as a TS object/interface member key — bare if it's already
 * a valid identifier (the common case, kept unquoted for readability), a
 * quoted string literal otherwise. */
function propertyKeyText(name: string): string {
  return VALID_IDENTIFIER.test(name) ? name : quote(name);
}

/** Sanitizes a `defs` entry name to a valid JS/TS identifier fragment (def
 * names can contain characters an identifier can't, e.g. `"Foo.Bar"`). Shared
 * by `defTypeAliasName` below and compile.ts's `defFnName`, so a def's type
 * alias and its generated check/errors/parse function names agree on the
 * same base fragment. */
export function sanitizeDefName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

/** The locally-declared type alias name a `ref` targeting a shared/recursive
 * `defs` entry renders as (see `compile.ts`'s `compileDefs`, which emits
 * `type __def_NAME = <structural>;` for every entry in `defNames` alongside
 * the runtime check/errors/parse functions it already generated) — e.g.
 * `defTypeAliasName("Expr")` → `"__def_Expr"`. */
export function defTypeAliasName(name: string): string {
  return `__def_${sanitizeDefName(name)}`;
}

const complexKinds = new Set([
  "union",
  "object",
  "map",
  "intersection",
  "function",
  "stream",
  "page",
]);

const handlers: Record<string, Converter> = {
  boolean: leaf("boolean"),
  number: leaf("number"),
  integer: leaf("number"),
  int32: leaf("number"),
  int64: leaf("number"),
  float32: leaf("number"),
  float64: leaf("number"),
  string: leaf("string"),
  uuid: leaf("string"),
  uri: leaf("string"),
  email: leaf("string"),
  datetime: leaf("Date"),
  date: leaf("Date"),
  time: leaf("string"),
  duration: leaf("string"),
  bytes: leaf("Uint8Array"),
  null: leaf("null"),
  void: leaf("void"),
  unknown: leaf("unknown"),
  never: leaf("never"),
  object: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "object" };
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true;
      const readonly = field.meta.readonly === true;
      return `${readonly ? "readonly " : ""}${propertyKeyText(name)}${optional ? "?" : ""}: ${toTypeScript(field, defNames)}`;
    });
    return `{ ${fields.join("; ")} }`;
  },
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — the caller (whatever
  // assembles this emitted source into a module) is responsible for ensuring
  // `className` is imported from `source` alongside the generated declaration.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "array" };
    return complexKinds.has(s.element.shape.kind)
      ? `Array<${toTypeScript(s.element, defNames)}>`
      : `${toTypeScript(s.element, defNames)}[]`;
  },
  tuple: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "tuple" };
    return `[${s.elements.map((e) => toTypeScript(e, defNames)).join(", ")}]`;
  },
  // `AsyncIterable<T>` is TypeScript's own native construct for an
  // asynchronously-produced sequence — the same type `AsyncIterableIterator<T>`
  // (an `async function*`'s return type) and `AsyncGenerator<T, ...>` widen to.
  stream: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "stream" };
    return `AsyncIterable<${toTypeScript(s.element, defNames)}>`;
  },
  // Renders back to the same named alias the extractor matched against
  // (`@rhi-zone/fractal-api-tree`'s `CursorPage<T>`/`OffsetPage<T>` — see
  // extract.ts's `pageAliasName` check) — the caller assembling this emitted
  // source is responsible for importing the name, same as `instance` above.
  page: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "page" };
    return s.style === "offset"
      ? `OffsetPage<${toTypeScript(s.element, defNames)}>`
      : `CursorPage<${toTypeScript(s.element, defNames)}>`;
  },
  map: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "map" };
    return s.key.shape.kind === "string"
      ? `Record<string, ${toTypeScript(s.value, defNames)}>`
      : `Map<${toTypeScript(s.key, defNames)}, ${toTypeScript(s.value, defNames)}>`;
  },
  union: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "union" };
    return s.variants.map((v) => toTypeScriptAsCompoundMember(v, defNames)).join(" | ");
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" };
    if (typeof s.value === "string") return quote(s.value);
    return String(s.value);
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" };
    return s.members.map(quote).join(" | ");
  },
  // A `ref` targeting a name in `defNames` (a shared/recursive `defs` entry —
  // see compile.ts's `compileDefs`, which emits a matching `type __def_NAME =
  // …` alias alongside the runtime check/errors/parse functions) renders the
  // locally-declared alias name, which the caller assembling this into a
  // module is guaranteed to have in scope. Any other `ref` (not in `defNames`
  // — an arbitrary named type this projector has no import mechanism for)
  // renders the bare target name, unimported — the caller is responsible for
  // ensuring it resolves, same as `instance`/`page` above.
  ref: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "ref" };
    return defNames.has(s.target) ? defTypeAliasName(s.target) : s.target;
  },
  intersection: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "intersection" };
    return s.members.map((m) => toTypeScriptAsCompoundMember(m, defNames)).join(" & ");
  },
  // TS's function-type syntax (`(params) => ReturnType`) supports an explicit
  // `this` parameter as its own leading pseudo-parameter
  // (https://www.typescriptlang.org/docs/handbook/2/functions.html#declaring-this-in-a-function) —
  // used when the TypeRef carries `thisType` (e.g. a class method's `this`).
  function: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "function" };
    const thisParam =
      s.thisType === undefined ? [] : [`this: ${toTypeScript(s.thisType, defNames)}`];
    const params = [
      ...thisParam,
      ...s.params.map((p) => `${p.name}: ${toTypeScript(p.type, defNames)}`),
    ];
    return `(${params.join(", ")}) => ${toTypeScript(s.returnType, defNames)}`;
  },
  // `method` has no explicit entry here for the *standalone* case — falls
  // back to the `function` handler above (arrow-function syntax) via
  // `registerParent("method", "function")`. The `interface` handler below
  // renders each method with method-signature syntax instead, since that's
  // the idiomatic TS form for a method living inside an object/interface type.
  //
  // https://www.typescriptlang.org/docs/handbook/2/objects.html#method-syntax —
  // `{ methodName(params): ReturnType }` — distinct from the arrow-function
  // field syntax (`{ methodName: (params) => ReturnType }`) that the generic
  // `function` handler emits, and the idiomatic form once a callable belongs
  // to an object/interface's own member list rather than being a value in
  // type position.
  interface: (shape, defNames) => {
    const s = shape as TypeShape & { kind: "interface" };
    const methods = Object.entries(s.methods).map(([name, methodRef]) => {
      const key = propertyKeyText(name);
      const m = methodRef.shape as TypeShape & { kind: "method" | "function" };
      if (m.params === undefined || m.returnType === undefined) {
        return `${key}(): ${toTypeScript(methodRef, defNames)}`;
      }
      const params = m.params.map((p) => `${p.name}: ${toTypeScript(p.type, defNames)}`);
      return `${key}(${params.join(", ")}): ${toTypeScript(m.returnType, defNames)}`;
    });
    return `{ ${methods.join("; ")} }`;
  },
};

export function toTypeScript(ref: TypeRef, defNames: ReadonlySet<string> = new Set()): string {
  const converter = resolve(ref.shape.kind, handlers);
  let type = converter === undefined ? "unknown" : converter(ref.shape, defNames);
  if (typeof ref.meta.brand === "string") {
    type = `${type} & { readonly __brand: ${quote(ref.meta.brand)} }`;
  }
  return ref.meta.nullable === true ? `${type} | null` : type;
}

/**
 * `toTypeScript(ref)`, but parenthesized when needed for `ref` to be safely
 * embedded as one member of a bigger union (`|`) or intersection (`&`) —
 * used by both the `union`/`intersection` handlers above (never called at
 * the top level).
 *
 * TypeScript's function-type syntax is the lowest-precedence type-level
 * grammar production (it extends as far right as it can), so a bare function
 * type as a union/intersection member is a syntax error (`TS1385`/`TS1387`:
 * "Function type notation must be parenthesized when used in a
 * union/intersection type"). This shape is produced by
 * `functionRefFromSignatures`/`methodRefFromSignatures` (from-typescript.ts),
 * which wrap ≥2 overloaded signatures as
 * `types.intersection([types.function(...), …])`.
 *
 * Two more cases change the type's meaning if left unwrapped, both because
 * `|` binds looser than `&`:
 *   - A `union`-shaped member nested in an intersection: `A & (X | Y) & B`
 *     unwrapped would read as `A & X | Y & B` — a different type.
 *   - A `meta.nullable` member (renders as `X | null`) nested in an
 *     intersection: the trailing `| null` would silently become a top-level
 *     alternative of the whole intersection instead of applying only to this
 *     one member.
 *
 * Wrapping a `meta.brand` member (`X & {...}`) or `meta.nullable` member
 * (`X | null`) nested in a union isn't required by precedence — `&` already
 * binds tighter than `|`, so it parses correctly unwrapped — but is
 * harmless; the same conservative "wrap whenever the rendered text is a
 * compound expression" rule covers both call sites with one implementation
 * rather than threading a union-vs-intersection context parameter through
 * for a purely-cosmetic difference.
 */
function toTypeScriptAsCompoundMember(ref: TypeRef, defNames: ReadonlySet<string>): string {
  const text = toTypeScript(ref, defNames);
  const isCompound =
    ref.shape.kind === "function" ||
    ref.shape.kind === "union" ||
    ref.meta.nullable === true ||
    typeof ref.meta.brand === "string";
  return isCompound ? `(${text})` : text;
}

export function toTypeDeclaration(name: string, ref: TypeRef): string {
  return `${flowTsDocComment(ref.meta)}type ${name} = ${toTypeScript(ref)};`;
}

export function toTypeDeclarations(registry: Record<string, TypeRef>): string {
  return Object.entries(registry)
    .map(([name, ref]) => toTypeDeclaration(name, ref))
    .join("\n");
}
