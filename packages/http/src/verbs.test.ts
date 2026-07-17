// packages/http/src/verbs.test.ts — verb-helper bundle tests
//
// Proves:
//   1. http.put on an op yields BOTH a verb directive PUT AND resolveTags → idempotent
//   2. http.get on an op yields BOTH a verb directive GET AND resolveTags → readOnly
//   3. http.delete on an op yields verb DELETE + destructive + idempotent
//   4. http.post / http.patch: verb set, no implied tags
//   5. Composing op(fn, http.put, { tags: { destructive: false } }) deep-merges:
//      keeps idempotent from the bundle AND applies the override — NOT a spread
//      that drops the bundle's tags
//   6. verbFromTags respects the meta.http verb directive from the bundle (GET, not POST)
//   7. head / options helpers exist and carry readOnly

import { describe, expect, it } from "bun:test"
import { mergeMeta, op } from "@rhi-zone/fractal-api-tree/node"
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags"
import type { Tags } from "@rhi-zone/fractal-api-tree/tags"
import { http } from "./verbs.ts"
import { verbFromTags } from "./project.ts"
import type { HttpDirective } from "./project.ts"

// ============================================================================
// Helpers
// ============================================================================

const noop = (_: unknown) => {}

function tags(n: ReturnType<typeof op>): Tags {
  return (n.meta.tags ?? {}) as Tags
}

function verbDirective(n: ReturnType<typeof op>): string | undefined {
  const http_ = n.meta.http as { directives: readonly HttpDirective[] } | undefined
  return http_?.directives.find((d) => d.kind === "verb")?.value
}

function methodDirective(n: ReturnType<typeof op>): string | undefined {
  const http_ = n.meta.http as { directives: readonly HttpDirective[] } | undefined
  return http_?.directives.find((d) => d.kind === "method")?.value
}

// ============================================================================
// 1. http.put → verb PUT + idempotent tag → MCP idempotentHint
// ============================================================================

describe("http.put bundle", () => {
  const n = op(noop, http.put)

  it("verb directive is PUT", () => {
    expect(verbDirective(n)).toBe("PUT")
  })

  it("verbFromTags respects the verb directive → PUT (not tag-derived)", () => {
    expect(verbFromTags(n.meta)).toBe("PUT")
  })

  it("meta.tags.idempotent is true", () => {
    expect(tags(n).idempotent).toBe(true)
  })

  it("resolveTags → idempotent:true (MCP idempotentHint surface)", () => {
    const resolved = resolveTags(tags(n))
    expect(resolved.idempotent).toBe(true)
  })

  it("resolveTags → readOnly is NOT set (PUT is not readOnly)", () => {
    const resolved = resolveTags(tags(n))
    expect(resolved.readOnly).toBeUndefined()
  })
})

// ============================================================================
// 2. http.get → verb GET + readOnly tag → MCP readOnlyHint
// ============================================================================

describe("http.get bundle", () => {
  const n = op(noop, http.get)

  it("verb directive is GET", () => {
    expect(verbDirective(n)).toBe("GET")
  })

  it("verbFromTags respects the verb directive → GET", () => {
    expect(verbFromTags(n.meta)).toBe("GET")
  })

  it("meta.tags.readOnly is true", () => {
    expect(tags(n).readOnly).toBe(true)
  })

  it("resolveTags → readOnly:true (MCP readOnlyHint surface)", () => {
    const resolved = resolveTags(tags(n))
    expect(resolved.readOnly).toBe(true)
  })

  it("resolveTags → idempotent:true (lattice: readOnly ⇒ idempotent)", () => {
    const resolved = resolveTags(tags(n))
    expect(resolved.idempotent).toBe(true)
  })
})

// ============================================================================
// 3. http.delete → verb DELETE + destructive + idempotent
// ============================================================================

describe("http.delete bundle", () => {
  const n = op(noop, http.delete)

  it("verb directive is DELETE", () => {
    expect(verbDirective(n)).toBe("DELETE")
  })

  it("verbFromTags → DELETE", () => {
    expect(verbFromTags(n.meta)).toBe("DELETE")
  })

  it("meta.tags.destructive is true", () => {
    expect(tags(n).destructive).toBe(true)
  })

  it("meta.tags.idempotent is true", () => {
    expect(tags(n).idempotent).toBe(true)
  })

  it("resolveTags → destructive:true AND idempotent:true", () => {
    const resolved = resolveTags(tags(n))
    expect(resolved.destructive).toBe(true)
    expect(resolved.idempotent).toBe(true)
  })
})

// ============================================================================
// 4. http.post and http.patch — plain mutations, no implied tags
// ============================================================================

describe("http.post bundle", () => {
  const n = op(noop, http.post)

  it("verb directive is POST", () => {
    expect(verbDirective(n)).toBe("POST")
  })

  it("resolveTags → no readOnly, no idempotent, no destructive", () => {
    const resolved = resolveTags(tags(n))
    expect(resolved.readOnly).toBeUndefined()
    expect(resolved.idempotent).toBeUndefined()
    expect(resolved.destructive).toBeUndefined()
  })
})

