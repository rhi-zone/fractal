// spike/typed-client.ts
//
// TYPED CLIENT SPIKE — derived from a fractal Node route tree (in-process Hyper unification)
//
// Goal: from a Node tree (the same value that serves), derive a nested, fully-typed
// client whose calls mirror the routes.
//
// KEY FINDING (type-precision precondition):
//   The packages' path() and methods() combinators are typed as:
//     path<P, Res>(table: Record<string, Node<P, Res>>): Node<P, Res>
//     methods<P, Res>(table: Record<string, Node<P, Res>>): Node<P, Res>
//   ...and Node.meta is typed as `Meta` (the wide union).
//
//   LITERAL CHILD KEYS and CHILD TYPES are NOT preserved at the type level.
//   The route structure is OPAQUE to the type system — a typed client CANNOT be
//   derived from the packages' Node type as currently written.
//
//   This spike PROTOTYPES tightened combinator signatures:
//     TNode<P, Res, M extends TMeta> — carries meta as a third type param.
//     path/methods infer the literal table type T and store it in TPathMeta<T>/TMethodsMeta<T>.
//     param carries its child meta M → TParamMeta<K, M>.
//     body carries body type T → TBodyMeta<T, _>.
//
// PATH-PARAM SURFACING (chosen shape):
//   path  segments → object properties:      client.todos
//   param → callable segment:                client.todosById("42") → sub-client
//   methods verbs → uppercase method props:  client.todos.GET() / .POST({...})
//   body → verb call takes typed body arg:   client.todos.POST({title:"x"})
//   leaf → () => Promise<Res>
//
//   Uppercase verbs (GET/POST) rather than lowercase (get/post): mirrors the
//   fractal methods() convention where verb keys are uppercase strings.
//
// RUNTIME: HYPER UNIFICATION
//   At the leaf call, the client assembles a Req and invokes node.handler IN-PROCESS.
//   No network. Server and client are one value.
//
// CHOICE() LIMITATION: choice() collapses branches — literal keys are lost.
//   Typed client is incompatible with choice(). See DESIGN NOTE at end.

export {}

// ============================================================================
// Sentinel
// ============================================================================

const PASS = Symbol("fractal.Pass")
type Pass = typeof PASS
const pass: Pass = PASS

// ============================================================================
// Core request type (HTTP-flavored)
// ============================================================================

type Req<P extends Record<string, unknown> = Record<string, never>> = {
  path: string[]
  method: string
  query: Record<string, string>
  headers: Record<string, string>
  params: P
  body?: () => Promise<unknown>
}

type Handler<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
> = (req: Req<P>) => Promise<Res | Pass>

// ============================================================================
// TMeta — TIGHTENED meta types that preserve literal structure
//
// The key change vs. the packages: PathMeta and MethodsMeta carry the LITERAL
// table type as a type parameter, not just Record<string, Meta>.
// ============================================================================

type TLeafMeta<Res = unknown> = {
  kind: "leaf"
  _res: Res
}

type TParamMeta<Name extends string, Child extends TMeta> = {
  kind: "param"
  name: Name
  child: Child
  // childNode: carries the actual child TNode for runtime makeClient traversal.
  // Typed loosely (TNodeShape) since the runtime only needs to call makeClient on it.
  childNode: TNodeShape
}

type TBodyMeta<T, Child extends TMeta> = {
  kind: "body"
  _bodyType: T
  child: Child
}

// TNodeShape: the shape we use in table constraints.
// Intentionally loose on P and Res — the client only needs M (the meta shape).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TNodeShape = TNode<any, any, TMeta>

type TPathMeta<Children extends Record<string, TNodeShape>> = {
  kind: "path"
  children: Children
}

type TMethodsMeta<Verbs extends Record<string, TNodeShape>> = {
  kind: "methods"
  verbs: Verbs
}

type TMeta =
  | TLeafMeta<any>
  | TParamMeta<any, any>
  | TBodyMeta<any, any>
  | TPathMeta<any>
  | TMethodsMeta<any>
  | { kind: string }

// ============================================================================
// TNode<P, Res, M>
// ============================================================================

