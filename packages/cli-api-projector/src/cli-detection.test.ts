// packages/cli-api-projector/src/cli-detection.test.ts — opt-in Result/
// streaming detection config (CliOpts.detection).
//
// Covers: docs/design/middleware-and-caller-context.md's opt-in-detection
// note. Both `detection.result` and `detection.streaming` default to `true`
// — existing behavior — so a handler's Result-shaped return value is
// unwrapped and an async-iterable return value is streamed unless a
// consumer explicitly opts out (because its own data collides with one of
// these shapes).

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

describe("CLI detection — result", () => {
  const tree = api_({ getThing: op((_: unknown) => ({ kind: "ok", value: 42 }), {}) })

  it("defaults (detection omitted): Result-shape output is unwrapped, matching prior behavior", async () => {
    const { out, io } = makeIO()
    await runCli(tree, ["getThing"], io)
    expect(JSON.parse(out())).toEqual(42)
  })

  it("detection.result: false — a Result-shaped return value passes through untouched", async () => {
    const { out, io } = makeIO()
    await runCli(tree, ["getThing"], io, { detection: { result: false } })
    expect(JSON.parse(out())).toEqual({ kind: "ok", value: 42 })
  })
})

describe("CLI detection — streaming", () => {
  async function* gen() {
    yield 1
    yield 2
  }
  const tree = api_({ getStream: op((_: unknown) => gen(), {}) })

  it("defaults (detection omitted): an async-iterable return value streams as JSONL, matching prior behavior", async () => {
    const { out, io } = makeIO()
    await runCli(tree, ["getStream"], io)
    expect(out()).toBe("1\n2\nnull\n")
  })

  it("detection.streaming: false — an async-iterable return value is NOT streamed; treated as a plain value", async () => {
    const { out, io } = makeIO()
    await runCli(tree, ["getStream"], io, { detection: { streaming: false } })
    // Not drained via streamAsyncIterable — falls through to the ordinary
    // pretty-JSON output path, which JSON.stringifies the (async generator)
    // object as a single value rather than one JSONL line per yield.
    expect(out()).not.toBe("1\n2\nnull\n")
    const lines = out().split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
  })
})
