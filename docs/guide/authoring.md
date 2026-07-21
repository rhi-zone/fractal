# Authoring a fractal tree

A fractal tree is a value: a nested structure of `Node` objects where **tree
position is address**. You build it once, pass it to a projection (HTTP,
MCP, CLI), and each projection derives what it needs from the structure and
the open metadata bag.

There are exactly two constructors: `op()` produces a leaf, `api()` produces
a branch. Both live in `@rhi-zone/fractal-api-tree` (re-exported from
`@rhi-zone/fractal-api-tree/node`, where the `Node`/`Meta`/`Handler` types
also live). Verb-helper bundles live in
`@rhi-zone/fractal-http-api-projector/verbs`; the `crud()` convention
constructor and the `httpProjection()` preset live in
`@rhi-zone/fractal-http-api-projector/dx`.

> **Superseded surfaces:** earlier revisions of this model had `node()`,
> `param()`, and `service()` constructors plus closest-wins tag inheritance
> (`effectiveTags`). None of these exist in the current code — `api()` is the
> only branch constructor, parameterized segments are expressed via a node's
> `fallback` field (§4), and tags are read exactly as authored on each node,
> with no inheritance from ancestors (§5).

---

## 1. Leaf nodes — `op(fn, ...contributions)`

`op` produces a leaf node: a `Node` with a `handler` and merged meta.

```ts
import { op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"

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

## 2. Branch nodes — `api(children, opts?)`

`api` produces a branch node: a `Node` with children (and optional meta and
`fallback` — see §4). Children are `Node` values keyed by their **address
segment name**, passed positionally; `opts` holds the rarer stuff.

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"

const catalogNode = api({
  search: op((input: { q?: string }) => /* … */),
  genres: op((input: { prefix?: string }) => /* … */),
}, {
  // Node-level tag. NOTE: this does NOT propagate to search/genres — tags
  // are read exactly as authored on each node, with no ancestor inheritance
  // (see §5). A node-level tag like this only affects code that reads
  // meta.tags off the branch node itself.
  meta: { tags: { readOnly: true } },
})
```

A node may carry both `handler` and `children` (uncommon but valid). A leaf
stored as a child is just a node whose `handler` is defined — there is one
`Node` primitive. `api()` is the only branch constructor.

---

## 3. No class-instance surface

There is no `service()`-style constructor that lowers a class instance to a
branch node. Build the tree explicitly with `api()` and `op()`, binding
methods yourself where needed:

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"

