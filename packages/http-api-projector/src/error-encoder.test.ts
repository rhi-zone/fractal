// packages/http-api-projector/src/error-encoder.test.ts — structured error
// types: composable error-to-transport mapping (HttpErrorEncoder/httpErrors)
// and its thrown-error counterpart (ThrownErrorEncoder).
//
// Covers: a handler returns `err({ kind, ... })`; `httpErrors` maps `kind` to
// an HTTP status; unmatched kinds and an absent `errorEncoder` fall back to
// the existing default (400 wrapping `{ error }`). Also covers a handler that
// THROWS: `thrownErrorEncoder` maps the caught value to an `HttpErrorResponse`;
// an absent encoder, or one returning `undefined`, falls back to the existing
// default (500 wrapping `{ error: "internal server error" }`). See
// docs/design/middleware-and-caller-context.md.

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { err, ok } from "@rhi-zone/fractal-api-tree"
import { composeErrorEncoders, matchKind } from "@rhi-zone/fractal-api-tree"
import { httpErrors, makeRouterFromRoute, naiveTransform } from "./route.ts"

function tree() {
  return api_({
    getBook: op((input: { id: string }) => {
      if (input.id === "missing") return err({ kind: "notFound", message: "Book not found" })
      if (input.id === "dupe") return err({ kind: "conflict", message: "already exists" })
      if (input.id === "weird") return err({ kind: "somethingElse", message: "???" })
      return ok({ id: input.id, title: "Dune" })
    }, {}),
  })
}

function throwingTree() {
  return api_({
    getBook: op((input: { id: string }) => {
      if (input.id === "missing") throw { kind: "notFound", message: "Book not found" }
      if (input.id === "boom") throw new Error("kaboom")
      return { id: input.id, title: "Dune" }
    }, {}),
  })
}

describe("httpErrors", () => {
  it("maps a matched error kind to its configured status", async () => {
    const route = naiveTransform(tree())
    const router = makeRouterFromRoute(
      route.children!.getBook!,
      undefined,
      undefined,
      httpErrors({ notFound: 404, conflict: 409 }),
    )
    const res = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "missing" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ kind: "notFound", message: "Book not found" })
  })

  it("maps a second configured kind to its own status (composed, first match wins)", async () => {
    const route = naiveTransform(tree())
    const router = makeRouterFromRoute(
      route.children!.getBook!,
      undefined,
      undefined,
      httpErrors({ notFound: 404, conflict: 409 }),
    )
    const res = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "dupe" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(409)
  })

  it("unknown error kind (no match) falls back to the default 400", async () => {
    const route = naiveTransform(tree())
    const router = makeRouterFromRoute(
      route.children!.getBook!,
      undefined,
      undefined,
      httpErrors({ notFound: 404, conflict: 409 }),
    )
    const res = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "weird" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: { kind: "somethingElse", message: "???" } })
  })

  it("no errorEncoder configured — current 400 default behavior unchanged", async () => {
    const route = naiveTransform(tree())
    const router = makeRouterFromRoute(route.children!.getBook!)
    const res = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "missing" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: { kind: "notFound", message: "Book not found" } })
  })

  it("a successful Result still returns 200 with the value, unaffected by errorEncoder", async () => {
    const route = naiveTransform(tree())
    const router = makeRouterFromRoute(
      route.children!.getBook!,
      undefined,
      undefined,
      httpErrors({ notFound: 404 }),
    )
    const res = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "1" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "1", title: "Dune" })
  })
})

describe("thrownErrorEncoder", () => {
  it("handler throws, no encoder configured — falls back to the existing 500", async () => {
    const route = naiveTransform(throwingTree())
    const router = makeRouterFromRoute(route.children!.getBook!)
    const res = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "boom" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal server error" })
  })

  it("handler throws, encoder returns an HttpErrorResponse — uses its status/body", async () => {
    const route = naiveTransform(throwingTree())
    const router = makeRouterFromRoute(
      route.children!.getBook!,
      undefined,
      undefined,
      undefined,
      (error) => {
        if (typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "notFound") {
          return { status: 404, body: error }
        }
        return undefined
      },
    )
    const res = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "missing" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ kind: "notFound", message: "Book not found" })
  })

  it("handler throws, encoder returns undefined — falls back to the existing 500", async () => {
    const route = naiveTransform(throwingTree())
    const router = makeRouterFromRoute(
      route.children!.getBook!,
      undefined,
      undefined,
      undefined,
      () => undefined,
    )
    const res = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "boom" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal server error" })
  })

  it("both encoders configured — a Result.err hits errorEncoder, a throw hits thrownErrorEncoder", async () => {
    // A tree whose handler returns Result.err for one input and throws for another.
    const mixedTree = api_({
      getBook: op((input: { id: string }) => {
        if (input.id === "missing") return err({ kind: "notFound", message: "Book not found" })
        if (input.id === "boom") throw { kind: "explosive", message: "kaboom" }
        return ok({ id: input.id, title: "Dune" })
      }, {}),
    })
    const route = naiveTransform(mixedTree)
    const router = makeRouterFromRoute(
      route.children!.getBook!,
      undefined,
      undefined,
      httpErrors({ notFound: 404 }),
      (error) => {
        if (typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "explosive") {
          return { status: 502, body: error }
        }
        return undefined
      },
    )

    const errRes = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "missing" }), headers: { "content-type": "application/json" } }))
    expect(errRes.status).toBe(404)
    expect(await errRes.json()).toEqual({ kind: "notFound", message: "Book not found" })

    const thrownRes = await router(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: "boom" }), headers: { "content-type": "application/json" } }))
    expect(thrownRes.status).toBe(502)
    expect(await thrownRes.json()).toEqual({ kind: "explosive", message: "kaboom" })
  })
})

describe("composeErrorEncoders + matchKind (api-tree combinators)", () => {
  it("first match wins across manually composed encoders", () => {
    const encoder = composeErrorEncoders(
      matchKind("notFound", { status: 404 }),
      matchKind("notFound", { status: 999 }), // never reached — first match wins
      matchKind("conflict", { status: 409 }),
    )
    expect(encoder({ kind: "notFound" })).toEqual({ status: 404 })
    expect(encoder({ kind: "conflict" })).toEqual({ status: 409 })
    expect(encoder({ kind: "unknown" })).toBeUndefined()
  })
})
