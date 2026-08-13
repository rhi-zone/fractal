// Wraps sharing-input.fixture.ts's exported `tree` in a single 2-arg
// `applyValidation` call site — the call-site-anchored fixture for the
// shouldShare/defs structural-sharing regression coverage, exercised through
// `buildWireApplyValidationModuleSource`. Every `applyValidation` call site,
// 2-arg included, compiles through the wire-profile pipeline, with an
// omitted protocol resolving to `"identity"`.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { applyValidation } from "./apply-validation-stub.fixture.ts";
import { tree } from "./sharing-input.fixture.ts";

export const validated = applyValidation("tree", tree);
