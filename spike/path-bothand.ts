// spike/path-bothand.ts
//
// SPIKE: Extended path combinator — collection + exact children + param fallthrough
// in ONE combinator, without choice().
//
// DESIGN QUESTION ANSWERED HERE:
//   Can we unify /todos (collection) and /todos/:id (param) under a SINGLE
//   `route` combinator that naturally holds both, so the typed client can derive
//   a callable-object hybrid: client.todos is simultaneously callable and has
//   method props?
//
// CHOSEN COMBINATOR SURFACE:
//   route(collection?, { children?, param? })
//   - collection: a methods({...}) node handling the exhausted-path case
//   - children:   { [literal]: childNode } — exact-segment dispatch
//   - param:      { name, child } — named param fallthrough when no exact match
//
//   Dispatch order: path exhausted → collection; exact child if seg matches;
//   else param fallthrough; else pass.
//
// STANDALONE — does not import the packages.

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
// TMeta — tightened meta types preserving literal structure.
//
// CIRCULAR-REF RESOLUTION:
//   TypeScript type aliases cannot circularly reference themselves (TS2456).
//   The cycle is: TMeta → TBodyMeta<?,TMeta> (direct) and
//   TMeta → TRouteMeta → TNodeShape → TNode<?,?,TMeta> (via interface).
//
//   Fix: Make BOTH TNodeShape and TMeta into interfaces (interfaces are lazily
//   resolved). The interface TMeta extends a plain object type that holds the
//   union discriminant — implemented as a mapped-union trick: we use interface
//   TMeta with a single discriminant property and rely on the conditional-type
//   narrowing in ClientOfMeta to pull out the concrete sub-types.
//
//   In practice: interfaces in TypeScript can be self-referential because they
//   are resolved lazily during checking, not eagerly at alias expansion time.
//   We declare `interface TMeta` as an open discriminant object and use separate
//   typed aliases for the concrete shapes used in conditionals.
// ============================================================================

type TLeafMeta<Res = unknown> = { kind: "leaf"; _res: Res }

type TBodyMeta<T, Child> = {
  kind: "body"
  _bodyType: T
  child: Child
}

// TNodeShape: lazy interface breaks the circular type alias problem.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface TNodeShape extends TNode<any, any, any> {}

type TMethodsMeta<Verbs extends Record<string, TNodeShape>> = {
  kind: "methods"
  verbs: Verbs
}

type TParamSpec<K extends string, Child extends TNodeShape> = {
  name: K
  child: Child
}

// TRouteMeta: the both-and combinator's meta.
// Holds all three slots in ONE meta node.
//
//   Collection — the methods node (or undefined)
//   Children   — exact-segment child map
//   ParamK     — the param key name string literal (never when no param)
//   ParamChild — the param fallthrough child TNode (never when no param)
type TRouteMeta<
  Collection extends TNodeShape | undefined,
  Children extends Record<string, TNodeShape>,
  ParamK extends string,
  ParamChild extends TNodeShape,
> = {
  kind: "route"
  collection: Collection
  children: Children
  param: TParamSpec<ParamK, ParamChild> | undefined
}

// TMeta: the closed discriminated union of all meta shapes.
//
// CIRCULAR REF RESOLUTION:
//   The apparent cycle is: TBodyMeta<T, Child> where Child extends TMeta.
//   But in the union, we write TBodyMeta<any, any> (not TBodyMeta<T, TMeta>).
//   `any` breaks the alias expansion cycle — TypeScript doesn't need to expand
//   `TMeta` to resolve `TBodyMeta<any, any>`. The full parametric shapes
//   (TBodyMeta<T, Child>, TRouteMeta<...>) are used only in conditional types
//   where `infer` extracts the concrete parameters from a narrowed type.
//   This is the same pattern used in spike/typed-client.ts (TParamMeta<any,any>).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TMeta =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | TLeafMeta<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | TBodyMeta<any, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | TMethodsMeta<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | TRouteMeta<any, any, any, any>
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
// Combinators
// ============================================================================

function leaf<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(fn: (req: Req<P>) => Promise<Res>): TNode<P, Res, TLeafMeta<Res>> {
  return { meta: { kind: "leaf", _res: undefined as unknown as Res }, handler: fn }
}

