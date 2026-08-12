import { describe, expect, test } from "bun:test"
import { interpolatePath, pathParamNames } from "./path-template.ts"

describe("pathParamNames", () => {
  test("extracts every {param} segment in order", () => {
    expect(pathParamNames("/books/{id}/reviews/{reviewId}")).toEqual(["id", "reviewId"])
  })

  test("empty array for a path with no params", () => {
    expect(pathParamNames("/books/list")).toEqual([])
  })
})

describe("interpolatePath", () => {
  test("substitutes every param from the values map", () => {
    expect(interpolatePath("/books/{id}/reviews/{reviewId}", { id: "42", reviewId: "7" })).toBe(
      "/books/42/reviews/7",
    )
  })

  test("percent-encodes values that need it", () => {
    expect(interpolatePath("/search/{q}", { q: "a b/c" })).toBe("/search/a%20b%2Fc")
  })

  test("missing values interpolate as empty string, not the literal token", () => {
    expect(interpolatePath("/books/{id}", {})).toBe("/books/")
  })
})
