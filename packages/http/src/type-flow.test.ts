// packages/http/src/type-flow.test.ts — generic handler-type flow through the
// HTTP projection pipeline.
//
// ff7c579 made op()/api() generic so a concrete handler's real input/output
// types survive tree construction (Node<H>). This file checks how far that
// survives once the Node tree is projected through HttpRoute:
//
//   Node<H> --naiveTransform--> HttpRoute<H> --rewriters--> HttpRoute<H>
//
// `naiveTransform`, `applyMethods`, `applyResponse`, and `createApplyValidation`
// are all generic — each computes its return type recursively from its input's
// own type (see `NaiveRoute<N>`, `ApplyMethodsRoute<R>`, `ApplyResponseRoute<R>`
// in route.ts), so a concrete handler's real input/output type keeps flowing
// through the pipeline instead of widening to the erased `Handler`.
//
// `applyMoveTo` is the one deliberate erasure boundary: `moveTo` reads a path
// out of the open `meta` bag as a runtime string, so WHERE a subtree ends up
// is unknowable statically — see `applyMoveTo`'s doc comment in route.ts.

import { describe, expect, expectTypeOf, it } from "bun:test"
import { api, op } from "@rhi-zone/fractal-core/node"
import type { Handler } from "@rhi-zone/fractal-core/node"
import { applyMethods, applyMoveTo, applyResponse, naiveTransform } from "./route.ts"
import type { HttpRoute, ResponseOverride } from "./route.ts"

describe("Node layer: op()/api() preserve concrete handler types", () => {
  it("op(fn) keeps fn's real input/output types on node.handler", () => {
    const getBook = (input: { id: string }) => ({ title: "x", id: input.id })
    const leaf = op(getBook)

    expectTypeOf(leaf.handler).toEqualTypeOf<typeof getBook>()
    expectTypeOf(leaf.handler).not.toEqualTypeOf<Handler>()
  })

  it("api({ key: op(fn) }) keeps the concrete handler type on children.key.handler", () => {
    const getBook = (input: { id: string }) => ({ title: "x", id: input.id })
    const tree = api({ getBook: op(getBook) })

    expectTypeOf(tree.children.getBook.handler).toEqualTypeOf<typeof getBook>()
    expectTypeOf(tree.children.getBook.handler).not.toEqualTypeOf<Handler>()
  })
})

describe("HttpRoute layer: naiveTransform preserves the concrete handler type", () => {
  it("naiveTransform(leaf) keeps the leaf's real handler type on methods.POST.handler", () => {
    const getBook = (input: { id: string }) => ({ title: "x", id: input.id })
    const leaf = op(getBook)
    const route = naiveTransform(leaf)

    expect(route.methods.POST.handler).toBe(getBook)
    expectTypeOf(route.methods.POST.handler).toEqualTypeOf<typeof getBook>()
    expectTypeOf(route.methods.POST.handler).not.toEqualTypeOf<Handler>()
  })

  it("naiveTransform(tree) keeps each child's own handler type, independently", () => {
    const getBook = (input: { id: string }) => ({ title: "x", id: input.id })
    const listBooks = (_input: unknown) => [] as Array<{ title: string }>
    const tree = api({ getBook: op(getBook), listBooks: op(listBooks) })
    const route = naiveTransform(tree)

    expectTypeOf(route.children.getBook.methods.POST.handler).toEqualTypeOf<typeof getBook>()
    expectTypeOf(route.children.listBooks.methods.POST.handler).toEqualTypeOf<typeof listBooks>()
  })

  it("a pure branch node has no methods key at all (not just undefined)", () => {
    const tree = api({ getBook: op((input: { id: string }) => ({ id: input.id })) })
    const route = naiveTransform(tree)

    // @ts-expect-error — route has no top-level `methods`; it's a branch.
    route.methods
    expect((route as HttpRoute).methods).toBeUndefined()
  })
})

describe("applyMethods preserves the handler's concrete type across the rename", () => {
  it("a single-method entry's handler type survives even though the method KEY is dynamic", () => {
    const getBook = (input: { id: string }) => ({ title: "x", id: input.id })
    const leaf = op(getBook, { http: { directives: [{ kind: "method", value: "GET" }] } })
    const route = applyMethods(naiveTransform(leaf))

    expect(Object.keys(route.methods)).toEqual(["GET"])
    const anyKey = Object.keys(route.methods)[0]!
    expectTypeOf(route.methods[anyKey]!.handler).toEqualTypeOf<typeof getBook>()
  })
})

describe("applyResponse widens the handler type to a union (wrapped or not)", () => {
  it("the resulting handler type is 'original | response-wrapped', not erased to any", () => {
    const getBook = (input: { id: string }) => ({ title: "x", id: input.id })
    const leaf = op(getBook, { http: { directives: [{ kind: "response", status: 201 }] } })
    const route = applyResponse(naiveTransform(leaf))

    type ExpectedHandler = typeof getBook | ((input: unknown) => Promise<ResponseOverride>)
    expectTypeOf(route.methods.POST.handler).toEqualTypeOf<ExpectedHandler>()
  })
})

describe("applyMoveTo is the deliberate erasure boundary", () => {
  it("moveTo repositions subtrees based on a runtime string, so the result is the plain erased HttpRoute", () => {
    const getBook = (input: { id: string }) => ({ title: "x", id: input.id })
    const tree = api({ getBook: op(getBook, { http: { directives: [{ kind: "moveTo", path: "../book" }] } }) })
    const route = applyMoveTo(naiveTransform(tree))

    // Statically only the erased HttpRoute shape is known — no children/
    // methods keys are guaranteed present at the type level, unlike the
    // naiveTransform/applyMethods/applyResponse cases above.
    expectTypeOf(route).toEqualTypeOf<HttpRoute>()
    expect(route.children?.book?.methods?.POST).toBeDefined()
  })
})
