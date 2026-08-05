// packages/http-api-projector/src/verbs.test.ts — verb-helper bundle tests
//
// Proves:
//   1. http.put on an op yields BOTH a verb GET/method PUT flat key AND resolveTags → idempotent
//   2. http.get on an op yields BOTH a verb/method flat key GET AND resolveTags → readOnly
//   3. http.delete on an op yields verb DELETE + destructive + idempotent
//   4. http.post / http.patch: verb set, no implied tags
//   5. Composing op(fn, http.put, { tags: { destructive: false } }) deep-merges:
//      keeps idempotent from the bundle AND applies the override — NOT a spread
//      that drops the bundle's tags
//   6. verbFromTags respects the meta.http.verb flat key from the bundle (GET, not POST)
//   7. head / options helpers exist and carry readOnly
//   8. http.source(map): string shorthand expands to a full ParamSource,
//      full-form values pass through unchanged, and two http.source() calls
//      compose their sourceMaps via ordinary meta merge (mergeMeta) — key-merged,
//      not concatenated

import { describe, expect, expectTypeOf, it } from "bun:test"
import { mergeMeta, op } from "@rhi-zone/fractal-api-tree/node"
import type { FindStoreForParam } from "@rhi-zone/fractal-api-tree"
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags"
import type { Tags } from "@rhi-zone/fractal-api-tree/tags"
import type { ParamSource } from "@rhi-zone/fractal-api-tree"
import { http } from "./verbs.ts"
import { getHttpMeta, verbFromTags } from "./project.ts"
import type { HttpLeafMetaProperties } from "./project.ts"

// ============================================================================
// Helpers
// ============================================================================

const noop = (_: unknown) => {}

function tags(n: ReturnType<typeof op>): Tags {
  return (n.meta.tags ?? {}) as Tags
}

function verbDirective(n: ReturnType<typeof op>): string | undefined {
  const http_ = n.meta.http as { verb?: string } | undefined
  return http_?.verb
}

function methodDirective(n: ReturnType<typeof op>): string | undefined {
  const http_ = n.meta.http as { method?: string } | undefined
  return http_?.method
}

// ============================================================================
// 1. http.put → verb PUT + idempotent tag → MCP idempotentHint
// ============================================================================

