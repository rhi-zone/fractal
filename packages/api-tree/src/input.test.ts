// packages/api-tree/src/input.test.ts — input resolution pipeline

import { describe, expect, it } from "bun:test"
import { assemble } from "./input.ts"

describe("assemble", () => {
  it("resolves params from the primary store by convention", () => {
    const stores = {
      query: { a: "1", b: "2" },
    }
    const result = assemble(stores, ["a", "b"], {}, "query")
    expect(result).toEqual({ a: "1", b: "2" })
  })

  it("applies sourceMap overrides ahead of the primary store", () => {
    const stores = {
      query: { a: "from-query" },
      header: { a: "from-header" },
    }
    const result = assemble(
      stores,
      ["a"],
      { a: { store: "header" } },
      "query",
    )
    expect(result).toEqual({ a: "from-header" })
  })

  it("applies sourceMap overrides with a remapped key", () => {
    const stores = {
      query: {},
      header: { "x-a": "from-header-key" },
    }
    const result = assemble(
      stores,
      ["a"],
      { a: { store: "header", key: "x-a" } },
      "query",
    )
    expect(result).toEqual({ a: "from-header-key" })
  })

  it("prefers pathParamNames over sourceMap and primary store", () => {
    const stores = {
      path: { id: "path-id" },
      query: { id: "query-id" },
    }
    const result = assemble(
      stores,
      ["id"],
      { id: { store: "query" } },
      "query",
      ["id"],
    )
    expect(result).toEqual({ id: "path-id" })
  })

  it("returns undefined values for params missing from their store", () => {
    const stores = { query: {} }
    const result = assemble(stores, ["missing"], {}, "query")
    expect(result).toEqual({ missing: undefined })
  })
})
