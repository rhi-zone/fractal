// packages/type-ir/src/compile.ts — @rhi-zone/fractal-type-ir
//
// AOT VALIDATOR CODEGEN: TypeRef -> TypeBox TSchema (runtime objects, not
// strings — mirrors `@rhi-zone/fractal-type-ir/typebox`'s string projector but
// builds actual `Type.*` values) -> `TypeCompiler.Code()` -> standalone JS
// validator source with ZERO runtime dependencies (TypeBox itself is a
// BUILD-TIME-ONLY devDependency of this package; the emitted module imports
// nothing).
//
// `TypeCompiler.Code(schema)` returns a function BODY of the form
// `return function check(value) { ... }` — evaluating that body inside a
// function scope yields the raw boolean-returning check function. This
// module wraps that check function into the `Validator` shape route.ts
// expects: `(bag) => Result<unknown, unknown>`.

import { Type, type TSchema } from "@sinclair/typebox"
import { TypeCompiler } from "@sinclair/typebox/compiler"
import { resolve, type TypeRef, type TypeShape } from "./index.ts"
import { toTypeScript } from "./typescript.ts"

// ============================================================================
// TypeRef -> TSchema (mirrors type-ir/src/typebox.ts, builds objects not strings)
// ============================================================================

const optionKeys = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "multipleOf",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "$comment",
] as const

function metaOptions(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  for (const key of optionKeys) {
    if (meta[key] !== undefined) options[key] = meta[key]
  }
  return options
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => TSchema

const leaf =
  (make: (options: Record<string, unknown>) => TSchema, extra: Record<string, unknown> = {}): Converter =>
  (_shape, meta) =>
    make({ ...metaOptions(meta), ...extra })

const handlers: Record<string, Converter> = {
  boolean: leaf((o) => Type.Boolean(o)),
  number: leaf((o) => Type.Number(o)),
  integer: leaf((o) => Type.Integer(o)),
  int32: leaf((o) => Type.Integer(o), { format: "int32" }),
  int64: leaf((o) => Type.Integer(o), { format: "int64" }),
  float32: leaf((o) => Type.Number(o), { format: "float" }),
  float64: leaf((o) => Type.Number(o), { format: "double" }),
  string: leaf((o) => Type.String(o)),
  uuid: leaf((o) => Type.String(o), { format: "uuid" }),
  uri: leaf((o) => Type.String(o), { format: "uri" }),
  datetime: leaf((o) => Type.String(o), { format: "date-time" }),
  date: leaf((o) => Type.String(o), { format: "date" }),
  time: leaf((o) => Type.String(o), { format: "time" }),
  duration: leaf((o) => Type.String(o), { format: "duration" }),
  bytes: leaf((o) => Type.String(o), { contentEncoding: "base64" }),
  null: leaf((o) => Type.Null(o)),
  void: leaf((o) => Type.Void(o)),
  unknown: leaf((o) => Type.Unknown(o)),
  never: leaf((o) => Type.Never(o)),
  object: (shape, meta) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields: Record<string, TSchema> = {}
    for (const [name, field] of Object.entries(s.fields)) {
      const fieldSchema = buildSchema(field)
      // Mirrors type-ir/src/typebox.ts's string projector: Type.Readonly()
      // wraps a schema to mark the property readonly, composed with
      // Type.Optional() the same way. Readonly has no effect on
      // TypeCompiler's runtime validation (it's a static-type-only TypeBox
      // annotation) but is applied anyway for output-schema fidelity.
      const readonlySchema = field.meta.readonly === true ? Type.Readonly(fieldSchema) : fieldSchema
      fields[name] = field.meta.optional === true ? Type.Optional(readonlySchema) : readonlySchema
    }
    return Type.Object(fields, metaOptions(meta))
  },
  array: (shape, meta) => {
    const s = shape as TypeShape & { kind: "array" }
    return Type.Array(buildSchema(s.element), metaOptions(meta))
  },
  tuple: (shape, meta) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return Type.Tuple(s.elements.map(buildSchema), metaOptions(meta))
  },
  map: (shape, meta) => {
    const s = shape as TypeShape & { kind: "map" }
    return Type.Record(Type.String(), buildSchema(s.value), metaOptions(meta))
  },
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    return Type.Union(s.variants.map(buildSchema), metaOptions(meta))
  },
  literal: (shape, meta) => {
    const s = shape as TypeShape & { kind: "literal" }
    const options = metaOptions(meta)
    // TypeBox's `Type.Literal` only accepts string/number/boolean — a `null`
    // TypeRef literal lowers to `Type.Null()` instead (semantically
    // equivalent: both accept exactly the single value `null`).
    return s.value === null ? Type.Null(options) : Type.Literal(s.value, options)
  },
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" }
    return Type.Union(
      s.members.map((m) => Type.Literal(m)),
      metaOptions(meta),
    )
  },
  // `Type.Ref` alone does not resolve without the referenced schema present in
  // `TypeCompiler.Code`'s `references` argument — this TypeRef IR has no
  // schema registry to pull that from (a `ref` TypeRef carries only the
  // target's NAME, mirroring type-ir/src/typebox.ts's same-named handler).
  // Recursive/named-reference types therefore compile to a validator that
  // always throws at `TypeCompiler.Code` time rather than silently
  // mis-validating; see docs/design for the follow-up (a shared type
  // registry threaded through both the string and TSchema projectors).
  ref: (shape, meta) => {
    const s = shape as TypeShape & { kind: "ref" }
    return Type.Ref(s.target, metaOptions(meta))
  },
  // Type.Intersect is TypeBox's native intersection combinator (any arity).
  intersection: (shape, meta) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.length === 0) return Type.Unknown()
    return Type.Intersect(s.members.map(buildSchema), metaOptions(meta))
  },
  // Type.Function(params, returns) is TypeBox's native callable-type
  // constructor (mirrors type-ir/src/typebox.ts's string-projector handler).
  // `thisType` has no dedicated slot and is dropped.
  function: (shape, meta) => {
    const s = shape as TypeShape & { kind: "function" }
    return Type.Function(
      s.params.map((p) => buildSchema(p.type)),
      buildSchema(s.returnType),
      metaOptions(meta),
    )
  },
}

