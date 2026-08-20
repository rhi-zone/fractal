// AOT validator codegen: compiles a TypeRef to standalone JS/TS source with
// zero runtime dependencies. Rather than building an intermediate schema
// representation and compiling that (the retired TypeBox-based approach,
// TypeRef -> TSchema -> `TypeCompiler.Code()`), this codegen walks the
// TypeRef tree directly and emits string templates per shape kind.
//
// Each compiled operation gets three standalone functions:
//   - check(value): value is T         — boolean fast path, no allocations
//     on the happy path, short-circuits on first failure. Used at the hot
//     request-time path where only a yes/no answer is needed.
//   - errors(value): ValidationError[] — structured error collection; checks
//     every field (doesn't short-circuit) so a caller can report everything
//     wrong with a payload in one pass.
//   - parse(value): {kind:"ok",value:T} | {kind:"err",errors}
//                                       — validates and coerces (e.g. string
//     "42" -> number 42) in one pass, building a fresh output value that
//     never mutates the input. The ok branch narrows via the discriminated-
//     union return type, with no explicit `is` predicate needed. One
//     carve-out: `unknown`/`instance`/`ref` subtrees have no structure to
//     validate or rebuild from, so their parsed output aliases the
//     corresponding input subtree rather than copying it — see the
//     `validateHandlers.unknown`/`instance`/`ref` doc comment below.
//
// Codegen strategy: string templates with thin helpers (indent, a per-entry
// const-hoisting pool for regexes/enum-member-arrays/known-field-sets), not
// ts-morph and not an intermediate IR — codegen runs on every build, so the
// template functions stay cheap. Each TypeRef shape kind gets its own
// template function; the registry (index.ts's `resolve`) is open, so a new
// kind only needs a `checkHandlers`/`validateHandlers` entry (or inherits
// its parent's via `ancestors()`).

import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts";
import { defTypeAliasName, sanitizeDefName, toTypeScript } from "./typescript-native.ts";

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
  // Wire-profile encoding-stage error (see "Wire profiles + staged
  // validation" below): the wire value wasn't even the WIRE shape a profile's
  // `decode` expects at all — e.g. a JSON object where argv only ever hands a
  // leaf `string | string[] | true`. `expected` is a human-readable WIRE-shape
  // description ("numeric string", `"true" or "false"`, "ISO date string"),
  // never a `TypeRef` — this is the encoding-stage counterpart to `coerce`
  // (right wire type, unparseable content) and `type` (a `T`-shape mismatch,
  // phrased against `T`): `encoding` is phrased against what the caller
  // actually sent, one level below `coerce`, per the design doc's "errors are
  // phrased against what the caller actually sent" requirement.
  | { kind: "encoding"; path: string[]; expected: string; actual: unknown }
  // Wire-profile custom-decoder (function-form `encodingMap`) failure: the
  // wire value passed `validateEncoding` (it IS the right wire shape — an
  // `"encoding"` error would have already fired otherwise) but the user's
  // own decoder function THREW while turning it into `T`. Neither `coerce`
  // (a builtin coercion failure) nor `encoding` (wrong wire shape) apply —
  // this is a distinct, later stage: semantically-invalid CONTENT per the
  // user's own decoder, not a shape problem this codebase's own machinery
  // could have caught. `message` carries the thrown value's message
  // (`error instanceof Error ? error.message : String(error)`) — a decoder
  // can throw anything, not just an `Error`, so this is never a lossy cast.
  | { kind: "decode"; path: string[]; message: string };

/** Display string for a TypeRef — reuses the TypeScript projector's rendering. */
export function typeRefToString(ref: TypeRef): string {
  return toTypeScript(ref);
}

// ============================================================================
// Codegen helpers
// ============================================================================

function indentLines(lines: readonly string[], spaces: number): string[] {
  const pad = " ".repeat(spaces);
  return lines
    .flatMap((line) => line.split("\n"))
    .map((line) => (line.length > 0 ? pad + line : line));
}

/** Per-entry codegen context: hoists regexes/enum-arrays/known-field-sets to
 * named consts declared once (at entry-eval time, not per-call), and mints
 * fresh local variable names for coerced/nested values in parse(). */
class GenCtx {
  /** Module-uniqueness namespace, empty by default (every single-`GenCtx`-
   * per-module caller — `compileEntryBody`'s/`compileWireEntryFragment`'s own
   * IIFE-scoped `ctx`, `compileDefsBlock`'s single shared `defCtx` — reproduces the
   * exact `__prefixN` names it always has). Only a caller that splices multiple
   * `GenCtx` instances' hoisted consts into one shared scope (`compileConstraintsFn`,
   * whose `fn.lines` land at module scope in `assembleWireModule`/
   * `assembleWireApplyValidationModule`) needs distinct instances to mint
   * non-colliding names — passing each instance its own namespace (e.g. the entry
   * name) is the fix, done once here rather than by post-hoc textual renaming at
   * every assembly site that splices more than one instance's declarations together. */
  constructor(private readonly namespace: string = "") {}
  private consts: string[] = [];
  private constCounter = 0;
  // Keyed by `${prefix}\0${expr}` — check/errors/parse each walk the same
  // TypeRef tree independently against the same ctx (see `compileEntryBody`),
  // so an enum's member array or an object's known-field Set gets requested
  // up to three times with identical content. Caching by content (not just
  // by regex pattern, which `addRegex` already did) means each unique
  // literal is hoisted once and shared across all three functions' bodies.
  private constCache = new Map<string, string>();
  private regexCache = new Map<string, string>();
  private varCounter = 0;

  /** Names of `defs` entries in scope for this compile — populated by
   * `compileDefs` before `genCheckExpr`/`genValidate` walk any body that
   * might reference them via `ref`. A `ref` whose target isn't in this set has
   * no generated function to call and passes through unchanged, the same
   * behavior as a bare `TypeRef` with no `defs`. */
  readonly defNames = new Set<string>();

  addConst(prefix: string, expr: string): string {
    const cacheKey = `${prefix}\0${expr}`;
    const cached = this.constCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const name = `__${this.namespace}${prefix}${this.constCounter++}`;
    this.consts.push(`const ${name} = ${expr};`);
    this.constCache.set(cacheKey, name);
    return name;
  }

  addRegex(pattern: string): string {
    const cached = this.regexCache.get(pattern);
    if (cached !== undefined) return cached;
    const name = this.addConst("re", `new RegExp(${JSON.stringify(pattern)})`);
    this.regexCache.set(pattern, name);
    return name;
  }

  fresh(prefix: string): string {
    return `__${prefix}${this.varCounter++}`;
  }

  declarations(): string[] {
    return this.consts;
  }
}

/** The generated function name for a `defs` entry's check/errors/parse
 * facet — e.g. `defFnName("User", "check")` → `__def_User_check`. Shared by
 * `compileDefs` (which emits the function declarations) and the `ref`
 * handlers below (which call them). Sanitizes `name` to a valid JS
 * identifier fragment so def names containing characters JS identifiers
 * can't (e.g. `"Foo.Bar"`, generic instantiation names) still emit valid code. */
function defFnName(name: string, facet: "check" | "errors" | "parse"): string {
  return `__def_${sanitizeDefName(name)}_${facet}`;
}

/** A JSON-serializable TypeRef literal, hoisted to a shared const (via `ctx`)
 * so a TypeRef checked at multiple call sites — check/errors/parse each walk
 * the same tree, and a shape can recur under a union/array/object — emits its
 * `JSON.stringify` literal once rather than inlining it at every site.
 * `as any`: the literal's inferred object-literal type (`{ kind: string }`,
 * a widened string, not the exact `TypeKinds` discriminant it structurally
 * is) doesn't satisfy `ValidationError`'s `expected`/`actual: TypeRef` field
 * without a full recursive `TypeRef`-shaped type annotation reproduced
 * inline — `any` sidesteps that without weakening `ValidationError` itself,
 * whose real definition (imported from type-ir, see `assembleWireModule`
 * and this file's own `ValidationError` export) still requires `TypeRef`. */
function refLiteral(ref: TypeRef, ctx: GenCtx): string {
  return ctx.addConst("ref", `${JSON.stringify(ref)} as any`);
}

function typeErrorStmt(pathExpr: string, expected: TypeRef, v: string, ctx: GenCtx): string {
  return `errs.push({ kind: "type", path: ${pathExpr}, expected: ${refLiteral(expected, ctx)}, actual: __inferTypeRef(${v}) });`;
}

// A kind is "stringlike"/"numericlike" if it (or an ancestor) is "string" /
// "number" or "integer" — covers built-in extension kinds (uuid, int32, …)
// registered via `registerParent` without hardcoding their names here.
function isStringlike(kind: string): boolean {
  return kind === "string" || ancestors(kind).includes("string");
}
function isNumericlike(kind: string): boolean {
  return (
    kind === "number" ||
    kind === "integer" ||
    ancestors(kind).some((a) => a === "number" || a === "integer")
  );
}

/** Extra constraint checks driven by `meta` (minLength/maxLength/pattern for
 * string-/array-like kinds; minimum/maximum/exclusiveMinimum/exclusiveMaximum/
 * multipleOf for number-like kinds) — guarded by `guardCond` (the base-type
 * check) so a wrong-type value doesn't also produce spurious constraint
 * errors. Shared between errors() and parse() (parse calls this on the
 * coerced value, after coercion, with its own base-type guard). */
function metaConstraintStmts(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  guardCond: string,
): string[] {
  const meta = ref.meta;
  const kind = ref.shape.kind;
  const clauses: string[] = [];
  if (isStringlike(kind) || kind === "array") {
    if (typeof meta.minLength === "number") {
      clauses.push(
        `if (${v}.length < ${meta.minLength}) { errs.push({ kind: "min_length", path: ${pathExpr}, expected: ${meta.minLength}, actual: ${v}.length }); }`,
      );
    }
    if (typeof meta.maxLength === "number") {
      clauses.push(
        `if (${v}.length > ${meta.maxLength}) { errs.push({ kind: "max_length", path: ${pathExpr}, expected: ${meta.maxLength}, actual: ${v}.length }); }`,
      );
    }
  }
  if (isStringlike(kind) && typeof meta.pattern === "string") {
    const re = ctx.addRegex(meta.pattern);
    clauses.push(
      `if (!${re}.test(${v})) { errs.push({ kind: "pattern", path: ${pathExpr}, expected: ${JSON.stringify(meta.pattern)}, actual: ${v} }); }`,
    );
  }
  if (isNumericlike(kind)) {
    if (typeof meta.minimum === "number") {
      clauses.push(
        `if (!(${v} >= ${meta.minimum})) { errs.push({ kind: "min", path: ${pathExpr}, expected: ${meta.minimum}, actual: ${v}, exclusive: false }); }`,
      );
    }
    if (typeof meta.exclusiveMinimum === "number") {
      clauses.push(
        `if (!(${v} > ${meta.exclusiveMinimum})) { errs.push({ kind: "min", path: ${pathExpr}, expected: ${meta.exclusiveMinimum}, actual: ${v}, exclusive: true }); }`,
      );
    }
    if (typeof meta.maximum === "number") {
      clauses.push(
        `if (!(${v} <= ${meta.maximum})) { errs.push({ kind: "max", path: ${pathExpr}, expected: ${meta.maximum}, actual: ${v}, exclusive: false }); }`,
      );
    }
    if (typeof meta.exclusiveMaximum === "number") {
      clauses.push(
        `if (!(${v} < ${meta.exclusiveMaximum})) { errs.push({ kind: "max", path: ${pathExpr}, expected: ${meta.exclusiveMaximum}, actual: ${v}, exclusive: true }); }`,
      );
    }
    if (typeof meta.multipleOf === "number") {
      clauses.push(
        `if (${v} % ${meta.multipleOf} !== 0) { errs.push({ kind: "multiple_of", path: ${pathExpr}, expected: ${meta.multipleOf}, actual: ${v} }); }`,
      );
    }
  }
  if (clauses.length === 0) return [];
  return [`if (${guardCond}) {`, ...indentLines(clauses, 2), `}`];
}

// ============================================================================
// check(value): value is T — pure boolean expression, no statements.
// ============================================================================

type CheckHandler = (ref: TypeRef, v: string, ctx: GenCtx) => string;

const FORMAT_PATTERNS: Record<string, string> = {
  uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  uri: "^[a-zA-Z][a-zA-Z0-9+.-]*:\\S*$",
  email: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
  time: "^\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?$",
  duration: "^P(?:\\d+Y)?(?:\\d+M)?(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d+)?S)?)?$",
  bytes: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
};

function formatCheck(formatName: keyof typeof FORMAT_PATTERNS): CheckHandler {
  return (_ref, v, ctx) =>
    `typeof ${v} === "string" && ${ctx.addRegex(FORMAT_PATTERNS[formatName]!)}.test(${v})`;
}

// datetime/date are the domain type `Date` (see kinds/date-time.ts), not a
// string subtype — a valid value is a `Date` instance whose `getTime()`
// isn't `NaN` (an "Invalid Date" is a `Date` instance too, so `instanceof`
// alone isn't sufficient).
function dateCheck(): CheckHandler {
  return (_ref, v) => `(${v} instanceof Date && !Number.isNaN(${v}.getTime()))`;
}

// `stream` (AsyncIterable<T>) is a runtime construct, not a materialized
// value — its elements are only observable by consuming the iterator, and
// validation must not do that (it would drain a live generator as a side
// effect of a type check). The only structural fact checkable without
// consuming it is whether the value looks like an async iterable at all —
// the `Symbol.asyncIterator` duck-check every native `for await` loop relies
// on. Elements are not validated — see the `stream` doc comment in index.ts
// and TODO.md.
function isAsyncIterableExpr(v: string): string {
  return `(typeof ${v} === "object" && ${v} !== null && typeof ${v}[Symbol.asyncIterator] === "function")`;
}

// `page` (CursorPage<T>/OffsetPage<T>, see api-tree/src/page.ts) is a
// materialized value — `items`/`hasMore` plus either `cursor` (cursor style)
// or `offset`/`total` (offset style) — so unlike `stream` it validates like
// any other structural shape. Modeled as a synthetic `object` TypeRef and
// delegated to the `object` handlers (`genCheckExpr`/`genValidate` below),
// reusing `objectValidate`'s per-field optional handling for `cursor?`
// rather than duplicating it.
function pageAsObjectRef(ref: TypeRef): TypeRef {
  const s = ref.shape as TypeShape & { kind: "page" };
  const items: TypeRef = { shape: { kind: "array", element: s.element }, meta: {} };
  const hasMore: TypeRef = { shape: { kind: "boolean" }, meta: {} };
  const fields: Record<string, TypeRef> =
    s.style === "cursor"
      ? { items, cursor: { shape: { kind: "string" }, meta: { optional: true } }, hasMore }
      : {
          items,
          offset: { shape: { kind: "number" }, meta: {} },
          total: { shape: { kind: "number" }, meta: {} },
          hasMore,
        };
  return { shape: { kind: "object", fields }, meta: {} };
}

