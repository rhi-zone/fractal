// packages/api-tree/src/__fixtures__/apply-validation-sharing-input.fixture.ts
//
// Wraps sharing-input.fixture.ts's exported `tree` in a single
// `applyValidation` call site, so the shouldShare/defs structural-sharing
// regression build.test.ts used to assert against `buildValidatorModuleSource`
// (build.ts, deleted phase 3) has an equivalent call-site-anchored fixture to
// exercise against `buildApplyValidationModuleSource` instead.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { applyValidation } from "./apply-validation-stub.fixture.ts"
import { tree } from "./sharing-input.fixture.ts"

export const validated = applyValidation("tree", tree)
