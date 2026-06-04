// examples/todo-api/src/vs.ts
//
// The three representative endpoints from docs/design/vs-hono-elysia.md, written
// in fractal AFTER the correctness + ergonomics punch-list. Reads clearly
// cleaner than the spike: verb sugar, typed path params (no `?? ""`), a real 201
// create through validation, and stdlib middleware composed as plain values.
//
//   (a) GET  /users/:id            — user or 404, behind bearerAuth (typed ctx.vars.auth)
//   (b) POST /users                — body { name, email } validated → 201 created()
//   (c) POST /users/:id/deactivate — domain Outcome<User,{code}> → 200/404/409
//
// Everything is plain data composed from fractal primitives + plain middleware.

import {
  created,
  err,
  httpRouter,
  json,
  ok,
  respond,
  toHandler,
  withValidation,
  type ErrorPolicy,
  type NoVars,
  type Outcome,
  type StandardSchema,
} from "@rhi-zone/fractal-http"
import { bearerAuth, cors } from "@rhi-zone/fractal-http/middleware"

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
// The app — three endpoints, verb sugar + typed params + 201 + stdlib mw
//
// `cors()` and `bearerAuth()` are ORDINARY Middleware values composed via the
// SAME `.use(...)` as any user middleware — no preset, no DSL, no framework hook.
// ---------------------------------------------------------------------------

export const app = httpRouter<NoVars>()
  .use(cors())
  // bearerAuth threads a typed principal into ctx.vars.auth (read with NO cast).
  .use(bearerAuth({ verify: (token) => (token.length > 0 ? { id: "caller", email: token } : null) }))
  // (a) GET /users/:id — ctx.params.id is typed `string` (no `?? ""`).
  .get("/users/:id", async (ctx) => {
    const _caller = ctx.vars.auth.email // typed, no cast — proof of typed ctx
    const user = users.get(ctx.params.id)
    return user === undefined ? json({ error: "USER_NOT_FOUND" }, 404) : json(user)
  })
  // (b) POST /users — validated body → 201 via created() (the 201 gap, closed).
  .routeNode(
    "POST",
    "/users",
    withValidation(
      async (args: { name: string; email: string }) => created(await createUser(args)),
      object({ name: "string", email: "string" }),
    ),
  )
  // (c) POST /users/:id/deactivate — domain Outcome → 200/404/409 via policy.
  //     ctx.params.id is typed; respond() maps the Outcome through the policy.
  .post("/users/:id/deactivate", respond((ctx) => deactivate({ id: ctx.params.id }), userErrorPolicy))

export const handle = toHandler(app)