const checkHandlers: Record<string, CheckHandler> = {
  boolean: (_r, v) => `typeof ${v} === "boolean"`,
  number: (_r, v) => `typeof ${v} === "number"`,
  integer: (_r, v) => `typeof ${v} === "number" && Number.isInteger(${v})`,
  int32: (_r, v) =>
    `typeof ${v} === "number" && Number.isInteger(${v}) && ${v} >= -2147483648 && ${v} <= 2147483647`,
  int64: (_r, v) =>
    `typeof ${v} === "number" && Number.isInteger(${v}) && ${v} >= Number.MIN_SAFE_INTEGER && ${v} <= Number.MAX_SAFE_INTEGER`,
  float32: (_r, v) => `typeof ${v} === "number"`,
  float64: (_r, v) => `typeof ${v} === "number"`,
  string: (_r, v) => `typeof ${v} === "string"`,
  uuid: formatCheck("uuid"),
  uri: formatCheck("uri"),
  email: formatCheck("email"),
  date: dateCheck(),
  time: formatCheck("time"),
  datetime: dateCheck(),
  duration: formatCheck("duration"),
  bytes: formatCheck("bytes"),
  null: (_r, v) => `${v} === null`,
  void: (_r, v) => `${v} === undefined`,
  unknown: () => "true",
  never: () => "false",
  // Purely nominal (instance) shapes can't be validated structurally — pass
  // through. See the `instance` doc comment in index.ts.
  instance: () => "true",
  // `ref` resolves against a document's `defs` (see index.ts's
  // `TypeRefDocument`) — delegates to the named validator function
  // `compileEntryBody`/`compileDefs` emit for the target def, so a recursive
  // def type-checks by ordinary mutual JS-function recursion, with no cycle
  // detection needed here. A ref with no matching def in scope (bare TypeRef,
  // no `defs` passed to `compileValidator`) has nothing to call and passes
  // through unchanged.
  ref: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "ref" };
    return ctx.defNames.has(s.target) ? `${defFnName(s.target, "check")}(${v})` : "true";
  },
  function: (_r, v) => `typeof ${v} === "function"`,
  object: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "object" };
    const fieldClauses = Object.entries(s.fields).map(([name, field]) => {
      const fv = `${v}[${JSON.stringify(name)}]`;
      const inner = genCheckExpr(field, fv, ctx);
      return field.meta.optional === true ? `(${fv} === undefined || (${inner}))` : `(${inner})`;
    });
    const base = `(typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v}))`;
    const parts = [base, ...fieldClauses];
    if (ref.meta.additionalProperties === false) {
      const known = ctx.addConst("known", `new Set(${JSON.stringify(Object.keys(s.fields))})`);
      parts.push(`Object.keys(${v}).every((__k) => ${known}.has(__k))`);
    }
    return parts.join(" && ");
  },
  array: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "array" };
    return `(Array.isArray(${v}) && ${v}.every((__e) => (${genCheckExpr(s.element, "__e", ctx)})))`;
  },
  // See `isAsyncIterableExpr`'s doc comment above — elements aren't checked.
  stream: (_ref, v) => isAsyncIterableExpr(v),
  // See `pageAsObjectRef`'s doc comment above — delegates to `object`.
  page: (ref, v, ctx) => genCheckExpr(pageAsObjectRef(ref), v, ctx),
  tuple: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "tuple" };
    const elementChecks = s.elements.map((e, i) => `(${genCheckExpr(e, `${v}[${i}]`, ctx)})`);
    return [`Array.isArray(${v})`, `${v}.length === ${s.elements.length}`, ...elementChecks].join(
      " && ",
    );
  },
  map: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "map" };
    // `Object.values(${v})` — not `Object.keys` (always `string[]`, no
    // generic ambiguity) — hits a TS overload-resolution quirk when `${v}` is
    // `any`: `values<T>(o: { [s: string]: T } | ArrayLike<T>): T[]` matches
    // even an `any` argument, but with no contextual type to infer `T` from,
    // TS resolves it to `unknown` (not `any`), so the `.every` callback's
    // element parameter loses `any`'s implicit-index-access exemption — a
    // `TS7053` on the very next property/index access inside that callback
    // (minimal repro: `Object.values((v as any)["x"]).every((e) => e["y"])`
    // fails `noImplicitAny` under `--strict` even though `v` is `any`).
    // `as any[]` forces the array itself back to `any[]`, restoring `any`'s
    // pass-through semantics for the callback parameter — a type-level cast
    // only, erased at runtime, with no effect on the emitted module's actual
    // validation behavior.
    return `(typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v}) && Object.keys(${v}).every((__k) => (${genCheckExpr(s.key, "__k", ctx)})) && (Object.values(${v}) as any[]).every((__e) => (${genCheckExpr(s.value, "__e", ctx)})))`;
  },
  union: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "union" };
    if (s.variants.length === 0) return "false";
    return `(${s.variants.map((m) => `(${genCheckExpr(m, v, ctx)})`).join(" || ")})`;
  },
  literal: (ref, v) => {
    const s = ref.shape as TypeShape & { kind: "literal" };
    return `${v} === ${JSON.stringify(s.value)}`;
  },
  enum: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "enum" };
    const members = ctx.addConst("members", JSON.stringify(s.members));
    return `${members}.includes(${v})`;
  },
  intersection: (ref, v, ctx) => {
    const s = ref.shape as TypeShape & { kind: "intersection" };
    if (s.members.length === 0) return "true";
    return s.members.map((m) => `(${genCheckExpr(m, v, ctx)})`).join(" && ");
  },
  interface: (ref, v) => {
    const s = ref.shape as TypeShape & { kind: "interface" };
    const methodChecks = Object.keys(s.methods).map(
      (name) => `typeof ${v}[${JSON.stringify(name)}] === "function"`,
    );
    const base = `(typeof ${v} === "object" && ${v} !== null)`;
    return [base, ...methodChecks].join(" && ");
  },
};

function genCheckExpr(ref: TypeRef, v: string, ctx: GenCtx): string {
  const handler = resolve(ref.shape.kind, checkHandlers);
  const base = handler === undefined ? "true" : handler(ref, v, ctx);
  const withConstraints = metaConstraintCheckClause(ref, v, base, ctx);
  return ref.meta.nullable === true ? `(${v} === null || (${withConstraints}))` : withConstraints;
}

function metaConstraintCheckClause(ref: TypeRef, v: string, base: string, ctx: GenCtx): string {
  const meta = ref.meta;
  const kind = ref.shape.kind;
  const clauses: string[] = [];
  if (isStringlike(kind) || kind === "array") {
    if (typeof meta.minLength === "number") clauses.push(`${v}.length >= ${meta.minLength}`);
    if (typeof meta.maxLength === "number") clauses.push(`${v}.length <= ${meta.maxLength}`);
  }
  if (isStringlike(kind) && typeof meta.pattern === "string") {
    clauses.push(`${ctx.addRegex(meta.pattern)}.test(${v})`);
  }
  if (isNumericlike(kind)) {
    if (typeof meta.minimum === "number") clauses.push(`${v} >= ${meta.minimum}`);
    if (typeof meta.exclusiveMinimum === "number") clauses.push(`${v} > ${meta.exclusiveMinimum}`);
    if (typeof meta.maximum === "number") clauses.push(`${v} <= ${meta.maximum}`);
    if (typeof meta.exclusiveMaximum === "number") clauses.push(`${v} < ${meta.exclusiveMaximum}`);
    if (typeof meta.multipleOf === "number") clauses.push(`${v} % ${meta.multipleOf} === 0`);
  }
  if (clauses.length === 0) return `(${base})`;
  return `((${base}) && ${clauses.join(" && ")})`;
}

// ============================================================================
// errors(value)/parse(value) — statement-based codegen (shared traversal).
// ============================================================================

type Mode = "errors" | "parse";
type ValidateResult = { stmts: string[]; outExpr: string };
type ValidateHandler = (
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
) => ValidateResult;

/** A leaf kind with no coercion available in parse mode: valid input passes
 * through unchanged, invalid input records a `type` error and keeps the raw
 * value (best-effort — the caller only cares whether `errs` stayed empty). */
function nonCoercingLeaf(cond: (v: string, ctx: GenCtx) => string): ValidateHandler {
  return (ref, v, pathExpr, ctx) => {
    const c = cond(v, ctx);
    const stmts = [
      `if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} }`,
      ...metaConstraintStmts(ref, v, pathExpr, ctx, c),
    ];
    return { stmts, outExpr: v };
  };
}

function formatLeaf(formatName: keyof typeof FORMAT_PATTERNS): ValidateHandler {
  return (ref, v, pathExpr, ctx) => {
    const re = ctx.addRegex(FORMAT_PATTERNS[formatName]!);
    const stmts = [
      `if (typeof ${v} !== "string") { ${typeErrorStmt(pathExpr, ref, v, ctx)} }`,
      `else if (!${re}.test(${v})) { errs.push({ kind: "format", path: ${pathExpr}, expected: ${JSON.stringify(formatName)}, actual: ${v} }); }`,
      ...metaConstraintStmts(ref, v, pathExpr, ctx, `typeof ${v} === "string"`),
    ];
    return { stmts, outExpr: v };
  };
}

/** datetime/date: valid input is a `Date` instance with a non-NaN
 * `getTime()`; parse mode additionally coerces an ISO-ish string via
 * `new Date(v)`, emitting a `coerce` error (not `type`) when that
 * construction lands on Invalid Date — same "wrong shape entirely" vs.
 * "right shape, unparseable content" split `numberFamilyLeaf` draws between
 * `type` and `coerce` errors. */
function dateLeaf(): ValidateHandler {
  const isValidDate = (v: string) => `${v} instanceof Date && !Number.isNaN(${v}.getTime())`;
  return (ref, v, pathExpr, ctx, mode) => {
    const c = isValidDate(v);
    if (mode === "errors") {
      return { stmts: [`if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} }`], outExpr: v };
    }
    const out = ctx.fresh("d");
    const stmts = [
      `let ${out};`,
      `if (${c}) { ${out} = ${v}; }`,
      `else if (typeof ${v} === "string") { const __d = new Date(${v}); if (!Number.isNaN(__d.getTime())) { ${out} = __d; } else { errs.push({ kind: "coerce", path: ${pathExpr}, expected: ${JSON.stringify(ref.shape.kind)}, actual: ${v} }); ${out} = ${v}; } }`,
      `else { ${typeErrorStmt(pathExpr, ref, v, ctx)} ${out} = ${v}; }`,
    ];
    return { stmts, outExpr: out };
  };
}

/** number/integer/int32/int64/float32/float64: coerces a numeric string in
 * parse mode ("42" -> 42), emitting a `coerce` error if the string isn't a
 * valid number and a `type` error if neither the raw value nor its coercion
 * matches `extra` (e.g. integer-ness). */
function numberFamilyLeaf(extra?: (v: string) => string): ValidateHandler {
  const cond = (v: string) =>
    extra === undefined ? `typeof ${v} === "number"` : `typeof ${v} === "number" && ${extra(v)}`;
  return (ref, v, pathExpr, ctx, mode) => {
    const c = cond(v);
    if (mode === "errors") {
      return {
        stmts: [
          `if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} }`,
          ...metaConstraintStmts(ref, v, pathExpr, ctx, c),
        ],
        outExpr: v,
      };
    }
    const out = ctx.fresh("n");
    const coercedOk = extra === undefined ? "true" : extra(out);
    const stmts = [
      `let ${out};`,
      `if (${c}) { ${out} = ${v}; }`,
      `else if (typeof ${v} === "string" && ${v}.trim() !== "" && !Number.isNaN(Number(${v}))) { ${out} = Number(${v}); if (!(${coercedOk})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} } }`,
      // A string that failed to parse as a number is a coercion failure; any
      // other wrong type (boolean, array, object, null) is a type error —
      // same kind errors() would report, so the two modes agree.
      `else if (typeof ${v} === "string") { errs.push({ kind: "coerce", path: ${pathExpr}, expected: ${JSON.stringify(ref.shape.kind)}, actual: ${v} }); ${out} = ${v}; }`,
      `else { ${typeErrorStmt(pathExpr, ref, v, ctx)} ${out} = ${v}; }`,
      ...metaConstraintStmts(ref, out, pathExpr, ctx, `typeof ${out} === "number"`),
    ];
    return { stmts, outExpr: out };
  };
}

const booleanLeaf: ValidateHandler = (ref, v, pathExpr, ctx, mode) => {
  const c = `typeof ${v} === "boolean"`;
  if (mode === "errors")
    return { stmts: [`if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} }`], outExpr: v };
  const out = ctx.fresh("b");
  const stmts = [
    `let ${out};`,
    `if (${c}) { ${out} = ${v}; }`,
    `else if (${v} === "true") { ${out} = true; }`,
    `else if (${v} === "false") { ${out} = false; }`,
    // A string that isn't "true"/"false" is a coercion failure; any other
    // wrong type (number, array, object, null) is a type error — same kind
    // errors() would report, so the two modes agree.
    `else if (typeof ${v} === "string") { errs.push({ kind: "coerce", path: ${pathExpr}, expected: "boolean", actual: ${v} }); ${out} = ${v}; }`,
    `else { ${typeErrorStmt(pathExpr, ref, v, ctx)} ${out} = ${v}; }`,
  ];
  return { stmts, outExpr: out };
};

const stringLeaf: ValidateHandler = (ref, v, pathExpr, ctx) => {
  const c = `typeof ${v} === "string"`;
  const stmts = [
    `if (!(${c})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} }`,
    ...metaConstraintStmts(ref, v, pathExpr, ctx, c),
  ];
  return { stmts, outExpr: v };
};

const literalLeaf: ValidateHandler = (ref, v, pathExpr) => {
  const s = ref.shape as TypeShape & { kind: "literal" };
  const stmts = [
    `if (${v} !== ${JSON.stringify(s.value)}) { errs.push({ kind: "literal", path: ${pathExpr}, expected: ${JSON.stringify(s.value)}, actual: ${v} }); }`,
  ];
  return { stmts, outExpr: v };
};

