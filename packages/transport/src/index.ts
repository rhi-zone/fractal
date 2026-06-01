// @rhi-zone/fractal-transport
// The unified transport KERNEL. Two halves of one RPC boundary:
//
//   client side  → `Transport` (invoke / optional stream) + `clientOver` Proxy
//   server side  → `Dispatcher`: ONE tree-walk that generalizes core's
//                  `evaluate` and a channel-http path-walk into a single descent.
//
// The kernel owns the three transport-axis INTERFACES (Channel / Codec /
// Protocol + the Exchange form), the AXIS ASSEMBLERS (compose / attach /
// composeRequestResponse), the `dispatcher`, and the `clientOver` Proxy. Concrete
// instances along each axis live in their own per-axis packages:
//   codecs    → fractal-codec-json, fractal-codec-structured-clone
//   protocols → fractal-protocol-correlation
//   channels  → fractal-channel-websocket / -worker / -stdio / -http
//
// The one-shot request/response form has NO standalone protocol package: its
// whole logic IS the kernel assemblers `composeRequestResponse` (client) and
// `serveExchange` (server). HTTP is its present instance (fractal-channel-http
// supplies the `httpExchange` medium + the Web/Bun/Node server handlers).
//
// Dependency direction: every per-axis package → fractal-transport → core. They
// provide a `Transport` to `clientOver` and call a `Dispatcher` on the server
// side; the wire format is the per-axis package's concern.

import {
  evaluate,
  evaluateStream,
  type AnyNode,
  type Branch,
  type Context,
  type ErrorOf,
  type InputOf,
  type Meta,
  type ModeOf,
  type OutputOf,
  type Result,
  type UClient,
} from '@rhi-zone/fractal-core'

// ── Client side: Transport ──────────────────────────────────────────────────

/**
 * A Transport carries a single RPC call across some boundary (HTTP, IPC, an
 * in-process bridge …). It is the client-side counterpart of a {@link Dispatcher}.
 *
 *   - `invoke` carries a UNARY call: one input → one Result.
 *   - `stream` (OPTIONAL) carries a STREAMING call: one input → many Results.
 *
 * The PRESENCE of `stream?` is the capability advertisement: "this transport
 * can carry a stream." A transport that omits `stream?` cannot service a
 * streaming leaf; `clientOver` errors explicitly rather than silently degrade.
 *
 * `path` is the branch-key path to the leaf (e.g. `['users', 'list']`); the
 * adapter maps it onto its own addressing (URL segments, channel ids, …).
 * `meta?` is per-call metadata (auth tokens, headers); the adapter maps it onto
 * its envelope.
 */
export interface Transport {
  invoke(
    path: readonly string[],
    input: unknown,
    meta?: Meta,
    method?: string,
  ): Promise<Result<unknown, unknown>>
  stream?(
    path: readonly string[],
    input: unknown,
    meta?: Meta,
    method?: string,
  ): AsyncIterable<Result<unknown, unknown>>
}

// ── Server side: Dispatcher ───────────────────────────────────────────────────

/**
 * A function that produces the pre-opened handle(s) for one capability `kind`.
 * Generic over `Raw`, the transport-native request object the grant may read
 * (via `req.raw`) for transport-specific data — HTTP headers, method, etc.
 */
export type CapGrant<Raw = unknown> = (req: DispatchRequest<Raw>) => Record<string, unknown>

/**
 * The decoded request a {@link Dispatcher} consumes. An adapter decodes its
 * wire form (HTTP Request, IPC frame, …) into this shape; the dispatcher is
 * transport-agnostic.
 */
export interface DispatchRequest<Raw = unknown> {
  /** Branch-key path to the target node, already split (e.g. ['users', 'list']). */
  readonly path: readonly string[]
  /** Leaf input (decoded body). */
  readonly input: unknown
  /** Per-call metadata (decoded headers / envelope). */
  readonly meta?: Meta
  /**
   * The request's HTTP method (or any verb a channel carries), used by a
   * `methods` node to select its verb handler (case-insensitive). Absent on
   * non-HTTP transports (WS / worker / stdio / in-process): a `methods` node then
   * falls back to its `defaultVerb`. NOT a path segment — a `methods` node sits at
   * a single path position and dispatches on this, not on the URL.
   */
  readonly method?: string
  /** Cancellation signal — the dispatcher threads it into Context and honors it. */
  readonly signal?: AbortSignal
  /**
   * The transport-native request object — the typed escape hatch for grants
   * that need transport-specific data (HTTP headers/method, an IPC frame, …).
   * `path`/`input`/`meta`/`signal` above are the canonical, transport-agnostic
   * fields; `raw` carries ONLY native extras. Callers with no native request
   * (in-process, tests) set `undefined`.
   */
  readonly raw: Raw
}

/** Options for {@link dispatcher}: capability grants keyed by capability kind. */
export interface DispatcherOptions<Raw = unknown> {
  /** Grants keyed by capability kind. ONLY the matched capability's handle is injected. */
  readonly grants?: Readonly<Record<string, CapGrant<Raw>>>
}