function methods<
  T extends Record<string, TNodeShape>,
>(table: T): TNode<Record<string, never>, unknown, TMethodsMeta<T>> {
  return {
    meta: { kind: "methods", verbs: table },
    handler: async (req: Req<Record<string, never>>) => {
      if (req.path.length > 0) return pass
      const n = table[req.method] as TNodeShape | undefined
      if (n === undefined) return pass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return n.handler(req as Req<any>)
    },
  }
}

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
      const parseResult = parse(rawBody)
      const parsed: T = (parseResult instanceof Promise ? await parseResult : parseResult) as T
      const enriched = { ...req, body: parsed } as unknown as Req<P> & { body: T }
      return inner(enriched)
    },
  }
}

// ============================================================================
// route() — the new both-and combinator
//
// Signature:
//   route(collection?, { children?, param? })
//
// All three slots are independently optional.
// P = Record<string, never> — route is always fully discharged.
//
// The param slot uses TParamSpec<K, Child> where Child carries the child node.
// The Omit<C,K> discharge algebra is preserved: the child node handles requests
// that include the captured param key in their params. The route node itself
// injects the param into req.params before calling the child handler, so the
// outer node's P stays as Record<string, never>.
// ============================================================================

type RouteOptions<
  Children extends Record<string, TNodeShape>,
  ParamK extends string,
  ParamChild extends TNodeShape,
> = {
  children?: Children
  param?: TParamSpec<ParamK, ParamChild>
}

// Implementation of route()
function route<
  Collection extends TNodeShape,
  Children extends Record<string, TNodeShape> = Record<never, never>,
  ParamK extends string = never,
  ParamChild extends TNodeShape = never,
>(
  collection: Collection,
  options?: RouteOptions<Children, ParamK, ParamChild>,
): TNode<Record<string, never>, unknown, TRouteMeta<Collection, Children, ParamK, ParamChild>>

function route<
  Children extends Record<string, TNodeShape>,
  ParamK extends string = never,
  ParamChild extends TNodeShape = never,
>(
  collection: undefined,
  options: RouteOptions<Children, ParamK, ParamChild>,
): TNode<Record<string, never>, unknown, TRouteMeta<undefined, Children, ParamK, ParamChild>>

