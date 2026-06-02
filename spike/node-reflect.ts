// spike/node-reflect.ts
//
// TYPE SPIKE: FNode<P,Res> = { meta, handler } wrapper
// (Named FNode to avoid clash with lib.dom's Node interface)
//
// Tests whether wrapping the composition unit as { meta, handler } (a) preserves
// the verified param-discharge type machinery and (b) makes the route structure
// reflectable via the meta tree.
//
// Standalone — does NOT import the packages.
//
// Make this a module so top-level await is valid and lib.dom does not
// bleed its 'Node' identifier into this file's scope.
export {}

// ============================================================================
// Sentinel
// ============================================================================

const PASS = Symbol("fractal.Pass")
type Pass = typeof PASS
const pass: Pass = PASS

// ============================================================================
// Core request type (HTTP-flavored for this spike)
// ============================================================================

type Req<P extends Record<string, unknown> = Record<string, never>> = {
  path: string[]
  method: string
  query: Record<string, string>
  params: P
  body?: () => Promise<unknown>
}

// ============================================================================
// Handler — same as before
// ============================================================================

type Handler<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
> = (req: Req<P>) => Promise<Res | Pass>

// ============================================================================
// Meta — the reflection descriptor
// ============================================================================

type LeafMeta    = { kind: "leaf" }
type ChoiceMeta  = { kind: "choice"; children: Meta[] }
type PathMeta    = { kind: "path"; children: Record<string, Meta> }
type MethodsMeta = { kind: "methods"; verbs: Record<string, Meta> }
type ParamMeta   = { kind: "param"; name: string; child: Meta }
type TypedMeta   = { kind: "typed"; schema: unknown; child: Meta }
type AuthMeta    = { kind: "auth"; security: string; child: Meta }

type Meta =
  | LeafMeta
  | ChoiceMeta
  | PathMeta
  | MethodsMeta
  | ParamMeta
  | TypedMeta
  | AuthMeta

// ============================================================================
// FNode<P,Res> — THE composition unit (the shape under test)
//
// NOTE: 'Node' is reserved by lib.dom — use FNode throughout.
// ============================================================================

type FNode<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
> = {
  meta: Meta
  handler: Handler<P, Res>
}

// ============================================================================
// Combinators
// ============================================================================

function mapValues<T, U>(
  obj: Record<string, T>,
  fn: (v: T) => U,
): Record<string, U> {
  const out: Record<string, U> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = fn(v)
  }
  return out
}

// -----------------------------------------------------------------------
// leaf
// -----------------------------------------------------------------------

function leaf<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(fn: (req: Req<P>) => Promise<Res>): FNode<P, Res> {
  return { meta: { kind: "leaf" }, handler: fn }
}

// -----------------------------------------------------------------------
// choice
// -----------------------------------------------------------------------

function choice<P extends Record<string, unknown>, Res>(
  ...ns: FNode<P, Res>[]
): FNode<P, Res> {
  return {
    meta: { kind: "choice", children: ns.map((n) => n.meta) },
    handler: async (req) => {
      for (const n of ns) {
        const res = await n.handler(req)
        if (res !== pass) return res
      }
      return pass
    },
  }
}

// -----------------------------------------------------------------------
// path
// -----------------------------------------------------------------------

function path<P extends Record<string, unknown>, Res>(
  table: Record<string, FNode<P, Res>>,
): FNode<P, Res> {
  return {
    meta: { kind: "path", children: mapValues(table, (n) => n.meta) },
    handler: async (req) => {
      const [seg, ...rest] = req.path
      if (seg === undefined) return pass
      const n = table[seg]
      if (n === undefined) return pass
      return n.handler({ ...req, path: rest })
    },
  }
}

// -----------------------------------------------------------------------
// methods: verb dispatch with path-exhaustion guard
// -----------------------------------------------------------------------