/**
 * The result of one dispatch. A leaf is either unary (one Result) or streaming
 * (an AsyncIterable of Results); the dispatcher reports which so the adapter
 * can frame the response accordingly.
 */
export type DispatchOutcome =
  | { readonly kind: 'unary'; readonly result: Result<unknown, unknown> }
  | { readonly kind: 'stream'; readonly stream: AsyncIterable<Result<unknown, unknown>> }

/** Runtime test: a leaf node carrying `mode: 'stream'` (absent mode ⇒ unary). */
const isStreamMode = (node: AnyNode): boolean => {
  switch (node.tag) {
    case 'leaf':
      return (node as { mode?: string }).mode === 'stream'
    case 'seq':
      return isStreamMode(node.right)
    case 'annotated':
      return isStreamMode(node.child)
    case 'branch':
    case 'methods':
      return false
  }
}

/**
 * Build a Dispatcher over a node tree: ONE tree-walk that GENERALIZES core's
 * `evaluate` and http's path-walk.
 *
 * It owns exactly the part neither core nor a single adapter should re-invent:
 *
 *   branch     → consume one path segment, descend into the named child
 *   annotated  → grant ONLY the matched capability's handle (capability
 *                security: nothing else leaks in) and enforce its gate
 *   leaf / seq → STOP descending and DELEGATE the run to core's
 *                `evaluate` / `evaluateStream`, so leaf/seq semantics
 *                (short-circuit, annotation transparency, stream pulling,
 *                signal-honoring) are defined in exactly one place.
 *
 * Capability grants applied on the way down live in `ctx.caps`; core's
 * evaluators re-enforce any annotation gates INSIDE the delegated subtree using
 * those same caps — behaviorally identical to walking annotations here.
 */
export const dispatcher = <Raw = unknown>(tree: AnyNode, options: DispatcherOptions<Raw> = {}) => {
  const grants = options.grants ?? {}

  const descend = async (
    node: AnyNode,
    segments: readonly string[],
    req: DispatchRequest<Raw>,
    caps: Record<string, unknown>,
  ): Promise<DispatchOutcome> => {
    switch (node.tag) {
      case 'branch': {
        const [head, ...rest] = segments
        const children = node.children as Record<string, AnyNode>
        if (head === undefined || !(head in children)) {
          return {
            kind: 'unary',
            result: { ok: false, error: { code: 'not_callable', message: `no route for /${segments.join('/')}` } },
          }
        }
        const child = children[head]
        if (child === undefined) {
          return { kind: 'unary', result: { ok: false, error: { code: 'not_callable', message: head } } }
        }
        return descend(child, rest, req, caps)
      }
      case 'methods': {
        // A methods node does NOT consume a path segment: it sits at the current
        // path position and selects its child by the request's HTTP method
        // (case-insensitive). Absent method (non-HTTP transport) → defaultVerb.
        const verbs = node.verbs as Record<string, AnyNode>
        const requested = req.method?.toUpperCase()
        const verb = requested ?? node.defaultVerb
        const child = verbs[verb]
        if (child === undefined) {
          return {
            kind: 'unary',
            result: {
              ok: false,
              error: {
                code: 'method_not_allowed',
                message: `${verb} not allowed for /${segments.join('/')}`,
                allow: Object.keys(verbs),
              },
            },
          }
        }
        // Verb selected; descend into the handler at the SAME path position.
        return descend(child, segments, req, caps)
      }
      case 'annotated': {
        const kind = node.annotation.kind
        // Grant ONLY this capability's handle, then enforce its gate.
        const granted: Record<string, unknown> = { ...caps }
        const grant = grants[kind]
        if (grant) Object.assign(granted, grant(req))
        const cap = node.annotation.value as
          | { enforce?: (c: Record<string, unknown>, s?: AbortSignal) => { ok: true } | { ok: false; error: unknown } }
          | undefined
        if (cap && typeof cap.enforce === 'function') {
          const verdict = cap.enforce(granted, req.signal)
          if (!verdict.ok) return { kind: 'unary', result: { ok: false, error: verdict.error } }
        }
        return descend(node.child, segments, req, granted)
      }
      case 'leaf':
      case 'seq': {
        // Reached a callable node: hand the run to core. The accumulated caps
        // and the request signal form the Context core threads through.
        const ctx: Context = req.signal ? { caps, signal: req.signal } : { caps }
        if (isStreamMode(node)) {
          // evaluateStream returns the AsyncIterable synchronously; the
          // generator body does not run until first pulled, so cancellation
          // before iteration is still honored.
          return { kind: 'stream', stream: evaluateStream(node, req.input, ctx) }
        }
        return { kind: 'unary', result: await evaluate(node, req.input, ctx) }
      }
    }
  }

  /**
   * Dispatch one decoded request. The returned outcome is `unary` (the single
   * Result) or `stream` (an AsyncIterable of Results); the adapter frames it.
   */
  return (req: DispatchRequest<Raw>): Promise<DispatchOutcome> => descend(tree, req.path, req, {})
}

