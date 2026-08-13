// packages/api-tree/src/__fixtures__/apply-validation-tree.fixture.ts
//
// Wraps tree.fixture.ts's exported `tree` in a single 2-arg `applyValidation`
// call site, so the call-site-anchored codegen (apply-validation-build.ts)
// has something to trace against the SAME extraction edge cases
// tree.fixture.ts exercises (named-type import resolution, builtin/global TS
// type exclusion, a DOM builtin reached through a return type, structural
// sharing via shouldShare) — the regression coverage build.test.ts used to
// assert against the now-deleted `buildValidatorModuleSource` (build.ts,
// phase 3), then ported onto the (also now-deleted, phase D)
// `buildApplyValidationModuleSource`, and now onto
// `buildWireApplyValidationModuleSource` instead — every `applyValidation`
// call site, 2-arg included, compiles through the wire-profile pipeline as of
// phase D, an omitted protocol resolving to `"identity"`. Also doubles as
// cache.test.ts's/cache-v3.test.ts's entry file for exercising cache.ts's
// generic mechanics end-to-end against a real multi-file extraction closure
// (tree.fixture.ts's own imports of result-reexport.fixture.ts/
// deployment-meta.fixture.ts) — cache.ts tracks the whole `ts.Program`'s file
// set by default, so those dependencies are tracked here exactly as they
// were through build.ts's `writeValidatorModuleCached`.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { applyValidation } from "./apply-validation-stub.fixture.ts";
import { tree } from "./tree.fixture.ts";

export const validated = applyValidation("tree", tree);
