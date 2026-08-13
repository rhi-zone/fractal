// packages/api-tree/src/__fixtures__/apply-validation.fixture.ts
//
// A multi-tree entry file for the CALL-SITE-anchored codegen
// (apply-validation-build.ts): two independent `applyValidation(key, tree)`
// call sites over two different trees, exercising both tracing forms —
//   - `applyValidation("books", booksTree)`: the argument is already the
//     `Node` tree;
//   - `applyValidation("widgets", fakeProjection(widgetsTree))`: the argument
//     is a PROJECTION call that has to be unwrapped one level to find the
//     Node-typed argument.
//
// Name-resolution is exercised in BOTH directions: the real `applyValidation`
// is imported under an ALIAS (`validate`) and must still be found, while a
// local function literally named `applyValidation` — called with a tree — must
// NOT be picked up. The scan resolves the callee by the brand on its TYPE, not
// by name (see `isApplyValidationCallee`).
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../node.ts";
import { applyValidation as validate } from "./apply-validation-stub.fixture.ts";
import { fakeProjection } from "./apply-validation-route.fixture.ts";

export const booksTree = api({
  /** List every book in the catalog. */
  list: op((_input: { limit?: number }) => ({ books: [] as string[] })),
  byId: api(
    {},
    {
      fallback: {
        name: "bookId",
        subtree: op((input: { bookId: string }) => ({ bookId: input.bookId })),
      },
    },
  ),
});

const widgetsTree = api({
  create: op((_input: { name: string; count: number }) => ({ id: "w1" })),
});

export const books = validate("books", booksTree);

export const widgets = validate("widgets", fakeProjection(widgetsTree));

// Decoy — the name the real mechanism usually goes by, on an unrelated local
// function whose type carries no brand. Must never be treated as a call site
// (if it were, key "decoy" would appear in the generated module).
function applyValidation<T>(_key: string, tree: T): T {
  return tree;
}
export const decoyed = applyValidation("decoy", booksTree);
