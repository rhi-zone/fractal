// packages/type-ir/src/standard-schema.ts — @rhi-zone/fractal-type-ir/standard-schema
//
// TO-direction emitter: TypeRef -> a runtime object implementing Standard
// Schema (https://standardschema.dev/) — both orthogonal interfaces the spec
// defines:
//   - StandardSchemaV1: `~standard.validate(value)` — structural runtime
//     validation, walking the TypeRef tree directly against the actual value
//     (not codegen — see compile.ts for the AOT-codegen sibling projector;
//     this one interprets the tree at call time instead of emitting source).
//   - StandardJSONSchemaV1: `~standard.jsonSchema.input`/`.output` — delegates
//     to the existing JSON Schema projectors (toJsonSchema for the spec's
//     "draft-2020-12" strongly-recommended target, toJsonSchema07 for its
//     "draft-07" strongly-recommended target, toOpenApi30 for the
//     "openapi-3.0" target the spec calls out by name). Input and output are
//     identical here — this projector does no separate input/output
//     transformation (no defaults injection, no coercion), so both methods
//     just render the same TypeRef.
//
// This is the mirror image of from-standard-schema.ts (any Standard Schema
// implementation -> TypeRef); together the two let a TypeRef round-trip
// through the vendor-neutral interface any of Zod/Valibot/ArkType/etc. also
// implement.
//
// Validation is intentionally structural only (correct JS type, required
// properties present, array/tuple element types, union/discriminated-union
// matching, enum membership, meta-driven length/range/pattern constraints) —
// no semantic validation beyond what `meta.pattern`/format kinds (uuid, uri,
// email, ...) already encode. See CLAUDE.md's design philosophy: this
// projector reads the same open TypeShape/meta bag every other projector
// does, nothing bespoke.

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"
import { typeRefToString } from "./compile.ts"
import { toJsonSchema } from "./json-schema.ts"
import { toJsonSchema07 } from "./json-schema-07.ts"
import { toOpenApi30 } from "./openapi30.ts"

export type { StandardJSONSchemaV1, StandardSchemaV1 }

type Issue = StandardSchemaV1.Issue

// ============================================================================
// Small shared helpers
// ============================================================================

function isStringlike(kind: string): boolean {
  return kind === "string" || ancestors(kind).includes("string")
}
function isNumericlike(kind: string): boolean {
  return kind === "number" || kind === "integer" || ancestors(kind).some((a) => a === "number" || a === "integer")
}

function issue(message: string, path: PropertyKey[]): Issue {
  return path.length === 0 ? { message } : { message, path }
}