describe("http.patch bundle", () => {
  const n = op(noop, http.patch)

  it("verb directive is PATCH", () => {
    expect(verbDirective(n)).toBe("PATCH")
  })

  it("resolveTags → no implied tags", () => {
    const resolved = resolveTags(tags(n))
    expect(resolved.readOnly).toBeUndefined()
    expect(resolved.idempotent).toBeUndefined()
  })
})

// ============================================================================
// 5. Composition: op(fn, http.put, { tags: { destructive: false } })
//    deep-merges — keeps idempotent from bundle AND applies destructive:false
//    Proves mergeMeta, NOT object spread (spread would clobber bundle's tags)
// ============================================================================

describe("op multi-contribution merge (bundle + extra)", () => {
  const n = op(noop, http.put, { tags: { destructive: false } })

  it("idempotent:true from http.put bundle is PRESERVED", () => {
    expect(tags(n).idempotent).toBe(true)
  })

  it("destructive:false from extra contribution is applied", () => {
    expect(tags(n).destructive).toBe(false)
  })

  it("verb directive from bundle is preserved after merge", () => {
    expect(verbDirective(n)).toBe("PUT")
  })

  it("verbFromTags still resolves to PUT (verb directive wins)", () => {
    expect(verbFromTags(n.meta)).toBe("PUT")
  })

  it("resolveTags: idempotent:true, destructive:false (not undefined)", () => {
    const resolved = resolveTags(tags(n))
    expect(resolved.idempotent).toBe(true)
    expect(resolved.destructive).toBe(false)
  })
})

// ============================================================================
// 6. op with no contributions → empty meta (backward compat)
// ============================================================================

describe("op with no contributions", () => {
  const n = op(noop)

  it("meta is empty object", () => {
    expect(n.meta).toEqual({})
  })
})

// ============================================================================
// 7. http.head and http.options helpers exist
// ============================================================================

describe("http.head bundle", () => {
  it("verb directive is HEAD", () => {
    expect(http.head.http.directives.find((d) => d.kind === "verb")?.value).toBe("HEAD")
  })

  it("carries readOnly tag", () => {
    expect(http.head.tags.readOnly).toBe(true)
  })
})

describe("http.options bundle", () => {
  it("verb directive is OPTIONS", () => {
    expect(http.options.http.directives.find((d) => d.kind === "verb")?.value).toBe("OPTIONS")
  })

  it("carries readOnly tag", () => {
    expect(http.options.tags.readOnly).toBe(true)
  })
})

// ============================================================================
// 8. `kind: "method"` directives — read by the HttpRoute rewriter pipeline
// (applyMethods in route.ts), added ALONGSIDE the legacy `kind: "verb"`
// directive (read by verbFromTags, the direct tree-walk projector) — both
// describe the same fact for two different projectors, neither clobbers
// the other.
// ============================================================================

describe("http.* bundles carry a method directive alongside the verb directive", () => {
  it("http.get: method directive is GET, verb directive is also GET", () => {
    const n = op(noop, http.get)
    expect(methodDirective(n)).toBe("GET")
    expect(verbDirective(n)).toBe("GET")
  })

  it("http.post: method directive is POST", () => {
    expect(methodDirective(op(noop, http.post))).toBe("POST")
  })

  it("http.put: method directive is PUT", () => {
    expect(methodDirective(op(noop, http.put))).toBe("PUT")
  })

  it("http.patch: method directive is PATCH", () => {
    expect(methodDirective(op(noop, http.patch))).toBe("PATCH")
  })

  it("http.delete: method directive is DELETE", () => {
    expect(methodDirective(op(noop, http.delete))).toBe("DELETE")
  })
})

// ============================================================================
// 9. http.moveTo(path) — DX helper returning a plain Meta with a single
// `moveTo` directive, designed to compose with a verb bundle via mergeMeta
// (see route.ts § applyMoveTo for the directive itself).
// ============================================================================

describe("http.moveTo", () => {
  it("returns the expected Meta shape", () => {
    expect(http.moveTo("..")).toEqual({
      http: { directives: [{ kind: "moveTo", path: ".." }] },
    })
  })

  it("mergeMeta(http.get, http.moveTo('..')) carries verb + method + moveTo directives", () => {
    const merged = mergeMeta(http.get, http.moveTo(".."))
    const directives = (merged.http as { directives: readonly HttpDirective[] }).directives
    expect(directives).toEqual([
      { kind: "verb", value: "GET" },
      { kind: "method", value: "GET" },
      { kind: "moveTo", path: ".." },
    ])
  })

  it("op(fn, http.get, http.moveTo('..')) yields the same meta as manual directive construction", () => {
    const n = op(noop, http.get, http.moveTo(".."))
    expect(methodDirective(n)).toBe("GET")
    expect(verbDirective(n)).toBe("GET")
    const directives = (n.meta.http as { directives: readonly HttpDirective[] }).directives
    expect(directives.find((d) => d.kind === "moveTo")).toEqual({ kind: "moveTo", path: ".." })
  })
})
