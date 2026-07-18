// packages/type-ir/src/compile.ts — @rhi-zone/fractal-type-ir
//
// AOT VALIDATOR CODEGEN: TypeRef -> standalone JS/TS source with ZERO runtime
// dependencies. Unlike the retired TypeBox-based version of this module
// (TypeRef -> TSchema -> `TypeCompiler.Code()`), this codegen walks the
// TypeRef tree directly and emits string templates per shape kind — no
// intermediate schema representation, no build-time-only runtime dependency.
//
// Each compiled operation gets THREE functions, all standalone:
//   - check(value): value is T         — boolean fast path, no allocations
//     on the happy path, short-circuits on first failure. Used at the hot
//     request-time path where only a yes/no answer is needed.
//   - errors(value): ValidationError[] — structured error collection; checks
//     every field (doesn't short-circuit) so a caller can report everything
//     wrong with a payload in one pass.
//   - parse(value): {kind:"ok",value:T} | {kind:"err",errors}
//                                       — validates AND coerces (e.g. string
//     "42" -> number 42) in one pass, building a FRESH output value (never
//     mutates the input). Ok branch narrows via the discriminated-union
//     return type, no explicit `is` predicate needed.
//
// Codegen strategy: string templates with thin helpers (indent, a per-entry
// const-hoisting pool for regexes/enum-member-arrays/known-field-sets), not
// ts-morph and not an intermediate IR — codegen runs on every build, so the
// template functions stay cheap. Each TypeRef shape kind gets its own
// template function; the registry (index.ts's `resolve`) is open, so a new
// kind only needs a `checkHandlers`/`validateHandlers` entry (or inherits
// its parent's via `ancestors()`).

import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"
import { toTypeScript } from "./typescript.ts"

// ============================================================================
// ValidationError — the structured error shape `errors()`/`parse()` emit.
// ============================================================================

export type ValidationError =
  | { kind: "type"; path: string[]; expected: TypeRef; actual: TypeRef }
  | { kind: "missing"; path: string[] }
  | { kind: "literal"; path: string[]; expected: unknown; actual: unknown }
  | { kind: "enum"; path: string[]; expected: readonly unknown[]; actual: unknown }
  | { kind: "min_length"; path: string[]; expected: number; actual: number }
  | { kind: "max_length"; path: string[]; expected: number; actual: number }
  | { kind: "pattern"; path: string[]; expected: string; actual: string }
  | { kind: "format"; path: string[]; expected: string; actual: string }
  | { kind: "min"; path: string[]; expected: number; actual: number; exclusive: boolean }
  | { kind: "max"; path: string[]; expected: number; actual: number; exclusive: boolean }
  | { kind: "multiple_of"; path: string[]; expected: number; actual: number }
  | { kind: "tuple_length"; path: string[]; expected: number; actual: number }
  | { kind: "unexpected"; path: string[] }
  | { kind: "union"; path: string[]; errors: ValidationError[][] }
  | { kind: "coerce"; path: string[]; expected: string; actual: unknown }

/** Display string for a TypeRef — reuses the TypeScript projector's rendering. */
export function typeRefToString(ref: TypeRef): string {
  return toTypeScript(ref)
}

// ============================================================================
// Codegen helpers
// ============================================================================

function indentLines(lines: readonly string[], spaces: number): string[] {
  const pad = " ".repeat(spaces)
  return lines.flatMap((line) => line.split("\n")).map((line) => (line.length > 0 ? pad + line : line))
}

/** Per-entry codegen context: hoists regexes/enum-arrays/known-field-sets to
 * named consts declared once (at entry-eval time, not per-call), and mints
 * fresh local variable names for coerced/nested values in parse(). */
class GenCtx {
  private consts: string[] = []
  private constCounter = 0
  private regexCache = new Map<string, string>()
  private varCounter = 0

  addConst(prefix: string, expr: string): string {
    const name = `__${prefix}${this.constCounter++}`
    this.consts.push(`const ${name} = ${expr};`)
    return name
  }

  addRegex(pattern: string): string {
    const cached = this.regexCache.get(pattern)
    if (cached !== undefined) return cached
    const name = this.addConst("re", `new RegExp(${JSON.stringify(pattern)})`)
    this.regexCache.set(pattern, name)
    return name
  }

  fresh(prefix: string): string {
    return `__${prefix}${this.varCounter++}`
  }

  declarations(): string[] {
    return this.consts
  }
}

/** A JSON-serializable TypeRef literal, inlined into generated error objects. */
function refLiteral(ref: TypeRef): string {
  return JSON.stringify(ref)
}

function typeErrorStmt(pathExpr: string, expected: TypeRef, v: string): string {
  return `errs.push({ kind: "type", path: ${pathExpr}, expected: ${refLiteral(expected)}, actual: __inferTypeRef(${v}) });`
}

