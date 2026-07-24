// packages/http-api-projector/src/idempotency.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { applyMethods, makeRouterFromRoute, naiveTransform } from "./route.ts"
import { http } from "./verbs.ts"
import { idempotencyMiddleware, InMemoryIdempotencyStore } from "./idempotency.ts"
import type { IdempotencyStore } from "./idempotency.ts"

function makeCountingTree() {
  let calls = 0
  const tree = api_({
    charge: op(
      (input: { amount: number }) => {
        calls++
        return { charged: input.amount, call: calls }
      },
      http.post,
    ),
  })
  return { tree, calls: () => calls }
}

describe("idempotencyMiddleware", () => {
  it("runs the handler once and caches the result for a repeated key", async () => {
    const { tree, calls } = makeCountingTree()
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [idempotencyMiddleware()])

    const req = () =>
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "Idempotency-Key": "abc-123", "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      })

    const first = await router(req())
    const second = await router(req())

    expect(await first.json()).toEqual({ charged: 100, call: 1 })
    expect(await second.json()).toEqual({ charged: 100, call: 1 }) // cached — handler not called again
    expect(calls()).toBe(1)
  })

  it("runs the handler again for a different key", async () => {
    const { tree, calls } = makeCountingTree()
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [idempotencyMiddleware()])

    await router(
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "Idempotency-Key": "key-1", "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      }),
    )
    await router(
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "Idempotency-Key": "key-2", "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      }),
    )

    expect(calls()).toBe(2)
  })

  it("runs the handler every time when no key header is present", async () => {
    const { tree, calls } = makeCountingTree()
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [idempotencyMiddleware()])

    const req = () =>
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      })

    await router(req())
    await router(req())

    expect(calls()).toBe(2)
  })

  it("is case-insensitive on the header name", async () => {
    const { tree, calls } = makeCountingTree()
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [idempotencyMiddleware()])

    await router(
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "IDEMPOTENCY-KEY": "abc", "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      }),
    )
    await router(
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "idempotency-key": "abc", "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      }),
    )

    expect(calls()).toBe(1)
  })

  it("honors a custom header name", async () => {
    const { tree, calls } = makeCountingTree()
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [
      idempotencyMiddleware({ header: "X-Request-Id" }),
    ])

    const req = () =>
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "X-Request-Id": "abc", "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      })

    await router(req())
    await router(req())

    expect(calls()).toBe(1)
  })

  it("uses a caller-supplied store", async () => {
    const { tree, calls } = makeCountingTree()
    const store = new InMemoryIdempotencyStore()
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [idempotencyMiddleware({ store })])

    const req = () =>
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "Idempotency-Key": "abc", "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      })

    await router(req())
    expect(store.size).toBe(1)
    await router(req())
    expect(calls()).toBe(1)
  })

  it("passes through to a custom IdempotencyStore implementation", async () => {
    const { tree, calls } = makeCountingTree()
    const backing = new Map<string, unknown>()
    const customStore: IdempotencyStore = {
      get: async (key) => backing.get(key),
      set: async (key, value) => {
        backing.set(key, value)
      },
    }
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [
      idempotencyMiddleware({ store: customStore }),
    ])

    const req = () =>
      new Request("http://localhost/charge", {
        method: "POST",
        headers: { "Idempotency-Key": "abc", "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      })

    await router(req())
    await router(req())

    expect(calls()).toBe(1)
    expect(backing.size).toBe(1)
  })
})

describe("InMemoryIdempotencyStore", () => {
  it("returns undefined for a missing key", async () => {
    const store = new InMemoryIdempotencyStore()
    expect(await store.get("nope")).toBeUndefined()
  })

  it("returns the cached value before ttl expiry", async () => {
    const store = new InMemoryIdempotencyStore()
    await store.set("k", { v: 1 }, 10_000)
    expect(await store.get("k")).toEqual({ v: 1 })
  })

  it("expires an entry past its ttl", async () => {
    const store = new InMemoryIdempotencyStore()
    await store.set("k", { v: 1 }, -1) // already expired
    expect(await store.get("k")).toBeUndefined()
  })

  it("never expires an entry with no ttl", async () => {
    const store = new InMemoryIdempotencyStore()
    await store.set("k", { v: 1 })
    expect(await store.get("k")).toEqual({ v: 1 })
  })
})
