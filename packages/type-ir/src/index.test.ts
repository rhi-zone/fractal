import { describe, expect, test } from "bun:test"
import { ancestors, registerParent, resolve, t, types } from "./index.ts"
import "./kinds/common.ts"

describe("ancestors", () => {
  test("walks integer -> number", () => {
    expect(ancestors("int32")).toEqual(["integer", "number"])
  })

  test("walks uuid -> string", () => {
    expect(ancestors("uuid")).toEqual(["string"])
  })

  test("walks email -> string", () => {
    expect(ancestors("email")).toEqual(["string"])
  })

  test("root type has no ancestors", () => {
    expect(ancestors("boolean")).toEqual([])
  })

  test("instance is a root kind with no ancestors (purely nominal, not a subtype of object)", () => {
    expect(ancestors("instance")).toEqual([])
  })
})

describe("resolve", () => {
  test("falls back to ancestor handler", () => {
    expect(resolve("int32", { number: "NUMBER" })).toBe("NUMBER")
  })

  test("exact match wins over ancestor", () => {
    expect(resolve("int32", { int32: "INT32", number: "NUMBER" })).toBe("INT32")
  })

  test("returns undefined when nothing matches", () => {
    expect(resolve("boolean", { string: "S" })).toBeUndefined()
  })
})

describe("registerParent", () => {
  test("extends the hierarchy for consumer-added kinds", () => {
    registerParent("int128", "integer")
    expect(ancestors("int128")).toEqual(["integer", "number"])
  })
})

describe("TypeRef construction", () => {
  test("attaches open metadata", () => {
    const ref = t(types.string, { nullable: true })
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta).toEqual({ nullable: true })
  })

  test("builds structural shapes", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.integer),
      }),
    )
    expect(ref.shape).toEqual({
      kind: "object",
      fields: {
        name: { shape: { kind: "string" }, meta: {} },
        age: { shape: { kind: "integer" }, meta: {} },
      },
    })
  })

  test("builds an intersection of members", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(ref.shape).toEqual({
      kind: "intersection",
      members: [
        { shape: { kind: "object", fields: { id: { shape: { kind: "string" }, meta: {} } } }, meta: {} },
        {
          shape: { kind: "object", fields: { createdAt: { shape: { kind: "string" }, meta: {} } } },
          meta: {},
        },
      ],
    })
  })

  test("intersection is a root kind with no ancestors", () => {
    expect(ancestors("intersection")).toEqual([])
  })

  test("builds an instance carrying only class identity, no fields", () => {
    const ref = t(types.instance("User", "src/user.ts"))
    expect(ref.shape).toEqual({
      kind: "instance",
      className: "User",
      source: "src/user.ts",
    })
  })

  test("resolve does NOT fall back from instance to an object handler (nominal, not structural)", () => {
    const ref = t(types.instance("User", "src/user.ts"))
    const handler = resolve(ref.shape.kind, {
      object: (shape: { kind: string; fields: Record<string, unknown> }) => Object.keys(shape.fields),
    })
    expect(handler).toBeUndefined()
  })

  test("builds a free function with params and return type, no thisType", () => {
    const ref = t(
      types.function(
        [{ name: "x", type: t(types.number) }],
        t(types.string),
      ),
    )
    expect(ref.shape).toEqual({
      kind: "function",
      params: [{ name: "x", type: { shape: { kind: "number" }, meta: {} } }],
      returnType: { shape: { kind: "string" }, meta: {} },
    })
    expect((ref.shape as { thisType?: unknown }).thisType).toBeUndefined()
  })

  test("builds a method function carrying a thisType", () => {
    const ref = t(
      types.function(
        [{ name: "amount", type: t(types.number) }],
        t(types.void),
        t(types.instance("Account", "src/account.ts")),
      ),
    )
    expect(ref.shape).toEqual({
      kind: "function",
      params: [{ name: "amount", type: { shape: { kind: "number" }, meta: {} } }],
      returnType: { shape: { kind: "void" }, meta: {} },
      thisType: { shape: { kind: "instance", className: "Account", source: "src/account.ts" }, meta: {} },
    })
  })

  test("function is a root kind with no ancestors", () => {
    expect(ancestors("function")).toEqual([])
  })

  test("builds a method carrying a thisType", () => {
    const ref = t(
      types.method(
        [{ name: "amount", type: t(types.number) }],
        t(types.void),
        t(types.instance("Account", "src/account.ts")),
      ),
    )
    expect(ref.shape).toEqual({
      kind: "method",
      params: [{ name: "amount", type: { shape: { kind: "number" }, meta: {} } }],
      returnType: { shape: { kind: "void" }, meta: {} },
      thisType: { shape: { kind: "instance", className: "Account", source: "src/account.ts" }, meta: {} },
    })
  })

  test("builds a method with no thisType", () => {
    const ref = t(types.method([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(ref.shape).toEqual({
      kind: "method",
      params: [{ name: "x", type: { shape: { kind: "number" }, meta: {} } }],
      returnType: { shape: { kind: "string" }, meta: {} },
    })
    expect((ref.shape as { thisType?: unknown }).thisType).toBeUndefined()
  })

  test("method's parent is function — a projector without an explicit method handler falls back to it", () => {
    expect(ancestors("method")).toEqual(["function"])
    expect(resolve("method", { function: "FUNCTION" })).toBe("FUNCTION")
    expect(resolve("method", { method: "METHOD", function: "FUNCTION" })).toBe("METHOD")
  })

  test("builds an interface carrying named method TypeRefs", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
      }),
    )
    expect(ref.shape).toEqual({
      kind: "interface",
      methods: {
        deposit: {
          shape: {
            kind: "method",
            params: [{ name: "amount", type: { shape: { kind: "number" }, meta: {} } }],
            returnType: { shape: { kind: "void" }, meta: {} },
          },
          meta: {},
        },
      },
    })
  })

  test("interface is a root kind with no ancestors (not a subtype of object)", () => {
    expect(ancestors("interface")).toEqual([])
  })

  test("resolve does NOT fall back from interface to an object handler (structural but not object)", () => {
    const ref = t(types.interface({}))
    const handler = resolve(ref.shape.kind, {
      object: (shape: { kind: string; fields: Record<string, unknown> }) => Object.keys(shape.fields),
    })
    expect(handler).toBeUndefined()
  })

  test("builds a stream of an element type", () => {
    const ref = t(types.stream(t(types.string)))
    expect(ref.shape).toEqual({
      kind: "stream",
      element: { shape: { kind: "string" }, meta: {} },
    })
  })

  test("stream is a root kind with no ancestors (not a subtype of array)", () => {
    expect(ancestors("stream")).toEqual([])
  })

  test("resolve does NOT fall back from stream to an array handler (async sequence, not a materialized collection)", () => {
    const ref = t(types.stream(t(types.string)))
    const handler = resolve(ref.shape.kind, {
      array: (shape: { kind: string; element: unknown }) => shape.element,
    })
    expect(handler).toBeUndefined()
  })
})
