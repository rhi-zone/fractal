// packages/api-tree/src/direct.test.ts — createDirectApi (zero-protocol-overhead projection)

import { describe, expect, expectTypeOf, it } from "bun:test"
import { api, op } from "./node.ts"
import { createDirectApi } from "./direct.ts"
import type { DirectApi } from "./direct.ts"

describe("createDirectApi", () => {
  it("invokes a leaf handler directly, no HTTP involved", async () => {
    const tree = api({ ping: op((input: { n: number }) => input.n * 2) })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.ping).toEqualTypeOf<(input: { n: number }) => Promise<number>>()
    const result = await direct.ping({ n: 21 })
    expect(result).toBe(42)
  })

  it("supports a leaf with no input", async () => {
    const tree = api({ hello: op(() => "hi") })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.hello).toEqualTypeOf<() => Promise<string>>()
    expect(await direct.hello()).toBe("hi")
  })

  it("navigates nested branch nodes", async () => {
    const tree = api({
      books: api({
        list: op(() => ["a", "b"]),
      }),
    })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.books.list).toEqualTypeOf<() => Promise<string[]>>()
    expect(await direct.books.list()).toEqual(["a", "b"])
  })

  it("supports async handlers transparently", async () => {
    const tree = api({ fetchThing: op(async (input: { id: string }): Promise<{ id: string }> => {
      await Promise.resolve()
      return { id: input.id }
    }) })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.fetchThing).toEqualTypeOf<
      (input: { id: string }) => Promise<{ id: string }>
    >()
    expect(await direct.fetchThing({ id: "x" })).toEqual({ id: "x" })
  })

  describe("fallback / wildcard capture", () => {
    it("a fallback becomes a function taking the slug value and returning a sub-api", async () => {
      const store = new Map([["123", { id: "123", title: "Dune" }]])
      const bookItem = api({
        read: op((input: { bookId: string }) => store.get(input.bookId)),
      })
      const tree = api({}, { fallback: { name: "bookId", subtree: bookItem } })
      const direct = createDirectApi(tree)
      expectTypeOf(direct.bookId).toEqualTypeOf<
        (slugValue: string) => DirectApi<typeof bookItem, "bookId">
      >()
      const book = await direct.bookId("123").read()
      expect(book).toEqual({ id: "123", title: "Dune" })
    })

    it("the captured slug value is merged into the handler input under fallback.name", async () => {
      const tree = api({}, {
        fallback: {
          name: "bookId",
          subtree: api({ read: op((input: { bookId: string }) => input) }),
        },
      })
      const direct = createDirectApi(tree)
      expect(await direct.bookId("abc").read()).toEqual({ bookId: "abc" })
    })

    it("explicit call-time input fields win over the accumulated slug on conflict", async () => {
      const tree = api({}, {
        fallback: {
          name: "bookId",
          subtree: api({ read: op((input: { bookId: string }) => input) }),
        },
      })
      const direct = createDirectApi(tree)
      // bookId is slug-subtracted from the type, so the typed signature is
      // `() => Promise<...>`. The runtime still merges explicit fields over
      // slugs (mirrors `assemble`'s path-param precedence), but exercising that override requires
      // escaping the type — this is intentional: the override is an escape
      // hatch, not the normal call pattern.
      const read = direct.bookId("abc").read as (input: { bookId: string }) => Promise<{ bookId: string }>
      expect(await read({ bookId: "override" })).toEqual({
        bookId: "override",
      })
    })

    it("nested fallbacks accumulate multiple slug values", async () => {
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
      const direct = createDirectApi(tree)
      const result = await direct.bookId("b1").chapterId("c1").read()
      expect(result).toEqual({ bookId: "b1", chapterId: "c1" })
    })

    it("a branch can carry both static children and a fallback", async () => {
      const tree = api(
        {
          list: op(() => ["a", "b"]),
        },
        {
          fallback: {
            name: "itemId",
            subtree: api({ read: op((input: { itemId: string }) => input) }),
          },
        },
      )
      const direct = createDirectApi(tree)
      expect(await direct.list()).toEqual(["a", "b"])
      expect(await direct.itemId("x").read()).toEqual({ itemId: "x" })
    })
  })

  it("a node with both a handler and children is callable AND has child properties", async () => {
    const tree = api({
      root: {
        handler: (input: { n: number }) => input.n + 1,
        children: {
          double: op((input: { n: number }) => input.n * 2),
        },
        meta: {},
      },
    })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.root).toEqualTypeOf<
      ((input: { n: number }) => Promise<number>) & {
        readonly double: (input: { n: number }) => Promise<number>
      }
    >()
    expectTypeOf(direct.root.double).toEqualTypeOf<
      (input: { n: number }) => Promise<number>
    >()
    expect(await direct.root({ n: 1 })).toBe(2)
    expect(await direct.root.double({ n: 5 })).toBe(10)
  })

  it("propagates a synchronous handler error to the caller", async () => {
    const tree = api({
      boom: op(() => {
        throw new Error("nope")
      }),
    })
    const direct = createDirectApi(tree)
    await expect(direct.boom()).rejects.toThrow("nope")
  })

  it("propagates a rejected async handler's error to the caller", async () => {
    const tree = api({
      boom: op(async () => {
        throw new Error("async nope")
      }),
    })
    const direct = createDirectApi(tree)
    await expect(direct.boom()).rejects.toThrow("async nope")
  })
})