function methods<P extends Record<string, unknown>, Res>(
  table: Record<string, FNode<P, Res>>,
): FNode<P, Res> {
  return {
    meta: { kind: "methods", verbs: mapValues(table, (n) => n.meta) },
    handler: async (req) => {
      if (req.path.length > 0) return pass
      const n = table[req.method]
      if (n === undefined) return pass
      return n.handler(req)
    },
  }
}

// -----------------------------------------------------------------------
// param — CRITICAL: discharge must survive the FNode wrapper
// -----------------------------------------------------------------------

function param<
  K extends string,
  C extends Record<K, string>,
  Res,
>(name: K, child: FNode<C, Res>): FNode<Omit<C, K>, Res> {
  return {
    meta: { kind: "param", name, child: child.meta },
    handler: async (req: Req<Omit<C, K>>) => {
      const [seg, ...rest] = req.path
      if (seg === undefined) return pass
      const enriched = {
        ...req,
        path: rest,
        params: { ...(req.params as object), [name]: seg } as unknown as C,
      } as Req<C>
      return child.handler(enriched)
    },
  }
}

// -----------------------------------------------------------------------
// typed: sync combinator
// -----------------------------------------------------------------------

function typed<
  Out extends Record<string, unknown>,
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(
  parse: (raw: Record<string, unknown>) => Out,
  inner: FNode<P & Out, Res>,
): FNode<P, Res> {
  return {
    meta: { kind: "typed", schema: { parsed: true }, child: inner.meta },
    handler: async (req: Req<P>) => {
      const parsed = parse(req.params as Record<string, unknown>)
      const enriched: Req<P & Out> = {
        ...req,
        params: { ...(req.params as object), ...parsed } as P & Out,
      }
      return inner.handler(enriched)
    },
  }
}

// -----------------------------------------------------------------------
// auth: bonus middleware-as-FNode
// -----------------------------------------------------------------------

function auth<P extends Record<string, unknown>, Res>(
  security: string,
  child: FNode<P, Res>,
): FNode<P, Res> {
  return {
    meta: { kind: "auth", security, child: child.meta },
    handler: async (req) => child.handler(req),
  }
}

// -----------------------------------------------------------------------
// run: only accepts a fully-discharged FNode (P = {})
//
// KEY QUESTION: does wrapping in {meta,handler} preserve the discharge
// guard, or does TypeScript's structural subtyping let undischarged nodes
// slip through?
// -----------------------------------------------------------------------

async function run<Res>(
  n: FNode<Record<string, never>, Res>,
  req: Req<Record<string, never>>,
): Promise<Res | null> {
  const res = await n.handler(req)
  if (res === pass) return null
  return res as Res
}

// ============================================================================
// ASSERTIONS A–I
// ============================================================================

console.log("=== Assertions A–I ===\n")

// -----------------------------------------------------------------------
// A. param flow → FNode<{}>, run compiles
// -----------------------------------------------------------------------

const leafA = leaf<{ id: string }, string>(async (req) => req.params.id)
const nodeA = param("id", leafA)         // FNode<{}, string>
void run(nodeA, { path: [], method: "GET", query: {}, params: {} })
console.log("A: param→FNode<{}> compiles, run accepts ✓")

// -----------------------------------------------------------------------
// B. typed refinement: string→number via typed()
// -----------------------------------------------------------------------

const leafB = leaf<{ id: number }, string>(async (req) => String(req.params.id))
// typed<Out={id:number}, P={}, Res=string>: inner must be FNode<{}&{id:number}> = FNode<{id:number}>
const typedB = typed<{ id: number }, {}, string>(
  (raw): { id: number } => ({ id: Number(raw["id"]) }),
  leafB,
)  // FNode<{}, string>
const nodeB = param("id", typedB)
void run(nodeB, { path: [], method: "GET", query: {}, params: {} })
console.log("B: typed number-refinement through FNode compiles ✓")

// -----------------------------------------------------------------------
// C. deep nesting: path(choice(methods, param(methods))) → FNode<{}>
// -----------------------------------------------------------------------

