import { describe, expect, it } from "bun:test"

import { defineRegistry, has, lookup, mergeRegistries, type RegistryEntry } from "./registry-core.ts"

interface Thing extends RegistryEntry {
  readonly value: number
}

const a: Thing = { id: "a", value: 1 }
const b: Thing = { id: "b", value: 2 }

describe("defineRegistry", () => {
  it("preserves registration order in ids and entries", () => {
    const registry = defineRegistry([b, a])
    expect(registry.ids).toEqual(["b", "a"])
    expect(registry.entries).toEqual([b, a])
  })

  it("resolves aliases to the same entry instance", () => {
    const registry = defineRegistry([a], { first: "a" })
    expect(registry.byId.get("first")).toBe(a)
    // Aliases never enter the canonical listing.
    expect(registry.ids).toEqual(["a"])
  })

  it("rejects duplicate canonical ids", () => {
    expect(() => defineRegistry([a, { id: "a", value: 9 }])).toThrow(/duplicate registry id: a/)
  })

  it("rejects an alias that shadows a canonical id", () => {
    expect(() => defineRegistry([a, b], { a: "b" })).toThrow(/collides with an existing id/)
  })

  it("rejects a dangling alias", () => {
    expect(() => defineRegistry([a], { first: "nope" })).toThrow(/targets unknown id nope/)
  })
})

describe("mergeRegistries", () => {
  it("spans both registries under one id space", () => {
    const merged = mergeRegistries(defineRegistry([a]), defineRegistry([b]))
    expect(merged.ids).toEqual(["a", "b"])
    expect(lookup(merged, "thing", "b")).toBe(b)
  })

  it("carries aliases across the merge", () => {
    const merged = mergeRegistries(defineRegistry([a], { first: "a" }), defineRegistry([b]))
    expect(merged.byId.get("first")).toBe(a)
  })

  it("rejects conflicting ids rather than silently picking a winner", () => {
    expect(() => mergeRegistries(defineRegistry([a]), defineRegistry([{ id: "a", value: 9 }]))).toThrow(
      /conflicting registry id when merging: a/,
    )
  })

  it("is idempotent for the same entry instance registered twice", () => {
    const registry = defineRegistry([a])
    expect(() => mergeRegistries(registry, registry)).not.toThrow()
  })

  it("merges nothing into an empty registry without complaint", () => {
    expect(mergeRegistries<Thing>().ids).toEqual([])
  })
})

describe("lookup", () => {
  it("names the kind in the error so a typo is diagnosable", () => {
    expect(() => lookup(defineRegistry([a]), "output format", "zz")).toThrow(/unknown output format: zz/)
  })

  it("has() answers without throwing", () => {
    const registry = defineRegistry([a])
    expect(has(registry, "a")).toBe(true)
    expect(has(registry, "zz")).toBe(false)
  })
})
