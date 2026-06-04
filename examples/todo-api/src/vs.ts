// examples/todo-api/src/vs.ts
//
// The three representative endpoints used in docs/design/vs-hono-elysia.md,
// written in fractal and verified: tsgo typechecks them and the test file
// (vs.test.ts) drives them in-process via toHandler(app)(new Request(...)).
//
//   (a) GET  /users/:id            — user or 404, behind auth (typed ctx.vars.user)
//   (b) POST /users                — body { name, email } validated, 201
//   (c) POST /users/:id/deactivate — domain Outcome<User,{code}> → 200/404/409
//
// Everything is plain data composed from fractal primitives.

import {
  err,
  httpRouter,
  json,
  ok,
  respond,
  toHandler,
  withValidation,
  type ErrorPolicy,
  type HttpCtx,
  type HttpMiddleware,
  type NoVars,
  type Outcome,
  type StandardSchema,
  type WithVars,
} from "@rhi-zone/fractal-http"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface User {
  id: string
  name: string
  email: string
  active: boolean
}

const users = new Map<string, User>([
  ["1", { id: "1", name: "Ada", email: "ada@x.io", active: true }],
])
let seq = 2

type UserError =
  | { code: "USER_NOT_FOUND"; id: string }
  | { code: "ALREADY_INACTIVE"; id: string }

const userErrorPolicy: ErrorPolicy<UserError> = (e) => {
  switch (e.code) {
    case "USER_NOT_FOUND":
      return { status: 404, body: { error: e.code, id: e.id } }
    case "ALREADY_INACTIVE":
      return { status: 409, body: { error: e.code, id: e.id } }
  }
}

// (b) library fn — args inferred; validator output is constrained ≡ args.
async function createUser(args: { name: string; email: string }): Promise<User> {
  const user: User = { id: String(seq++), name: args.name, email: args.email, active: true }
  users.set(user.id, user)
  return user
}

// (c) library fn returning a domain Result, not a Response.
async function deactivate(args: { id: string }): Promise<Outcome<User, UserError>> {
  const user = users.get(args.id)
  if (user === undefined) return err({ code: "USER_NOT_FOUND", id: args.id })
  if (!user.active) return err({ code: "ALREADY_INACTIVE", id: args.id })
  user.active = false
  return ok(user)
}

// ---------------------------------------------------------------------------
// Auth middleware — typed `user` into ctx.vars (handler reads it with NO cast)
// ---------------------------------------------------------------------------

interface AuthVars extends Record<string, unknown> {
  user: { id: string; email: string }
}

const auth: HttpMiddleware<NoVars, AuthVars> = async (ctx, next) => {
  const email = ctx.headers.get("x-user")
  if (email === null) return json({ error: "Unauthorized" }, 401)
  const enriched: WithVars<HttpCtx, NoVars & AuthVars> = {
    ...ctx,
    vars: { user: { id: "caller", email } },
  }
  return next(enriched)
}

// A tiny StandardSchema-shaped validator (no external dep). zod/valibot/arktype
// all implement this `~standard` interface, so a real schema drops in unchanged.
function object<const F extends Record<string, "string">>(
  fields: F,
): StandardSchema<unknown, { [K in keyof F]: string }> {
  type Out = { [K in keyof F]: string }
  return {
    "~standard": {
      version: 1,
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "expected an object" }] }
        }
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
// The app — three endpoints
// ---------------------------------------------------------------------------

export const app = httpRouter<NoVars>()
  // (a) GET /users/:id behind auth → user or 404. ctx.vars.user is typed.
  .use(auth)
  .route("GET", "/users/:id", async (ctx) => {
    const _caller = ctx.vars.user.email // typed, no cast — proof of typed ctx
    const user = users.get(ctx.params["id"] ?? "")
    return user === undefined ? json({ error: "USER_NOT_FOUND" }, 404) : json(user)
  })
  // (b) POST /users — validated body, 201 on success (400 on bad input).
  .routeNode(
    "POST",
    "/users",
    withValidation(
      async (args: { name: string; email: string }) => createUser(args),
      object({ name: "string", email: "string" }),
    ),
  )
  // (c) POST /users/:id/deactivate — domain Outcome → 200/404/409 via policy.
  .route(
    "POST",
    "/users/:id/deactivate",
    respond((ctx) => deactivate({ id: ctx.params["id"] ?? "" }), userErrorPolicy),
  )

export const handle = toHandler(app)
