// packages/http/src/compile.test.ts — composable route compiler tests
//
// Verifies each compiled router (`radixRouter`, `compiledCharRouter`,
// `mapCharRouter`) produces identical results to `makeRouterFromRoute` for
// the same `HttpRoute` tree, plus targeted coverage of `chainMatchers`
// composition, slug extraction, and 404 handling.

import { describe, expect, it } from "bun:test"
import {
  chainMatchers,
  compiledCharMatcher,
  compiledCharRouter,
  mapCharRouter,
  mapMatcher,
  radixMatcher,
  radixRouter,
  toRouter,
} from "./compile.ts"
import { httpRoute, makeRouterFromRoute } from "./route.ts"
import type { HttpRoute } from "./route.ts"

// ============================================================================
// Fixture — a small tree with static, deep-static, and dynamic (1- and
// 2-param) routes, mirroring the shapes route.bench.ts stresses.
// ============================================================================

function buildFixture(): HttpRoute {
  return httpRoute({
    meta: {},
    methods: { GET: { handler: () => ({ name: "root" }), meta: {} } },
    children: {
      users: httpRoute({
        meta: {},
        methods: {
          GET: { handler: () => ({ name: "listUsers" }), meta: {} },
          POST: { handler: (input: unknown) => ({ name: "createUser", input }), meta: {} },
        },
        fallback: {
          name: "id",
          subtree: httpRoute({
            meta: {},
            methods: {
              GET: { handler: (input: unknown) => ({ name: "getUser", input }), meta: {} },
              PUT: { handler: (input: unknown) => ({ name: "updateUser", input }), meta: {} },
            },
            children: {
              posts: httpRoute({
                meta: {},
                fallback: {
                  name: "postId",
                  subtree: httpRoute({
                    meta: {},
                    methods: {
                      GET: { handler: (input: unknown) => ({ name: "getUserPost", input }), meta: {} },
                    },
                  }),
                },
              }),
            },
          }),
        },
      }),
      static: httpRoute({
        meta: {},
        children: {
          docs: httpRoute({
            meta: {},
            children: {
              guides: httpRoute({
                meta: {},
                methods: { GET: { handler: () => ({ name: "guides" }), meta: {} } },
              }),
            },
          }),
        },
      }),
    },
  })
}

const cases: readonly { readonly name: string; readonly pathname: string; readonly method: string }[] = [
  { name: "root", pathname: "/", method: "GET" },
  { name: "static list", pathname: "/users", method: "GET" },
  { name: "static create (POST)", pathname: "/users", method: "POST" },
  { name: "deep static", pathname: "/static/docs/guides", method: "GET" },
  { name: "dynamic get", pathname: "/users/42", method: "GET" },
  { name: "dynamic put", pathname: "/users/42", method: "PUT" },
  { name: "two-param dynamic", pathname: "/users/42/posts/7", method: "GET" },
  { name: "miss — unknown path", pathname: "/nope", method: "GET" },
  { name: "miss — known path, wrong method", pathname: "/users", method: "DELETE" },
]

async function bodyOf(res: Response): Promise<unknown> {
  if (res.status === 404) return "404"
  return res.json()
}

describe("compiled routers match makeRouterFromRoute", () => {
  const route = buildFixture()
  const baseline = makeRouterFromRoute(route)
  const compilers: readonly { readonly name: string; readonly build: (r: HttpRoute) => (req: Request) => Promise<Response> }[] = [
    { name: "radixRouter", build: radixRouter },
    { name: "compiledCharRouter", build: compiledCharRouter },
    { name: "mapCharRouter", build: mapCharRouter },
  ]

  for (const compiler of compilers) {
    describe(compiler.name, () => {
      const router = compiler.build(route)
      for (const kase of cases) {
        it(`${kase.name}: ${kase.method} ${kase.pathname}`, async () => {
          const req = () => new Request(`http://localhost${kase.pathname}`, { method: kase.method })
          const expected = await bodyOf(await baseline(req()))
          const actual = await bodyOf(await router(req()))
          expect(actual).toEqual(expected)
        })
      }
    })
  }
})

describe("slug extraction", () => {
  const route = buildFixture()

  it("radixMatcher extracts a single slug", () => {
    const match = radixMatcher(route)("/users/42", "GET")
    expect(match?.slugs).toEqual({ id: "42" })
  })

  it("compiledCharMatcher extracts a single slug", () => {
    const match = compiledCharMatcher(route)("/users/42", "GET")
    expect(match?.slugs).toEqual({ id: "42" })
  })

  it("radixMatcher extracts two slugs from a nested dynamic path", () => {
    const match = radixMatcher(route)("/users/42/posts/7", "GET")
    expect(match?.slugs).toEqual({ id: "42", postId: "7" })
  })

  it("compiledCharMatcher extracts two slugs from a nested dynamic path", () => {
    const match = compiledCharMatcher(route)("/users/42/posts/7", "GET")
    expect(match?.slugs).toEqual({ id: "42", postId: "7" })
  })

  it("mapCharRouter's dynamic fallthrough extracts slugs too", async () => {
    const router = mapCharRouter(route)
    const res = await router(new Request("http://localhost/users/42", { method: "GET" }))
    expect(await res.json()).toEqual({ name: "getUser", input: { id: "42" } })
  })
})

describe("mapMatcher — static only", () => {
  const route = buildFixture()

  it("matches a static route", () => {
    const match = mapMatcher(route)("/users", "GET")
    expect(match).toBeDefined()
  })

  it("does not match a dynamic route", () => {
    const match = mapMatcher(route)("/users/42", "GET")
    expect(match).toBeUndefined()
  })

  it("does not match an unknown path", () => {
    const match = mapMatcher(route)("/nope", "GET")
    expect(match).toBeUndefined()
  })
})

describe("chainMatchers", () => {
  it("first matcher wins when both would match", () => {
    const first = () => ({ handler: () => "first", meta: {}, slugs: {} })
    const second = () => ({ handler: () => "second", meta: {}, slugs: {} })
    const chained = chainMatchers(first, second)
    const match = chained("/anything", "GET")
    expect(match?.handler(undefined)).toBe("first")
  })

  it("falls through to the next matcher on a miss", () => {
    const first = () => undefined
    const second = () => ({ handler: () => "second", meta: {}, slugs: {} })
    const chained = chainMatchers(first, second)
    const match = chained("/anything", "GET")
    expect(match?.handler(undefined)).toBe("second")
  })

  it("returns undefined when every matcher misses", () => {
    const chained = chainMatchers(
      () => undefined,
      () => undefined,
    )
    expect(chained("/anything", "GET")).toBeUndefined()
  })
})

describe("404 handling", () => {
  const route = buildFixture()
  const routers = {
    radixRouter: radixRouter(route),
    compiledCharRouter: compiledCharRouter(route),
    mapCharRouter: mapCharRouter(route),
  }

  for (const [name, router] of Object.entries(routers)) {
    it(`${name} returns 404 for an unmatched path`, async () => {
      const res = await router(new Request("http://localhost/does/not/exist"))
      expect(res.status).toBe(404)
    })

    it(`${name} returns 404 for a matched path with an unregistered method`, async () => {
      const res = await router(new Request("http://localhost/users", { method: "DELETE" }))
      expect(res.status).toBe(404)
    })
  }

  it("toRouter wraps a matcher with the same 404 contract", async () => {
    const router = toRouter(() => undefined)
    const res = await router(new Request("http://localhost/anything"))
    expect(res.status).toBe(404)
  })
})
