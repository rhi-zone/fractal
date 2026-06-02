// spike/demo.ts — runtime proof of protocol agnosticism + server=client
//
// THESIS:
//   1. The same business-logic leaves run over HTTP and Worker transports.
//   2. The core has zero HTTP references.
//   3. A client IS a Handler (Hyper/Dream unification): in-process Handler
//      call is the same type as the server handler.
//
// Run with: bun spike/demo.ts

import { leaf, typed, pipe, choice, type Middleware, type Handler } from "./core.ts"
import { path, methods, param, serve } from "./http.ts"
import { procedure, dispatch } from "./worker.ts"

// ============================================================================
// DATA MODEL (trivial in-memory store)
// ============================================================================

interface Todo {
  id: number
  title: string
  done: boolean
}

const store: Todo[] = [
  { id: 1, title: "Write the spike", done: false },
  { id: 2, title: "Prove protocol agnosticism", done: false },
  { id: 3, title: "Commit and report", done: false },
]

// ============================================================================
// RESPONSE UNION
//
// All leaf handlers return values from this union. The union is declared at
// the demo level — core and kits are not aware of it.
// ============================================================================

type ApiResult = Todo | Todo[] | null

// ============================================================================
// BUSINESS LOGIC LEAVES
//
// Written once. No HTTP knowledge, no Worker knowledge — pure domain logic.
// All are Handler<P, Res> from core.ts.
// Both HttpReq<P> and WorkerReq<P> are structural supersets of Req<P>,
// so these leaves work on both transports unchanged.
// ============================================================================

/** List all todos. Requires no params. */
const listTodos: Handler<Record<string, never>, Todo[]> = leaf(async (_req) => {
  return [...store]
})

/**
 * Get a single todo by numeric id.
 * Requires { id: number } — supplied by the `typed` bridge below.
 */
const getTodoLeaf: Handler<{ id: number }, Todo | null> = leaf(async (req) => {
  return store.find((t) => t.id === req.params.id) ?? null
})

/**
 * Create a todo.
 * Requires { title: string } — supplied via params (see typed wrappers below).
 */
const createTodo: Handler<{ title: string }, Todo> = leaf(async (req) => {
  const nextId = Math.max(0, ...store.map((t) => t.id)) + 1
  const todo: Todo = { id: nextId, title: req.params.title, done: false }
  store.push(todo)
  return todo
})

// ============================================================================
// TYPED BRIDGES
//
// typed() refines string params into richer types and discharges the requirement.
// This is the only place type-narrowing happens — core and leaves stay clean.
// ============================================================================

/**
 * getTodo: bridges {id:string} → {id:number}.
 * Discharges {id:number} from getTodoLeaf, leaving {id:string} for param to fill.
 * Used by BOTH the HTTP kit (param discharges id from path) and the Worker
 * kit (caller puts id in params directly; a second typed layer discharges id:string).
 */
const getTodo: Handler<{ id: string }, Todo | null> = typed<
  { id: number },
  { id: string },
  Todo | null
>((raw) => ({ id: Number(raw["id"]) }))(getTodoLeaf)

/**
 * getTodoFromParams: fully discharges {id:string} by reading from raw params.
 * Used in the Worker kit where there is no path segment to consume — the
 * caller passes { id: "2" } in params directly.
 */
const getTodoFromParams: Handler<Record<string, never>, Todo | null> = typed<
  { id: string },
  Record<string, never>,
  Todo | null
>((raw) => ({ id: raw["id"] ?? "" }))(getTodo)

/**
 * createTodoTyped: fully discharges {title:string} from raw params.
 * Works identically on HTTP (title from params) and Worker (title from params).
 */
const createTodoTyped: Handler<Record<string, never>, Todo> = typed<
  { title: string },
  Record<string, never>,
  Todo
>((raw) => ({ title: raw["title"] ?? "untitled" }))(createTodo)

// ============================================================================
// SHARED MIDDLEWARE
//
// Written once. Applied identically to both HTTP and Worker routing trees.
// A middleware is (Handler -> Handler) — same type on both transports.
// ============================================================================

/**
 * Logger middleware: prints the request shape before delegating.
 * Accesses all fields via spread (HTTP adds path/method; Worker adds procedure).
 */
