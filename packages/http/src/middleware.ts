// packages/http/src/middleware.ts — @rhi-zone/fractal-http/middleware
//
// A small composable middleware stdlib. EVERY export here is an ORDINARY
// `HttpMiddleware` value — the exact same shape user-written middleware has, and
// composed through the exact same `.use(...)` / `.mount(...)`. There is NO
// special mechanism, NO preset/DSL, NO framework hook. `cors()` returns a
// Middleware; so does `bearerAuth()`. They are indistinguishable in kind from a
// hand-written middleware. This keeps the core free of these (they live in the
// HTTP surface because cors/bearerAuth/etag are HTTP-specific) while shrinking
// the assembly burden that made get-started feel heavy.
//
// Runtime-agnostic: imports NO Bun, NO Node — only WHATWG Request/Response (the
// HTTP surface's substrate).

import type { NoVars } from "@rhi-zone/fractal-core"
import { json, type HttpMiddleware } from "./index.ts"

// ============================================================================
// cors — adds CORS headers; short-circuits OPTIONS preflight
// ============================================================================

export interface CorsOptions {
  /** Allowed origin(s). A string, a list, or "*" (default "*"). */
  readonly origin?: string | string[]
  /** Allowed methods (default GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS). */
  readonly methods?: string[]
  /** Allowed request headers (default "Content-Type,Authorization"). */
  readonly headers?: string[]
  /** Whether to send Access-Control-Allow-Credentials: true. */
  readonly credentials?: boolean
  /** Access-Control-Max-Age in seconds for preflight caching. */
  readonly maxAge?: number
}

function resolveOrigin(opt: string | string[] | undefined, reqOrigin: string | null): string {
  if (opt === undefined || opt === "*") return "*"
  if (typeof opt === "string") return opt
  if (reqOrigin !== null && opt.includes(reqOrigin)) return reqOrigin
  return opt[0] ?? "*"
}

/** CORS as a plain Middleware. Adds Access-Control-* headers to every response
 *  and answers an OPTIONS preflight with 204 directly. */
export function cors(opts: CorsOptions = {}): HttpMiddleware<NoVars, NoVars> {
  const methods = (opts.methods ?? ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"]).join(", ")
  const headers = (opts.headers ?? ["Content-Type", "Authorization"]).join(", ")
  return async (ctx, next) => {
    const origin = resolveOrigin(opts.origin, ctx.headers.get("origin"))
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": headers,
    }
    if (opts.credentials === true) corsHeaders["Access-Control-Allow-Credentials"] = "true"
    if (opts.maxAge !== undefined) corsHeaders["Access-Control-Max-Age"] = String(opts.maxAge)

    // Preflight: short-circuit with 204 + headers, never reaching a handler.
    if (ctx.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const res = await next(ctx)
    const merged = new Headers(res.headers)
    for (const [k, v] of Object.entries(corsHeaders)) merged.set(k, v)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged })
  }
}

// ============================================================================
// logger — logs method, path, status, and elapsed ms
// ============================================================================

/** A logger Middleware. Calls `sink` (default console.log) after the handler. */
export function logger(
  sink: (line: string) => void = (line) => console.log(line),
): HttpMiddleware<NoVars, NoVars> {
  return async (ctx, next) => {
    const start = Date.now()
    const path = "/" + ctx.segments.join("/")
    const res = await next(ctx)
    sink(`${ctx.method} ${path} ${res.status} ${Date.now() - start}ms`)
    return res
  }
}

// ============================================================================
// bearerAuth — verifies a Bearer token; sets a typed context var
// ============================================================================

export interface BearerVars<Principal> extends Record<string, unknown> {
  readonly auth: Principal
}

export interface BearerOptions<Principal> {
  /** Verify the raw token; return a principal (typed into ctx.vars.auth) or
   *  null to reject with 401. May be async. */
  readonly verify: (token: string) => Principal | null | Promise<Principal | null>
}

/** Bearer-token auth as a plain Middleware. On success it threads a typed
 *  `auth` principal into ctx.vars (handlers read `ctx.vars.auth` with NO cast);
 *  on failure it returns 401. Same shape as any user middleware. */
export function bearerAuth<Principal>(
  opts: BearerOptions<Principal>,
): HttpMiddleware<NoVars, BearerVars<Principal>> {
  return async (ctx, next) => {
    const header = ctx.headers.get("authorization")
    const token = header !== null && header.startsWith("Bearer ") ? header.slice(7) : null
    if (token === null) return json({ error: "Unauthorized" }, 401)
    const principal = await opts.verify(token)
    if (principal === null) return json({ error: "Unauthorized" }, 401)
    return next({ ...ctx, vars: { ...ctx.vars, auth: principal } })
  }
}

// ============================================================================
// etag — adds a weak ETag from the body; answers If-None-Match with 304
// ============================================================================

// FNV-1a 32-bit — small, dependency-free, good enough for an entity tag.
function fnv1a(input: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of input) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** ETag as a plain Middleware. Hashes the response body into a weak ETag; if it
 *  matches the request's If-None-Match, returns 304 with an empty body. */
export function etag(): HttpMiddleware<NoVars, NoVars> {
  return async (ctx, next) => {
    const res = await next(ctx)
    // Only tag bodied 2xx responses.
    if (res.status < 200 || res.status >= 300) return res
    const buf = new Uint8Array(await res.clone().arrayBuffer())
    if (buf.length === 0) return res
    const tag = `W/"${fnv1a(buf)}"`
    const inm = ctx.headers.get("if-none-match")
    const headers = new Headers(res.headers)
    headers.set("ETag", tag)
    if (inm === tag) return new Response(null, { status: 304, headers })
    return new Response(buf, { status: res.status, statusText: res.statusText, headers })
  }
}