function route(
  collection: TNodeShape | undefined,
  options: RouteOptions<Record<string, TNodeShape>, string, TNodeShape> = {},
): TNode<Record<string, never>, unknown, TRouteMeta<TNodeShape | undefined, Record<string, TNodeShape>, string, TNodeShape>> {
  const children = options.children ?? {}
  const paramSpec = options.param

  const meta: TRouteMeta<TNodeShape | undefined, Record<string, TNodeShape>, string, TNodeShape> = {
    kind: "route",
    collection,
    children,
    param: paramSpec,
  }

  const handler: Handler<Record<string, never>, unknown> = async (req) => {
    const [seg, ...rest] = req.path

    // Path exhausted → collection
    if (seg === undefined) {
      if (collection === undefined) return pass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return collection.handler({ ...req, path: [] } as Req<any>)
    }

    // Exact child match
    const exactChild = children[seg] as TNodeShape | undefined
    if (exactChild !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return exactChild.handler({ ...req, path: rest } as Req<any>)
    }

    // Param fallthrough
    if (paramSpec !== undefined) {
      const enriched = {
        ...req,
        path: rest,
        params: { ...(req.params as object), [paramSpec.name]: seg },
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return paramSpec.child.handler(enriched as Req<any>)
    }

    return pass
  }

  return { meta, handler }
}

// ============================================================================
// CLIENT TYPE DERIVATION
//
// CALLABLE-OBJECT HYBRID:
//   When a route node has a param slot, client.todos is simultaneously:
//     - callable: client.todos('1') → sub-client
//     - has properties: client.todos.GET(), client.todos.POST(body)
//
//   Realized in TypeScript as an intersection:
//     ((value: string) => SubClient) & { GET(): Promise<Todo[]>; POST(b: CreateInput): Promise<Todo> }
//
//   JS semantics: functions are objects. We create a function, attach properties
//   onto it, and return it. TypeScript's intersection type captures both aspects.
//
// KEY FINDING (reported honestly):
//   The negative assertions (NEG-1..NEG-4) require that the conditional type
//   ClientOfMeta<M> resolves to a CONCRETE surface with literal verb keys and
//   literal child segment keys — not `Record<string, ...>`.
//
//   This requires:
//     (a) MethodsMeta carries the literal Verbs table type T (preserved — done).
//     (b) TBodyMeta carries the literal body type T (preserved — done).
//     (c) TRouteMeta carries the literal Children and Collection types (preserved — done).
//     (d) ClientOfMeta conditionals resolve at the call site, not abstractly.
//
//   The tsgo run will tell us whether all four negatives are consumed.
// ============================================================================

// ClientOfVerbNode: maps a verb node to its callable signature.
// Uses `any` for P to avoid contraviance rejection: TNode<{},Res,M> does not
// extend TNode<Record<string,unknown>,Res,M> because Handler<{}> is not
// assignable to Handler<Record<string,unknown>> (contravariance in P).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientOfVerbNode<N> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  N extends TNode<any, infer Res, TBodyMeta<infer T, any>>
    ? (body: T) => Promise<Res>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : N extends TNode<any, infer Res, any>
      ? () => Promise<Res>
      : never

// MethodsClient<Verbs>: { [verb]: callable }
// Only iterates literal keys — no string-index fallback added.
type MethodsClient<Verbs extends Record<string, TNodeShape>> = {
  [K in keyof Verbs & string]: ClientOfVerbNode<Verbs[K]>
}

// ClientOf: the top-level client derivation entry point.
// Uses `any` for P/Res to avoid contravariance rejection on Handler<P>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientOf<N> = N extends TNode<any, any, infer M> ? ClientOfMeta<M> : never

// ClientOfMeta<M>: recursive derivation of the client surface from a meta type
type ClientOfMeta<M extends TMeta> =
  M extends TLeafMeta<infer Res>
    ? () => Promise<Res>
  : M extends TBodyMeta<infer T, TLeafMeta<infer Res>>
    ? (body: T) => Promise<Res>
  : M extends TMethodsMeta<infer Verbs>
    ? MethodsClient<Verbs>
  : M extends TRouteMeta<infer Collection, infer Children, infer _ParamK, infer ParamChild>
    ? RouteClient<Collection, Children, ParamChild>
  : never

// RouteClient: the callable-object hybrid
//
// Three intersected parts:
//   1. ParamCallable: ((value: string) => ClientOf<ParamChild>)  if param present
//   2. CollectionPart: the collection's client surface (MethodsClient<...>)  if present
//   3. ChildrenPart: { [seg]: ClientOf<child> }  for exact children
//
// When param is present, ParamCallable is a function type. CollectionPart and
// ChildrenPart add properties. The intersection creates the callable-object hybrid.
//
// When param is absent (ParamChild = never), ParamCallable = Record<never,never>
// (contributes nothing, no callable aspect).

type ParamCallable<ParamChild extends TNodeShape> =
  [ParamChild] extends [never]
    ? Record<never, never>
    : (value: string) => ClientOf<ParamChild>

type CollectionPart<Collection extends TNodeShape | undefined> =
  Collection extends TNodeShape
    ? ClientOf<Collection>
    : Record<never, never>

type ChildrenPart<Children extends Record<string, TNodeShape>> = {
  [K in keyof Children & string]: ClientOf<Children[K]>
}

type RouteClient<
  Collection extends TNodeShape | undefined,
  Children extends Record<string, TNodeShape>,
  ParamChild extends TNodeShape,
> = ParamCallable<ParamChild> & CollectionPart<Collection> & ChildrenPart<Children>

// ============================================================================
// RUNTIME: makeClient
//
// Callable-object hybrid: create a function (for param callable), attach
// properties (collection verbs + exact children) directly onto it.
// JS functions are objects, so property assignment is valid.
//
// ARCHITECTURE: Split into typed wrapper + untyped implementation to avoid
// TS2589 "type instantiation excessively deep" errors when evaluating
// ClientOfMeta<M> with abstract M in recursive calls.
// ============================================================================

// Untyped implementation — does the actual work without generic constraints
// that trigger deep ClientOfMeta<M> instantiation in recursive calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClientImpl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: TNode<any, any, any>,
  ctx: { path: string[]; params: Record<string, string> },
): unknown {
  const meta = node.meta

  if (meta.kind === "leaf") {
    return async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: Req<any> = { path: [], method: "GET", query: {}, headers: {}, params: ctx.params }
      const res = await node.handler(req)
      if (res === pass) throw new Error(`[path-bothand] no match at leaf`)
      return res
    }
  }

  if (meta.kind === "body") {
    return ((bodyArg: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: Req<any> = {
        path: [],
        method: "POST",
        query: {},
        headers: {},
        params: ctx.params,
        body: () => Promise.resolve(bodyArg),
      }
      return node.handler(req).then((res) => {
        if (res === pass) throw new Error(`[path-bothand] no match at body node`)
        return res
      })
    })
  }

  if (meta.kind === "methods") {
    const verbsMeta = (meta as unknown as TMethodsMeta<Record<string, TNodeShape>>).verbs
    const obj: Record<string, unknown> = {}
    for (const [verb, child] of Object.entries(verbsMeta)) {
      const childMeta = child.meta
      if (childMeta.kind === "body") {
        obj[verb] = (bodyArg: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const req: Req<any> = {
            path: [],
            method: verb,
            query: {},
            headers: {},
            params: ctx.params,
            body: () => Promise.resolve(bodyArg),
          }
          return node.handler(req).then((res) => {
            if (res === pass) throw new Error(`[path-bothand] 404 ${verb}`)
            return res
          })
        }
      } else {
        obj[verb] = () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const req: Req<any> = {
            path: [],
            method: verb,
            query: {},
            headers: {},
            params: ctx.params,
          }
          return node.handler(req).then((res) => {
            if (res === pass) throw new Error(`[path-bothand] 404 ${verb}`)
            return res
          })
        }
      }
    }
    return obj
  }

  if (meta.kind === "route") {
    const routeMeta = meta as unknown as TRouteMeta<TNodeShape | undefined, Record<string, TNodeShape>, string, TNodeShape>

    // Build the callable function (param slot) or a no-op function
    let clientFn: (value: string) => unknown

    if (routeMeta.param !== undefined) {
      const { name: paramName, child: paramChild } = routeMeta.param
      clientFn = (value: string) =>
        makeClientImpl(paramChild, {
          path: [...ctx.path, value],
          params: { ...ctx.params, [paramName]: value },
        })
    } else {
      clientFn = () => { throw new Error(`[path-bothand] this route node has no param fallthrough`) }
    }

    // JS: functions are objects — cast and attach properties
    const clientObj = clientFn as unknown as Record<string, unknown>

    // Attach collection method props
    if (routeMeta.collection !== undefined) {
      const collMeta = routeMeta.collection.meta
      if (collMeta.kind === "methods") {
        const verbsMeta = (collMeta as unknown as TMethodsMeta<Record<string, TNodeShape>>).verbs
        const collHandler = routeMeta.collection.handler
        for (const [verb, child] of Object.entries(verbsMeta)) {
          const childMeta = child.meta
          if (childMeta.kind === "body") {
            clientObj[verb] = (bodyArg: unknown) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const req: Req<any> = {
                path: [],
                method: verb,
                query: {},
                headers: {},
                params: ctx.params,
                body: () => Promise.resolve(bodyArg),
              }
              return collHandler(req).then((res) => {
                if (res === pass) throw new Error(`[path-bothand] 404 ${verb}`)
                return res
              })
            }
          } else {
            clientObj[verb] = () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const req: Req<any> = {
                path: [],
                method: verb,
                query: {},
                headers: {},
                params: ctx.params,
              }
              return collHandler(req).then((res) => {
                if (res === pass) throw new Error(`[path-bothand] 404 ${verb}`)
                return res
              })
            }
          }
        }
      }
    }

    // Attach exact-child props
    for (const [seg, child] of Object.entries(routeMeta.children)) {
      clientObj[seg] = makeClientImpl(child, { path: [...ctx.path, seg], params: ctx.params })
    }

    return clientObj
  }

  throw new Error(`[path-bothand] unknown meta kind: ${(meta as { kind: string }).kind}`)
}