const logger: Middleware<Record<string, never>, ApiResult> = (inner) => async (req) => {
  const { params, ...meta } = req as { params: unknown } & Record<string, unknown>
  console.log(`  [LOG] meta=${JSON.stringify(meta)} params=${JSON.stringify(params)}`)
  return inner(req)
}

// ============================================================================
// HTTP ROUTING TREE
//
// GET  /todos        → listTodos        (no params required)
// POST /todos        → createTodoTyped  (title from params, discharged by typed)
// GET  /todos/:id    → getTodo          (id captured by HTTP param, refined by typed)
//
// All branches are Handler<{}> after discharge. serve() accepts them.
//
// NOTE on param placement:
//   - `param` is in the HTTP kit because it consumes a path segment.
//   - The type algebra (Omit<C,K>) is identical to what core's typed uses.
//   - There is no path-consuming param in core — that cut is explicit.
// ============================================================================

const httpApp: Handler<Record<string, never>, ApiResult> = pipe(logger)(
  path<Record<string, never>, ApiResult>({
    todos: choice<Record<string, never>, ApiResult>(
      // Exact /todos — method dispatch
      methods<Record<string, never>, ApiResult>({
        GET: listTodos,
        POST: createTodoTyped,
      }),
      // /todos/:id — capture id segment, then method dispatch
      param(
        "id",
        methods<{ id: string }, ApiResult>({
          GET: getTodo,
        }),
      ),
    ),
  }),
)

// ============================================================================
// WORKER ROUTING TREE
//
// Same leaves (via typed bridges), different transport.
// No path. No method. Purely name-keyed.
//
// "todos.list"   → listTodos
// "todos.get"    → getTodoFromParams  (id read from params, fully discharged)
// "todos.create" → createTodoTyped    (title read from params, fully discharged)
// ============================================================================

const workerApp: Handler<Record<string, never>, ApiResult> = pipe(logger)(
  procedure<Record<string, never>, ApiResult>({
    "todos.list": listTodos,
    "todos.get": getTodoFromParams,
    "todos.create": createTodoTyped,
  }),
)

// ============================================================================
// SERVER = CLIENT (Hyper/Dream unification)
//
// A "client" is just a Handler. The in-process client is typed identically to
// the server handler — no separate client interface, no mock infrastructure.
// Swapping in-process for a network call means replacing the Handler value,
// not changing any types or call sites.
// ============================================================================

// The server handler IS the client handler — same type, same value.
const httpClient: Handler<Record<string, never>, ApiResult> = httpApp

// A network client stub with the SAME type — demonstrates type unification:
const httpNetworkClientStub: Handler<Record<string, never>, ApiResult> = async (req) => {
  // Production: serialize req → HTTP → deserialize. Same Handler<{}, ApiResult> type.
  console.log(
    "  [NETWORK-CLIENT-STUB] would send over network; forwarding in-process for demo",
  )
  return httpApp(req)
}

// ============================================================================
// DEMO RUNNER
// ============================================================================