function describeValue(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function baseTypeIssue(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue {
  return issue(`expected ${typeRefToString(ref)}, got ${describeValue(value)}`, path)
}

function isAsyncIterable(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] === "function"
}

// `page` (CursorPage<T>/OffsetPage<T>) validates like the equivalent plain
// object — see compile.ts's `pageAsObjectRef` doc comment for the reasoning;
// this is the same synthesis, duplicated rather than shared because compile.ts
// doesn't export it (it's an internal codegen helper there, this module
// interprets values directly instead of generating source).
function pageAsObjectRef(ref: TypeRef): TypeRef {
  const s = ref.shape as TypeShape & { kind: "page" }
  const items: TypeRef = { shape: { kind: "array", element: s.element } as TypeShape, meta: {} }
  const hasMore: TypeRef = { shape: { kind: "boolean" } as TypeShape, meta: {} }
  const fields: Record<string, TypeRef> =
    s.style === "cursor"
      ? {
          items,
          cursor: { shape: { kind: "string" } as TypeShape, meta: { optional: true } },
          hasMore,
        }
      : {
          items,
          offset: { shape: { kind: "number" } as TypeShape, meta: {} },
          total: { shape: { kind: "number" } as TypeShape, meta: {} },
          hasMore,
        }
  return { shape: { kind: "object", fields } as TypeShape, meta: {} }
}

// ============================================================================
// meta-driven constraint checks (minLength/maxLength/pattern/minimum/maximum/
// exclusiveMinimum/exclusiveMaximum/multipleOf) — only applied once the base
// type handler already confirmed `value` has the right JS shape, since e.g.
// `.length` on a non-string/array is meaningless.
// ============================================================================

function metaConstraintIssues(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const meta = ref.meta
  const kind = ref.shape.kind
  const issues: Issue[] = []

  const lengthable = isStringlike(kind) || kind === "array"
  if (lengthable && (typeof value === "string" || Array.isArray(value))) {
    const len = value.length
    if (typeof meta.minLength === "number" && len < meta.minLength) {
      issues.push(issue(`expected length >= ${meta.minLength}, got ${len}`, path))
    }
    if (typeof meta.maxLength === "number" && len > meta.maxLength) {
      issues.push(issue(`expected length <= ${meta.maxLength}, got ${len}`, path))
    }
  }
  if (isStringlike(kind) && typeof value === "string" && typeof meta.pattern === "string") {
    if (!new RegExp(meta.pattern).test(value)) {
      issues.push(issue(`expected string matching pattern ${meta.pattern}`, path))
    }
  }
  if (isNumericlike(kind) && typeof value === "number") {
    if (typeof meta.minimum === "number" && !(value >= meta.minimum)) {
      issues.push(issue(`expected >= ${meta.minimum}, got ${value}`, path))
    }
    if (typeof meta.exclusiveMinimum === "number" && !(value > meta.exclusiveMinimum)) {
      issues.push(issue(`expected > ${meta.exclusiveMinimum}, got ${value}`, path))
    }
    if (typeof meta.maximum === "number" && !(value <= meta.maximum)) {
      issues.push(issue(`expected <= ${meta.maximum}, got ${value}`, path))
    }
    if (typeof meta.exclusiveMaximum === "number" && !(value < meta.exclusiveMaximum)) {
      issues.push(issue(`expected < ${meta.exclusiveMaximum}, got ${value}`, path))
    }
    if (typeof meta.multipleOf === "number" && value % meta.multipleOf !== 0) {
      issues.push(issue(`expected multiple of ${meta.multipleOf}, got ${value}`, path))
    }
  }
  return issues
}

// ============================================================================
// Per-kind structural validators
// ============================================================================

type Handler = (ref: TypeRef, value: unknown, path: PropertyKey[]) => Issue[]

const FORMAT_PATTERNS: Record<string, string> = {
  uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  uri: "^[a-zA-Z][a-zA-Z0-9+.-]*:\\S*$",
  email: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
  time: "^\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$",
  duration: "^P(?:\\d+Y)?(?:\\d+M)?(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d+)?S)?)?$",
  bytes: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
}

function formatHandler(name: keyof typeof FORMAT_PATTERNS): Handler {
  return (ref, value, path) => {
    if (typeof value !== "string") return [baseTypeIssue(ref, value, path)]
    if (!new RegExp(FORMAT_PATTERNS[name]!).test(value)) return [issue(`expected ${name}-formatted string`, path)]
    return []
  }
}

function dateHandler(): Handler {
  return (ref, value, path) =>
    value instanceof Date && !Number.isNaN(value.getTime()) ? [] : [baseTypeIssue(ref, value, path)]
}

function intRangeHandler(min: number, max: number): Handler {
  return (ref, value, path) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? []
      : [baseTypeIssue(ref, value, path)]
}

function objectHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "object" }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [baseTypeIssue(ref, value, path)]
  const record = value as Record<string, unknown>
  const issues: Issue[] = []
  for (const [name, field] of Object.entries(s.fields)) {
    const fv = record[name]
    const fpath = [...path, name]
    if (fv === undefined) {
      if (field.meta.optional !== true) issues.push(issue(`missing required property "${name}"`, fpath))
      continue
    }
    issues.push(...validateValue(field, fv, fpath))
  }
  if (ref.meta.additionalProperties === false) {
    const known = new Set(Object.keys(s.fields))
    for (const key of Object.keys(record)) {
      if (!known.has(key)) issues.push(issue(`unexpected property "${key}"`, [...path, key]))
    }
  }
  return issues
}

function arrayHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "array" }
  if (!Array.isArray(value)) return [baseTypeIssue(ref, value, path)]
  const issues: Issue[] = []
  value.forEach((el, i) => issues.push(...validateValue(s.element, el, [...path, i])))
  return issues
}

function tupleHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "tuple" }
  if (!Array.isArray(value)) return [baseTypeIssue(ref, value, path)]
  const issues: Issue[] = []
  if (value.length !== s.elements.length) {
    issues.push(issue(`expected tuple of length ${s.elements.length}, got ${value.length}`, path))
  }
  s.elements.forEach((element, i) => {
    if (i < value.length) issues.push(...validateValue(element, value[i], [...path, i]))
  })
  return issues
}

function mapHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "map" }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [baseTypeIssue(ref, value, path)]
  const issues: Issue[] = []
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    issues.push(...validateValue(s.key, key, [...path, key]))
    issues.push(...validateValue(s.value, v, [...path, key]))
  }
  return issues
}

// Discriminated unions (meta.discriminator, see the zod.ts projector's
// z.discriminatedUnion doc comment for the same convention) validate in O(1)
// by reading the discriminant field and matching against the ONE variant
// whose literal field agrees — precise "expected variant X, discriminator
// says Y" issues instead of "matched none of N variants." A plain union
// tries every variant and reports success on the first zero-issue match.
function unionHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "union" }
  if (s.variants.length === 0) return [issue("value does not match empty union", path)]

  const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
  if (discriminator !== undefined && typeof value === "object" && value !== null) {
    const tag = (value as Record<string, unknown>)[discriminator]
    const matched = s.variants.find((variant) => {
      if (variant.shape.kind !== "object") return false
      const field = (variant.shape as TypeShape & { kind: "object" }).fields[discriminator]
      return field !== undefined && field.shape.kind === "literal" && (field.shape as TypeShape & { kind: "literal" }).value === tag
    })
    if (matched === undefined) {
      return [issue(`discriminator "${discriminator}" value ${JSON.stringify(tag)} matches no union variant`, [...path, discriminator])]
    }
    return validateValue(matched, value, path)
  }

  for (const variant of s.variants) {
    if (validateValue(variant, value, path).length === 0) return []
  }
  return [issue(`value does not match any of ${s.variants.length} union variant(s)`, path)]
}

function literalHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "literal" }
  return value === s.value ? [] : [issue(`expected literal ${JSON.stringify(s.value)}, got ${JSON.stringify(value)}`, path)]
}

function enumHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "enum" }
  return s.members.includes(value as string)
    ? []
    : [issue(`expected one of ${s.members.map((m) => JSON.stringify(m)).join(", ")}, got ${JSON.stringify(value)}`, path)]
}

function intersectionHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "intersection" }
  return s.members.flatMap((member) => validateValue(member, value, path))
}

function interfaceHandler(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  const s = ref.shape as TypeShape & { kind: "interface" }
  if (typeof value !== "object" || value === null) return [baseTypeIssue(ref, value, path)]
  const record = value as Record<string, unknown>
  const issues: Issue[] = []
  for (const name of Object.keys(s.methods)) {
    const fv = record[name]
    const fpath = [...path, name]
    if (fv === undefined) issues.push(issue(`missing required method "${name}"`, fpath))
    else if (typeof fv !== "function") issues.push(issue(`expected function for "${name}"`, fpath))
  }
  return issues
}

