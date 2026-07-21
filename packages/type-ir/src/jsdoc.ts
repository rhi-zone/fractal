import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function quote(value: string): string {
  return JSON.stringify(value)
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

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
  datetime: leaf("Date"),
  date: leaf("Date"),
  time: leaf("string"),
  duration: leaf("string"),
  bytes: leaf("string"),
  null: leaf("null"),
  void: leaf("void"),
  unknown: leaf("*"),
  never: leaf("never"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const entries = Object.entries(s.fields)
    if (entries.length === 0) return "Object.<string, *>"
    const props = entries.map(([name, field]) => `${name}: ${toJsDocType(field)}`)
    return `{${props.join(", ")}}`
  },
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — JSDoc's type syntax
  // supports referencing a class by name directly (https://jsdoc.app/tags-type.html),
  // so this emits the class name rather than a structural object type.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `Array.<${toJsDocType(s.element)}>`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const types = [...new Set(s.elements.map(toJsDocType))]
    return `Array.<${types.join("|")}>`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `Object.<string, ${toJsDocType(s.value)}>`
  },
  // JSDoc/Closure Compiler's type-application syntax (`Foo.<T>`,
  // https://jsdoc.app/tags-type.html#type-language) applies to any generic
  // name, including a built-in async iterable — same pattern `Array.<T>`
  // uses above.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `AsyncIterable.<${toJsDocType(s.element)}>`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    const types = [...new Set(s.variants.map(toJsDocType))]
    return `(${types.join("|")})`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return quote(s.value)
    return String(s.value)
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return `(${s.members.map(quote).join("|")})`
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
  // JSDoc/Closure Compiler type syntax has no intersection operator (unlike its
  // union support via `|`) — lossy fallback: the first member's type, dropping
  // the rest.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "*" : toJsDocType(first)
  },
  // JSDoc/Closure Compiler's function type syntax: `function(ParamType,
  // ParamType): ReturnType` (https://jsdoc.app/tags-type.html#type-language).
  // `thisType` (an explicit/implicit `this` binding) has no dedicated slot in
  // this syntax and is dropped — lossy but the closest native fit.
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const params = s.params.map((p) => toJsDocType(p.type)).join(", ")
    return `function(${params}): ${toJsDocType(s.returnType)}`
  },
  // `method` has no explicit entry — falls back to the `function` handler
  // above via `registerParent("method", "function")`; JSDoc's function-type
  // syntax has no separate "this belongs to a contract" notion anyway.
  //
  // JSDoc/Closure Compiler has no dedicated service/interface-with-methods
  // type syntax (https://jsdoc.app/tags-type.html) — degrades to the same
  // object-type-literal form the `object` handler above uses, with each
  // method's type rendered via `toJsDocType` (which resolves through the
  // `function` handler for `method`-kind entries).
  interface: (shape) => {
    const s = shape as TypeShape & { kind: "interface" }
    const entries = Object.entries(s.methods)
    if (entries.length === 0) return "Object.<string, function()>"
    const props = entries.map(([name, method]) => `${name}: ${toJsDocType(method)}`)
    return `{${props.join(", ")}}`
  },
}

export function toJsDocType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const type = converter === undefined ? "*" : converter(ref.shape, ref.meta)
  return ref.meta.nullable === true ? `?${type}` : type
}

// https://jsdoc.app/tags-readonly.html — `@readonly` is normally its own tag on a
// property's dedicated doc block, but this projector emits properties as a flat
// list of single-line `@property`/`@param` entries (no per-field doc block to
// attach a standalone tag to), so readonly rides along in the description text
// instead — the same textual-fallback idiom `optional` already uses below when a
// field has no description of its own.
function fieldSuffix(field: TypeRef, optional: boolean, readonly = false): string {
  const description = typeof field.meta.description === "string" ? field.meta.description : undefined
  const fallback = [optional ? "optional" : undefined, readonly ? "readonly" : undefined].filter(
    (part): part is string => part !== undefined,
  )
  if (description !== undefined) {
    return readonly ? ` - ${description} (readonly)` : ` - ${description}`
  }
  return fallback.length > 0 ? ` - ${fallback.join(", ")}` : ""
}

function propertyLine(name: string, field: TypeRef): string {
  const optional = field.meta.optional === true
  const readonly = field.meta.readonly === true
  const label = optional ? `[${name}]` : name
  const typeExpr = toJsDocType(field)
  return ` * @property {${typeExpr}} ${label}${fieldSuffix(field, optional, readonly)}`
}

function paramLine(name: string, field: TypeRef): string {
  const optional = field.meta.optional === true
  const label = optional ? `[${name}]` : name
  const typeExpr = toJsDocType(field)
  return ` * @param {${typeExpr}} ${label}${fieldSuffix(field, optional)}`
}

function isObjectKind(kind: string): boolean {
  return kind === "object" || ancestors(kind).includes("object")
}

export type JsDocDeclarationMode = "typedef" | "interface" | "class"

export interface JsDocDeclarationOptions {
  readonly mode?: JsDocDeclarationMode
}

export function toJsDocTypedef(name: string, ref: TypeRef, options: JsDocDeclarationOptions = {}): string {
  const mode = options.mode ?? "typedef"
  const description = typeof ref.meta.description === "string" ? ` ${ref.meta.description}` : ""
  const isObject = isObjectKind(ref.shape.kind)
  const s = isObject ? (ref.shape as TypeShape & { kind: "object" }) : undefined
  // https://jsdoc.app/tags-deprecated.html — `@deprecated` is a standalone block
  // tag; single-line `/** @typedef {...} Name */` forms must expand to multi-line
  // to carry it.
  const deprecatedLine = ref.meta.deprecated === true ? [" * @deprecated"] : []

  if (mode === "interface") {
    const lines =
      s === undefined ? [] : Object.entries(s.fields).map(([fieldName, field]) => propertyLine(fieldName, field))
    return ["/**", ` * @interface ${name}${description}`, ...deprecatedLine, ...lines, " */"].join("\n")
  }

  if (mode === "class") {
    const lines =
      s === undefined ? [] : Object.entries(s.fields).map(([fieldName, field]) => paramLine(fieldName, field))
    return [
      "/**",
      ` * @class ${name}${description}`,
      ` * @constructs ${name}`,
      ...deprecatedLine,
      ...lines,
      " */",
    ].join("\n")
  }

  if (isObject && s !== undefined) {
    const lines = Object.entries(s.fields).map(([fieldName, field]) => propertyLine(fieldName, field))
    return ["/**", ` * @typedef {Object} ${name}${description}`, ...deprecatedLine, ...lines, " */"].join("\n")
  }

  if (ref.meta.deprecated === true) {
    return ["/**", ` * @typedef {${toJsDocType(ref)}} ${name}${description}`, " * @deprecated", " */"].join("\n")
  }

  return `/** @typedef {${toJsDocType(ref)}} ${name}${description} */`
}

export function toJsDocTypedefs(registry: Record<string, TypeRef>, options: JsDocDeclarationOptions = {}): string {
  return Object.entries(registry)
    .map(([name, ref]) => toJsDocTypedef(name, ref, options))
    .join("\n\n")
}

// Inline `@type` annotation — the value-annotation form (JSDoc spec:
// https://jsdoc.app/tags-type.html), as opposed to the `@typedef`/`@interface`/`@class`
// declaration forms above. `meta.optional` is ignored: optionality describes a field in a
// declaration, not a standalone expression being annotated.
export function toJsDocInlineType(ref: TypeRef): string {
  return `/** @type {${toJsDocType(ref)}} */`
}