// A kind is "stringlike"/"numericlike" if it (or an ancestor) is "string" /
// "number" or "integer" — covers built-in extension kinds (uuid, int32, …)
// registered via `registerParent` without hardcoding their names here.
function isStringlike(kind: string): boolean {
  return kind === "string" || ancestors(kind).includes("string")
}
function isNumericlike(kind: string): boolean {
  return kind === "number" || kind === "integer" || ancestors(kind).some((a) => a === "number" || a === "integer")
}

/** Extra constraint checks driven by `meta` (minLength/maxLength/pattern for
 * string-/array-like kinds; minimum/maximum/exclusiveMinimum/exclusiveMaximum/
 * multipleOf for number-like kinds) — guarded by `guardCond` (the base-type
 * check) so a wrong-type value doesn't also produce spurious constraint
 * errors. Shared between errors() and parse() (parse calls this on the
 * coerced value, after coercion, with its own base-type guard). */
function metaConstraintStmts(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, guardCond: string): string[] {
  const meta = ref.meta
  const kind = ref.shape.kind
  const clauses: string[] = []
  if (isStringlike(kind) || kind === "array") {
    if (typeof meta.minLength === "number") {
      clauses.push(
        `if (${v}.length < ${meta.minLength}) { errs.push({ kind: "min_length", path: ${pathExpr}, expected: ${meta.minLength}, actual: ${v}.length }); }`,
      )
    }
    if (typeof meta.maxLength === "number") {
      clauses.push(
        `if (${v}.length > ${meta.maxLength}) { errs.push({ kind: "max_length", path: ${pathExpr}, expected: ${meta.maxLength}, actual: ${v}.length }); }`,
      )
    }
  }
  if (isStringlike(kind) && typeof meta.pattern === "string") {
    const re = ctx.addRegex(meta.pattern)
    clauses.push(
      `if (!${re}.test(${v})) { errs.push({ kind: "pattern", path: ${pathExpr}, expected: ${JSON.stringify(meta.pattern)}, actual: ${v} }); }`,
    )
  }
  if (isNumericlike(kind)) {
    if (typeof meta.minimum === "number") {
      clauses.push(
        `if (!(${v} >= ${meta.minimum})) { errs.push({ kind: "min", path: ${pathExpr}, expected: ${meta.minimum}, actual: ${v}, exclusive: false }); }`,
      )
    }
    if (typeof meta.exclusiveMinimum === "number") {
      clauses.push(
        `if (!(${v} > ${meta.exclusiveMinimum})) { errs.push({ kind: "min", path: ${pathExpr}, expected: ${meta.exclusiveMinimum}, actual: ${v}, exclusive: true }); }`,
      )
    }
    if (typeof meta.maximum === "number") {
      clauses.push(
        `if (!(${v} <= ${meta.maximum})) { errs.push({ kind: "max", path: ${pathExpr}, expected: ${meta.maximum}, actual: ${v}, exclusive: false }); }`,
      )
    }
    if (typeof meta.exclusiveMaximum === "number") {
      clauses.push(
        `if (!(${v} < ${meta.exclusiveMaximum})) { errs.push({ kind: "max", path: ${pathExpr}, expected: ${meta.exclusiveMaximum}, actual: ${v}, exclusive: true }); }`,
      )
    }
    if (typeof meta.multipleOf === "number") {
      clauses.push(
        `if (${v} % ${meta.multipleOf} !== 0) { errs.push({ kind: "multiple_of", path: ${pathExpr}, expected: ${meta.multipleOf}, actual: ${v} }); }`,
      )
    }
  }
  if (clauses.length === 0) return []
  return [`if (${guardCond}) {`, ...indentLines(clauses, 2), `}`]
}

// ============================================================================
// check(value): value is T — pure boolean expression, no statements.
// ============================================================================

type CheckHandler = (ref: TypeRef, v: string, ctx: GenCtx) => string

const FORMAT_PATTERNS: Record<string, string> = {
  uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  uri: "^[a-zA-Z][a-zA-Z0-9+.-]*:\\S*$",
  date: "^\\d{4}-\\d{2}-\\d{2}$",
  time: "^\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$",
  datetime: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$",
  duration: "^P(?:\\d+Y)?(?:\\d+M)?(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d+)?S)?)?$",
  bytes: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
}

function formatCheck(formatName: keyof typeof FORMAT_PATTERNS): CheckHandler {
  return (_ref, v, ctx) => `typeof ${v} === "string" && ${ctx.addRegex(FORMAT_PATTERNS[formatName]!)}.test(${v})`
}

