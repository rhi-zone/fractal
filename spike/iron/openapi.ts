// spike/iron/openapi.ts — OpenAPI projection. Walks the `.meta` DATA tree.
//
// toOpenApi(app) → an OpenAPI 3.1 document. Pure structural projection from the
// meta tree: a route's `segs` → path template "/users/{id}", EndMeta → an
// operation, param segments → path parameters, EndMeta.hasBody → requestBody,
// PrefixMeta → a mounted prefix. No closures inspected — only the inert meta
// DATA. References only `Handler` + the meta DATA-descriptor shapes.

import type { Handler } from "./core.ts"
import type {
  Ctx,
  Reply,
  ParamMeta,
  LitMeta,
  EndMeta,
  ChoiceMeta,
  PrefixMeta,
} from "./http.ts"

interface OpenApiParam {
  name: string
  in: "path"
  required: true
  schema: { type: "string" }
}
interface OpenApiOp {
  parameters?: OpenApiParam[]
  requestBody?: { required: true; content: { "application/json": { schema: { type: "object" } } } }
  responses: { "200": { description: string } }
}
interface OpenApiDoc {
  openapi: "3.1.0"
  info: { title: string; version: string }
  paths: Record<string, Record<string, OpenApiOp>>
}

export function toOpenApi(
  app: Handler<Ctx<unknown>, Reply | null, unknown>,
  info: { title: string; version: string } = { title: "fractal", version: "0.0.0" },
): OpenApiDoc {
  const paths: Record<string, Record<string, OpenApiOp>> = {}
  walk(app.meta, "", paths)
  return { openapi: "3.1.0", info, paths }
}

function walk(
  meta: unknown,
  pre: string,
  paths: Record<string, Record<string, OpenApiOp>>,
): void {
  if (typeof meta !== "object" || meta === null) return
  const m = meta as { tag?: string }
  if (m.tag === "end") {
    const end = meta as EndMeta<
      readonly (LitMeta<string> | ParamMeta<string, unknown>)[],
      string,
      unknown,
      unknown
    >
    let key = pre
    const params: OpenApiParam[] = []
    for (const s of end.segs) {
      if (s.tag === "lit") key += `/${s.value}`
      else {
        key += `/{${s.name}}`
        params.push({ name: s.name, in: "path", required: true, schema: { type: "string" } })
      }
    }
    if (key === "") key = "/"
    const op: OpenApiOp = { responses: { "200": { description: "OK" } } }
    if (params.length > 0) op.parameters = params
    if (end.hasBody) {
      op.requestBody = { required: true, content: { "application/json": { schema: { type: "object" } } } }
    }
    ;(paths[key] ??= {})[end.method.toLowerCase()] = op
    return
  }
  if (m.tag === "prefix") {
    const pm = meta as PrefixMeta<readonly string[], unknown>
    walk(pm.rest, pre + pm.pre.map((s) => `/${s}`).join(""), paths)
    return
  }
  if (m.tag === "choice") {
    for (const alt of (meta as ChoiceMeta<readonly unknown[]>).alts) walk(alt, pre, paths)
  }
}
