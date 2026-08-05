// packages/http-api-projector/src/subtree-layers.test.ts — per-branch
// middleware scoping via the meta channel (docs/design/subtree-layers-spec.md).
//
// Covers:
//   1. Per-subtree `middleware` applies only within its subtree — sibling
//      subtrees unaffected (the raw-capture motivating case shape, §1).
//   2. Nesting order — root outermost, leaf innermost, declaration order
//      within a node (§5).
//   3. `handlerMiddleware` vs `middleware` phase ordering relative to
//      decode/validate (§4a/§4b/§7).
//   4. Extraction/codegen/OpenAPI stay clean over a layered tree — regression
//      guard for the spec's own §6 `[verify]` findings.
//   5. The `FoldMeta` array-shape hazard (§6/§7/§10.3) — a type-level test.
//   6. Error semantics — a subtree layer's throw behaves IDENTICALLY to its
//      global (`PresetOptions`) counterpart's throw (owner ruling, spec's
//      open question 2 — see preset.test.ts's own baseline test for the
//      global case this compares against).
//
// Leaf-position contributions are attached the real way (`op(fn, http.get,
// middleware(mw))`) — `op()`'s meta-contribution check is vacuous against
// core's (unaugmented) `LeafMeta`, since it declares no required keys, so
// this typechecks without a deployment-level `declare module` merge.
// Branch-position contributions are attached by constructing the `HttpRoute`
// tree directly via `httpRoute()` (route.ts) — `api()`'s `opts.meta` is
// typed `M extends BranchMeta` (core's, unaugmented), which genuinely can't
// accept an `http` field without that same deployment-level merge; every
// existing branch-level meta test in this package (route.test.ts,
// compile.test.ts) already follows this same `httpRoute()`-direct pattern
// for exactly this reason.

import { describe, expect, expectTypeOf, it } from "bun:test"
import { op } from "@rhi-zone/fractal-api-tree/node"
import { httpProjection } from "./dx.ts"
import { compiledCharRouter, mapCharRouter, radixRouter } from "./compile.ts"
import type { CompiledRouter } from "./compile.ts"
import { httpRoute, makeRouterFromRoute } from "./route.ts"
import type { HttpHandlerMiddleware, HttpRoute } from "./route.ts"
import { http, handlerMiddleware, middleware } from "./verbs.ts"
import type { Fetch } from "./layers.ts"
import { listRoutes, toOpenApiFromRoute } from "./openapi.ts"
import type { StandardSchemaV1 } from "./decode.ts"

// ============================================================================
// 1 + 2. Subtree scoping + nesting order, across every built-in router
// compiler in compile.ts (the spec's own explicit scope, §5).
// ============================================================================

/** A tracking `Fetch => Fetch` middleware that records enter/exit under `name`. */
function trackingMiddleware(name: string, log: string[]): (inner: Fetch) => Fetch {
  return (inner) => async (req) => {
    log.push(`${name}:enter`)
    const res = await inner(req)
    log.push(`${name}:exit`)
    return res
  }
}

/**
 * The raw-capture motivating case's shape (docs/decisions/
 * one-root-fractal-tree-2026-08-02.md §3.3/§7, quoted in the spec's §1): a
 * `webhooks` branch declares a `middleware` that must run for every leaf
 * under it, and a SIBLING branch (`other`) must be completely unaffected.
 */
function webhooksFixture(log: string[]): HttpRoute {
  return httpRoute({
    meta: {},
    children: {
      webhooks: httpRoute({
        meta: { http: { middleware: [trackingMiddleware("webhooksMw", log)] } },
        children: {
          stripe: httpRoute({
            meta: {},
            methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
          }),
          github: httpRoute({
            meta: {},
            methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
          }),
        },
      }),
      other: httpRoute({
        meta: {},
        methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
      }),
    },
  })
}

const compilers: readonly { readonly name: string; readonly compile: (route: HttpRoute) => CompiledRouter }[] = [
  { name: "radixRouter", compile: (r) => radixRouter(r) },
  { name: "compiledCharRouter", compile: (r) => compiledCharRouter(r) },
  { name: "mapCharRouter", compile: (r) => mapCharRouter(r) },
]