// Typed wrapper: provides the generic ClientOfMeta<M> return type for call sites.
// Delegates to makeClientImpl to avoid TS2589 in recursive calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient<M extends TMeta>(
  node: TNode<any, any, M>,
  ctx: { path: string[]; params: Record<string, string> } = { path: [], params: {} },
): ClientOfMeta<M> {
  return makeClientImpl(node, ctx) as ClientOfMeta<M>
}

// ============================================================================
// walk(meta) → OpenAPI-ish fragment
// Handles TRouteMeta: emits collection ops at current prefix,
// exact-child ops at prefix/seg, param ops at prefix/{name}.
// ============================================================================

type OpenApiParam = { name: string; in: "path"; schema: { type: string } }
type OpenApiOperation = {
  parameters: OpenApiParam[]
  requestBody?: { content: { "application/json": { schema: unknown } } }
}
type OpenApiPaths = Record<string, Record<string, OpenApiOperation>>

function walk(
  meta: TMeta,
  ctx: { prefix: string; method?: string; params: OpenApiParam[] } = { prefix: "", params: [] },
): OpenApiPaths {
  switch (meta.kind) {
    case "leaf": {
      if (!ctx.method) return {}
      const op: OpenApiOperation = { parameters: [...ctx.params] }
      return { [ctx.prefix || "/"]: { [ctx.method]: op } }
    }

    case "body": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sub = walk((meta as TBodyMeta<unknown, any>).child as TMeta, ctx)
      for (const verbs of Object.values(sub)) {
        for (const op of Object.values(verbs)) {
          op.requestBody = { content: { "application/json": { schema: { type: "object" } } } }
        }
      }
      return sub
    }

    case "methods": {
      const merged: OpenApiPaths = {}
      const verbsMeta = (meta as unknown as TMethodsMeta<Record<string, TNodeShape>>).verbs
      for (const [verb, child] of Object.entries(verbsMeta)) {
        const sub = walk(child.meta, { ...ctx, method: verb.toLowerCase() })
        for (const [p, verbs] of Object.entries(sub)) {
          merged[p] = { ...(merged[p] ?? {}), ...verbs }
        }
      }
      return merged
    }

    case "route": {
      const routeMeta = meta as unknown as TRouteMeta<TNodeShape | undefined, Record<string, TNodeShape>, string, TNodeShape>
      const merged: OpenApiPaths = {}

      // Collection: walk at current prefix
      if (routeMeta.collection !== undefined) {
        const collSub = walk(routeMeta.collection.meta, ctx)
        for (const [p, verbs] of Object.entries(collSub)) {
          merged[p] = { ...(merged[p] ?? {}), ...verbs }
        }
      }

      // Exact children
      for (const [seg, child] of Object.entries(routeMeta.children)) {
        const sub = walk(child.meta, { ...ctx, prefix: `${ctx.prefix}/${seg}` })
        for (const [p, verbs] of Object.entries(sub)) {
          merged[p] = { ...(merged[p] ?? {}), ...verbs }
        }
      }

      // Param fallthrough
      if (routeMeta.param !== undefined) {
        const { name, child } = routeMeta.param
        const newParam: OpenApiParam = { name, in: "path", schema: { type: "string" } }
        const sub = walk(child.meta, {
          ...ctx,
          prefix: `${ctx.prefix}/{${name}}`,
          params: [...ctx.params, newParam],
        })
        for (const [p, verbs] of Object.entries(sub)) {
          merged[p] = { ...(merged[p] ?? {}), ...verbs }
        }
      }

      return merged
    }

    default:
      return {}
  }
}