const handlers: Record<string, Handler> = {
  boolean: (ref, value, path) => (typeof value === "boolean" ? [] : [baseTypeIssue(ref, value, path)]),
  number: (ref, value, path) => (typeof value === "number" ? [] : [baseTypeIssue(ref, value, path)]),
  integer: (ref, value, path) => (typeof value === "number" && Number.isInteger(value) ? [] : [baseTypeIssue(ref, value, path)]),
  int32: intRangeHandler(-2147483648, 2147483647),
  int64: intRangeHandler(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  float32: (ref, value, path) => (typeof value === "number" ? [] : [baseTypeIssue(ref, value, path)]),
  float64: (ref, value, path) => (typeof value === "number" ? [] : [baseTypeIssue(ref, value, path)]),
  string: (ref, value, path) => (typeof value === "string" ? [] : [baseTypeIssue(ref, value, path)]),
  uuid: formatHandler("uuid"),
  uri: formatHandler("uri"),
  email: formatHandler("email"),
  date: dateHandler(),
  datetime: dateHandler(),
  time: formatHandler("time"),
  duration: formatHandler("duration"),
  bytes: formatHandler("bytes"),
  null: (ref, value, path) => (value === null ? [] : [baseTypeIssue(ref, value, path)]),
  void: (ref, value, path) => (value === undefined ? [] : [baseTypeIssue(ref, value, path)]),
  unknown: () => [],
  never: (ref, value, path) => [baseTypeIssue(ref, value, path)],
  // Purely nominal — no structure to check. See index.ts's `instance` doc.
  instance: () => [],
  // Bare TypeRef (no TypeRefDocument/defs threading in this projector's
  // surface) has no target to resolve against — passes through, same
  // convention as compile.ts's bare-TypeRef `ref` handler.
  ref: () => [],
  function: (ref, value, path) => (typeof value === "function" ? [] : [baseTypeIssue(ref, value, path)]),
  object: objectHandler,
  array: arrayHandler,
  // See `isAsyncIterable`'s doc — elements aren't (can't be, without
  // consuming the iterator) checked.
  stream: (ref, value, path) => (isAsyncIterable(value) ? [] : [baseTypeIssue(ref, value, path)]),
  page: (ref, value, path) => validateValue(pageAsObjectRef(ref), value, path),
  tuple: tupleHandler,
  map: mapHandler,
  union: unionHandler,
  literal: literalHandler,
  enum: enumHandler,
  intersection: intersectionHandler,
  interface: interfaceHandler,
}

function validateValue(ref: TypeRef, value: unknown, path: PropertyKey[]): Issue[] {
  if (ref.meta.nullable === true && value === null) return []
  const handler = resolve(ref.shape.kind, handlers)
  const issues = handler === undefined ? [] : handler(ref, value, path)
  // Constraint checks (minLength/pattern/minimum/...) only make sense once
  // the base structural check already passed — skip them on a type mismatch
  // so a wrong-type value doesn't ALSO report spurious constraint failures.
  if (issues.length > 0) return issues
  return metaConstraintIssues(ref, value, path)
}

// ============================================================================
// JSON Schema export (StandardJSONSchemaV1)
// ============================================================================

function jsonSchemaForTarget(ref: TypeRef, target: string): Record<string, unknown> {
  switch (target) {
    case "draft-2020-12":
      return toJsonSchema(ref) as unknown as Record<string, unknown>
    case "draft-07":
      return toJsonSchema07(ref) as unknown as Record<string, unknown>
    case "openapi-3.0":
      return toOpenApi30(ref) as unknown as Record<string, unknown>
    default:
      throw new Error(`toStandardSchema: unsupported JSON Schema target "${target}"`)
  }
}

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Converts a TypeRef to a runtime object implementing both Standard Schema
 * interfaces (https://standardschema.dev/): `StandardSchemaV1` (structural
 * `~standard.validate`) and `StandardJSONSchemaV1` (`~standard.jsonSchema.
 * input`/`.output`, delegating to this package's existing JSON Schema/
 * OpenAPI 3.0 projectors). `vendor` is always `"fractal-type-ir"`.
 */
export function toStandardSchema(ref: TypeRef): StandardSchemaV1 & StandardJSONSchemaV1 {
  const props: StandardSchemaV1.Props & StandardJSONSchemaV1.Props = {
    version: 1,
    vendor: "fractal-type-ir",
    validate(value: unknown) {
      const issues = validateValue(ref, value, [])
      if (issues.length === 0) return { value }
      return { issues }
    },
    jsonSchema: {
      input: (options) => jsonSchemaForTarget(ref, options.target),
      output: (options) => jsonSchemaForTarget(ref, options.target),
    },
  }
  return { "~standard": props }
}