describe("subtree-scoped middleware — applies only within its declaring subtree", () => {
  for (const { name, compile } of compilers) {
    it(`${name}: webhooks middleware runs for every leaf UNDER webhooks, never for a sibling branch`, async () => {
      const log: string[] = []
      const router = compile(webhooksFixture(log))

      await router(new Request("http://x/webhooks/stripe", { method: "POST" }))
      expect(log).toEqual(["webhooksMw:enter", "webhooksMw:exit"])

      log.length = 0
      await router(new Request("http://x/webhooks/github", { method: "POST" }))
      expect(log).toEqual(["webhooksMw:enter", "webhooksMw:exit"])

      log.length = 0
      await router(new Request("http://x/other", { method: "POST" }))
      expect(log).toEqual([])
    })
  }

  it("makeRouterFromRoute (route.ts's own dispatcher, an ALTERNATIVE to compile.ts's compilers) does NOT apply subtree middleware — a real, documented scope limit of this spec (§5 names only compile.ts's four built-in compilers), not a silent gap", async () => {
    const log: string[] = []
    const router = makeRouterFromRoute(webhooksFixture(log))
    await router(new Request("http://x/webhooks/stripe", { method: "POST" }))
    expect(log).toEqual([])
  })
})

describe("nesting order — root outermost, leaf innermost, declaration order within a node", () => {
  it("root(mwR) -> admin(mwA) -> webhooks(mwW) -> leaf composes as mwR[mwA[mwW[leaf]]] (§5's worked example)", async () => {
    const log: string[] = []
    const tree = httpRoute({
      meta: { http: { middleware: [trackingMiddleware("root", log)] } },
      children: {
        admin: httpRoute({
          meta: { http: { middleware: [trackingMiddleware("admin", log)] } },
          children: {
            webhooks: httpRoute({
              meta: { http: { middleware: [trackingMiddleware("webhooks", log)] } },
              methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
            }),
          },
        }),
      },
    })

    const router = mapCharRouter(tree)
    await router(new Request("http://x/admin/webhooks", { method: "POST" }))

    expect(log).toEqual([
      "root:enter",
      "admin:enter",
      "webhooks:enter",
      "webhooks:exit",
      "admin:exit",
      "root:exit",
    ])
  })

  it("a node's own middleware array composes in DECLARATION order, first entry outermost within that node's own contribution", async () => {
    const log: string[] = []
    const tree = httpRoute({
      meta: {
        http: {
          middleware: [trackingMiddleware("first", log), trackingMiddleware("second", log)],
        },
      },
      methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
    })

    const router = mapCharRouter(tree)
    await router(new Request("http://x/", { method: "POST" }))

    expect(log).toEqual(["first:enter", "second:enter", "second:exit", "first:exit"])
  })

  it("op(fn, http.middleware(mw)) — a LEAF's own middleware runs exactly ONCE, not doubled by the leaf's own HttpRoute-position meta (regression guard: naiveTransform aliases a pure leaf's route-position meta and its POST-entry meta to the SAME object)", async () => {
    let calls = 0
    const mw = (): ((inner: Fetch) => Fetch) => (inner) => async (req) => {
      calls++
      return inner(req)
    }
    const tree = op((_input: unknown) => ({ ok: true }), http.get, middleware(mw()))
    const routes = httpProjection(tree)
    const router = mapCharRouter(routes)
    await router(new Request("http://x/", { method: "GET" }))
    expect(calls).toBe(1)
  })
})

// ============================================================================
// 3. handlerMiddleware vs middleware phase ordering relative to decode/validate
// ============================================================================

describe("middleware (dispatch-around) vs handlerMiddleware (handler-around) — phase ordering", () => {
  it("middleware runs BEFORE decode/validate; handlerMiddleware runs AFTER decode/validate, before the handler — both nested subtree-scoped, root-to-leaf", async () => {
    const log: string[] = []
    const dispatchMw = (name: string): ((inner: Fetch) => Fetch) => (inner) => async (req) => {
      log.push(`${name}:dispatch-enter`)
      const res = await inner(req)
      log.push(`${name}:dispatch-exit`)
      return res
    }
    const handlerMw: (name: string) => HttpHandlerMiddleware = (name) => (next) => (input, stores) => {
      log.push(`${name}:handler-enter`)
      const out = next(input, stores)
      log.push(`${name}:handler-exit`)
      return out
    }

    const tree = httpRoute({
      meta: {
        http: {
          middleware: [dispatchMw("root")],
          handlerMiddleware: [handlerMw("root")],
        },
      },
      methods: {
        POST: {
          handler: (input: unknown) => {
            log.push("handler")
            return { echoed: input }
          },
          meta: {},
        },
      },
    })

    const router = mapCharRouter(tree)
    await router(
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ a: 1 }),
        headers: { "content-type": "application/json" },
      }),
    )

    // dispatch-around (middleware) is OUTSIDE decode/validate/handler-around
    // entirely; handler-around (handlerMiddleware) is INSIDE, immediately
    // around the handler call — never reordered or collapsed into one phase
    // (spec §7's "Validators" section / §10.6's regression guard).
    expect(log).toEqual(["root:dispatch-enter", "root:handler-enter", "handler", "root:handler-exit", "root:dispatch-exit"])
  })

  it("http.validate() rejection short-circuits BEFORE handlerMiddleware/handler run, but AFTER dispatch-around middleware has already entered", async () => {
    const log: string[] = []
    const dispatchMw: (inner: Fetch) => Fetch = (inner) => async (req) => {
      log.push("dispatch-enter")
      const res = await inner(req)
      log.push("dispatch-exit")
      return res
    }
    const handlerMw: HttpHandlerMiddleware = (next) => (input, stores) => {
      log.push("handler-mw-should-not-run")
      return next(input, stores)
    }
    const failingSchema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [{ message: "nope" }] }),
      },
    }

    const tree = op(
      (input: unknown) => {
        log.push("handler-should-not-run")
        return input
      },
      http.post,
      middleware(dispatchMw),
      handlerMiddleware(handlerMw),
      http.validate(failingSchema),
    )
    const routes = httpProjection(tree)
    const router = mapCharRouter(routes)
    const res = await router(
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }),
    )

    expect(res.status).toBe(422)
    expect(log).toEqual(["dispatch-enter", "dispatch-exit"])
  })
})

