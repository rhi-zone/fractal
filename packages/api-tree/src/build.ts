// packages/api-tree/src/build.ts — @rhi-zone/fractal-api-tree
//
// SETTLED (phase 3, 2026-08): this file used to be the build orchestrator for
// `wrapValidators` — a Node-level mechanism that wired a generated validator
// module onto a raw `api()` tree's leaf handlers, shared by HTTP/MCP/CLI/
// GraphQL before each was projected/dispatched. It's been superseded
// end-to-end by the keyed, call-site-anchored `applyValidation(key,
// projectedTree)` mechanism (`apply-validation.ts`/`apply-validation-build.ts`)
// — see docs/design/routing-and-transforms.md's "Dispatch is not an
// interceptable multi-stage pipeline" section for the full history.
//
// Deleted from this file: `wrapValidators`/`wrapValidatorsUnchecked`,
// `isValidatorWrapped`/`wrappedHandlerBrand`, `UnvalidatedLeafError`,
// `collectUnvalidatedLeaves`/`isTaggedUnvalidated`/`wrapHandler`, and the
// codegen entry points that existed only to feed `wrapValidators` a module —
// `buildValidatorModuleSource`/`writeValidatorModule` and their cached/
// incremental variants (`buildValidatorModuleSourceIncremental`,
// `buildValidatorModuleCached`, `writeValidatorModuleCached`) plus their
// private helpers (`relativeImportSpecifier`, `isCompiledFragment`).
// `apply-validation-build.ts` does NOT reuse any of these — it reimplements
// the same extraction/compile plumbing itself (over call sites rather than
// exported trees), so nothing here was shared infrastructure worth keeping
// for that file's sake.
//
// What remains: `GeneratedEntry`, the one type genuinely shared across both
// mechanisms (and every projector) — it's the type-ir compiler's own output
// contract (`compileWireEntryFragment`/`compileConstraintsFn`, `@rhi-zone/
// fractal-type-ir`), not something specific to `wrapValidators`. (Phase D
// deleted the module-assembly layer this used to also describe —
// `compileValidatorModule`/`compileEntryFragment` — once the 2-arg
// `applyValidation` codegen route they backed was retired.)
// `apply-validation.ts` re-exports it from here for convenience; every
// projector's `GeneratedEntry` import (`@rhi-zone/fractal-api-tree/build`)
// keeps working unchanged.

/** One generated entry's public shape — see type-ir/compile.ts's
 * `compileWireEntryFragment`/`compileWireEntryFragmentComposite`/
 * `compileConstraintsFn`.
 *
 * `hooks` (second, optional `parse` argument) and `hookFields` are additive —
 * see docs/design/wire-profiles-and-staged-validation.md's implementation-
 * trace addendum for the function-form `encodingMap` phase. A field flagged
 * as HOOK-COVERED by a leaf's own `encodingMap` (per-protocol meta, function
 * form) is validated for wire SHAPE by the generated fragment exactly like
 * any other field, but DECODED by whatever function `hooks[fieldName]`
 * supplies at call time rather than the fused profile default — the function
 * itself never moves through codegen (no inlining, no source re-emission);
 * it's read off the tree's own `meta` at WRAP time
 * (`apply-validation.ts`'s `createApplyValidation`) and passed in here.
 * `hookFields` is the fragment's OWN static declaration of which field names
 * it expects a hook for — every existing hand-authored `GeneratedEntry`
 * (this package's own runtime tests build these directly, independent of
 * codegen) simply omits both, which is exactly "no hook fields, call `parse`
 * with one argument" — zero behavior change for any pre-existing caller. */
export type GeneratedEntry = {
  parse: (
    value: unknown,
    hooks?: Readonly<Record<string, (w: unknown) => unknown>>,
  ) => { kind: "ok"; value: unknown } | { kind: "err"; errors: unknown[] };
  readonly hookFields?: readonly string[];
};
