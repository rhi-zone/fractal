// packages/cli-api-projector/src/als.test.ts — CliOpts.als
//
// Covers: handler runs inside the configured AsyncLocalStorage context,
// `init` receives CLI dispatch context (CliMiddlewareContext), concurrent
// invocations stay isolated, and ALS composes with `opts.middleware` as the
// INNERMOST wrapper (middleware sees the call before/after the ALS-entered
// handler — see `packages/http-api-projector/src/preset.ts`'s sibling `als`
// option for the same contract on HTTP).

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

describe("CliOpts.als", () => {
  it("the handler runs inside the AsyncLocalStorage context set up by init", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" }), {}),
    })
    const { out, io } = makeIO()
    await runCli(tree, ["whoami"], io, { als: { storage, init: () => ({ requestId: "req-1" }) } })
    expect(JSON.parse(out.join(""))).toEqual({ requestId: "req-1" })
  })

  it("init receives CLI dispatch context (meta, leafName, slugs, io)", async () => {
    const storage = new AsyncLocalStorage<{ leafName: string }>()
    let seenLeafName: string | undefined
    let seenDescription: unknown
    const tree = api_({
      echo: op((_: unknown) => ({ ok: true }), { description: "an echo op" }),
    })
    const { io } = makeIO()
    await runCli(tree, ["echo"], io, {
      als: {
        storage,
        init: (context) => {
          seenLeafName = context.leafName
          seenDescription = context.meta.description
          return { leafName: context.leafName }
        },
      },
    })
    expect(seenLeafName).toBe("echo")
    expect(seenDescription).toBe("an echo op")
  })

  it("no ALS configured — handler runs with no store active (undefined)", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" }), {}),
    })
    const { out, io } = makeIO()
    await runCli(tree, ["whoami"], io)
    expect(JSON.parse(out.join(""))).toEqual({ requestId: "none" })
  })

  it("concurrent invocations stay isolated — each sees its own context value", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    const tree = api_({
      whoami: op(async (_: unknown) => {
        // Yield a tick so concurrent runs interleave — proves isolation isn't
        // an artifact of strictly sequential execution.
        await new Promise((r) => setTimeout(r, 0))
        return { requestId: storage.getStore()?.requestId ?? "none" }
      }, {}),
    })

    let counter = 0
    const runs = [1, 2, 3].map(async () => {
      const id = `req-${counter++}`
      const { out, io } = makeIO()
      await runCli(tree, ["whoami"], io, { als: { storage, init: () => ({ requestId: id }) } })
      return { id, out: JSON.parse(out.join("")) as { requestId: string } }
    })

    const results = await Promise.all(runs)
    for (const { id, out } of results) {
      expect(out.requestId).toBe(id)
    }
  })

  it("composes with middleware — ALS wraps only the handler, not middleware's own code", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    let seenBeforeNext: string | undefined
    let seenAfterNext: string | undefined

    const observe: CliMiddleware = (next) => async (input) => {
      // Before calling `next`, ALS hasn't been entered yet — middleware runs
      // OUTSIDE the store (ALS is the innermost wrapper, closer to the
      // handler than middleware — see CliOpts.als).
      seenBeforeNext = storage.getStore()?.requestId
      const result = await next(input)
      // After `next` settles, execution is back outside the store too —
      // Node's AsyncLocalStorage does not propagate back out through an
      // already-settled `await`.
      seenAfterNext = storage.getStore()?.requestId
      return result
    }

    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" }), {}),
    })
    const { out, io } = makeIO()
    await runCli(tree, ["whoami"], io, {
      als: { storage, init: () => ({ requestId: "req-mw" }) },
      middleware: [observe],
    })
    // The handler itself — inside `next` — still saw the store.
    expect(JSON.parse(out.join(""))).toEqual({ requestId: "req-mw" })
    expect(seenBeforeNext).toBeUndefined()
    expect(seenAfterNext).toBeUndefined()
  })
})
