// packages/core/src/node.test.ts — new Node/Op/Meta/ParamNode model

import { describe, expect, it } from "bun:test"
import {
  op,
  node,
  service,
  param,
  dispatch,
  isNode,
  isParamNode,
  type Meta,
  type Node,
} from "./node.ts"
import {
  resolveTags,
  TAG_READ_ONLY,
  TAG_IDEMPOTENT,
  TAG_DESTRUCTIVE,
  TAG_OPEN_WORLD,
  TAG_STREAMING,
} from "./tags.ts"

// ============================================================================
// 1. Lowering equivalence: service() ≡ node() — both surfaces, one value
// ============================================================================

describe("lowering equivalence: service ≡ node", () => {
  it("produces deep-equal Node values from service() and node()", () => {
    const handler = (input: { userId: string }) => ({ ok: true, userId: input.userId })
    const meta: Meta = { http: { verb: "POST" } }

    // Surface A: class / service
    class UserService {
      getUser(input: { userId: string }) {
        return handler(input)
      }
    }
    const fromService = service(new UserService(), { meta: { getUser: meta } })

    // Surface B: standalone function
    const fromNode = node({
      ops: {
        getUser: op(handler, meta),
      },
    })

    // Both lower to the same shape
    expect(fromService.children).toEqual(fromNode.children)
    expect(fromService.meta).toEqual(fromNode.meta)
    // ops are structurally equal: same keys, same meta; fn identity differs (bind)
    expect(Object.keys(fromService.ops)).toEqual(Object.keys(fromNode.ops))
    expect(fromService.ops["getUser"]?.meta).toEqual(fromNode.ops["getUser"]?.meta)
    // both fns produce the same output
    expect(
      fromService.ops["getUser"]?.fn({ userId: "u1" }),
    ).toEqual(
      fromNode.ops["getUser"]?.fn({ userId: "u1" }),
    )
  })

  it("bare function in node() ops is lifted to {fn, meta:{}}", () => {
    const bare = (input: { n: number }) => input.n * 2
    const n = node({ ops: { double: bare } })
    expect(n.ops["double"]?.meta).toEqual({})
    expect(n.ops["double"]?.fn({ n: 3 })).toBe(6)
  })
})

// ============================================================================
// 2. Param slug threads into op input (provenance-blind dispatch)
// ============================================================================

describe("param slug threads into op input", () => {
  it("merges a single param slug into the op's input", async () => {
    const captured: unknown[] = []
    const checkoutOp = op(
      (input: { invoiceId: string; currency?: string }) => {
        captured.push(input)
        return { url: "https://pay.example.com" }
      },
      { http: { verb: "POST", segment: "checkout" } },
    )

    const invoicesNode: Node = node({
      children: {
        invoiceId: param("invoiceId", node({ ops: { checkout: checkoutOp } })),
      },
    })

    const root: Node = node({ children: { invoices: invoicesNode } })

    // segments: [child-key, param-slug-value, op-name]
    await dispatch(root, ["invoices", "inv-42", "checkout"], { currency: "usd" })

    expect(captured[0]).toEqual({ currency: "usd", invoiceId: "inv-42" })
  })

  it("accumulates multiple nested param slugs", async () => {
    const captured: unknown[] = []
    const leafOp = op((input: { orgId: string; userId: string }) => {
      captured.push(input)
      return { ok: true }
    })

    const usersNode: Node = node({
      children: {
        userId: param("userId", node({ ops: { get: leafOp } })),
      },
    })
    const orgsNode: Node = node({
      children: {
        orgId: param("orgId", node({ children: { users: usersNode } })),
      },
    })
    const root: Node = node({ children: { orgs: orgsNode } })

    await dispatch(root, ["orgs", "org-1", "users", "user-7", "get"], {})

    expect(captured[0]).toEqual({ orgId: "org-1", userId: "user-7" })
  })

  it("throws on missing op", () => {
    const n = node({ ops: { ping: op(() => "pong") } })
    expect(() => dispatch(n, ["missing"], {})).toThrow("op not found: missing")
  })

  it("throws on missing child", () => {
    const n = node({ children: { a: node({}) } })
    expect(() => dispatch(n, ["b", "op"], {})).toThrow("child not found: b")
  })
})

// ============================================================================
// 3. resolveTags — implication lattice
// ============================================================================

