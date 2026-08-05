// packages/api-tree/src/__fixtures__/wire-apply-validation-sharing-input.fixture.ts
//
// Wire-path (3-arg `applyValidation(key, tree, protocol)`) sibling of
// apply-validation-sharing-input.fixture.ts — same Address-reuse shape (two
// ops, `setBilling`/`setShipping`, both taking an `Address`-typed field), but
// registered under a 3-arg call site so `extractWireApplyValidationTypeRefs`'s
// `shouldShare` opt-in (phase D) has a fixture to exercise end-to-end. `mcp`
// is the protocol tag: uniform jsonProfile, no per-field derivation, so this
// fixture isolates the defs/sharing behavior from wire-derive.ts's
// http/cli-specific field-profile logic (already covered by
// wire-apply-validation.fixture.ts).
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { applyValidation } from "./apply-validation-stub.fixture.ts"
import { tree } from "./sharing-input.fixture.ts"

export const validated = applyValidation("wire-tree", tree, "mcp")
