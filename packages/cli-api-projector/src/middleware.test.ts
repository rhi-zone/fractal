// packages/cli-api-projector/src/middleware.test.ts — CliOpts.middleware
//
// Covers: middleware is `F => F` where `F = (input, stores) => result` (see
// docs/design/middleware-and-caller-context.md) — a middleware can read from
// the raw pre-assembly `stores` (flag/path/env), can inspect/transform the
// assembled `input`, the handler itself never receives `stores` (structural,
// not a convention), ALS-based caller context threads through to the
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

  it("middleware can read from stores — flag, path, and env", async () => {
    const tree = api_({
      users: api_({}, {
        fallback: {
          name: "userId",
          subtree: api_({
            profile: op((input: { userId: string; x: string }) => ({ id: input.userId, got: input.x }), {}),
          }),
        },
      }),
    })
    let seenFlagX: unknown
    let seenPathUserId: unknown
    let seenEnvHome: unknown
    const readStores: CliMiddleware = (next) => (input, stores) => {
      seenFlagX = stores.flag?.get("x")
      seenPathUserId = stores.path?.get("userId")
      seenEnvHome = stores.env?.get("HOME")
      return next(input, stores)
    }
    const { out, io } = makeIO()
    await runCli(tree, ["users", "u1", "profile", "--x", "1"], io, { middleware: [readStores] })
    expect(JSON.parse(out.join(""))).toEqual({ id: "u1", got: "1" })
    expect(seenFlagX).toBe("1")
    expect(seenPathUserId).toBe("u1")
    expect(seenEnvHome).toBe(process.env.HOME)
  })

  it("middleware wraps the handler call — can transform input before and output after", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: Number(input.x) }), {}) })
    const doubleInput: CliMiddleware = (next) => (input, stores) =>
      next({ ...input, x: String(Number(input.x) * 2) }, stores)
    const wrapOutput: CliMiddleware = (next) => async (input, stores) => {
      const result = await next(input, stores)
      return { wrapped: result }
    }
    const { out, io } = makeIO()
    await runCli(tree, ["echo", "--x", "5"], io, { middleware: [wrapOutput, doubleInput] })
    expect(JSON.parse(out.join(""))).toEqual({ wrapped: { got: 10 } })
  })

  it("the handler does not receive stores — only the assembled input", async () => {
    // A handler declared with a single `input` parameter has no way to reach
    // `stores` — there is no second parameter to receive it. This proves the
    // base adapter is `(input, _stores) => handler(input)`, not something
    // that leaks `stores` through to the handler.
    const tree = api_({
      whatArgs: op((input: unknown) => ({ argCount: Object.keys(input as object).length }), {}),
    })
    const passStores: CliMiddleware = (next) => (input, stores) => next(input, stores)
    const { out, io } = makeIO()
    await runCli(tree, ["whatArgs", "--x", "1"], io, { middleware: [passStores] })
    expect(JSON.parse(out.join(""))).toEqual({ argCount: 1 })
  })

  it("middleware sets up an AsyncLocalStorage caller-context the handler can read", async () => {
    const als = new AsyncLocalStorage<{ requestedBy: string }>()
    const tree = api_({
      whoami: op((_: unknown) => ({ requestedBy: als.getStore()?.requestedBy ?? "none" }), {}),
    })
    const withAls: CliMiddleware = (next) => (input, stores) =>
      als.run({ requestedBy: String(stores.flag?.get("user") ?? "unknown") }, () => next(input, stores))
    const { out, io } = makeIO()
    await runCli(tree, ["whoami", "--user", "alice"], io, { middleware: [withAls] })
    expect(JSON.parse(out.join(""))).toEqual({ requestedBy: "alice" })
  })

  it("composes multiple middleware — first entry is outermost (sees the call first and last)", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x }), {}) })
    const order: string[] = []
    const outer: CliMiddleware = (next) => async (input, stores) => {
      order.push("outer:before")
      const result = await next(input, stores)
      order.push("outer:after")
      return result
    }
    const inner: CliMiddleware = (next) => async (input, stores) => {
      order.push("inner:before")
      const result = await next(input, stores)
      order.push("inner:after")
      return result
    }
    const { io } = makeIO()
    await runCli(tree, ["echo", "--x", "1"], io, { middleware: [outer, inner] })
    expect(order).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"])
  })
})
