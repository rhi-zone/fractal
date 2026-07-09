// examples/library-api/src/tree.ts
//
// Library API — new-model authoring: both service class and standalone node(),
// param() for per-book routes, meta.tags spanning readOnly/idempotent/destructive,
// and node-level tag inheritance on the catalog subtree.
//
// In the new node model, callables are leaf nodes stored in `children` via
// `op(fn, meta?)`. The `ops` map is gone — a leaf child IS a Node with handler.
// `service()` still works: methods become leaf node children automatically.
//
// This file is also the codegen entry-point: extractToolSchemas walks the
// exported `api` node() call and derives input schemas for inline ops.
// The booksNode is authored via service() (not node()), so codegen skips it —
// its ops degrade to the MCP spec-minimum `{ type: "object" }` placeholder.

import { node, op, param, service } from "@rhi-zone/fractal-core/node"
import { http } from "@rhi-zone/fractal-http/verbs"

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
// Per-book subtree — REST resource via attribute-dispatch
//
// `meta.http.dispatch === "method"` makes all LEAF children co-locate at the
// node's own path (/books/{bookId}), distinguished by HTTP verb derived from
// their tags. Branch children (checkout) still contribute a segment as normal.
//
// read   → readOnly → GET    /books/{bookId}
// replace → idempotent → PUT  /books/{bookId}
// remove  → idempotent+destructive → DELETE /books/{bookId}
// checkout (branch/action) → POST /books/{bookId}/checkout  (segment-dispatch)
// ============================================================================

const bookItemNode = node({
  meta: { http: { dispatch: "method" } },
  children: {
    /** Get a single book by its ID. GET /books/{bookId} */
    read: op(
      (input: { bookId: string }) => {
        const book = store.get(input.bookId)
        if (book === undefined) throw new Error(`Not Found: ${input.bookId}`)
        return book
      },
      { tags: { readOnly: true } },
    ),

    /** Replace book metadata wholesale. Idempotent. PUT /books/{bookId} */
    replace: op(
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
      { tags: { idempotent: true } },
    ),

    /** Permanently delete a book. Destructive and irreversible. DELETE /books/{bookId} */
    remove: op(
      (_: { bookId: string }) => ({ deleted: store.delete(_.bookId) }),
      { tags: { destructive: true, idempotent: true } },
    ),

    /** Checkout action — a named action kept as a segment-child (branch node). */
    checkout: node({
      children: {
        /**
         * Initiate a checkout session for a book reservation.
         * Authored with `http.post` verb helper — bundles POST pin (no implied tags).
         * POST /books/{bookId}/checkout/start
         */
        start: op(
          (input: { bookId: string }) => ({ sessionId: `checkout-${input.bookId}` }),
          http.post,
        ),

        /**
         * Reserve a book for a patron — idempotent (same patron+book = same reservation).
         * Authored with `http.put` verb helper — bundles PUT pin + idempotent:true.
         * The bundled `idempotent` tag flows to MCP (idempotentHint) for free.
         * PUT /books/{bookId}/checkout/reserve
         */
        reserve: op(
          (input: { bookId: string; patronId: string }) => ({
            reservationId: `res-${input.bookId}-${input.patronId}`,
            patronId: input.patronId,
          }),
          http.put,
        ),
      },
    }),
  },
})

// ============================================================================
// BooksService — service class authoring surface
// ============================================================================

class BooksService {
  /**
   * ParamNode field: service() picks up Node/ParamNode instance properties as
   * children, so `byId` becomes children["byId"] in the lowered Node.
   */
  byId = param("bookId", bookItemNode)

  /** List all books in the library. */
  list(_: unknown): Book[] {
    return [...store.values()]
  }

  /** Add a new book to the collection. */
  add(input: { title: string; author: string; genre: string }): Book {
    const id = `book-${++_seq}`
    const book: Book = { id, ...input }
    store.set(id, book)
    return book
  }
}

// ============================================================================
// API root
//
// Exported as `api` so extractToolSchemas (codegen) can walk the node() call.
// The inline `catalog: node({...})` is found by the codegen walker; the
// `books: service(...)` child is not a node() call and is skipped.
// ============================================================================

// ============================================================================
// API version node — header-dispatch demo
//
// `meta.http.dispatch = { by: "header", name: "X-Api-Version" }` makes the
// leaf children distinguish themselves by the X-Api-Version header value.
// Child keyed `v1` matches when the header value is exactly `"v1"`.
// Child keyed `v2` matches when the header value is exactly `"v2"`.
// Both live at the same path (GET /version); no path segment per child.
//
// Both v1 and v2 are readOnly → GET /version. The X-Api-Version header
// selects which child's handler runs.
// ============================================================================

const versionNode = node({
  meta: { http: { dispatch: { by: "header", name: "X-Api-Version" } } },
  children: {
    /** API version 1 response. Dispatched when X-Api-Version: v1. */
    v1: op((_: unknown) => ({ version: "v1", message: "Library API — classic edition" }), {
      tags: { readOnly: true },
    }),

    /**
     * API version 2 response. Dispatched when X-Api-Version: v2.
     * Uses `when` override to demonstrate key≠value: the child key is `v2Alias`
     * but the match value is still `"v2"` (the header value to match).
     */
    v2Alias: op((_: unknown) => ({ version: "v2", message: "Library API — enhanced edition", features: ["pagination", "filtering"] }), {
      tags: { readOnly: true },
      http: { when: "v2" },
    }),
  },
})

export const api = node({
  children: {
    books: service(new BooksService(), {
      meta: {
        list: { tags: { readOnly: true }, description: "List all books in the library." },
        add: { description: "Add a new book to the collection." },
      },
    }),

    // catalog is tagged readOnly at the NODE level — both search and genres
    // inherit readOnly via effectiveTags (closest-wins), without any leaf-level tag.
    catalog: node({
      children: {
        /** Search the library catalog by title or author keyword. */
        search: op((input: { q?: string }) => {
          const q = input.q !== undefined ? input.q.toLowerCase() : undefined
          return [...store.values()].filter(
            (b) =>
              q === undefined ||
              b.title.toLowerCase().includes(q) ||
              b.author.toLowerCase().includes(q),
          )
        }),

        /** List all genres in the catalog, optionally filtered to those starting with a prefix. */
        genres: op((input: { prefix?: string }) => {
          const all = [...new Set([...store.values()].map((b) => b.genre))]
          const { prefix } = input
          return prefix !== undefined ? all.filter((g) => g.startsWith(prefix)) : all
        }),
      },
      // Node-level tag: leaves inherit readOnly → GET routes + readOnlyHint annotations
      meta: { tags: { readOnly: true } },
    }),

    // Header-dispatch demo: X-Api-Version header selects the version handler
    version: versionNode,
  },
})
