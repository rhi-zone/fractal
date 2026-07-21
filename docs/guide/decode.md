# Decoding requests: the stores model

`@rhi-zone/fractal-http-api-projector` turns an incoming `Request` into the flat input
object a handler expects via a **stores-based decode system**
(`packages/http-api-projector/src/decode.ts`, wired into the pipeline in
`packages/http-api-projector/src/route.ts`). This guide covers how to use it; see the
source files for the exact mechanics.

---

## 1. The stores model

A `Store` is a uniform key-value interface over one input source:

```ts
interface Store {
  get(key: string): unknown
}
```

`httpStores(req, slugs, parsedBody)` builds the five standard stores for a
request:

| store    | source                                    |
| -------- | ------------------------------------------ |
| `path`   | route slugs (dynamic path segments)        |
| `query`  | URL query string                            |
| `header` | request headers                             |
| `body`   | the pre-parsed request body                 |
| `caller` | raw request headers, unparsed pass-through  |

The body is parsed once, upstream, via `parseRequestBody` — which WHATWG API
handles it depends on `Content-Type` (`application/json` → `req.json()`;
`multipart/form-data`/`application/x-www-form-urlencoded` → `req.formData()`,
flattened to a plain object; `text/plain` → `{ _text: await req.text() }`;
`application/octet-stream` → `{ _binary: await req.arrayBuffer() }`) — the
stores factory itself stays synchronous and never re-parses.

`caller` is a thin pass-through over the same request headers the `header`
store wraps — `caller.authorization`, `caller.cookie`, etc. — for reading raw
auth-related headers without going through a named param. Parsing what's
inside (decoding a JWT, splitting a cookie string) is the consumer's job, not
this store's; see `docs/design/middleware-and-caller-context.md`.

An **assembler** (`assemble`) then builds the handler's input bag by reading
named params out of these stores, one param at a time, following a
resolution order (below). This replaces reading everything positionally off
the raw `Request` — handlers declare *what* they need by name, and the
assembler figures out *where* each name comes from.

---

## 2. The convention: method → primary store

Every param that isn't a path slug has a **primary store**, chosen by HTTP
method (`primaryStoreForMethod`):

```
GET, HEAD, DELETE  → "query"   (params come from the URL query string)
POST, PUT, PATCH   → "body"    (params come from the parsed request body)
```

This is the default for any param without an explicit override. It means a
handler for `GET /books?q=foo` and one for `POST /books` with `{ "q": "foo" }`
in the body both just declare `q` as a param — the convention picks the
right store based on the method already on the route.

Path params are handled separately and always win: if a param name matches
one of the route's dynamic slug names, it's read from the `path` store
regardless of method.

---

## 3. Per-param source overrides — `sources.sourceMap`

`Sources` (`packages/http-api-projector/src/route.ts`) is the declarative
decode config: `{ sourceMap?, paramNames?, transform? }`. It attaches to one
method entry on the `HttpRoute` tree (`route.methods[verb].sources`) — set it
by constructing (or rewriting) `HttpRoute` values directly with `httpRoute()`;
there is no `meta`-level directive that wires it in through `op()`/`api()`
yet.

Sometimes a param needs to come from somewhere other than its method's
primary store — the textbook case is an API key read from a header on an
otherwise query/body-driven route:

```ts
const sources: Sources = {
  sourceMap: {
    apiKey: { store: "header", key: "x-api-key" },
  },
}
```

`ParamSource.key` defaults to the param name when omitted, so
`{ store: "header" }` alone reads the header named exactly like the param.

Only params listed in `sourceMap` diverge from the convention — everything
else still follows the primary-store rule.

---

## 4. Explicit param lists — `sources.paramNames`

By default (see §5), decode computes a param list from everything it can
find. Providing `paramNames` explicitly switches to **declarative** mode:
the assembler reads exactly those names, nothing more, each via the
resolution order:

```ts
const sources: Sources = {
  paramNames: ["bookId", "q", "apiKey"],
  sourceMap: {
    apiKey: { store: "header", key: "x-api-key" },
  },
}
```

Resolution order per param, in `assemble`:

1. Param name matches a route path slug → read from `path`.
2. Param has an entry in `sourceMap` → read from that store/key.
3. Otherwise → read from the primary store (method convention).

This is also the mode codegen-derived validators are expected to drive:
once a handler's input type is known statically, its param list can be
generated instead of hand-written.

---

## 5. Computed `paramNames` fallback

When `sources.paramNames` is absent (or empty), decode computes a param
list itself instead of running a separate merge codepath — the same
approach cli-api-projector's `buildInput` and mcp-api-projector's
`assembleInput` use: the union of every key any store could actually
produce (path slugs, query keys, body keys) plus any name declared purely
via `sourceMap`, then that list runs through the exact same `assemble` call
as the declarative path (§4's resolution order applies unchanged).

Because each param name resolves through exactly one store (path override,
`sourceMap` override, or the primary store), a query-only key on a
body-primary request only ends up in the bag if it's also reachable via
`sourceMap` or happens to collide with a path slug — there is no longer an
implicit "always merge query too" behavior for body-primary methods. Declare
an explicit `sourceMap` entry (`{ store: "query" }`) for any param that must
be readable from query regardless of method.

---

## 6. The transform escape hatch — `sources.transform`

After the bag is assembled (by either path above), `sources.transform` gets
one last pass to reshape it before the handler sees it:

```ts
const sources: Sources = {
  paramNames: ["tags"],
  transform: (bag) => ({
    ...bag,
    tags: typeof bag.tags === "string" ? bag.tags.split(",") : bag.tags,
  }),
}
```

`paramNames`, `sourceMap`, and `transform` all live together on the same
`Sources` object. Use `transform` for coercions the assembler itself doesn't
do — splitting a comma-separated query value into an array, parsing a
numeric string, defaulting an absent field.

There is no further escape hatch below `sources` — the per-route
`decode`/`encode` override that used to bypass the stores system entirely has
been removed (see `route.ts`'s module doc: "Dispatch ... is NOT an
interceptable multi-stage pipeline ... nothing in this codebase used those
hooks outside of tests exercising the mechanism itself"). Validation is
handled separately, one level down, by wrapping a leaf's handler directly —
see `docs/guide/codegen-cli.md`'s `wrapValidators` section.

---

## Summary

- Stores (`path`/`query`/`header`/`body`/`caller`) are the uniform read
  surface over a request.
- Method implies a primary store for non-path params (query for
  GET/HEAD/DELETE, body otherwise).
- `sources.sourceMap` overrides individual params to a different
  store/key.
- `sources.paramNames` switches from the computed param list to an explicit,
  declarative param list — the mode codegen is expected to drive.
- `sources.transform` reshapes the assembled bag as a final step.
- `sources` lives on an `HttpRoute` method entry, set via `httpRoute()` or a
  custom rewriter — there is no `meta`-level authoring surface for it yet,
  and no further escape hatch below it.