function enumLeaf(): ValidateHandler {
  return (ref, v, pathExpr, ctx) => {
    const s = ref.shape as TypeShape & { kind: "enum" };
    const members = ctx.addConst("members", JSON.stringify(s.members));
    const stmts = [
      `if (!${members}.includes(${v})) { errs.push({ kind: "enum", path: ${pathExpr}, expected: ${members}, actual: ${v} }); }`,
    ];
    return { stmts, outExpr: v };
  };
}

function objectValidate(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "object" };
  const baseCond = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`;
  const out = mode === "parse" ? ctx.fresh("o") : undefined;
  const stmts: string[] = [];
  if (out !== undefined) stmts.push(`let ${out}: Record<string, any> = {};`);
  stmts.push(`if (!(${baseCond})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} } else {`);
  const body: string[] = [];
  for (const [name, field] of Object.entries(s.fields)) {
    const fv = `${v}[${JSON.stringify(name)}]`;
    const fpath = `${pathExpr}.concat([${JSON.stringify(name)}])`;
    const inner = genValidate(field, fv, fpath, ctx, mode);
    const assign = out === undefined ? [] : [`${out}[${JSON.stringify(name)}] = ${inner.outExpr};`];
    if (field.meta.optional === true) {
      body.push(
        `if (${fv} !== undefined) {`,
        ...indentLines(inner.stmts, 2),
        ...indentLines(assign, 2),
        `}`,
      );
    } else {
      body.push(
        `if (${fv} === undefined) { errs.push({ kind: "missing", path: ${fpath} }); }`,
        `else {`,
        ...indentLines(inner.stmts, 2),
        ...indentLines(assign, 2),
        `}`,
      );
    }
  }
  if (ref.meta.additionalProperties === false) {
    const known = ctx.addConst("known", `new Set(${JSON.stringify(Object.keys(s.fields))})`);
    body.push(
      `for (const __k of Object.keys(${v})) { if (!${known}.has(__k)) { errs.push({ kind: "unexpected", path: ${pathExpr}.concat([__k]) }); } }`,
    );
  }
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out ?? v };
}

function arrayValidate(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "array" };
  const out = mode === "parse" ? ctx.fresh("a") : undefined;
  const stmts: string[] = [];
  if (out !== undefined) stmts.push(`let ${out}: any[] = [];`);
  stmts.push(`if (!Array.isArray(${v})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} } else {`);
  const idx = ctx.fresh("i");
  const ev = ctx.fresh("e");
  const epath = ctx.fresh("p");
  const inner = genValidate(s.element, ev, epath, ctx, mode);
  const body = [
    `for (let ${idx} = 0; ${idx} < ${v}.length; ${idx}++) {`,
    `  const ${ev} = ${v}[${idx}];`,
    `  const ${epath} = ${pathExpr}.concat([String(${idx})]);`,
    ...indentLines(inner.stmts, 2),
    out === undefined ? "" : `  ${out}.push(${inner.outExpr});`,
    `}`,
    ...metaConstraintStmts(ref, v, pathExpr, ctx, "true"),
  ].filter((l) => l !== "");
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out ?? v };
}

function tupleValidate(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "tuple" };
  const out = mode === "parse" ? ctx.fresh("t") : undefined;
  const stmts: string[] = [];
  if (out !== undefined) stmts.push(`let ${out}: any[] = [];`);
  stmts.push(`if (!Array.isArray(${v})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} } else {`);
  const body: string[] = [
    `if (${v}.length !== ${s.elements.length}) { errs.push({ kind: "tuple_length", path: ${pathExpr}, expected: ${s.elements.length}, actual: ${v}.length }); }`,
  ];
  s.elements.forEach((element, i) => {
    const ev = `${v}[${i}]`;
    const epath = `${pathExpr}.concat([${JSON.stringify(String(i))}])`;
    const inner = genValidate(element, ev, epath, ctx, mode);
    body.push(`if (${v}.length > ${i}) {`, ...indentLines(inner.stmts, 2));
    if (out !== undefined) body.push(`  ${out}.push(${inner.outExpr});`);
    body.push(`}`);
  });
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out ?? v };
}

function mapValidate(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "map" };
  const baseCond = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`;
  const out = mode === "parse" ? ctx.fresh("m") : undefined;
  const stmts: string[] = [];
  if (out !== undefined) stmts.push(`let ${out}: Record<string, any> = {};`);
  stmts.push(`if (!(${baseCond})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} } else {`);
  const key = ctx.fresh("k");
  const ev = ctx.fresh("e");
  const epath = ctx.fresh("p");
  // The key is always validated in "errors" mode regardless of `mode` — keys
  // come from `Object.keys` as strings, so there's nothing to coerce; a
  // constrained key type (uuid/enum/pattern) still needs its errors
  // collected, but the key itself is never replaced in the parsed output.
  const keyCheck = genValidate(s.key, key, epath, ctx, "errors");
  const inner = genValidate(s.value, ev, epath, ctx, mode);
  const body = [
    `for (const ${key} of Object.keys(${v})) {`,
    `  const ${ev} = ${v}[${key}];`,
    `  const ${epath} = ${pathExpr}.concat([${key}]);`,
    ...indentLines(keyCheck.stmts, 2),
    ...indentLines(inner.stmts, 2),
    out === undefined ? "" : `  ${out}[${key}] = ${inner.outExpr};`,
    `}`,
  ].filter((l) => l !== "");
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out ?? v };
}

/** Union: tries each variant's parse in sequence against a scratch `errs`
 * array (reusing the outer `errs` binding name via block scoping — nested
 * codegen references `errs.push` unmodified); the first variant with zero
 * new errors wins. If none succeed, all variants' collected errors are
 * reported together under a single `union` error. */
function unionValidate(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "union" };
  const out = mode === "parse" ? ctx.fresh("u") : undefined;
  const matched = ctx.fresh("matched");
  const scratchNames: string[] = [];
  const stmts: string[] = [];
  if (out !== undefined) stmts.push(`let ${out} = ${v};`);
  stmts.push(`let ${matched} = false;`);
  for (const _variant of s.variants) {
    const scratch = ctx.fresh("ue");
    scratchNames.push(scratch);
    stmts.push(`const ${scratch}: ValidationError[] = [];`);
  }
  s.variants.forEach((variant, i) => {
    const scratch = scratchNames[i]!;
    const inner = genValidate(variant, v, pathExpr, ctx, mode);
    stmts.push(`if (!${matched}) {`);
    stmts.push(`  { const errs = ${scratch};`);
    stmts.push(...indentLines(inner.stmts, 4));
    stmts.push(
      `    if (${scratch}.length === 0) { ${matched} = true;${out === undefined ? "" : ` ${out} = ${inner.outExpr};`} }`,
    );
    stmts.push(`  }`);
    stmts.push(`}`);
  });
  stmts.push(
    `if (!${matched}) { errs.push({ kind: "union", path: ${pathExpr}, errors: [${scratchNames.join(", ")}] }); }`,
  );
  return { stmts, outExpr: out ?? v };
}

/** Intersection: every member validates against the same value (not
 * alternate representations, unlike union), so their errors just accumulate
 * into the shared `errs` array at the same path. Fresh-object construction
 * merges object-shaped members' outputs via `Object.assign`, in order; a
 * non-object member's parsed value is only used if no object member exists
 * (intersections of non-object types are a degenerate case). */
function intersectionValidate(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "intersection" };
  if (s.members.length === 0) return { stmts: [], outExpr: v };
  const out = mode === "parse" ? ctx.fresh("x") : undefined;
  const stmts: string[] = [];
  if (out !== undefined) stmts.push(`let ${out} = ${v};`);
  const hasObjectMember = s.members.some((m) => m.shape.kind === "object");
  if (out !== undefined && hasObjectMember) stmts.push(`${out} = {};`);
  for (const member of s.members) {
    const inner = genValidate(member, v, pathExpr, ctx, mode);
    stmts.push(...inner.stmts);
    if (out !== undefined) {
      if (hasObjectMember && member.shape.kind === "object") {
        stmts.push(`Object.assign(${out}, ${inner.outExpr});`);
      } else if (!hasObjectMember) {
        stmts.push(`${out} = ${inner.outExpr};`);
      }
    }
  }
  return { stmts, outExpr: out ?? v };
}

function interfaceValidate(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "interface" };
  const baseCond = `typeof ${v} === "object" && ${v} !== null`;
  const stmts = [`if (!(${baseCond})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} } else {`];
  const body: string[] = [];
  for (const name of Object.keys(s.methods)) {
    const fv = `${v}[${JSON.stringify(name)}]`;
    const fpath = `${pathExpr}.concat([${JSON.stringify(name)}])`;
    body.push(
      `if (typeof ${fv} === "undefined") { errs.push({ kind: "missing", path: ${fpath} }); }`,
      `else if (typeof ${fv} !== "function") { ${typeErrorStmt(fpath, ref, fv, ctx)} }`,
    );
  }
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: v };
}

const validateHandlers: Record<string, ValidateHandler> = {
  boolean: booleanLeaf,
  number: numberFamilyLeaf(),
  integer: numberFamilyLeaf((v) => `Number.isInteger(${v})`),
  int32: numberFamilyLeaf(
    (v) => `Number.isInteger(${v}) && ${v} >= -2147483648 && ${v} <= 2147483647`,
  ),
  int64: numberFamilyLeaf(
    (v) =>
      `Number.isInteger(${v}) && ${v} >= Number.MIN_SAFE_INTEGER && ${v} <= Number.MAX_SAFE_INTEGER`,
  ),
  float32: numberFamilyLeaf(),
  float64: numberFamilyLeaf(),
  string: stringLeaf,
  uuid: formatLeaf("uuid"),
  uri: formatLeaf("uri"),
  email: formatLeaf("email"),
  date: dateLeaf(),
  time: formatLeaf("time"),
  datetime: dateLeaf(),
  duration: formatLeaf("duration"),
  bytes: formatLeaf("bytes"),
  null: nonCoercingLeaf((v) => `${v} === null`),
  void: nonCoercingLeaf((v) => `${v} === undefined`),
  // `unknown`/`instance` have no structure to validate or reconstruct from
  // (see the doc comments on their `checkHandlers` counterparts above, and
  // index.ts's own `instance` docs) — parse() returns the same reference it
  // was given rather than a fresh copy. This is the one carve-out to parse()'s
  // "fresh output, never mutates the input" contract (see this file's header
  // comment): there's nothing to copy from, so aliasing is the only option.
  unknown: (_ref, v) => ({ stmts: [], outExpr: v }),
  never: (ref, v, pathExpr, ctx) => ({ stmts: [typeErrorStmt(pathExpr, ref, v, ctx)], outExpr: v }),
  instance: (_ref, v) => ({ stmts: [], outExpr: v }),
  // `ref` delegates to the target def's generated `errors`/`parse` function
  // (see the `checkHandlers.ref` doc comment above) when the target is in
  // scope (`ctx.defNames`); with no matching def (bare `TypeRef`, no `defs`
  // passed in) there's nothing to call, so — like `unknown`/`instance` above —
  // it's a structural no-op that aliases the input.
  ref: (ref, v, pathExpr, ctx, mode) => {
    const s = ref.shape as TypeShape & { kind: "ref" };
    if (!ctx.defNames.has(s.target)) return { stmts: [], outExpr: v };
    if (mode === "errors") {
      return {
        stmts: [`errs.push(...${defFnName(s.target, "errors")}(${v}, ${pathExpr}));`],
        outExpr: v,
      };
    }
    const out = ctx.fresh("d");
    return {
      stmts: [
        `const ${out} = ${defFnName(s.target, "parse")}(${v}, ${pathExpr}); errs.push(...${out}.errors);`,
      ],
      outExpr: `${out}.value`,
    };
  },
  function: nonCoercingLeaf((v) => `typeof ${v} === "function"`),
  literal: literalLeaf,
  enum: enumLeaf(),
  object: objectValidate,
  array: arrayValidate,
  // Same carve-out as `unknown`/`instance`/`ref` above: nothing to coerce or
  // rebuild from without consuming the iterator, so parse() aliases the
  // input. See `isAsyncIterableExpr`'s doc comment above.
  stream: nonCoercingLeaf((v) => isAsyncIterableExpr(v)),
  // See `pageAsObjectRef`'s doc comment above — delegates to `object`.
  page: (ref, v, pathExpr, ctx, mode) => genValidate(pageAsObjectRef(ref), v, pathExpr, ctx, mode),
  tuple: tupleValidate,
  map: mapValidate,
  union: unionValidate,
  intersection: intersectionValidate,
  interface: interfaceValidate,
};

function genValidateShape(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
): ValidateResult {
  const handler = resolve(ref.shape.kind, validateHandlers);
  if (handler === undefined) return { stmts: [], outExpr: v };
  return handler(ref, v, pathExpr, ctx, mode);
}

function genValidate(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  mode: Mode,
): ValidateResult {
  if (ref.meta.nullable === true) {
    const out = mode === "parse" ? ctx.fresh("n") : undefined;
    const inner = genValidateShape(ref, v, pathExpr, ctx, mode);
    const stmts = [
      out === undefined ? "" : `let ${out};`,
      `if (${v} === null) {`,
      out === undefined ? "" : `  ${out} = null;`,
      `} else {`,
      ...indentLines(inner.stmts, 2),
      out === undefined ? "" : `  ${out} = ${inner.outExpr};`,
      `}`,
    ].filter((l) => l !== "");
    return { stmts, outExpr: out ?? v };
  }
  return genValidateShape(ref, v, pathExpr, ctx, mode);
}

// ============================================================================
// Runtime helper embedded once per compiled entry — infers a best-effort
// TypeRef "shape" for an arbitrary runtime value, used as the `actual` field
// of a `type` ValidationError (paired with `expected`, the TypeRef that was
// checked against — see typeRefToString for turning either into display text).
// ============================================================================

// `: any` return type: like `refLiteral`'s `as any` above, the inferred
// per-branch object-literal type doesn't satisfy `ValidationError`'s
// `actual: TypeRef` field without reproducing the full recursive `TypeRef`
// type inline — `any` sidesteps that.
/** Exported so a caller assembling its own module out of individually-
 * compiled `CompiledWireEntryFragment`s (`apply-validation-build.ts`'s
 * per-protocol wire build path, whose entries don't share one uniform
 * profile set the way `assembleWireModule`'s own per-entry-per-profile loop
 * assumes) can emit the shared `__inferTypeRef` helper every fragment's
 * `type`-kind error path references, without re-deriving its source. */