class BooksService {
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

const svc = new BooksService()
const booksNode = api({
  list: op(svc.list.bind(svc), { tags: { readOnly: true } }, { description: "List all books." }),
  add:  op(svc.add.bind(svc), { description: "Add a new book to the collection." }),
})
```

---

## 4. Parameterized children — `fallback`

There is no `param()` constructor. A parameterized (wildcard-capture) child
edge is the optional `fallback` field on any node: `{ name, subtree }`. When
keyed dispatch at that node finds no child matching the current request
value, the fallback consumes the value, binds it under `fallback.name` in the
handler input, and continues into `subtree`. Static children always win over
the fallback.

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"

// bookId becomes the wildcard segment; its runtime value flows into handler input
const byId = api({
  read:   op((input: { bookId: string }) => store.get(input.bookId), { tags: { readOnly: true } }),
  remove: op((input: { bookId: string }) => ({ deleted: store.delete(input.bookId) }),
             { tags: { destructive: true, idempotent: true } }),
})

const booksNode = api({
  list: op((_: unknown): Book[] => [...store.values()], { tags: { readOnly: true } }),
}, {
  fallback: { name: "bookId", subtree: byId },
})
```

At dispatch time the captured segment value is merged into handler input
under `"bookId"` — provenance-blind (the handler just sees `input.bookId`).

`fallback` sets the tree's own domain-level structure. When the API tree's
domain shape doesn't already match the desired HTTP path shape, the
`http.moveTo(path)` directive (§7) can converge several leaves onto a shared
wildcard position in the *route* tree instead, without reshaping the API tree
itself.

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

**HTTP projection** (`verbFromTags`, `packages/http-api-projector/src/tags.ts`):
- Derives HTTP verb from the resolved tag lattice (see [§5a](#5a-verb-derivation)).
- `readOnly: true` → GET; `idempotent: true, destructive: true` → DELETE;
  `idempotent: true` → PUT; otherwise → POST.

**MCP projection** (`toTools`):
- `readOnly: true` → `readOnlyHint: true`
- `idempotent: true` → `idempotentHint: true`
- `destructive: true` → `destructiveHint: true`
- `openWorld: true` → `openWorldHint: true`

**CLI projection**: `readOnly: true` suppresses confirmation prompts;
`destructive: true` triggers them.

### No node-level tag inheritance

Tags are read exactly as authored **on the node itself** — there is no
closest-wins inheritance from ancestor branch nodes. Setting `meta.tags` on a
branch node does not propagate to its leaf descendants; each leaf carries its
own tags.

```ts
// meta.tags on this branch node does NOT propagate to search/genres —
// each leaf must set readOnly itself if it wants the GET-deriving tag.
const catalogNode = api({
  search: op(/* … */, { tags: { readOnly: true } }),
  genres: op(/* … */, { tags: { readOnly: true } }),
})
```

Tree transforms (`(tree) => tree` functions, using `mapNodes` from
`@rhi-zone/fractal-api-tree/tags` as the shared pre-order-visitor primitive)
are the general mechanism for anything that used to rely on inheritance —
e.g. a convention transform that walks a subtree and pushes a tag down to
every descendant explicitly. This is a deliberate design choice: inheritance
by tree position broke composability (moving a subtree would silently change
its behavior).

### 5a. Verb derivation

`verbFromTags` applies this lattice (checked in order):

1. A `{ kind: "verb", value }` entry in `meta.http.directives` → wins over all
   inference.
2. `readOnly === true` → `GET`
3. `idempotent === true && destructive === true` → `DELETE`
4. `idempotent === true` → `PUT`
5. Otherwise → `POST` (conservative default)

---

## 6. `http.*` verb-helper bundles

`http.get`, `http.post`, `http.put`, `http.patch`, `http.delete`, `http.head`,
`http.options` are **meta values** (not wrapper functions). Each bundles a
verb pin (`meta.http.directives`, holding both a `{kind:"verb"}` entry read by
`verbFromTags` and a `{kind:"method"}` entry read by the `applyMethods`
rewriter) with the behavioral tags that verb implies:

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
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"

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

## 7. Method-dispatch REST resources — `fallback` + `http.moveTo`

There is no `meta.http.dispatch: "method"` marker. The current model produces
the HTTP route tree from the API tree via a fixed pipeline
(`naiveTransform` → `applyMethods` → `applyMoveTo` → `applyResponse`, see
`docs/design/routing-and-transforms.md`), and "several leaf children share
one path, distinguished by verb" falls out of two more primitive pieces:

- **`fallback`** (§4) puts the parameterized subtree at its own tree
  position — a single wildcard segment shared by everything under it.
- **`http.moveTo(path)`** repositions a leaf within the *route* tree
  (relative-path algebra: `..` up to parent, `../newname` rename, `*` push a
  wildcard segment). Leaves that `moveTo` the same target converge onto one
  route position; `applyMoveTo` merges their methods and throws on a genuine
  verb collision.

The two compose: put `read`/`replace`/`remove` inside a `fallback` subtree so
they already share the API tree's own parameterized position, then let the
verb come from tags as usual — no `moveTo` needed when the domain tree
already matches the desired URL shape:

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"

const bookItemNode = api({
  // Branch child alongside the leaves → still its own path segment,
  // /books/{bookId}/checkout/...
  checkout: api({
    start:   op(/* … */, http.post), // POST /books/{bookId}/checkout/start
    reserve: op(/* … */, http.put),  // PUT  /books/{bookId}/checkout/reserve
  }),
}, {
  fallback: {
    name: "bookId",
    subtree: api({
      read:    op((input: { bookId: string }) => store.get(input.bookId), http.get),
      replace: op((input: { bookId: string /* … */ }) => { /* … */ }, http.put),
      remove:  op((input: { bookId: string }) => ({ deleted: store.delete(input.bookId) }), http.delete),
    }),
  },
})
```

`applyMethods` renames each leaf's `POST` method-table entry to the verb its
`http.*` bundle (or tags) implies, so `read`/`replace`/`remove` all land at
`/books/{bookId}` with distinct verbs GET/PUT/DELETE. Reach for
`http.moveTo(path)` instead when the operations naturally live elsewhere in
the domain tree and need to be repositioned onto a shared URL — see
`docs/design/routing-and-transforms.md`'s "Motivating example".

**Collision detection**: if two leaf children resolve to the same verb at the
same route position, `applyMoveTo`/`mergeRoutes` throws:

```
applyMoveTo: conflicting route — GET /books/{bookId} is defined by more than one node
```

**CLI/MCP projection**: these projections key children by their agnostic
names (`read`, `replace`, `remove`) regardless of how the HTTP projector
places them. The HTTP verb and route position are invisible at those layers.

---

## 8. Attribute dispatch (header / query / Content-Type) — not implemented

Earlier revisions of this model supported dispatching a node's children on a
request attribute other than path/method (`meta.http.dispatch: { by: "header" | "query" | "contentType", ... }`,
with per-child `meta.http.when` overrides). That mechanism has been retired
along with the direct tree-walk dispatcher it depended on — see
`packages/http-api-projector/src/project.ts`'s module doc, which describes it
as "an open design question" with no current equivalent in the
`naiveTransform` → rewriters → `makeRouterFromRoute` pipeline. Do not author
against `meta.http.dispatch` for anything other than the `fallback`/`moveTo`
mechanism in §7 — there is no interpreter for header/query/contentType
markers in the current build.

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
// http.put contributes { http: { directives: [{kind:"verb",value:"PUT"},{kind:"method",value:"PUT"}] }, tags: { idempotent: true } }
// Extra contribution adds { tags: { destructive: false } }
// mergeMeta deep-merges the tags sub-bag: idempotent:true is preserved
const n = op(fn, http.put, { tags: { destructive: false } })
// n.meta.tags → { idempotent: true, destructive: false }
// n.meta.http.directives → [{kind:"verb",value:"PUT"},{kind:"method",value:"PUT"}]
```

This means a verb-helper bundle and extra behavioral annotations compose without
either clobbering the other.

---

## 10. Putting it together — the library API root

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"
import { httpProjection } from "@rhi-zone/fractal-http-api-projector/dx"

export const apiTree = api({
  books: api({
    list: op((_: unknown): Book[] => [...store.values()], { tags: { readOnly: true } }, { description: "List all books in the library." }),
    add:  op((input: { title: string; author: string; genre: string }) => { /* … */ }, { description: "Add a new book to the collection." }),
  }, {
    fallback: { name: "bookId", subtree: bookItemNode }, // §7's read/replace/remove
  }),

  // Explicit children — each leaf sets its own tags (no inheritance, see §5)
  catalog: api({
    search: op((input: { q?: string }) => /* … */, { tags: { readOnly: true } }),
    genres: op((input: { prefix?: string }) => /* … */, { tags: { readOnly: true } }),
  }),
})
```

Routes produced by `httpProjection(apiTree)` (see
`docs/design/routing-and-transforms.md`):

| Verb | Path |
|------|------|
| GET | /books/list |
| POST | /books/add |
| GET | /books/{bookId} |
| PUT | /books/{bookId} |
| DELETE | /books/{bookId} |
| POST | /books/{bookId}/checkout/start |
| PUT | /books/{bookId}/checkout/reserve |
| GET | /catalog/search |
| GET | /catalog/genres |
