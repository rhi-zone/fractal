// packages/client/src/index.ts — @rhi-zone/fractal-client
//
// Typed client derived from a fractal Node route tree.
//
// client(node)            → in-process transport (Hyper unification: invokes node.handler directly)
// client(node, http(url)) → HTTP transport (same type, real fetch over the wire)
//
// Type derivation is ported from spike/typed-client.ts and spike/path-bothand.ts.
// KEY TYPE TRICKS (documented in spikes):
//   - Split makeClient<M> (typed wrapper) + makeClientImpl (untyped) to dodge TS2589.
//   - `any` in the recursive Meta union (ChoiceMeta, BodyMeta<any,any>) to dodge TS2456.
//   - `any` for P in client-side contravariant conditionals (ClientOfVerbNode).
//   - `& string` on mapped keys for noUncheckedIndexedAccess.
//
// Meta types consumed from @rhi-zone/fractal-http:
//   PathMeta<Children>       — dispatch on path segment
//   MethodsMeta<Verbs>       — dispatch on HTTP verb
//   ParamMeta<K,ChildMeta>   — path param (carries child META, not child NODE)
//   BodyMeta<T,ChildMeta>    — body with typed body arg
//   RouteMeta<Collection,Children,ParamK,ParamChild> — both-and combinator
//
// NOTE on BodyMeta vs the spike:
//   The packages/http body() combinator returns Node<P,Res,BodyMeta> where BodyMeta
//   carries `child: Meta` (the wrapped handler's meta). However the body() signature
//   takes a *HandlerWithBody* (a plain function), not a Node — so BodyMeta.child is
//   always { kind: "leaf" } or a ValidateMeta. The typed client treats any
//   BodyMeta as a body-taking callable: the _bodyType phantom field carries T.
//
// NOTE on ParamMeta vs the spike:
//   packages/http param() stores child.meta in ParamMeta.child (a Meta value).
//   The spike stored the full child TNode for recursive makeClient calls. To get
//   the child Node for in-process invocation we walk the RouteMeta.param.child
//   (which IS a full NodeShape) rather than using the raw ParamMeta approach.
//   For path()/param() nodes, the typed client uses the PathMeta path and ParamMeta
//   path for TYPE DERIVATION only; RUNTIME routing goes through the root handler.
//
// RUNTIME STRATEGY (simpler than spike, works with packages' meta shapes):
//   At each node, we assemble the full path segments + params accumulated so far,
//   then call the ROOT node's handler (or a per-transport call) with path=[...segments].
//   The root handler does the full routing. This avoids needing child node references
//   at every level — only RouteMeta carries full child NodeShapes (in .collection,
//   .children[seg], .param.child) which we use for the route combinator.
//
//   For path/methods/param nodes (produced by the older combinators) we use a
//   "segment accumulator + root handler" strategy for the in-process transport.
//   For the HTTP transport both strategies work identically.

import type {
  Node,
  Meta,
} from '@rhi-zone/fractal-core'

import type {
  PathMeta,
  MethodsMeta,
  ParamMeta,
  BodyMeta,
  RouteMeta,
} from '@rhi-zone/fractal-http'

// ---------------------------------------------------------------------------
// NodeShape — open interface for table constraints
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface NodeShape extends Node<any, any, any> {}

// ---------------------------------------------------------------------------
// Transport interface
//
// A Transport serializes an accumulated call descriptor into a result.
// The call descriptor carries the HTTP method, path segments, params (path
// params captured along the way), and an optional body value.
// ---------------------------------------------------------------------------

export interface TransportCall {
  method: string
  path: string[]
  params: Record<string, string>
  body?: unknown
}

export interface Transport {
  call(desc: TransportCall): Promise<unknown>
}

// ---------------------------------------------------------------------------
// inProcess(node): transport that invokes the node handler directly.
//
// Assembles an HttpReq from the accumulated {method, path, params, body} and
// calls node.handler(req). Passes[] up become errors.
// ---------------------------------------------------------------------------

const PASS_SYMBOL = Symbol('fractal.Pass')

