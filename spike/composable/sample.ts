// The sample-flavored endpoints from docs/design/vs-hono-elysia.md, written
// in the composable value model, for comparing readability against the
// stringly-typed Hono/Elysia versions.
//
//   (a) GET  /users/:id              → a user or 404
//   (b) POST /users {name,email}     → 201
//   (c) POST /users/:id/deactivate   → Outcome mapped to 200/404/409

import { lit, param, path, route, routes, mount } from "./router";
import { json } from "./http";
import type { StandardSchema } from "@rhi-zone/fractal-api-tree";

interface User {
  readonly id: string;
  readonly name: string;
}
const users = new Map<string, User>();
const newUser: StandardSchema<unknown, { name: string; email: string }> = {
  "~standard": { version: 1, validate: (v) => ({ value: v as { name: string; email: string } }) },
};

// A reusable error->status table — a plain value, applied per action rather
// than duplicated per route.
type UserError = { code: "USER_NOT_FOUND" | "ALREADY_INACTIVE"; id: string };
const userErrorPolicy = (e: UserError) =>
  e.code === "USER_NOT_FOUND"
    ? json({ error: e.code, id: e.id }, 404)
    : json({ error: e.code, id: e.id }, 409);

function deactivate(id: string): { ok: true; user: User } | ({ ok: false } & UserError) {
  const u = users.get(id);
  return u ? { ok: true, user: u } : { ok: false, code: "USER_NOT_FOUND", id };
}

// path values compose; routes() is flat. Param structs give ctx.params.id:string
const app = routes(
  // (a)
  route("GET", path(lit("users"), param("id")), async (ctx) => {
    const u = users.get(ctx.params.id);
    return u === undefined ? json({ error: "USER_NOT_FOUND" }, 404) : json(u);
  }),
  // (b) validated body → 201
  route("POST", path(lit("users")), newUser, async (ctx) => {
    const u: User = { id: "caller", name: ctx.body.name };
    return json(u, 201);
  }),
  // (c) domain Outcome mapped via the reusable policy value
  route("POST", path(lit("users"), param("id"), lit("deactivate")), async (ctx) => {
    const r = deactivate(ctx.params.id);
    return r.ok ? json(r.user, 200) : userErrorPolicy(r);
  }),
);

// a path prefix is itself a value; mount prepends it flat (no string prefix)
const v1 = mount(path(lit("v1")), app);

void [app, v1];
