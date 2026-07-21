// packages/graphql-api-projector/src/resolve.test.ts — per-field resolver dispatch tests

import { describe, expect, it } from "bun:test"
import { GraphQLError } from "graphql"
import { err, ok } from "@rhi-zone/fractal-api-tree"
import { createResolver, graphqlErrors } from "./resolve.ts"
import type { FieldResolver, SubscriptionFieldConfig } from "./resolve.ts"
import type { Dispatch } from "./project.ts"

function dispatch(overrides: Partial<Dispatch> & Pick<Dispatch, "handler">): Dispatch {
  return {
    inputNames: [],
    sourceMap: {},
    operationType: "query",
    meta: {},
    ...overrides,
  }
}

// ============================================================================
// 1. Query/mutation resolvers — arg assembly + plain return
// ============================================================================

describe("createResolver — query/mutation fields", () => {
  it("assembles the handler input bag from the resolver's own args, by inputNames", async () => {
    let seen: unknown
    const entry = dispatch({
      handler: (input: unknown) => {
        seen = input
        return "ok"
      },
      inputNames: ["id", "name"],
    })
    const resolver = createResolver(entry) as FieldResolver
    const result = await resolver(undefined, { id: "1", name: "book", extra: "ignored" }, {}, {})
    expect(result).toBe("ok")
    expect(seen).toEqual({ id: "1", name: "book" })
  })

  it("a param name not present in args resolves to undefined (matches assemble()'s convention)", async () => {
    let seen: unknown
    const entry = dispatch({
      handler: (input: unknown) => {
        seen = input
      },
      inputNames: ["missing"],
    })
    const resolver = createResolver(entry) as FieldResolver
    await resolver(undefined, {}, {}, {})
    expect(seen).toEqual({ missing: undefined })
  })

  it("sourceMap remaps an arg name to a different source key", async () => {
    let seen: unknown
    const entry = dispatch({
      handler: (input: unknown) => {
        seen = input
      },
      inputNames: ["name"],
      sourceMap: { name: { store: "argument", key: "fullName" } },
    })
    const resolver = createResolver(entry) as FieldResolver
    await resolver(undefined, { fullName: "Ada" }, {}, {})
    expect(seen).toEqual({ name: "Ada" })
  })

  it("unwraps an ok Result to its .value", async () => {
    const entry = dispatch({ handler: () => ok({ id: 1 }) })
    const resolver = createResolver(entry) as FieldResolver
    expect(await resolver(undefined, {}, {}, {})).toEqual({ id: 1 })
  })

  it("an err Result with no errorEncoder throws a GraphQLError wrapping the raw error", async () => {
    const entry = dispatch({ handler: () => err({ kind: "notFound", message: "no such book" }) })
    const resolver = createResolver(entry) as FieldResolver
    await expect(resolver(undefined, {}, {}, {})).rejects.toBeInstanceOf(GraphQLError)
  })

  it("an err Result with a matching errorEncoder throws a GraphQLError carrying its message + extensions", async () => {
    const entry = dispatch({ handler: () => err({ kind: "notFound", message: "no such book" }) })
    const encoder = graphqlErrors({ notFound: "NOT_FOUND" })
    const resolver = createResolver(entry, { errorEncoder: encoder }) as FieldResolver
    try {
      await resolver(undefined, {}, {}, {})
      throw new Error("expected resolver to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError)
      expect((e as GraphQLError).message).toBe("no such book")
      expect((e as GraphQLError).extensions.code).toBe("NOT_FOUND")
    }
  })

  it("a handler-thrown error propagates as-is (not converted to a GraphQLError by this module)", async () => {
    const entry = dispatch({
      handler: () => {
        throw new Error("boom")
      },
    })
    const resolver = createResolver(entry) as FieldResolver
    await expect(resolver(undefined, {}, {}, {})).rejects.toThrow("boom")
  })

  it("a plain (non-Result) return value passes through unchanged", async () => {
    const entry = dispatch({ handler: () => 42 })
    const resolver = createResolver(entry) as FieldResolver
    expect(await resolver(undefined, {}, {}, {})).toBe(42)
  })
})

// ============================================================================
// 2. graphqlErrors — error-kind → extensions.code mapping
// ============================================================================

describe("graphqlErrors", () => {
  it("returns undefined for an unmatched kind (falls through to the default)", () => {
    const encoder = graphqlErrors({ notFound: "NOT_FOUND" })
    expect(encoder({ kind: "conflict", message: "x" })).toBeUndefined()
  })

  it("falls back to JSON.stringify when the error has no .message field", () => {
    const encoder = graphqlErrors({ notFound: "NOT_FOUND" })
    const encoded = encoder({ kind: "notFound", detail: 42 })
    expect(encoded).toEqual({ message: JSON.stringify({ kind: "notFound", detail: 42 }), extensions: { code: "NOT_FOUND" } })
  })
})

// ============================================================================
// 3. Subscription fields — subscribe/resolve config
// ============================================================================

describe("createResolver — subscription fields", () => {
  async function* gen(values: unknown[]) {
    for (const v of values) yield v
  }

  it("drains a plain AsyncIterable, yielding each value untagged", async () => {
    const entry = dispatch({
      handler: () => gen(["a", "b"]),
      operationType: "subscription",
    })
    const config = createResolver(entry) as SubscriptionFieldConfig
    const iterable = await config.subscribe(undefined, {}, {}, {})
    const collected: unknown[] = []
    for await (const v of iterable) collected.push(v)
    expect(collected).toEqual(["a", "b"])
    expect(config.resolve("payload")).toBe("payload")
  })

  it("unwraps StreamChunk yields to their .data and swallows StreamProgress yields", async () => {
    async function* stream() {
      yield { kind: "progress", progress: 0.5 }
      yield { kind: "chunk", data: "first" }
      yield { kind: "chunk", data: "second" }
    }
    const entry = dispatch({ handler: () => stream(), operationType: "subscription" })
    const config = createResolver(entry) as SubscriptionFieldConfig
    const iterable = await config.subscribe(undefined, {}, {}, {})
    const collected: unknown[] = []
    for await (const v of iterable) collected.push(v)
    expect(collected).toEqual(["first", "second"])
  })

  it("yields the generator's own return value last", async () => {
    async function* stream() {
      yield "a"
      return "final"
    }
    const entry = dispatch({ handler: () => stream(), operationType: "subscription" })
    const config = createResolver(entry) as SubscriptionFieldConfig
    const iterable = await config.subscribe(undefined, {}, {}, {})
    const collected: unknown[] = []
    for await (const v of iterable) collected.push(v)
    expect(collected).toEqual(["a", "final"])
  })

  it("throws a GraphQLError when a subscription handler does not return an AsyncIterable", async () => {
    const entry = dispatch({ handler: () => "not iterable", operationType: "subscription" })
    const config = createResolver(entry) as SubscriptionFieldConfig
    await expect(config.subscribe(undefined, {}, {}, {})).rejects.toBeInstanceOf(GraphQLError)
  })

  it("assembles subscribe's input from args the same way as a query/mutation resolver", async () => {
    let seen: unknown
    const entry = dispatch({
      handler: (input: unknown) => {
        seen = input
        return gen([])
      },
      operationType: "subscription",
      inputNames: ["channel"],
    })
    const config = createResolver(entry) as SubscriptionFieldConfig
    await config.subscribe(undefined, { channel: "orders" }, {}, {})
    expect(seen).toEqual({ channel: "orders" })
  })
})
