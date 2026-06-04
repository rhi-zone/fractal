// spike/iron/sample.ts — the sample 3-endpoint snippet from
// docs/design/vs-hono-elysia.md, written in the IRON model (handler is the only
// type; combinators are functions). Judged honestly vs Hono/Elysia for
// reads-clean.
//
//   (a) GET  /users/:id              → a user or 404
//   (b) POST /users {name,email}     → 201
//   (c) POST /users/:id/deactivate   → Outcome mapped to 200/404/409

import { choice, route, path, lit, param, mount, json } from "./http.ts"
import type { StandardSchema } from "@rhi-zone/fractal-core"

interface User {
  readonly id: string
  readonly name: string
}
const users = new Map<string, User>([["1", { id: "1", name: "Ada" }]])

const newUser: StandardSchema<unknown, { name: string; email: string }> = {
  "~standard": { version: 1, validate: (v) => ({ value: v as { name: string; email: string } }) },
}

// a reusable error->status table — a VALUE, applied per action (the fractal win)
type UserError = { code: "USER_NOT_FOUND" | "ALREADY_INACTIVE"; id: string }
const userErrorPolicy = (e: UserError) =>
  e.code === "USER_NOT_FOUND" ? json({ error: e.code, id: e.id }, 404) : json({ error: e.code, id: e.id }, 409)

function deactivate(id: string): { ok: true; user: User } | ({ ok: false } & UserError) {
  const u = users.get(id)
  return u ? { ok: true, user: u } : { ok: false, code: "USER_NOT_FOUND", id }
}

// the app is a handler built by composing handler-returning functions.
export const app = choice(
  // (a) GET /users/:id — typed ctx.params.id: string
  route("GET", path(lit("users"), param("id")), async (ctx) => {
    const u = users.get(ctx.params.id)
    return u === undefined ? json({ error: "USER_NOT_FOUND" }, 404) : json(u)
  }),
  // (b) POST /users — validated body → 201
  route("POST", path(lit("users")), newUser, async (ctx) => {
    const u: User = { id: "caller", name: ctx.input.name }
    return json(u, 201)
  }),
  // (c) POST /users/:id/deactivate — domain Outcome mapped via the policy VALUE
  route("POST", path(lit("users"), param("id"), lit("deactivate")), async (ctx) => {
    const r = deactivate(ctx.params.id)
    return r.ok ? json(r.user, 200) : userErrorPolicy(r)
  }),
)

// a path PREFIX is itself a handler-returning function; mount nests it.
export const v1 = mount(["v1"], app)
