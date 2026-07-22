import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// Flow (https://flow.org/) type-annotation projector — structurally very
// close to typescript.ts (see that file for the shared derivation pattern:
// per-kind Converter table + resolve() for subtype fallback), but differs in
// several syntax positions that matter enough to warrant its own file rather
// than a thin wrapper:
//   - `unknown` -> `mixed`, `never` -> `empty` (TS's top/bottom types have no
//     literal Flow spelling).
//   - `bytes` -> `string` (Flow has no `Uint8Array`-as-type-position
//     convention distinct from `string` the way TS's typed-array class does).
//   - Object types default to Flow's *exact* form (`{| ... |}` — no excess
//     properties allowed) rather than TS's always-inexact `{ ... }`; a def
//     opts into inexact via `meta.exact === false`, following the same
//     open-metadata-bag convention `optional`/`readonly`/`nullable` already
//     use elsewhere in type-ir (see index.ts's TypeRef doc comment).
//   - Object readonly fields use Flow's covariant-property marker (`+name:
//     T`), not TS's `readonly name: T`.
//   - `meta.nullable` renders as Flow's prefix maybe-type (`?T`), not TS's
//     trailing `| null` union member — Flow's `?T` additionally covers
//     `void`, which is the closer match to "optional/absent" semantics Flow
//     idiom expects here.
//   - Maps render as an indexer object type (`{ [key: K]: V }`) rather than
//     TS's `Record<string, V>`/`Map<K, V>` split, since Flow has no `Record`
//     utility type and idiomatically uses the indexer form for both cases.
//   - Enums render as a union of string literals (matching TS's own
//     degrade-to-literal-union behavior) rather than Flow's native `enum`
//     declaration — a type-ir `enum` shape carries only a flat member list,
//     with no place to hang the identifier-vs-string-value split Flow's
//     `enum` syntax requires, so the safe, always-representable literal-union
//     form is used consistently regardless of position.

type Converter = (ref: TypeRef) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

function quote(value: string): string {
  return JSON.stringify(value)
}

