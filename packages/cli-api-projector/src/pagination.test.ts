// packages/cli-api-projector/src/pagination.test.ts — page-shaped (`CursorPage`/
// `OffsetPage`, see `@rhi-zone/fractal-api-tree/page`) handler support in the
// CLI projector.
//
// Covers: a page-shaped result is detected structurally (`isPageShape`, same
// "conventions over contracts" split streaming's `isAsyncIterable` uses) —
// `--all-pages` walks every following page in-process, writing every item as
// a JSONL line as each page is fetched; without the flag, the current page
// prints unchanged through the normal output path, plus a stderr hint when
// there's a next page. Mirrors http-api-projector's client-side `pagination()`
// extension (extensions/pagination.ts) — same cursor/offset algebra, applied
// to a direct handler call instead of a re-issued `fetch`.

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import type { CursorPage, OffsetPage } from "@rhi-zone/fractal-api-tree"
import { runCli } from "./cli.ts"

function makeIO() {
  const writes: Array<{ stream: "out" | "err"; text: string }> = []
  return {
    writes,
    out: () => writes.filter((w) => w.stream === "out").map((w) => w.text).join(""),
    err: () => writes.filter((w) => w.stream === "err").map((w) => w.text).join(""),
    io: {
      stdout: { write: (s: string) => { writes.push({ stream: "out", text: s }) } },
      stderr: { write: (s: string) => { writes.push({ stream: "err", text: s }) } },
      confirm: async () => true,
    },
  }
}

const ITEMS = Array.from({ length: 5 }, (_, i) => ({ id: i }))

function cursorList(input: { readonly cursor?: string }): CursorPage<{ id: number }> {
  const start = input.cursor !== undefined ? Number(input.cursor) : 0
  const page = ITEMS.slice(start, start + 2)
  const nextStart = start + page.length
  const hasMore = nextStart < ITEMS.length
  return { items: page, hasMore, ...(hasMore ? { cursor: String(nextStart) } : {}) }
}

function offsetList(input: { readonly offset?: number }): OffsetPage<{ id: number }> {
  const offset = input.offset !== undefined ? Number(input.offset) : 0
  const page = ITEMS.slice(offset, offset + 2)
  return { items: page, offset, total: ITEMS.length, hasMore: offset + page.length < ITEMS.length }
}

describe("CLI pagination — page-shaped handlers", () => {
  it("without --all-pages, prints the current page unchanged (pretty JSON)", async () => {
    const tree = api_({ list: op(cursorList, {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["list"], io)
    expect(JSON.parse(out())).toEqual({ items: [{ id: 0 }, { id: 1 }], hasMore: true, cursor: "2" })
  })

  it("writes a stderr hint with the cursor flag when there is a next page", async () => {
    const tree = api_({ list: op(cursorList, {}) })
    const { err, io } = makeIO()
    await runCli(tree, ["list"], io)
    expect(err()).toContain("--cursor 2")
    expect(err()).toContain("--all-pages")
  })

  it("writes an offset hint for an OffsetPage", async () => {
    const tree = api_({ list: op(offsetList, {}) })
    const { err, io } = makeIO()
    await runCli(tree, ["list"], io)
    expect(err()).toContain("--offset 2")
  })

  it("omits the hint once hasMore is false (last page)", async () => {
    const tree = api_({ list: op(cursorList, {}) })
    const { err, io } = makeIO()
    await runCli(tree, ["list", "--cursor", "4"], io)
    expect(err()).toBe("")
  })

  it("--jsonl on a page-shaped result streams items only, dropping the pagination envelope", async () => {
    const tree = api_({ list: op(cursorList, {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["list", "--jsonl"], io)
    expect(out()).toBe(JSON.stringify({ id: 0 }) + "\n" + JSON.stringify({ id: 1 }) + "\n")
  })

  it("--all-pages walks every page, writing every item as JSONL", async () => {
    const tree = api_({ list: op(cursorList, {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["list", "--all-pages"], io)
    expect(out()).toBe(ITEMS.map((item) => JSON.stringify(item) + "\n").join(""))
  })

  it("--all-pages walks an OffsetPage the same way", async () => {
    const tree = api_({ list: op(offsetList, {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["list", "--all-pages"], io)
    expect(out()).toBe(ITEMS.map((item) => JSON.stringify(item) + "\n").join(""))
  })

  it("--all-pages starting mid-sequence (an explicit --cursor) only walks the remaining pages", async () => {
    const tree = api_({ list: op(cursorList, {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["list", "--cursor", "2", "--all-pages"], io)
    expect(out()).toBe(ITEMS.slice(2).map((item) => JSON.stringify(item) + "\n").join(""))
  })

  it("respects meta.cli.paginated's inputCursorParam override", async () => {
    function customCursorList(input: { readonly after?: string }): CursorPage<{ id: number }> {
      return cursorList(input.after !== undefined ? { cursor: input.after } : {})
    }
    const tree = api_({
      list: op(customCursorList, { cli: { paginated: { inputCursorParam: "after" } } }),
    })
    const { out, io } = makeIO()
    await runCli(tree, ["list", "--all-pages"], io)
    expect(out()).toBe(ITEMS.map((item) => JSON.stringify(item) + "\n").join(""))
  })

  it("non-page-shaped returns are unaffected — plain object/array output unchanged", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x }), {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["echo", "--x", "1"], io)
    expect(JSON.parse(out())).toEqual({ got: "1" })
  })
})