// ============================================================================
// 4. Extraction/codegen/OpenAPI stay clean over a layered tree — regression
// guard for the spec's own §6 `[verify]` findings (empirically re-confirmed
// here, permanently, rather than trusted from the spec's scratch session).
// ============================================================================

describe("OpenAPI / listRoutes over a layered tree — no leakage, route surface unchanged (spec §6/§7)", () => {
  function layeredTree() {
    return op(
      (input: { id: string }) => ({ id: input.id }),
      http.get,
      middleware((inner) => inner),
      handlerMiddleware((next) => next),
    )
  }

  it("toOpenApiFromRoute produces a valid document whose JSON contains no function leakage", async () => {
    const routes = httpProjection(layeredTree())
    const doc = await toOpenApiFromRoute(routes)
    const json = JSON.stringify(doc)
    expect(json).not.toContain("function")
    expect(doc.openapi).toBe("3.1.0")
  })

  it("listRoutes reports the same path/method set a middleware/handlerMiddleware-free tree would", async () => {
    const layered = httpProjection(layeredTree())
    const plain = httpProjection(op((input: { id: string }) => ({ id: input.id }), http.get))

    const layeredRoutes = listRoutes(layered).map((r) => `${r.verb} ${r.path}`)
    const plainRoutes = listRoutes(plain).map((r) => `${r.verb} ${r.path}`)
    expect(layeredRoutes).toEqual(plainRoutes)
  })
})

// ============================================================================
// 5. FoldMeta array-shape hazard — type-level regression test (§6/§7/§10.3)
// ============================================================================

describe("FoldMeta array-shape hazard — why middleware/handlerMiddleware are plain-array-authored under a flat key, never a bare field", () => {
  it("two http.middleware() contributions on the SAME op() compose — the folded array's elements stay callable", () => {
    const mw1: (inner: Fetch) => Fetch = (inner) => inner
    const mw2: (inner: Fetch) => Fetch = (inner) => inner
    const leaf = op((input: unknown) => input, middleware(mw1), middleware(mw2))

    expect(leaf.meta.http?.middleware?.length).toBe(2)

    // Type-level: the array's element type is still a real, callable
    // `(inner: Fetch) => Fetch` — NOT stripped to `{}` the way a bare
    // (non-array) function-valued field would be (see the next test).
    // `MergeMetaValue`'s array branch (node.ts) concatenates without
    // recursing into elements, so composing two `middleware()` contributions
    // (or one `http.middleware(a, b)` call) both land here unchanged.
    type MiddlewareValue = NonNullable<NonNullable<typeof leaf.meta.http>["middleware"]>[number]
    expectTypeOf<MiddlewareValue>().toEqualTypeOf<(inner: Fetch) => Fetch>()
    const callable: MiddlewareValue = (inner) => inner
    expect(typeof callable).toBe("function")
  })

  it("[verify, made permanent] a BARE (non-array) function-valued meta member loses its call signature through FoldMeta when two op() contributions both set it — direct reproduction of the spec's own scratch finding against real op()/FoldMeta (node.ts), not a simplified stand-in. This is WHY middleware/handlerMiddleware are never authored this way", () => {
    const fn1: (inner: Fetch) => Fetch = (inner) => inner
    const fn2: (inner: Fetch) => Fetch = (inner) => inner
    // A hypothetical, NEVER-actually-exposed bare-field authoring shape —
    // exactly the class of contribution `http.middleware()`/
    // `http.handlerMiddleware()` deliberately do NOT produce.
    const leaf = op((input: unknown) => input, { http: { bareHazard: fn1 } }, { http: { bareHazard: fn2 } })

    type Bad = typeof leaf.meta.http extends { readonly bareHazard: infer F } ? F : never
    // @ts-expect-error — `Bad` is NOT assignable to `(inner: Fetch) => Fetch`.
    // `MergeTwoMeta`'s mapped-type merge (`Omit`/`Pick` over `keyof`,
    // api-tree's node.ts) strips the call signature for a bare
    // function-valued key two contributions both set — `keyof` a plain
    // function type is empty, so the merge reduces the folded member toward
    // `{}` (a function structurally satisfies `extends object`, so
    // `MergeMetaValue` takes the OBJECT-merge branch, not the
    // array-concatenation branch that keeps `middleware`/`handlerMiddleware`
    // safe).
    const check: (inner: Fetch) => Fetch = null as unknown as Bad
    void check
  })
})

