import { describe, expect, test } from "bun:test"
import {
  ancestors,
  nodeCount,
  registerParent,
  resolve,
  resolveRef,
  t,
  types,
  typeRefDocument,
  walkTypeRef,
  type TypeRef,
} from "./index.ts"
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
      declarationFile: "src/user.ts",
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
      thisType: { shape: { kind: "instance", className: "Account", declarationFile: "src/account.ts" }, meta: {} },
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
      thisType: { shape: { kind: "instance", className: "Account", declarationFile: "src/account.ts" }, meta: {} },
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

describe("typeRefDocument", () => {
  test("wraps a bare TypeRef with empty defs by default", () => {
    const root = t(types.string)
    expect(typeRefDocument(root)).toEqual({ root, defs: {} })
  })

  test("carries an explicit defs map", () => {
    const root = t(types.ref("User"))
    const defs = { User: t(types.object({ id: t(types.string) })) }
    expect(typeRefDocument(root, defs)).toEqual({ root, defs })
  })
})

describe("nodeCount", () => {
  test("a leaf counts as 1", () => {
    expect(nodeCount(t(types.string))).toBe(1)
  })

  test("counts nested object fields", () => {
    const ref = t(types.object({ a: t(types.string), b: t(types.number) }))
    // self (1) + a (1) + b (1)
    expect(nodeCount(ref)).toBe(3)
  })

  test("counts array/tuple/union/intersection/map elements generically", () => {
    expect(nodeCount(t(types.array(t(types.string))))).toBe(2)
    expect(nodeCount(t(types.tuple([t(types.string), t(types.number)])))).toBe(3)
    expect(nodeCount(t(types.union([t(types.string), t(types.number)])))).toBe(3)
    expect(nodeCount(t(types.intersection([t(types.string), t(types.number)])))).toBe(3)
    expect(nodeCount(t(types.map(t(types.string), t(types.number))))).toBe(3)
  })

  test("counts function params + returnType (and thisType, when present)", () => {
    const fn = t(types.function([{ name: "x", type: t(types.number) }], t(types.void)))
    // self + param + returnType
    expect(nodeCount(fn)).toBe(3)
    const method = t(types.method([], t(types.void), t(types.instance("Foo", "foo.ts"))))
    // self + returnType + thisType
    expect(nodeCount(method)).toBe(3)
  })

  test("a ref does not expand into its target — target is a string, not a TypeRef", () => {
    expect(nodeCount(t(types.ref("Whatever")))).toBe(1)
  })

  test("a recursive def's own body (containing a ref to itself) is finite to count", () => {
    // { kind: "object", fields: { next: { kind: "ref", target: "Self" } } }
    const body = t(types.object({ next: t(types.ref("Self")) }))
    expect(nodeCount(body)).toBe(2)
  })
})

describe("resolveRef", () => {
  test("resolves a ref against defs", () => {
    const user = t(types.object({ id: t(types.string) }))
    const doc = typeRefDocument(t(types.ref("User")), { User: user })
    expect(resolveRef(doc, doc.root)).toEqual(user)
  })

  test("returns non-ref input unchanged", () => {
    const doc = typeRefDocument(t(types.string))
    const ref = t(types.number)
    expect(resolveRef(doc, ref)).toBe(ref)
  })

  test("throws on an unresolved ref target", () => {
    const doc = typeRefDocument(t(types.ref("Missing")))
    expect(() => resolveRef(doc, doc.root)).toThrow(/unresolved ref target "Missing"/)
  })
})

describe("walkTypeRef", () => {
  test("visits every node reachable from root, pre-order", () => {
    const root = t(types.object({ a: t(types.string), b: t(types.array(t(types.number))) }))
    const doc = typeRefDocument(root)
    const kinds: string[] = []
    walkTypeRef(doc, (node) => kinds.push(node.shape.kind))
    expect(kinds).toEqual(["object", "string", "array", "number"])
  })

  test("also visits every defs entry, each with its own ancestors chain starting empty", () => {
    const doc = typeRefDocument(t(types.ref("User")), {
      User: t(types.object({ id: t(types.string) })),
    })
    const visited: { kind: string; ancestorCount: number }[] = []
    walkTypeRef(doc, (node, ctx) => visited.push({ kind: node.shape.kind, ancestorCount: ctx.ancestors.length }))
    // root: ref (0 ancestors); defs.User: object (0 ancestors), then id: string (1 ancestor)
    expect(visited).toEqual([
      { kind: "ref", ancestorCount: 0 },
      { kind: "object", ancestorCount: 0 },
      { kind: "string", ancestorCount: 1 },
    ])
  })

  test("ctx.resolveRef resolves a ref against the document's defs", () => {
    const user = t(types.object({ id: t(types.string) }))
    const doc = typeRefDocument(t(types.ref("User")), { User: user })
    let resolved: TypeRef | undefined
    walkTypeRef(doc, (node, ctx) => {
      if (node.shape.kind === "ref") resolved = ctx.resolveRef(node)
    })
    expect(resolved).toEqual(user)
  })

  test("ctx.isRecursionTarget is true for a node reference-equal to an ancestor", () => {
    const inner = t(types.string)
    const outer = t(types.object({ a: inner }))
    const doc = typeRefDocument(outer)
    const flags: boolean[] = []
    walkTypeRef(doc, (_node, ctx) => flags.push(ctx.isRecursionTarget(outer)))
    // At the root (outer itself), outer is not yet an ancestor of itself; at
    // the child (inner), outer IS now an ancestor.
    expect(flags).toEqual([false, true])
  })
})
