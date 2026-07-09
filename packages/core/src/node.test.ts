// packages/core/src/node.test.ts — new Node/Handler/Meta/ParamNode model

import { describe, expect, it } from "bun:test"
import {
  op,
  node,
  service,
  param,
  dispatch,
  isNode,
  isLeaf,
  isParamNode,
  mergeMeta,
  type Meta,
  type Node,
} from "./node.ts"
import {
  resolveTags,
  effectiveTags,
  TAG_READ_ONLY,
  TAG_IDEMPOTENT,
  TAG_DESTRUCTIVE,
  TAG_OPEN_WORLD,
  TAG_STREAMING,
  type Tags,
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
      children: {
        getUser: op(handler, meta),
      },
    })

    // Both lower to the same shape
    expect(fromService.children?.["getUser"] !== undefined).toBe(true)
    expect(fromNode.children?.["getUser"] !== undefined).toBe(true)
    expect(fromService.meta).toEqual(fromNode.meta)
    // children are structurally equivalent: same keys, same meta; handler identity differs (bind)
    expect(Object.keys(fromService.children ?? {})).toEqual(Object.keys(fromNode.children ?? {}))
    const svcChild = fromService.children?.["getUser"] as Node
    const nodeChild = fromNode.children?.["getUser"] as Node
    expect(svcChild.meta).toEqual(nodeChild.meta)
    // both handlers produce the same output
    expect(svcChild.handler!({ userId: "u1" })).toEqual(nodeChild.handler!({ userId: "u1" }))
  })

  it("op(fn) produces a leaf node with empty meta", () => {
    const bare = (input: { n: number }) => input.n * 2
    const n = node({ children: { double: op(bare) } })
    const child = n.children?.["double"] as Node
    expect(child.meta).toEqual({})
    expect(child.handler!({ n: 3 })).toBe(6)
    expect(isLeaf(child)).toBe(true)
  })
})

// ============================================================================
// 2. Param slug threads into handler input (provenance-blind dispatch)
// ============================================================================

