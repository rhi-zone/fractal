// packages/api-tree/src/typed-client.test.ts — TypedClient<N> type-level checks
//
// TypedClient<N, CallOpts> is a pure type — no runtime constructor lives in
// this package (a remote client needs a transport, which is a projector
// concern; see packages/http-api-projector/src/client.ts's `createClient`
// for the HTTP instantiation). These tests exercise the type only, via
// `expectTypeOf`, mirroring direct.test.ts's "DirectApi type safety" block
// for its in-process counterpart.

import { describe, expectTypeOf, it } from "bun:test"
import { api, op } from "./node.ts"
import type { TypedClient } from "./typed-client.ts"

// A stand-in per-call options type, exercising the CallOpts parameter the
// way a projector (e.g. http-api-projector's CallOptions) would.
type TestCallOpts = { readonly timeout?: number }

describe("TypedClient type safety", () => {
  it("a simple leaf's callable type matches the handler's input/output, plus an optional CallOpts second arg", () => {
    const tree = api({ ping: op((input: { n: number }) => input.n * 2) })
    type Client = TypedClient<typeof tree, TestCallOpts>
    expectTypeOf<Client["ping"]>().toEqualTypeOf<
      (input: { n: number }, opts?: TestCallOpts) => Promise<number>
    >()
  })

  it("a no-input leaf's input argument is optional, CallOpts still reachable as the second arg", () => {
    const tree = api({ hello: op(() => "hi") })
    type Client = TypedClient<typeof tree, TestCallOpts>
    expectTypeOf<Client["hello"]>().toEqualTypeOf<
      (input?: undefined, opts?: TestCallOpts) => Promise<string>
    >()
  })

  it("with no CallOpts supplied, TypedClient<N> defaults to never — opts can only be omitted", () => {
    const tree = api({ hello: op(() => "hi") })
    type Client = TypedClient<typeof tree>
    expectTypeOf<Client["hello"]>().toEqualTypeOf<
      (input?: undefined, opts?: never) => Promise<string>
    >()
  })

  it("a nested branch carries the leaf's typed callable through, recursively", () => {
    const tree = api({
      books: api({
        list: op(() => ["a", "b"]),
      }),
    })
    type Client = TypedClient<typeof tree, TestCallOpts>
    expectTypeOf<Client["books"]["list"]>().toEqualTypeOf<
      (input?: undefined, opts?: TestCallOpts) => Promise<string[]>
    >()
  })

  it("an async handler's return type is Promise<T>, not Promise<Promise<T>>", () => {
    const tree = api({
      fetchThing: op(async (input: { id: string }): Promise<{ id: string }> => {
        await Promise.resolve()
        return { id: input.id }
      }),
    })
    type Client = TypedClient<typeof tree, TestCallOpts>
    expectTypeOf<Client["fetchThing"]>().toEqualTypeOf<
      (input: { id: string }, opts?: TestCallOpts) => Promise<{ id: string }>
    >()
  })

  it("a fallback becomes a (slugValue) => TypedClient<subtree> function, and subtracts the slug from descendant input", () => {
    const bookItem = api({
      read: op((input: { bookId: string }) => ({ id: input.bookId, title: "Dune" })),
    })
    const tree = api({}, { fallback: { name: "bookId", subtree: bookItem } })
    type Client = TypedClient<typeof tree, TestCallOpts>

    expectTypeOf<Client["bookId"]>().toEqualTypeOf<
      (slugValue: string) => TypedClient<typeof bookItem, TestCallOpts, "bookId">
    >()
    // bookId is slug-subtracted from the read leaf's input — no input arg needed
    type Sub = ReturnType<Client["bookId"]>
    expectTypeOf<Sub["read"]>().toEqualTypeOf<
      (input?: undefined, opts?: TestCallOpts) => Promise<{ id: string; title: string }>
    >()
  })

  it("nested fallbacks accumulate multiple slug names, subtracting all of them from the leaf", () => {
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
    type Client = TypedClient<typeof tree, TestCallOpts>
    type AfterBookId = ReturnType<Client["bookId"]>
    type AfterChapterId = ReturnType<AfterBookId["chapterId"]>
    expectTypeOf<AfterChapterId["read"]>().toEqualTypeOf<
      (input?: undefined, opts?: TestCallOpts) => Promise<{ bookId: string; chapterId: string }>
    >()
  })

  it("a branch can carry both static children and a fallback — both surface on the same client shape", () => {
    const tree = api(
      { list: op(() => ["a", "b"]) },
      {
        fallback: {
          name: "itemId",
          subtree: api({ read: op((input: { itemId: string }) => input) }),
        },
      },
    )
    type Client = TypedClient<typeof tree, TestCallOpts>
    expectTypeOf<Client["list"]>().toEqualTypeOf<
      (input?: undefined, opts?: TestCallOpts) => Promise<string[]>
    >()
    type Sub = ReturnType<Client["itemId"]>
    expectTypeOf<Sub["read"]>().toEqualTypeOf<
      (input?: undefined, opts?: TestCallOpts) => Promise<{ itemId: string }>
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
    type Client = TypedClient<typeof tree, TestCallOpts>
    expectTypeOf<Client["root"]>().toEqualTypeOf<
      ((input: { n: number }, opts?: TestCallOpts) => Promise<number>) & {
        readonly double: (input: { n: number }, opts?: TestCallOpts) => Promise<number>
      }
    >()
  })
})
