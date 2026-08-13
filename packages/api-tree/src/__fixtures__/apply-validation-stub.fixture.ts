// Stands in for a consumer's pre-codegen generated module — exactly what
// `applyValidationStubSource` (apply-validation-build.ts) emits, hand-written
// here so the call-site fixtures beside it import `applyValidation` through
// the same re-export hop a real consumer does (`./generated`), which is what
// the call-site scan's brand-based resolution has to see through.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { createApplyValidation } from "../apply-validation.ts";

export const applyValidation = createApplyValidation({});