const getLeaf    = leaf<{}, string>(async () => "list")
const getMethods = methods({ GET: getLeaf })
const idLeaf     = leaf<{ id: string }, string>(async (req) => req.params.id)
const paramId    = param("id", methods({ GET: idLeaf }))

const nodeC = path({ todos: choice(paramId, getMethods) })
void run(nodeC, { path: [], method: "GET", query: {}, params: {} })
console.log("C: path(choice(methods, param(methods))) → FNode<{}> compiles ✓")

// -----------------------------------------------------------------------
// D. DISCHARGE GUARD: run(FNode<{id:number}>) — does the wrapper preserve
//    the guard that requires P={}?
//
//    EXPECTED: @ts-expect-error is consumed (error fires).
//    FINDING: if tsgo reports "Unused '@ts-expect-error'", the guard is
//    BROKEN — TypeScript's structural subtyping lets the undischarged
//    FNode slip through because FNode is NOT a function type.
//
//    The bare-function model (Handler<P,Res> = (req:Req<P>)=>...) is
//    CONTRAVARIANT in P — run(h: Handler<{},Res>) rejects Handler<{id:number}>
//    because a function wanting {id:number} is NOT a function wanting {}.
//    The object wrapper {meta,handler} makes the wrapper COVARIANT in
//    the structural sense that TypeScript checks: FNode<{id:number}> has
//    handler: Handler<{id:number}>, which IS assignable to
//    handler: Handler<{}> via function-argument covariance in the object
//    property position... actually this should still be contravariant.
//
//    Run tsgo and observe the actual verdict. Document outcome honestly.
// -----------------------------------------------------------------------

const leafD = leaf<{ id: number }, string>(async (req) => String(req.params.id))
// leafD is FNode<{id:number}, string>; run requires FNode<{}>
// @ts-expect-error [D: FNode<{id:number}> not assignable to FNode<{}>]
void run(leafD, { path: [], method: "GET", query: {}, params: {} })
console.log("D: @ts-expect-error on undischarged FNode — see tsgo output for verdict")

// -----------------------------------------------------------------------
// E. partial discharge
// -----------------------------------------------------------------------

const leafE = leaf<{ tenantId: string; id: string }, string>(
  async (req) => `${req.params.tenantId}/${req.params.id}`,
)
const partialE = param("id", leafE)   // FNode<{tenantId:string}, string>

// @ts-expect-error [E: FNode<{tenantId:string}> not fully discharged]
void run(partialE, { path: [], method: "GET", query: {}, params: {} })

const fullE = param("tenantId", partialE)
void run(fullE, { path: [], method: "GET", query: {}, params: {} })
console.log("E: partial→full discharge — see tsgo output for @ts-expect-error verdict")

// -----------------------------------------------------------------------
// F. choice siblings union-of-needs
// -----------------------------------------------------------------------

const leafFa = leaf<{ a: string }, string>(async (req) => req.params.a)
const leafFb = leaf<{ b: string }, string>(async (req) => req.params.b)

const nodeF = choice<{ a: string } & { b: string }, string>(leafFa, leafFb)
// @ts-expect-error [F: FNode<{a,b}> not discharged]
void run(nodeF, { path: [], method: "GET", query: {}, params: {} })
const dischFa = param("a", param("b", nodeF))
void run(dischFa, { path: [], method: "GET", query: {}, params: {} })
console.log("F: choice union-of-needs — see tsgo output for @ts-expect-error verdict")

// -----------------------------------------------------------------------
// G1. number-child capture compile error
// -----------------------------------------------------------------------

const leafG1 = leaf<{ x: number }, string>(async (req) => String(req.params.x))
// param requires C extends Record<K,string>; {x:number} does not satisfy it:
// @ts-expect-error [G1: {x:number} does not satisfy C extends Record<'x',string>]
const _g1Probe = param("x", leafG1)
console.log("G1: @ts-expect-error on number-child param — see tsgo output for verdict")

