# @rhi-zone/fractal-http

WHATWG (`Request`/`Response`) renderer for the function-core `Node` tree.

## What it does

Turns an `api()`/`op()` tree into an HTTP router. A rewriter pipeline
(`naiveTransform` + `applyMethods`/`applyMoveTo`/`applyResponse`) derives
each leaf's HTTP verb and path from its tags/directives, producing an
`HttpRoute` tree that a compiled matcher (radix or char-based) dispatches
against. Ships DX sugar (`crud()`, `httpProjection()`, the `http.*` verb
bundles), CORS/auto-method layers, and `createFetch`/`serveBun`/`serveNode`
adapters to run the result as a real server.

## Key exports

- `http` — verb-helper bundles (`http.get`, `http.post`, `http.put`, ...), each bundling a verb directive with implied tags
- `crud(handlers)` — convention constructor for the 5-op REST-resource shape
- `httpProjection(tree, opts?)` — one-call `Node => HttpRoute` with the standard rewriter pipeline
- `mapRoute`, `fusePipeline`, `skipEmptyInput`, `createApplyValidation` — route-tree rewriters (`./route`)
- `toRouter`, `radixRouter`, `compiledCharRouter`, `withALS` — compiled matchers (`./compile`)
- `./adapter` — `createFetch`, `serveBun`, `serveNode`
- `./preset` — configurable out-of-the-box `createFetch` preset
- `./project` — direct tree-walk `makeRouter`, `verbFromTags`, layers (`autoMethodLayer`, `corsLayer`)

## Usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { http } from "@rhi-zone/fractal-http/verbs"
import { httpProjection } from "@rhi-zone/fractal-http/dx"
import { createFetch } from "@rhi-zone/fractal-http/preset"

const tree = api({
  books: api({
    list: op(() => [], http.get),
  }),
})

const fetch = createFetch(tree)
const res = await fetch(new Request("http://localhost/books/list"))
```
