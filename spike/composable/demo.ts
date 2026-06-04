// spike/composable/demo.ts — runtime verification (bun). Three endpoint shapes,
// dispatched via toHandler; the typed client returns server-identical results
// in-process; toOpenApi emits the structural document.

import { lit, param, path, route, routes, mount } from "./router"
import { toHandler, json } from "./http"
import { client } from "./client"
import { toOpenApi } from "./openapi"
import type { StandardSchema } from "@rhi-zone/fractal-core"

// --- a tiny body schema (no zod) -------------------------------------------
interface NewUser {
  readonly name: string
  readonly email: string
}
const newUser: StandardSchema<unknown, NewUser> = {
  "~standard": {
    version: 1,
    validate(v) {
      const o = v as Partial<NewUser>
      if (typeof o?.name !== "string" || typeof o?.email !== "string") {
        return { issues: [{ message: "name & email required" }] }
      }
      return { value: { name: o.name, email: o.email } }
    },
  },
}

// --- domain ----------------------------------------------------------------
const users = new Map<string, { id: string; name: string }>([["1", { id: "1", name: "Ada" }]])

// (a) GET /users/:id  — typed params, 404 when missing
const getUser = route("GET", path(lit("users"), param("id")), async (ctx) => {
  const u = users.get(ctx.params.id) // ctx.params.id: string (from structure)
  return u === undefined ? json({ error: "USER_NOT_FOUND" }, 404) : json(u)
})

// (b) POST /users  — validated body, returns 201
const createUser = route("POST", path(lit("users")), newUser, async (ctx) => {
  const u = { id: String(users.size + 1), name: ctx.body.name } // ctx.body: NewUser
  users.set(u.id, u)
  return json(u, 201)
})

// (c) POST /users/:id/deactivate — action returning an Outcome → status
type Outcome = { ok: true; id: string } | { ok: false; code: "USER_NOT_FOUND" }
const deactivate = route(
  "POST",
  path(lit("users"), param("id"), lit("deactivate")),
  async (ctx): Promise<Outcome> => {
    return users.has(ctx.params.id)
      ? { ok: true, id: ctx.params.id }
      : { ok: false, code: "USER_NOT_FOUND" }
  },
)

// --- FLAT compose ----------------------------------------------------------
const api = routes(getUser, createUser, deactivate)

// mount demo: prefix value-transform — same routes under /v1
const v1 = mount(path(lit("v1")), routes(getUser))

const dispatch = toHandler(api)

async function main() {
  const log: string[] = []
  const req = (m: string, p: string, b?: unknown) =>
    dispatch(
      new Request(`http://local${p}`, {
        method: m,
        ...(b !== undefined ? { body: JSON.stringify(b), headers: { "content-type": "application/json" } } : {}),
      }),
    )

  // --- dispatch ---
  const r1 = await req("GET", "/users/1")
  log.push(`GET /users/1 -> ${r1.status} ${JSON.stringify(await r1.json())}`)
  const r2 = await req("GET", "/users/999")
  log.push(`GET /users/999 -> ${r2.status} ${JSON.stringify(await r2.json())}`)
  const r3 = await req("POST", "/users", { name: "Bob", email: "b@x" })
  log.push(`POST /users -> ${r3.status} ${JSON.stringify(await r3.json())}`)
  const r3bad = await req("POST", "/users", { name: "Bob" })
  log.push(`POST /users (bad body) -> ${r3bad.status}`)
  const r4 = await req("POST", "/users/1/deactivate")
  log.push(`POST /users/1/deactivate -> ${r4.status} ${JSON.stringify(await r4.json())}`)
  const r5 = await req("DELETE", "/users/1")
  log.push(`DELETE /users/1 (method mismatch) -> ${r5.status} Allow=${r5.headers.get("Allow")}`)
  const r6 = await req("GET", "/nope")
  log.push(`GET /nope -> ${r6.status}`)
  const rv = await toHandler(v1)(new Request("http://local/v1/users/1"))
  log.push(`GET /v1/users/1 (mounted) -> ${rv.status} ${JSON.stringify(await rv.json())}`)

  // --- typed client (in-process, server-identical) ---
  const c = client(api)
  const cu = await c["/users/{id}"].get({ params: { id: "1" } })
  log.push(`client GET /users/{id} -> ${JSON.stringify(cu)}`)
  const cc = await c["/users/{id}/deactivate"].post({ params: { id: "1" } })
  log.push(`client POST deactivate -> ${JSON.stringify(cc)}`)
  const cn = await c["/users"].post({ body: { name: "Cleo", email: "c@x" } })
  log.push(`client POST /users -> ${JSON.stringify(cn)}`)

  // parity: client GET matches a raw dispatch
  const raw = await (await req("GET", "/users/1")).json()
  log.push(`PARITY client==dispatch: ${JSON.stringify(cu) === JSON.stringify(raw)}`)

  // --- openapi ---
  const doc = toOpenApi(api, { title: "users", version: "1.0.0" })
  log.push(`openapi paths: ${JSON.stringify(Object.keys(doc.paths))}`)
  log.push(`openapi /users/{id}.get params: ${JSON.stringify(doc.paths["/users/{id}"]?.get?.parameters)}`)
  log.push(`openapi /users.post requestBody present: ${doc.paths["/users"]?.post?.requestBody !== undefined}`)

  console.log(log.join("\n"))
}

void main()
