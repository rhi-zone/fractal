// packages/graphql-api-projector/src/server.test.ts — createGraphQLServer end-to-end tests
//
// Drives `createGraphQLServer` through its own `execute`/`subscribe` — the
// real graphql-js parse → validate → execute pipeline against a schema this
// module wired resolvers onto, not just the internal `projectGraphQL` walk
// (already covered by project.test.ts).

import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, it } from "bun:test"
import type { ExecutionResult } from "graphql"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
import { err, ok } from "@rhi-zone/fractal-api-tree"
import { t, types } from "@rhi-zone/fractal-type-ir"
import type { FieldTypeMap } from "./project.ts"
import { createGraphQLServer } from "./server.ts"
import { graphqlErrors } from "./resolve.ts"
import type { GraphQLHandlerMiddleware } from "./resolve.ts"

// ============================================================================
// 1. Basic query/mutation dispatch — nested Query, flat Mutation
// ============================================================================

describe("createGraphQLServer — query/mutation dispatch", () => {
  const tree = api_({
    users: api_({
      get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), { tags: { readOnly: true } }),
      admin: api_({
        settings: op((_: unknown) => ({ theme: "dark" }), { tags: { readOnly: true } }),
      }),
    }),
    createUser: op((input: { name: string }) => ({ id: "1", name: input.name })),
  })

  const typesMap: FieldTypeMap = {
    users_get: { input: t(types.object({ id: t(types.string) })), output: t(types.ref("User")) },
    users_admin_settings: { output: t(types.ref("Settings")) },
    createUser: { input: t(types.object({ name: t(types.string) })), output: t(types.ref("User")) },
  }
  const namedTypes = {
    User: t(types.object({ id: t(types.string), name: t(types.string) }), { typeName: "User" }),
    Settings: t(types.object({ theme: t(types.string) }), { typeName: "Settings" }),
  }

  it("executes a nested query field, threading args through the reconstructed namespace path", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const result = await server.execute(`{ users { get(id: "42") { id name } } }`)
    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ users: { get: { id: "42", name: "Alice" } } })
  })

  it("executes a two-level-deep nested query field (passthrough resolver on the intermediate namespace)", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const result = await server.execute(`{ users { admin { settings { theme } } } }`)
    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ users: { admin: { settings: { theme: "dark" } } } })
  })

  it("executes a flat top-level mutation field", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const result = await server.execute(`mutation { createUser(name: "Bob") { id name } }`)
    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ createUser: { id: "1", name: "Bob" } })
  })

  it("exposes the rendered SDL text", () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    expect(server.sdl).toContain("type Query")
    expect(server.sdl).toContain("type Mutation")
  })

  it("an unknown field surfaces as a GraphQL validation error, not a crash", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const result = await server.execute(`{ doesNotExist }`)
    expect(result.errors).toBeDefined()
    expect(result.errors!.length).toBeGreaterThan(0)
  })

  it("a syntactically invalid query surfaces as an error result", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const result = await server.execute(`{ users { `)
    expect(result.errors).toBeDefined()
  })
})

// ============================================================================
// 2. Root-level (non-namespaced) query leaf
// ============================================================================

describe("createGraphQLServer — root-level query field", () => {
  it("dispatches a query leaf declared directly at the tree root", async () => {
    const tree = api_({ ping: op((_: unknown) => "pong", { tags: { readOnly: true } }) })
    const server = createGraphQLServer(tree)
    const result = await server.execute(`{ ping }`)
    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ ping: "pong" })
  })
})

// ============================================================================
// 3. Error encoding
// ============================================================================

describe("createGraphQLServer — errorEncoder", () => {
  const tree = api_({
    getBook: op((_: unknown) => err({ kind: "notFound", message: "no such book" })),
  })

  it("an err Result with no errorEncoder surfaces as a generic error", async () => {
    const server = createGraphQLServer(tree)
    const result = await server.execute(`mutation { getBook }`)
    expect(result.errors).toBeDefined()
    expect(result.data).toEqual({ getBook: null })
  })

  it("an err Result with a matching errorEncoder carries the encoded message + extensions.code", async () => {
    const server = createGraphQLServer(tree, { errorEncoder: graphqlErrors({ notFound: "NOT_FOUND" }) })
    const result = await server.execute(`mutation { getBook }`)
    expect(result.errors).toBeDefined()
    expect(result.errors![0]!.message).toBe("no such book")
    expect(result.errors![0]!.extensions?.code).toBe("NOT_FOUND")
  })
})

// ============================================================================
// 4. Middleware — threaded through resolve.ts's createResolver
// ============================================================================

