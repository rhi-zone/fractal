// packages/http-framework-projector/src/__fixtures__/express-tree.ts
//
// Schema-extraction fixture for express.test.ts. `extractToolSchemas` walks
// a real SOURCE FILE (TypeScript types, not runtime values) to derive JSON
// Schema for each op's input/output — it can't be pointed at an in-memory
// tree built inside a test function, so this file exists purely to give it
// something to read. Its exported tree's SHAPE (keys, path-param name,
// input/output types) must match `makeStore()` in express.test.ts exactly;
// the two are duplicated rather than shared for the same reason `codegen.ts`
// tests point `extractToolSchemas` at a real file even though the same
// handlers are also imported and run directly.

import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"

export type Book = { readonly id: string; readonly title: string; readonly author: string }

const store = new Map<string, Book>()
let seq = 0

const listBooks = op((input: { readonly author?: string }): Book[] => {
  const all = [...store.values()]
  return input?.author !== undefined ? all.filter((b) => b.author === input.author) : all
}, http.get)

const addBook = op((input: { readonly title: string; readonly author: string }): Book => {
  const id = `book-${++seq}`
  const book: Book = { id, ...input }
  store.set(id, book)
  return book
}, http.post)

const readBook = op((input: { readonly bookId: string }): Book => {
  const book = store.get(input.bookId)
  if (book === undefined) throw new Error(`Not Found: ${input.bookId}`)
  return book
}, http.get, http.moveTo(".."))

const replaceBook = op((input: { readonly bookId: string; readonly title: string; readonly author: string }): Book => {
  const book: Book = { id: input.bookId, title: input.title, author: input.author }
  store.set(input.bookId, book)
  return book
}, http.put, http.moveTo(".."))

const removeBook = op((input: { readonly bookId: string }): { readonly deleted: boolean } => {
  return { deleted: store.delete(input.bookId) }
}, http.delete, http.moveTo(".."))

const bookItemNode = api_({ read: readBook, replace: replaceBook, remove: removeBook })
const booksNode = api_({ list: listBooks, add: addBook }, { fallback: { name: "bookId", subtree: bookItemNode } })

export const api = api_({ books: booksNode })