// ============================================================================
// EXAMPLE: Todo API — the both-and tree
//
// Structure:
//   /todos         GET  → list all todos
//                  POST → create todo (body: {title})
//   /todos/{id}    GET  → get todo by id
//
// ONE route node handles all three, no choice() needed.
// ============================================================================

interface Todo {
  id: number
  title: string
  done: boolean
}
type CreateInput = { title: string }

let nextId = 1
const store: Todo[] = [
  { id: nextId++, title: 'fractal both-and example', done: false },
]

function parseCreate(raw: unknown): CreateInput {
  if (
    typeof raw === 'object' && raw !== null &&
    typeof (raw as Record<string, unknown>)['title'] === 'string'
  ) {
    return { title: (raw as Record<string, unknown>)['title'] as string }
  }
  throw new Error(`expected {title:string}, got ${JSON.stringify(raw)}`)
}

const listLeaf = leaf<Record<string, never>, Todo[]>(async () => [...store])

const createNode = body<CreateInput, Record<string, never>, Todo>(
  parseCreate,
  async (req) => {
    const todo: Todo = { id: nextId++, title: req.body.title, done: false }
    store.push(todo)
    return todo
  },
)

const getByIdLeaf = leaf<{ id: string }, Todo | null>(
  async (req) => store.find((t) => t.id === Number(req.params.id)) ?? null,
)

