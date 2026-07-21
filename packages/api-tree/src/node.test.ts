// packages/api-tree/src/node.test.ts — new Node/Handler/Meta/fallback model

import { describe, expect, it } from "bun:test"
import {
  op,
  api,
  isNode,
  isLeaf,
  mergeMeta,
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
  type Tags,
} from "./tags.ts"

// `Meta` uses declaration merging (each projector package types its own
// slot — see node.ts's doc comment). Tests below exercise the bag's
// genuinely-open, undeclared-key runtime behavior — arbitrary keys still
// pass through unchanged at the value level, they're just not statically
// known here. `OpenMeta` is the test-only escape hatch for that: an index
// signature back on top of `Meta`, used ONLY where a test's whole point is
// an undeclared key.
type OpenMeta = Meta & Record<string, unknown>

// ============================================================================
// 1. op() — leaf-node constructor
// ============================================================================

describe("op()", () => {
  it("op(fn) produces a leaf node with empty meta", () => {
    const bare = (input: { n: number }) => input.n * 2
    const n = api({ double: op(bare) })
    const child = n.children?.["double"] as Node
    expect(child.meta).toEqual({})
    expect(child.handler!({ n: 3 })).toBe(6)
    expect(isLeaf(child)).toBe(true)
  })
})

// ============================================================================
// 2. fallback field — wildcard-capture subtree shape
// ============================================================================

describe("fallback field on api()", () => {
  it("api({}, { fallback }) carries the fallback shape", () => {
    const subtree = api({ checkout: op((_: { invoiceId: string }) => ({})) })
    const invoicesNode = api({}, { fallback: { name: "invoiceId", subtree } })
    expect(invoicesNode.fallback?.name).toBe("invoiceId")
    expect(invoicesNode.fallback?.subtree).toBe(subtree)
  })

  it("a node can carry both children and a fallback", () => {
    const subtree = api({})
    const n = api({ list: op(() => []) }, { fallback: { name: "id", subtree } })
    expect(n.children?.["list"]).toBeDefined()
    expect(n.fallback?.name).toBe("id")
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
    } as OpenMeta)
    expect((leaf.meta as OpenMeta)["myCustomProjection"]).toEqual({ foo: "bar", nested: { deep: 42 } })
    expect((leaf.meta as OpenMeta)["acme:cache"]).toEqual({ ttl: 300, varyOn: ["id"] })
  })

  it("arbitrary/unknown meta keys are preserved on node", () => {
    const n = api({}, { meta: { internalFlag: true, analytics: { track: "pageview" } } as OpenMeta })
    expect((n.meta as OpenMeta)["internalFlag"]).toBe(true)
    expect((n.meta as OpenMeta)["analytics"]).toEqual({ track: "pageview" })
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
// 5. Standalone-function op
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
      { tags: { [TAG_READ_ONLY]: true }, http: { segment: "detail" } } as OpenMeta,
    )
    expect(await leaf.handler!({ id: "x" })).toEqual({ found: true, id: "x" })
    expect(leaf.meta.tags?.[TAG_READ_ONLY]).toBe(true)
    expect((leaf.meta as OpenMeta)["http"]).toEqual({ segment: "detail" })
  })

  it("isNode / isLeaf discriminators are correct", () => {
    const n = api({})
    const leaf = op(() => "x")
    expect(isNode(n)).toBe(true)
    expect(isNode(leaf)).toBe(true)   // a leaf IS a node (has meta)
    expect(isLeaf(n)).toBe(false)     // branch node with no handler
    expect(isLeaf(leaf)).toBe(true)
    expect(isNode(null)).toBe(false)
    expect(isNode(42)).toBe(false)
  })
})

// ============================================================================
// 6. mapNodes — pre-order tree transform (replaces removed tag inheritance)
// ============================================================================

describe("mapNodes", () => {
  it("visits every node pre-order via children and fallback.subtree", async () => {
    const { mapNodes } = await import("./tags.ts")
    const leaf = op(() => "x")
    const subtree = api({ get: leaf })
    const tree = api({ list: op(() => []) }, { fallback: { name: "id", subtree } })

    const visited: unknown[] = []
    mapNodes(tree, (n) => {
      visited.push(n)
      return n
    })

    // root, "list" leaf, fallback subtree branch, and its "get" leaf
    expect(visited).toHaveLength(4)
    expect(visited[0]).toBe(tree)
  })

  it("a transform can tag every leaf node without mutating the original tree", async () => {
    const { mapNodes } = await import("./tags.ts")
    const tree = api({
        list: op(() => []),
        detail: api({ read: op(() => ({})) }),
      })

    const tagged = mapNodes(tree, (n) =>
      isLeaf(n) ? { ...n, meta: { ...n.meta, tags: { readOnly: true } } } : n,
    )

    expect((tagged.children?.["list"] as Node).meta.tags?.readOnly).toBe(true)
    expect(
      ((tagged.children?.["detail"] as Node).children?.["read"] as Node).meta.tags?.readOnly,
    ).toBe(true)
    // Original tree is untouched
    expect((tree.children?.["list"] as Node).meta.tags).toBeUndefined()
  })
})