export const INFER_TYPE_REF_SOURCE = `function __inferTypeRef(v: any): any {
  if (v === null) return { shape: { kind: "null" }, meta: {} };
  if (v === undefined) return { shape: { kind: "void" }, meta: {} };
  if (Array.isArray(v)) return { shape: { kind: "array", element: { shape: { kind: "unknown" }, meta: {} } }, meta: {} };
  if (typeof v === "object") return { shape: { kind: "object", fields: {} }, meta: {} };
  if (typeof v === "function") return { shape: { kind: "function", params: [], returnType: { shape: { kind: "unknown" }, meta: {} } }, meta: {} };
  return { shape: { kind: typeof v }, meta: {} };
}`;

// ============================================================================
// Top-level assembly: one TypeRef -> { check, errors, parse } source.
// ============================================================================

/**
 * The type-guard annotation for a validator's input, plus the `import type`
 * this annotation needs, if any. Two cases:
 *   - The TypeRef carries `meta.typeName` + `meta.declarationFile` (see
 *     index.ts's meta-bag doc) and the caller passed `resolveImport`: the
 *     annotation is the bare type name, imported.
 *   - Otherwise: the annotation is the type's own structural TypeScript
 *     rendering (`toTypeScript`), inlined directly. `defNames` (the shared/
 *     recursive `defs` entries in scope for this compile — see `compileDefs`'
 *     doc comment above) is threaded through so a nested `ref` inside this
 *     structural rendering — not just the entry's own top-level type —
 *     also resolves to its locally-declared `__def_NAME` alias instead of an
 *     unimportable bare name.
 */
function guardAnnotation(
  ref: TypeRef,
  resolveImport: ((declarationFile: string) => string) | undefined,
  defNames: ReadonlySet<string> = new Set(),
): { annotation: string; typeImport?: { typeName: string; from: string } } {
  const typeName = typeof ref.meta.typeName === "string" ? ref.meta.typeName : undefined;
  const declarationFile =
    typeof ref.meta.declarationFile === "string" ? ref.meta.declarationFile : undefined;
  if (typeName !== undefined && declarationFile !== undefined && resolveImport !== undefined) {
    return { annotation: typeName, typeImport: { typeName, from: resolveImport(declarationFile) } };
  }
  return { annotation: toTypeScript(ref, defNames) };
}

/**
 * Emits one `function __def_NAME_check/errors/parse(...)` declaration triple
 * per entry in `defs`, all sharing `ctx` (so a const/regex reused across
 * multiple defs — or between a def and the entry that refs it — is hoisted
 * once). Populates `ctx.defNames` before generating any body, so a def whose
 * body `ref`s another def — including itself — resolves to a call, not a
 * no-op passthrough: recursion is ordinary JS function recursion, not
 * anything special-cased here. Declared as `function` statements (hoisted),
 * so declaration order among mutually-referential defs never matters.
 *
 * Also emits one `type __def_NAME = <structural TS>;` alias per entry (via
 * `toTypeScript(ref, ctx.defNames)` — see typescript-native.ts's `ref`
 * handler and `defTypeAliasName`), so a caller building a real static
 * annotation for a value that contains a `ref` to a shared/recursive def
 * (`guardAnnotation` below, via `toTypeScript(ref, defNames)`) has a real,
 * locally-declared type to name instead of an unimportable bare string. A
 * `type` alias is a local, block-scoped declaration in TS (unlike a runtime
 * `const`), so emitting it inside an IIFE body (the standalone
 * `compileValidator` case) is exactly as valid as at module scope
 * (`compileDefsBlock`'s output, spliced into `assembleWireModule`) — both
 * callers just splice these lines in alongside the function declarations
 * below. Emitted with `ctx.defNames`
 * (populated before this loop) so a def that refs itself or another def in
 * the same batch renders its own alias name, not a bare unimported string —
 * the same recursion guarantee the runtime functions below already have.
 */
function compileDefs(defs: Record<string, TypeRef>, ctx: GenCtx): string[] {
  for (const name of Object.keys(defs)) ctx.defNames.add(name);
  const lines: string[] = [];
  for (const [name, ref] of Object.entries(defs)) {
    lines.push(`type ${defTypeAliasName(name)} = ${toTypeScript(ref, ctx.defNames)};`);
  }
  for (const [name, ref] of Object.entries(defs)) {
    const checkExpr = genCheckExpr(ref, "value", ctx);
    const errorsBody = genValidate(ref, "value", "path", ctx, "errors");
    const parseBody = genValidate(ref, "value", "path", ctx, "parse");
    lines.push(`function ${defFnName(name, "check")}(value: any): boolean {`);
    lines.push(`  return (${checkExpr});`);
    lines.push(`}`);
    lines.push(
      `function ${defFnName(name, "errors")}(value: any, path: string[]): ValidationError[] {`,
    );
    lines.push(`  const errs: ValidationError[] = [];`);
    lines.push(...indentLines(errorsBody.stmts, 2));
    lines.push(`  return errs;`);
    lines.push(`}`);
    lines.push(
      `function ${defFnName(name, "parse")}(value: any, path: string[]): { errors: ValidationError[]; value: any } {`,
    );
    lines.push(`  const errs: ValidationError[] = [];`);
    lines.push(...indentLines(parseBody.stmts, 2));
    lines.push(`  return { errors: errs, value: ${parseBody.outExpr} };`);
    lines.push(`}`);
  }
  return lines;
}

/** Emits the `{ check, errors, parse }` triple's body lines (no wrapping
 * IIFE/braces — the caller supplies those) for a single TypeRef. `withHelper`
 * controls whether the `__inferTypeRef` runtime helper and the
 * `ValidationError` type (used by `type`-kind ValidationErrors) are declared
 * inline, versus assumed to already be in scope at module level — the only
 * current caller (`compileValidator`) always passes `true`.
 *
 * The narrowing `value is T` / discriminated-`parse`-return cast is applied
 * inside this function body's `return` statement, not by the caller wrapping
 * the IIFE call from outside — when `withHelper` is true, `ValidationError`
 * is a type local to this function body, out of scope for a cast written
 * after the IIFE closes; casting from inside keeps it in scope in both
 * `withHelper` cases. */
function compileEntryBody(
  ref: TypeRef,
  annotation: string,
  withHelper: boolean,
  defs?: Record<string, TypeRef>,
  // Seeds `ctx.defNames` for a module-scope caller whose def functions are
  // declared once, shared across all entries, outside any single entry's
  // IIFE — each entry's own `ctx.defNames` still needs the names seeded so
  // its `ref` handlers know to emit a call rather than a no-op. Mutually
  // exclusive with `defs` in practice, since a caller passing both would
  // double-declare. Not currently exercised — `compileEntryBody`'s only
  // caller (`compileValidator`) always passes `defs` instead.
  externalDefNames?: ReadonlySet<string>,
): string[] {
  const ctx = new GenCtx();
  // `defs`' function declarations are generated first (populating
  // `ctx.defNames` before the entry body itself is walked), so a `ref` at
  // the entry's own top level — not just inside a def — also resolves to a
  // call rather than a no-op passthrough.
  const defLines = defs !== undefined ? compileDefs(defs, ctx) : [];
  if (externalDefNames !== undefined) for (const name of externalDefNames) ctx.defNames.add(name);
  const checkExpr = genCheckExpr(ref, "value", ctx);
  const errorsBody = genValidate(ref, "value", "path", ctx, "errors");
  const parseBody = genValidate(ref, "value", "path", ctx, "parse");

  const lines: string[] = [];
  // `withHelper` is true for `compileValidator`'s single-expression,
  // truly-standalone output — there's no module scope to hoist a shared
  // `ValidationError` type/`__inferTypeRef` helper to, so both are declared
  // locally inside the IIFE (erased at runtime, no cost). This is the only
  // case `compileEntryBody` currently compiles; a module-scope caller
  // sharing one copy across entries would pass `false` here instead.
  if (withHelper) {
    // A local `type` declaration inside the IIFE body; module-level `export
    // type` syntax is invalid inside a function body.
    lines.push(VALIDATION_ERROR_TYPE_SOURCE.replace(/^export /, ""));
    lines.push(INFER_TYPE_REF_SOURCE);
  }
  lines.push(...ctx.declarations());
  lines.push(...defLines);
  // `value: any` (not `unknown`) throughout the raw compiled body — bracket
  // access (`value["field"]`) only type-checks against `any`; the annotated,
  // narrower signature (`value is T`, the discriminated `parse` return type)
  // is applied at the call site via the `as {...}` cast below, the same
  // approach the retired TypeBox-compiler wrapper this replaces used.
  // `void value;`/`void path;` — a trivial (e.g. `unknown`) shape's checkExpr/
  // genValidate body never references its own `value`/`path` parameter, which
  // would otherwise trip `noUnusedParameters`/`noUnusedLocals` on the emitted
  // module. Unconditional no-op reads keep every entry compiling regardless
  // of whether the shape-specific body ends up using them.
  lines.push(`function check(value: any) {`);
  lines.push(`  void value;`);
  lines.push(`  return (${checkExpr});`);
  lines.push(`}`);
  lines.push(`function errors(value: any): ValidationError[] {`);
  lines.push(`  void value;`);
  lines.push(`  const path: string[] = [];`);
  lines.push(`  void path;`);
  lines.push(`  const errs: ValidationError[] = [];`);
  lines.push(...indentLines(errorsBody.stmts, 2));
  lines.push(`  return errs;`);
  lines.push(`}`);
  lines.push(`function parse(value: any) {`);
  lines.push(`  const path: string[] = [];`);
  lines.push(`  void path;`);
  lines.push(`  const errs: ValidationError[] = [];`);
  lines.push(...indentLines(parseBody.stmts, 2));
  lines.push(
    `  if (errs.length === 0) return { kind: "ok" as const, value: ${parseBody.outExpr} };`,
  );
  lines.push(`  return { kind: "err" as const, errors: errs };`);
  lines.push(`}`);
  lines.push(`return { check: check, errors: errors, parse: parse } as unknown as {`);
  lines.push(`  check: (value: unknown) => value is ${annotation};`);
  lines.push(`  errors: (value: unknown) => ValidationError[];`);
  lines.push(
    `  parse: (value: unknown) => { kind: "ok"; value: ${annotation} } | { kind: "err"; errors: ValidationError[] };`,
  );
  lines.push(`};`);
  return lines;
}

/**
 * Compiles a single TypeRef to a standalone JS expression evaluating to `{
 * check, errors, parse }` — zero runtime dependency, `check`/`parse` narrow
 * via TypeScript (a type-guard cast on `check`, a discriminated-union return
 * type on `parse`).
 *
 * `defs` is optional and holds a `TypeRefDocument`'s named definitions (see
 * index.ts) — a `ref` inside `ref` (or inside a def's own body) whose target
 * has an entry here compiles to a real recursive check. Every def's
 * `check`/`errors`/`parse` triple is generated as a standalone function
 * inside this same IIFE — there's no module scope to hoist to, since this
 * expression is meant to stand entirely on its own.
 */
