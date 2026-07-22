// packages/api-tree/src/tree-manifest.test.ts — TreeManifest<N> type-level checks
//
// TreeManifest<N> is a pure type (no runtime constructor — flattening a
// tree TYPE into a path map is entirely a compile-time computation; a
// runtime walk that mirrors this shape belongs to whichever consumer wants
// one, e.g. a doc generator). These tests exercise the type only, via
// `expectTypeOf`, mirroring typed-client.test.ts's own pattern for its
// nested-shape counterpart.

import { describe, expectTypeOf, it } from "bun:test"
import { api, op } from "./node.ts"
import type { TreeManifest } from "./tree-manifest.ts"

describe("TreeManifest type safety", () => {
  it("a simple leaf's entry is keyed at its own name, input/output taken from the handler", () => {
    const tree = api({ ping: op((input: { n: number }) => input.n * 2) })
    type Manifest = TreeManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly ping: { readonly input: { n: number }; readonly output: number }
    }>()
  })

  it("a nested branch's leaf is keyed by its full dot-separated path", () => {
    const tree = api({
      books: api({
        list: op((_input: { limit?: number }) => [{ id: "1", title: "Dune" }]),
      }),
    })
    type Manifest = TreeManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "books.list": {
        readonly input: { limit?: number }
        readonly output: { id: string; title: string }[]
      }
    }>()
  })

  it("multiple leaves across different branches all appear as sibling keys", () => {
    const tree = api({
      books: api({
        list: op((_input: { limit?: number }) => [{ id: "1" }]),
        create: op((input: { title: string }) => ({ id: "1", title: input.title })),
      }),
      health: op(() => "ok" as const),
    })
    type Manifest = TreeManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "books.list": { readonly input: { limit?: number }; readonly output: { id: string }[] }
      readonly "books.create": {
        readonly input: { title: string }
        readonly output: { id: string; title: string }
      }
      readonly health: { readonly input: unknown; readonly output: "ok" }
    }>()
  })

  it("an async handler's output is Awaited, not Promise-wrapped", () => {
    const tree = api({
      fetchThing: op(async (input: { id: string }): Promise<{ id: string }> => {
        await Promise.resolve()
        return { id: input.id }
      }),
    })
    type Manifest = TreeManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly fetchThing: { readonly input: { id: string }; readonly output: { id: string } }
    }>()
  })

  it("a fallback segment appears by its authored name, same as an ordinary child key", () => {
    const bookItem = api({
      read: op((input: { bookId: string }) => ({ id: input.bookId, title: "Dune" })),
    })
    const tree = api({
      books: api({}, { fallback: { name: "bookId", subtree: bookItem } }),
    })
    type Manifest = TreeManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "books.bookId.read": {
        readonly input: { bookId: string }
        readonly output: { id: string; title: string }
      }
    }>()
  })

  it("nested fallbacks accumulate a full dot path through each authored slug name", () => {
    const tree = api({}, {
      fallback: {
        name: "bookId",
        subtree: api({}, {
          fallback: {
            name: "chapterId",
            subtree: api({
              read: op((input: { bookId: string; chapterId: string }) => input),
            }),
          },
        }),
      },
    })
    type Manifest = TreeManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly "bookId.chapterId.read": {
        readonly input: { bookId: string; chapterId: string }
        readonly output: { bookId: string; chapterId: string }
      }
    }>()
  })

  it("a branch can carry both static children and a fallback — both contribute entries", () => {
    const tree = api(
      { list: op(() => ["a", "b"]) },
      {
        fallback: {
          name: "itemId",
          subtree: api({ read: op((input: { itemId: string }) => input) }),
        },
      },
    )
    type Manifest = TreeManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly list: { readonly input: unknown; readonly output: string[] }
      readonly "itemId.read": {
        readonly input: { itemId: string }
        readonly output: { itemId: string }
      }
    }>()
  })

  it("a node with both a handler and children contributes its own leaf entry AND its children's", () => {
    const tree = api({
      root: {
        handler: (input: { n: number }) => input.n + 1,
        children: {
          double: op((input: { n: number }) => input.n * 2),
        },
        meta: {},
      },
    })
    type Manifest = TreeManifest<typeof tree>
    expectTypeOf<Manifest>().toEqualTypeOf<{
      readonly root: { readonly input: { n: number }; readonly output: number }
      readonly "root.double": { readonly input: { n: number }; readonly output: number }
    }>()
  })
})
