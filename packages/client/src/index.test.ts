// packages/client/src/index.test.ts — @rhi-zone/fractal-client
//
// End-to-end proof of the typed client derived from a fractal router:
//   - route accumulation infers (the crux)
//   - ClientOf<typeof app> derives the right call surface (type probe below)
//   - inProcess transport returns server-IDENTICAL results
//   - http transport round-trips through toHandler via a mock fetch
//   - @ts-expect-error negatives (wrong body / missing param / unknown route)

import { describe, expect, it } from "bun:test"
import {
  created,
  httpRouter,
  json,
  toHandler,
  withValidation,
  type NoVars,
  type StandardSchema,
} from "@rhi-zone/fractal-http"
import { client, http, inProcess, type ClientOf } from "./index.ts"

// ---------------------------------------------------------------------------
// A tiny StandardSchema validator (no external dep) — same as the example.
// ---------------------------------------------------------------------------

function object<const F extends Record<string, "string">>(
  fields: F,
): StandardSchema<unknown, { [K in keyof F]: string }> {
  type Out = { [K in keyof F]: string }
  return {
    "~standard": {
      version: 1,
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) return { issues: [{ message: "expected object" }] }
        const obj = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(fields)) {
          if (typeof obj[k] !== "string") return { issues: [{ message: `field "${k}" must be a string` }] }
          out[k] = obj[k]
        }
        return { value: out as Out }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// The app — GET /users/:id (typed param, typed output via json<User>) and
// POST /users (validated body → typed output via withValidation).
// ---------------------------------------------------------------------------

interface User {
  id: string
  name: string
  email: string
}

function makeApp() {
  const users = new Map<string, User>([
    ["1", { id: "1", name: "Ada", email: "ada@x.io" }],
  ])
  let seq = 2

  const app = httpRouter<NoVars>()
    .get("/users", async () => json<User[]>([...users.values()]))
    .get("/users/:id", async (ctx) => {
      const id: string = ctx.params.id // typed string, no cast
      const user = users.get(id)
      return json<User | null>(user ?? null)
    })
    .routeNode(
      "POST",
      "/users",
      withValidation(
        async (args: { name: string; email: string }) => {
          const user: User = { id: String(seq++), name: args.name, email: args.email }
          users.set(user.id, user)
          return created(user) // status-aware 201; Result (output type) = User
        },
        object({ name: "string", email: "string" }),
      ),
    )

  return app
}

// ============================================================================
// TYPE PROBE — the derived client surface
//
// type _ should expand to roughly:
// {
//   "/users":     { get: () => Promise<User[]>;          post: (a: { body: { name: string; email: string } }) => Promise<User> }
//   "/users/:id": { get: (a: { params: { id: string } }) => Promise<User | null> }
// }
// ============================================================================

type App = ReturnType<typeof makeApp>
type _ = ClientOf<App>

// Static assertions (compile-time) — these are exercised by typecheck.
function _staticPositives(c: ClientOf<App>) {
  const a: Promise<User[]> = c["/users"].get()
  const b: Promise<User | null> = c["/users/:id"].get({ params: { id: "1" } })
  const d: Promise<User> = c["/users"].post({ body: { name: "Grace", email: "g@x.io" } })
  return [a, b, d]
}

function _staticNegatives(c: ClientOf<App>) {
  // @ts-expect-error wrong body type (name must be string)
  c["/users"].post({ body: { name: 42, email: "x" } })
  // @ts-expect-error missing required path param
  c["/users/:id"].get({})
  // @ts-expect-error method does not exist on this route
  c["/users/:id"].post({ params: { id: "1" }, body: { name: "x", email: "y" } })
  // @ts-expect-error pattern does not exist
  c["/nope"].get()
  // @ts-expect-error missing the params arg entirely
  c["/users/:id"].get()
}

// ============================================================================
// RUNTIME — in-process transport: server-identical results
// ============================================================================

describe("inProcess transport — Hyper unification", () => {
  it("GET /users returns the seeded list", async () => {
    const c = client(makeApp())
    const list = await c["/users"].get()
    expect(list).toEqual([{ id: "1", name: "Ada", email: "ada@x.io" }])
  })

  it("GET /users/:id with a typed param returns the user", async () => {
    const c = client(makeApp())
    const user = await c["/users/:id"].get({ params: { id: "1" } })
    expect(user).toEqual({ id: "1", name: "Ada", email: "ada@x.io" })
  })

  it("GET /users/:id unknown id returns null (server-identical)", async () => {
    const c = client(makeApp())
    const user = await c["/users/:id"].get({ params: { id: "999" } })
    expect(user).toBeNull()
  })

  it("POST /users with a typed body creates and returns the user", async () => {
    const app = makeApp()
    const c = client(app)
    const created = await c["/users"].post({ body: { name: "Grace", email: "g@x.io" } })
    expect(created.name).toBe("Grace")
    // server-identical: the same router now serves the new user back in-process.
    const back = await c["/users/:id"].get({ params: { id: created.id } })
    expect(back).toEqual(created)
  })

  it("in-process result equals a direct toHandler round-trip (server-identical)", async () => {
    const app = makeApp()
    const handle = toHandler(app)
    const direct = await (await handle(new Request("http://x/users/1"))).json()
    const viaClient = await client(app)["/users/:id"].get({ params: { id: "1" } })
    expect(viaClient).toEqual(direct)
  })
})

// ============================================================================
// RUNTIME — http transport: serialise to fetch, parse the response.
// We back the mock fetch with the SAME toHandler the server uses, proving the
// produced { method, path, body } is a real, correct HTTP request.
// ============================================================================

describe("http transport — fetch round-trip through toHandler", () => {
  function servedFetch(app: ReturnType<typeof makeApp>): typeof fetch {
    const handle = toHandler(app)
    return ((input: string | URL | Request, init?: RequestInit) =>
      handle(new Request(input, init))) as unknown as typeof fetch
  }

  it("GET /users/:id interpolates the param into the path and parses the body", async () => {
    const app = makeApp()
    const c = client(app, http("http://api.test", servedFetch(app)))
    const user = await c["/users/:id"].get({ params: { id: "1" } })
    expect(user).toEqual({ id: "1", name: "Ada", email: "ada@x.io" })
  })

  it("POST /users sends the JSON body and returns the created user", async () => {
    const app = makeApp()
    const c = client(app, http("http://api.test", servedFetch(app)))
    const created = await c["/users"].post({ body: { name: "Lin", email: "lin@x.io" } })
    expect(created.name).toBe("Lin")
  })

  it("the produced request is exactly method + interpolated path + JSON body", async () => {
    const seen: { method?: string; url?: string; body?: string } = {}
    const spyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      seen.method = req.method
      seen.url = req.url
      if (init?.body) seen.body = String(init.body)
      return new Response(JSON.stringify({ id: "9", name: "Z", email: "z@x.io" }), {
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const c = client(makeApp(), http("http://api.test", spyFetch))
    await c["/users"].post({ body: { name: "Z", email: "z@x.io" } })
    expect(seen.method).toBe("POST")
    expect(seen.url).toBe("http://api.test/users")
    expect(seen.body).toBe(JSON.stringify({ name: "Z", email: "z@x.io" }))
  })
})