export function compileValidator(ref: TypeRef, defs?: Record<string, TypeRef>): string {
  const defNames = new Set(Object.keys(defs ?? {}));
  const { annotation } = guardAnnotation(ref, undefined, defNames);
  const body = compileEntryBody(ref, annotation, true, defs);
  return ["(function () {", ...indentLines(body, 2), "})()"].join("\n");
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
  | { kind: "coerce"; path: string[]; expected: string; actual: unknown }
  | { kind: "encoding"; path: string[]; expected: string; actual: unknown }
  | { kind: "decode"; path: string[]; message: string };`;

/** The module-scope `defs` block (shared `__def_NAME_check/errors/parse`
 * function declarations plus their own hoisted consts) — declared once per
 * module, independent of any single leaf, and reused by every leaf whose
 * `ref` targets one of `defNames`. Gated by the caller on its own rollup
 * (e.g. a hash of `defs`' content — see cache.ts's `defNamesFingerprint`/
 * per-entry defs handling), since unlike a leaf's fragment, this block's
 * generated names (`defCtx`'s sequential counters) depend on the full `defs`
 * record's content and iteration order, not any one def in isolation. */
export type CompiledDefsBlock = {
  readonly lines: readonly string[];
  readonly defNames: ReadonlySet<string>;
};

/** Compile a `defs` record (structural-sharing's shared/recursive named
 * types — see `finalizeSharedDefs`, from-typescript.ts) to its module-scope
 * declaration block, shared once at module scope by every leaf/entry that
 * refs one of `defNames` — used by api-tree's wire-profile build path
 * (`apply-validation-build.ts`'s `buildWireApplyValidationModuleSource*`,
 * which compiles this once per build and passes the resulting `defNames`
 * into `compileConstraintsFn` for every entry) so an incremental caller can
 * compile it once per Tier-2 run independent of per-leaf
 * fragment compilation. */
export function compileDefsBlock(defs: Record<string, TypeRef>): CompiledDefsBlock {
  const defNames = new Set(Object.keys(defs));
  if (defNames.size === 0) return { lines: [], defNames };
  const defCtx = new GenCtx();
  const defLines = compileDefs(defs, defCtx);
  return { lines: [...defCtx.declarations(), ...defLines], defNames };
}

// ============================================================================
// Wire profiles + staged validation
//
//   Wire --validateEncoding--> ValidWire --decode (total)--> T
//     --defaults-fill--> T --validateConstraints--> valid T
//
// See docs/design/wire-profiles-and-staged-validation.md for the full design
// this section implements. `check`/`errors`/`parse` above are unchanged by
// everything below — they remain exactly the strict, non-coercing path they
// always were. This section adds a second, profile-parameterized entry point
// (`compileWireEntryFragment`/`compileWireModule`) alongside the existing
// profile-blind `compileValidator` — it does not alter that path's behavior
// or output. api-tree's `apply-validation-build.ts` and `apply-validation.ts`
// are wired onto this wire-profile path; the legacy 2-arg codegen route this
// section originally sat alongside (`compileValidatorModule`, and the cli/mcp
// `isApplyValidationWrapped` sniff it gated) was retired in phases C and D —
// see the design doc's phase C/D implementation-trace sections.
//
// Scope cuts made in this phase (none contradict the design doc's settled
// decisions; the phase's own test list doesn't exercise them):
//   - [closed, phase D] `defs`/`ref` recursion support for wire profiles: a
//     `ref` inside a wire-profile-compiled tree compiles to a real call —
//     `compileConstraintsFn`'s `externalDefNames` param (constraints layer,
//     reusing `compileDefs`/`ctx.defNames` unchanged) plus the
//     `WireDefsRegistry` (decode layer, one `__wiredecode_NAME_PROFILE`
//     function per (defName, profile) pair actually referenced — see that
//     class's doc comment). A `ref` with no `defs`/registry passed in still
//     falls through as the pre-phase-D structural no-op — the carve-out
//     itself isn't gone, just no longer the only option.
//   - `defaults-fill` recurses into `object` fields and `array` elements only
//     — matching `meta.default`'s only current authoring site
//     (`json-schema.ts`'s `withMeta`, always on a field, never on a
//     tuple/map/union/intersection member).
// ============================================================================

/** One profile's per-kind leaf override. Structural recursion (object/array/
 * tuple/map/union/intersection, below) is identical for every profile —
 * wire profiles only ever change leaf encoding and decode. A kind with no
 * entry (every profile-independent kind: `string`, `enum`, `literal`,
 * `uuid`/`uri`/`email`/…, `null`, `void`, `unknown`, `never`, `instance`,
 * `function`, `interface`, `ref`) falls back to `defaultWireLeaf` — "the wire
 * value must already be a valid `T`, no coercion" — which is exactly
 * `identityProfile`'s definition for every kind (an empty `leafHandlers`
 * map) and every other profile's definition for whichever kinds it doesn't
 * override either. */
export type WireLeafHandler = {
  /** Fused `validateEncoding` + `decode` for this leaf kind (fusing the two
   * stages into one traversal is the permitted emission optimization the
   * design doc calls out — the model still has both, as the two things this
   * one pass does: push `errs` on a wire-shape mismatch, or produce a valid
   * `T`-shaped `outExpr`, never both for the same input). */
  readonly decode: (ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx) => ValidateResult;
  /** The `ValidWire` type text for this leaf kind under this profile — e.g.
   * `"string"` for a `number` field under `argvProfile`. */
  readonly wireType: (ref: TypeRef) => string;
};

export type WireProfile = {
  readonly name: string;
  readonly leafHandlers: Readonly<Record<string, WireLeafHandler>>;
};

function encodingErrorStmt(pathExpr: string, expectedText: string, v: string): string {
  return `errs.push({ kind: "encoding", path: ${pathExpr}, expected: ${JSON.stringify(expectedText)}, actual: ${v} });`;
}

/** Fallback leaf handling for every kind a profile doesn't override: the
 * wire value must already satisfy the kind's own `checkHandlers` condition —
 * no coercion. Reusing `checkHandlers` directly means this automatically
 * agrees with `check`/`errors` for every kind, present and future (a new
 * extension kind registered via `registerParent` + a `checkHandlers` entry
 * gets a correct default wire leaf for free, the same open-registry story
 * this file's header comment already promises for `check`/`errors`/`parse`).
 * This is `identityProfile`'s entire behavior, and any other profile's
 * behavior for whichever kinds it doesn't list. */
function defaultWireLeaf(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx): ValidateResult {
  const handler = resolve(ref.shape.kind, checkHandlers);
  const cond = handler === undefined ? "true" : handler(ref, v, ctx);
  return { stmts: [`if (!(${cond})) { ${typeErrorStmt(pathExpr, ref, v, ctx)} }`], outExpr: v };
}

function defaultWireType(ref: TypeRef): string {
  return toTypeScript({ shape: ref.shape, meta: {} });
}

/** number/integer/int32/int64/float32/float64 (argv, query): the wire value
 * is a numeric string. `resolve`s the same per-kind `checkHandlers` entry
 * (e.g. int32's own range+integer-ness check) against the coerced number, so
 * an out-of-range/non-integer numeric string is an encoding failure, not a
 * `validateConstraints` one — the same "this is the right shape" framing
 * `defaultWireLeaf` uses for every other kind, just reached via a coercion
 * step first. */
function numericStringLeaf(ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx): ValidateResult {
  const out = ctx.fresh("n");
  const ok = ctx.fresh("ok");
  const kindCheck = resolve(ref.shape.kind, checkHandlers);
  const wireDesc = `numeric string (${ref.shape.kind})`;
  const rangeCheck = kindCheck === undefined ? "" : ` || !(${kindCheck(ref, out, ctx)})`;
  const stmts = [
    `let ${out} = ${v};`,
    `let ${ok} = false;`,
    `if (typeof ${v} === "string" && ${v}.trim() !== "" && !Number.isNaN(Number(${v}))) { ${out} = Number(${v}); ${ok} = true; }`,
    `if (!${ok}${rangeCheck}) { ${encodingErrorStmt(pathExpr, wireDesc, v)} }`,
  ];
  return { stmts, outExpr: out };
}

/** boolean (query): strict `"true"`/`"false"` string only — no native
 * boolean passthrough, matching query-string's always-a-string wire shape. */
function strictBoolFromStringLeaf(
  _ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
): ValidateResult {
  const out = ctx.fresh("b");
  const stmts = [
    `let ${out};`,
    `if (${v} === "true") { ${out} = true; }`,
    `else if (${v} === "false") { ${out} = false; }`,
    `else { ${encodingErrorStmt(pathExpr, `"true" or "false"`, v)} ${out} = ${v}; }`,
  ];
  return { stmts, outExpr: out };
}

/** boolean (argv): native `true` (argv's bare-flag-presence sentinel,
 * `parseFlags`) or `false`, OR the strict `"true"`/`"false"` string (an
 * explicit `--flag=true`/`--flag=false`) — never a loose set
 * (`"1"`/`"yes"`/…): see the design doc's "(c) Default argv boolean
 * encoding" decision (strict, chosen explicitly over loose). */
function argvBoolLeaf(_ref: TypeRef, v: string, pathExpr: string, ctx: GenCtx): ValidateResult {
  const out = ctx.fresh("b");
  const stmts = [
    `let ${out};`,
    `if (typeof ${v} === "boolean") { ${out} = ${v}; }`,
    `else if (${v} === "true") { ${out} = true; }`,
    `else if (${v} === "false") { ${out} = false; }`,
    `else { ${encodingErrorStmt(pathExpr, `boolean, "true", or "false"`, v)} ${out} = ${v}; }`,
  ];
  return { stmts, outExpr: out };
}

/** date/datetime (argv, query, json): an ISO-ish string decoded via `new
 * Date(v)` — the one coercion `jsonProfile` needs too, since "JSON has no
 * date literal" (design doc). Shared by all three non-identity profiles;
 * `identityProfile`'s fallback (`defaultWireLeaf`) requires an already-`Date`
 * wire value instead, with no coercion at all. */
function isoDateStringLeaf(
  _ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
): ValidateResult {
  const out = ctx.fresh("d");
  const tmp = ctx.fresh("dt");
  const stmts = [
    `let ${out};`,
    `if (typeof ${v} === "string") { const ${tmp} = new Date(${v}); if (!Number.isNaN(${tmp}.getTime())) { ${out} = ${tmp}; } else { ${encodingErrorStmt(pathExpr, "ISO date string", v)} ${out} = ${v}; } }`,
    `else { ${encodingErrorStmt(pathExpr, "ISO date string", v)} ${out} = ${v}; }`,
  ];
  return { stmts, outExpr: out };
}

/** Trivial encoding check + identity decode, for every kind — no coercion at
 * all. This is strict validation: the mcp/graphql in-process/already-typed-
 * value posture `check`/`errors`/`parse` above have always assumed. An empty
 * `leafHandlers` map means every kind falls through to `defaultWireLeaf`. */
export const identityProfile: WireProfile = { name: "identity", leafHandlers: {} };

/** Typed JSON in, except `Date` — JSON has no date literal, so a date/
 * datetime field arrives as an ISO string even on an otherwise-typed JSON
 * wire (MCP/GraphQL tool-call arguments, an HTTP JSON body). */
export const jsonProfile: WireProfile = {
  name: "json",
  leafHandlers: {
    date: { decode: isoDateStringLeaf, wireType: () => "string" },
    datetime: { decode: isoDateStringLeaf, wireType: () => "string" },
  },
};

/** HTTP query/path segments: every leaf arrives as a string (never a native
 * number/boolean/Date) — strict `"true"`/`"false"` booleans, numeric
 * strings, ISO date strings. `string` itself needs no override — the wire
 * value already IS a string, so `defaultWireLeaf`'s fallback is correct
 * as-is. */
export const queryProfile: WireProfile = {
  name: "query",
  leafHandlers: {
    number: { decode: numericStringLeaf, wireType: () => "string" },
    integer: { decode: numericStringLeaf, wireType: () => "string" },
    int32: { decode: numericStringLeaf, wireType: () => "string" },
    int64: { decode: numericStringLeaf, wireType: () => "string" },
    float32: { decode: numericStringLeaf, wireType: () => "string" },
    float64: { decode: numericStringLeaf, wireType: () => "string" },
    boolean: { decode: strictBoolFromStringLeaf, wireType: () => `"true" | "false"` },
    date: { decode: isoDateStringLeaf, wireType: () => "string" },
    datetime: { decode: isoDateStringLeaf, wireType: () => "string" },
  },
};

/** CLI argv: `string | string[] | true` per field (`parseFlags`) — identical
 * to `queryProfile` except booleans, which additionally accept argv's bare-
 * flag-presence `true` sentinel (see `argvBoolLeaf`). (`number`'s entry
 * doesn't strictly need repeating per width — `resolve()`'s ancestor climb
 * would find `"number"` for `int32`/`int64`/etc. too — but listing them
 * explicitly keeps this profile's OWN vocabulary self-evident without
 * relying on a reader already knowing `queryProfile`'s ancestor-climb
 * behavior.) */
export const argvProfile: WireProfile = {
  name: "argv",
  leafHandlers: {
    number: { decode: numericStringLeaf, wireType: () => "string" },
    integer: { decode: numericStringLeaf, wireType: () => "string" },
    int32: { decode: numericStringLeaf, wireType: () => "string" },
    int64: { decode: numericStringLeaf, wireType: () => "string" },
    float32: { decode: numericStringLeaf, wireType: () => "string" },
    float64: { decode: numericStringLeaf, wireType: () => "string" },
    boolean: { decode: argvBoolLeaf, wireType: () => `boolean | "true" | "false"` },
    date: { decode: isoDateStringLeaf, wireType: () => "string" },
    datetime: { decode: isoDateStringLeaf, wireType: () => "string" },
  },
};

const STRUCTURAL_WIRE_KINDS = new Set([
  "object",
  "array",
  "tuple",
  "map",
  "union",
  "intersection",
  "page",
]);

/**
 * Module-scope registry of wire-decode functions and `ValidWire` type
 * aliases for shared/recursive `defs`, keyed by the (defName, profileName)
 * pair — the decode-layer half of phase D's "close the wire-profile
 * defs/ref scope cut" work (see this section's header comment). A shared def
 * needs one compiled wire-decode function per (defName, profile) pair
 * actually referenced across a module, not one per defName (unlike the
 * constraints layer's `__def_NAME_errors`, which is profile-independent) —
 * this registry compiles each pair lazily, the first time
 * `genWireEncodeDecodeShape`'s `ref` case (or `wireTypeTextShape`'s)
 * encounters it, and memoizes by pair so the same def referenced from
 * multiple entries/fields under the same profile compiles once. The
 * function's own name is reserved in the memo before its body is generated,
 * so a self- (or mutually-) recursive def's own body resolves to a call to
 * that reserved name rather than re-entering compilation.
 *
 * One instance is shared across an entire module's compile (constructed by
 * the caller — `compileWireModule`, or api-tree's `apply-validation-build.ts`
 * — via `createWireDefsRegistry`, threaded into every
 * `compileWireEntryFragment`/`compileWireEntryFragmentComposite` call for
 * that module) so dedup spans every entry, not just one.
 */
export class WireDefsRegistry {
  private readonly defs: Readonly<Record<string, TypeRef>>;
  /** Names with a `defs` entry in scope for this compile — a `ref` whose
   * target isn't in this set has nothing to call (bare `TypeRef`, no `defs`
   * passed in) and falls through to the structural no-op, the same carve-out
   * as `checkHandlers.ref`/`validateHandlers.ref`. */
  readonly defNames: ReadonlySet<string>;
  private readonly decodeFnNames = new Map<string, string>();
  private readonly typeAliasNames = new Map<string, string>();
  private readonly lines: string[] = [];

  // `defs` is assigned explicitly in the constructor body rather than via a
  // parameter property (`private readonly defs: ...` in the constructor
  // signature): a parameter property's assignment runs after this class's
  // own field initializers (JS class-field-initializer-order semantics), so
  // `defNames`'s initializer above would observe `this.defs` as still
  // `undefined` if `defs` were declared that way. The explicit assignments
  // below run in the constructor body, after every field initializer, so
  // `this.defs` is set before `defNames` needs it.
  constructor(defs: Readonly<Record<string, TypeRef>>) {
    this.defs = defs;
    this.defNames = new Set(Object.keys(defs));
  }

  /** The wire-decode function name for `(defName, profile.name)`, compiling
   * `function __wiredecode_NAME_PROFILE(wire, path, errs) { ... }` (decode,
   * then defaults-fill for this def's OWN subtree — see this section's header
   * comment for why NOT constraints, which stay the constraints fn's job) on
   * first request. */
  decodeFnName(defName: string, profile: WireProfile): string {
    const key = `${defName}\0${profile.name}`;
    const existing = this.decodeFnNames.get(key);
    if (existing !== undefined) return existing;
    const fnName = `__wiredecode_${sanitizeDefName(defName)}_${sanitizeDefName(profile.name)}`;
    this.decodeFnNames.set(key, fnName);
    const ref = this.defs[defName];
    if (ref === undefined)
      throw new Error(`WireDefsRegistry: unknown def ${JSON.stringify(defName)}`);
    const ctx = new GenCtx(`${sanitizeDefName(defName)}_${sanitizeDefName(profile.name)}_`);
    const decodeBody = genWireEncodeDecode(ref, "wire", "path", ctx, profile, this);
    const fillStmts = genDefaultsFillChildren(ref, "__decoded");
    this.lines.push(
      ...ctx.declarations(),
      `function ${fnName}(wire: any, path: string[], errs: ValidationError[]): any {`,
      ...indentLines(decodeBody.stmts, 2),
      `  let __decoded: any = ${decodeBody.outExpr};`,
      ...indentLines(fillStmts, 2),
      `  return __decoded;`,
      `}`,
    );
    return fnName;
  }

  /** The local `ValidWire` type-alias name for `(defName, profile.name)`,
   * emitting `type __wiretype_NAME_PROFILE = <structural ValidWire text>;`
   * once. A local alias (not structural inlining, `wireTypeTextShape`'s
   * default for a `ref` with no def in scope) is required here because
   * inlining would infinite-loop for a self-recursive def — mirrors
   * `compileDefs`'s own `type __def_NAME = ...` alias, profile-qualified
   * since `ValidWire` (unlike `T`) varies per profile. */
  typeAliasName(defName: string, profile: WireProfile): string {
    const key = `${defName}\0${profile.name}`;
    const existing = this.typeAliasNames.get(key);
    if (existing !== undefined) return existing;
    const aliasName = `__wiretype_${sanitizeDefName(defName)}_${sanitizeDefName(profile.name)}`;
    this.typeAliasNames.set(key, aliasName);
    const ref = this.defs[defName];
    if (ref === undefined)
      throw new Error(`WireDefsRegistry: unknown def ${JSON.stringify(defName)}`);
    this.lines.push(`type ${aliasName} = ${wireTypeText(ref, profile, this)};`);
    return aliasName;
  }

  /** Every wire-decode function + type-alias declaration compiled so far —
   * spliced once at module scope by the caller (`assembleWireModule`/
   * `assembleWireApplyValidationModule`), alongside (not instead of) the
   * constraints layer's own `compileDefsBlock` output. */
  moduleLines(): readonly string[] {
    return this.lines;
  }
}

/** Construct a fresh `WireDefsRegistry` for one module's compile — the
 * factory a caller outside this file (api-tree's `apply-validation-build.ts`)
 * uses, since `WireDefsRegistry`'s constructor is otherwise this file's own
 * implementation detail. */
export function createWireDefsRegistry(defs: Readonly<Record<string, TypeRef>>): WireDefsRegistry {
  return new WireDefsRegistry(defs);
}

/** Structural recursion for the fused `validateEncoding` + `decode` stage.
 * Every structural kind (object/array/tuple/map/union/intersection/page) is
 * profile-independent — only leaf kinds vary, via `profile.leafHandlers`
 * (falling back to `defaultWireLeaf`). Diverges from this file's existing
 * `genValidate` ("errors"/"parse" traversal) in exactly the ways the staged
 * model's contract requires:
 *   - `object`: a field absent from the wire is left absent in the decoded
 *     output, never a `missing` error here. Required-ness is
 *     `validateConstraints`'s job (`errors()`, run on the defaults-filled
 *     value — see "Where defaults-fill sits" in the design doc).
 *   - `object`'s `additionalProperties: false` unexpected-key check belongs
 *     here, not in `validateConstraints`: it's a fact about the wire's own
 *     key set, which decode's per-field copy silently drops (an extra wire
 *     key is never assigned into the decoded output) — checking it
 *     post-decode would never fire.
 *   - no `metaConstraintStmts` anywhere in this traversal — min/max/pattern/
 *     enum/minLength/maxLength/multipleOf are entirely `validateConstraints`'s
 *     job, shared unchanged across every profile (see `compileConstraintsFn`
 *     below). */
function genWireEncodeDecode(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): ValidateResult {
  if (ref.meta.nullable === true) {
    const out = ctx.fresh("n");
    const inner = genWireEncodeDecodeShape(ref, v, pathExpr, ctx, profile, registry);
    const stmts = [
      `let ${out};`,
      `if (${v} === null) { ${out} = null; } else {`,
      ...indentLines(inner.stmts, 2),
      `  ${out} = ${inner.outExpr};`,
      `}`,
    ];
    return { stmts, outExpr: out };
  }
  return genWireEncodeDecodeShape(ref, v, pathExpr, ctx, profile, registry);
}

/** `ref`'s own wire-decode handling (phase D): delegates to
 * `registry.decodeFnName` when the target has a `defs` entry in scope
 * (a `WireDefsRegistry` was passed in and knows this target); with no
 * registry, or a target not in it, this is a structural no-op that aliases
 * the wire value — the same pre-phase-D carve-out `checkHandlers.ref`/
 * `validateHandlers.ref` document for a bare `TypeRef` with no `defs`. */
function wireRefDecode(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry: WireDefsRegistry | undefined,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "ref" };
  if (registry === undefined || !registry.defNames.has(s.target))
    return defaultWireLeaf(ref, v, pathExpr, ctx);
  const fnName = registry.decodeFnName(s.target, profile);
  const out = ctx.fresh("d");
  return { stmts: [`const ${out} = ${fnName}(${v}, ${pathExpr}, errs);`], outExpr: out };
}

function genWireEncodeDecodeShape(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): ValidateResult {
  const kind = ref.shape.kind;
  if (kind === "page")
    return genWireEncodeDecode(pageAsObjectRef(ref), v, pathExpr, ctx, profile, registry);
  if (kind === "ref") return wireRefDecode(ref, v, pathExpr, ctx, profile, registry);
  if (!STRUCTURAL_WIRE_KINDS.has(kind)) {
    const handler = resolve(kind, profile.leafHandlers);
    return handler === undefined
      ? defaultWireLeaf(ref, v, pathExpr, ctx)
      : handler.decode(ref, v, pathExpr, ctx);
  }
  switch (kind) {
    case "object":
      return wireObject(ref, v, pathExpr, ctx, profile, registry);
    case "array":
      return wireArray(ref, v, pathExpr, ctx, profile, registry);
    case "tuple":
      return wireTuple(ref, v, pathExpr, ctx, profile, registry);
    case "map":
      return wireMap(ref, v, pathExpr, ctx, profile, registry);
    case "union":
      return wireUnion(ref, v, pathExpr, ctx, profile, registry);
    case "intersection":
      return wireIntersection(ref, v, pathExpr, ctx, profile, registry);
    default:
      return { stmts: [], outExpr: v };
  }
}

function wireObject(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "object" };
  const baseCond = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`;
  const out = ctx.fresh("o");
  const stmts: string[] = [`let ${out}: Record<string, any> = {};`];
  stmts.push(`if (!(${baseCond})) { ${encodingErrorStmt(pathExpr, "object", v)} } else {`);
  const body: string[] = [];
  for (const [name, field] of Object.entries(s.fields)) {
    const fv = `${v}[${JSON.stringify(name)}]`;
    const fpath = `${pathExpr}.concat([${JSON.stringify(name)}])`;
    const inner = genWireEncodeDecode(field, fv, fpath, ctx, profile, registry);
    body.push(
      `if (${fv} !== undefined) {`,
      ...indentLines(inner.stmts, 2),
      `  ${out}[${JSON.stringify(name)}] = ${inner.outExpr};`,
      `}`,
    );
  }
  if (ref.meta.additionalProperties === false) {
    const known = ctx.addConst("known", `new Set(${JSON.stringify(Object.keys(s.fields))})`);
    body.push(
      `for (const __k of Object.keys(${v})) { if (!${known}.has(__k)) { errs.push({ kind: "unexpected", path: ${pathExpr}.concat([__k]) }); } }`,
    );
  }
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out };
}

