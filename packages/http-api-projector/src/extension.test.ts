// packages/http-api-projector/src/extension.test.ts — @rhi-zone/fractal-http-api-projector
//
// Unit tests for the two composition interpreters (extension.ts):
// `composeFetch` (runtime, wraps functions) and `composeCodegenFetch`
// (codegen, wraps source-text expressions). Per-extension behavior tests
// live in extensions/*.test.ts; this file only tests the composition
// mechanics — order, no-op-on-empty, and helper deduplication.

import { describe, expect, it } from "bun:test"
import { composeCodegenFetch, composeFetch } from "./extension.ts"
import type { ClientExtension, FetchImpl } from "./extension.ts"

describe("composeFetch", () => {
  it("returns the base fetchImpl unchanged when extensions is undefined or empty", () => {
    const base: FetchImpl = async () => new Response("ok")
    expect(composeFetch(base, undefined)).toBe(base)
    expect(composeFetch(base, [])).toBe(base)
  })

  it("skips extensions without a wrapFetch hook", () => {
    const base: FetchImpl = async () => new Response("ok")
    const noHook: ClientExtension = { name: "no-op" }
    expect(composeFetch(base, [noHook])).toBe(base)
  })

  it("composes extensions[0] as the OUTERMOST wrapper", async () => {
    const calls: string[] = []
    const base: FetchImpl = async (req) => {
      calls.push(`base:${req.headers.get("x-order")}`)
      return new Response("ok")
    }
    const tagOuter: ClientExtension = {
      name: "outer",
      wrapFetch: (inner) => async (req) => {
        calls.push("outer:before")
        const tagged = new Request(req, { headers: { "x-order": `${req.headers.get("x-order") ?? ""}outer` } })
        const res = await inner(tagged)
        calls.push("outer:after")
        return res
      },
    }
    const tagInner: ClientExtension = {
      name: "inner",
      wrapFetch: (inner) => async (req) => {
        calls.push("inner:before")
        const tagged = new Request(req, { headers: { "x-order": `${req.headers.get("x-order") ?? ""}-inner` } })
        const res = await inner(tagged)
        calls.push("inner:after")
        return res
      },
    }

    const composed = composeFetch(base, [tagOuter, tagInner])
    await composed(new Request("http://localhost/"))

    // outer wraps inner wraps base: outer runs first and last.
    expect(calls).toEqual(["outer:before", "inner:before", "base:outer-inner", "inner:after", "outer:after"])
  })
})

describe("composeCodegenFetch", () => {
  it("returns the inner expression unchanged, with no helpers, when extensions is undefined or empty", () => {
    expect(composeCodegenFetch("baseExpr", undefined)).toEqual({ expr: "baseExpr", helpers: [] })
    expect(composeCodegenFetch("baseExpr", [])).toEqual({ expr: "baseExpr", helpers: [] })
  })

  it("skips extensions without a codegen hook", () => {
    const runtimeOnly: ClientExtension = { name: "runtime-only", wrapFetch: (inner) => inner }
    expect(composeCodegenFetch("baseExpr", [runtimeOnly])).toEqual({ expr: "baseExpr", helpers: [] })
  })

  it("wraps extensions[0] as the OUTERMOST expression, matching composeFetch's order", () => {
    const outer: ClientExtension = {
      name: "outer",
      codegen: { wrap: (inner) => `outer(${inner})`, helpers: "function outer() {}" },
    }
    const inner: ClientExtension = {
      name: "inner",
      codegen: { wrap: (inner) => `inner(${inner})`, helpers: "function inner() {}" },
    }
    const { expr, helpers } = composeCodegenFetch("base", [outer, inner])
    expect(expr).toBe("outer(inner(base))")
    expect(helpers).toContain("function outer() {}")
    expect(helpers).toContain("function inner() {}")
  })

  it("deduplicates identical helper strings", () => {
    const ext: ClientExtension = {
      name: "dup",
      codegen: { wrap: (inner) => `dup(${inner})`, helpers: "function shared() {}" },
    }
    const { helpers } = composeCodegenFetch("base", [ext, ext])
    expect(helpers).toHaveLength(1)
  })
})