// Wraps `type` in Flow's prefix maybe-type (`?T`). `?` binds tighter than
// `|`/`&`, so a type built from a top-level union/intersection needs explicit
// parens to keep "nullable applies to the whole type" from silently becoming
// "nullable applies to just the first member".
function maybe(type: string): string {
  return /[|&]/.test(type) ? `?(${type})` : `?${type}`
}

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
  bytes: leaf("string"),
  null: leaf("null"),
  void: leaf("void"),
  unknown: leaf("mixed"),
  never: leaf("empty"),
  object: (ref) => {
    const s = ref.shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true
      const readonly = field.meta.readonly === true
      return `${readonly ? "+" : ""}${name}${optional ? "?" : ""}: ${toFlowType(field)}`
    })
    const exact = ref.meta.exact !== false
    return exact ? `{| ${fields.join(", ")} |}` : `{ ${fields.join(", ")} }`
  },
  // A class instance carries only nominal identity (className/source), never
  // fields — same convention as typescript.ts's `instance` handler; see
  // index.ts's TypeKinds.instance doc comment for why it's not a subtype of
  // `object`. The caller assembling the emitted source is responsible for
  // importing `className` from `source`.
  instance: (ref) => (ref.shape as TypeShape & { kind: "instance" }).className,
  array: (ref) => {
    const s = ref.shape as TypeShape & { kind: "array" }
    const wrapper = ref.meta.readonly === true ? "$ReadOnlyArray" : "Array"
    return `${wrapper}<${toFlowType(s.element)}>`
  },
  tuple: (ref) => {
    const s = ref.shape as TypeShape & { kind: "tuple" }
    return `[${s.elements.map(toFlowType).join(", ")}]`
  },
  // Flow's own lib-defs ship `AsyncIterable<T>` with the same shape as TS's
  // built-in — same degrade-to-native-generic choice typescript.ts makes.
  stream: (ref) => {
    const s = ref.shape as TypeShape & { kind: "stream" }
    return `AsyncIterable<${toFlowType(s.element)}>`
  },
  // Renders back to the same named alias the extractor matched against (see
  // typescript.ts's `page` handler) — the caller assembling this emitted
  // source is responsible for importing the name.
  page: (ref) => {
    const s = ref.shape as TypeShape & { kind: "page" }
    return s.style === "offset" ? `OffsetPage<${toFlowType(s.element)}>` : `CursorPage<${toFlowType(s.element)}>`
  },
  // Flow has no `Record<K, V>` utility type — an indexer property type is the
  // idiomatic spelling for both string- and non-string-keyed maps.
  map: (ref) => {
    const s = ref.shape as TypeShape & { kind: "map" }
    return `{ [key: ${toFlowType(s.key)}]: ${toFlowType(s.value)} }`
  },
  union: (ref) => {
    const s = ref.shape as TypeShape & { kind: "union" }
    return s.variants.map(toFlowType).join(" | ")
  },
  literal: (ref) => {
    const s = ref.shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return quote(s.value)
    return String(s.value)
  },
  // See file-header comment: rendered as a string-literal union, same as
  // typescript.ts, rather than Flow's native `enum` declaration.
  enum: (ref) => {
    const s = ref.shape as TypeShape & { kind: "enum" }
    return s.members.map(quote).join(" | ")
  },
  ref: (ref) => (ref.shape as TypeShape & { kind: "ref" }).target,
  intersection: (ref) => {
    const s = ref.shape as TypeShape & { kind: "intersection" }
    return s.members.map(toFlowType).join(" & ")
  },
  // Flow's function-type syntax (`(params) => ReturnType`) is identical to
  // TS's here, including the `this`-as-leading-pseudo-parameter convention.
  function: (ref) => {
    const s = ref.shape as TypeShape & { kind: "function" }
    const thisParam = s.thisType === undefined ? [] : [`this: ${toFlowType(s.thisType)}`]
    const params = [...thisParam, ...s.params.map((p) => `${p.name}: ${toFlowType(p.type)}`)]
    return `(${params.join(", ")}) => ${toFlowType(s.returnType)}`
  },
  // `method` has no explicit entry — falls back to the `function` handler
  // above (arrow-function syntax) via `registerParent("method", "function")`
  // in index.ts, same as typescript.ts. The `interface` handler below renders
  // each method with method-signature syntax instead.
  interface: (ref) => {
    const s = ref.shape as TypeShape & { kind: "interface" }
    const methods = Object.entries(s.methods).map(([name, methodRef]) => {
      const m = methodRef.shape as TypeShape & { kind: "method" | "function" }
      if (m.params === undefined || m.returnType === undefined) {
        return `${name}(): ${toFlowType(methodRef)}`
      }
      const params = m.params.map((p) => `${p.name}: ${toFlowType(p.type)}`)
      return `${name}(${params.join(", ")}): ${toFlowType(m.returnType)}`
    })
    return `{ ${methods.join("; ")} }`
  },
}

/** Bare Flow type expression for `ref` — no declaration wrapper, no header.
 * Recursive helper used by every composite handler above and by `toFlow`
 * below. */
export function toFlowType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? "mixed" : converter(ref)
  if (typeof ref.meta.brand === "string") {
    type = `${type} & {| +__brand: ${quote(ref.meta.brand)} |}`
  }
  return ref.meta.nullable === true ? maybe(type) : type
}

// Same TSDoc-shaped comment convention typescript.ts's `docComment` uses,
// driven by `meta.description`/`meta.deprecated` — Flow reads ordinary JSDoc
// comments the same way TS does, so no Flow-specific format is needed.
function docComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecated = meta.deprecated === true
  if (description === undefined && !deprecated) return ""

  if (description !== undefined && deprecated) {
    return ["/**", ` * ${description}`, " * @deprecated", " */", ""].join("\n")
  }
  if (description !== undefined) return `/** ${description} */\n`
  return "/** @deprecated */\n"
}

/**
 * `toFlow(ref)` returns the bare Flow type expression for `ref` (same as
 * `toFlowType`). `toFlow(ref, name)` returns a complete, standalone Flow
 * declaration: the `// @flow` file-level pragma Flow requires to opt a file
 * into type checking, any doc comment, and an `export type Name = ...;`
 * declaration.
 */
export function toFlow(ref: TypeRef, name?: string): string {
  const type = toFlowType(ref)
  if (name === undefined) return type
  return `// @flow\n${docComment(ref.meta)}export type ${name} = ${type};`
}