/** Lower a TypeRef to an actual TypeBox `TSchema` runtime object. */
export function buildSchema(ref: TypeRef): TSchema {
  const converter = resolve(ref.shape.kind, handlers)
  const schema = converter === undefined ? Type.Unknown() : converter(ref.shape, ref.meta)
  return ref.meta.nullable === true ? Type.Union([schema, Type.Null()]) : schema
}

// ============================================================================
// TSchema -> standalone validator source (TypeCompiler.Code, zero-dependency)
// ============================================================================

function indent(code: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return code
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n")
}

const DEFAULT_ERROR_MESSAGE = "validation failed"

/**
 * `TypeCompiler.Code()` always emits a function BODY of the exact shape
 * `return function check(value) { … }` (see `compileValidator`'s doc
 * comment) whose body indexes into `value` with bracket access
 * (`value['field']`) throughout — code that only type-checks against `any`.
 * Giving the checked-in-by-hand `unknown`/named-type ANNOTATION to `check`'s
 * CALLER (via the `as (value: unknown) => value is T` cast below) is what
 * makes the emitted validator narrow; the raw compiled body underneath stays
 * untyped by annotating its own parameter with an EXPLICIT `any` — distinct
 * from an IMPLICIT `any`, which `strict`'s `noImplicitAny` would reject once
 * `@ts-nocheck` is gone. (A narrower annotation, even `unknown`, breaks: TS's
 * built-in `typeof`/`Array.isArray` narrowing collapses `value` to `{}`
 * ahead of each bracket access, and `{}` has no indexable properties.)
 */
function annotateCheckParam(code: string): string {
  return code.replace("function check(value)", "function check(value: any)")
}

/**
 * The type-guard annotation for a validator's input, plus the `import type`
 * this annotation needs (if any). Two cases:
 *   - The TypeRef carries `meta.typeName` + `meta.declarationFile` (see
 *     index.ts's meta-bag doc — set by `@rhi-zone/fractal-api-tree`'s
 *     `typeRefFromFunctionNode` for a NAMED handler parameter type) AND the
 *     caller passed `resolveImport` to turn that declaration file into a
 *     module specifier: the annotation is the bare type name, imported.
 *   - Otherwise (anonymous/inline parameter type, or no `resolveImport`):
 *     the annotation is the type's own structural TypeScript rendering
 *     (`toTypeScript`, this package's TS-string projector) — inlined
 *     directly into the guard, no import needed.
 */
