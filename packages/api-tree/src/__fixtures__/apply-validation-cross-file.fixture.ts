// packages/api-tree/src/__fixtures__/apply-validation-cross-file.fixture.ts
//
// A call site whose tree argument is an already-PROJECTED value declared in
// ANOTHER file — nothing in this file's AST leads back to an `api()` Node
// tree, and same-file resolution is this phase's deliberate first cut. Codegen
// must fail LOUDLY here rather than silently emit a module missing this key.
//
// (An imported `Node` tree, by contrast, needs no tracing at all: the
// identifier's own TYPE is already the tree, which is everything the leaf
// extraction reads — see `traceNodeType`'s first form.)
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { applyValidation } from "./apply-validation-stub.fixture.ts";
import { projectedElsewhere } from "./apply-validation-projected.fixture.ts";

export const elsewhere = applyValidation("elsewhere", projectedElsewhere);
