# @rhi-zone/fractal-http-framework-projector

Idiomatic router codegen for existing HTTP frameworks — Express first — from
the function-core tree's `HttpRoute`.

## What it does

Where `@rhi-zone/fractal-http-api-projector` is fractal's own working HTTP
framework/runtime (a compiled matcher your process serves directly), this
package generates source code for frameworks *other than* fractal's own:
a real `express.Router()` your existing (or new) Express app mounts like any
hand-written router. It's an **eject** tool, not a runtime dependency — the
generated file is written once, has no drift-detection or watch loop, and is
meant to be committed and hand-edited like any other file in your project.
See `docs/design/framework-router-codegen.md` for the full set of settled
decisions this package implements (package boundary, eject model, framework
scope/priority, and why Express gets no generated validator call).

Target frameworks are added one at a time, most-popular-first (see the
design doc's priority list) — Express is the first and, as of this writing,
only target.

## Key exports

- `generateExpressRouter(route, schemas?, options?)` (`./express`) — walks an already-projected `HttpRoute` tree, returns Express router source text
- `generateExpressRouterFromNode(node, schemas?, options?)` — convenience wrapper: projects `node` via `httpProjection` and recovers authored member names

## Usage

```ts
import { extractToolSchemas } from "@rhi-zone/fractal-api-tree/tree"
import { generateExpressRouterFromNode } from "@rhi-zone/fractal-http-framework-projector"
import { api } from "./tree.ts"

const schemas = extractToolSchemas("./tree.ts")
const source = generateExpressRouterFromNode(api, schemas, { routerName: "Books" })
// write `source` to disk, e.g. src/books.router.ts
```

The generated file exports a `create<RouterName>Router(handlers)` factory.
`handlers` is a plain nested object mirroring the tree's shape, each leaf
typed as fractal's own `Handler<I, O>` — the same handler functions already
wired into your `api()`/`op()` tree can be passed straight in:

```ts
// src/books.router.ts (generated, then committed)
import { createBooksRouter } from "./books.router.ts"
import { listBooks, createBook, getBook } from "./tree.ts"

const router = createBooksRouter({
  books: { list: listBooks, create: createBook, bookId: { get: getBook } },
})

app.use(router) // mount into an existing Express app
```

## Known simplifications (v1)

- **No generated validation.** Express has no single dominant validation
  convention to target (unlike Hono's `zValidator` or Elysia's `t.Object`) —
  see the design doc. `<Base>Input`/`<Base>Output` type aliases are still
  emitted for compile-time DX.
- **No path-param coercion.** `req.params`/`req.query` values are always
  strings; a `number`-typed path param is not parsed to a number.
- **No custom status codes.** Every response is `res.json(result ?? null)`
  at the implicit default 200, mirroring `http-api-projector`'s own
  `defaultEncode`. Status codes set via `meta.http.response` are not
  reflected.
- **Requires your own body-parsing middleware** (e.g.
  `app.use(express.json())`) for POST/PUT/PATCH — this router doesn't add
  its own, since it may be mounted inside a larger app that already
  configures one.

All of these are eject-model tradeoffs, not permanent limits: the generated
file is plain, hand-editable TypeScript.

## Install

```bash
bun add @rhi-zone/fractal-http-framework-projector
```

See the [root README](../../README.md) for the full picture across all projections.