// ============================================================================
// 6. Error semantics — MAXIMAL CONSISTENCY (owner ruling, revisited
// 2026-08-02, supersedes the "propagates uncaught" ruling this block
// originally verified): a middleware throw — subtree-scoped or global — is
// now caught and encoded via `thrownErrorEncoder`, IDENTICALLY to a
// handlerMiddleware throw, instead of propagating uncaught. `toRouter`
// (compile.ts) catches a subtree `http.middleware()` throw right where it
// composes `match.middleware` around `runRoute`'s dispatch; `createFetch`
// (preset.ts) does the analogous catch around the GLOBAL
// `PresetOptions.middleware` array, which wraps OUTSIDE the compiled router
// entirely (see preset.test.ts's own middleware-throw tests for that
// baseline). Both funnel through the same `encodeThrownError` helper
// (route.ts) `runRoute`'s own catch block uses for a handlerMiddleware
// throw — one fallback-to-500 path, not three independent re-derivations.
// ============================================================================

describe("error semantics — a subtree layer's throw matches its global counterpart's throw exactly", () => {
  it("a subtree http.middleware() that throws IS caught and encoded — falls back to the existing 500 default when no thrownErrorEncoder is configured, identical to a global PresetOptions.middleware throw (preset.test.ts) and to a handlerMiddleware throw (next test)", async () => {
    const throwingMw: (inner: Fetch) => Fetch = () => async () => {
      throw new Error("subtree middleware boom")
    }
    const tree = httpRoute({
      meta: { http: { middleware: [throwingMw] } },
      methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
    })
    const router = mapCharRouter(tree)
    const res = await router(new Request("http://x/", { method: "POST" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal server error" })
  })

  it("a subtree http.middleware() throw reaches a configured thrownErrorEncoder, same as the global option and same as a subtree handlerMiddleware throw", async () => {
    const throwingMw: (inner: Fetch) => Fetch = () => async () => {
      throw { kind: "explosive", message: "kaboom" }
    }
    const tree = httpRoute({
      meta: { http: { middleware: [throwingMw] } },
      methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
    })
    const router = mapCharRouter(tree, undefined, undefined, undefined, (error) => {
      if (typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "explosive") {
        return { status: 502, body: error }
      }
      return undefined
    })
    const res = await router(new Request("http://x/", { method: "POST" }))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ kind: "explosive", message: "kaboom" })
  })

  it("a subtree http.handlerMiddleware() that throws IS caught and encoded via thrownErrorEncoder — identical to a global PresetOptions.handlerMiddleware throw (both sit inside runRoute's try/catch)", async () => {
    const throwingHmw: HttpHandlerMiddleware = () => () => {
      throw new Error("subtree handlerMiddleware boom")
    }
    const tree = httpRoute({
      meta: { http: { handlerMiddleware: [throwingHmw] } },
      methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
    })

    // No thrownErrorEncoder configured — falls back to the existing default
    // (500, same as error-encoder.test.ts's own "no encoder configured" case).
    const router = mapCharRouter(tree)
    const res = await router(new Request("http://x/", { method: "POST" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal server error" })
  })

  it("a subtree http.handlerMiddleware() throw reaches a configured thrownErrorEncoder, same as the global option threaded through toRouter", async () => {
    const throwingHmw: HttpHandlerMiddleware = () => () => {
      throw { kind: "explosive", message: "kaboom" }
    }
    const tree = httpRoute({
      meta: { http: { handlerMiddleware: [throwingHmw] } },
      methods: { POST: { handler: () => ({ ok: true }), meta: {} } },
    })

    const router = mapCharRouter(tree, undefined, undefined, undefined, (error) => {
      if (typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "explosive") {
        return { status: 502, body: error }
      }
      return undefined
    })
    const res = await router(new Request("http://x/", { method: "POST" }))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ kind: "explosive", message: "kaboom" })
  })
})