// ============================================================================
// Integration: a library-api-shaped tree exercising list/add + fallback
// read/replace/remove, mirroring examples/library-api/src/tree.ts's shape
// without pulling in its HTTP meta (createDirectApi is protocol-agnostic —
// it never looks at meta.http).
// ============================================================================

describe("createDirectApi — library-api-shaped integration", () => {
  type Book = { readonly id: string; readonly title: string; readonly author: string }

  function makeLibraryTree() {
    const store = new Map<string, Book>()
    let seq = 0

    const listBooks = op((): Book[] => [...store.values()])
    const addBook = op((input: { title: string; author: string }): Book => {
      const id = `book-${++seq}`
      const book: Book = { id, ...input }
      store.set(id, book)
      return book
    })
    const readBook = op((input: { bookId: string }): Book => {
      const book = store.get(input.bookId)
      if (book === undefined) throw new Error(`Not Found: ${input.bookId}`)
      return book
    })
    const removeBook = op((input: { bookId: string }) => ({ deleted: store.delete(input.bookId) }))

    const bookItem = api({ read: readBook, remove: removeBook })
    const books = api({ list: listBooks, add: addBook }, { fallback: { name: "bookId", subtree: bookItem } })
    return api({ books })
  }

  it("add, list, read, and remove a book through the direct api", async () => {
    const tree = makeLibraryTree()
    const direct = createDirectApi(tree)

    expect(await direct.books.list()).toEqual([])

    const added = (await direct.books.add({ title: "Dune", author: "Herbert" })) as Book
    expect(added.title).toBe("Dune")

    expect(await direct.books.list()).toEqual([added])

    const read = await direct.books.bookId(added.id).read()
    expect(read).toEqual(added)

    const removed = await direct.books.bookId(added.id).remove()
    expect(removed).toEqual({ deleted: true })
    expect(await direct.books.list()).toEqual([])
  })

  it("reading a missing book propagates the handler's error", async () => {
    const tree = makeLibraryTree()
    const direct = createDirectApi(tree)
    await expect(direct.books.bookId("nope").read()).rejects.toThrow("Not Found: nope")
  })
})

// ============================================================================
// Type-level checks: DirectApi<N> computes the fully typed proxy shape from
// the tree's own Node type — no assertions or `as` casts should be needed at
// call sites. These tests never run any code; `expectTypeOf` checks are
// evaluated by the type checker.
// ============================================================================

describe("DirectApi type safety", () => {
  it("a simple leaf's callable type matches the handler's input/output", () => {
    const tree = api({ ping: op((input: { n: number }) => input.n * 2) })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.ping).toEqualTypeOf<(input: { n: number }) => Promise<number>>()
  })

  it("a no-input leaf's callable type takes no arguments", () => {
    const tree = api({ hello: op(() => "hi") })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.hello).toEqualTypeOf<() => Promise<string>>()
  })

  it("a nested branch carries the leaf's typed callable through", () => {
    const tree = api({
      books: api({
        list: op(() => ["a", "b"]),
      }),
    })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.books.list).toEqualTypeOf<() => Promise<string[]>>()
  })

  it("an async handler's return type is Promise<T>, not Promise<Promise<T>>", () => {
    const tree = api({
      fetchThing: op(async (input: { id: string }): Promise<{ id: string }> => {
        await Promise.resolve()
        return { id: input.id }
      }),
    })
    const direct = createDirectApi(tree)
    expectTypeOf(direct.fetchThing).toEqualTypeOf<
      (input: { id: string }) => Promise<{ id: string }>
    >()
  })

  it("a fallback subtracts captured slug fields from handler input", () => {
    const bookItem = api({
      read: op((input: { bookId: string }) => ({ id: input.bookId, title: "Dune" })),
    })
    const tree = api({}, { fallback: { name: "bookId", subtree: bookItem } })
    const direct = createDirectApi(tree)

    expectTypeOf(direct.bookId).toEqualTypeOf<
      (slugValue: string) => DirectApi<typeof bookItem, "bookId">
    >()
    // bookId is subtracted — read takes no input
    expectTypeOf(direct.bookId("x").read).toEqualTypeOf<
      () => Promise<{ id: string; title: string }>
    >()
  })

  it("a node with both a handler and children is callable AND has typed child properties", () => {
    const tree = api({
      root: {
        handler: (input: { n: number }) => input.n + 1,
        children: {
          double: op((input: { n: number }) => input.n * 2),
        },
        meta: {},
      },
    })
    const direct = createDirectApi(tree)

    expectTypeOf(direct.root).toEqualTypeOf<
      ((input: { n: number }) => Promise<number>) & {
        readonly double: (input: { n: number }) => Promise<number>
      }
    >()
    expectTypeOf(direct.root.double).toEqualTypeOf<
      (input: { n: number }) => Promise<number>
    >()
  })
})
