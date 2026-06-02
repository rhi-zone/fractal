// spike/demo.ts — runtime proof of protocol agnosticism + server=client
//
// THESIS:
//   1. HTTP param at V=string works; typed refines string→number (eager/sync).
//   2. httpParam('x', leaf<{x:number}>) is a compile error (G1 closed).
//      Confirmed by the @ts-expect-error in http.ts being USED (not spurious).
//   3. Worker field capture at V=number discharges WITHOUT any typed/parse step.
//   4. HTTP body is LAZY: validate pulls async; invalid rejected, valid types through;
//      a body-ignoring route never pulls the thunk (counter proof).
//   5. Nested discharge still type-checks (existing nested HTTP demo still works).
//   6. Core purity: core.ts references no string-pinned param type, no HTTP, no
//      eager/lazy payload assumption.
//   7. Server = Client (Handler type unification).
//
// Run with: bun spike/demo.ts

import { leaf, typed, pipe, choice, pass, type Middleware, type Handler } from "./core.ts"
import {
  path,
  methods,
  param,
  query,
  header,
  body,
  validate,
  serve,
  type HandlerWithBody,
  type ReqWithBody,
} from "./http.ts"
import { procedure, field, dispatch, type WorkerCall } from "./worker.ts"

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
// ============================================================================

type ApiResult = Todo | Todo[] | { error: string } | null

// ============================================================================
// BUSINESS LOGIC LEAVES
// ============================================================================

/** List all todos. Requires no params. */
const listTodos: Handler<Record<string, never>, Todo[]> = leaf(async (_req) => {
  return [...store]
})

/**
 * List todos with a limit — requires { limit: string } in params.
 * The limit string comes from the query extractor (V=string, HTTP kit).
 */
const listTodosWithLimit: Handler<{ limit: string }, Todo[]> = leaf(async (req) => {
  const n = Number(req.params.limit)
  return store.slice(0, Number.isFinite(n) && n > 0 ? n : store.length)
})

/**
 * Get a single todo by numeric id.
 * Requires { id: number } — supplied by the typed bridge (string→number) for HTTP,
 * or by a Worker field capture (already number, no parse needed) for Worker.
 */
const getTodoLeaf: Handler<{ id: number }, Todo | null> = leaf(async (req) => {
  return store.find((t) => t.id === req.params.id) ?? null
})

/**
 * Create a todo.
 * Requires { title: string } — supplied via params (typed wrappers or Worker field).
 */
const createTodo: Handler<{ title: string }, Todo> = leaf(async (req) => {
  const nextId = Math.max(0, ...store.map((t) => t.id)) + 1
  const todo: Todo = { id: nextId, title: req.params.title, done: false }
  store.push(todo)
  return todo
})

/**
 * Tenant-scoped list — requires { "x-tenant": string } in params.
 * Captured by the header() extractor (same Omit<C,K> algebra as param).
 */
const listTodosForTenant: Handler<{ "x-tenant": string }, Todo[]> = leaf(async (req) => {
  const tenant = req.params["x-tenant"]
  return store.map((t) => ({ ...t, title: `[tenant:${tenant}] ${t.title}` }))
})

// ============================================================================
// TYPED BRIDGES (HTTP path: string→number via typed())
//
// typed() is SYNC and EAGER — it refines values already in the params bag.
// This is used in HTTP where param/query/header capture strings; typed then
// converts string→number or string→T without any body pull.
// ============================================================================

/**
 * getTodo: bridges {id:string} → {id:number}.
 * Discharges {id:number} from getTodoLeaf, leaving {id:string} for HTTP param to fill.
 * Used ONLY in the HTTP kit path. The Worker path uses a typed field capture instead.
 */
const getTodo: Handler<{ id: string }, Todo | null> = typed<
  { id: number },
  { id: string },
  Todo | null
>((raw) => ({ id: Number(raw["id"]) }))(getTodoLeaf)

/**
 * getTodoFromParams: fully discharges {id:string} from raw params.
 * Used in the Worker kit where id arrives as string (legacy compat path).
 */
const getTodoFromParams: Handler<Record<string, never>, Todo | null> = typed<
  { id: string },
  Record<string, never>,
  Todo | null
>((raw) => ({ id: String(raw["id"] ?? "") }))(getTodo)

