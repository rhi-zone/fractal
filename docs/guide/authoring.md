# Authoring a fractal tree

A fractal tree is a value: a nested structure of `Node` objects where **tree
position is address**. You build it once, pass it to a projection (HTTP,
MCP, CLI), and each projection derives what it needs from the structure and
the open metadata bag.

All constructors live in `@rhi-zone/fractal-api-tree/node`. Verb-helper bundles
live in `@rhi-zone/fractal-http/verbs`.

---

## 1. Leaf nodes — `op(fn, ...contributions)`

`op` produces a leaf node: a `Node` with a `handler` and merged meta.

```ts
import { op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "@rhi-zone/fractal-http/verbs"

// Bare fn — empty meta, verb inferred from tags (defaults to POST)
const listBooks = op((_: unknown): Book[] => [...store.values()])

// Single meta contribution
const readBook = op(
  (input: { bookId: string }) => store.get(input.bookId),
  { tags: { readOnly: true } },
)

// Verb-helper bundle as contribution
const reserveBook = op(
  (input: { bookId: string; patronId: string }) => ({ reservationId: `res-${input.bookId}-${input.patronId}` }),
  http.put,
)
```

Multiple contributions deep-merge left-to-right via `mergeMeta` (later wins
per key; `undefined` defers — see [§6 Composition](#6-composition)):

```ts
// bundle's idempotent:true is preserved; extra destructive:false is applied
const n = op(fn, http.put, { tags: { destructive: false } })
```

The handler receives one **flat input object** — path slugs, query params,
and JSON body are all merged in provenance-blind. The handler cannot and need
not distinguish their origin.

---

## 2. Branch nodes — `node({ children, meta })`

`node` produces a branch node: a `Node` with children (and optional meta).
Children are `Node | ParamNode` values keyed by their **address segment name**.

```ts
import { node, op } from "@rhi-zone/fractal-api-tree/node"

const catalogNode = node({
  children: {
    search: op((input: { q?: string }) => /* … */),
    genres: op((input: { prefix?: string }) => /* … */),
  },
  // Node-level tag: all leaf descendants inherit readOnly via effectiveTags
  meta: { tags: { readOnly: true } },
})
```

A node may carry both `handler` and `children` (uncommon but valid). A leaf
stored as a child is just a node whose `handler` is defined — there is one
`Node` primitive.

---

## 3. Service class surface — `service(instance, opts?)`

`service` lowers a class instance to a branch `Node`:

- Each **method** → `children[name]` (leaf node, handler bound to instance)
- Each **`Node`-valued field** → `children[name]` (static mount)
- Each **`ParamNode`-valued field** → `children[name]` (slug mount)
- `opts.meta[name]` → meta bag for that child leaf

```ts
import { node, op, param, service } from "@rhi-zone/fractal-api-tree/node"

class BooksService {
  // ParamNode field: service() picks it up as a child
  byId = param("bookId", bookItemNode)

  list(_: unknown): Book[] {
    return [...store.values()]
  }

  add(input: { title: string; author: string; genre: string }): Book {
    const id = `book-${++_seq}`
    const book: Book = { id, ...input }
    store.set(id, book)
    return book
  }
}

const booksNode = service(new BooksService(), {
  meta: {
    list: { tags: { readOnly: true }, description: "List all books." },
    add:  { description: "Add a new book." },
  },
})
```

`service()` and `node()` produce the same `{handler?, children, meta}` value.
Both surfaces lower to the one `Node` primitive.

---

## 4. Parameterized children — `param(name, subtree)`

`param` creates a `ParamNode`: a typed slug mount that contributes `{name}` as
a path segment in the HTTP projection and merges the captured value into handler
inputs at dispatch time.

```ts
import { param } from "@rhi-zone/fractal-api-tree/node"

// bookId becomes the {bookId} segment; its runtime value flows into handler input
byId = param("bookId", bookItemNode)
```

When the HTTP projection walks `param("bookId", subtree)`, it contributes
`/{bookId}` to the path. At dispatch time, the actual segment value is merged
into handler input under `"bookId"` — provenance-blind (the handler just sees
`input.bookId`).

---

## 5. Tags (`meta.tags`) and what projections do with them

Tags are the open three-valued behavioral dictionary carried in `meta.tags`.
Three values: `true` (asserted), `false` (negated), `undefined` (unknown —
absence asserts nothing).

Standard tags from `@rhi-zone/fractal-api-tree/tags`:

| Tag | Meaning | Implies |
|-----|---------|---------|
| `readOnly` | No observable side-effects; safe to call any number of times | `idempotent: true` (via lattice) |
| `idempotent` | Same args → same state, regardless of call count | — |
| `destructive` | Irrevocably removes or destroys state | Mutually exclusive with `readOnly` |
| `openWorld` | May reach external systems or networks | Orthogonal |
| `streaming` | Yields a sequence over time, not a single value | Orthogonal |

Custom tags are allowed via the index signature — the bag is open.

### What each projection reads

**HTTP projection** (`buildRoutes`):
- Derives HTTP verb from the resolved tag lattice (see [§5a](#5a-verb-derivation)).
- `readOnly: true` → GET; `idempotent: true, destructive: true` → DELETE;
  `idempotent: true` → PUT; otherwise → POST.

**MCP projection** (`toTools`):
- `readOnly: true` → `readOnlyHint: true`
- `idempotent: true` → `idempotentHint: true`
- `destructive: true` → `destructiveHint: true`

**CLI projection**: `readOnly: true` suppresses confirmation prompts;
`destructive: true` triggers them.

### Node-level tag inheritance

Tags set on a branch node's `meta.tags` are inherited by all leaf descendants
via `effectiveTags` (closest-wins). A leaf's own tags override ancestor tags;
`undefined` defers upward.

```ts
// catalog node tagged readOnly — search and genres inherit it
// Neither leaf sets meta.tags of its own
const catalogNode = node({
  children: {
    search: op(/* … */),   // inherits readOnly → GET /catalog/search
    genres: op(/* … */),   // inherits readOnly → GET /catalog/genres
  },
  meta: { tags: { readOnly: true } },
})
```

The MCP tests confirm the downstream effect:

```ts
// catalog_search → readOnlyHint: true (no leaf-level tag; from node)
const t = tools.find((t) => t.name === "catalog_search")
expect(t?.annotations?.readOnlyHint).toBe(true)
```

### 5a. Verb derivation

`verbFromTags` applies this lattice (checked in order):

1. `meta.http.verb` override → wins over all inference.
2. `readOnly === true` → `GET`
3. `idempotent === true && destructive === true` → `DELETE`
4. `idempotent === true` → `PUT`
5. Otherwise → `POST` (conservative default)

---

## 6. `http.*` verb-helper bundles

`http.get`, `http.post`, `http.put`, `http.patch`, `http.delete`, `http.head`,
`http.options` are **meta values** (not wrapper functions). Each bundles a verb
pin (`meta.http.verb`) with the behavioral tags that verb implies:

| Bundle | Verb pin | Bundled tags | MCP hints lit up |
|--------|----------|--------------|-----------------|
| `http.get` | GET | `readOnly: true` | readOnlyHint, idempotentHint (via lattice) |
| `http.post` | POST | _(none)_ | _(none)_ |
| `http.put` | PUT | `idempotent: true` | idempotentHint |
| `http.patch` | PATCH | _(none)_ | _(none)_ |
| `http.delete` | DELETE | `destructive: true, idempotent: true` | destructiveHint, idempotentHint |
| `http.head` | HEAD | `readOnly: true` | readOnlyHint |
| `http.options` | OPTIONS | `readOnly: true` | readOnlyHint |

Attach a bundle as a contribution to `op`:

```ts
import { http } from "@rhi-zone/fractal-http/verbs"

// PUT /books/{bookId}/checkout/reserve + idempotentHint in MCP — one declaration
const reserve = op(
  (input: { bookId: string; patronId: string }) => ({
    reservationId: `res-${input.bookId}-${input.patronId}`,
    patronId: input.patronId,
  }),
  http.put,
)

// POST /books/{bookId}/checkout/start — no implied behavioral tags
const start = op(
  (input: { bookId: string }) => ({ sessionId: `checkout-${input.bookId}` }),
  http.post,
)
```

**When to reach for `http.*` vs plain tags**: use `http.*` when you are
explicitly pinning the HTTP verb and want the behavioral tags to follow from it
for free (the bundle carries the verb _and_ the semantics together). Use plain
`meta.tags` when you are annotating semantics without committing to a specific
HTTP verb — the HTTP projection will derive the verb from tags, and other
projections (MCP, CLI) respond to the same tags regardless of the HTTP verb
choice. The two compose cleanly via `mergeMeta`.

---

## 7. Method-dispatch REST resources (`meta.http.dispatch: "method"`)

A node with `meta.http.dispatch: "method"` makes all **leaf children share the
node's own path**, distinguished by HTTP verb. Branch children under the same
node still contribute a path segment (segment-dispatched as normal).

```ts
const bookItemNode = node({
  meta: { http: { dispatch: "method" } },
  children: {
    // All three leaves → /books/{bookId}, verb from tags
    read:    op((input: { bookId: string }) => store.get(input.bookId),
               { tags: { readOnly: true } }),          // GET  /books/{bookId}
    replace: op((input: { bookId: string; /* … */ }) => { /* … */ },
               { tags: { idempotent: true } }),         // PUT  /books/{bookId}
    remove:  op((_: { bookId: string }) => ({ deleted: store.delete(_.bookId) }),
               { tags: { destructive: true, idempotent: true } }), // DELETE /books/{bookId}

    // Branch child under method-dispatch node → still segment-dispatched
    checkout: node({
      children: {
        start:   op(/* … */, http.post), // POST /books/{bookId}/checkout/start
        reserve: op(/* … */, http.put),  // PUT  /books/{bookId}/checkout/reserve
      },
    }),
  },
})
```

The route table produced by `buildRoutes` contains three distinct routes at
`/books/{bookId}` with verbs GET, PUT, DELETE:

```ts
const routes = buildRoutes(api)
const byIdRoutes = routes.filter((r) => r.path === "/books/{bookId}")
// → length 3, verbs { GET, PUT, DELETE }
```

**Collision detection**: if two leaf children resolve to the same verb (after
tag inheritance), `buildRoutes` throws:

```
attribute-dispatch collision at "/books/{bookId}": children "read" and "…"
both resolve to GET
```

**CLI/MCP projection**: these projections ignore the `dispatch` marker
entirely and key children by their agnostic names (`read`, `replace`, `remove`).
The HTTP verb is invisible at those layers.

---

## 8. Arbitrary-attribute dispatch

For dispatching on request attributes other than the HTTP verb, set
`meta.http.dispatch` to one of:

| Dispatch marker | Matches on |
|-----------------|-----------|
| `{ by: "header", name: "X-Api-Version" }` | A request header |
| `{ by: "query", name: "mode" }` | A query parameter |
| `{ by: "contentType" }` | The request `Content-Type` |

The default match value for each child is its **key** (the child's slot name in
the parent's `children` map). Override per-child with `meta.http.when`.

### Example: header dispatch (`/version`)

```ts
const versionNode = node({
  meta: { http: { dispatch: { by: "header", name: "X-Api-Version" } } },
  children: {
    // child key "v1" → matches X-Api-Version: v1
    v1: op((_: unknown) => ({ version: "v1", message: "Library API — classic edition" }), {
      tags: { readOnly: true },
    }),

    // key≠value: child key is "v2Alias" but meta.http.when pins the match value to "v2"
    v2Alias: op((_: unknown) => ({ version: "v2", message: "Library API — enhanced edition", features: ["pagination", "filtering"] }), {
      tags: { readOnly: true },
      http: { when: "v2" },
    }),
  },
})
```

Both `v1` and `v2Alias` are leaf nodes with `readOnly: true` → both project to
`GET /version`. The `X-Api-Version` header value selects which handler runs:

- `X-Api-Version: v1` → `v1` handler (key = match value)
- `X-Api-Version: v2` → `v2Alias` handler (`when: "v2"` overrides the key)

No-match behavior:
- Method dispatch: 405 + Allow (via `autoMethodLayer`).
- Header/query/contentType dispatch: 404 (the attribute is not part of the
  HTTP-visible address, so there is no meaningful 4xx to return).

### Multi-level nesting

Attribute-dispatch nodes can nest. A header-dispatch node whose branch children
are method-dispatch nodes produces leaves that carry **both** conditions. The
parent's condition is propagated into all descendants via `inheritedConditions`.

---

## 9. Composition: `mergeMeta` and multiple contributions

All constructors that accept meta use `mergeMeta` internally. Never spread meta
bags manually — spreading is one level shallow and silently drops sub-keys.

`mergeMeta` rules:
- Later bags win per top-level key.
- `undefined` values **defer** (they do not override a previously-set value).
- When both an existing value and the incoming value are plain objects (not
  arrays), they are merged one level deeper (e.g. the `tags` sub-bag, the
  `http` sub-bag).

```ts
// http.put contributes { http: { verb: "PUT" }, tags: { idempotent: true } }
// Extra contribution adds { tags: { destructive: false } }
// mergeMeta deep-merges the tags sub-bag: idempotent:true is preserved
const n = op(fn, http.put, { tags: { destructive: false } })
// n.meta.tags → { idempotent: true, destructive: false }
// n.meta.http  → { verb: "PUT" }
```

This means a verb-helper bundle and extra behavioral annotations compose without
either clobbering the other.

---

## 10. Putting it together — the library API root

```ts
export const api = node({
  children: {
    // service() surface: methods → leaf node children
    books: service(new BooksService(), {
      meta: {
        list: { tags: { readOnly: true }, description: "List all books in the library." },
        add:  { description: "Add a new book to the collection." },
      },
    }),

    // node() surface: explicit children, node-level tag inheritance
    catalog: node({
      children: {
        search: op((input: { q?: string }) => /* … */),
        genres: op((input: { prefix?: string }) => /* … */),
      },
      meta: { tags: { readOnly: true } }, // search + genres inherit → GET routes
    }),

    // Header-dispatch demo
    version: versionNode,
  },
})
```

Routes produced by `buildRoutes(api)`:

| Verb | Path | Conditions |
|------|------|------------|
| GET | /books/list | — |
| POST | /books/add | — |
| GET | /books/{bookId} | method=GET |
| PUT | /books/{bookId} | method=PUT |
| DELETE | /books/{bookId} | method=DELETE |
| POST | /books/{bookId}/checkout/start | — |
| PUT | /books/{bookId}/checkout/reserve | — |
| GET | /catalog/search | — |
| GET | /catalog/genres | — |
| GET | /version | header X-Api-Version=v1 |
| GET | /version | header X-Api-Version=v2 |
