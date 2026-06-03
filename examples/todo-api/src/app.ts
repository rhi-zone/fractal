// examples/todo-api/src/app.ts
//
// A small but real example on the library-first framework.
//
// Exercises:
//   - a CRUD-ish resource via library functions wrapped with withValidation
//   - an /admin mount with auth middleware adding typed context
//     (the handler reads ctx.vars.user with NO cast)
//   - a validated body route (200 on success, 400 on bad input)
//   - an SSE endpoint (text/event-stream)
//   - a raw req.query read
//
// Everything is plain data composed from the framework primitives. The app is
// a Router value; toHandler(app) turns it into a WHATWG (Request)=>Response.

import {
  binary,
  err,
  httpRouter,
  json,
  ok,
  respond,
  sse,
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
// A tiny object-schema fixture (StandardSchema-shaped; no external dep)
// ---------------------------------------------------------------------------

function schema<const F extends Record<string, "string" | "number">>(
  fields: F,
): StandardSchema<unknown, { [K in keyof F]: F[K] extends "string" ? string : number }> {
  type Out = { [K in keyof F]: F[K] extends "string" ? string : number }
  return {
    "~standard": {
      version: 1,
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "expected an object" }] }
        }
        const obj = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const [k, t] of Object.entries(fields)) {
          if (typeof obj[k] !== t) return { issues: [{ message: `field "${k}" must be a ${t}` }] }
          out[k] = obj[k]
        }
        return { value: out as Out }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Domain — an in-memory todo store and plain library functions
// ---------------------------------------------------------------------------

export interface Todo {
  id: string
  title: string
  done: boolean
}

const todos: Todo[] = []
let seq = 1

// Library functions — pure-ish business logic, surface-agnostic. These are the
// values withValidation wraps; the validator's output type is checked ≡ Args.
async function createTodo(args: { title: string }): Promise<Todo> {
  const todo: Todo = { id: String(seq++), title: args.title, done: false }
  todos.push(todo)
  return todo
}

async function setDone(args: { id: string; done: boolean }): Promise<Todo | null> {
  const todo = todos.find((t) => t.id === args.id)
  if (todo === undefined) return null
  todo.done = args.done
  return todo
}

// ---------------------------------------------------------------------------
// Domain Result + USER-SIDE error policy
//
// This is the sample `switch (result.error.code)` pattern expressed against
// the framework's GENERAL Outcome + ErrorPolicy mechanism. The error codes and
// the code→status table live HERE, in the app — the framework knows none of it.
// ---------------------------------------------------------------------------

/** A domain error with a discriminating `code`, exactly like sample. */
type TodoError =
  | { code: "TODO_NOT_FOUND"; id: string }
  | { code: "ALREADY_DONE"; id: string }

/** The user's error→status policy. The framework hardcodes none of this. */
const todoErrorPolicy: ErrorPolicy<TodoError> = (e) => {
  switch (e.code) {
    case "TODO_NOT_FOUND":
      return { status: 404, body: { error: e.code, id: e.id } }
    case "ALREADY_DONE":
      return { status: 409, body: { error: e.code, id: e.id } }
  }
}

/** A library function returning a domain Result (not a Response). */
async function markDone(args: { id: string }): Promise<Outcome<Todo, TodoError>> {
  const todo = todos.find((t) => t.id === args.id)
  if (todo === undefined) return err({ code: "TODO_NOT_FOUND", id: args.id })
  if (todo.done) return err({ code: "ALREADY_DONE", id: args.id })
  todo.done = true
  return ok(todo)
}

// ---------------------------------------------------------------------------
// Auth middleware — adds typed `user` to ctx.vars
// ---------------------------------------------------------------------------

export interface AuthVars extends Record<string, unknown> {
  user: { id: string; email: string }
}

const auth: HttpMiddleware<NoVars, AuthVars> = async (ctx, next) => {
  const email = ctx.headers.get("x-user")
  if (email === null) return json({ error: "Forbidden" }, 403)
  const enriched: WithVars<HttpCtx, NoVars & AuthVars> = {
    ...ctx,
    vars: { user: { id: "u-1", email } },
  }
  return next(enriched)
}

// ---------------------------------------------------------------------------
// /admin sub-router — handlers read ctx.vars.user with ZERO casts
// ---------------------------------------------------------------------------

const admin = httpRouter<NoVars & AuthVars>()
  .route("GET", "/me", async (ctx) =>
    // No cast: ctx.vars.user is typed { id: string; email: string }
    json({ user: ctx.vars.user }),
  )
  .route("GET", "/stats", async (ctx) =>
    json({ requestedBy: ctx.vars.user.email, total: todos.length }),
  )

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------

export const app = httpRouter<NoVars>()
  // List todos
  .route("GET", "/todos", async () => json(todos))
  // Create todo via a library function wrapped with withValidation (200 / 400)
  .routeNode("POST", "/todos", withValidation(createTodo, schema({ title: "string" })))
  // Update done flag — validated body (200 / 400; 404 if id unknown)
  .routeNode(
    "POST",
    "/todos/done",
    withValidation(async (args: { id: string; done: boolean }) => {
      const updated = await setDone(args)
      return updated ?? { error: "not found" }
    }, {
      "~standard": {
        version: 1,
        validate(value: unknown) {
          if (typeof value !== "object" || value === null) {
            return { issues: [{ message: "expected an object" }] }
          }
          const obj = value as Record<string, unknown>
          if (typeof obj["id"] !== "string") return { issues: [{ message: "id must be a string" }] }
          if (typeof obj["done"] !== "boolean") return { issues: [{ message: "done must be a boolean" }] }
          return { value: { id: obj["id"], done: obj["done"] } }
        },
      },
    }),
  )
  // Result→Response: handler returns a domain Outcome; respond() applies the
  // USER-SIDE policy (TODO_NOT_FOUND→404, ALREADY_DONE→409). ok → 200 JSON.
  .route(
    "POST",
    "/todos/:id/mark-done",
    respond(
      (ctx) => markDone({ id: ctx.params["id"] ?? "" }),
      todoErrorPolicy,
    ),
  )
  // Plain value → JSON: handler returns a non-Response value; the default JSON
  // renderer (via respond) turns it into 200 application/json.
  .route(
    "GET",
    "/count",
    respond(() => ({ total: todos.length }), todoErrorPolicy),
  )
  // Raw query read — no capture combinator
  .route("GET", "/search", async (ctx) => {
    const q = ctx.query.get("q")
    const limit = ctx.query.get("limit")
    return json({ q, limit, raw: true })
  })
  // SSE endpoint — ordinary text/event-stream Response
  .route("GET", "/events", async () =>
    sse((emit) => {
      emit("connected", { ts: 0 })
      emit("status", { active: true })
      emit("done", { count: todos.length })
    }),
  )
  // Binary endpoint — ordinary Response with a byte body
  .route("GET", "/favicon", async () =>
    binary(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"),
  )
  // /admin behind auth middleware, declared ONCE at the mount
  .mount("/admin", auth, admin)

/** WHATWG fetch handler for the app. Run in-process with new Request(...). */
export const handle = toHandler(app)
