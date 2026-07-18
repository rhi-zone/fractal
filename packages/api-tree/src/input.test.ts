// packages/api-tree/src/input.test.ts — input resolution pipeline

import { describe, expect, it } from "bun:test"
import { assemble, createStore } from "./input.ts"

describe("assemble", () => {
  it("resolves params from the primary store by convention", () => {
    const stores = {
      query: createStore({ a: "1", b: "2" }),
    }
    const result = assemble(stores, ["a", "b"], {}, "query")
    expect(result.values).toEqual({ a: "1", b: "2" })
  })

  it("applies sourceMap overrides ahead of the primary store", () => {
    const stores = {
      query: createStore({ a: "from-query" }),
      header: createStore({ a: "from-header" }),
    }
    const result = assemble(
      stores,
      ["a"],
      { a: { store: "header" } },
      "query",
    )
    expect(result.values).toEqual({ a: "from-header" })
  })

  it("applies sourceMap overrides with a remapped key", () => {
    const stores = {
      query: createStore({}),
      header: createStore({ "x-a": "from-header-key" }),
    }
    const result = assemble(
      stores,
      ["a"],
      { a: { store: "header", key: "x-a" } },
      "query",
    )
    expect(result.values).toEqual({ a: "from-header-key" })
  })

  it("prefers pathParamNames over sourceMap and primary store", () => {
    const stores = {
      path: createStore({ id: "path-id" }),
      query: createStore({ id: "query-id" }),
    }
    const result = assemble(
      stores,
      ["id"],
      { id: { store: "query" } },
      "query",
      ["id"],
    )
    expect(result.values).toEqual({ id: "path-id" })
  })

  it("returns undefined values for params missing from their store", () => {
    const stores = { query: createStore({}) }
    const result = assemble(stores, ["missing"], {}, "query")
    expect(result.values).toEqual({ missing: undefined })
  })

  describe("provenance", () => {
    it("reports the primary store for convention-resolved params", () => {
      const stores = { query: createStore({ a: "1" }) }
      const result = assemble(stores, ["a"], {}, "query")
      expect(result.provenance("a")).toEqual({ store: "query", key: "a" })
    })

    it("reports the sourceMap override for overridden params", () => {
      const stores = {
        query: createStore({}),
        header: createStore({ "x-a": "v" }),
      }
      const result = assemble(
        stores,
        ["a"],
        { a: { store: "header", key: "x-a" } },
        "query",
      )
      expect(result.provenance("a")).toEqual({ store: "header", key: "x-a" })
    })

    it("reports the path store for path params", () => {
      const stores = { path: createStore({ id: "1" }), query: createStore({}) }
      const result = assemble(stores, ["id"], {}, "query", ["id"])
      expect(result.provenance("id")).toEqual({ store: "path", key: "id" })
    })

    it("still reports where a missing param would resolve from", () => {
      const stores = { query: createStore({}) }
      const result = assemble(stores, ["missing"], {}, "query")
      expect(result.provenance("missing")).toEqual({
        store: "query",
        key: "missing",
      })
    })

    it("resolves provenance for a param not in paramNames at all, on demand", () => {
      const stores = { query: createStore({}) }
      const result = assemble(stores, [], {}, "query")
      expect(result.provenance("anything")).toEqual({
        store: "query",
        key: "anything",
      })
    })
  })
})

describe("createStore", () => {
  it("wraps a plain object as a Store", () => {
    const store = createStore({ a: 1, b: "two" })
    expect(store.get("a")).toBe(1)
    expect(store.get("b")).toBe("two")
    expect(store.get("missing")).toBeUndefined()
  })
})
