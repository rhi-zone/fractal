// packages/http-api-projector/src/__fixtures__/wire-apply-validation-http.fixture.ts
//
// A single 3-arg `applyValidation(key, tree, "http")` call site — the
// query-param-decode-end-to-end fixture used by
// wire-apply-validation.test.ts. A GET leaf with a `page: number` field:
// with no `sourceMap` override, `wire-derive.ts`'s HTTP branch defaults a
// non-path-segment field on a GET/HEAD/DELETE leaf to the `query` store's
// `queryProfile`-style encoding — a numeric-string query value ("3") should
// decode to the number 3 before the handler ever sees it.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "@rhi-zone/fractal-api-tree/node"
import { createApplyValidation } from "@rhi-zone/fractal-api-tree/apply-validation"

// Stands in for a consumer's pre-codegen generated module (see api-tree's
// `apply-validation-stub.fixture.ts`) — the call-site scan's brand-based
// resolution needs to see `applyValidation` reached through this same kind
// of re-export hop.
const applyValidation = createApplyValidation({})

export const booksTree = api({
  list: op(
    (input: { page: number }) => ({ page: input.page, doubled: input.page * 2 }),
    { http: { method: "GET" } },
  ),
})

export const books = applyValidation("wire-books", booksTree, "http")
