// examples/doc-site-verification/docusaurus/src/fixture-tree.ts
//
// Shared fixture Node tree — the single source of truth for BOTH:
//   - generate.ts (bun script, run before `npm run build`): projects this
//     tree to an OpenApiDoc and writes real toDocusaurusRouteReference MDX
//     into docs/api/.
//   - src/theme/Root.tsx (this site's live wiring): builds a real
//     `createFetch`/`toDropInFetch` fetch implementation over the SAME tree,
//     so the generated pages' embedded <ApiExplorer/> instances hit a real
//     in-process backend that actually answers with the routes the MDX
//     documents — not two independently-authored trees that happen to look
//     similar.
//
// Deliberately tiny: one GET with a path param (bookId), one POST with a
// request body (title/author) — enough to exercise both
// requestSchema/responseSchema embedding and path-param rendering for real,
// per this fixture's own scope (examples/doc-site-verification's README).
//
// Imported by package name (`@rhi-zone/fractal-api-tree/node`, not a
// repo-relative src path) because, unlike examples/library-api, this site is
// NOT a bun-workspace member (see examples/doc-site-verification/README.md
// for why) — its own package.json's `file:`/`overrides` wiring is what makes
// these package-name imports resolve, against the workspace packages' built
// `dist/` output.

import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"

export type Book = {
  readonly id: string
  readonly title: string
  readonly author: string
}

const store = new Map<string, Book>([["book-1", { id: "book-1", title: "Dune", author: "Frank Herbert" }]])
let seq = 1

/** Get a single book by ID. GET /books/{bookId} (fallback subtree is a bare leaf — no extra path segment). */
const getBook = op(
  (input: { bookId: string }): Book => {
    const book = store.get(input.bookId)
    if (book === undefined) throw new Error(`Not Found: ${input.bookId}`)
    return book
  },
  http.get,
  { description: "Get a single book by its ID." },
)

/** Add a new book. POST /books/add */
const addBook = op(
  (input: { title: string; author: string }): Book => {
    const id = `book-${++seq}`
    const book: Book = { id, ...input }
    store.set(id, book)
    return book
  },
  http.post,
  { description: "Add a new book to the collection." },
)

export const api = api_(
  {
    books: api_({ add: addBook }, { fallback: { name: "bookId", subtree: getBook } }),
  },
)