describe("resolveTags", () => {
  it("readOnly ⇒ idempotent when idempotent is unknown", () => {
    const result = resolveTags({ [TAG_READ_ONLY]: true })
    expect(result.readOnly).toBe(true)
    expect(result.idempotent).toBe(true)  // derived
  })

  it("readOnly does not override an explicitly-set idempotent", () => {
    // idempotent: false is an explicit negative — readOnly ⇒ idempotent should
    // not stomp an explicit false (conflict is a domain issue, not our job here)
    const result = resolveTags({ [TAG_READ_ONLY]: true, [TAG_IDEMPOTENT]: false })
    expect(result.idempotent).toBe(false)  // explicit negative preserved
  })

  it("unknown stays unknown — absence does not default to false", () => {
    const result = resolveTags({})
    expect(result.readOnly).toBeUndefined()
    expect(result.idempotent).toBeUndefined()
    expect(result.destructive).toBeUndefined()
    expect(result.openWorld).toBeUndefined()
    expect(result.streaming).toBeUndefined()
    expect(result.conflict).toBeUndefined()
  })

  it("readOnly + destructive conflict is detected", () => {
    const result = resolveTags({
      [TAG_READ_ONLY]: true,
      [TAG_DESTRUCTIVE]: true,
    })
    expect(result.conflict).toBeDefined()
    expect(typeof result.conflict).toBe("string")
  })

  it("destructive + idempotent is valid (no conflict)", () => {
    const result = resolveTags({ [TAG_DESTRUCTIVE]: true, [TAG_IDEMPOTENT]: true })
    expect(result.destructive).toBe(true)
    expect(result.idempotent).toBe(true)
    expect(result.conflict).toBeUndefined()
  })

  it("streaming and openWorld are orthogonal — pass through untouched", () => {
    const result = resolveTags({
      [TAG_READ_ONLY]: true,
      [TAG_STREAMING]: true,
      [TAG_OPEN_WORLD]: true,
    })
    expect(result.streaming).toBe(true)
    expect(result.openWorld).toBe(true)
    expect(result.conflict).toBeUndefined()
  })
})

// ============================================================================
// 4. Open metadata — arbitrary/unknown keys pass through untouched
// ============================================================================

describe("open metadata", () => {
  it("arbitrary/unknown meta keys are preserved on op", () => {
    const o = op(() => "ok", {
      myCustomProjection: { foo: "bar", nested: { deep: 42 } },
      "acme:cache": { ttl: 300, varyOn: ["id"] },
    })
    expect(o.meta["myCustomProjection"]).toEqual({ foo: "bar", nested: { deep: 42 } })
    expect(o.meta["acme:cache"]).toEqual({ ttl: 300, varyOn: ["id"] })
  })

  it("arbitrary/unknown meta keys are preserved on node", () => {
    const n = node({ meta: { internalFlag: true, analytics: { track: "pageview" } } })
    expect(n.meta["internalFlag"]).toBe(true)
    expect(n.meta["analytics"]).toEqual({ track: "pageview" })
  })

  it("resolveTags leaves non-standard keys in meta untouched (not consumed)", () => {
    // resolveTags reads only known tag keys; extras are ignored but the bag
    // itself is unmodified — the caller retains the original meta object
    const meta: Meta = {
      [TAG_READ_ONLY]: true,
      "acme:cacheable": { ttl: 60 },
      unknownTag: true,
    }
    const result = resolveTags(meta)
    // Standard tags resolved correctly
    expect(result.readOnly).toBe(true)
    expect(result.idempotent).toBe(true)
    // The original meta bag is untouched
    expect(meta["acme:cacheable"]).toEqual({ ttl: 60 })
    expect(meta["unknownTag"]).toBe(true)
  })
})

// ============================================================================
// 5. Standalone-function op and method op both work
// ============================================================================

describe("op surfaces", () => {
  it("standalone function op works", async () => {
    const greet = (input: { name: string }) => `Hello, ${input.name}!`
    const o = op(greet)
    expect(await o.fn({ name: "world" })).toBe("Hello, world!")
    expect(o.meta).toEqual({})
  })

  it("standalone function op with meta works", async () => {
    const o = op(
      (input: { id: string }) => ({ found: true, id: input.id }),
      { [TAG_READ_ONLY]: true, http: { segment: "detail" } },
    )
    expect(await o.fn({ id: "x" })).toEqual({ found: true, id: "x" })
    expect(o.meta[TAG_READ_ONLY]).toBe(true)
    expect(o.meta["http"]).toEqual({ segment: "detail" })
  })

  it("method op (from service) works and is bound", async () => {
    class Greeter {
      private prefix = "Hi"
      greet(input: { name: string }) {
        return `${this.prefix}, ${input.name}!`
      }
    }
    const n = service(new Greeter())
    const greetOp = n.ops["greet"]
    expect(greetOp).toBeDefined()
    // Call without receiver — binding must have captured `this`
    expect(await greetOp!.fn({ name: "Alice" })).toBe("Hi, Alice!")
  })

  it("isNode / isParamNode discriminators are correct", () => {
    const n = node({})
    const p = param("id", node({}))
    expect(isNode(n)).toBe(true)
    expect(isNode(p)).toBe(false)
    expect(isParamNode(p)).toBe(true)
    expect(isParamNode(n)).toBe(false)
    expect(isNode(null)).toBe(false)
    expect(isParamNode(42)).toBe(false)
  })
})