const checkHandlers: Record<string, CheckHandler> = {
  boolean: (_r, v) => `typeof ${v} === "boolean"`,
  number: (_r, v) => `typeof ${v} === "number"`,
  integer: (_r, v) => `typeof ${v} === "number" && Number.isInteger(${v})`,
  int32: (_r, v) => `typeof ${v} === "number" && Number.isInteger(${v}) && ${v} >= -2147483648 && ${v} <= 2147483647`,
  int64: (_r, v) => `typeof ${v} === "number" && Number.isInteger(${v})`,
  float32: (_r, v) => `typeof ${v} === "number"`,
  float64: (_r, v) => `typeof ${v} === "number"`,
  string: (_r, v) => `typeof ${v} === "string"`,
  uuid: formatCheck("uuid"),
  uri: formatCheck("uri"),
  date: formatCheck("date"),
  time: formatCheck("time"),
  datetime: formatCheck("datetime"),
  duration: formatCheck("duration"),
  bytes: formatCheck("bytes"),
  null: (_r, v) => `${v} === null`,
  void: (_r, v) => `${v} === undefined`,
  unknown: () => "true",
  never: () => "false",
  // Purely nominal (instance) / non-structural (ref has no schema registry to
  // resolve against) shapes can't be validated structurally — pass through.
  // See the `instance`/`ref` doc comments in index.ts.
  instance: () => "true",
  ref: () => "true",
  function: (_r, v) => `typeof ${v} === "function"`,
  object: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "object" }
    const fieldClauses = Object.entries(s.fields).map(([name, field]) => {
      const fv = `${v}[${JSON.stringify(name)}]`
      const inner = genCheckExpr(field, fv, ctx)
      return field.meta.optional === true ? `(${fv} === undefined || (${inner}))` : `(${inner})`
    })
    const base = `(typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v}))`
    const parts = [base, ...fieldClauses]
    if (ref.meta.additionalProperties === false) {
      const known = ctx.addConst("known", `new Set(${JSON.stringify(Object.keys(s.fields))})`)
      parts.push(`Object.keys(${v}).every((__k) => ${known}.has(__k))`)
    }
    return parts.join(" && ")
  },
  array: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "array" }
    return `(Array.isArray(${v}) && ${v}.every((__e) => (${genCheckExpr(s.element, "__e", ctx)})))`
  },
  tuple: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "tuple" }
    const elementChecks = s.elements.map((e, i) => `(${genCheckExpr(e, `${v}[${i}]`, ctx)})`)
    return [`Array.isArray(${v})`, `${v}.length === ${s.elements.length}`, ...elementChecks].join(" && ")
  },
  map: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "map" }
    return `(typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v}) && Object.values(${v}).every((__e) => (${genCheckExpr(s.value, "__e", ctx)})))`
  },
  union: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "union" }
    if (s.variants.length === 0) return "false"
    return `(${s.variants.map((m) => `(${genCheckExpr(m, v, ctx)})`).join(" || ")})`
  },
  literal: (ref, v) => {
    const s = ref.shape as TypeShape & { kind: "literal" }
    return `${v} === ${JSON.stringify(s.value)}`
  },
  enum: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "enum" }
    const members = ctx.addConst("members", JSON.stringify(s.members))
    return `${members}.includes(${v})`
  },
  intersection: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "intersection" }
    if (s.members.length === 0) return "true"
    return s.members.map((m) => `(${genCheckExpr(m, v, ctx)})`).join(" && ")
  },
  interface: (ref, v) => {
    const s = ref.shape as TypeShape & { kind: "interface" }
    const methodChecks = Object.keys(s.methods).map((name) => `typeof ${v}[${JSON.stringify(name)}] === "function"`)
    const base = `(typeof ${v} === "object" && ${v} !== null)`
    return [base, ...methodChecks].join(" && ")
  },
}

function genCheckExpr(ref: TypeRef, v: string, ctx: GenCtx): string {
  const handler = resolve(ref.shape.kind, checkHandlers)
  const base = handler === undefined ? "true" : handler(ref, v, ctx)
  const withConstraints = metaConstraintCheckClause(ref, v, base, ctx)
  return ref.meta.nullable === true ? `(${v} === null || (${withConstraints}))` : withConstraints
}

function metaConstraintCheckClause(ref: TypeRef, v: string, base: string, ctx: GenCtx): string {
  const meta = ref.meta
  const kind = ref.shape.kind
  const clauses: string[] = []
  if (isStringlike(kind) || kind === "array") {
    if (typeof meta.minLength === "number") clauses.push(`${v}.length >= ${meta.minLength}`)
    if (typeof meta.maxLength === "number") clauses.push(`${v}.length <= ${meta.maxLength}`)
  }
  if (isStringlike(kind) && typeof meta.pattern === "string") {
    clauses.push(`${ctx.addRegex(meta.pattern)}.test(${v})`)
  }
  if (isNumericlike(kind)) {
    if (typeof meta.minimum === "number") clauses.push(`${v} >= ${meta.minimum}`)
    if (typeof meta.exclusiveMinimum === "number") clauses.push(`${v} > ${meta.exclusiveMinimum}`)
    if (typeof meta.maximum === "number") clauses.push(`${v} <= ${meta.maximum}`)
    if (typeof meta.exclusiveMaximum === "number") clauses.push(`${v} < ${meta.exclusiveMaximum}`)
    if (typeof meta.multipleOf === "number") clauses.push(`${v} % ${meta.multipleOf} === 0`)
  }
  if (clauses.length === 0) return `(${base})`
  return `((${base}) && ${clauses.join(" && ")})`
}

