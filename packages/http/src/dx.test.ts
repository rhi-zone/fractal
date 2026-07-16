// packages/http/src/dx.test.ts — crud() and httpProjection() DX sugar tests

import { describe, expect, it } from "bun:test"
import { isLeaf } from "@rhi-zone/fractal-core/node"
import type { Node } from "@rhi-zone/fractal-core/node"
import { crud, httpProjection } from "./dx.ts"
import { naiveTransform } from "./route.ts"
import type { HttpDirective } from "./project.ts"

function methodDirective(n: Node): string | undefined {
  const http_ = n.meta.http as { directives: readonly HttpDirective[] } | undefined
  return http_?.directives.find((d) => d.kind === "method")?.value
}

// ============================================================================
// crud() — all handlers
// ============================================================================

describe("crud() with all handlers", () => {
  const list = (_: unknown) => []
  const create = (_: unknown) => ({})
  const get = (_: unknown) => ({})
  const update = (_: unknown) => ({})
  const del = (_: unknown) => ({})

  const tree = crud({ list, create, get, update, delete: del })

  it("produces a branch node with one child per handler", () => {
    expect(Object.keys(tree.children ?? {}).sort()).toEqual(
      ["create", "delete", "get", "list", "update"],
    )
  })

  it("each child is a leaf node wrapping the given handler", () => {
    expect(isLeaf(tree.children?.list as Node)).toBe(true)
    expect((tree.children?.list as Node).handler).toBe(list)
    expect((tree.children?.create as Node).handler).toBe(create)
    expect((tree.children?.get as Node).handler).toBe(get)
    expect((tree.children?.update as Node).handler).toBe(update)
    expect((tree.children?.delete as Node).handler).toBe(del)
  })

  it("sets the correct HTTP method directive per operation", () => {
    expect(methodDirective(tree.children?.list as Node)).toBe("GET")
    expect(methodDirective(tree.children?.create as Node)).toBe("POST")
    expect(methodDirective(tree.children?.get as Node)).toBe("GET")
    expect(methodDirective(tree.children?.update as Node)).toBe("PUT")
    expect(methodDirective(tree.children?.delete as Node)).toBe("DELETE")
  })
})

// ============================================================================
// crud() — partial handlers
// ============================================================================

describe("crud() with partial handlers", () => {
  const list = (_: unknown) => []
  const create = (_: unknown) => ({})

  const tree = crud({ list, create })

  it("only produces children for the handlers provided", () => {
    expect(Object.keys(tree.children ?? {}).sort()).toEqual(["create", "list"])
  })

  it("omits get/update/delete entirely", () => {
    expect(tree.children?.get).toBeUndefined()
    expect(tree.children?.update).toBeUndefined()
    expect(tree.children?.delete).toBeUndefined()
  })
})

describe("crud() with no handlers", () => {
  it("produces a branch node with no children", () => {
    const tree = crud({})
    expect(tree.children).toEqual({})
  })
})

// ============================================================================
// httpProjection() — default transforms
// ============================================================================

describe("httpProjection() with default transforms", () => {
  const list = (_: unknown) => []
  const create = (_: unknown) => ({})

  it("applies the standard rewriter pipeline (methods renamed off the POST default)", () => {
    const tree = crud({ list, create })
    const routes = httpProjection(tree)
    expect(Object.keys(routes.children?.list?.methods ?? {})).toEqual(["GET"])
    expect(Object.keys(routes.children?.create?.methods ?? {})).toEqual(["POST"])
  })

  it("is equivalent to composeTransforms(applyMethods, applyPlacement, applyResponse)(naiveTransform(tree))", async () => {
    const { applyMethods, applyPlacement, applyResponse, composeTransforms } = await import("./route.ts")
    const tree = crud({ list, create })
    const expected = composeTransforms(applyMethods, applyPlacement, applyResponse)(naiveTransform(tree))
    expect(httpProjection(tree)).toEqual(expected)
  })
})

// ============================================================================
// httpProjection() — custom transforms
// ============================================================================

describe("httpProjection() with custom transforms", () => {
  it("uses exactly the transforms passed in opts.transforms, in order", () => {
    const list = (_: unknown) => []
    const tree = crud({ list })

    const calls: string[] = []
    const tap = (label: string) => (r: import("./route.ts").HttpRoute) => {
      calls.push(label)
      return r
    }

    httpProjection(tree, { transforms: [tap("a"), tap("b")] })
    expect(calls).toEqual(["a", "b"])
  })

  it("an empty transforms array yields the naive transform unchanged", () => {
    const list = (_: unknown) => []
    const tree = crud({ list })
    const routes = httpProjection(tree, { transforms: [] })
    // No applyMethods run — the naive default POST entry is left untouched.
    expect(Object.keys(routes.children?.list?.methods ?? {})).toEqual(["POST"])
  })
})