function wireArray(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "array" };
  const out = ctx.fresh("a");
  const stmts: string[] = [`let ${out}: any[] = [];`];
  stmts.push(`if (!Array.isArray(${v})) { ${encodingErrorStmt(pathExpr, "array", v)} } else {`);
  const idx = ctx.fresh("i");
  const ev = ctx.fresh("e");
  const epath = ctx.fresh("p");
  const inner = genWireEncodeDecode(s.element, ev, epath, ctx, profile, registry);
  const body = [
    `for (let ${idx} = 0; ${idx} < ${v}.length; ${idx}++) {`,
    `  const ${ev} = ${v}[${idx}];`,
    `  const ${epath} = ${pathExpr}.concat([String(${idx})]);`,
    ...indentLines(inner.stmts, 2),
    `  ${out}.push(${inner.outExpr});`,
    `}`,
  ];
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out };
}

function wireTuple(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "tuple" };
  const out = ctx.fresh("t");
  const stmts: string[] = [`let ${out}: any[] = [];`];
  stmts.push(`if (!Array.isArray(${v})) { ${encodingErrorStmt(pathExpr, "array", v)} } else {`);
  const body: string[] = [
    `if (${v}.length !== ${s.elements.length}) { errs.push({ kind: "tuple_length", path: ${pathExpr}, expected: ${s.elements.length}, actual: ${v}.length }); }`,
  ];
  s.elements.forEach((element, i) => {
    const ev = `${v}[${i}]`;
    const epath = `${pathExpr}.concat([${JSON.stringify(String(i))}])`;
    const inner = genWireEncodeDecode(element, ev, epath, ctx, profile, registry);
    body.push(
      `if (${v}.length > ${i}) {`,
      ...indentLines(inner.stmts, 2),
      `  ${out}.push(${inner.outExpr});`,
      `}`,
    );
  });
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out };
}

