// spike/composable/http.ts — dispatch projection (surface #1).
//
// toHandler(router): (Request) => Promise<Response>. Walks the FLAT route
// structs: linear match on segments + method, binds params (running any param
// codec), calls the handler. 405 + Allow on method-mismatch, 404 on no match.
//
// This file is the ONLY http/Bun-aware code in the model. The core (router.ts)
// imports nothing http/runtime. The handler is the opaque leaf; segments,
// method, and schema are all data this projection walks.

import type { AnyRoute, Segment, Method } from "./router"

// --- json helper: handlers return data; we render it. A phantom `__body`
// lets the typed client recover the domain type from a Response-shaped return.
export interface Json<T> {
  readonly status: number
  readonly body: T
  readonly __body?: T
}

export function json<const T>(body: T, status = 200): Json<T> {
  return { status, body }
}

// --- match one route's segment structs against the request path segments ----
function matchSegments(
  pattern: readonly Segment[],
  segs: string[],
): Record<string, string> | null {
  if (pattern.length !== segs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!
    const s = segs[i]!
    if (p.kind === "lit") {
      if (p.value !== s) return null
    } else {
      // param: optionally decode via codec (Standard-Schema over the raw string)
      if (p.codec !== undefined) {
        const r = p.codec["~standard"].validate(s)
        if (r.issues !== undefined) return null
        params[p.name] = r.value as string
      } else {
        params[p.name] = s
      }
    }
  }
  return params
}

/** Project the flat route data into a Request→Response dispatcher. */
export function toHandler(router: readonly AnyRoute[]): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const segs = url.pathname.split("/").filter((s) => s.length > 0)
    const method = req.method.toUpperCase() as Method

    const allow = new Set<string>()
    for (const r of router) {
      const params = matchSegments(r.pattern, segs)
      if (params === null) continue
      // path matched — record method for a possible 405/Allow
      allow.add(r.method)
      if (r.method !== method) continue

      // body: validate if a schema is present
      let body: unknown = undefined
      if (r.schema !== undefined) {
        const raw = await req.json().catch(() => undefined)
        const res = r.schema["~standard"].validate(raw)
        if (res.issues !== undefined) {
          return Response.json({ error: "VALIDATION", issues: res.issues }, { status: 422 })
        }
        body = res.value
      }

      // r.handler is bound to `(ctx: never) => unknown` by the AnyRoute element
      // bound; at runtime we invoke it with the bound ctx. The cast is confined
      // to this internal projection — it is NOT in any public path/param/route/
      // client TYPE (those stay cast-free).
      const call = r.handler as (ctx: {
        params: Record<string, string>
        body: unknown
        request: Request
      }) => unknown
      const out = await call({ params, body, request: req })
      // render: a Json<T> → Response; anything else passed through as JSON 200
      if (isJson(out)) return Response.json(out.body as object, { status: out.status })
      return Response.json(out as object, { status: 200 })
    }

    if (allow.size > 0) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: [...allow].sort().join(", ") },
      })
    }
    return new Response("Not Found", { status: 404 })
  }
}

function isJson(v: unknown): v is Json<unknown> {
  return typeof v === "object" && v !== null && "status" in v && "body" in v
}
