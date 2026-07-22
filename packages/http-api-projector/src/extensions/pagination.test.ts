// packages/http-api-projector/src/extensions/pagination.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import { api, op } from "@rhi-zone/fractal-api-tree/node"
import type { CursorPage, OffsetPage } from "@rhi-zone/fractal-api-tree"
import { createClient } from "../client.ts"
import { createFetch } from "../preset.ts"
import { http, paginated } from "../verbs.ts"
import { pagination } from "./pagination.ts"
import type { PageIterator } from "./pagination.ts"

type Item = { readonly id: number }

const ALL_ITEMS: readonly Item[] = Array.from({ length: 25 }, (_, i) => ({ id: i }))

// Query params always arrive as strings over HTTP — `Number(...)` coerces
// explicitly rather than relying on `??`'s pass-through (which would leave a
// numeric-looking string in place and silently string-concatenate below).
function cursorList(input: { readonly limit?: number; readonly cursor?: string }): CursorPage<Item> {
  const limit = input.limit !== undefined ? Number(input.limit) : 10
  const start = input.cursor !== undefined ? Number(input.cursor) : 0
  const page = ALL_ITEMS.slice(start, start + limit)
  const nextStart = start + page.length
  const hasMore = nextStart < ALL_ITEMS.length
  return { items: page, hasMore, ...(hasMore ? { cursor: String(nextStart) } : {}) }
}

function offsetList(input: { readonly limit?: number; readonly offset?: number }): OffsetPage<Item> {
  const limit = input.limit !== undefined ? Number(input.limit) : 10
  const offset = input.offset !== undefined ? Number(input.offset) : 0
  const page = ALL_ITEMS.slice(offset, offset + limit)
  return {
    items: page,
    offset,
    total: ALL_ITEMS.length,
    hasMore: offset + page.length < ALL_ITEMS.length,
  }
}

function customCursorList(input: { readonly limit?: number; readonly after?: string }): CursorPage<Item> {
  return cursorList({
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.after !== undefined ? { cursor: input.after } : {}),
  })
}

function getOne(input: { readonly id: number }): Item {
  const found = ALL_ITEMS.find((i) => i.id === Number(input.id))
  if (!found) throw new Error("not found")
  return found
}

const tree = api({
  items: api({
    listCursor: op(cursorList, http.get),
    listOffset: op(offsetList, http.get),
    listCustom: op(customCursorList, http.get, paginated({ inputCursorParam: "after" })),
    getOne: op(getOne, http.get),
  }),
})

function testClient() {
  const serverFetch = createFetch(tree)
  return createClient(tree, { baseUrl: "http://localhost", fetch: serverFetch, extensions: [pagination()] })
}

describe("pagination() — cursor style", () => {
  it("awaiting the call directly resolves to just the first page (unchanged behavior)", async () => {
    const client = testClient()
    const first = (await client.items.listCursor({ limit: 10 })) as CursorPage<Item>
    expect(first.items).toHaveLength(10)
    expect(first.items[0]).toEqual({ id: 0 })
    expect(first.hasMore).toBe(true)
    expect(first.cursor).toBe("10")
  })

  it("for await walks every item across every page", async () => {
    const client = testClient()
    const seen: Item[] = []
    for await (const item of (await client.items.listCursor({ limit: 10 })) as unknown as PageIterator<CursorPage<Item>>) {
      seen.push(item)
    }
    expect(seen).toHaveLength(25)
    expect(seen.map((i) => i.id)).toEqual(ALL_ITEMS.map((i) => i.id))
  })

  it("getPage() fetches one page at a time, advancing the cursor across calls", async () => {
    const client = testClient()
    const iter = (await client.items.listCursor({ limit: 10 })) as unknown as PageIterator<CursorPage<Item>>
    const page1 = await iter.getPage()
    expect(page1?.items).toHaveLength(10)
    const page2 = await iter.getPage()
    expect(page2?.items).toHaveLength(10)
    expect(page2?.items[0]).toEqual({ id: 10 })
    const page3 = await iter.getPage()
    expect(page3?.items).toHaveLength(5)
    expect(page3?.hasMore).toBe(false)
    const page4 = await iter.getPage()
    expect(page4).toBeUndefined()
  })
})

describe("pagination() — offset style", () => {
  it("for await walks every item across every page using offset/total", async () => {
    const client = testClient()
    const seen: Item[] = []
    for await (const item of (await client.items.listOffset({ limit: 7 })) as unknown as PageIterator<OffsetPage<Item>>) {
      seen.push(item)
    }
    expect(seen).toHaveLength(25)
    expect(seen.map((i) => i.id)).toEqual(ALL_ITEMS.map((i) => i.id))
  })

  it("preserves extra query params (limit) across every follow-up request", async () => {
    const client = testClient()
    let count = 0
    for await (const _item of (await client.items.listOffset({ limit: 3 })) as unknown as PageIterator<OffsetPage<Item>>) {
      count++
    }
    expect(count).toBe(25)
  })
})

describe("pagination() — paginated() directive customization", () => {
  it("honors a custom inputCursorParam name", async () => {
    const client = testClient()
    const seen: Item[] = []
    for await (const item of (await client.items.listCustom({ limit: 10 })) as unknown as PageIterator<CursorPage<Item>>) {
      seen.push(item)
    }
    expect(seen).toHaveLength(25)
  })
})

describe("pagination() — non-paginated endpoints pass through unchanged", () => {
  it("a plain (non-page-shaped) endpoint still resolves normally when awaited", async () => {
    const client = testClient()
    const one = await client.items.getOne({ id: 3 })
    expect(one).toEqual({ id: 3 })
  })

  it("iterating a non-paginated endpoint's result throws (plain objects have no Symbol.asyncIterator)", async () => {
    const client = testClient()
    const result = (await client.items.getOne({ id: 3 })) as unknown as AsyncIterable<unknown>
    await expect(
      (async () => {
        for await (const _x of result) {
          // no-op
        }
      })(),
    ).rejects.toThrow()
  })
})