function wireMap(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "map" };
  const baseCond = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`;
  const out = ctx.fresh("m");
  const stmts: string[] = [`let ${out}: Record<string, any> = {};`];
  stmts.push(`if (!(${baseCond})) { ${encodingErrorStmt(pathExpr, "object", v)} } else {`);
  const key = ctx.fresh("k");
  const ev = ctx.fresh("e");
  const epath = ctx.fresh("p");
  const inner = genWireEncodeDecode(s.value, ev, epath, ctx, profile, registry);
  const body = [
    `for (const ${key} of Object.keys(${v})) {`,
    `  const ${ev} = ${v}[${key}];`,
    `  const ${epath} = ${pathExpr}.concat([${key}]);`,
    ...indentLines(inner.stmts, 2),
    `  ${out}[${key}] = ${inner.outExpr};`,
    `}`,
  ];
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out };
}

/** Union: same "try each variant, keep the first with zero new errors" idiom
 * as this file's existing `unionValidate` — here, "zero new errors" means
 * zero ENCODING errors (a variant this profile can't even decode the wire
 * into), not zero constraint errors (constraints aren't checked until
 * `validateConstraints`, after a variant has already been picked). */
function wireUnion(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "union" };
  const out = ctx.fresh("u");
  const matched = ctx.fresh("matched");
  const scratchNames: string[] = [];
  const stmts: string[] = [`let ${out} = ${v};`, `let ${matched} = false;`];
  for (const _variant of s.variants) {
    const scratch = ctx.fresh("ue");
    scratchNames.push(scratch);
    stmts.push(`const ${scratch}: ValidationError[] = [];`);
  }
  s.variants.forEach((variant, i) => {
    const scratch = scratchNames[i]!;
    const inner = genWireEncodeDecode(variant, v, pathExpr, ctx, profile, registry);
    stmts.push(`if (!${matched}) {`);
    stmts.push(`  { const errs = ${scratch};`);
    stmts.push(...indentLines(inner.stmts, 4));
    stmts.push(
      `    if (${scratch}.length === 0) { ${matched} = true; ${out} = ${inner.outExpr}; }`,
    );
    stmts.push(`  }`);
    stmts.push(`}`);
  });
  stmts.push(
    `if (!${matched}) { errs.push({ kind: "union", path: ${pathExpr}, errors: [${scratchNames.join(", ")}] }); }`,
  );
  return { stmts, outExpr: out };
}

function wireIntersection(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "intersection" };
  if (s.members.length === 0) return { stmts: [], outExpr: v };
  const out = ctx.fresh("x");
  const stmts: string[] = [`let ${out} = ${v};`];
  const hasObjectMember = s.members.some((m) => m.shape.kind === "object");
  if (hasObjectMember) stmts.push(`${out} = {};`);
  for (const member of s.members) {
    const inner = genWireEncodeDecode(member, v, pathExpr, ctx, profile, registry);
    stmts.push(...inner.stmts);
    if (hasObjectMember && member.shape.kind === "object") {
      stmts.push(`Object.assign(${out}, ${inner.outExpr});`);
    } else if (!hasObjectMember) {
      stmts.push(`${out} = ${inner.outExpr};`);
    }
  }
  return { stmts, outExpr: out };
}

/** `ValidWire`'s TypeScript rendering for `ref` under `profile` — a real,
 * named-by-the-caller type (see `compileWireEntryFragment`), not a phantom
 * brand: an object's fields are always rendered optional (`?:`) regardless of
 * `meta.optional`, matching `wireObject`'s "absent field, no error" decode
 * semantics above — decode only ever produces what the wire actually
 * carried. */
export function wireTypeText(
  ref: TypeRef,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): string {
  const base = wireTypeTextShape(ref, profile, registry);
  return ref.meta.nullable === true ? `${base} | null` : base;
}

function wireTypeTextShape(
  ref: TypeRef,
  profile: WireProfile,
  registry?: WireDefsRegistry,
): string {
  const kind = ref.shape.kind;
  if (kind === "page") return wireTypeTextShape(pageAsObjectRef(ref), profile, registry);
  if (kind === "ref") {
    const s = ref.shape as TypeShape & { kind: "ref" };
    if (registry === undefined || !registry.defNames.has(s.target)) return defaultWireType(ref);
    return registry.typeAliasName(s.target, profile);
  }
  if (kind === "object") {
    const s = ref.shape as TypeShape & { kind: "object" };
    const fields = Object.entries(s.fields).map(
      ([name, field]) => `${JSON.stringify(name)}?: ${wireTypeText(field, profile, registry)}`,
    );
    return `{ ${fields.join("; ")} }`;
  }
  if (kind === "array") {
    const s = ref.shape as TypeShape & { kind: "array" };
    return `(${wireTypeText(s.element, profile, registry)})[]`;
  }
  if (kind === "tuple") {
    const s = ref.shape as TypeShape & { kind: "tuple" };
    return `[${s.elements.map((e) => wireTypeText(e, profile, registry)).join(", ")}]`;
  }
  if (kind === "map") {
    const s = ref.shape as TypeShape & { kind: "map" };
    return `Record<string, ${wireTypeText(s.value, profile, registry)}>`;
  }
  if (kind === "union") {
    const s = ref.shape as TypeShape & { kind: "union" };
    return s.variants.map((m) => `(${wireTypeText(m, profile, registry)})`).join(" | ");
  }
  if (kind === "intersection") {
    const s = ref.shape as TypeShape & { kind: "intersection" };
    return s.members.map((m) => `(${wireTypeText(m, profile, registry)})`).join(" & ");
  }
  const override = resolve(kind, profile.leafHandlers);
  return override === undefined ? defaultWireType(ref) : override.wireType(ref);
}

/** `defaults-fill` — see "Where defaults-fill sits" in the design doc: runs
 * after `decode`, before `validateConstraints`, so a defaulted field is
 * checked exactly like a caller-supplied one (no separate "missing-but-has-
 * a-default" carve-out in `validateConstraints`). Profile-independent —
 * defaults are author-supplied `T`-typed values (`meta.default`, the
 * convention `json-schema.ts`'s `withMeta` already reads/emits), with no
 * wire encoding to decode from; running them through `decode` would require
 * `decode` to accept `T` values it never itself produced, breaking its
 * totality-by-construction guarantee for no benefit. */
function genDefaultsFillChildren(ref: TypeRef, v: string): string[] {
  if (ref.shape.kind === "object") {
    const s = ref.shape as TypeShape & { kind: "object" };
    const stmts: string[] = [];
    for (const [name, field] of Object.entries(s.fields)) {
      stmts.push(...genDefaultsFillField(field, `${v}[${JSON.stringify(name)}]`));
    }
    return stmts;
  }
  if (ref.shape.kind === "array") {
    const s = ref.shape as TypeShape & { kind: "array" };
    const nested = genDefaultsFillField(s.element, "__el");
    if (nested.length === 0) return [];
    return [
      `if (Array.isArray(${v})) { for (const __el of ${v}) {`,
      ...indentLines(nested, 2),
      `} }`,
    ];
  }
  return [];
}

function genDefaultsFillField(field: TypeRef, fv: string): string[] {
  const stmts: string[] = [];
  if (field.meta.default !== undefined) {
    stmts.push(`if (${fv} === undefined) { ${fv} = ${JSON.stringify(field.meta.default)}; }`);
  }
  const nested = genDefaultsFillChildren(field, fv);
  if (nested.length > 0) {
    stmts.push(`if (${fv} !== undefined) {`, ...indentLines(nested, 2), `}`);
  }
  return stmts;
}

/** `validateConstraints` — min/max/pattern/enum/minLength/maxLength/
 * multipleOf/required-field checks on `T`. This is `errors()`'s existing
 * codegen (`genValidate(ref, ..., "errors")`, entirely unmodified — the
 * design doc's identity-profile framing is literal: "what today's
 * check/errors/parse do for an in-process, already-typed value with no wire
 * in between"), given its own module-scope function name so every wire
 * profile's `parse` for the same entry calls the same compiled function
 * instead of regenerating it — "compiled once per TypeRef and shared across
 * all profiles" (design doc). It depends only on `ref`'s own IR fingerprint,
 * never on any wire profile — the doc's "wire profile as a second
 * fingerprint input" (see `compileWireEntryFragment`'s doc comment) is
 * exactly what this function does not take.
 *
 * `externalDefNames` (phase D) is the same seeding mechanism
 * `compileEntryBody`'s own `externalDefNames` parameter uses: a caller
 * compiles the shared `__def_NAME_check/errors/parse` functions once at
 * module scope (`compileDefsBlock`, unchanged) and passes the resulting
 * `defNames` set here — as `compileWireModule` does — so a `ref` inside
 * `ref`'s own tree resolves to a call into that shared function (via the
 * existing, unmodified `validateHandlers.ref`)
 * instead of the pre-phase-D no-op passthrough. This does not recompile
 * `defs`' own bodies — that stays `compileDefsBlock`'s job, shared with the
 * non-wire `check`/`errors`/`parse` path, so a def reused by both paths in
 * one module still compiles once. */
export type CompiledConstraintsFn = { readonly fnName: string; readonly lines: readonly string[] };

export function compileConstraintsFn(
  name: string,
  ref: TypeRef,
  externalDefNames?: ReadonlySet<string>,
): CompiledConstraintsFn {
  const fnName = `__constraints_${sanitizeDefName(name)}`;
  // Namespaced by entry name (not the module-shared default `""`) — see `GenCtx`'s
  // `namespace` doc comment: this function's `.lines` (including its hoisted consts)
  // get spliced at module scope alongside every other entry's own `compileConstraintsFn`
  // output (`assembleWireModule`/`assembleWireApplyValidationModule`), so two entries'
  // consts must never collide on `__ref0`-style names the way two `GenCtx()` instances
  // both starting their counters at 0 otherwise would.
  const ctx = new GenCtx(`${sanitizeDefName(name)}_`);
  // Seed `ctx.defNames` before walking the body (mirrors `compileEntryBody`'s
  // own `externalDefNames` seeding) — the def function declarations
  // themselves live in the caller's shared `compileDefsBlock` output, not here.
  if (externalDefNames !== undefined)
    for (const defName of externalDefNames) ctx.defNames.add(defName);
  const body = genValidate(ref, "value", "path", ctx, "errors");
  const lines = [
    ...ctx.declarations(),
    `function ${fnName}(value: any): ValidationError[] {`,
    `  void value;`,
    `  const path: string[] = [];`,
    `  void path;`,
    `  const errs: ValidationError[] = [];`,
    ...indentLines(body.stmts, 2),
    `  return errs;`,
    `}`,
  ];
  return { fnName, lines };
}

/** One (entry, profile) pair's compiled `{ parse }` — the staged pipeline
 * fused into one function per the design doc's permitted emission
 * optimization ("fusing stages into one emitted `parse_profile` function"):
 * `validateEncoding`+`decode` (this fragment's own codegen, profile-driven),
 * then `defaults-fill` (profile-independent), then `validateConstraints`
 * (a call to `constraintsFnName`, not regenerated here — see
 * `compileConstraintsFn`'s doc comment for why sharing it across profiles is
 * load-bearing, not just an optimization). Self-contained modulo that one
 * by-name reference, with `profile.name` as the doc-noted second fingerprint
 * input:
 * a caller re-derives this fragment only when `ref`'s own IR fingerprint or
 * `profile.name` changed; `constraintsFnName` is a pure naming convention,
 * not part of the fingerprint, since it's derived from the entry name alone. */
export type CompiledWireEntryFragment = {
  readonly code: string;
  readonly wireType: string;
  readonly typeImport?: { readonly typeName: string; readonly from: string };
  /** Field names this fragment's generated `parse` expects a custom-decoder
   * hook for, supplied at wrap time (function-form `encodingMap` — see
   * `wireObjectWithFieldProfiles`'s doc comment). Always `[]` for a fragment
   * compiled via `compileWireEntryFragment` (the uniform-profile path never
   * dispatches per field name, so it can never have a hook field); non-empty
   * only for a `compileWireEntryFragmentComposite` fragment whose caller
   * passed a non-empty `hookFields`. Embedded verbatim into the fragment's
   * own generated `code` (as a literal property on the returned entry
   * object), not just carried on this compile-time wrapper — api-tree's
   * `apply-validation.ts` reads it off the runtime generated entry, which
   * never sees this TypeScript-only wrapper type. */
  readonly hookFields: readonly string[];
};

export function compileWireEntryFragment(
  ref: TypeRef,
  profile: WireProfile,
  constraintsFnName: string,
  resolveImport?: (declarationFile: string) => string,
  registry?: WireDefsRegistry,
): CompiledWireEntryFragment {
  const { annotation, typeImport } = guardAnnotation(ref, resolveImport, registry?.defNames);
  const wireType = wireTypeText(ref, profile, registry);
  const ctx = new GenCtx();
  const decodeBody = genWireEncodeDecode(ref, "wire", "path", ctx, profile, registry);
  const fillStmts = genDefaultsFillChildren(ref, "__decoded");

  const lines: string[] = [...ctx.declarations()];
  lines.push(`function parse(wire: any) {`);
  lines.push(`  const path: string[] = [];`);
  lines.push(`  void path;`);
  lines.push(`  const errs: ValidationError[] = [];`);
  lines.push(...indentLines(decodeBody.stmts, 2));
  lines.push(`  if (errs.length > 0) { return { kind: "err" as const, errors: errs }; }`);
  lines.push(`  let __decoded: any = ${decodeBody.outExpr};`);
  lines.push(...indentLines(fillStmts, 2));
  lines.push(`  const constraintErrs = ${constraintsFnName}(__decoded);`);
  lines.push(
    `  if (constraintErrs.length > 0) { return { kind: "err" as const, errors: constraintErrs }; }`,
  );
  lines.push(`  return { kind: "ok" as const, value: __decoded };`);
  lines.push(`}`);
  lines.push(`return { parse: parse, hookFields: [] } as unknown as {`);
  lines.push(
    `  parse: (wire: unknown) => { kind: "ok"; value: ${annotation} } | { kind: "err"; errors: ValidationError[] };`,
  );
  lines.push(`  hookFields: readonly string[];`);
  lines.push(`};`);
  const code = ["(function () {", ...indentLines(lines, 2), "})()"].join("\n");
  return typeImport === undefined
    ? { code, wireType, hookFields: [] }
    : { code, wireType, typeImport, hookFields: [] };
}

/** True when `ref` (accounting for `meta.nullable` and `page`, the same
 * unwrapping `genWireEncodeDecodeShape`/`wireTypeTextShape` above already do)
 * is an `object` at the top level — the only shape
 * `compileWireEntryFragmentComposite`'s per-field dispatch applies to. */
function isTopLevelObjectRef(ref: TypeRef): boolean {
  const kind = ref.shape.kind;
  if (kind === "page") return true;
  return kind === "object";
}

/** Sibling of `wireObject` whose per-field profile lookup varies by field
 * name instead of using one profile for every field — see
 * `compileWireEntryFragmentComposite`'s doc comment for why this exists as a
 * separate function rather than a parameter added to `wireObject` itself.
 *
 * `hookFields` (default empty) names fields whose decode is a custom decoder
 * function supplied at wrap time (function-form `encodingMap`, see
 * docs/design/wire-profiles-and-staged-validation.md's implementation-trace
 * addendum for this phase) rather than this profile's fused default decode.
 * A hook field still runs its ordinary `genWireEncodeDecode` statements — the
 * same `validateEncoding` check every other field gets, so a wire-shape-
 * invalid input is rejected exactly as it would be fused — but discards that
 * call's own decoded `outExpr`; the assignment instead calls
 * `hooks[name](fv)` with the raw wire field value (`fv`/`v` above), which
 * per the staged model is `ValidWire` once `validateEncoding` has passed (no
 * existing leaf handler mutates its input before decoding it — see
 * `numericStringLeaf`/`strictBoolFromStringLeaf`/`argvBoolLeaf`/
 * `isoDateStringLeaf`/`defaultWireLeaf`, none of which touch `v` itself).
 * Guarded by `errs.length` before/after the field's own `validateEncoding`
 * statements — a hook only runs when that field introduced no new error —
 * and wrapped in try/catch: a throw (or a missing/non-function hook — the
 * wrap-time stale-module check in api-tree's `apply-validation.ts` is the
 * fail-at-wrap-time version of this same defect; this is the generated
 * code's own fallback for a caller that invokes `parse` directly without
 * going through that check) becomes a structured `"decode"`
 * `ValidationError` instead of propagating or silently producing
 * `undefined`. A field not in `hookFields` is unaffected — the same fused
 * single-pass emission as when this parameter didn't exist, with zero extra
 * machinery. */
function wireObjectWithFieldProfiles(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  fieldProfiles: Readonly<Record<string, WireProfile>>,
  defaultProfile: WireProfile,
  registry?: WireDefsRegistry,
  hookFields: ReadonlySet<string> = EMPTY_HOOK_FIELDS,
): ValidateResult {
  const s = ref.shape as TypeShape & { kind: "object" };
  const baseCond = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`;
  const out = ctx.fresh("o");
  const stmts: string[] = [`let ${out}: Record<string, any> = {};`];
  stmts.push(`if (!(${baseCond})) { ${encodingErrorStmt(pathExpr, "object", v)} } else {`);
  const body: string[] = [];
  for (const [name, field] of Object.entries(s.fields)) {
    const fv = `${v}[${JSON.stringify(name)}]`;
    const fpath = `${pathExpr}.concat([${JSON.stringify(name)}])`;
    const fieldProfile = fieldProfiles[name] ?? defaultProfile;
    const inner = genWireEncodeDecode(field, fv, fpath, ctx, fieldProfile, registry);
    if (!hookFields.has(name)) {
      body.push(
        `if (${fv} !== undefined) {`,
        ...indentLines(inner.stmts, 2),
        `  ${out}[${JSON.stringify(name)}] = ${inner.outExpr};`,
        `}`,
      );
      continue;
    }
    const preErrs = ctx.fresh("preErrs");
    const hook = ctx.fresh("hook");
    body.push(
      `if (${fv} !== undefined) {`,
      `  const ${preErrs} = errs.length;`,
      ...indentLines(inner.stmts, 2),
      `  if (errs.length === ${preErrs}) {`,
      `    const ${hook} = hooks ? hooks[${JSON.stringify(name)}] : undefined;`,
      `    if (typeof ${hook} !== "function") {`,
      `      errs.push({ kind: "decode", path: ${fpath}, message: ${JSON.stringify(`no decoder hook supplied for field ${JSON.stringify(name)}`)} });`,
      `    } else {`,
      `      try { ${out}[${JSON.stringify(name)}] = ${hook}(${fv}); }`,
      `      catch (__e) { errs.push({ kind: "decode", path: ${fpath}, message: __e instanceof Error ? __e.message : String(__e) }); }`,
      `    }`,
      `  }`,
      `}`,
    );
  }
  if (ref.meta.additionalProperties === false) {
    const known = ctx.addConst("known", `new Set(${JSON.stringify(Object.keys(s.fields))})`);
    body.push(
      `for (const __k of Object.keys(${v})) { if (!${known}.has(__k)) { errs.push({ kind: "unexpected", path: ${pathExpr}.concat([__k]) }); } }`,
    );
  }
  stmts.push(...indentLines(body, 2), `}`);
  return { stmts, outExpr: out };
}

/** Shared empty-set default for `wireObjectWithFieldProfiles`'s `hookFields`
 * parameter — a single frozen instance rather than allocating a fresh `Set`
 * per call for the (overwhelmingly common) no-hooks case. */
const EMPTY_HOOK_FIELDS: ReadonlySet<string> = new Set();

/** Composite-top wrapper: unwraps `meta.nullable`/`page` (mirroring
 * `genWireEncodeDecode`/`genWireEncodeDecodeShape`'s own unwrapping) then
 * dispatches to `wireObjectWithFieldProfiles` for the top-level object.
 * `compileWireEntryFragmentComposite` only ever calls this once it has
 * already confirmed (`isTopLevelObjectRef`) that `ref` unwraps to an object —
 * this function still has to handle the unwrapping itself because that's the
 * shape the fields end up dispatched against, not just a delegation check. */
function genWireEncodeDecodeCompositeTop(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  fieldProfiles: Readonly<Record<string, WireProfile>>,
  defaultProfile: WireProfile,
  registry?: WireDefsRegistry,
  hookFields: ReadonlySet<string> = EMPTY_HOOK_FIELDS,
): ValidateResult {
  if (ref.meta.nullable === true) {
    const out = ctx.fresh("n");
    const inner = genWireEncodeDecodeCompositeTopShape(
      ref,
      v,
      pathExpr,
      ctx,
      fieldProfiles,
      defaultProfile,
      registry,
      hookFields,
    );
    const stmts = [
      `let ${out};`,
      `if (${v} === null) { ${out} = null; } else {`,
      ...indentLines(inner.stmts, 2),
      `  ${out} = ${inner.outExpr};`,
      `}`,
    ];
    return { stmts, outExpr: out };
  }
  return genWireEncodeDecodeCompositeTopShape(
    ref,
    v,
    pathExpr,
    ctx,
    fieldProfiles,
    defaultProfile,
    registry,
    hookFields,
  );
}