// ============================================================================
// errors(value)/parse(value) — statement-based codegen (shared traversal).
// ============================================================================

type Mode = "errors" | "parse"
type ValidateResult = { stmts: string[]; outExpr: string }
type ValidateHandler = (ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode) => ValidateResult

/** A leaf kind with no coercion available in parse mode: valid input passes
 * through unchanged, invalid input records a `type` error and keeps the raw
 * value (best-effort — the caller only cares whether `errs` stayed empty). */
function nonCoercingLeaf(cond: (v: string, ctx: GenCtx) => string): ValidateHandler {
  return (ref, v, pathExpr, ctx) => {
    const c = cond(v, ctx)
    const stmts = [`if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v)} }`, ...metaConstraintStmts(ref, v, pathExpr, ctx, c)]
    return { stmts, outExpr: v }
  }
}

function formatLeaf(formatName: keyof typeof FORMAT_PATTERNS): ValidateHandler {
  return (ref, v, pathExpr, ctx) => {
    const re = ctx.addRegex(FORMAT_PATTERNS[formatName]!)
    const stmts = [
      `if (typeof ${v} !== "string") { ${typeErrorStmt(pathExpr, ref, v)} }`,
      `else if (!${re}.test(${v})) { errs.push({ kind: "format", path: ${pathExpr}, expected: ${JSON.stringify(formatName)}, actual: ${v} }); }`,
      ...metaConstraintStmts(ref, v, pathExpr, ctx, `typeof ${v} === "string"`),
    ]
    return { stmts, outExpr: v }
  }
}

/** number/integer/int32/int64/float32/float64: coerces a numeric string in
 * parse mode ("42" -> 42), emitting a `coerce` error if the string isn't a
 * valid number and a `type` error if neither the raw value nor its coercion
 * matches `extra` (e.g. integer-ness). */
function numberFamilyLeaf(extra?: (v: string) => string): ValidateHandler {
  const cond = (v: string) => (extra === undefined ? `typeof ${v} === "number"` : `typeof ${v} === "number" && ${extra(v)}`)
  return (ref, v, pathExpr, ctx, mode) => {
    const c = cond(v)
    if (mode === "errors") {
      return { stmts: [`if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v)} }`, ...metaConstraintStmts(ref, v, pathExpr, ctx, c)], outExpr: v }
    }
    const out = ctx.fresh("n")
    const coercedOk = extra === undefined ? "true" : extra(out)
    const stmts = [
      `let ${out};`,
      `if (${c}) { ${out} = ${v}; }`,
      `else if (typeof ${v} === "string" && ${v}.trim() !== "" && !Number.isNaN(Number(${v}))) { ${out} = Number(${v}); if (!(${coercedOk})) { ${typeErrorStmt(pathExpr, ref, v)} } }`,
      `else { errs.push({ kind: "coerce", path: ${pathExpr}, expected: ${JSON.stringify(ref.shape.kind)}, actual: ${v} }); ${out} = ${v}; }`,
      ...metaConstraintStmts(ref, out, pathExpr, ctx, `typeof ${out} === "number"`),
    ]
    return { stmts, outExpr: out }
  }
}

const booleanLeaf: ValidateHandler = (ref, v, pathExpr, ctx, mode) => {
  const c = `typeof ${v} === "boolean"`
  if (mode === "errors") return { stmts: [`if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v)} }`], outExpr: v }
  const out = ctx.fresh("b")
  const stmts = [
    `let ${out};`,
    `if (${c}) { ${out} = ${v}; }`,
    `else if (${v} === "true") { ${out} = true; }`,
    `else if (${v} === "false") { ${out} = false; }`,
    `else { errs.push({ kind: "coerce", path: ${pathExpr}, expected: "boolean", actual: ${v} }); ${out} = ${v}; }`,
  ]
  return { stmts, outExpr: out }
}

const stringLeaf: ValidateHandler = (ref, v, pathExpr, ctx) => {
  const c = `typeof ${v} === "string"`
  const stmts = [`if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v)} }`, ...metaConstraintStmts(ref, v, pathExpr, ctx, c)]
  return { stmts, outExpr: v }
}

const literalLeaf: ValidateHandler = (ref, v, pathExpr) => {
  const s = ref.shape as TypeShape & { kind: "literal" }
  const stmts = [
    `if (${v} !== ${JSON.stringify(s.value)}) { errs.push({ kind: "literal", path: ${pathExpr}, expected: ${JSON.stringify(s.value)}, actual: ${v} }); }`,
  ]
  return { stmts, outExpr: v }
}

function enumLeaf(): ValidateHandler {
  return (ref, v, pathExpr, ctx) => {
    const s = ref.shape as TypeShape & { kind: "enum" }
    const members = ctx.addConst("members", JSON.stringify(s.members))
    const stmts = [
      `if (!${members}.includes(${v})) { errs.push({ kind: "enum", path: ${pathExpr}, expected: ${members}, actual: ${v} }); }`,
    ]
    return { stmts, outExpr: v }
  }
}

function objectValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "object" }
  const baseCond = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`
  const out = mode === "parse" ? ctx.fresh("o") : undefined
  const stmts: string[] = []
  if (out !== undefined) stmts.push(`let ${out}: Record<string, any> = {};`)
  stmts.push(`if (!(${baseCond})) { ${typeErrorStmt(pathExpr, ref, v)} } else {`)
  const body: string[] = []
  for (const [name, field] of Object.entries(s.fields)) {
    const fv = `${v}[${JSON.stringify(name)}]`
    const fpath = `${pathExpr}.concat([${JSON.stringify(name)}])`
    const inner = genValidate(field, fv, fpath, ctx, mode)
    const assign = out === undefined ? [] : [`${out}[${JSON.stringify(name)}] = ${inner.outExpr};`]
    if (field.meta.optional === true) {
      body.push(`if (${fv} !== undefined) {`, ...indentLines(inner.stmts, 2), ...indentLines(assign, 2), `}`)
    } else {
      body.push(
        `if (${fv} === undefined) { errs.push({ kind: "missing", path: ${fpath} }); }`,
        `else {`,
        ...indentLines(inner.stmts, 2),
        ...indentLines(assign, 2),
        `}`,
      )
    }
  }
  if (ref.meta.additionalProperties === false) {
    const known = ctx.addConst("known", `new Set(${JSON.stringify(Object.keys(s.fields))})`)
    body.push(
      `for (const __k of Object.keys(${v})) { if (!${known}.has(__k)) { errs.push({ kind: "unexpected", path: ${pathExpr}.concat([__k]) }); } }`,
    )
  }
  stmts.push(...indentLines(body, 2), `}`)
  return { stmts, outExpr: out ?? v }
}

function arrayValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "array" }
  const out = mode === "parse" ? ctx.fresh("a") : undefined
  const stmts: string[] = []
  if (out !== undefined) stmts.push(`let ${out}: any[] = [];`)
  stmts.push(`if (!Array.isArray(${v})) { ${typeErrorStmt(pathExpr, ref, v)} } else {`)
  const idx = ctx.fresh("i")
  const ev = ctx.fresh("e")
  const epath = ctx.fresh("p")
  const inner = genValidate(s.element, ev, epath, ctx, mode)
  const body = [
    `for (let ${idx} = 0; ${idx} < ${v}.length; ${idx}++) {`,
    `  const ${ev} = ${v}[${idx}];`,
    `  const ${epath} = ${pathExpr}.concat([String(${idx})]);`,
    ...indentLines(inner.stmts, 2),
    out === undefined ? "" : `  ${out}.push(${inner.outExpr});`,
    `}`,
    ...metaConstraintStmts(ref, v, pathExpr, ctx, "true"),
  ].filter((l) => l !== "")
  stmts.push(...indentLines(body, 2), `}`)
  return { stmts, outExpr: out ?? v }
}

function tupleValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "tuple" }
  const out = mode === "parse" ? ctx.fresh("t") : undefined
  const stmts: string[] = []
  if (out !== undefined) stmts.push(`let ${out}: any[] = [];`)
  stmts.push(`if (!Array.isArray(${v})) { ${typeErrorStmt(pathExpr, ref, v)} } else {`)
  const body: string[] = [
    `if (${v}.length !== ${s.elements.length}) { errs.push({ kind: "tuple_length", path: ${pathExpr}, expected: ${s.elements.length}, actual: ${v}.length }); }`,
  ]
  s.elements.forEach((element, i) => {
    const ev = `${v}[${i}]`
    const epath = `${pathExpr}.concat([${JSON.stringify(String(i))}])`
    const inner = genValidate(element, ev, epath, ctx, mode)
    body.push(`if (${v}.length > ${i}) {`, ...indentLines(inner.stmts, 2))
    if (out !== undefined) body.push(`  ${out}.push(${inner.outExpr});`)
    body.push(`}`)
  })
  stmts.push(...indentLines(body, 2), `}`)
  return { stmts, outExpr: out ?? v }
}

function mapValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "map" }
  const baseCond = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`
  const out = mode === "parse" ? ctx.fresh("m") : undefined
  const stmts: string[] = []
  if (out !== undefined) stmts.push(`let ${out}: Record<string, any> = {};`)
  stmts.push(`if (!(${baseCond})) { ${typeErrorStmt(pathExpr, ref, v)} } else {`)
  const key = ctx.fresh("k")
  const ev = ctx.fresh("e")
  const epath = ctx.fresh("p")
  const inner = genValidate(s.value, ev, epath, ctx, mode)
  const body = [
    `for (const ${key} of Object.keys(${v})) {`,
    `  const ${ev} = ${v}[${key}];`,
    `  const ${epath} = ${pathExpr}.concat([${key}]);`,
    ...indentLines(inner.stmts, 2),
    out === undefined ? "" : `  ${out}[${key}] = ${inner.outExpr};`,
    `}`,
  ].filter((l) => l !== "")
  stmts.push(...indentLines(body, 2), `}`)
  return { stmts, outExpr: out ?? v }
}