// -----------------------------------------------------------------------
// H. unused-capture verdict
//    param('id', leaf<{}>) compiles silently — known caveat.
// -----------------------------------------------------------------------

const leafH = leaf<{}, string>(async () => "nothing")
const _unusedCapture = param("id", leafH)
console.log("H: unused-capture (param on leaf<{}>) compiles silently — known caveat")

// -----------------------------------------------------------------------
// I. typed + param chain end-to-end
// -----------------------------------------------------------------------

const typedI3 = typed<{ idNum: number }, { id: string }, string>(
  (raw) => ({ idNum: Number(raw["id"]) }),
  leaf<{ id: string; idNum: number }, string>(
    async (req) => `${req.params.id}:${req.params.idNum}`,
  ),
)  // FNode<{id:string}, string>

const nodeI = param("id", typedI3)  // FNode<{}, string>
void run(nodeI, { path: [], method: "GET", query: {}, params: {} })
console.log("I: typed+param chain end-to-end compiles ✓")

// ============================================================================
// REFLECTION: walk(meta) → OpenAPI-ish fragment
// ============================================================================

console.log("\n=== Reflection proof ===\n")

type OpenApiParam = { name: string; in: "path" | "query"; schema: { type: string } }
type OpenApiOperation = {
  parameters: OpenApiParam[]
  requestBody?: { content: { "application/json": { schema: unknown } } }
  security?: { scheme: string }[]
}
type OpenApiPaths = Record<string, Record<string, OpenApiOperation>>

function walk(
  meta: Meta,
  ctx: {
    prefix: string
    method?: string
    params: OpenApiParam[]
    security?: { scheme: string }[]
  } = { prefix: "", params: [] },
): OpenApiPaths {
  switch (meta.kind) {
    case "leaf": {
      if (!ctx.method) return {}
      const key = ctx.prefix || "/"
      const op: OpenApiOperation = { parameters: [...ctx.params] }
      if (ctx.security) op.security = ctx.security
      return { [key]: { [ctx.method]: op } }
    }

    case "choice": {
      const merged: OpenApiPaths = {}
      for (const child of meta.children) {
        const sub = walk(child, ctx)
        for (const [p, verbs] of Object.entries(sub)) {
          merged[p] = { ...(merged[p] ?? {}), ...verbs }
        }
      }
      return merged
    }

    case "path": {
      const merged: OpenApiPaths = {}
      for (const [seg, child] of Object.entries(meta.children)) {
        const sub = walk(child, { ...ctx, prefix: `${ctx.prefix}/${seg}` })
        for (const [p, verbs] of Object.entries(sub)) {
          merged[p] = { ...(merged[p] ?? {}), ...verbs }
        }
      }
      return merged
    }

    case "methods": {
      const merged: OpenApiPaths = {}
      for (const [verb, child] of Object.entries(meta.verbs)) {
        const sub = walk(child, { ...ctx, method: verb.toLowerCase() })
        for (const [p, verbs] of Object.entries(sub)) {
          merged[p] = { ...(merged[p] ?? {}), ...verbs }
        }
      }
      return merged
    }

    case "param": {
      const newParam: OpenApiParam = {
        name: meta.name,
        in: "path",
        schema: { type: "string" },
      }
      return walk(meta.child, {
        ...ctx,
        prefix: `${ctx.prefix}/{${meta.name}}`,
        params: [...ctx.params, newParam],
      })
    }

    case "typed": {
      const sub = walk(meta.child, ctx)
      for (const verbs of Object.values(sub)) {
        for (const op of Object.values(verbs)) {
          op.requestBody = {
            content: { "application/json": { schema: meta.schema } },
          }
        }
      }
      return sub
    }

    case "auth": {
      return walk(meta.child, {
        ...ctx,
        security: [...(ctx.security ?? []), { scheme: meta.security }],
      })
    }
  }
}

// -----------------------------------------------------------------------
// Build a representative todos API tree:
//   GET  /todos
//   GET  /todos/{id}
//   POST /todos  (typed body, auth-wrapped)
// -----------------------------------------------------------------------

