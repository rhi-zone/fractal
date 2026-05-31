// @rhi-zone/fractal-http
// HTTP server interpreter. Transport lives ONLY here; leaves stay (input, ctx) => Result.
//
// The interpreter walks the reflectable node union:
//   branch     → path segments (one segment per child key)
//   annotated  → grant ONLY that capability's handle into ctx.caps + enforce its gate
//   leaf       → call `run`
//   seq        → thread left.output into right.input (short-circuit on error)
// and maps the resulting Result to an HTTP status.

import type { AnyNode, Context, Result } from '@rhi-zone/fractal-core'

/** A function that produces the pre-opened handle for one capability `kind`. */
export type CapGrant = (req: HttpRequestLike) => Record<string, unknown>

/** Minimal request shape the interpreter reads — framework-agnostic. */
export interface HttpRequestLike {
  readonly method: string
  /** Path already split into non-empty segments, e.g. ['users', '42']. */
  readonly segments: readonly string[]
  /** Parsed request body (JSON) used as the leaf input. */
  readonly body: unknown
  readonly signal?: AbortSignal
}

/** What the interpreter returns; a framework adapter writes this to the wire. */
export interface HttpResponseLike {
  readonly status: number
  readonly body: unknown
}

/** Options: a registry mapping capability `kind` → handle grantor. */
export interface ServeOptions {
  /** Grants keyed by capability kind. Only the matched capability's handle is injected. */
  readonly grants?: Readonly<Record<string, CapGrant>>
  /** Map a domain error to an HTTP status. Defaults to 400; auth → 401, rate → 429. */
  readonly errorStatus?: (error: unknown) => number
}

const defaultErrorStatus = (error: unknown): number => {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'unauthorized') return 401
  if (code === 'rate_limited') return 429
  if (code === 'invalid') return 422
  if (code === 'not_callable') return 404
  return 400
}

// We re-implement the walk here (rather than reuse core.evaluate) because the
// HTTP interpreter must (a) consume path segments at branches and (b) grant
// capability handles incrementally as it descends annotations.
const walk = async (
  node: AnyNode,
  segments: readonly string[],
  req: HttpRequestLike,
  caps: Record<string, unknown>,
  grants: Readonly<Record<string, CapGrant>>,
): Promise<Result<unknown, unknown>> => {
  switch (node.tag) {
    case 'branch': {
      const [head, ...rest] = segments
      const children = node.children as Record<string, AnyNode>
      if (head === undefined || !(head in children)) {
        return { ok: false, error: { code: 'not_callable', message: `no route for /${segments.join('/')}` } }
      }
      const child = children[head]
      if (child === undefined) {
        return { ok: false, error: { code: 'not_callable', message: head } }
      }
      return walk(child, rest, req, caps, grants)
    }
    case 'annotated': {
      const kind = node.annotation.kind
      // Grant ONLY this capability's handle (capability security: nothing else leaks in).
      const granted: Record<string, unknown> = { ...caps }
      const grant = grants[kind]
      if (grant) Object.assign(granted, grant(req))
      // Enforce the capability's own gate, if it carries one.
      const cap = node.annotation.value as
        | { enforce?: (c: Record<string, unknown>, s?: AbortSignal) => { ok: true } | { ok: false; error: unknown } }
        | undefined
      if (cap && typeof cap.enforce === 'function') {
        const verdict = cap.enforce(granted, req.signal)
        if (!verdict.ok) return { ok: false, error: verdict.error }
      }
      return walk(node.child, segments, req, granted, grants)
    }
    case 'seq': {
      // seq does not consume path segments; both stages see the remaining path.
      const left = await walk(node.left, segments, req, caps, grants)
      if (!left.ok) return left
      const ctx: Context = req.signal ? { caps, signal: req.signal } : { caps }
      return runFrom(node.right, left.value, ctx)
    }
    case 'leaf': {
      const ctx: Context = req.signal ? { caps, signal: req.signal } : { caps }
      return node.run(req.body, ctx)
    }
  }
}

// After a seq's left stage produces a value, the right stage runs as a pure
// data transform (no further path consumption) — capability grants already
// applied on the way down are carried in ctx.caps.
const runFrom = async (node: AnyNode, input: unknown, ctx: Context): Promise<Result<unknown, unknown>> => {
  switch (node.tag) {
    case 'leaf':
      return node.run(input, ctx)
    case 'seq': {
      const left = await runFrom(node.left, input, ctx)
      if (!left.ok) return left
      return runFrom(node.right, left.value, ctx)
    }
    case 'annotated': {
      const cap = node.annotation.value as
        | { enforce?: (c: Record<string, unknown>, s?: AbortSignal) => { ok: true } | { ok: false; error: unknown } }
        | undefined
      if (cap && typeof cap.enforce === 'function') {
        const verdict = cap.enforce(ctx.caps, ctx.signal)
        if (!verdict.ok) return { ok: false, error: verdict.error }
      }
      return runFrom(node.child, input, ctx)
    }
    case 'branch':
      return { ok: false, error: { code: 'not_callable', message: 'branch reached mid-seq' } }
  }
}

/**
 * Build an HTTP handler over a node tree. Returns a function from a parsed
 * request to a status + body. The tree's leaves never see transport; this
 * interpreter is the only place HTTP concepts (segments, status) appear.
 */
export const serve = (tree: AnyNode, options: ServeOptions = {}) => {
  const grants = options.grants ?? {}
  const errorStatus = options.errorStatus ?? defaultErrorStatus
  return async (req: HttpRequestLike): Promise<HttpResponseLike> => {
    const result = await walk(tree, req.segments, req, {}, grants)
    if (result.ok) return { status: 200, body: result.value }
    return { status: errorStatus(result.error), body: result.error }
  }
}