/** Union: tries each variant's parse in sequence against a scratch `errs`
 * array (reusing the outer `errs` binding name via block scoping — nested
 * codegen references `errs.push` unmodified); the first variant with zero
 * new errors wins. If none succeed, all variants' collected errors are
 * reported together under a single `union` error. */
function unionValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "union" }
  const out = mode === "parse" ? ctx.fresh("u") : undefined
  const matched = ctx.fresh("matched")
  const scratchNames: string[] = []
  const stmts: string[] = []
  if (out !== undefined) stmts.push(`let ${out} = ${v};`)
  stmts.push(`let ${matched} = false;`)
  for (const variant of s.variants) {
    const scratch = ctx.fresh("ue")
    scratchNames.push(scratch)
    stmts.push(`const ${scratch}: ValidationError[] = [];`)
  }
  s.variants.forEach((variant, i) => {
    const scratch = scratchNames[i]!
    const inner = genValidate(variant, v, pathExpr, ctx, mode)
    stmts.push(`if (!${matched}) {`)
    stmts.push(`  { const errs = ${scratch};`)
    stmts.push(...indentLines(inner.stmts, 4))
    stmts.push(`    if (${scratch}.length === 0) { ${matched} = true;${out === undefined ? "" : ` ${out} = ${inner.outExpr};`} }`)
    stmts.push(`  }`)
    stmts.push(`}`)
  })
  stmts.push(
    `if (!${matched}) { errs.push({ kind: "union", path: ${pathExpr}, errors: [${scratchNames.join(", ")}] }); }`,
  )
  return { stmts, outExpr: out ?? v }
}

/** Intersection: every member validates against the SAME value (not
 * alternate representations, unlike union), so their errors just accumulate
 * into the shared `errs` array at the same path. Fresh-object construction
 * merges object-shaped members' outputs via `Object.assign`, in order; a
 * non-object member's parsed value is only used if no object member exists
 * (intersections of non-object types are a degenerate case). */
function intersectionValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "intersection" }
  if (s.members.length === 0) return { stmts: [], outExpr: v }
  const out = mode === "parse" ? ctx.fresh("x") : undefined
  const stmts: string[] = []
  if (out !== undefined) stmts.push(`let ${out} = ${v};`)
  const hasObjectMember = s.members.some((m) => m.shape.kind === "object")
  if (out !== undefined && hasObjectMember) stmts.push(`${out} = {};`)
  for (const member of s.members) {
    const inner = genValidate(member, v, pathExpr, ctx, mode)
    stmts.push(...inner.stmts)
    if (out !== undefined) {
      if (hasObjectMember && member.shape.kind === "object") {
        stmts.push(`Object.assign(${out}, ${inner.outExpr});`)
      } else if (!hasObjectMember) {
        stmts.push(`${out} = ${inner.outExpr};`)
      }
    }
  }
  return { stmts, outExpr: out ?? v }
}

function interfaceValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "interface" }
  const baseCond = `typeof ${v} === "object" && ${v} !== null`
  const stmts = [`if (!(${baseCond})) { ${typeErrorStmt(pathExpr, ref, v)} } else {`]
  const body: string[] = []
  for (const name of Object.keys(s.methods)) {
    const fv = `${v}[${JSON.stringify(name)}]`
    const fpath = `${pathExpr}.concat([${JSON.stringify(name)}])`
    body.push(
      `if (typeof ${fv} === "undefined") { errs.push({ kind: "missing", path: ${fpath} }); }`,
      `else if (typeof ${fv} !== "function") { ${typeErrorStmt(fpath, ref, fv)} }`,
    )
  }
  stmts.push(...indentLines(body, 2), `}`)
  return { stmts, outExpr: v }
}

const validateHandlers: Record<string, ValidateHandler> = {
  boolean: booleanLeaf,
  number: numberFamilyLeaf(),
  integer: numberFamilyLeaf((v) => `Number.isInteger(${v})`),
  int32: numberFamilyLeaf((v) => `Number.isInteger(${v}) && ${v} >= -2147483648 && ${v} <= 2147483647`),
  int64: numberFamilyLeaf((v) => `Number.isInteger(${v})`),
  float32: numberFamilyLeaf(),
  float64: numberFamilyLeaf(),
  string: stringLeaf,
  uuid: formatLeaf("uuid"),
  uri: formatLeaf("uri"),
  date: formatLeaf("date"),
  time: formatLeaf("time"),
  datetime: formatLeaf("datetime"),
  duration: formatLeaf("duration"),
  bytes: formatLeaf("bytes"),
  null: nonCoercingLeaf((v) => `${v} === null`),
  void: nonCoercingLeaf((v) => `${v} === undefined`),
  unknown: (_ref, v) => ({ stmts: [], outExpr: v }),
  never: (ref, v, pathExpr) => ({ stmts: [typeErrorStmt(pathExpr, ref, v)], outExpr: v }),
  instance: (_ref, v) => ({ stmts: [], outExpr: v }),
  ref: (_ref, v) => ({ stmts: [], outExpr: v }),
  function: nonCoercingLeaf((v) => `typeof ${v} === "function"`),
  literal: literalLeaf,
  enum: enumLeaf(),
  object: objectValidate,
  array: arrayValidate,
  tuple: tupleValidate,
  map: mapValidate,
  union: unionValidate,
  intersection: intersectionValidate,
  interface: interfaceValidate,
}

