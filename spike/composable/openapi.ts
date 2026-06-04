// spike/composable/openapi.ts — OpenAPI projection (surface #3).
//
// toOpenApi(router) → an OpenAPI 3.1 document. Pure structural projection from
// the FLAT route data: segments → path template "/users/{id}", method → an
// operation, param segments → parameters, schema → requestBody. No closures are
// inspected — only the inert data (pattern / method / schema).

import type { AnyRoute, Segment, ParamSegment } from "./router"

interface OpenApiParam {
  name: string
  in: "path"
  required: true
  schema: { type: "string" }
}
interface OpenApiOp {
  parameters?: OpenApiParam[]
  requestBody?: {
    required: true
    content: { "application/json": { schema: { type: "object" } } }
  }
  responses: { "200": { description: string } }
}
interface OpenApiDoc {
  openapi: "3.1.0"
  info: { title: string; version: string }
  paths: Record<string, Record<string, OpenApiOp>>
}

/** template path: lit→/users, param→/{id}. */
function templateOf(pattern: readonly Segment[]): string {
  let p = ""
  for (const s of pattern)
    p += s.kind === "lit" ? `/${s.value}` : `/{${(s as ParamSegment).name}}`
  return p
}

function paramsOf(pattern: readonly Segment[]): OpenApiParam[] {
  const out: OpenApiParam[] = []
  for (const s of pattern) {
    if (s.kind === "param") {
      out.push({ name: s.name, in: "path", required: true, schema: { type: "string" } })
    }
  }
  return out
}

export function toOpenApi(
  router: readonly AnyRoute[],
  info: { title: string; version: string } = { title: "fractal", version: "0.0.0" },
): OpenApiDoc {
  const paths: Record<string, Record<string, OpenApiOp>> = {}
  for (const r of router) {
    const tmpl = templateOf(r.pattern)
    const op: OpenApiOp = { responses: { "200": { description: "OK" } } }
    const ps = paramsOf(r.pattern)
    if (ps.length > 0) op.parameters = ps
    if (r.schema !== undefined) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      }
    }
    ;(paths[tmpl] ??= {})[r.method.toLowerCase()] = op
  }
  return { openapi: "3.1.0", info, paths }
}
