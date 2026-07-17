// examples/library-api/src/tree.ts
//
// Library API — new-model authoring on the HttpRoute pipeline (naiveTransform
// + applyMethods/applyMoveTo/applyResponse, see packages/http-api-projector/src/route.ts
// and docs/design/routing-and-transforms.md). Each leaf carries its OWN tags —
// there is no ancestor tag inheritance (removed; see docs/design/router-model.md
// — "Tags"): a node-level tag does not flow down to its descendants.
//
// In the new node model, callables are leaf nodes stored in `children` via
// `op(fn, meta?)`. A node's `fallback` option (shape `{ name, subtree }`)
// captures the wildcard-capture subtree (replaces the former `param()`).
//
// This file is also the codegen entry-point: extractToolSchemas walks the
// exported `api` value's api() call and derives input schemas for inline
// ops, including the `books` subtree below (also authored via api()).

import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"
import { httpProjection } from "@rhi-zone/fractal-http-api-projector/dx"
import { createApplyValidation } from "@rhi-zone/fractal-http-api-projector/route"
import type { Validator, ValidatorMap } from "@rhi-zone/fractal-http-api-projector/route"
import { validators as catalogValidators } from "./generated/validators.ts"

// ============================================================================
// Domain types + in-memory store
// ============================================================================

export type Book = {
  readonly id: string
  readonly title: string
  readonly author: string
  readonly genre: string
}

let _seq = 0
const store = new Map<string, Book>()

/** Reset store and ID sequence between tests. */
export function clearStore(): void {
  store.clear()
  _seq = 0
}

// ============================================================================
// Per-book REST resource — GET/PUT/DELETE co-located at /books/{bookId}
//
// The old model co-located these three leaves via a `meta.http.dispatch =
// {kind:"method"}` marker on their containing node — a feature of the
// retired direct tree-walk dispatcher. The HttpRoute pipeline has no
// dispatch-marker equivalent; the same co-location is expressed instead with
// the `moveTo` rewriter directive (`applyMoveTo`, see route.ts and
// docs/design/routing-and-transforms.md § "Motivating example"): `read`/
// `replace`/`remove` stay nested inside the fallback subtree (alongside
// `checkout` — this is what gives them the `books_bookId_read` etc. MCP/CLI
// names, since those projections read raw tree position with no moveTo
// pass), each with `moveTo: ".."` — go up to the parent position (see the
// path algebra in route.ts: paths resolve relative to the node's own
// position; `..` moves up one level to the parent — the fallback subtree's
// own root). Method assignment is a second, independent directive
// (`{kind:"method"}`, read by `applyMethods`) — `http.get`/`http.put`/
// `http.delete` bundle both the verb and the tags that verb implies.
//
// read   → readOnly              → GET    /books/{bookId}
// replace → idempotent            → PUT    /books/{bookId}
// remove  → idempotent+destructive → DELETE /books/{bookId}
// checkout (branch/action, no placement — stays at its own key) →
//   POST /books/{bookId}/checkout/{start,reserve}
// ============================================================================

/** Get a single book by its ID. GET /books/{bookId} (co-located, no extra segment). */
const readBook = op(
  (input: { bookId: string }) => {
    const book = store.get(input.bookId)
    if (book === undefined) throw new Error(`Not Found: ${input.bookId}`)
    return book
  },
  http.get,
  http.moveTo(".."),
)

/** Replace book metadata wholesale. Idempotent. PUT /books/{bookId}. */
const replaceBook = op(
  (input: { bookId: string; title?: string; author?: string; genre?: string }) => {
    const existing = store.get(input.bookId)
    if (existing === undefined) throw new Error(`Not Found: ${input.bookId}`)
    const updated: Book = {
      id: existing.id,
      title: input.title !== undefined ? input.title : existing.title,
      author: input.author !== undefined ? input.author : existing.author,
      genre: input.genre !== undefined ? input.genre : existing.genre,
    }
    store.set(input.bookId, updated)
    return updated
  },
  http.put,
  http.moveTo(".."),
)

/** Permanently delete a book. Destructive and irreversible. DELETE /books/{bookId}. */
const removeBook = op(
  (input: { bookId: string }) => ({ deleted: store.delete(input.bookId) }),
  http.delete,
  http.moveTo(".."),
)

/**
 * Checkout action subtree — nested directly under the fallback (no
 * placement needed).
 *
 * Initiate a checkout session for a book reservation.
 * Authored with `http.post` verb helper — bundles POST directive (no implied tags).
 * POST /books/{bookId}/checkout/start
 *
 * Reserve a book for a patron — idempotent (same patron+book = same reservation).
 * Authored with `http.put` verb helper — bundles PUT directive + idempotent:true.
 * The bundled `idempotent` tag flows to MCP (idempotentHint) for free.
 * PUT /books/{bookId}/checkout/reserve
 */
