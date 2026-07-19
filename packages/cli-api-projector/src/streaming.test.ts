// packages/cli-api-projector/src/streaming.test.ts — async-iterable /
// streaming handler support in the CLI projector.
//
// Covers: docs/design/middleware-and-caller-context.md — "Streaming and
// Progress". A handler returning an AsyncIterable is detected structurally
// (Symbol.asyncIterator, same check HTTP's route.ts uses) and streamed
// incrementally: StreamProgress yields go to stderr as human-readable lines,
// StreamChunk yields (and untagged yields) go to stdout as JSONL, and the
// generator's return value is the final stdout JSONL line. Non-async-iterable
// returns are unaffected (backwards compat).

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
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

describe("CLI streaming — async-iterable handlers", () => {
  it("streams untagged yields as JSONL lines to stdout", async () => {
    async function* gen() {
      yield { n: 1 }
      yield { n: 2 }
    }
    const tree = api_({ stream: op((_: unknown) => gen(), {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["stream"], io)
    expect(out()).toBe(
      JSON.stringify({ n: 1 }) + "\n" +
      JSON.stringify({ n: 2 }) + "\n" +
      "null\n",
    )
  })

  it("StreamProgress yields go to stderr as a human-readable line", async () => {
    async function* gen() {
      yield { kind: "progress", progress: 25, message: "Loading..." }
      yield { kind: "progress", progress: 1, total: 4 }
    }
    const tree = api_({ stream: op((_: unknown) => gen(), {}) })
    const { out, err, io } = makeIO()
    await runCli(tree, ["stream"], io)
    expect(err()).toBe("[progress] 25% Loading...\n" + "[progress] 25%\n")
    // No stdout lines for progress-only yields, just the final return line.
    expect(out()).toBe("null\n")
  })

  it("StreamChunk yields are unwrapped and written as JSONL lines to stdout", async () => {
    async function* gen() {
      yield { kind: "chunk", data: { n: 1 } }
      yield { kind: "chunk", data: { n: 2 } }
    }
    const tree = api_({ stream: op((_: unknown) => gen(), {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["stream"], io)
    expect(out()).toBe(
      JSON.stringify({ n: 1 }) + "\n" +
      JSON.stringify({ n: 2 }) + "\n" +
      "null\n",
    )
  })

  it("the generator's return value is written as the final stdout JSONL line", async () => {
    async function* gen() {
      yield { n: 1 }
      return { total: 1, ok: true }
    }
    const tree = api_({ stream: op((_: unknown) => gen(), {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["stream"], io)
    expect(out()).toBe(
      JSON.stringify({ n: 1 }) + "\n" +
      JSON.stringify({ total: 1, ok: true }) + "\n",
    )
  })

  it("a mix of progress, chunk, and untagged yields interleaves correctly across streams", async () => {
    async function* gen() {
      yield { kind: "progress", progress: 50, message: "halfway" }
      yield { kind: "chunk", data: "a" }
      yield "b"
      return "done"
    }
    const tree = api_({ stream: op((_: unknown) => gen(), {}) })
    const { out, err, io } = makeIO()
    await runCli(tree, ["stream"], io)
    expect(err()).toBe("[progress] 50% halfway\n")
    expect(out()).toBe(
      JSON.stringify("a") + "\n" +
      JSON.stringify("b") + "\n" +
      JSON.stringify("done") + "\n",
    )
  })

  it("non-async-iterable returns are unaffected — plain object output unchanged", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x }), {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["echo", "--x", "1"], io)
    expect(JSON.parse(out())).toEqual({ got: "1" })
  })

  it("non-async-iterable array returns still use tags.streaming/--jsonl gating (unchanged)", async () => {
    const tree = api_({
      list: op((_: unknown) => [{ n: 1 }, { n: 2 }], { tags: { streaming: true } }),
    })
    const { out, io } = makeIO()
    await runCli(tree, ["list"], io)
    expect(out()).toBe(JSON.stringify({ n: 1 }) + "\n" + JSON.stringify({ n: 2 }) + "\n")
  })

  it("streams incrementally — each line is written before the next value is produced (push, not buffer-then-emit)", async () => {
    const order: string[] = []
    async function* gen() {
      order.push("before-yield-1")
      yield { n: 1 }
      order.push("after-yield-1")
      yield { n: 2 }
      order.push("after-yield-2")
    }
    const tree = api_({ stream: op((_: unknown) => gen(), {}) })
    const writes: string[] = []
    const io = {
      stdout: {
        write: (s: string) => {
          // Record write order relative to generator progress — if runCli
          // buffered (collected all values before writing any), every
          // "after-yield-N" marker would already be in `order` by the time
          // the FIRST write happens. True incremental streaming means the
          // first write happens right after the first yield, before the
          // generator has produced its second value.
          writes.push(`${s.trim()} | order-so-far=${order.join(",")}`)
        },
      },
      stderr: { write: (_s: string) => {} },
      confirm: async () => true,
    }
    await runCli(tree, ["stream"], io)
    // The first stdout write must happen before "after-yield-2" is recorded —
    // proof the second value wasn't produced (and thus not buffered) before
    // the first was written out.
    expect(writes[0]).toContain(`order-so-far=${["before-yield-1"].join(",")}`)
    expect(writes[0]).not.toContain("after-yield-2")
  })
})
