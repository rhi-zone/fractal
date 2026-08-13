// Two `applyValidation` call sites claiming the same literal key over two
// different trees — a codegen error (last-wins would silently apply one
// tree's validators to the other tree's leaves). See
// `findApplyValidationCallSites`' duplicate-key check.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../node.ts";
import { applyValidation } from "./apply-validation-stub.fixture.ts";

const first = api({
  list: op((_input: { limit?: number }) => ({ items: [] as string[] })),
});

const second = api({
  create: op((_input: { name: string }) => ({ id: "x1" })),
});

export const a = applyValidation("shared", first);
export const b = applyValidation("shared", second);