describe("createGraphQLServer — middleware", () => {
  const tree = api_({
    echo: op((input: { text: string }) => input.text),
  })
  const typesMap: FieldTypeMap = { echo: { input: t(types.object({ text: t(types.string) })) } }

  it("wraps the handler call and can transform its output", async () => {
    const tagOutput: GraphQLHandlerMiddleware = (next) => async (input, stores) => {
      const result = await next(input, stores)
      return `[${result as string}]`
    }
    const server = createGraphQLServer(tree, { types: typesMap, middleware: [tagOutput] })
    const result = await server.execute(`mutation { echo(text: "hi") }`)
    expect(result.data).toEqual({ echo: "[hi]" })
  })

  it("multiple middleware compose — first entry is outermost", async () => {
    const order: string[] = []
    const tracking = (name: string): GraphQLHandlerMiddleware => (next) => async (input, stores) => {
      order.push(`${name}:enter`)
      const result = await next(input, stores)
      order.push(`${name}:exit`)
      return result
    }
    const server = createGraphQLServer(tree, { types: typesMap, middleware: [tracking("outer"), tracking("inner")] })
    await server.execute(`mutation { echo(text: "hi") }`)
    expect(order).toEqual(["outer:enter", "inner:enter", "inner:exit", "outer:exit"])
  })
})

// ============================================================================
// 5. ALS — innermost wrapper
// ============================================================================

describe("createGraphQLServer — als", () => {
  it("the handler call runs inside the AsyncLocalStorage context", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    let observedInsideHandler: string | undefined

    const tree = api_({
      whoami: op((_: unknown) => {
        observedInsideHandler = storage.getStore()?.requestId
        return "ok"
      }),
    })

    const server = createGraphQLServer(tree, { als: { storage, init: () => ({ requestId: "req-123" }) } })
    await server.execute(`mutation { whoami }`)
    expect(observedInsideHandler).toBe("req-123")
  })

  it("passes GraphQLAlsContext (meta, fieldName, operationType) into init", async () => {
    const storage = new AsyncLocalStorage<{ fieldName: string; operationType: string }>()
    let captured: { fieldName: string; operationType: string } | undefined

    const tree = api_({
      users: api_({
        get: op((_: unknown) => "ok", { tags: { readOnly: true } }),
      }),
    })

    const server = createGraphQLServer(tree, {
      als: {
        storage,
        init: (ctx) => {
          captured = { fieldName: ctx.fieldName, operationType: ctx.operationType }
          return captured
        },
      },
    })
    await server.execute(`{ users { get } }`)
    expect(captured).toEqual({ fieldName: "get", operationType: "query" })
  })
})

// ============================================================================
// 6. Detection — opt-out of Result-shape unwrapping
// ============================================================================

describe("createGraphQLServer — detection", () => {
  const tree = api_({
    getThing: op((_: unknown) => ok(42)),
  })

  it("defaults: Result-shape output is unwrapped", async () => {
    const server = createGraphQLServer(tree)
    const result = await server.execute(`mutation { getThing }`)
    expect(result.data).toEqual({ getThing: 42 })
  })

  it("detection.result: false — a Result-shaped return value passes through untouched", async () => {
    const server = createGraphQLServer(tree, { detection: { result: false } })
    const result = await server.execute(`mutation { getThing }`)
    expect(result.data?.getThing).toMatchObject({ kind: "ok", value: 42 })
  })
})

// ============================================================================
// 7. Validators
// ============================================================================

describe("createGraphQLServer — validators", () => {
  function rejectingEntry(): GeneratedEntry {
    return { parse: () => ({ kind: "err", errors: [{ kind: "type", path: [], expected: "n/a", actual: "n/a" }] }) }
  }
  function okEntry(): GeneratedEntry {
    return { parse: (value) => ({ kind: "ok", value: { ...(value as Record<string, unknown>), validated: true } }) }
  }

  it("wraps the tree via wrapValidators before projection", async () => {
    const tree = api_({
      widgets: op((input: Record<string, unknown>) => input),
    })
    const server = createGraphQLServer(tree, { validators: { widgets: okEntry() } })
    const result = await server.execute(`mutation { widgets }`)
    expect(result.data?.widgets).toMatchObject({ validated: true })
  })

  it("a rejecting generated validator's err Result surfaces as a GraphQL error", async () => {
    const tree = api_({
      widgets: op((input: Record<string, unknown>) => input),
    })
    const server = createGraphQLServer(tree, { validators: { widgets: rejectingEntry() } })
    const result = await server.execute(`mutation { widgets }`)
    expect(result.errors).toBeDefined()
  })
})

// ============================================================================
// 8. Subscriptions
// ============================================================================

describe("createGraphQLServer — subscriptions", () => {
  it("drains a streaming handler's AsyncIterable through graphql-js's own subscribe", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield "a"
        yield "b"
      }, { tags: { streaming: true } }),
    })
    const server = createGraphQLServer(tree)
    const iterableOrResult = await server.subscribe(`subscription { watch }`)
    expect(Symbol.asyncIterator in (iterableOrResult as object)).toBe(true)

    const collected: unknown[] = []
    for await (const event of iterableOrResult as AsyncIterable<ExecutionResult>) {
      collected.push(event.data?.watch)
    }
    expect(collected).toEqual(["a", "b"])
  })

  it("a subscription document with a validation error surfaces as a plain ExecutionResult with errors", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield "a"
      }, { tags: { streaming: true } }),
    })
    const server = createGraphQLServer(tree)
    const result = await server.subscribe(`subscription { doesNotExist }`)
    expect("errors" in (result as object)).toBe(true)
  })
})