// ============================================================================
// 7. mergeMeta — deep-merge with precedence
// ============================================================================

describe("mergeMeta", () => {
  it("later bag wins over earlier for scalar keys", () => {
    const m = mergeMeta({ foo: 1 } as OpenMeta, { foo: 2 } as OpenMeta)
    expect((m as OpenMeta)["foo"]).toBe(2)
  })

  it("undefined in later bag defers — does not override", () => {
    const m = mergeMeta({ foo: 1 } as OpenMeta, { foo: undefined } as OpenMeta)
    expect((m as OpenMeta)["foo"]).toBe(1)
  })

  it("sub-bag objects are merged one level deep (later wins per key)", () => {
    const m = mergeMeta(
      { tags: { readOnly: true, openWorld: true } },
      { tags: { readOnly: false } },
    )
    expect((m.tags as Tags).readOnly).toBe(false)   // overridden
    expect((m.tags as Tags).openWorld).toBe(true)   // inherited
  })

  it("arrays are concatenated, not replaced", () => {
    const m = mergeMeta({ roles: ["a"] } as OpenMeta, { roles: ["b", "c"] } as OpenMeta)
    expect((m as OpenMeta)["roles"]).toEqual(["a", "b", "c"])
  })

  it("undefined metas are skipped", () => {
    const m = mergeMeta(undefined, { x: 1 } as OpenMeta, undefined)
    expect((m as OpenMeta)["x"]).toBe(1)
  })

  it("key absent in later bag is inherited from earlier", () => {
    const m = mergeMeta({ a: 1, b: 2 } as OpenMeta, { b: 3 } as OpenMeta)
    expect((m as OpenMeta)["a"]).toBe(1)
    expect((m as OpenMeta)["b"]).toBe(3)
  })

  it("arrays at depth 2 (e.g. http.directives) concatenate", () => {
    const a = { kind: "verb", value: "GET" }
    const b = { kind: "moveTo", path: ".." }
    const m = mergeMeta(
      { http: { directives: [a] } } as OpenMeta,
      { http: { directives: [b] } } as OpenMeta,
    )
    expect(((m as OpenMeta).http as { directives: unknown[] }).directives).toEqual([a, b])
  })

  it("scalar keys nested in sub-bags still overwrite (later wins)", () => {
    const m = mergeMeta(
      { tags: { readOnly: true } },
      { tags: { readOnly: false } },
    )
    expect((m.tags as Tags).readOnly).toBe(false)
  })

  it("composing a verb bundle with an extra http contribution preserves both directive sets", () => {
    const verbGet = {
      tags: { readOnly: true },
      http: { directives: [{ kind: "verb", value: "GET" }, { kind: "method", value: "GET" }] },
    } as OpenMeta
    const m = mergeMeta(verbGet, { http: { directives: [{ kind: "moveTo", path: ".." }] } } as OpenMeta)
    expect(((m as OpenMeta).http as { directives: unknown[] }).directives).toEqual([
      { kind: "verb", value: "GET" },
      { kind: "method", value: "GET" },
      { kind: "moveTo", path: ".." },
    ])
    expect((m.tags as Tags).readOnly).toBe(true)
  })
})

// ============================================================================
// 8. api() — the branch-node constructor
// ============================================================================

describe("api()", () => {
  it("api(children) produces a Node whose children are exactly what was passed", () => {
    const children = { users: op(() => []) }
    expect(api(children)).toEqual({ children, meta: {} })
  })

  it("api(children, opts) forwards meta and fallback exactly as given", () => {
    const children = { users: op(() => []) }
    const meta: Meta = { tags: { readOnly: true } }
    const fallback = { name: "id", subtree: op(() => ({})) }
    expect(api(children, { meta, fallback })).toEqual(
      { children, meta, fallback },
    )
  })

  it("composes with nested api() calls", () => {
    const tree = api({
      users: api({ list: op(() => []) }),
    })
    expect(isNode(tree)).toBe(true)
    expect(isLeaf((tree.children?.["users"] as Node).children?.["list"] as Node)).toBe(true)
  })
})