function guardAnnotation(
  ref: TypeRef,
  resolveImport: ((declarationFile: string) => string) | undefined,
): { annotation: string; typeImport?: { typeName: string; from: string } } {
  const typeName = typeof ref.meta.typeName === "string" ? ref.meta.typeName : undefined
  const declarationFile = typeof ref.meta.declarationFile === "string" ? ref.meta.declarationFile : undefined
  if (typeName !== undefined && declarationFile !== undefined && resolveImport !== undefined) {
    return { annotation: typeName, typeImport: { typeName, from: resolveImport(declarationFile) } }
  }
  return { annotation: toTypeScript(ref) }
}

/**
 * Compile a single TypeRef to a standalone JS EXPRESSION (not a statement)
 * evaluating to a `Validator` — `(bag) => Result<unknown, unknown>` — with no
 * runtime dependency on TypeBox. `TypeCompiler.Code()`'s output is a function
 * BODY (`return function check(value) {...}`); wrapping it in an IIFE and
 * capturing the returned function is what lets a second IIFE adapt its
 * boolean return into the `Result` shape `route.ts`'s pipeline expects.
 *
 * The returned expression is a type guard: `check` is cast to `(value:
 * unknown) => value is T` (T = the TypeRef's structural TypeScript
 * rendering — a single expression has no module scope to `import` a named
 * type into, so this always inlines; `compileValidatorModule` below is the
 * one that can import), so `bag` narrows to `T` in the `"ok"` branch.
 */
export function compileValidator(ref: TypeRef, errorMessage: string = DEFAULT_ERROR_MESSAGE): string {
  const schema = buildSchema(ref)
  const code = annotateCheckParam(TypeCompiler.Code(schema))
  const { annotation } = guardAnnotation(ref, undefined)
  return [
    "(function () {",
    "  const check = (function () {",
    indent(code, 4),
    `  })() as (value: unknown) => value is ${annotation};`,
    `  return (bag: Record<string, unknown>) => (check(bag) ? { kind: "ok" as const, value: bag } : { kind: "err" as const, error: { message: ${JSON.stringify(errorMessage)} } });`,
    "})()",
  ].join("\n")
}

/**
 * Emit a complete, standalone, zero-dependency-AT-RUNTIME TypeScript module
 * exporting a `validators` object — `Record<name, Validator>`, i.e. the
 * INNER map of a `ValidatorMap` (see route.ts). The build orchestrator
 * (build.ts) is responsible for nesting this under whatever outer key it
 * passes to `createApplyValidation`'s `applyValidation(key, route)`.
 *
 * Each entry's `check` is cast to a type-guard `(value: unknown) => value is
 * T`, so `bag` narrows to `T` in the `"ok"` branch — a caller pattern-matching
 * on `.kind` gets a typed `.value`, not `unknown`. `T` is either an imported
 * named type (when `options.resolveImport` can place it — see
 * `guardAnnotation`) or that type's own inline structural rendering.
 * TypeBox remains build-time-only: nothing in the emitted source imports it.
 */
export function compileValidatorModule(
  entries: readonly { name: string; ref: TypeRef }[],
  options?: { resolveImport?: (declarationFile: string) => string },
): string {
  const imports = new Map<string, Set<string>>() // module specifier -> type names
  const lines: string[] = []
  lines.push("// AUTO-GENERATED by @rhi-zone/fractal-type-ir. Do not edit by hand.")
  lines.push("")

  const entryLines: string[] = []
  for (const { name, ref } of entries) {
    const schema = buildSchema(ref)
    const code = annotateCheckParam(TypeCompiler.Code(schema))
    const errorMessage = `validation failed: ${name}`
    const { annotation, typeImport } = guardAnnotation(ref, options?.resolveImport)
    if (typeImport) {
      const names = imports.get(typeImport.from) ?? new Set<string>()
      names.add(typeImport.typeName)
      imports.set(typeImport.from, names)
    }
    entryLines.push(`  ${JSON.stringify(name)}: (function () {`)
    entryLines.push("    const check = (function () {")
    entryLines.push(indent(code, 6))
    entryLines.push(`    })() as (value: unknown) => value is ${annotation};`)
    entryLines.push(
      `    return (bag: Record<string, unknown>) => (check(bag) ? { kind: "ok" as const, value: bag } : { kind: "err" as const, error: { message: ${JSON.stringify(errorMessage)} } });`,
    )
    entryLines.push("  })(),")
  }

  for (const [from, names] of imports) {
    lines.push(`import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(from)}`)
  }
  if (imports.size > 0) lines.push("")

  lines.push("export const validators = {")
  lines.push(...entryLines)
  lines.push("}")
  lines.push("")
  return lines.join("\n")
}