const checkoutNode = api_({
    start: op(
      (input: { bookId: string }) => ({ sessionId: `checkout-${input.bookId}` }),
      http.post,
    ),
    reserve: op(
      (input: { bookId: string; patronId: string }) => ({
        reservationId: `res-${input.bookId}-${input.patronId}`,
        patronId: input.patronId,
      }),
      http.put,
    ),
  })

/**
 * The per-book subtree: read/replace/remove co-locate onto their parent
 * position (via each leaf's own `moveTo` directive, read by the HttpRoute
 * pipeline); checkout stays a branch. The `dispatch:{kind:"method"}`
 * node-level marker below is retained meta, NOT interpreted by the HttpRoute
 * pipeline (which reads only `moveTo`/`method` directives) — it's read
 * independently by openapi's and client's own self-contained Node-tree
 * walks (packages/openapi-api-projector/src/index.ts, packages/client-api-projector/src/index.ts),
 * which still derive method-co-location from this marker rather than from
 * `moveTo` directives. Two projectors, two encodings of the same fact.
 */
const bookItemNode = api_({
    read: readBook,
    replace: replaceBook,
    remove: removeBook,
    checkout: checkoutNode,
  }, { meta: { http: { dispatch: { kind: "method" } } } })

// ============================================================================
// Books — list/add ops, plus the per-book fallback subtree
// ============================================================================

/** List all books in the library. GET /books/list */
const listBooks = op(
  (_: unknown): Book[] => [...store.values()],
  http.get,
  { description: "List all books in the library." },
)

/** Add a new book to the collection. POST /books/add */
const addBook = op(
  (input: { title: string; author: string; genre: string }): Book => {
    const id = `book-${++_seq}`
    const book: Book = { id, ...input }
    store.set(id, book)
    return book
  },
  http.post,
  { description: "Add a new book to the collection." },
)

/**
 * Books subtree: `list`/`add` are static children; the per-book fallback
 * (`fallback: { name, subtree }`) captures any other path segment as
 * `bookId` and continues into `bookItemNode` (read/replace/remove/checkout).
 */
const booksNode = api_({
    list: listBooks,
    add: addBook,
  }, { fallback: { name: "bookId", subtree: bookItemNode } })

// ============================================================================
// API root
//
// Exported as `api` so extractToolSchemas (codegen) can walk the api() call.
// Both the inline `catalog: api(...)` and `books: booksNode` (also api()) are
// found by the codegen walker.
//
// A header-dispatch API-versioning demo (`X-Api-Version` selecting a
// response body at `GET /version`) previously lived here, exercising the
// retired direct tree-walk dispatcher's attribute-dispatch feature. The
// HttpRoute pipeline has no attribute-dispatch equivalent yet — reintroducing
// this demo is blocked on that open design question (see TODO.md
// "Attribute dispatch (header/query/contentType) is an open design
// question").
// ============================================================================

export const api = api_({
    books: booksNode,

    // Each leaf carries its OWN readOnly tag — tags do not inherit from the
    // node (removed; see docs/design/router-model.md — "Tags").
    catalog: api_({
        /** Search the library catalog by title or author keyword. */
        search: op((input: { q?: string }) => {
          const q = input.q !== undefined ? input.q.toLowerCase() : undefined
          return [...store.values()].filter(
            (b) =>
              q === undefined ||
              b.title.toLowerCase().includes(q) ||
              b.author.toLowerCase().includes(q),
          )
        }, http.get),

        /** List all genres in the catalog, optionally filtered to those starting with a prefix. */
        genres: op((input: { prefix?: string }) => {
          const all = [...new Set([...store.values()].map((b) => b.genre))]
          const { prefix } = input
          return prefix !== undefined ? all.filter((g) => g.startsWith(prefix)) : all
        }, http.get),
      }),
  })

// ============================================================================
// Validator wiring — createApplyValidation injects the codegen-generated
// `catalog/*` validators (examples/library-api/src/generated/validators.ts,
// produced by `bun run codegen`, see package.json) into the route tree's
// `pipeline.validate` slot. The `books` subtree has no entry in `validatorMap`
// and is untouched: a key not present in the map is a no-op passthrough
// (route.ts's `createApplyValidation` doc comment).
// ============================================================================

// The generated module is a `@ts-nocheck` build artifact (see cli.ts's
// `GENERATED_HEADER`): its inferred type is the TypeBox-compiler's raw
// output shape (`kind: string`, not the `"ok" | "err"` literal union
// `Validator`'s `Result` needs), not `Record<string, Validator>` — cast at
// this import boundary, same as any generated-code consumer would.
const validatorMap: ValidatorMap = { catalog: catalogValidators as Record<string, Validator> }
const applyValidation = createApplyValidation(validatorMap)

// ============================================================================
// HttpRoute projection — the pre-composed pipeline (naiveTransform +
// applyMethods + applyMoveTo + applyResponse, see
// docs/design/routing-and-transforms.md and packages/http-api-projector/src/dx.ts),
// with the generated `catalog/*` validators applied on top. This is the
// actual route tree `createFetch(api)` dispatches against.
// ============================================================================

export const httpRoutes = applyValidation("catalog", httpProjection(api))