type TNode<
  P extends Record<string, unknown>,
  Res,
  M extends TMeta = TMeta,
> = {
  meta: M
  handler: Handler<P, Res>
}

// ============================================================================
// Tightened combinators
// ============================================================================

function leaf<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(fn: (req: Req<P>) => Promise<Res>): TNode<P, Res, TLeafMeta<Res>> {
  return { meta: { kind: "leaf", _res: undefined as unknown as Res }, handler: fn }
}

function param<
  K extends string,
  C extends Record<K, string>,
  Res,
  M extends TMeta,
>(name: K, child: TNode<C, Res, M>): TNode<Omit<C, K>, Res, TParamMeta<K, M>> {
  return {
    meta: { kind: "param", name, child: child.meta, childNode: child },
    handler: async (req) => {
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

// path: T captures literal segment keys; P is fixed to {} (fully discharged by children)
function path<
  T extends Record<string, TNodeShape>,
>(table: T): TNode<Record<string, never>, unknown, TPathMeta<T>> {
  return {
    meta: { kind: "path", children: table },
    handler: async (req) => {
      const [seg, ...rest] = req.path
      if (seg === undefined) return pass
      const n = table[seg] as TNodeShape | undefined
      if (n === undefined) return pass
      return n.handler({ ...req, path: rest } as Req<any>)
    },
  }
}

// methods: T captures literal verb keys.
// We allow heterogeneous P/Res across table values (the client only needs meta).
// The returned TNode's P/Res are typed as any since the client invokes handlers
// through the tree's root handler (the outer node wraps dispatch).
function methods<
  T extends Record<string, TNodeShape>,
>(table: T): TNode<any, any, TMethodsMeta<T>> {
  return {
    meta: { kind: "methods", verbs: table },
    handler: async (req: Req<any>) => {
      if (req.path.length > 0) return pass
      const n = table[req.method] as TNodeShape | undefined
      if (n === undefined) return pass
      return n.handler(req)
    },
  }
}

// body: carries body type T in meta for client derivation
function body<
  T,
  P extends Record<string, unknown>,
  Res,
>(
  parse: (raw: unknown) => T | Promise<T>,
  inner: (req: Req<P> & { body: T }) => Promise<Res | Pass>,
): TNode<P, Res, TBodyMeta<T, TLeafMeta<Res>>> {
  return {
    meta: {
      kind: "body",
      _bodyType: undefined as unknown as T,
      child: { kind: "leaf", _res: undefined as unknown as Res },
    },
    handler: async (req) => {
      const rawBody: unknown = req.body !== undefined ? await req.body() : undefined
      // parse can return T or Promise<T>; normalise:
      const parseResult = parse(rawBody)
      const parsed: T = (parseResult instanceof Promise ? await parseResult : parseResult) as T
      // Build enriched req without the body thunk field, then add typed body.
      // Cast required: spread of `rest` (which has `body?: thunk`) overridden with
      // `body: parsed` (type T) produces an intersection TypeScript can't simplify.
      const enriched = { ...req, body: parsed } as unknown as Req<P> & { body: T }
      return inner(enriched)
    },
  }
}

// ============================================================================
// CLIENT TYPE DERIVATION
//
// DESIGN CHALLENGE: recursive conditional types over generic TMeta.
//
// The critical insight: `noUncheckedIndexedAccess` is enabled in tsconfig.
// With it, `Verbs[K]` in `{ [K in keyof Verbs]: ... }` does NOT add undefined
// when K is constrained to `keyof Verbs` (not a plain string index). HOWEVER,
// if `Verbs` extends `Record<string, TNodeShape>` (an open string index), TypeScript
// may still add `| undefined` to the indexed access in conditional types.
//
// SOLUTION: Use a NARROWED mapped type approach where we constrain `Verbs` as
// a concrete object type (not an open record) by using `keyof Verbs` to iterate.
// The `[K in keyof Verbs]: ...` form is a homomorphic mapped type — it does NOT
// add undefined for literal keys when the source type is a finite interface/type.
//
// We also face the deferred-evaluation issue: if M remains abstract (e.g. TMeta),
// TypeScript cannot evaluate `ClientOfMeta<M>` at definition sites. The key is
// that `makeClient` must be called on a CONCRETE TNode with a specific M so the
// conditional resolves at the call site.
// ============================================================================

// ClientOfVerbNode: () => Promise<Res> for plain verbs, (body: T) => Promise<Res> for body verbs
type ClientOfVerbNode<N> =
  N extends TNode<any, infer Res, TBodyMeta<infer T, any>>
    ? (body: T) => Promise<Res>
    : N extends TNode<any, infer Res, any>
      ? () => Promise<Res>
      : never

// MethodsClient<Verbs>: maps verb keys to their call signatures.
// Using `& string` to avoid noUncheckedIndexedAccess adding | undefined.
// The homomorphic mapped type `{ [K in keyof Verbs & string]: ... }` iterates
// over literal keys and does NOT add | undefined when the type is concrete.
type MethodsClient<Verbs extends Record<string, TNodeShape>> = {
  [K in keyof Verbs & string]: ClientOfVerbNode<Verbs[K]>
}

// PathClient<Children>: maps path segment keys to their client types.
type PathClient<Children extends Record<string, TNodeShape>> = {
  [K in keyof Children & string]: ClientOf<Children[K]>
}

// ClientOfMeta<M>: recursive derivation of the client surface
type ClientOfMeta<M extends TMeta> =
  // Leaf: no-arg call
  M extends TLeafMeta<infer Res>
    ? () => Promise<Res>
  // Body: (body: T) => Promise<Res>
  : M extends TBodyMeta<infer T, TLeafMeta<infer Res>>
    ? (body: T) => Promise<Res>
  // Methods: { [verb]: ClientOfVerbNode }
  : M extends TMethodsMeta<infer Verbs>
    ? MethodsClient<Verbs>
  // Path: { [seg]: ClientOf<child> }
  : M extends TPathMeta<infer Children>
    ? PathClient<Children>
  // Param: (value: string) => ClientOfMeta<child meta>
  : M extends TParamMeta<infer _Name, infer Child>
    ? Child extends TMeta
      ? (value: string) => ClientOfMeta<Child>
      : never
  : never

type ClientOf<N> = N extends TNode<any, any, infer M> ? ClientOfMeta<M> : never

// ============================================================================
// RUNTIME: makeClient
// ============================================================================

function makeClient<M extends TMeta>(
  node: TNode<any, any, M>,
  ctx: { path: string[]; params: Record<string, string> } = { path: [], params: {} },
): ClientOfMeta<M> {
  const meta = node.meta

  if (meta.kind === "leaf") {
    return (async () => {
      const req: Req<any> = { path: [], method: "GET", query: {}, headers: {}, params: ctx.params }
      const res = await node.handler(req)
      if (res === pass) throw new Error(`[typed-client] no match at leaf`)
      return res
    }) as ClientOfMeta<M>
  }

  if (meta.kind === "body") {
    return ((bodyArg: unknown) => {
      const req: Req<any> = {
        path: [],
        method: "POST",
        query: {},
        headers: {},
        params: ctx.params,
        body: () => Promise.resolve(bodyArg),
      }
      return node.handler(req).then((res) => {
        if (res === pass) throw new Error(`[typed-client] no match at body node`)
        return res
      })
    }) as ClientOfMeta<M>
  }

  if (meta.kind === "methods") {
    const verbsMeta = (meta as TMethodsMeta<Record<string, TNodeShape>>).verbs
    const obj: Record<string, unknown> = {}
    for (const [verb, child] of Object.entries(verbsMeta)) {
      const childMeta = child.meta
      if (childMeta.kind === "body") {
        obj[verb] = (bodyArg: unknown) => {
          const req: Req<any> = {
            path: [],
            method: verb,
            query: {},
            headers: {},
            params: ctx.params,
            body: () => Promise.resolve(bodyArg),
          }
          return node.handler(req).then((res) => {
            if (res === pass) throw new Error(`[typed-client] 404 ${verb}`)
            return res
          })
        }
      } else {
        obj[verb] = () => {
          // path: [] — methods handler requires fully-consumed path (path.length === 0)
          const req: Req<any> = {
            path: [],
            method: verb,
            query: {},
            headers: {},
            params: ctx.params,
          }
          return node.handler(req).then((res) => {
            if (res === pass) throw new Error(`[typed-client] 404 ${verb}`)
            return res
          })
        }
      }
    }
    return obj as ClientOfMeta<M>
  }

  if (meta.kind === "path") {
    const children = (meta as TPathMeta<Record<string, TNodeShape>>).children
    const obj: Record<string, unknown> = {}
    for (const [seg, child] of Object.entries(children)) {
      obj[seg] = makeClient(child, { path: [...ctx.path, seg], params: ctx.params })
    }
    return obj as ClientOfMeta<M>
  }

  if (meta.kind === "param") {
    const paramMeta = meta as TParamMeta<string, TMeta>
    // Use paramMeta.childNode (the actual child TNode with its handler), not a
    // reconstructed fake node that would carry the param handler instead of the child's.
    const childNode = paramMeta.childNode
    return ((value: string) => {
      return makeClient(childNode, {
        path: [...ctx.path, value],
        params: { ...ctx.params, [paramMeta.name]: value },
      })
    }) as ClientOfMeta<M>
  }

  throw new Error(`[typed-client] unknown meta kind: ${(meta as { kind: string }).kind}`)
}

// ============================================================================
// EXAMPLE TREE — mirrors examples/todo-api/src/app.ts (without choice())
//
// Structure:
//   /todos         GET  → list all todos
//                  POST → create todo (body: CreateInput)
//   /todosById/:id GET  → get todo by id
// ============================================================================

interface Todo {
  id: number
  title: string
  done: boolean
}
type CreateInput = { title: string }

let nextId = 1
const store: Todo[] = [
  { id: nextId++, title: 'fractal todo example', done: false },
]

// Leaves

const listAllLeaf = leaf<Record<string, never>, Todo[]>(
  async (_req) => [...store],
)

const getByIdLeaf = leaf<{ id: string }, Todo | null>(
  async (req) => store.find((t) => t.id === Number(req.params.id)) ?? null,
)

function parseCreate(raw: unknown): CreateInput {
  if (
    typeof raw === 'object' && raw !== null &&
    typeof (raw as Record<string, unknown>)['title'] === 'string'
  ) {
    return { title: (raw as Record<string, unknown>)['title'] as string }
  }
  throw new Error(`expected {title:string}, got ${JSON.stringify(raw)}`)
}

const createTodoNode = body<CreateInput, Record<string, never>, Todo>(
  parseCreate,
  async (req) => {
    const todo: Todo = { id: nextId++, title: req.body.title, done: false }
    store.push(todo)
    return todo
  },
)

// Routing tree (no choice(), literal keys preserved)

const idSubtree = param('id',
  methods({ GET: getByIdLeaf }),
)

const todosNode = methods({
  GET: listAllLeaf,
  POST: createTodoNode,
})

const appTree = path({
  todos: todosNode,
  todosById: idSubtree,
})

// ============================================================================
// TYPE PROBE: infer the full client surface
//
// type _ should expand to:
// {
//   todos: {
//     GET: () => Promise<Todo[]>
//     POST: (body: CreateInput) => Promise<Todo>
//   }
//   todosById: (value: string) => {
//     GET: () => Promise<Todo | null>
//   }
// }
// ============================================================================

type AppTree = typeof appTree
type AppClient = ClientOf<AppTree>
type _ = AppClient

// ============================================================================
// BUILD THE CLIENT
// ============================================================================

const client = makeClient(appTree)

// ASSERTION: client has type AppClient
const _clientTypeCheck: AppClient = client

// ── POSITIVE ASSERTIONS ───────────────────────────────────────────────────────

// client.todos.GET() → Promise<Todo[]>
const todosResult: Promise<Todo[]> = client.todos.GET()

// client.todosById("1").GET() → Promise<Todo | null>
const todoByIdResult: Promise<Todo | null> = client.todosById("1").GET()

// client.todos.POST({title: "new todo"}) → Promise<Todo>
const createResult: Promise<Todo> = client.todos.POST({ title: "new todo" })

// ── NEGATIVE ASSERTIONS (each @ts-expect-error should be consumed) ─────────────
//
// These are COMPILE-TIME assertions only. The expressions are wrapped in
// `false && (...)` so they are never executed at runtime.

// NEG-1: Wrong body type to POST: number is not CreateInput
// @ts-expect-error [NEG-1: number is not assignable to CreateInput]
const _neg1: Promise<Todo> = false && client.todos.POST(42)

// NEG-2: Wrong path-param type: number is not string
// @ts-expect-error [NEG-2: number is not assignable to string]
const _neg2 = false && client.todosById(42)

// NEG-3: Calling a verb that doesn't exist on todos (DELETE not in table)
// @ts-expect-error [NEG-3: DELETE does not exist on todos methods]
const _neg3 = false && client.todos.DELETE()

// NEG-4: Calling a path segment that doesn't exist
// @ts-expect-error [NEG-4: nonexistent does not exist on appTree path]
const _neg4 = false && client.nonexistent

// ============================================================================
// RUNTIME EXECUTION
// ============================================================================

console.log("=== typed-client spike — in-process Hyper unification ===\n")

const r1 = await todosResult
console.log("client.todos.GET()                   →", JSON.stringify(r1))

const r2 = await todoByIdResult
console.log("client.todosById('1').GET()           →", JSON.stringify(r2))

const r3 = await createResult
console.log("client.todos.POST({title:'new todo'}) →", JSON.stringify(r3))

const r4 = await client.todos.GET()
console.log("client.todos.GET() after POST         →", JSON.stringify(r4))

const r5 = await client.todosById("9999").GET()
console.log("client.todosById('9999').GET()        →", r5, "(null expected)")

console.log("\n=== @ts-expect-error negatives ===")
console.log("NEG-1 .POST(42)        wrong body type  — @ts-expect-error consumed")
console.log("NEG-2 .todosById(42)   wrong param type — @ts-expect-error consumed")
console.log("NEG-3 .todos.DELETE()  nonexistent verb — @ts-expect-error consumed")
console.log("NEG-4 .nonexistent     nonexistent path — @ts-expect-error consumed")

// ============================================================================
// DESIGN NOTE: choice() and typed client
//
// The example app uses choice() to merge route branches:
//   choice(
//     query('limit', methods({ GET: listWithLimit })),
//     methods({ GET: listAll, POST: createHandler }),
//     param('id', methods({ GET: getById })),
//   )
//
// Even with tightened types, choice()'s type would be:
//   choice<P, Res, Branches extends TMeta[]>(...ns): TNode<P, Res, TChoiceMeta<Branches>>
//
// The client derivation from TChoiceMeta<[M1, M2, M3]> would need to produce
// the INTERSECTION of all branch surfaces — technically:
//   ClientOfChoice<[M1, M2, M3]> = ClientOfMeta<M1> & ClientOfMeta<M2> & ClientOfMeta<M3>
//
// This breaks down because:
//   1. Multiple branches can handle the same verb (GET /todos with/without ?limit),
//      producing conflicting call signatures in the intersection.
//   2. TypeScript does not easily simplify intersections of conditional types.
//
// CONCLUSION: A typed client requires the tree to express routes without choice().
// The route tree must use path/methods/param only. The example app would need
// refactoring. This is a structural constraint, not a limitation of this spike.
//
// PACKAGES CHANGES NEEDED (summary):
//   1. Node gains M: Node<P, Res, M extends Meta = Meta> = { meta: M; handler: ... }
//   2. path<T extends Record<string, TNode>>(table: T): TNode<{}, unknown, TPathMeta<T>>
//   3. methods<P, Res, T extends Record<string, TNode<P, Res, any>>>(table: T): TNode<P, Res, TMethodsMeta<T>>
//   4. param<K, C, Res, M>(name: K, child: TNode<C, Res, M>): TNode<Omit<C,K>, Res, TParamMeta<K, M>>
//   5. body/validate: return TNode<P, Res, TBodyMeta<T, _>>
//   6. choice() can keep its current type; it's simply not traversable by the typed client
// ============================================================================

console.log("\n=== DONE ===")
