// Holds `GeneratedEntry`, the one type shared across every validation
// mechanism and every projector — it is the type-ir compiler's own output
// contract (`compileWireEntryFragment`/`compileConstraintsFn`, `@rhi-zone/
// fractal-type-ir`). Validators are wired onto a tree by the keyed,
// call-site-anchored `applyValidation(key, projectedTree)` mechanism in
// `apply-validation.ts`/`apply-validation-build.ts` — see docs/design/
// routing-and-transforms.md's "Dispatch is not an interceptable multi-stage
// pipeline" section for the history of how validation wiring reached this
// shape.
//
// `apply-validation.ts` re-exports `GeneratedEntry` from here for
// convenience; every projector's `GeneratedEntry` import
// (`@rhi-zone/fractal-api-tree/build`) keeps working unchanged.

/** One generated entry's public shape — see type-ir/compile.ts's
 * `compileWireEntryFragment`/`compileWireEntryFragmentComposite`/
 * `compileConstraintsFn`.
 *
 * `hooks` (second, optional `parse` argument) and `hookFields` are additive —
 * see docs/design/wire-profiles-and-staged-validation.md's implementation-
 * trace addendum for the function-form `encodingMap` phase. A field flagged
 * as hook-covered by a leaf's own `encodingMap` (per-protocol meta, function
 * form) is validated for wire shape by the generated fragment exactly like
 * any other field, but decoded by whatever function `hooks[fieldName]`
 * supplies at call time rather than the fused profile default — the function
 * itself never moves through codegen (no inlining, no source re-emission);
 * it's read off the tree's own `meta` at wrap time
 * (`apply-validation.ts`'s `createApplyValidation`) and passed in here.
 * `hookFields` is the fragment's own static declaration of which field names
 * it expects a hook for. Every hand-authored `GeneratedEntry` (this
 * package's own runtime tests build these directly, independent of codegen)
 * simply omits both, which is exactly "no hook fields, call `parse` with one
 * argument". */
export type GeneratedEntry = {
  parse: (
    value: unknown,
    hooks?: Readonly<Record<string, (w: unknown) => unknown>>,
  ) => { kind: "ok"; value: unknown } | { kind: "err"; errors: unknown[] };
  readonly hookFields?: readonly string[];
};