const idSubtree = methods({ GET: getByIdLeaf })

// The both-and route node:
//   collection = methods({ GET: list, POST: create })
//   no exact children
//   param = { name: 'id', child: methods({ GET: getById }) }
const todosRoute = route(
  methods({ GET: listLeaf, POST: createNode }),
  {
    param: {
      name: 'id' as const,
      child: idSubtree,
    },
  },
)

// Top-level: route with no collection, one exact child "todos"
const appTree = route(undefined, { children: { todos: todosRoute } })

// ============================================================================
// TYPE PROBE: the callable-object hybrid client surface
//
// AppClient should expand to:
// {
//   todos: ((value: string) => MethodsClient<{GET: getByIdLeaf}>)
//          & MethodsClient<{GET: listLeaf, POST: createNode}>
//          & {}   (no exact children on todosRoute)
// }
//
// i.e. client.todos is callable AND has .GET() and .POST(body) properties.
// ============================================================================

const client = makeClient(appTree)

type AppTree = typeof appTree
type AppClient = ClientOf<AppTree>
type _ = AppClient

// ============================================================================
// POSITIVE ASSERTIONS (compile-time type checking + runtime)
// ============================================================================

// client.todos.GET() → Promise<Todo[]>
const todosListResult: Promise<Todo[]> = client.todos.GET()

// client.todos.POST({title}) → Promise<Todo>
const todosCreateResult: Promise<Todo> = client.todos.POST({ title: "new todo" })

// client.todos('1') → sub-client for item
const todoByIdClient = client.todos('1')

// client.todos('1').GET() → Promise<Todo | null>
const todoById1Result: Promise<Todo | null> = todoByIdClient.GET()

// ============================================================================
// NEGATIVE ASSERTIONS — @ts-expect-error probes
// (wrapped in false && ... so they never execute at runtime)
// ============================================================================

// NEG-1: Wrong body type to POST (number instead of CreateInput)
// @ts-expect-error [NEG-1: number is not assignable to CreateInput]
const _neg1: Promise<Todo> = false && client.todos.POST(42)

// NEG-2: Wrong param type to todos callable (number instead of string)
// @ts-expect-error [NEG-2: number is not assignable to string]
const _neg2 = false && client.todos(42)

// NEG-3: Nonexistent verb on todos collection (DELETE not in table)
// @ts-expect-error [NEG-3: DELETE does not exist on todos client surface]
const _neg3 = false && client.todos.DELETE()

// NEG-4: Nonexistent exact child on app root (nonexistent not in children)
// @ts-expect-error [NEG-4: nonexistent does not exist on appTree client]
const _neg4 = false && client.nonexistent

// ============================================================================
// DISCHARGE STILL HOLDS
//
// The Omit<C,K> discharge algebra is preserved:
//   - getByIdLeaf: TNode<{id:string}, Todo|null, ...>
//   - idSubtree = methods({GET:getByIdLeaf}): TNode<{}, unknown, TMethodsMeta<...>>
//     (methods handler receives fully-consumed path with id in params)
//   - todosRoute: TNode<{}, unknown, TRouteMeta<...>> — fully discharged
//   - appTree: TNode<{}, unknown, TRouteMeta<...>> — fully discharged
//
// G1-style check: a leaf expecting {id:number} is NOT assignable to one expecting
// {id:string} — the type system preserves string-pinning through TNode.
// ============================================================================

