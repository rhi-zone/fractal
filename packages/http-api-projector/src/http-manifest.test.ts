// packages/http-api-projector/src/http-manifest.test.ts — HttpManifest<N> type-level checks
//
// `HttpManifest<N>` is a pure type (see http-manifest.ts's module doc) —
// these tests exercise the type only, via `expectTypeOf`, mirroring
// `tree-manifest.test.ts`'s own pattern in api-tree for the same reason:
// flattening a tree TYPE into a path/method map is entirely a compile-time
// computation.

import { describe, expectTypeOf, it } from "bun:test"
import { api, op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "./verbs.ts"
import type { HttpManifest } from "./http-manifest.ts"

describe("HttpManifest type safety", () => {
  it("a bare leaf (no method directive) defaults to POST, matching naiveTransform's baseline", () => {
    const tree = api({ ping: op((input: { n: number }) => input.n * 2) })
    type Manifest = HttpManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "/ping": { readonly POST: { readonly input: { n: number }; readonly output: number } }
    }>()
  })

  it("http.get resolves the leaf's literal method from the directive", () => {
    const tree = api({
      books: api({
        list: op((_input: { limit?: number }) => [{ id: "1", title: "Dune" }], http.get),
      }),
    })
    type Manifest = HttpManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "/books/list": {
        readonly GET: {
          readonly input: { limit?: number }
          readonly output: { id: string; title: string }[]
        }
      }
    }>()
  })

  it("distinct verbs across siblings each resolve their own literal method", () => {
    const tree = api({
      books: api({
        list: op((_: unknown): string[] => [], http.get),
        add: op((input: { title: string }): { id: string } => ({ id: "1" }), http.post),
      }),
    })
    type Manifest = HttpManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "/books/list": { readonly GET: { readonly input: unknown; readonly output: string[] } }
      readonly "/books/add": {
        readonly POST: { readonly input: { title: string }; readonly output: { id: string } }
      }
    }>()
  })

  it("a fallback segment appears as `:name`, same convention as naiveTransform/applyMoveTo's wildcard", () => {
    const bookItem = api({
      read: op((input: { bookId: string }) => ({ id: input.bookId }), http.get),
    })
    const tree = api({
      books: api({}, { fallback: { name: "bookId", subtree: bookItem } }),
    })
    type Manifest = HttpManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "/books/:bookId/read": {
        readonly GET: { readonly input: { bookId: string }; readonly output: { id: string } }
      }
    }>()
  })

  it(
    "a leaf carrying moveTo resolves to its runtime (applyMoveTo) path, not its raw authored position",
    () => {
      const bookItem = api({
        read: op((input: { bookId: string }) => ({ id: input.bookId }), http.get, http.moveTo("..")),
      })
      const tree = api({
        books: api({}, { fallback: { name: "bookId", subtree: bookItem } }),
      })
      type Manifest = HttpManifest<typeof tree>
      // "/books/:bookId" — moveTo("..") drops "read", landing at the
      // fallback's own position, matching applyMoveTo's runtime resolution.
      expectTypeOf<Manifest>().toEqualTypeOf<{
        readonly "/books/:bookId": {
          readonly GET: { readonly input: { bookId: string }; readonly output: { id: string } }
        }
      }>()
    },
  )

  it("moveTo(\"../rename\") drops the last segment and appends a new one (sibling rename)", () => {
    const tree = api({
      books: api({
        legacyList: op((_: unknown): string[] => [], http.get, http.moveTo("../list")),
      }),
    })
    type Manifest = HttpManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "/books/list": { readonly GET: { readonly input: unknown; readonly output: string[] } }
    }>()
  })

  it("distinct leaves with moveTo converging on the same target become sibling methods at that path", () => {
    const bookItem = api({
      read: op((input: { bookId: string }) => ({ id: input.bookId }), http.get, http.moveTo("..")),
      remove: op((input: { bookId: string }) => ({ ok: true }), http.delete, http.moveTo("..")),
    })
    const tree = api({
      books: api({}, { fallback: { name: "bookId", subtree: bookItem } }),
    })
    type Manifest = HttpManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "/books/:bookId": {
        readonly GET: { readonly input: { bookId: string }; readonly output: { id: string } }
        readonly DELETE: { readonly input: { bookId: string }; readonly output: { ok: boolean } }
      }
    }>()
  })

  it("an async handler's output is Awaited, not Promise-wrapped", () => {
    const tree = api({
      fetchThing: op(async (input: { id: string }): Promise<{ id: string }> => {
        await Promise.resolve()
        return { id: input.id }
      }, http.get),
    })
    type Manifest = HttpManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "/fetchThing": {
        readonly GET: { readonly input: { id: string }; readonly output: { id: string } }
      }
    }>()
  })
})
