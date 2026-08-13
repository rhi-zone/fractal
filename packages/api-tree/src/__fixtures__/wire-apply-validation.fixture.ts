// 3-arg `applyValidation(key, tree, protocol)` call sites — one per protocol
// under test (http, cli, mcp, graphql, jsonrpc), plus a variant exercising an
// explicit HTTP `sourceMap` override and a variant exercising `encodingMap`'s
// STRING form alongside its FUNCTION form on the same leaf (see
// `httpEncodingMapTree` below) — over independent trees, each with a
// `bookId` path-param field plus a `page` number field, so the http/cli
// composite per-field derivation (path-segment-name default, method-derived
// primary store, explicit override) has something real to exercise, and so
// decode behavior for the SAME shape of leaf can be compared across
// protocols (query/argv coerce a numeric STRING; json/identity do not).
//
// mcp/graphql/jsonrpc all resolve to the SAME uniform `jsonProfile` (see
// wire-derive.ts) — the graphql/jsonrpc trees here are STRUCTURALLY IDENTICAL
// to mcpTree (same leaf shape, same protocol-blind derivation), which is
// exactly what lets docs/design/wire-profiles-and-staged-validation.md's
// "Implementation trace (phase B)" decision 1 hold: two protocols that
// resolve to the same base profile can share one key/call if the tree
// itself is one tree for both.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import "./wire-apply-validation-meta.fixture.ts";
import { api, op } from "../node.ts";
import { applyValidation } from "./apply-validation-stub.fixture.ts";

const httpTree = api({
  byId: api(
    {},
    {
      fallback: {
        name: "bookId",
        subtree: op(
          (input: { bookId: string; page: number }) => ({ bookId: input.bookId, page: input.page }),
          { http: { method: "GET" } },
        ),
      },
    },
  ),
});

const httpOverrideTree = api({
  byId: api(
    {},
    {
      fallback: {
        name: "bookId",
        subtree: op(
          (input: { bookId: string; page: number }) => ({ bookId: input.bookId, page: input.page }),
          { http: { method: "GET", sourceMap: { page: { store: "body", key: "page" } } } },
        ),
      },
    },
  ),
});

const cliTree = api({
  byId: api(
    {},
    {
      fallback: {
        name: "bookId",
        subtree: op((input: { bookId: string; page: number }) => ({
          bookId: input.bookId,
          page: input.page,
        })),
      },
    },
  ),
});

// `encodingMap` STRING form (base-profile-name override, phase B) plus its
// FUNCTION form (custom decoder, phase E) on the SAME leaf, over two
// DIFFERENT fields — `price` names a base profile outright ("identity",
// overriding away from GET's derived `queryProfile`, which would otherwise
// coerce a numeric string); `qty` gets a custom decoder function instead
// (still under the query-store default, so its own param type is
// `WireOf<number,"query">` = `string`). `bookId` gets no `encodingMap`
// entry at all, so it still resolves through the ordinary path-segment-name
// derivation, unaffected by either override.
const httpEncodingMapTree = api({
  byId: api(
    {},
    {
      fallback: {
        name: "bookId",
        subtree: op(
          (input: { bookId: string; price: number; qty: number }) => ({
            bookId: input.bookId,
            price: input.price,
            qty: input.qty,
          }),
          {
            http: {
              method: "GET",
              encodingMap: {
                price: "identity",
                qty: (w: string): number => Number(w) * 2,
              },
            },
          },
        ),
      },
    },
  ),
});

const mcpTree = api({
  get: op((input: { count: number }) => ({ count: input.count })),
});

const graphqlTree = api({
  get: op((input: { count: number }) => ({ count: input.count })),
});

const jsonrpcTree = api({
  get: op((input: { count: number }) => ({ count: input.count })),
});

export const http = applyValidation("wire-http", httpTree, "http");
export const httpOverride = applyValidation("wire-http-override", httpOverrideTree, "http");
export const httpEncodingMap = applyValidation(
  "wire-http-encoding-map",
  httpEncodingMapTree,
  "http",
);
export const cli = applyValidation("wire-cli", cliTree, "cli");
export const mcp = applyValidation("wire-mcp", mcpTree, "mcp");
export const graphql = applyValidation("wire-graphql", graphqlTree, "graphql");
export const jsonrpc = applyValidation("wire-jsonrpc", jsonrpcTree, "jsonrpc");