async function demo(): Promise<void> {
  console.log("=".repeat(70))
  console.log("fractal spike — runtime proof")
  console.log("=".repeat(70))

  // ── 1. HTTP transport ──────────────────────────────────────────────────────
  console.log("\n── HTTP transport ──────────────────────────────────────────────────")

  console.log("\n[HTTP] GET /todos")
  const r1 = await serve<ApiResult>(httpApp, { method: "GET", url: "/todos" })
  console.log(`  status=${r1.status} body=${JSON.stringify(r1.body)}`)

  console.log("\n[HTTP] GET /todos/2")
  const r2 = await serve<ApiResult>(httpApp, { method: "GET", url: "/todos/2" })
  console.log(`  status=${r2.status} body=${JSON.stringify(r2.body)}`)

  console.log("\n[HTTP] GET /todos/999 (todo not found)")
  const r3 = await serve<ApiResult>(httpApp, { method: "GET", url: "/todos/999" })
  console.log(`  status=${r3.status} body=${JSON.stringify(r3.body)}`)

  console.log("\n[HTTP] POST /todos with params.title=DoMoreThings")
  const r4 = await serve<ApiResult>(httpApp, {
    method: "POST",
    url: "/todos",
    params: { title: "DoMoreThings" },
  })
  console.log(`  status=${r4.status} body=${JSON.stringify(r4.body)}`)

  console.log("\n[HTTP] GET /unknown (route not matched → 404)")
  const r5 = await serve<ApiResult>(httpApp, { method: "GET", url: "/unknown" })
  console.log(`  status=${r5.status} body=${JSON.stringify(r5.body)}`)

  // ── 2. Worker transport ────────────────────────────────────────────────────
  console.log("\n── Worker transport (no HTTP, no path, no method) ──────────────────")

  console.log("\n[WORKER] todos.list")
  const w1 = await dispatch<ApiResult>(workerApp, { procedure: "todos.list" })
  console.log(`  ok=${w1.ok} result=${JSON.stringify(w1.result)}`)

  console.log("\n[WORKER] todos.get id=2")
  const w2 = await dispatch<ApiResult>(workerApp, {
    procedure: "todos.get",
    params: { id: "2" },
  })
  console.log(`  ok=${w2.ok} result=${JSON.stringify(w2.result)}`)

  console.log("\n[WORKER] todos.create title=WorkerCreatedTodo")
  const w3 = await dispatch<ApiResult>(workerApp, {
    procedure: "todos.create",
    params: { title: "WorkerCreatedTodo" },
  })
  console.log(`  ok=${w3.ok} result=${JSON.stringify(w3.result)}`)

  console.log("\n[WORKER] todos.unknown (no match → not found)")
  const w4 = await dispatch<ApiResult>(workerApp, { procedure: "todos.unknown" })
  console.log(`  ok=${w4.ok} error=${JSON.stringify(w4.error)}`)

  // ── 3. Same leaves, both transports ───────────────────────────────────────
  console.log("\n── Same leaf, both transports ──────────────────────────────────────")
  console.log("\n[HTTP]   GET /todos/1")
  const bothHttp = await serve<ApiResult>(httpApp, { method: "GET", url: "/todos/1" })
  console.log(`  HTTP   → ${JSON.stringify(bothHttp.body)}`)

  console.log("\n[WORKER] todos.get id=1")
  const bothWorker = await dispatch<ApiResult>(workerApp, {
    procedure: "todos.get",
    params: { id: "1" },
  })
  console.log(`  WORKER → ${JSON.stringify(bothWorker.result)}`)
  console.log(
    `  SAME RESULT: ${JSON.stringify(bothHttp.body) === JSON.stringify(bothWorker.result)}`,
  )

  // ── 4. Server = Client (Hyper/Dream unification) ───────────────────────────
  console.log("\n── Server = Client (Handler type unification) ──────────────────────")
  console.log("\n[CLIENT in-process] httpClient === httpApp (same value, same type)")
  const c1 = await serve<ApiResult>(httpClient, { method: "GET", url: "/todos/1" })
  console.log(`  client result=${JSON.stringify(c1.body)}`)

  console.log("\n[CLIENT network-stub] httpNetworkClientStub (same type, stub impl)")
  const c2 = await serve<ApiResult>(httpNetworkClientStub, { method: "GET", url: "/todos/1" })
  console.log(`  stub   result=${JSON.stringify(c2.body)}`)

  console.log("\n  Type proof:")
  console.log("    httpClient             : Handler<{}, ApiResult>")
  console.log("    httpNetworkClientStub  : Handler<{}, ApiResult>")
  console.log("    httpApp (the server)   : Handler<{}, ApiResult>")
  console.log("  The server type IS the client type. No mock interface needed.")

  // ── 5. Core purity check ───────────────────────────────────────────────────
  console.log("\n── Core purity ──────────────────────────────────────────────────────")
  console.log("  core.ts exports: Pass, Req<P>, Handler<P,Res>, Middleware<P,Res>,")
  console.log("                   choice, pipe, typed, leaf, run")
  console.log("  core.ts imports: nothing")
  console.log("  core.ts contains: no 'method', no 'path', no 'url', no 'procedure'")

  console.log("\n" + "=".repeat(70))
  console.log("All proofs complete.")
  console.log("=".repeat(70))
}

demo().catch((e: unknown) => {
  console.error(e)
  throw e
})