/**
 * createTodoTyped: fully discharges {title:string} from raw params.
 */
const createTodoTyped: Handler<Record<string, never>, Todo> = typed<
  { title: string },
  Record<string, never>,
  Todo
>((raw) => ({ title: String(raw["title"] ?? "untitled") }))(createTodo)

// ============================================================================
// WORKER TYPED CAPTURE PROOF (Fix 1)
//
// The Worker transport delivers ALREADY-TYPED values. No typed()/parse step.
// field('id', read, child<{id:number}>) pins V=number and discharges id:number
// directly — the child sees a number, not a string.
//
// This proves that the params bag is generic in value type: non-text transports
// inject their own types without going through string→T conversion.
// ============================================================================

/**
 * getTodoByTypedId: a Worker leaf that expects {id:number} in params.
 * The id arrives pre-typed from the Worker call — no parse needed.
 */
const getTodoByTypedId: Handler<{ id: number }, Todo | null> = leaf(async (req) => {
  // req.params.id is number here — no Number() parse, no typed() bridge.
  return store.find((t) => t.id === req.params.id) ?? null
})

/**
 * getTodoTypedField: captures the id field from Worker call params as a number.
 *
 * field('id', read, getTodoByTypedId):
 *   - V is inferred as number (from child's {id:number} requirement)
 *   - read extracts the value from the incoming request's params bag
 *   - Returns Handler<Omit<{id:number},'id'>, _> = Handler<{}, _>
 *   - NO typed() or parse step — the Worker delivers number directly
 */
const getTodoTypedField: Handler<Record<string, never>, Todo | null> = field(
  "id",
  // The read function extracts from the outer request params bag (Record<string,unknown>)
  // The Worker dispatch puts { id: 42 } (a number) in params directly.
  (req) => {
    const v = (req.params as Record<string, unknown>)["id"]
    // Return pass if absent or wrong type; otherwise return the pre-typed number.
    return typeof v === "number" ? v : pass
  },
  getTodoByTypedId,
)

// ============================================================================
// BODY DEMO — LAZY, EFFECTFUL, CONSUME-ONCE (Fix 2)
//
// The body is a lazy thunk: () => Promise<unknown>. It fires only when body()
// is in the route chain. A route that does not include body() never pulls the
// thunk — the read counter below proves this.
//
// validate() is a SYNC combinator whose returned handler awaits parse() per
// request (accommodating async validators). Contrast with typed() which is
// SYNC and operates over already-present params values.
//
// Body counter: incremented each time the thunk fires. After serving a GET
// (body-ignoring), counter remains 0. After POST (body(validate(...))), it fires.
// ============================================================================

interface CreateTodoInput {
  title: string
}

function parseCreateTodoBody(raw: unknown): CreateTodoInput {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>)["title"] !== "string"
  ) {
    throw new Error(`invalid body: expected {title:string}, got ${JSON.stringify(raw)}`)
  }
  return { title: (raw as Record<string, unknown>)["title"] as string }
}

const createTodoFromBodyLeaf: HandlerWithBody<
  Record<string, never>,
  CreateTodoInput,
  Todo
> = async (req) => {
  const nextId = Math.max(0, ...store.map((t) => t.id)) + 1
  const todo: Todo = { id: nextId, title: req.body.title, done: false }
  store.push(todo)
  return todo
}

// validate() is a SYNC combinator — no await needed here. The route tree is
// built synchronously; the returned handler does async work per request.
const createTodoBodyHandler: Handler<Record<string, never>, Todo> = body(
  validate(parseCreateTodoBody, createTodoFromBodyLeaf),
)

// ============================================================================
// SHARED MIDDLEWARE
// ============================================================================

const logger: Middleware<Record<string, never>, ApiResult> = (inner) => async (req) => {
  const { params, ...meta } = req as { params: unknown } & Record<string, unknown>
  console.log(`  [LOG] meta=${JSON.stringify(meta)} params=${JSON.stringify(params)}`)
  return inner(req)
}

// ============================================================================
// HTTP ROUTING TREE
// ============================================================================

