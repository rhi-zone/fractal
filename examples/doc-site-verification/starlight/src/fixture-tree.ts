// Identical shape to the Docusaurus site's own src/fixture-tree.ts (same
// header rationale applies — single source of truth shared by generate.ts
// and this site's live wiring). Duplicated rather than imported across the
// two site directories: each site is an independent, non-bun-workspace npm
// project (examples/doc-site-verification/README.md), and there is no
// shared-source import path between them that wouldn't reintroduce the
// file:/workspace-resolution complexity each site's own package.json
// already carries for the real workspace packages.

import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { http } from "@rhi-zone/fractal-http-api-projector/verbs";

export type Book = {
  readonly id: string;
  readonly title: string;
  readonly author: string;
};

const store = new Map<string, Book>([
  ["book-1", { id: "book-1", title: "Dune", author: "Frank Herbert" }],
]);
let seq = 1;

/** Get a single book by ID. GET /books/{bookId} (fallback subtree is a bare leaf — no extra path segment). */
const getBook = op(
  (input: { bookId: string }): Book => {
    const book = store.get(input.bookId);
    if (book === undefined) throw new Error(`Not Found: ${input.bookId}`);
    return book;
  },
  http.get,
  { description: "Get a single book by its ID." },
);

/** Add a new book. POST /books/add */
const addBook = op(
  (input: { title: string; author: string }): Book => {
    const id = `book-${++seq}`;
    const book: Book = { id, ...input };
    store.set(id, book);
    return book;
  },
  http.post,
  { description: "Add a new book to the collection." },
);

export const api = api_({
  books: api_({ add: addBook }, { fallback: { name: "bookId", subtree: getBook } }),
});