function genValidateShape(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode): ValidateResult {
  const handler = resolve(ref.shape.kind, validateHandlers)
  if (handler === undefined) return { stmts: [], outExpr: v }
  return handler(ref, v, pathExpr, ctx, mode)
}

function genValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx, mode: Mode): ValidateResult {
  if (ref.meta.nullable === true) {
    const out = mode === "parse" ? ctx.fresh("n") : undefined
    const inner = genValidateShape(ref, v, pathExpr, ctx, mode)
    const stmts = [
      out === undefined ? "" : `let ${out};`,
      `if (${v} === null) {`,
      out === undefined ? "" : `  ${out} = null;`,
      `} else {`,
      ...indentLines(inner.stmts, 2),
      out === undefined ? "" : `  ${out} = ${inner.outExpr};`,
      `}`,
    ].filter((l) => l !== "")
    return { stmts, outExpr: out ?? v }
  }
  return genValidateShape(ref, v, pathExpr, ctx, mode)
}

// ============================================================================
// Runtime helper embedded once per compiled entry — infers a best-effort
// TypeRef "shape" for an arbitrary runtime value, used as the `actual` field
// of a `type` ValidationError (paired with `expected`, the TypeRef that was
// checked against — see typeRefToString for turning either into display text).
// ============================================================================

const INFER_TYPE_REF_SOURCE = `function __inferTypeRef(v: any) {
  if (v === null) return { shape: { kind: "null" }, meta: {} };
  if (v === undefined) return { shape: { kind: "void" }, meta: {} };
  if (Array.isArray(v)) return { shape: { kind: "array", element: { shape: { kind: "unknown" }, meta: {} } }, meta: {} };
  if (typeof v === "object") return { shape: { kind: "object", fields: {} }, meta: {} };
  if (typeof v === "function") return { shape: { kind: "function", params: [], returnType: { shape: { kind: "unknown" }, meta: {} } }, meta: {} };
  return { shape: { kind: typeof v }, meta: {} };
}`

// ============================================================================
// Top-level assembly: one TypeRef -> { check, errors, parse } source.
// ============================================================================

/**
 * The type-guard annotation for a validator's input, plus the `import type`
 * this annotation needs (if any). Two cases:
 *   - The TypeRef carries `meta.typeName` + `meta.declarationFile` (see
 *     index.ts's meta-bag doc) AND the caller passed `resolveImport`: the
 *     annotation is the bare type name, imported.
 *   - Otherwise: the annotation is the type's own structural TypeScript
 *     rendering (`toTypeScript`), inlined directly.
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

/** Emit the `{ check, errors, parse }` triple's body lines (no wrapping
 * IIFE/braces — the caller supplies those) for a single TypeRef. `withHelper`
 * controls whether the `__inferTypeRef` runtime helper (used by `type`-kind
 * ValidationErrors) is declared inline — `compileValidatorModule` hoists one
 * shared copy to module scope instead and passes `false`. */
function compileEntryBody(ref: TypeRef, annotation: string, withHelper: boolean): string[] {
  const ctx = new GenCtx()
  const checkExpr = genCheckExpr(ref, "value", ctx)
  const errorsBody = genValidate(ref, "value", "path", ctx, "errors")
  const parseBody = genValidate(ref, "value", "path", ctx, "parse")

  const lines: string[] = []
  if (withHelper) lines.push(INFER_TYPE_REF_SOURCE)
  lines.push(...ctx.declarations())
  // `value: any` (not `unknown`) throughout the raw compiled body — bracket
  // access (`value["field"]`) only type-checks against `any`; the ANNOTATED,
  // narrower signature (`value is T`, the discriminated `parse` return type)
  // is applied at the CALL site via the `as {...}` cast below, same
  // reasoning as the retired TypeBox-compiler wrapper this replaces.
  lines.push(`function check(value: any) {`)
  lines.push(`  return (${checkExpr});`)
  lines.push(`}`)
  lines.push(`function errors(value: any): ValidationError[] {`)
  lines.push(`  const path: string[] = [];`)
  lines.push(`  const errs: ValidationError[] = [];`)
  lines.push(...indentLines(errorsBody.stmts, 2))
  lines.push(`  return errs;`)
  lines.push(`}`)
  lines.push(`function parse(value: any) {`)
  lines.push(`  const path: string[] = [];`)
  lines.push(`  const errs: ValidationError[] = [];`)
  lines.push(...indentLines(parseBody.stmts, 2))
  lines.push(`  if (errs.length === 0) return { kind: "ok" as const, value: ${parseBody.outExpr} };`)
  lines.push(`  return { kind: "err" as const, errors: errs };`)
  lines.push(`}`)
  lines.push(
    `return { check: check, errors: errors, parse: parse };`,
  )
  return lines
}

