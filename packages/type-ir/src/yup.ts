// Yup validator code projector. Emits Yup schema source text, not runtime schemas.
// Spec: https://github.com/jquense/yup#api (mixed, string, number, boolean, date,
// object, array, tuple; required/nullable/default; string min/max/matches/url;
// number min/max; object shape with per-field .required()). Yup has no native
// record/map, union, or literal-set type — `.oneOf()` on `mixed()` approximates
// literals/enums (value-based, not schema-based), and `yup.lazy()` approximates
// schema unions via a runtime type guard per variant (best-effort, lossy).
import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function regexLiteral(pattern: string): string {
  return `/${pattern.replace(/\//g, "\\/")}/`
}

// Best-effort runtime discriminator for a union variant, used inside yup.lazy().
function runtimeGuard(ref: TypeRef): string {
  const kind = ref.shape.kind

  if (kind === "literal") {
    const value = (ref.shape as TypeShape & { kind: "literal" }).value
    return `value === ${JSON.stringify(value)}`
  }
  if (kind === "enum") {
    const members = (ref.shape as TypeShape & { kind: "enum" }).members
    return `[${members.map((m) => JSON.stringify(m)).join(", ")}].includes(value)`
  }
  if (kind === "null") return "value === null"
  if (kind === "array" || kind === "tuple") return "Array.isArray(value)"
  if (kind === "object" || kind === "instance" || kind === "map") return `typeof value === "object" && value !== null && !Array.isArray(value)`
  if (isA(kind, "string")) return `typeof value === "string"`
  if (isA(kind, "number")) return `typeof value === "number"`
  if (kind === "boolean") return `typeof value === "boolean"`

  return "true"
}

function withMeta(expr: string, meta: Readonly<Record<string, unknown>>, kind: string): string {
  let result = expr

  const numberLike = isA(kind, "number")
  const stringLike = isA(kind, "string")
  const lengthConstrainable = stringLike || kind === "array"

  if (typeof meta.minimum === "number" && numberLike) result += `.min(${meta.minimum})`
  if (typeof meta.maximum === "number" && numberLike) result += `.max(${meta.maximum})`
  if (typeof meta.minLength === "number" && lengthConstrainable) result += `.min(${meta.minLength})`
  if (typeof meta.maxLength === "number" && lengthConstrainable) result += `.max(${meta.maxLength})`
  if (typeof meta.pattern === "string" && stringLike) result += `.matches(${regexLiteral(meta.pattern)})`
  if (typeof meta.multipleOf === "number" && numberLike) {
    result += `.test("multipleOf", "must be a multiple of ${meta.multipleOf}", (value) => value === undefined || value % ${meta.multipleOf} === 0)`
  }

  if (meta.nullable === true) result += ".nullable()"
  if (typeof meta.description === "string") result += `.label(${JSON.stringify(meta.description)})`
  if (meta.default !== undefined) result += `.default(${JSON.stringify(meta.default)})`

  return result
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (expr: string): Converter =>
  () =>
    expr

const handlers: Record<string, Converter> = {
  boolean: leaf("yup.boolean()"),
  number: leaf("yup.number()"),
  integer: leaf("yup.number().integer()"),
  int32: leaf("yup.number().integer()"),
  int64: leaf("yup.number().integer()"),
  float32: leaf("yup.number()"),
  float64: leaf("yup.number()"),
  string: leaf("yup.string()"),
  uuid: leaf("yup.string().matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)"),
  uri: leaf("yup.string().url()"),
  datetime: leaf("yup.date()"),
  date: leaf("yup.date()"),
  time: leaf("yup.string() /* no native time type in Yup */"),
  duration: leaf("yup.string() /* no native duration type in Yup */"),
  bytes: leaf("yup.string() /* no native base64 validation in Yup */"),
  null: leaf("yup.mixed().oneOf([null] as const)"),
  void: leaf("yup.mixed() /* no native void type in Yup */"),
  unknown: leaf("yup.mixed()"),
  never: leaf("yup.mixed().oneOf([] as const) /* no native never type in Yup */"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const expr = toYup(field)
      const required = field.meta.optional === true ? "" : ".required()"
      return `${quoteKey(name)}: ${expr}${required}`
    })
    return `yup.object({ ${fields.join(", ")} })`
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `yup.array().of(${toYup(s.element)})`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `yup.tuple([${s.elements.map(toYup).join(", ")}])`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    void s
    return "yup.object() /* lossy: Yup has no native record/map type; key/value types not preserved */"
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    if (s.variants.every((v) => v.shape.kind === "literal")) {
      const values = s.variants.map((v) => JSON.stringify((v.shape as TypeShape & { kind: "literal" }).value))
      return `yup.mixed().oneOf([${values.join(", ")}] as const)`
    }
    const branches = s.variants.map((v) => `if (${runtimeGuard(v)}) return ${toYup(v)};`)
    return `yup.lazy((value) => {\n  ${branches.join("\n  ")}\n  return yup.mixed();\n})`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return `yup.mixed().oneOf([${JSON.stringify(s.value)}] as const)`
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return `yup.mixed().oneOf([${s.members.map((m) => JSON.stringify(m)).join(", ")}] as const)`
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
  // Yup's `.concat(schema)` merges two schemas of the same underlying type —
  // https://github.com/jquense/yup#schemaconcatschema-schema-schema — which is
  // only meaningful here for object shapes (concat-ing e.g. two strings doesn't
  // produce an intersection). When every intersection member is an object, chain
  // .concat() left-associatively; otherwise fall back to the first member's
  // schema, dropping the rest.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first, ...rest] = s.members
    if (first === undefined) return "yup.mixed()"
    if (s.members.every((member) => isA(member.shape.kind, "object"))) {
      return rest.reduce((acc, member) => `${acc}.concat(${toYup(member)})`, toYup(first))
    }
    return toYup(first)
  },
}

export function toYup(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const expr = converter === undefined ? "yup.mixed()" : converter(ref.shape, ref.meta)
  return withMeta(expr, ref.meta, ref.shape.kind)
}

export function toYupDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toYup(ref)};`
}

export function toYupDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toYupDeclaration(name, ref))
  return [`import * as yup from "yup";`, "", ...declarations].join("\n")
}
