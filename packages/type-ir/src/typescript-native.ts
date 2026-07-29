import { resolve, type TypeRef, type TypeShape } from "./index.ts"

type Converter = (shape: TypeShape) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

function quote(value: string): string {
  return JSON.stringify(value)
}

const complexKinds = new Set(["union", "object", "map", "intersection", "function", "stream", "page"])

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
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true
      const readonly = field.meta.readonly === true
      return `${readonly ? "readonly " : ""}${name}${optional ? "?" : ""}: ${toTypeScript(field)}`
    })
    return `{ ${fields.join("; ")} }`
  },
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — the caller (whatever
  // assembles this emitted source into a module) is responsible for ensuring
  // `className` is imported from `source` alongside the generated declaration.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return complexKinds.has(s.element.shape.kind)
      ? `Array<${toTypeScript(s.element)}>`
      : `${toTypeScript(s.element)}[]`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `[${s.elements.map(toTypeScript).join(", ")}]`
  },
  // `AsyncIterable<T>` is TypeScript's own native construct for an
  // asynchronously-produced sequence — the same type `AsyncIterableIterator<T>`
  // (an `async function*`'s return type) and `AsyncGenerator<T, ...>` widen to.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `AsyncIterable<${toTypeScript(s.element)}>`
  },
  // Renders back to the same named alias the extractor matched against
  // (`@rhi-zone/fractal-api-tree`'s `CursorPage<T>`/`OffsetPage<T>` — see
  // extract.ts's `pageAliasName` check) — the caller assembling this emitted
  // source is responsible for importing the name, same as `instance` above.
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return s.style === "offset" ? `OffsetPage<${toTypeScript(s.element)}>` : `CursorPage<${toTypeScript(s.element)}>`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return s.key.shape.kind === "string"
      ? `Record<string, ${toTypeScript(s.value)}>`
      : `Map<${toTypeScript(s.key)}, ${toTypeScript(s.value)}>`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return s.variants.map(toTypeScriptAsCompoundMember).join(" | ")
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return quote(s.value)
    return String(s.value)
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return s.members.map(quote).join(" | ")
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return s.members.map(toTypeScriptAsCompoundMember).join(" & ")
  },
  // TS's function-type syntax (`(params) => ReturnType`) supports an explicit
  // `this` parameter as its own leading pseudo-parameter
  // (https://www.typescriptlang.org/docs/handbook/2/functions.html#declaring-this-in-a-function) —
  // used when the TypeRef carries `thisType` (e.g. a class method's `this`).
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const thisParam = s.thisType === undefined ? [] : [`this: ${toTypeScript(s.thisType)}`]
    const params = [...thisParam, ...s.params.map((p) => `${p.name}: ${toTypeScript(p.type)}`)]
    return `(${params.join(", ")}) => ${toTypeScript(s.returnType)}`
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
  interface: (shape) => {
    const s = shape as TypeShape & { kind: "interface" }
    const methods = Object.entries(s.methods).map(([name, methodRef]) => {
      const m = methodRef.shape as TypeShape & { kind: "method" | "function" }
      if (m.params === undefined || m.returnType === undefined) {
        return `${name}(): ${toTypeScript(methodRef)}`
      }
      const params = m.params.map((p) => `${p.name}: ${toTypeScript(p.type)}`)
      return `${name}(${params.join(", ")}): ${toTypeScript(m.returnType)}`
    })
    return `{ ${methods.join("; ")} }`
  },
}

export function toTypeScript(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? "unknown" : converter(ref.shape)
  if (typeof ref.meta.brand === "string") {
    type = `${type} & { readonly __brand: ${quote(ref.meta.brand)} }`
  }
  return ref.meta.nullable === true ? `${type} | null` : type
}

/**
 * `toTypeScript(ref)`, but parenthesized when needed for `ref` to be safely
 * embedded as ONE MEMBER of a bigger union (`|`) or intersection (`&`) —
 * used by both the `union`/`intersection` handlers above (never called at
 * the top level).
 *
 * TypeScript's function-type syntax is the lowest-precedence type-level
 * grammar production (it extends as far right as it can) — a bare function
 * type as a union/intersection member is a genuine SYNTAX ERROR
 * (`TS1385`/`TS1387`: "Function type notation must be parenthesized when
 * used in a union/intersection type"), not just a style nit. Confirmed via
 * a real overloaded method (`functionRefFromSignatures`/
 * `methodRefFromSignatures` wrap ≥2 signatures as
 * `types.intersection([types.function(...), …])`) reached through a TS/DOM
 * builtin's method surface (`Response`) once the call-budget circuit
 * breaker (from-typescript.ts) let extraction terminate INTO it instead of
 * overflowing the stack first.
 *
 * Two more cases genuinely change MEANING (not just a syntax error) if left
 * unwrapped, both because `|` binds looser than `&`:
 *   - A `union`-shaped member nested in an intersection: `A & (X | Y) & B`
 *     unwrapped would read as `A & X | Y & B` — a completely different type.
 *   - A `meta.nullable` member (renders as `X | null`) nested in an
 *     intersection: same issue, the trailing `| null` silently becomes a
 *     top-level alternative of the whole intersection instead of applying
 *     only to this one member.
 *
 * Wrapping in the union-nests-brand/nullable case (a `meta.brand` member,
 * `X & {...}`, or `meta.nullable`, `X | null`, nested in a UNION) is not
 * strictly required by precedence (`&` already binds tighter than `|`, so
 * it parses correctly unwrapped) but is harmless — the same conservative
 * "wrap whenever the rendered text is a compound expression" rule below
 * covers both call sites with one implementation rather than threading a
 * union-vs-intersection context parameter through for a purely-cosmetic
 * difference.
 */
function toTypeScriptAsCompoundMember(ref: TypeRef): string {
  const text = toTypeScript(ref)
  const isCompound =
    ref.shape.kind === "function" ||
    ref.shape.kind === "union" ||
    ref.meta.nullable === true ||
    typeof ref.meta.brand === "string"
  return isCompound ? `(${text})` : text
}

// TSDoc (https://tsdoc.org/) comment above a declaration — driven by
// `meta.description` (the summary text) and `meta.deprecated` (the
// `@deprecated` block tag), same open-metadata-bag convention the jsdoc.ts
// projector uses. A single line renders as `/** ... */`; both together render
// as a multi-line block.
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

export function toTypeDeclaration(name: string, ref: TypeRef): string {
  return `${docComment(ref.meta)}type ${name} = ${toTypeScript(ref)};`
}

export function toTypeDeclarations(registry: Record<string, TypeRef>): string {
  return Object.entries(registry)
    .map(([name, ref]) => toTypeDeclaration(name, ref))
    .join("\n")
}