function genWireEncodeDecodeCompositeTopShape(
  ref: TypeRef,
  v: string,
  pathExpr: string,
  ctx: GenCtx,
  fieldProfiles: Readonly<Record<string, WireProfile>>,
  defaultProfile: WireProfile,
  registry?: WireDefsRegistry,
  hookFields: ReadonlySet<string> = EMPTY_HOOK_FIELDS,
): ValidateResult {
  if (ref.shape.kind === "page") {
    return genWireEncodeDecodeCompositeTop(
      pageAsObjectRef(ref),
      v,
      pathExpr,
      ctx,
      fieldProfiles,
      defaultProfile,
      registry,
      hookFields,
    );
  }
  return wireObjectWithFieldProfiles(
    ref,
    v,
    pathExpr,
    ctx,
    fieldProfiles,
    defaultProfile,
    registry,
    hookFields,
  );
}

/** Sibling of `wireTypeTextShape`'s `"object"` branch whose per-field
 * `ValidWire` type varies by field NAME — the `wireTypeText` analogue of
 * `wireObjectWithFieldProfiles`. */
function wireTypeTextObjectWithFieldProfiles(
  ref: TypeRef,
  fieldProfiles: Readonly<Record<string, WireProfile>>,
  defaultProfile: WireProfile,
  registry?: WireDefsRegistry,
): string {
  const s = ref.shape as TypeShape & { kind: "object" };
  const fields = Object.entries(s.fields).map(
    ([name, field]) =>
      `${JSON.stringify(name)}?: ${wireTypeText(field, fieldProfiles[name] ?? defaultProfile, registry)}`,
  );
  return `{ ${fields.join("; ")} }`;
}

function wireTypeTextCompositeTopShape(
  ref: TypeRef,
  fieldProfiles: Readonly<Record<string, WireProfile>>,
  defaultProfile: WireProfile,
  registry?: WireDefsRegistry,
): string {
  if (ref.shape.kind === "page") {
    return wireTypeTextCompositeTopShape(
      pageAsObjectRef(ref),
      fieldProfiles,
      defaultProfile,
      registry,
    );
  }
  return wireTypeTextObjectWithFieldProfiles(ref, fieldProfiles, defaultProfile, registry);
}

/** `wireTypeText`'s composite-top analogue: mirrors `wireTypeText`'s own
 * `meta.nullable` handling, then dispatches to
 * `wireTypeTextCompositeTopShape`/`wireTypeTextObjectWithFieldProfiles`. */
function wireTypeTextComposite(
  ref: TypeRef,
  fieldProfiles: Readonly<Record<string, WireProfile>>,
  defaultProfile: WireProfile,
  registry?: WireDefsRegistry,
): string {
  const base = wireTypeTextCompositeTopShape(ref, fieldProfiles, defaultProfile, registry);
  return ref.meta.nullable === true ? `${base} | null` : base;
}

/**
 * Per-field composite entry-fragment compiler — `compileWireEntryFragment`'s
 * sibling for the case where a single leaf's own params need different wire
 * profiles per field (HTTP: a query-string field and a JSON-body field on the
 * same operation; CLI: a flag-store field and a path-slug field). Phase A's
 * `WireProfile.leafHandlers` dispatches by TypeRef kind only, which cannot
 * vary by field name — this is the top-level, per-field-name dispatch that
 * closes that gap, without touching `compileWireEntryFragment` or anything it
 * calls: every structural/leaf function above (`wireObject`,
 * `genWireEncodeDecode`, `wireTypeTextShape`, ...) is reused completely
 * unchanged, including for every field's own sub-structure (a composite
 * profile only ever varies dispatch at the leaf's own direct fields — a
 * validated leaf's input is always an object of named params one level deep,
 * per the design doc; nested structure under one field still resolves via
 * that field's own single profile, recursing through the ordinary,
 * profile-blind-to-field-name `genWireEncodeDecode`).
 *
 * `ref.shape.kind !== "object"` (after accounting for `meta.nullable`/`page`
 * the same way `genWireEncodeDecodeShape` does) has no top-level fields to
 * dispatch per-name over, so this is exactly
 * `compileWireEntryFragment(ref, defaultProfile, ...)` — delegation, not a
 * separate codepath, so the non-object case can never drift from the ordinary
 * one. This also means a non-empty `hookFields` is silently inert for a
 * non-object `ref` — there are no named fields to hook here, the same way
 * `fieldProfiles` is already inert in this branch.
 *
 * `hookFields` (default empty) threads straight through to
 * `genWireEncodeDecodeCompositeTop`/`wireObjectWithFieldProfiles` (see that
 * function's doc comment for the full hook-emission contract) and is
 * embedded verbatim into the compiled fragment's generated entry object and
 * this function's own return value (`CompiledWireEntryFragment.hookFields`)
 * — the one static surface a caller needs to drive both the wrap-time
 * stale-module check (api-tree's `apply-validation.ts`) and the
 * incremental-build fingerprint (api-tree's `apply-validation-build.ts`'s
 * `fingerprintableDerivation`). The generated `parse` function itself gains
 * a second, optional `hooks` parameter regardless of whether `hookFields` is
 * empty — a stable signature is simpler than a fragment-shape that varies by
 * whether hooks are in play, and an ignored extra parameter costs nothing at
 * the (rare, wrap-time-only) call site.
 */
export function compileWireEntryFragmentComposite(
  ref: TypeRef,
  fieldProfiles: Readonly<Record<string, WireProfile>>,
  defaultProfile: WireProfile,
  constraintsFnName: string,
  resolveImport?: (declarationFile: string) => string,
  registry?: WireDefsRegistry,
  hookFields: ReadonlySet<string> = EMPTY_HOOK_FIELDS,
): CompiledWireEntryFragment {
  if (!isTopLevelObjectRef(ref)) {
    return compileWireEntryFragment(
      ref,
      defaultProfile,
      constraintsFnName,
      resolveImport,
      registry,
    );
  }
  const { annotation, typeImport } = guardAnnotation(ref, resolveImport, registry?.defNames);
  const wireType = wireTypeTextComposite(ref, fieldProfiles, defaultProfile, registry);
  const ctx = new GenCtx();
  const decodeBody = genWireEncodeDecodeCompositeTop(
    ref,
    "wire",
    "path",
    ctx,
    fieldProfiles,
    defaultProfile,
    registry,
    hookFields,
  );
  const fillStmts = genDefaultsFillChildren(ref, "__decoded");
  const hookFieldsLiteral = JSON.stringify([...hookFields]);

  const lines: string[] = [...ctx.declarations()];
  // `hooks` is only actually referenced in `decodeBody.stmts` when some field
  // in `s.fields` is both in `hookFields` and emitted by
  // `wireObjectWithFieldProfiles` (see that function's hook-emission branch,
  // guarded by `hookFields.has(name)`). When that never fires — the
  // overwhelmingly common no-hooks case — the parameter is dead in the
  // function body, and `noUnusedParameters`-strict consumers (this repo's
  // own tsconfig included) flag it as `TS6133`. Name it `_hooks` in exactly
  // that case, the standard TS/eslint "intentionally unused" convention,
  // rather than emitting a name the body never uses.
  const hooksParamUsed = decodeBody.stmts.some((line) => /\bhooks\b/.test(line));
  const hooksParamName = hooksParamUsed ? "hooks" : "_hooks";
  lines.push(
    `function parse(wire: any, ${hooksParamName}?: Readonly<Record<string, (w: any) => any>>) {`,
  );
  lines.push(`  const path: string[] = [];`);
  lines.push(`  void path;`);
  lines.push(`  const errs: ValidationError[] = [];`);
  lines.push(...indentLines(decodeBody.stmts, 2));
  lines.push(`  if (errs.length > 0) { return { kind: "err" as const, errors: errs }; }`);
  lines.push(`  let __decoded: any = ${decodeBody.outExpr};`);
  lines.push(...indentLines(fillStmts, 2));
  lines.push(`  const constraintErrs = ${constraintsFnName}(__decoded);`);
  lines.push(
    `  if (constraintErrs.length > 0) { return { kind: "err" as const, errors: constraintErrs }; }`,
  );
  lines.push(`  return { kind: "ok" as const, value: __decoded };`);
  lines.push(`}`);
  lines.push(`return { parse: parse, hookFields: ${hookFieldsLiteral} } as unknown as {`);
  lines.push(
    `  parse: (wire: unknown, hooks?: Readonly<Record<string, (w: unknown) => unknown>>) => { kind: "ok"; value: ${annotation} } | { kind: "err"; errors: ValidationError[] };`,
  );
  lines.push(`  hookFields: readonly string[];`);
  lines.push(`};`);
  const code = ["(function () {", ...indentLines(lines, 2), "})()"].join("\n");
  const hookFieldsArr = [...hookFields];
  return typeImport === undefined
    ? { code, wireType, hookFields: hookFieldsArr }
    : { code, wireType, typeImport, hookFields: hookFieldsArr };
}

/** The key `assembleWireModule`'s `wireValidators` map uses for one
 * (entry, profile) pair — the exact surface the design doc asks for
 * ("design the emitted module surface so apply-validation-build can request
 * (key, profile) pairs"). Exported so a caller (phase B/C's
 * `apply-validation-build.ts`) constructs the SAME key deterministically
 * rather than re-deriving the joining convention itself. */
export function wireValidatorKey(name: string, profileName: string): string {
  return `${name} ${profileName}`;
}

/**
 * Reassembles a complete wire-validator module from already-compiled pieces
 * — the wire-profile analogue of the now-deleted (phase D)
 * `assembleValidatorModule`. `constraintsFns` (keyed by entry name) is
 * emitted once per entry at module scope,
 * independent of how many profiles that entry has fragments for — see
 * `compileConstraintsFn`'s doc comment for why. `wireFragments` is keyed by
 * `wireValidatorKey(name, profileName)`.
 *
 * `defsBlockLines` (phase D, default `[]`) is the constraints layer's shared
 * `__def_NAME_check/errors/parse` + `type __def_NAME` declarations —
 * `compileDefsBlock`'s own output, spliced here exactly once (the same defs
 * record a caller also builds `wireDefsLines` from). `wireDefsLines` (phase
 * D, default `[]`) is the decode layer's own `__wiredecode_*`/`__wiretype_*`
 * declarations — `WireDefsRegistry.moduleLines()`. Both default to empty for
 * a caller with no `defs` in play.
 */
export function assembleWireModule(
  entries: readonly { readonly name: string }[],
  profileNames: readonly string[],
  constraintsFns: Readonly<Record<string, CompiledConstraintsFn>>,
  wireFragments: Readonly<Record<string, CompiledWireEntryFragment>>,
  defsBlockLines: readonly string[] = [],
  wireDefsLines: readonly string[] = [],
): string {
  const imports = new Map<string, Set<string>>();
  imports.set("@rhi-zone/fractal-type-ir", new Set(["ValidationError"]));

  const constraintsLines: string[] = [];
  for (const { name } of entries) {
    const fn = constraintsFns[name];
    if (!fn)
      throw new Error(
        `assembleWireModule: missing constraints fn for entry ${JSON.stringify(name)}`,
      );
    constraintsLines.push(...fn.lines);
  }

  const entryLines: string[] = [];
  for (const { name } of entries) {
    for (const profileName of profileNames) {
      const key = wireValidatorKey(name, profileName);
      const frag = wireFragments[key];
      if (!frag)
        throw new Error(`assembleWireModule: missing wire fragment for ${JSON.stringify(key)}`);
      if (frag.typeImport) {
        const names = imports.get(frag.typeImport.from) ?? new Set<string>();
        names.add(frag.typeImport.typeName);
        imports.set(frag.typeImport.from, names);
      }
      const codeLines = frag.code.split("\n");
      entryLines.push(
        `  ${JSON.stringify(key)}: ${codeLines[0]}`,
        ...indentLines(codeLines.slice(1, -1), 2),
        `  ${codeLines[codeLines.length - 1]},`,
      );
    }
  }

  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @rhi-zone/fractal-type-ir. Do not edit by hand.");
  lines.push("");
  for (const [from, names] of imports) {
    lines.push(`import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(from)}`);
  }
  if (imports.size > 0) lines.push("");
  lines.push(INFER_TYPE_REF_SOURCE);
  lines.push("");
  lines.push(...defsBlockLines);
  if (defsBlockLines.length > 0) lines.push("");
  lines.push(...wireDefsLines);
  if (wireDefsLines.length > 0) lines.push("");
  lines.push(...constraintsLines);
  if (constraintsLines.length > 0) lines.push("");
  lines.push("export const wireValidators = {");
  lines.push(...entryLines);
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Non-incremental convenience wrapper around `compileConstraintsFn`/
 * `compileWireEntryFragment`/`assembleWireModule` — compiles every entry for
 * every requested profile in one pass, the wire-profile analogue of the
 * now-deleted (phase D) `compileValidatorModule`. Incremental callers
 * (api-tree's build orchestrator) should use the split functions directly.
 *
 * `options.defs` (phase D) mirrors `compileValidatorModule`'s own (now-deleted)
 * `defs` option: compiled once at module scope (`compileDefsBlock` for the
 * constraints layer, one shared `WireDefsRegistry` for the decode layer),
 * shared across every entry/profile — a def referenced by multiple entries,
 * or by the same entry under multiple profiles, compiles once per layer.
 */
export function compileWireModule(
  entries: readonly { readonly name: string; readonly ref: TypeRef }[],
  profiles: readonly WireProfile[],
  options?: { resolveImport?: (declarationFile: string) => string; defs?: Record<string, TypeRef> },
): string {
  const defs = options?.defs ?? {};
  const defsBlock = compileDefsBlock(defs);
  const registry = createWireDefsRegistry(defs);
  const constraintsFns: Record<string, CompiledConstraintsFn> = {};
  const wireFragments: Record<string, CompiledWireEntryFragment> = {};
  for (const { name, ref } of entries) {
    constraintsFns[name] = compileConstraintsFn(name, ref, defsBlock.defNames);
    for (const profile of profiles) {
      const key = wireValidatorKey(name, profile.name);
      wireFragments[key] = compileWireEntryFragment(
        ref,
        profile,
        constraintsFns[name].fnName,
        options?.resolveImport,
        registry,
      );
    }
  }
  return assembleWireModule(
    entries,
    profiles.map((p) => p.name),
    constraintsFns,
    wireFragments,
    defsBlock.lines,
    registry.moduleLines(),
  );
}