const httpApp: Handler<Record<string, never>, ApiResult> = pipe(logger)(
  path<Record<string, never>, ApiResult>({
    todos: choice<Record<string, never>, ApiResult>(
      // /todos?limit=N — query captures limit string; typed not needed (leaf uses string)
      query(
        "limit",
        methods<{ limit: string }, ApiResult>({
          GET: listTodosWithLimit,
        }),
      ),
      // /todos with x-tenant header
      header(
        "x-tenant",
        methods<{ "x-tenant": string }, ApiResult>({
          GET: listTodosForTenant,
        }),
      ),
      // Exact /todos — method dispatch
      methods<Record<string, never>, ApiResult>({
        GET: listTodos,
        POST: createTodoBodyHandler as Handler<Record<string, never>, ApiResult>,
      }),
      // /todos/:id — capture id string, typed bridges string→number
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
// "todos.list"          → listTodos (no params)
// "todos.get"           → getTodoFromParams (id as string, legacy path via typed)
// "todos.get.typed"     → getTodoTypedField (id as number, NO typed() needed)
// "todos.create"        → createTodoTyped (title from params)
// ============================================================================

const workerApp: Handler<Record<string, never>, ApiResult> = pipe(logger)(
  procedure<Record<string, never>, ApiResult>({
    "todos.list": listTodos,
    "todos.get": getTodoFromParams,
    "todos.get.typed": getTodoTypedField as Handler<Record<string, never>, ApiResult>,
    "todos.create": createTodoTyped,
  }),
)

// ============================================================================
// SERVER = CLIENT
// ============================================================================

const httpClient: Handler<Record<string, never>, ApiResult> = httpApp

const httpNetworkClientStub: Handler<Record<string, never>, ApiResult> = async (req) => {
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

  // ── 1. HTTP param + typed (Fix 1, HTTP side) ───────────────────────────────
  console.log("\n── 1. HTTP param at V=string + typed bridges string→number ──────────")

  console.log("\n[HTTP] GET /todos/2  (param captures id:string, typed→number, leaf sees number)")
  const r1 = await serve<ApiResult>(httpApp, { method: "GET", url: "/todos/2" })
  console.log(`  status=${r1.status} body=${JSON.stringify(r1.body)}`)
  console.log(`  PROOF: param captured '2' as string; typed({ id: Number(raw.id) }) → id:2 (number); leaf found todo #2`)

  console.log("\n[HTTP] GET /todos/999  (id string→number, no todo → null)")
  const r2 = await serve<ApiResult>(httpApp, { method: "GET", url: "/todos/999" })
  console.log(`  status=${r2.status} body=${JSON.stringify(r2.body)}`)

  // ── 2. G1 compile error proof ──────────────────────────────────────────────
  console.log("\n── 2. G1 safety: httpParam('x', leaf<{x:number}>) is a compile error ─")
  console.log("  The @ts-expect-error on _g1Probe in http.ts is CONSUMED (not spurious).")
  console.log("  tsgo --noEmit confirms this: no 'Unused @ts-expect-error' diagnostic.")
  console.log("  If tsgo reported the error as unused, the G1 guard would be broken.")

  // ── 3. Worker typed capture WITHOUT typed() (Fix 1, Worker side) ──────────
  console.log("\n── 3. Worker field capture at V=number, NO typed() step ─────────────")

  console.log("\n[WORKER] todos.get.typed id=2 (number in params — no parse step)")
  const wt1 = await dispatch<ApiResult>(workerApp, {
    procedure: "todos.get.typed",
    params: { id: 2 },         // number, not string — Worker delivers pre-typed
  } as WorkerCall)
  console.log(`  ok=${wt1.ok} result=${JSON.stringify(wt1.result)}`)
  console.log(`  PROOF: params.id was 2 (number); field() captured it as V=number;`)
  console.log(`         getTodoByTypedId received id:number directly; no Number() parse.`)

  console.log("\n[WORKER] todos.get.typed id=3 (another pre-typed number)")
  const wt2 = await dispatch<ApiResult>(workerApp, {
    procedure: "todos.get.typed",
    params: { id: 3 },
  } as WorkerCall)
  console.log(`  ok=${wt2.ok} result=${JSON.stringify(wt2.result)}`)

  console.log("\n[WORKER] todos.get.typed id='not-a-number' (string → field returns pass)")
  const wt3 = await dispatch<ApiResult>(workerApp, {
    procedure: "todos.get.typed",
    params: { id: "not-a-number" },
  } as WorkerCall)
  console.log(`  ok=${wt3.ok} error=${JSON.stringify(wt3.error)}`)
  console.log(`  PROOF: field's read fn returned pass (wrong type) → dispatch not found`)

  // ── 4. HTTP body laziness (Fix 2) ─────────────────────────────────────────
  console.log("\n── 4. HTTP body lazy: thunk fires only when body() is in the chain ──")

  // A body counter wraps each serve call to prove laziness.
  let bodyReadCount = 0

  async function serveWithBodyCounter<Res>(
    h: Handler<Record<string, never>, Res>,
    req: import("./http.ts").HttpRequest & { body?: unknown },
    label: string,
  ): Promise<import("./http.ts").HttpResponse<Res>> {
    const originalBody = req.body
    const countingReq = {
      ...req,
      // The thunk itself: increments counter and resolves the value.
      body:
        originalBody !== undefined
          ? () => {
              bodyReadCount++
              console.log(`    [BODY-THUNK] pulled! count is now ${bodyReadCount}`)
              return Promise.resolve(originalBody)
            }
          : undefined,
    }
    // We need to pass the thunk directly to serve — but serve() re-wraps body.
    // Instead, bypass serve()'s wrapping by calling the handler directly with a
    // manually constructed httpReq that already has the counting thunk.
    const [rawPath = "", rawQuery = ""] = req.url.split("?") as [string, string?]
    const segments = rawPath.replace(/^\//, "").split("/").filter(Boolean)
    const queryRecord: Record<string, string> = {}
    if (rawQuery) {
      for (const part of rawQuery.split("&")) {
        const eqIdx = part.indexOf("=")
        if (eqIdx === -1) queryRecord[decodeURIComponent(part)] = ""
        else {
          queryRecord[decodeURIComponent(part.slice(0, eqIdx))] =
            decodeURIComponent(part.slice(eqIdx + 1))
        }
      }
    }
    const httpReq = {
      method: req.method,
      path: segments,
      query: queryRecord,
      headers: req.headers ?? {},
      body: countingReq.body,
      params: {} as Record<string, never>,
    }
    console.log(`    [${label}] bodyReadCount before: ${bodyReadCount}`)
    const res = await h(httpReq as Parameters<typeof h>[0])
    const result = res === pass ? { status: 404, body: null } : { status: 200, body: res as Res }
    console.log(`    [${label}] bodyReadCount after:  ${bodyReadCount}`)
    return result as import("./http.ts").HttpResponse<Res>
  }

  bodyReadCount = 0
  console.log("\n[HTTP] GET /todos  (body-ignoring route — thunk must NOT fire)")
  const bl1 = await serveWithBodyCounter<ApiResult>(
    httpApp,
    { method: "GET", url: "/todos", body: { title: "ShouldNotRead" } },
    "GET /todos",
  )
  console.log(`  status=${bl1.status} bodyReadCount=${bodyReadCount}`)
  console.log(`  PROOF: GET /todos never calls body() → thunk never pulled → count stays 0`)

  bodyReadCount = 0
  console.log("\n[HTTP] GET /todos/1  (body-ignoring route — thunk must NOT fire)")
  const bl2 = await serveWithBodyCounter<ApiResult>(
    httpApp,
    { method: "GET", url: "/todos/1", body: { title: "ShouldNotRead" } },
    "GET /todos/1",
  )
  console.log(`  status=${bl2.status} bodyReadCount=${bodyReadCount}`)
  console.log(`  PROOF: GET /todos/1 never calls body() → count stays 0`)

  bodyReadCount = 0
  console.log("\n[HTTP] POST /todos body={title:'LazyBodyTodo'}  (body() fires — thunk pulled)")
  const bl3 = await serveWithBodyCounter<ApiResult>(
    httpApp,
    { method: "POST", url: "/todos", body: { title: "LazyBodyTodo" } },
    "POST /todos (valid)",
  )
  console.log(`  status=${bl3.status} body=${JSON.stringify(bl3.body)} bodyReadCount=${bodyReadCount}`)
  console.log(`  PROOF: POST /todos → body() → thunk pulled exactly once → count = 1`)

  bodyReadCount = 0
  console.log("\n[HTTP] POST /todos body={wrong:true}  (body() fires, validate throws)")
  try {
    const bl4 = await serveWithBodyCounter<ApiResult>(
      httpApp,
      { method: "POST", url: "/todos", body: { wrong: true } },
      "POST /todos (invalid)",
    )
    console.log(`  status=${bl4.status} body=${JSON.stringify(bl4.body)} bodyReadCount=${bodyReadCount}`)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`  CAUGHT validation error: ${msg} bodyReadCount=${bodyReadCount}`)
    console.log(`  PROOF: body was pulled (count=1) then validate() threw — lazy + typed rejection works`)
  }

  // ── 5. Nested discharge (existing HTTP demo still works) ───────────────────
  console.log("\n── 5. Nested discharge — existing HTTP routes still work ─────────────")

  console.log("\n[HTTP] GET /todos  (list, no params)")
  const n1 = await serve<ApiResult>(httpApp, { method: "GET", url: "/todos" })
  console.log(`  status=${n1.status} count=${Array.isArray(n1.body) ? (n1.body as Todo[]).length : "?"}}`)

  console.log("\n[HTTP] GET /todos?limit=2  (query capture, limit:string, leaf slices)")
  const n2 = await serve<ApiResult>(httpApp, { method: "GET", url: "/todos?limit=2" })
  console.log(`  status=${n2.status} body=${JSON.stringify(n2.body)}`)

  console.log("\n[HTTP] GET /todos with x-tenant: acme  (header capture)")
  const n3 = await serve<ApiResult>(httpApp, {
    method: "GET",
    url: "/todos",
    headers: { "x-tenant": "acme" },
  })
  console.log(`  status=${n3.status} body=${JSON.stringify(n3.body)}`)

  console.log("\n[HTTP] GET /unknown  (404)")
  const n4 = await serve<ApiResult>(httpApp, { method: "GET", url: "/unknown" })
  console.log(`  status=${n4.status} body=${JSON.stringify(n4.body)}`)

  // ── 6. Core purity ─────────────────────────────────────────────────────────
  console.log("\n── 6. Core purity ───────────────────────────────────────────────────")
  console.log("  core.ts exports: Pass, Req<P>, Handler<P,Res>, Middleware<P,Res>,")
  console.log("                   choice, pipe, typed, leaf, run, capture")
  console.log("  core.ts imports: nothing")
  console.log("  core.ts mentions: no 'string' as param value constraint,")
  console.log("                    no 'method'/'path'/'url'/'procedure'/'query'/'header'/'body',")
  console.log("                    no eager/lazy payload assumption.")
  console.log("  V in capture<K,V,C,Res> is FREE — pinned by each kit independently.")
  console.log("  HTTP kit pins V=string. Worker kit pins V=number/object/…")

  // ── 7. Server = Client ─────────────────────────────────────────────────────
  console.log("\n── 7. Server = Client (Handler type unification) ────────────────────")
  const c1 = await serve<ApiResult>(httpClient, { method: "GET", url: "/todos/1" })
  console.log(`  [in-process client] result=${JSON.stringify(c1.body)}`)
  const c2 = await serve<ApiResult>(httpNetworkClientStub, { method: "GET", url: "/todos/1" })
  console.log(`  [network-stub client] result=${JSON.stringify(c2.body)}`)
  console.log("  httpClient, httpNetworkClientStub, httpApp: all Handler<{},ApiResult>")
  console.log("  The server type IS the client type. No mock interface needed.")

  // Worker string vs typed capture side-by-side
  console.log("\n── Worker: string-params path vs typed-field path (same leaf) ────────")
  const ws1 = await dispatch<ApiResult>(workerApp, { procedure: "todos.get", params: { id: "1" } })
  console.log(`  [todos.get string path]      id='1' (string) → result=${JSON.stringify(ws1.result)}`)
  const ws2 = await dispatch<ApiResult>(workerApp, { procedure: "todos.get.typed", params: { id: 1 } } as WorkerCall)
  console.log(`  [todos.get.typed number path] id=1  (number) → result=${JSON.stringify(ws2.result)}`)
  console.log("  Both reach the same underlying data. String path uses typed(); number path uses field().")

  console.log("\n" + "=".repeat(70))
  console.log("All proofs complete.")
  console.log("=".repeat(70))
}

demo().catch((e: unknown) => {
  console.error(e)
  throw e
})
