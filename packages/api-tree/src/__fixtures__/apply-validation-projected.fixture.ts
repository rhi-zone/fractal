// packages/api-tree/src/__fixtures__/apply-validation-projected.fixture.ts
//
// A projected route value declared away from any call site — the "declared in
// another file" case `apply-validation-cross-file.fixture.ts` passes to
// `applyValidation`.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../node.ts";
import { fakeProjection, type FakeRoute } from "./apply-validation-route.fixture.ts";

const tree = api({
  list: op((_input: { limit?: number }) => ({ items: [] as string[] })),
});

export const projectedElsewhere: FakeRoute = fakeProjection(tree);
