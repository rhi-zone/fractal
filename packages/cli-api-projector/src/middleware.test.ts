// packages/cli-api-projector/src/middleware.test.ts — CliOpts.middleware
//
// Covers: a middleware sees CLI dispatch context, wraps the handler call, can
// modify input/output, ALS-based caller context threads through to the
// handler, and composition order (first entry = outermost wrapper).

import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { runCli } from "./cli.ts"
import type { CliMiddleware } from "./cli.ts"

function makeIO() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      stdout: { write: (s: string) => { out.push(s) } },
      stderr: { write: (s: string) => { err.push(s) } },
      confirm: async () => true,
    },
  }
}

describe("CliOpts.middleware", () => {
  it("with no middleware configured, the handler is called directly", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x }), {}) })
    const { out, io } = makeIO()
    await runCli(tree, ["echo", "--x", "1"], io)
    expect(JSON.parse(out.join(""))).toEqual({ got: "1" })
  })

  it("middleware sees CLI dispatch context (meta, leafName, slugs, io)", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x }), { description: "an echo op" }) })
    let seenLeafName: string | undefined
    let seenDescription: unknown
    let sawIo = false
    const capture: CliMiddleware = (next, context) => {
      seenLeafName = context.leafName
      seenDescription = context.meta.description
      // `runCli` shallow-merges the injected io over defaults (`{ ...defaultIO, ...io }`),
      // so the individual stream objects (not the wrapper) are reference-identical.
      sawIo = context.io.stdout === io.stdout
      return next
    }
    const { io } = makeIO()
    await runCli(tree, ["echo", "--x", "1"], io, { middleware: [capture] })
    expect(seenLeafName).toBe("echo")
    expect(seenDescription).toBe("an echo op")
    expect(sawIo).toBe(true)
  })

  it("middleware wraps the handler call — can transform input before and output after", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: Number(input.x) }), {}) })
    const doubleInput: CliMiddleware = (next) => (input) => next({ ...input, x: String(Number(input.x) * 2) })
    const wrapOutput: CliMiddleware = (next) => async (input) => {
      const result = await next(input)
      return { wrapped: result }
    }
    const { out, io } = makeIO()
    await runCli(tree, ["echo", "--x", "5"], io, { middleware: [wrapOutput, doubleInput] })
    expect(JSON.parse(out.join(""))).toEqual({ wrapped: { got: 10 } })
  })

  it("middleware sets up an AsyncLocalStorage caller-context the handler can read", async () => {
    const als = new AsyncLocalStorage<{ leafName: string }>()
    const tree = api_({
      whoami: op((_: unknown) => ({ leafName: als.getStore()?.leafName ?? "none" }), {}),
    })
    const withAls: CliMiddleware = (next, context) => (input) =>
      als.run({ leafName: context.leafName }, () => next(input))
    const { out, io } = makeIO()
    await runCli(tree, ["whoami"], io, { middleware: [withAls] })
    expect(JSON.parse(out.join(""))).toEqual({ leafName: "whoami" })
  })

  it("composes multiple middleware — first entry is outermost (sees the call first and last)", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x }), {}) })
    const order: string[] = []
    const outer: CliMiddleware = (next) => async (input) => {
      order.push("outer:before")
      const result = await next(input)
      order.push("outer:after")
      return result
    }
    const inner: CliMiddleware = (next) => async (input) => {
      order.push("inner:before")
      const result = await next(input)
      order.push("inner:after")
      return result
    }
    const { io } = makeIO()
    await runCli(tree, ["echo", "--x", "1"], io, { middleware: [outer, inner] })
    expect(order).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"])
  })
})
