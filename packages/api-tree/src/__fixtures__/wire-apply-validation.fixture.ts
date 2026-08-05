// packages/api-tree/src/__fixtures__/wire-apply-validation.fixture.ts
//
// 3-arg `applyValidation(key, tree, protocol)` call sites — one per protocol
// under test (http, cli, mcp), plus a variant exercising an explicit HTTP
// `sourceMap` override — over independent trees, each with a `bookId`
// path-param field plus a `page` number field, so the http/cli composite
// per-field derivation (path-segment-name default, method-derived primary
// store, explicit override) has something real to exercise, and so decode
// behavior for the SAME shape of leaf can be compared across protocols
// (query/argv coerce a numeric STRING; json/identity do not).
//
// Not a test file (no `.test.ts`), so bun test skips it.

import "./wire-apply-validation-meta.fixture.ts"
import { api, op } from "../node.ts"
import { applyValidation } from "./apply-validation-stub.fixture.ts"

const httpTree = api({
  byId: api({}, {
    fallback: {
      name: "bookId",
      subtree: op(
        (input: { bookId: string; page: number }) => ({ bookId: input.bookId, page: input.page }),
        { http: { method: "GET" } },
      ),
    },
  }),
})

const httpOverrideTree = api({
  byId: api({}, {
    fallback: {
      name: "bookId",
      subtree: op(
        (input: { bookId: string; page: number }) => ({ bookId: input.bookId, page: input.page }),
        { http: { method: "GET", sourceMap: { page: { store: "body", key: "page" } } } },
      ),
    },
  }),
})

const cliTree = api({
  byId: api({}, {
    fallback: {
      name: "bookId",
      subtree: op((input: { bookId: string; page: number }) => ({ bookId: input.bookId, page: input.page })),
    },
  }),
})

const mcpTree = api({
  get: op((input: { count: number }) => ({ count: input.count })),
})

export const http = applyValidation("wire-http", httpTree, "http")
export const httpOverride = applyValidation("wire-http-override", httpOverrideTree, "http")
export const cli = applyValidation("wire-cli", cliTree, "cli")
export const mcp = applyValidation("wire-mcp", mcpTree, "mcp")
