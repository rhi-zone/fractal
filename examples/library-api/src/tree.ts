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
// Per-book subtree (will be mounted under books/{bookId} via ParamNode)
// ============================================================================

const bookItemNode = node({
  children: {
    /** Get a single book by its ID. */
    details: op(
      (input: { bookId: string }) => {
        const book = store.get(input.bookId)
        if (book === undefined) throw new Error(`Not Found: ${input.bookId}`)
        return book
      },
      { tags: { readOnly: true } },
    ),

    /** Update book metadata. Idempotent — repeated updates with the same fields converge. */
    update: op(
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

    /** Permanently delete a book from the library. Destructive and irreversible. */
    remove: op(
      (_: { bookId: string }) => ({ deleted: store.delete(_.bookId) }),
      { tags: { destructive: true, idempotent: true } },
    ),
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
  },
})
