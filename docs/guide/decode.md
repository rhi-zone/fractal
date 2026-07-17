# Decoding requests: the stores model

`@rhi-zone/fractal-http` turns an incoming `Request` into the flat input
object a handler expects via a **stores-based decode system**
(`packages/http/src/decode.ts`, wired into the pipeline in
`packages/http/src/route.ts`). This guide covers how to use it; see the
source files for the exact mechanics.

---

## 1. The stores model

A `Store` is a uniform key-value interface over one input source:

```ts
interface Store {
  get(key: string): unknown
}
```

`httpStores(req, slugs, parsedBody)` builds the four standard stores for a
request:

| store    | source                                    |
| -------- | ------------------------------------------ |
| `path`   | route slugs (dynamic path segments)        |
| `query`  | URL query string                            |
| `header` | request headers                             |
| `body`   | the pre-parsed JSON body                    |

The body is parsed once, upstream, and handed in — the stores factory itself
stays synchronous and never re-parses.

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

Sometimes a param needs to come from somewhere other than its method's
primary store — the textbook case is an API key read from a header on an
otherwise query/body-driven route:

```ts
const pipeline: Pipeline = {
  sources: {
    sourceMap: {
      apiKey: { store: "header", key: "x-api-key" },
    },
  },
}
```

`ParamSource.key` defaults to the param name when omitted, so
`{ store: "header" }` alone reads the header named exactly like the param.

Only params listed in `sourceMap` diverge from the convention — everything
else still follows the primary-store rule.

---

## 4. Explicit param lists — `sources.paramNames`

By default (see §5), decode bulk-collects everything it can find. Providing
`paramNames` switches to **declarative** mode: the assembler reads exactly
those names, nothing more, each via the resolution order:

```ts
const pipeline: Pipeline = {
  sources: {
    paramNames: ["bookId", "q", "apiKey"],
    sourceMap: {
      apiKey: { store: "header", key: "x-api-key" },
    },
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

## 5. Bulk-collect fallback

When `paramNames` is absent (or empty), decode falls back to `bulkCollect`:
it merges all path slugs, all query params, and (for body-primary methods)
all body fields into one flat bag — this is the pre-stores `defaultDecode`
behavior, preserved for backward compatibility so existing handlers that
don't declare a param list keep working unchanged.

Note the bulk-collect quirk carried over from the old behavior: query params
are merged in regardless of method, even when body is the primary store —
useful for things like `?debug=1` alongside a JSON POST body.

---

## 6. The transform escape hatch — `sources.transform`

After the bag is assembled (by either path above), `sources.transform` gets
one last pass to reshape it before the handler sees it:

```ts
const pipeline: Pipeline = {
  sources: {
    paramNames: ["tags"],
    transform: (bag) => ({
      ...bag,
      tags: typeof bag.tags === "string" ? bag.tags.split(",") : bag.tags,
    }),
  },
}
```

`paramNames`, `sourceMap`, and `transform` all live together under the same
`sources` object. Use `transform` for coercions the assembler itself doesn't
do — splitting a comma-separated query value into an array, parsing a
numeric string, defaulting an absent field.

---

## 7. Overriding the whole system — `Pipeline.decode`

`Pipeline.decode` is a full escape hatch: when set, the stores system is
bypassed entirely and `decode(req, meta)` is solely responsible for
producing the handler's input.

```ts
const pipeline: Pipeline = {
  decode: async (req, meta) => {
    const body = await req.json()
    return { ...body, requestId: crypto.randomUUID() }
  },
}
```

`sources` is ignored whenever `decode` is present — the function always
wins. This keeps existing hand-written `decode` pipelines working unchanged
alongside the newer declarative `sources` config; migrate to `sources` only
when convenient, not as a requirement.

---

## Summary

- Stores (`path`/`query`/`header`/`body`) are the uniform read surface over a
  request.
- Method implies a primary store for non-path params (query for
  GET/HEAD/DELETE, body otherwise).
- `sources.sourceMap` overrides individual params to a different
  store/key.
- `sources.paramNames` switches from bulk-collect to an explicit, declarative
  param list — the mode codegen is expected to drive.
- `sources.transform` reshapes the assembled bag as a final step.
- `Pipeline.decode` bypasses stores entirely for full manual control.