describe("param slug threads into handler input", () => {
  it("merges a single param slug into the handler's input", async () => {
    const captured: unknown[] = []
    const checkoutLeaf = op(
      (input: { invoiceId: string; currency?: string }) => {
        captured.push(input)
        return { url: "https://pay.example.com" }
      },
      { http: { verb: "POST", segment: "checkout" } },
    )

    const invoicesNode: Node = node({
      children: {
        invoiceId: param("invoiceId", node({ children: { checkout: checkoutLeaf } })),
      },
    })

    const root: Node = node({ children: { invoices: invoicesNode } })

    // segments: [child-key, param-slug-value, leaf-key]
    await dispatch(root, ["invoices", "inv-42", "checkout"], { currency: "usd" })

    expect(captured[0]).toEqual({ currency: "usd", invoiceId: "inv-42" })
  })

  it("accumulates multiple nested param slugs", async () => {
    const captured: unknown[] = []
    const getLeaf = op((input: { orgId: string; userId: string }) => {
      captured.push(input)
      return { ok: true }
    })

    const usersNode: Node = node({
      children: {
        userId: param("userId", node({ children: { get: getLeaf } })),
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

  it("throws on missing leaf", () => {
    const n = node({ children: { ping: op(() => "pong") } })
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
  it("arbitrary/unknown meta keys are preserved on leaf op", () => {
    const leaf = op(() => "ok", {
      myCustomProjection: { foo: "bar", nested: { deep: 42 } },
      "acme:cache": { ttl: 300, varyOn: ["id"] },
    })
    expect(leaf.meta["myCustomProjection"]).toEqual({ foo: "bar", nested: { deep: 42 } })
    expect(leaf.meta["acme:cache"]).toEqual({ ttl: 300, varyOn: ["id"] })
  })

  it("arbitrary/unknown meta keys are preserved on node", () => {
    const n = node({ meta: { internalFlag: true, analytics: { track: "pageview" } } })
    expect(n.meta["internalFlag"]).toBe(true)
    expect(n.meta["analytics"]).toEqual({ track: "pageview" })
  })

  it("resolveTags leaves non-standard boolean keys in tags untouched (not consumed)", () => {
    // resolveTags reads only known tag keys; custom boolean keys pass through in
    // the Tags bag untouched — the caller retains the original tags object
    const tags: Tags = {
      [TAG_READ_ONLY]: true,
      customTag: true,
    }
    const result = resolveTags(tags)
    // Standard tags resolved correctly
    expect(result.readOnly).toBe(true)
    expect(result.idempotent).toBe(true)
    // The original tags bag is untouched
    expect(tags[TAG_READ_ONLY]).toBe(true)
    expect(tags["customTag"]).toBe(true)
  })
})

// ============================================================================
// 5. Standalone-function op and method op both work
// ============================================================================

describe("op surfaces", () => {
  it("standalone function op produces a leaf node", async () => {
    const greet = (input: { name: string }) => `Hello, ${input.name}!`
    const leaf = op(greet)
    expect(isLeaf(leaf)).toBe(true)
    expect(await leaf.handler!({ name: "world" })).toBe("Hello, world!")
    expect(leaf.meta).toEqual({})
  })

  it("standalone function op with meta preserves meta", async () => {
    const leaf = op(
      (input: { id: string }) => ({ found: true, id: input.id }),
      { tags: { [TAG_READ_ONLY]: true }, http: { segment: "detail" } },
    )
    expect(await leaf.handler!({ id: "x" })).toEqual({ found: true, id: "x" })
    expect(leaf.meta.tags?.[TAG_READ_ONLY]).toBe(true)
    expect(leaf.meta["http"]).toEqual({ segment: "detail" })
  })

  it("method op (from service) produces a leaf node child and is bound", async () => {
    class Greeter {
      private prefix = "Hi"
      greet(input: { name: string }) {
        return `${this.prefix}, ${input.name}!`
      }
    }
    const n = service(new Greeter())
    const greetLeaf = n.children?.["greet"] as Node
    expect(greetLeaf).toBeDefined()
    expect(isLeaf(greetLeaf)).toBe(true)
    // Call without receiver — binding must have captured `this`
    expect(await greetLeaf.handler!({ name: "Alice" })).toBe("Hi, Alice!")
  })

  it("isNode / isParamNode / isLeaf discriminators are correct", () => {
    const n = node({})
    const p = param("id", node({}))
    const leaf = op(() => "x")
    expect(isNode(n)).toBe(true)
    expect(isNode(leaf)).toBe(true)   // a leaf IS a node (has meta)
    expect(isNode(p)).toBe(false)
    expect(isParamNode(p)).toBe(true)
    expect(isParamNode(n)).toBe(false)
    expect(isLeaf(n)).toBe(false)     // branch node with no handler
    expect(isLeaf(leaf)).toBe(true)
    expect(isNode(null)).toBe(false)
    expect(isParamNode(42)).toBe(false)
  })
})

// ============================================================================
// 6. effectiveTags — node-level tag inheritance
// ============================================================================

describe("effectiveTags — inheritance", () => {
  it("node tags flow to leaf when leaf has no own tags", () => {
    const path = [
      { meta: { tags: { readOnly: true } } },  // parent node
      { meta: {} },                              // leaf with no tags
    ]
    const result = effectiveTags(path)
    expect(result.readOnly).toBe(true)
  })

  it("leaf-level readOnly:false overrides ancestor readOnly:true", () => {
    const path = [
      { meta: { tags: { readOnly: true } } },   // ancestor
      { meta: { tags: { readOnly: false } } },  // leaf
    ]
    const result = effectiveTags(path)
    expect(result.readOnly).toBe(false)
  })

  it("leaf idempotent:true does not disturb ancestor readOnly:false; other ancestor tags flow through", () => {
    const path = [
      { meta: { tags: { readOnly: false, openWorld: true } } },  // ancestor
      { meta: { tags: { idempotent: true } } },                   // leaf — no readOnly key
    ]
    const result = effectiveTags(path)
    expect(result.idempotent).toBe(true)
    expect(result.readOnly).toBe(false)    // flows through from ancestor
    expect(result.openWorld).toBe(true)   // flows through from ancestor
  })

  it("undefined at leaf level defers to ancestor value", () => {
    const path = [
      { meta: { tags: { readOnly: true } } },
      { meta: { tags: { readOnly: undefined } } },  // explicit undefined — defers upward
    ]
    const result = effectiveTags(path)
    expect(result.readOnly).toBe(true)
  })

  it("two-level nesting resolves closest-wins: leaf > parent > grandparent", () => {
    const path = [
      { meta: { tags: { readOnly: true } } },    // grandparent
      { meta: { tags: { idempotent: false } } }, // parent
      { meta: { tags: { destructive: true } } }, // leaf
    ]
    const result = effectiveTags(path)
    expect(result.readOnly).toBe(true)      // from grandparent
    expect(result.idempotent).toBe(false)   // from parent
    expect(result.destructive).toBe(true)   // from leaf
  })

  it("three-valued: explicit false overrides true from ancestor", () => {
    const path = [
      { meta: { tags: { readOnly: true } } },
      { meta: { tags: { readOnly: false } } },
    ]
    expect(effectiveTags(path).readOnly).toBe(false)
  })

  it("three-valued: explicit true overrides false from ancestor", () => {
    const path = [
      { meta: { tags: { readOnly: false } } },
      { meta: { tags: { readOnly: true } } },
    ]
    expect(effectiveTags(path).readOnly).toBe(true)
  })
})

// ============================================================================
// 7. mergeMeta — deep-merge with precedence
// ============================================================================

describe("mergeMeta", () => {
  it("later bag wins over earlier for scalar keys", () => {
    const m = mergeMeta({ foo: 1 }, { foo: 2 })
    expect(m["foo"]).toBe(2)
  })

  it("undefined in later bag defers — does not override", () => {
    const m = mergeMeta({ foo: 1 }, { foo: undefined })
    expect(m["foo"]).toBe(1)
  })

  it("sub-bag objects are merged one level deep (later wins per key)", () => {
    const m = mergeMeta(
      { tags: { readOnly: true, openWorld: true } },
      { tags: { readOnly: false } },
    )
    expect((m.tags as Tags).readOnly).toBe(false)   // overridden
    expect((m.tags as Tags).openWorld).toBe(true)   // inherited
  })

  it("arrays are NOT merged — later replaces", () => {
    const m = mergeMeta({ roles: ["a"] }, { roles: ["b", "c"] })
    expect(m["roles"]).toEqual(["b", "c"])
  })

  it("undefined metas are skipped", () => {
    const m = mergeMeta(undefined, { x: 1 }, undefined)
    expect(m["x"]).toBe(1)
  })

  it("key absent in later bag is inherited from earlier", () => {
    const m = mergeMeta({ a: 1, b: 2 }, { b: 3 })
    expect(m["a"]).toBe(1)
    expect(m["b"]).toBe(3)
  })
})
