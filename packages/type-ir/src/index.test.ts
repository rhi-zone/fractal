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

  test("root type has no ancestors", () => {
    expect(ancestors("boolean")).toEqual([])
  })

  test("instance falls back to object", () => {
    expect(ancestors("instance")).toEqual(["object"])
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

  test("builds an instance carrying class identity alongside fields", () => {
    const ref = t(types.instance("User", "src/user.ts", { name: t(types.string) }))
    expect(ref.shape).toEqual({
      kind: "instance",
      className: "User",
      source: "src/user.ts",
      fields: { name: { shape: { kind: "string" }, meta: {} } },
    })
  })

  test("resolve falls back from instance to object handler (structural compatibility)", () => {
    const ref = t(types.instance("User", "src/user.ts", { name: t(types.string) }))
    const handler = resolve(ref.shape.kind, {
      object: (shape: { kind: string; fields: Record<string, unknown> }) => Object.keys(shape.fields),
    })
    expect(handler).toBeDefined()
  })
})