// ── Client side: clientOver ───────────────────────────────────────────────────

/**
 * Build a runtime client over a node tree, routing every call through a
 * {@link Transport}. This is the generalization of core's in-process `client`
 * and http's bespoke fetch Proxy: the traversal is identical; only the leaf
 * call differs, and that difference is exactly the Transport.
 *
 *   branch         → nested object of clients (one per child key); each level
 *                    appends one path segment
 *   streaming leaf → (input, meta?) => transport.stream(path, input, meta)
 *                    — ERRORS EXPLICITLY if the transport lacks `stream?`
 *   unary leaf/seq → (input, meta?) => transport.invoke(path, input, meta)
 *
 * Exactly ONE boundary cast bridges the dynamic Proxy to the derived
 * `UClient<N>` type.
 */
export const clientOver = <N extends AnyNode>(node: N, transport: Transport): UClient<N> => {
  // Build the callable for a node at `path`, optionally issuing a specific HTTP
  // `verb` (set when the node sits under a `methods` parent; undefined for plain
  // leaves, which keep the POST-only back-compat path).
  const callableFor = (current: AnyNode, path: readonly string[], verb?: string): unknown => {
    if (isStreamMode(current)) {
      return (input: unknown, meta?: Meta): AsyncIterable<Result<unknown, unknown>> => {
        if (typeof transport.stream !== 'function') {
          throw new Error(
            `transport cannot carry a stream: leaf /${path.join('/')} is streaming but the transport provides no stream()`,
          )
        }
        return transport.stream(path, input, meta, verb)
      }
    }
    return (input: unknown, meta?: Meta): Promise<Result<unknown, unknown>> =>
      transport.invoke(path, input, meta, verb)
  }

  const build = (current: AnyNode, path: readonly string[]): unknown => {
    if (current.tag === 'branch') {
      const children = current.children as Record<string, AnyNode>
      return new Proxy(
        {},
        {
          get: (_t, prop: string | symbol) => {
            if (typeof prop !== 'string' || !(prop in children)) return undefined
            const child = children[prop]
            return child === undefined ? undefined : build(child, [...path, prop])
          },
          has: (_t, prop) => typeof prop === 'string' && prop in children,
          ownKeys: () => Object.keys(children),
          getOwnPropertyDescriptor: (_t, prop) =>
            typeof prop === 'string' && prop in children
              ? { enumerable: true, configurable: true }
              : undefined,
        },
      )
    }
    if (current.tag === 'methods') {
      // A methods node exposes its verbs as LOWERCASED keys; each is a callable
      // at the SAME path (no segment appended) that issues its verb. The runtime
      // verb map is keyed by uppercase canonical verbs.
      const verbs = current.verbs as Record<string, AnyNode>
      const lowerKeys = Object.keys(verbs).map((v) => v.toLowerCase())
      return new Proxy(
        {},
        {
          get: (_t, prop: string | symbol) => {
            if (typeof prop !== 'string') return undefined
            const upper = prop.toUpperCase()
            const child = verbs[upper]
            return child === undefined ? undefined : callableFor(child, path, upper)
          },
          has: (_t, prop) => typeof prop === 'string' && prop.toUpperCase() in verbs,
          ownKeys: () => lowerKeys,
          getOwnPropertyDescriptor: (_t, prop) =>
            typeof prop === 'string' && prop.toUpperCase() in verbs
              ? { enumerable: true, configurable: true }
              : undefined,
        },
      )
    }
    return callableFor(current, path)
  }
  // ONE boundary cast: the dynamically-built structure conforms to UClient<N>.
  return build(node, []) as UClient<N>
}

// Re-export the derived client types so adapters can name them without reaching
// past rpc-dispatch into core.
export type { UClient, Meta }
export type { InputOf, OutputOf, ErrorOf, ModeOf, Branch }

// ── Transport axes: channel × codec × protocol ────────────────────────────────
// A transport factors into three orthogonal, composable axes. `compose` (client)
// and `attach` (server) assemble them into the `Transport`/dispatcher surface
// above. Each per-axis package picks one value per axis:
//
//   channel  (medium)   : Channel<W> — moves encoded wire units, owns framing
//   codec    (encoding) : Codec<W>   — value ↔ wire unit (json / structured-clone)
//   protocol (semantics): Protocol   — call semantics (correlation / requestResponse)
//
// WS    = compose(wsChannel,    jsonCodec,            correlation)
// stdio = compose(stdioChannel, jsonCodec,            correlation)
// worker= compose(portChannel,  structuredCloneCodec, correlation)
// http  = composeRequestResponse(httpExchange, jsonCodec)
//
// The kernel exports ONLY the interfaces + assemblers; concrete instances ship
// in the per-axis packages named in the file header.
export type { Channel, MessageStream } from './channel.ts'
export type { Codec } from './codec.ts'
export {
  compose,
  attach,
  composeRequestResponse,
  serveExchange,
  type Protocol,
  type Exchange,
  type ExchangeResponse,
  type EncodedRequest,
  type EncodedOutcome,
} from './protocol.ts'