describe("http.put bundle", () => {
  const n = op(noop, http.put)

  it("verb flat key is PUT", () => {
    expect(verbDirective(n)).toBe("PUT")
  })

  it("verbFromTags respects the verb flat key → PUT (not tag-derived)", () => {
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

  it("verb flat key is GET", () => {
    expect(verbDirective(n)).toBe("GET")
  })

  it("verbFromTags respects the verb flat key → GET", () => {
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

  it("verb flat key is DELETE", () => {
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

  it("verb flat key is POST", () => {
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

  it("verb flat key is PATCH", () => {
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

  it("verb flat key from bundle is preserved after merge", () => {
    expect(verbDirective(n)).toBe("PUT")
  })

  it("verbFromTags still resolves to PUT (verb flat key wins)", () => {
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
  it("verb flat key is HEAD", () => {
    expect(http.head.http.verb).toBe("HEAD")
  })

  it("carries readOnly tag", () => {
    expect(http.head.tags.readOnly).toBe(true)
  })
})

describe("http.options bundle", () => {
  it("verb flat key is OPTIONS", () => {
    expect(http.options.http.verb).toBe("OPTIONS")
  })

  it("carries readOnly tag", () => {
    expect(http.options.tags.readOnly).toBe(true)
  })
})

// ============================================================================
// 8. `method` flat key — read by the HttpRoute rewriter pipeline
// (applyMethods in route.ts), set ALONGSIDE the `verb` flat key (read by
// verbFromTags, the direct tree-walk projector) — both describe the same
// fact for two different projectors, neither clobbers the other.
// ============================================================================

describe("http.* bundles carry a method flat key alongside the verb flat key", () => {
  it("http.get: method flat key is GET, verb flat key is also GET", () => {
    const n = op(noop, http.get)
    expect(methodDirective(n)).toBe("GET")
    expect(verbDirective(n)).toBe("GET")
  })

  it("http.post: method flat key is POST", () => {
    expect(methodDirective(op(noop, http.post))).toBe("POST")
  })

  it("http.put: method flat key is PUT", () => {
    expect(methodDirective(op(noop, http.put))).toBe("PUT")
  })

  it("http.patch: method flat key is PATCH", () => {
    expect(methodDirective(op(noop, http.patch))).toBe("PATCH")
  })

  it("http.delete: method flat key is DELETE", () => {
    expect(methodDirective(op(noop, http.delete))).toBe("DELETE")
  })
})

// ============================================================================
// 9. http.moveTo(path) — DX helper returning a plain Meta with a single
// `moveTo` flat key, designed to compose with a verb bundle via mergeMeta's
// last-wins scalar merge (see route.ts § applyMoveTo for the directive itself).
// ============================================================================

describe("http.moveTo", () => {
  it("returns the expected Meta shape", () => {
    expect(http.moveTo("..")).toEqual({
      http: { moveTo: ".." },
    })
  })

  it("mergeMeta(http.get, http.moveTo('..')) carries verb + method + moveTo flat keys", () => {
    const merged = mergeMeta(http.get, http.moveTo(".."))
    expect(merged.http).toEqual({ verb: "GET", method: "GET", moveTo: ".." })
  })

  it("op(fn, http.get, http.moveTo('..')) yields the same meta as manual flat-key construction", () => {
    const n = op(noop, http.get, http.moveTo(".."))
    expect(methodDirective(n)).toBe("GET")
    expect(verbDirective(n)).toBe("GET")
    expect((n.meta.http as { moveTo?: string } | undefined)?.moveTo).toBe("..")
  })
})

// ============================================================================
// 10. http.source(map) — per-param HTTP store overrides. A bare, KEY-MERGED
// `meta.http.sourceMap` map (like moveTo/paginated, a flat key), NOT a
// directive array — composing two http.source() calls key-merges their maps
// directly at op()'s own FoldMeta fold (later call's keys win on overlap).
// See verbs.ts's source() doc comment for the empirical verification this
// relies on (scratch tsc + bun run, during the http-directive-dissolution
// migration).
// ============================================================================

function sourceMapOf(n: ReturnType<typeof op>): Record<string, ParamSource> | undefined {
  return getHttpMeta(n.meta).sourceMap as Record<string, ParamSource> | undefined
}

describe("http.source", () => {
  it("expands string shorthand to a full ParamSource, keyed by the param's own name", () => {
    expect(http.source({ year: "query" })).toEqual({
      http: { sourceMap: { year: { store: "query", key: "year" } } },
    })
  })

  it("passes the full form through unchanged", () => {
    expect(http.source({ months: { store: "body", key: "budgetMonths" } })).toEqual({
      http: { sourceMap: { months: { store: "body", key: "budgetMonths" } } },
    })
  })

  it("mixes shorthand and full form in one call", () => {
    expect(
      http.source({
        year: "query",
        months: { store: "body", key: "budgetMonths" },
      }),
    ).toEqual({
      http: {
        sourceMap: {
          year: { store: "query", key: "year" },
          months: { store: "body", key: "budgetMonths" },
        },
      },
    })
  })

  it("op(fn, http.source(map)) carries the sourceMap onto the leaf's meta (via getHttpMeta)", () => {
    const n = op(noop, http.source({ year: "query" }))
    expect(sourceMapOf(n)).toEqual({ year: { store: "query", key: "year" } })
  })

  it("two http.source() calls key-merge into one sourceMap object (disjoint keys)", () => {
    const merged = mergeMeta(http.source({ year: "query" }), http.source({ months: "body" }))
    expect((merged.http as HttpLeafMetaProperties).sourceMap).toEqual({
      year: { store: "query", key: "year" },
      months: { store: "body", key: "months" },
    })
  })

  it("getHttpMeta reads the already-merged sourceMap straight off meta.http (no read-time fold needed)", () => {
    const merged = mergeMeta(http.source({ year: "query" }), http.source({ months: "body" }))
    expect(getHttpMeta(merged).sourceMap).toEqual({
      year: { store: "query", key: "year" },
      months: { store: "body", key: "months" },
    })
  })

  it("a later http.source() call overrides an earlier one's key on overlap — WHOLESALE (not field-merged), same key-merge semantics node.ts's mergeRecords depth-cap gives every map-shaped meta value", () => {
    const merged = mergeMeta(
      http.source({ year: { store: "query", key: "fiscal_year" } }),
      http.source({ year: "header" }),
    )
    expect(getHttpMeta(merged).sourceMap).toEqual({
      year: { store: "header", key: "year" },
    })
  })

  it("composes with a verb bundle without either clobbering the other", () => {
    const n = op(noop, http.get, http.source({ year: "query" }))
    expect(methodDirective(n)).toBe("GET")
    expect(sourceMapOf(n)).toEqual({ year: { store: "query", key: "year" } })
  })

  it("type safety: only registered HTTP store names compile (checked by `bun run typecheck`, not at runtime)", () => {
    // All five built-in stores (decode.ts's HttpStoreRegistry) compile, both
    // shorthand and full form.
    http.source({ a: "path", b: "query", c: "header", d: "body", e: "caller" })
    http.source({ a: { store: "path" }, b: { store: "query", key: "k" } })

    // An unregistered store name is a compile-time error — this line only
    // typechecks BECAUSE it's wrong; if `store` accepted a bare `string`
    // (the design decision this test guards against), `@ts-expect-error`
    // itself would fail with "Unused '@ts-expect-error' directive" under
    // `bun run typecheck`.
    // @ts-expect-error — "carrierPigeon" is not a registered HttpStore
    http.source({ f: "carrierPigeon" })

    expect(true).toBe(true)
  })
})

// ============================================================================
// Static source coverage — docs/design/typed-store-spec.md §6
//
// These assert at COMPILE time (`bun run typecheck`); the runtime bodies exist
// only so `bun test` reports them. A `@ts-expect-error` that stops being an
// error fails typecheck with "Unused '@ts-expect-error' directive", so each
// negative case genuinely guards its invariant.
// ============================================================================

describe("http.source() preserves literal key/store association (§6)", () => {
  it("a source() map's keys and stores survive as literal types on meta.http.sourceMap", () => {
    const getBudget = (input: { year: string; months: string }) => input
    const n = op(getBudget, http.get, http.source({ year: "query" }), http.source({ months: { store: "body", key: "budgetMonths" } }))

    // The literal association is what the type-level read needs — walking
    // `n.meta` directly (no directive tuple to extract anymore, see
    // api-tree's input.ts's `FindStoreForParam`).
    type Meta = typeof n.meta
    expectTypeOf<FindStoreForParam<Meta, "year">>().toEqualTypeOf<"query">()
    expectTypeOf<FindStoreForParam<Meta, "months">>().toEqualTypeOf<"body">()
    // A param no source() call names falls through to the path/convention
    // steps, which are runtime-resolved — `never` is "not statically declared".
    type NopeUnresolved = [FindStoreForParam<Meta, "nope">] extends [never] ? true : false
    expectTypeOf<NopeUnresolved>().toEqualTypeOf<true>()

    // Runtime agrees with the type.
    expect(sourceMapOf(n)).toEqual({
      year: { store: "query", key: "year" },
      months: { store: "body", key: "budgetMonths" },
    })
  })

  it("the LAST source() call naming a param wins", () => {
    const getBudget = (input: { year: string }) => input
    const n = op(getBudget, http.source({ year: "query" }), http.source({ year: "header" }))

    type Meta = typeof n.meta
    expectTypeOf<FindStoreForParam<Meta, "year">>().toEqualTypeOf<"header">()

    expect(sourceMapOf(n)).toEqual({ year: { store: "header", key: "year" } })
  })
})

describe("op() rejects a source() param the handler doesn't declare (§6)", () => {
  it("a mistyped param name in source() is a compile error at the op() call site", () => {
    const getBudget = (input: { year: string; months: string }) => input

    // Covered: every source()-named param is a declared handler input.
    op(getBudget, http.source({ year: "query", months: "body" }))

    // @ts-expect-error — "yearr" is not one of getBudget's input keys, so this
    // override would assemble a param the handler never reads while `year`
    // silently fell through to the method convention.
    op(getBudget, http.source({ yearr: "query" }))

    expect(true).toBe(true)
  })

  it("stays vacuous when the handler's input keys aren't statically known", () => {
    // No declared input, an open record, and an erased input type must all pass
    // — the check speaks only when it actually knows the handler's key set.
    op((_input: unknown) => "x", http.source({ anything: "query" }))
    op((_input: Record<string, unknown>) => "x", http.source({ anything: "query" }))
    op((_input: unknown) => "x", http.source({ anything: "query" }))

    expect(true).toBe(true)
  })
})