export function inProcess(node: Node<Record<string, never>, unknown>): Transport {
  return {
    async call(desc: TransportCall): Promise<unknown> {
      const req = {
        method: desc.method,
        path: desc.path,
        query: {} as Record<string, string>,
        headers: {} as Record<string, string>,
        params: desc.params as Record<string, never>,
        ...(desc.body !== undefined
          ? { body: () => Promise.resolve(desc.body) }
          : {}),
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (node.handler as (req: unknown) => Promise<unknown>)(req)
      if (typeof res === 'symbol' && res.toString() === PASS_SYMBOL.toString()) {
        throw new Error(`[fractal-client] inProcess: no handler matched — path=${desc.path.join('/')} method=${desc.method}`)
      }
      // Check for Pass by symbol description (works across module instances)
      if (typeof res === 'symbol' && (res as symbol).description === 'fractal.Pass') {
        throw new Error(`[fractal-client] inProcess: no handler matched — path=${desc.path.join('/')} method=${desc.method}`)
      }
      return res
    },
  }
}

// ---------------------------------------------------------------------------
// http(baseUrl): transport that serializes the call to a real fetch.
// ---------------------------------------------------------------------------

export function http(baseUrl: string): Transport {
  return {
    async call(desc: TransportCall): Promise<unknown> {
      const url = `${baseUrl.replace(/\/$/, '')}/${desc.path.join('/')}`
      const hasBody = desc.body !== undefined
      const fetchInit: RequestInit = {
        method: desc.method,
        headers: hasBody ? { 'Content-Type': 'application/json' } : {},
      }
      if (hasBody) {
        fetchInit.body = JSON.stringify(desc.body)
      }
      const response = await fetch(url, fetchInit)
      if (!response.ok && response.status === 404) {
        throw new Error(`[fractal-client] http: 404 ${desc.method} ${url}`)
      }
      const text = await response.text()
      if (!text) return null
      return JSON.parse(text) as unknown
    },
  }
}

// ---------------------------------------------------------------------------
// CLIENT TYPE DERIVATION
//
// Ported from spike/typed-client.ts and spike/path-bothand.ts.
// Adapts to the actual packages/http Meta types.
//
// Key adaptations:
//   - ParamMeta<K,ChildMeta> carries child META (not child node), so the client
//     type for param is: (value: string) => ClientOfMeta<ChildMeta>
//     The runtime must use the param child node from RouteMeta when available,
//     or re-root from a path accumulator for standalone param() nodes.
//   - BodyMeta<T,ChildMeta> from packages/http has `_bodyType?: T` (optional phantom).
//     Client treats any BodyMeta as (body: T) => Promise<Res>. Res is inferred
//     from the enclosing MethodsMeta verb node.
//   - RouteMeta carries Collection (full NodeShape), Children (full NodeShapes),
//     param.child (full NodeShape) — these are the ones we recurse into.
// ---------------------------------------------------------------------------

// ClientOfVerbNode: a verb node → its callable signature.
// For BodyMeta nodes the Res is in the BodyMeta's child chain — we use the
// outer method node's Res (inferred from Node<any,infer Res,any>).
// `any` for P dodges contravariance rejection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientOfVerbNode<N> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  N extends Node<any, infer Res, BodyMeta<infer T, any>>
    ? (body: T) => Promise<Res>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : N extends Node<any, infer Res, any>
      ? () => Promise<Res>
      : never

// MethodsClient<Verbs>: map verb keys to their callables.
// `& string` avoids noUncheckedIndexedAccess adding | undefined.
type MethodsClient<Verbs extends Record<string, NodeShape>> = {
  [K in keyof Verbs & string]: ClientOfVerbNode<Verbs[K]>
}

// PathClient<Children>: map path segment keys to their client types.
type PathClient<Children extends Record<string, NodeShape>> = {
  [K in keyof Children & string]: ClientOf<Children[K]>
}

// ParamCallable<ParamChild>: callable when param present, empty record when absent.
type ParamCallable<ParamChild extends NodeShape> =
  [ParamChild] extends [never]
    ? Record<never, never>
    : (value: string) => ClientOf<ParamChild>

// CollectionPart<Collection>: the collection's client surface, or empty.
type CollectionPart<Collection extends NodeShape | undefined> =
  Collection extends NodeShape
    ? ClientOf<Collection>
    : Record<never, never>

// ChildrenPart<Children>: exact-child props.
type ChildrenPart<Children extends Record<string, NodeShape>> = {
  [K in keyof Children & string]: ClientOf<Children[K]>
}

// RouteClient: the callable-object hybrid from route().
type RouteClient<
  Collection extends NodeShape | undefined,
  Children extends Record<string, NodeShape>,
  ParamChild extends NodeShape,
> = ParamCallable<ParamChild> & CollectionPart<Collection> & ChildrenPart<Children>

// ClientOfMeta<M>: recursive derivation of client surface from a meta type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientOfMeta<M extends Meta> =
  // Leaf: no-arg call (method is accumulated via MethodsMeta; leaf just returns)
  M extends { kind: "leaf" }
    ? () => Promise<unknown>
  // Body: takes a typed body arg
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  : M extends BodyMeta<infer T, any>
    ? (body: T) => Promise<unknown>
  // Methods: { [VERB]: callable }
  : M extends MethodsMeta<infer Verbs>
    ? MethodsClient<Verbs>
  // Path: { [seg]: ClientOf<child> }
  : M extends PathMeta<infer Children>
    ? PathClient<Children>
  // Param: (value: string) => ClientOfMeta<child meta>
  : M extends ParamMeta<infer _K, infer ChildMeta>
    ? ChildMeta extends Meta
      ? (value: string) => ClientOfMeta<ChildMeta>
      : never
  // Route (both-and): callable-object hybrid
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  : M extends RouteMeta<infer Collection, infer Children, infer _ParamK, infer ParamChild>
    ? RouteClient<Collection, Children, ParamChild>
  : never

// ClientOf<N>: entry point for type derivation from a Node.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClientOf<N> = N extends Node<any, any, infer M> ? ClientOfMeta<M> : never

// ---------------------------------------------------------------------------
// RUNTIME: makeClientImpl (untyped) + makeClient<M> (typed wrapper)
//
// Two-layer split dodges TS2589 "type instantiation excessively deep" errors
// that occur when recursive ClientOfMeta<M> is instantiated in recursive calls.
//
// Context carries:
//   path:      segments accumulated so far (for path/param routing)
//   params:    path param key→value map (for body param injection)
//   transport: the active Transport
//
// For path() and param() nodes we accumulate segments and params in ctx, then
// when we hit the leaf (methods/body/leaf), we fire the transport with the
// accumulated path + method.
//
// For route() nodes we handle the callable-object hybrid directly using the
// full child node references stored in RouteMeta.
// ---------------------------------------------------------------------------

interface ClientCtx {
  path: string[]
  params: Record<string, string>
  transport: Transport
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClientImpl(node: Node<any, any, any>, ctx: ClientCtx): unknown {
  const meta = node.meta as Meta & Record<string, unknown>

  // ── leaf ────────────────────────────────────────────────────────────────────
  if (meta.kind === 'leaf') {
    return async () => {
      return ctx.transport.call({
        method: 'GET',
        path: ctx.path,
        params: ctx.params,
      })
    }
  }

  // ── body ────────────────────────────────────────────────────────────────────
  if (meta.kind === 'body') {
    return (bodyArg: unknown) => {
      return ctx.transport.call({
        method: 'POST',
        path: ctx.path,
        params: ctx.params,
        body: bodyArg,
      })
    }
  }

  // ── methods ─────────────────────────────────────────────────────────────────
  if (meta.kind === 'methods') {
    const verbsMeta = (meta as unknown as MethodsMeta<Record<string, NodeShape>>).verbs
    const obj: Record<string, unknown> = {}
    for (const [verb, verbNode] of Object.entries(verbsMeta)) {
      const childMeta = verbNode.meta as Meta & Record<string, unknown>
      if (childMeta.kind === 'body') {
        obj[verb] = (bodyArg: unknown) => {
          return ctx.transport.call({
            method: verb,
            path: ctx.path,
            params: ctx.params,
            body: bodyArg,
          })
        }
      } else {
        obj[verb] = () => {
          return ctx.transport.call({
            method: verb,
            path: ctx.path,
            params: ctx.params,
          })
        }
      }
    }
    return obj
  }

  // ── path ────────────────────────────────────────────────────────────────────
  if (meta.kind === 'path') {
    const children = (meta as unknown as PathMeta<Record<string, NodeShape>>).children
    const obj: Record<string, unknown> = {}
    for (const [seg, child] of Object.entries(children)) {
      obj[seg] = makeClientImpl(child, {
        ...ctx,
        path: [...ctx.path, seg],
      })
    }
    return obj
  }

  // ── param ───────────────────────────────────────────────────────────────────
  // ParamMeta carries child META not child NODE. We need to reconstruct a proxy
  // node that has the child's handler. But packages/http param() bakes the
  // accumulated route into its own handler — we can't simply call child.handler.
  //
  // STRATEGY: param() nodes are only encountered when using the path()/param()
  // combinators (not route()). In that case the node IS the dispatch handler.
  // We build a thin wrapper that forwards to the root param node's handler with
  // the correct path segment injected, accumulating params in ctx.
  //
  // The param node's handler expects: path[0] = param segment (it consumes it).
  // So we just call the param node's own handler with path=[value, ...ctx.path].
  // This is incorrect in general (ctx.path should be what remains AFTER param).
  //
  // Better: for param nodes, we accumulate the param in ctx.params and create
  // a child proxy using the paramMeta.child meta. Since we don't have the child
  // node reference, we create a synthetic "rooted" call using the parent node.
  //
  // SIMPLER AND CORRECT: call the param node handler directly with path set to
  // [value] — it extracts value, injects into params, then calls its child with
  // path=[]. For this to work the child must be a methods node that matches
  // path=[]. This IS the typical shape: param('id', methods({GET:...})).
  //
  // We create a closure that given `value`, invokes the param node's handler
  // with path=[value] and returns the result from THERE. But we still need to
  // support param nodes nested under path nodes, where the path prefix is also
  // accumulated.
  //
  // BEST APPROACH: for param() standalone nodes (not wrapped in route()), call
  // the node handler with path = [value, ...restPath]. The "restPath" is what
  // remains after param — but in the param(name, child) pattern, child is a
  // methods node which expects path=[]. So restPath=[] and we call:
  //   node.handler({ path: [value], method, params: ctx.params, ... })
  // from within the callable's returned inner client.
  //
  // This is implemented below: return a function that, given value, returns a
  // methods-client proxy that invokes the PARAM node's handler with path=[value].
  if (meta.kind === 'param') {
    const paramMeta = meta as unknown as ParamMeta<string, Meta>
    const childMeta = paramMeta.child
    return (value: string) => {
      // Build the inner context: path includes the param value, params includes the named binding.
      // The path accumulator is used by the transport call, so it must include all segments.
      // For in-process: the synthetic node's handler prepends the prefix path + value so the
      // root node can dispatch correctly.
      const innerCtx: ClientCtx = {
        ...ctx,
        path: [...ctx.path, value],
        params: { ...ctx.params, [paramMeta.name]: value },
      }
      // Create a synthetic child node backed by the PARAM node's handler.
      // The param node expects: path = [prefixSegments..., value, childPath...]
      // At call time (from methods handler), child path is []. So we invoke the
      // root param node with the full prefix+value path.
      const syntheticNode: NodeShape = {
        meta: childMeta as Meta,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (innerReq) => {
          const r = innerReq as Record<string, unknown>
          const childPath = (r['path'] ?? []) as string[]
          // The param node consumes path[0] as the param value, passes rest to child.
          // So we give it [value, ...childPath] — it will extract 'value', inject into params,
          // and call its child handler with childPath.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (node.handler as (r: unknown) => Promise<unknown>)({
            ...r,
            path: [value, ...childPath],
          })
        },
      }
      return makeClientImpl(syntheticNode, innerCtx)
    }
  }

  // ── route (both-and) ───────────────────────────────────────────────────────
  // RouteMeta carries full NodeShapes for collection, children[seg], param.child.
  // This is the clean path: we recurse with the real child nodes.
  if (meta.kind === 'route') {
    const routeMeta = meta as unknown as RouteMeta<
      NodeShape | undefined,
      Record<string, NodeShape>,
      string,
      NodeShape
    >

    // Build param callable if param slot present
    let clientFn: ((value: string) => unknown) | undefined
    if (routeMeta.param !== undefined) {
      const { name: paramName, child: paramChild } = routeMeta.param
      clientFn = (value: string) =>
        makeClientImpl(paramChild, {
          ...ctx,
          path: [...ctx.path, value],
          params: { ...ctx.params, [paramName]: value },
        })
    }

    // The surface object — if param present, start from a function
    let clientObj: Record<string, unknown>
    if (clientFn !== undefined) {
      clientObj = clientFn as unknown as Record<string, unknown>
    } else {
      clientObj = {} as Record<string, unknown>
    }

    // Attach collection method props
    if (routeMeta.collection !== undefined) {
      const collMeta = routeMeta.collection.meta as Meta & Record<string, unknown>
      if (collMeta.kind === 'methods') {
        const verbsMeta = (collMeta as unknown as MethodsMeta<Record<string, NodeShape>>).verbs
        for (const [verb, verbNode] of Object.entries(verbsMeta)) {
          const childMeta = verbNode.meta as Meta & Record<string, unknown>
          if (childMeta.kind === 'body') {
            clientObj[verb] = (bodyArg: unknown) =>
              ctx.transport.call({
                method: verb,
                path: ctx.path,
                params: ctx.params,
                body: bodyArg,
              })
          } else {
            clientObj[verb] = () =>
              ctx.transport.call({
                method: verb,
                path: ctx.path,
                params: ctx.params,
              })
          }
        }
      }
      // Collection might also be a choice() node — handle by just calling it
      if (collMeta.kind === 'choice') {
        // We can't derive individual verb methods from choice(), so attach a
        // generic catch-all via the transport. Per spec: choice() is opaque.
        // We forward the collection's client as a sub-proxy using the collection node.
        const collClient = makeClientImpl(routeMeta.collection, ctx)
        if (typeof collClient === 'object' && collClient !== null) {
          for (const [k, v] of Object.entries(collClient as Record<string, unknown>)) {
            clientObj[k] = v
          }
        }
      }
    }

    // Attach exact-child props
    for (const [seg, child] of Object.entries(routeMeta.children)) {
      clientObj[seg] = makeClientImpl(child, {
        ...ctx,
        path: [...ctx.path, seg],
      })
    }

    return clientObj
  }

  // ── choice / other ─────────────────────────────────────────────────────────
  // choice() is opaque to the typed client — we can't enumerate its branches.
  // Return an empty object (best-effort: typed surface is `never`).
  if (meta.kind === 'choice') {
    return {}
  }

  throw new Error(`[fractal-client] makeClientImpl: unknown meta kind "${meta.kind}"`)
}

// Typed wrapper: provides the generic ClientOf<N> return type for call sites.
// Delegates to makeClientImpl to avoid TS2589 in recursive calls.
export function makeClient<M extends Meta>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: Node<any, any, M>,
  ctx: ClientCtx,
): ClientOfMeta<M> {
  return makeClientImpl(node, ctx) as ClientOfMeta<M>
}

// ---------------------------------------------------------------------------
// client(node, transport?) — the public API
//
// client(node)            → in-process transport (default)
// client(node, http(url)) → HTTP transport
//
// The node is always required (needed at the type level for ClientOf<typeof node>).
// For in-process, the node is also needed at runtime (inProcess(node) calls its handler).
// For HTTP, the node is used only for type derivation; it's not called at runtime.
// ---------------------------------------------------------------------------

export function client<N extends Node<Record<string, never>, unknown>>(
  node: N,
  transport?: Transport,
): ClientOf<N> {
  const t = transport ?? inProcess(node)
  return makeClientImpl(node, { path: [], params: {}, transport: t }) as ClientOf<N>
}
