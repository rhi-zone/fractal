// spike/iron/run.ts — runnable proof (bun run run.ts). Exercises the sample
// 3 endpoints through the dispatcher, the in-process typed client (with a
// parity assert: client result === server result), and the OpenAPI projection.

import { app } from "./sample.ts"
import { toHandler } from "./http.ts"
import { client } from "./client.ts"
import { toOpenApi } from "./openapi.ts"

declare const process: { exitCode?: number }

const dispatch = toHandler(app)

function ok(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) process.exitCode = 1
}

const log: string[] = []
function line(s: string) {
  log.push(s)
  console.log(s)
}

async function main() {
  line("=== 1. dispatch the 3 endpoints (server-side) ===")

  // (a) GET /users/1 → 200 user
  const a = await dispatch(new Request("http://x/users/1"))
  const aBody = await a.json()
  line(`(a) GET /users/1 -> ${a.status} ${JSON.stringify(aBody)}`)
  ok("(a) 200 + user", a.status === 200 && aBody.id === "1")

  // (a') GET /users/999 → 404
  const a2 = await dispatch(new Request("http://x/users/999"))
  line(`(a') GET /users/999 -> ${a2.status} ${JSON.stringify(await a2.json())}`)
  ok("(a') 404 unknown user", a2.status === 404)

  // (b) POST /users → 201
  const b = await dispatch(
    new Request("http://x/users", {
      method: "POST",
      body: JSON.stringify({ name: "Grace", email: "g@x" }),
      headers: { "content-type": "application/json" },
    }),
  )
  const bBody = await b.json()
  line(`(b) POST /users -> ${b.status} ${JSON.stringify(bBody)}`)
  ok("(b) 201 created", b.status === 201 && bBody.name === "Grace")

  // (c) POST /users/1/deactivate → 200
  const c1 = await dispatch(new Request("http://x/users/1/deactivate", { method: "POST" }))
  line(`(c) POST /users/1/deactivate -> ${c1.status} ${JSON.stringify(await c1.json())}`)
  ok("(c) 200 deactivate existing", c1.status === 200)

  // (c') POST /users/999/deactivate → 404 (policy)
  const c2 = await dispatch(new Request("http://x/users/999/deactivate", { method: "POST" }))
  line(`(c') POST /users/999/deactivate -> ${c2.status} ${JSON.stringify(await c2.json())}`)
  ok("(c') 404 deactivate missing", c2.status === 404)

  // 405 + Allow: DELETE on a matched path
  const m = await dispatch(new Request("http://x/users/1", { method: "DELETE" }))
  line(`405 probe: DELETE /users/1 -> ${m.status} Allow=${m.headers.get("Allow")}`)
  ok("405 + Allow on method mismatch", m.status === 405 && (m.headers.get("Allow") ?? "").includes("GET"))

  // auto-HEAD from GET
  const h = await dispatch(new Request("http://x/users/1", { method: "HEAD" }))
  const hText = await h.text()
  line(`auto-HEAD: HEAD /users/1 -> ${h.status} bodyLen=${hText.length}`)
  ok("auto-HEAD: 200 + empty body", h.status === 200 && hText.length === 0)

  line("")
  line("=== 2. in-process typed client + parity assert ===")
  const api = client(app)
  const viaClient = await api["/users/{id}"].get({ params: { id: "1" } })
  const viaServer = await (await dispatch(new Request("http://x/users/1"))).json()
  line(`client /users/{id}.get({id:1}) -> ${JSON.stringify(viaClient)}`)
  ok("client === server parity", JSON.stringify(viaClient) === JSON.stringify(viaServer))

  line("")
  line("=== 3. OpenAPI projection (walks .meta) ===")
  const spec = toOpenApi(app, { title: "sample", version: "1.0.0" })
  line(JSON.stringify(spec, null, 2))
  ok("openapi has /users/{id} GET", spec.paths["/users/{id}"]?.get !== undefined)
  ok("openapi has /users POST requestBody", spec.paths["/users"]?.post?.requestBody !== undefined)
  ok(
    "openapi has /users/{id}/deactivate POST",
    spec.paths["/users/{id}/deactivate"]?.post !== undefined,
  )
}

await main()
