// packages/core/src/index.test.ts — @rhi-zone/fractal-core
import { describe, expect, it } from "vitest"
import {
  compose,
  createRouter,
  isMethodMismatch,
  node,
  type Handler,
  type Middleware,
  type NoVars,
  type PathParams,
  type RoutingCtx,
  type StandardSchema,
  type WithVars,
} from "./index.ts"

// A minimal concrete routing context for tests (no HTTP, no runtime).
interface TestCtx<Vars extends Record<string, unknown> = NoVars> extends RoutingCtx<Vars> {
  readonly tag: "test"
}

function ctx<Vars extends Record<string, unknown>>(
  method: string,
  path: string,
  vars: Vars,
): TestCtx<Vars> {
  return {
    tag: "test",
    method: method.toUpperCase(),
    segments: path.replace(/^\//, "").split("/").filter(Boolean),
    params: {},
    vars,
  }
}

describe("compose", () => {
  it("threads output of a into b", async () => {
    const a: Handler<number, string> = (n) => String(n + 1)
    const b: Handler<string, string> = (s) => `<${s}>`
    const f = compose(a, b)
    expect(await f(1)).toBe("<2>")
  })
})

describe("node", () => {
  it("pairs meta with handler", async () => {
    const n = node({ kind: "leaf" }, (n: number) => n * 2)
    expect(n.meta).toEqual({ kind: "leaf" })
    expect(await n.handler(21)).toBe(42)
  })
})

interface AuthVars extends Record<string, unknown> {
  user: { id: string }
}

describe("router — typed context through mount (linchpin, zero casts)", () => {
  const authMw: Middleware<TestCtx, NoVars, AuthVars, string> = async (c, next) => {
    const enriched: WithVars<TestCtx, NoVars & AuthVars> = {
      ...c,
      vars: { user: { id: "u-1" } },
    }
    return next(enriched)
  }

  const admin = createRouter<TestCtx, NoVars & AuthVars, string>()
    .route("GET", "/me", async (c) => {
      // ZERO casts — c.vars typed as AuthVars
      return `user:${c.vars.user.id}`
    })

  const app = createRouter<TestCtx, NoVars, string>()
    .route("GET", "/ping", async () => "pong")
    .mount("/admin", authMw, admin)

  it("public route", async () => {
    expect(await app.dispatch(ctx("GET", "/ping", {}))).toBe("pong")
  })

  it("mounted route reads typed vars set by middleware", async () => {
    expect(await app.dispatch(ctx("GET", "/admin/me", {}))).toBe("user:u-1")
  })

  it("no match returns null", async () => {
    expect(await app.dispatch(ctx("GET", "/nope", {}))).toBeNull()
  })
})

describe("router — use() widens visible vars", () => {
  const greetMw: Middleware<TestCtx, NoVars, { greeting: string }, string> = async (c, next) =>
    next({ ...c, vars: { greeting: "hi" } })

  const r = createRouter<TestCtx, NoVars, string>()
    .use(greetMw)
    .route("GET", "/g", async (c) => c.vars.greeting)

  it("handler registered after use() sees added vars", async () => {
    expect(await r.dispatch(ctx("GET", "/g", {}))).toBe("hi")
  })
})

describe("dispatch — method-mismatch sentinel vs no-match null", () => {
  const r = createRouter<TestCtx, NoVars, string>()
    .route("GET", "/users/:id", async (c) => `get:${c.params["id"]}`)
    .route("PUT", "/users/:id", async () => "put")

  it("path matched, method didn't → MethodMismatch carrying allowed methods", async () => {
    const result = await r.dispatch(ctx("DELETE", "/users/1", {}))
    expect(isMethodMismatch(result)).toBe(true)
    if (isMethodMismatch(result)) {
      expect(result.allow.sort()).toEqual(["GET", "HEAD", "PUT"])
    }
  })

  it("genuinely unmatched path → null", async () => {
    expect(await r.dispatch(ctx("DELETE", "/absent", {}))).toBeNull()
  })

  it("auto-HEAD: HEAD with no HEAD route runs the GET handler", async () => {
    expect(await r.dispatch(ctx("HEAD", "/users/9", {}))).toBe("get:9")
  })
})

describe("PathParams — type-level pattern parsing (no casts)", () => {
  type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
  it("single, multi, and zero params parse to the right record", () => {
    const single: Eq<PathParams<"/users/:id">, { readonly id: string }> = true
    const multi: Eq<
      PathParams<"/u/:uid/books/:bid">,
      { readonly uid: string; readonly bid: string }
    > = true
    const none: Eq<PathParams<"/static">, Record<never, never>> = true
    expect([single, multi, none]).toEqual([true, true, true])
  })
})

describe("StandardSchema", () => {
  it("is a structural interface usable as a value shape", () => {
    const s: StandardSchema<unknown, { n: number }> = {
      "~standard": {
        version: 1,
        validate: (v) =>
          typeof v === "object" && v !== null && typeof (v as { n?: unknown }).n === "number"
            ? { value: v as { n: number } }
            : { issues: [{ message: "bad" }] },
      },
    }
    const r = s["~standard"].validate({ n: 5 })
    expect(r.issues).toBeUndefined()
    expect(r.value).toEqual({ n: 5 })
  })
})