type Todo = { id: string; title: string }

const listTodosLeaf  = leaf<{}, Todo[]>(async () => [{ id: "1", title: "Buy milk" }])
const getTodoLeaf    = leaf<{ id: string }, Todo>(
  async (req) => ({ id: req.params.id, title: "Example" }),
)
// typed<Out={title:string}, P={}, Res=Todo>: inner must be FNode<{title:string}, Todo>
const createTodoNode: FNode<{}, Todo> = typed<{ title: string }, {}, Todo>(
  (raw): { title: string } => ({ title: String(raw["title"] ?? "") }),
  leaf<{ title: string }, Todo>(
    async (req) => ({ id: "new", title: req.params.title }),
  ),
)

const authCreateTodo: FNode<{}, Todo> = auth("bearer", createTodoNode)

// The three branches have different Res types (Todo[] | Todo); annotate explicitly.
const listNode:    FNode<{}, Todo[] | Todo> = listTodosLeaf as FNode<{}, Todo[] | Todo>
const createNode:  FNode<{}, Todo[] | Todo> = authCreateTodo as FNode<{}, Todo[] | Todo>
const getByIdNode: FNode<{}, Todo[] | Todo> = param(
  "id",
  methods<{ id: string }, Todo>({ GET: getTodoLeaf }),
) as FNode<{}, Todo[] | Todo>

const todosMethods: FNode<{}, Todo[] | Todo> = choice(
  methods<{}, Todo[] | Todo>({ GET: listNode, POST: createNode }),
  getByIdNode,
)

const root: FNode<{}, Todo[] | Todo> = path({ todos: todosMethods })

// -----------------------------------------------------------------------
// Runtime: run requests through the tree
// -----------------------------------------------------------------------

const makeReq = (
  method: string,
  pathStr: string,
): Req<Record<string, never>> => ({
  method,
  path: pathStr.replace(/^\//, "").split("/").filter(Boolean),
  query: {},
  params: {},
})

const r1 = await run(root, makeReq("GET",    "/todos"))
const r2 = await run(root, makeReq("GET",    "/todos/42"))
const r3 = await run(root, makeReq("POST",   "/todos"))
const r4 = await run(root, makeReq("DELETE", "/todos"))

console.log("GET  /todos       →", JSON.stringify(r1))
console.log("GET  /todos/42    →", JSON.stringify(r2))
console.log("POST /todos       →", JSON.stringify(r3))
console.log("DELETE /todos     →", JSON.stringify(r4), "(null = no match)")

// -----------------------------------------------------------------------
// Walk the meta tree → OpenAPI-ish fragment
// -----------------------------------------------------------------------

const openApiFragment = walk(root.meta)

const expectedFragment: OpenApiPaths = {
  "/todos": {
    get:  { parameters: [] },
    post: {
      parameters: [],
      requestBody: {
        content: { "application/json": { schema: { parsed: true } } },
      },
      security: [{ scheme: "bearer" }],
    },
  },
  "/todos/{id}": {
    get: {
      parameters: [{ name: "id", in: "path", schema: { type: "string" } }],
    },
  },
}

console.log("\nwalk(root.meta) =", JSON.stringify(openApiFragment, null, 2))
console.log("\nExpected =", JSON.stringify(expectedFragment, null, 2))

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object") return false
  if (a === null || b === null) return false
  const aKeys = Object.keys(a as object).sort()
  const bKeys = Object.keys(b as object).sort()
  if (aKeys.join(",") !== bKeys.join(",")) return false
  for (const k of aKeys) {
    if (
      !deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    )
      return false
  }
  return true
}

const reflectionMatch = deepEqual(openApiFragment, expectedFragment)
console.log("\nReflection deep-equal:", reflectionMatch ? "PASS ✓" : "FAIL ✗")

if (!reflectionMatch) {
  throw new Error("REFLECTION MISMATCH — see diff above")
}

console.log("\n=== DONE ===")