const _g1NumberLeaf = leaf<{ id: number }, string>(async (req) => String(req.params.id))
const _g1StringLeaf = leaf<{ id: string }, string>(async (req) => req.params.id)

// Discharge: TNode<{id:string},...> is assignable to itself
const _dischargeOk: TNode<{ id: string }, string, TLeafMeta<string>> = _g1StringLeaf

// G1: TNode<{id:number},...> is NOT assignable to TNode<{id:string},...>
// @ts-expect-error [DISCHARGE-G1: TNode<{id:number}> not assignable to TNode<{id:string}>]
const _dischargeG1Fail: TNode<{ id: string }, string, TLeafMeta<string>> = _g1NumberLeaf

// ============================================================================
// walk(meta) → OpenAPI fragment + deep-equal assertion
// ============================================================================

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a as object).sort()
  const bKeys = Object.keys(b as object).sort()
  if (aKeys.join(',') !== bKeys.join(',')) return false
  for (const k of aKeys) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

const fragment = walk(appTree.meta)

const expectedFragment: OpenApiPaths = {
  "/todos": {
    get: { parameters: [] },
    post: {
      parameters: [],
      requestBody: { content: { "application/json": { schema: { type: "object" } } } },
    },
  },
  "/todos/{id}": {
    get: { parameters: [{ name: "id", in: "path", schema: { type: "string" } }] },
  },
}

// ============================================================================
// RUNTIME
// ============================================================================

console.log("=== spike/path-bothand.ts — both-and route + callable-object client ===\n")
console.log("--- Positive assertions (runtime) ---")

const r1 = await todosListResult
console.log("client.todos.GET()                    →", JSON.stringify(r1))

const r2 = await todosCreateResult
console.log("client.todos.POST({title:'new todo'}) →", JSON.stringify(r2))

const r3 = await todoById1Result
console.log("client.todos('1').GET()               →", JSON.stringify(r3))

const r4 = await client.todos.GET()
console.log("client.todos.GET() after POST         →", JSON.stringify(r4))

const r5 = await client.todos('9999').GET()
console.log("client.todos('9999').GET()            →", r5, "(null expected)")

console.log("\n--- @ts-expect-error negatives (compile-time) ---")
console.log("NEG-1: .todos.POST(42)       wrong body type   — @ts-expect-error consumed")
console.log("NEG-2: .todos(42)            wrong param type  — @ts-expect-error consumed")
console.log("NEG-3: .todos.DELETE()       nonexistent verb  — @ts-expect-error consumed")
console.log("NEG-4: .nonexistent          nonexistent child — @ts-expect-error consumed")
console.log("DISCHARGE-G1: TNode<{id:number}> not assignable to TNode<{id:string}> — @ts-expect-error consumed")

console.log("\n--- walk(meta) → OpenAPI fragment ---")
console.log(JSON.stringify(fragment, null, 2))
console.log("\nExpected:")
console.log(JSON.stringify(expectedFragment, null, 2))

const walkOk = deepEqual(fragment, expectedFragment)
console.log("\nwalk() deep-equal:", walkOk ? "PASS ✓" : "FAIL ✗")

if (!walkOk) {
  console.error("WALK MISMATCH")
  throw new Error("WALK MISMATCH — see diff above")
}

console.log("\n--- Type probe: AppClient ---")
console.log("type AppClient = ClientOf<AppTree>")
console.log("client.todos: callable-object hybrid")
console.log("  client.todos.GET()    → Promise<Todo[]>")
console.log("  client.todos.POST(b)  → Promise<Todo>  (b: CreateInput)")
console.log("  client.todos('1')     → sub-client { GET(): Promise<Todo|null> }")
console.log("  client.todos('1').GET() → Promise<Todo|null>")

console.log("\n=== DONE ===")