/**
 * Compile a single TypeRef to a standalone JS EXPRESSION evaluating to `{
 * check, errors, parse }` — zero runtime dependency, `check`/`parse` narrow
 * via TypeScript (a type-guard cast on `check`, a discriminated-union return
 * type on `parse`).
 */
export function compileValidator(ref: TypeRef): string {
  const { annotation } = guardAnnotation(ref, undefined)
  const body = compileEntryBody(ref, annotation, true)
  return [
    "(function () {",
    ...indentLines(body, 2),
    "})() as unknown as {",
    `  check: (value: unknown) => value is ${annotation};`,
    "  errors: (value: unknown) => ValidationError[];",
    `  parse: (value: unknown) => { kind: "ok"; value: ${annotation} } | { kind: "err"; errors: ValidationError[] };`,
    "}",
  ].join("\n")
}

const VALIDATION_ERROR_TYPE_SOURCE = `export type ValidationError =
  | { kind: "type"; path: string[]; expected: unknown; actual: unknown }
  | { kind: "missing"; path: string[] }
  | { kind: "literal"; path: string[]; expected: unknown; actual: unknown }
  | { kind: "enum"; path: string[]; expected: readonly unknown[]; actual: unknown }
  | { kind: "min_length"; path: string[]; expected: number; actual: number }
  | { kind: "max_length"; path: string[]; expected: number; actual: number }
  | { kind: "pattern"; path: string[]; expected: string; actual: string }
  | { kind: "format"; path: string[]; expected: string; actual: string }
  | { kind: "min"; path: string[]; expected: number; actual: number; exclusive: boolean }
  | { kind: "max"; path: string[]; expected: number; actual: number; exclusive: boolean }
  | { kind: "multiple_of"; path: string[]; expected: number; actual: number }
  | { kind: "tuple_length"; path: string[]; expected: number; actual: number }
  | { kind: "unexpected"; path: string[] }
  | { kind: "union"; path: string[]; errors: ValidationError[][] }
  | { kind: "coerce"; path: string[]; expected: string; actual: unknown };`

/**
 * Emit a complete, standalone, zero-runtime-dependency TypeScript module
 * exporting a `validators` object — `Record<name, { check, errors, parse }>`.
 * The build orchestrator (api-tree's build.ts) adapts each entry's `parse`
 * into whatever single-function `Validator` shape its own consumer (e.g.
 * http-api-projector's `createApplyValidation`) expects; this module makes
 * no assumption about that consumer.
 *
 * `expected`/`actual` in a `type`-kind `ValidationError` are TypeRef values
 * (see `ValidationError`'s doc in this file) — the module-local
 * `ValidationError` type widens them to `unknown` (no import of type-ir's own
 * `TypeRef` type needed to keep the emitted module dependency-free); pass the
 * emitted values to `typeRefToString` (importable from `@rhi-zone/fractal-type-ir`)
 * for a display string.
 */
export function compileValidatorModule(
  entries: readonly { name: string; ref: TypeRef }[],
  options?: { resolveImport?: (declarationFile: string) => string },
): string {
  const imports = new Map<string, Set<string>>()
  const lines: string[] = []
  lines.push("// AUTO-GENERATED by @rhi-zone/fractal-type-ir. Do not edit by hand.")
  lines.push("")

  const entryLines: string[] = []
  for (const { name, ref } of entries) {
    const { annotation, typeImport } = guardAnnotation(ref, options?.resolveImport)
    if (typeImport) {
      const names = imports.get(typeImport.from) ?? new Set<string>()
      names.add(typeImport.typeName)
      imports.set(typeImport.from, names)
    }
    const body = compileEntryBody(ref, annotation, false)
    entryLines.push(`  ${JSON.stringify(name)}: (function () {`)
    entryLines.push(...indentLines(body, 4))
    entryLines.push(`  })() as unknown as {`)
    entryLines.push(`    check: (value: unknown) => value is ${annotation};`)
    entryLines.push(`    errors: (value: unknown) => ValidationError[];`)
    entryLines.push(
      `    parse: (value: unknown) => { kind: "ok"; value: ${annotation} } | { kind: "err"; errors: ValidationError[] };`,
    )
    entryLines.push(`  },`)
  }

  for (const [from, names] of imports) {
    lines.push(`import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(from)}`)
  }
  if (imports.size > 0) lines.push("")

  lines.push(VALIDATION_ERROR_TYPE_SOURCE)
  lines.push("")
  lines.push(INFER_TYPE_REF_SOURCE)
  lines.push("")
  lines.push("export const validators = {")
  lines.push(...entryLines)
  lines.push("}")
  lines.push("")
  return lines.join("\n")
}
