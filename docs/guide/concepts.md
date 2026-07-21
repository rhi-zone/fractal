# Fractal — Core Concepts

A guide for newcomers grounded in the as-built code.

---

## 1. It's just a function

The atom of fractal is a plain function.

```ts
type Handler<I = any, O = any> = (input: I) => O | Promise<O>
```

An operation is a `T => U`. Composition (`compose`, `pipe`) and the `Result<T, E>`
type are in `@rhi-zone/fractal-api-tree` (`packages/api-tree/src/index.ts`) as base
primitives. Everything else — routing, HTTP, MCP — is built on top of bare functions,
not framework objects.

---

## 2. One tree = the router

There is one tree. It is both the grouping structure and the router. There is no separate
route table at the API-tree level, no `ops` map, no two-level `{ops, children}` split. The
tree IS the router.

### Node shape

Every node is a value of type `Node` (from `packages/api-tree/src/node.ts`):

```ts
type Node<H extends Handler = Handler> = {
  readonly handler?: H            // present on leaf nodes
  readonly children?: Readonly<Record<string, Node>>
  readonly fallback?: { readonly name: string; readonly subtree: Node }
  readonly meta: Meta
}
```

- **Leaf node** — `handler` is present (a callable). May have no `children`.
- **Branch node** — `children` is present. May have no `handler`.
- A node may be both (uncommon but valid). `isLeaf(n)` tests `n.handler !== undefined`.
- **`fallback`** — optional wildcard-capture child, `{ name, subtree }`. When keyed
  dispatch at this node finds no static child matching the request value, the fallback
  consumes it, binds it as `input[name]`, and continues into `subtree`. Static children
  always win.

Children are keyed by **agnostic, lowercase names** — never HTTP verbs. A child's key
is its identity across all projections: a path segment for HTTP, a subcommand for CLI, a
tool-name segment for MCP.

### One authoring primitive, two constructors

There is one `Node` primitive; two constructors produce it:

- **`op(fn, ...contributions)`** — produces a leaf node from a bare function; multiple
  meta contributions deep-merge via `mergeMeta`.
- **`api(children, opts?)`** — produces a branch node. `children` is positional; `opts`
  holds `meta` and `fallback`.

There is no `node()`, `param()`, or `service()` constructor, and no class-instance
lowering surface — those existed in an earlier revision of this model and have been
removed. `api()` is the only branch constructor; a parameterized child edge is expressed
via a node's own `fallback` field, not a separate `ParamNode` type:

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"

const routes = api({
  books: api({
    list: op((_: unknown) => /* … */),
  }, {
    fallback: { name: "bookId", subtree: api({ get: op((input: { bookId: string }) => /* … */) }) },
  }),
})
```

The handler sees one flat input object — it cannot distinguish a path slug from a query
param from a body field (provenance-blind by design).

---

## 3. Building the HTTP route tree — a separate transform, not attribute dispatch

An earlier revision of this model let any node dispatch its children by an attribute
other than path segment (`meta.http.dispatch: "method" | { by: "header" | "query" | "contentType", ... }`,
with a direct tree-walk dispatcher interpreting it at request time). That mechanism has
been retired — see `packages/http-api-projector/src/project.ts`'s module doc, which
describes header/query/contentType attribute dispatch as "an open design question" with
no current equivalent. Do not author against `meta.http.dispatch` today.

The current HTTP projector instead produces a **separate route tree** (`HttpRoute`,
organized by path segment + HTTP method) from the API tree (organized by domain) via a
fixed transform pipeline in `packages/http-api-projector/src/route.ts`:

```
Node --naiveTransform--> HttpRoute --applyMethods, applyMoveTo, applyResponse--> HttpRoute --makeRouterFromRoute--> Fetch
```

- **`naiveTransform`** — the mechanical baseline: every child becomes a path-segment
  child, every handler becomes a single `POST` entry in `methods`.
- **`applyMethods`** — reads `{ kind: "method", value }` directives (set by `http.*`
  verb bundles or written by hand) and renames a method entry's key from `POST` to the
  right verb.
- **`applyMoveTo`** — reads `{ kind: "moveTo", path }` directives and repositions a
  subtree within the route tree using relative-path algebra (`.`/`..`/`../name`/`*`).
  Leaves that converge on the same target position (the REST-resource pattern: several
  operations at one path, distinguished by verb) merge there; a real verb collision
  throws.
- **`applyResponse`** — reads `{ kind: "response", status?, headers? }` directives and
  wraps the handler (function composition, not metadata) to produce the override.

`httpProjection(tree)` (`packages/http-api-projector/src/dx.ts`) is the one-call preset
composing all three rewriters over `naiveTransform`'s output; `crud(handlers)` is the
convention constructor for the standard 5-op REST resource, wiring `http.*` bundles for
you. `createFetch(node, opts?)` (`preset.ts`) is the full OOTB pipeline: optional
`wrapValidators`, `httpProjection`, user rewriters, router compilation
(`makeRouterFromRoute` by default; `radixRouter`/`compiledCharRouter`/`mapCharRouter` in
`compile.ts` for faster dispatch at a build-time cost), and the auto-method layer
(HEAD-from-GET, OPTIONS/405).

`makeRouterFromRoute` dispatches directly on the compiled `HttpRoute` tree — O(depth) via
keyed child lookup at each node, walking `children` for static path segments and
`fallback` for the wildcard-capture case. There is no flat route table.

Non-HTTP projections (MCP, CLI) never see the `HttpRoute` tree — they dispatch/enumerate
the original `Node` tree directly and key children by their agnostic name as always.

---

## 4. Tags

Tags are **agnostic behavioral markers** that live in `meta.tags` on any node. They drive
behavior across all projections from one authoring site.

```ts
// packages/api-tree/src/tags.ts
type Tags = {
  readOnly?: boolean | undefined
  idempotent?: boolean | undefined
  destructive?: boolean | undefined
  openWorld?: boolean | undefined
  streaming?: boolean | undefined
  [custom: string]: boolean | undefined
}
```

Tags are **three-valued**: `true` (explicitly asserted), `false` (explicitly negated),
`undefined` (unknown). Unknown is not the same as false. When a projection reads a tag and
finds `undefined`, it omits the corresponding hint/behavior rather than treating it as
negated.

### Implication lattice

`resolveTags(tags)` (in `packages/api-tree/src/tags.ts`) applies two lattice rules:

- `readOnly = true` implies `idempotent = true`
- `readOnly = true` AND `destructive = true` is a conflict (both cannot hold)

### No inheritance — a node's tags are exactly what's on it

An earlier revision of this model had closest-wins tag inheritance
(`effectiveTags(path)`, walking root-to-leaf and letting a defined value at a closer node
override a farther one). That function has been removed: **a node's tags do not depend on
its ancestors.** Inheritance-by-tree-position broke composability — moving a subtree would
silently change its behavior. Tagging a whole subtree as `readOnly` now means tagging each
leaf explicitly, or writing an explicit `(tree) => tree` transform (built on `mapNodes` in
`packages/api-tree/src/tags.ts`, the shared pre-order-visitor primitive) that pushes the
tag down as its own pass over the tree.

### How projections read tags

| Projection | Tag use |
|---|---|
| HTTP (`verbFromTags`) | derives HTTP verb via the lattice |
| MCP (`toTools`) | derives `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| CLI (`runCli`) | drives confirmation prompt on destructive ops |

The same `meta.tags` bag drives all of these — read directly off each node, with no
inheritance step. One authoring site, consistent semantics everywhere.

> **Note:** The `readOnly` tag name is provisional. The canonical tag-set document uses
> `safe`; `readOnly` is a working alias pending final naming resolution.

---

## 5. Verbs stay out of the tree (by taste, not law)

HTTP verb strings (`GET`, `POST`, `PUT`, `DELETE`) do not appear as node keys in a
well-formed fractal tree. They are uppercase HTTP vocabulary; they are meaningless to MCP,
CLI, and any other projection.

The verb for a leaf is **derived from tags** at build time by `verbFromTags(meta)` in
`packages/http-api-projector/src/tags.ts`:

```
readOnly = true                           → GET
idempotent = true, destructive = true     → DELETE
idempotent = true, destructive ≠ true     → PUT
else                                      → POST  (conservative default)
```

An explicit `{ kind: "verb", value }` entry in `meta.http.directives` (set by an
`http.*` bundle, or by hand) is an escape hatch that overrides the derived verb when
needed — checked before tags.

The `http.*` verb helpers (`http.get`, `http.put`, `http.post`, `http.patch`,
`http.delete`) are **metadata value bundles**: each sets both the verb pin and the
behavioral tags that verb implies (e.g. `http.get` → `{ readOnly: true }`). They exist as
a convenience for the HTTP-specific authoring surface — applying one still lights up MCP
hints and CLI confirms via the shared tag lattice. Tags remain the source of truth; the
helper sets both at once.

A tree authored with raw verb keys in `children` is a soft smell — it divorces tree
position from agnostic meaning and breaks non-HTTP projections.

---

## 6. Metadata: an open bag; composition by `mergeMeta`

`Meta` is an open bag:

```ts
// packages/api-tree/src/node.ts
type Meta = { tags?: Tags; readonly [key: string]: unknown }
```

Projection namespaces are per-key sub-bags (`meta.http`, `meta.mcp`, etc.). The bag is
never a second source for domain data — TypeScript types and JSDoc are the source of truth
for data. `Meta` carries only the non-type-expressible projection and taste concerns:
verb, segment names, idempotency, auth hints.

### `mergeMeta`

Composing meta bags — merging a verb helper bundle with explicit tags, or any other
multi-contribution `op()`/`api()` call — uses one primitive: `mergeMeta(...metas)`
(in `packages/api-tree/src/node.ts`).

`mergeMeta` is a deep merge with precedence:
- Later bags win per key; `undefined` defers (does not override a previously-set value).
- Sub-bags that are plain objects (like `tags` or `http`) are merged recursively — not
  spread-replaced. Spreading would silently drop keys from the losing sub-bag. Arrays
  (e.g. `http.directives`) concatenate.

`op(fn, ...contributions)` applies `mergeMeta` across all provided meta contributions
so a verb bundle and extra explicit tags compose without clobbering each other.

---

## 7. Projections — dispatching vs enumerating

A **projection** reads the one Node tree and produces a surface. There are two modes:

### Dispatching projections

**HTTP** and **CLI**: a request arrives → walk the tree (or the derived route tree, for
HTTP — see §3) → find one leaf → call its handler → return a response.

`createFetch(node, opts?)` (`packages/http-api-projector/src/preset.ts`) is the OOTB HTTP
pipeline described in §3. `runCli(node, opts?)` (`packages/cli-api-projector/src/cli.ts`)
walks the `Node` tree directly for CLI subcommand dispatch — no separate route-tree
transform, since a CLI's shape already matches the domain tree's shape.

### Enumerating projections

**MCP** and **GraphQL**: flatten all leaves in the tree to produce a surface — one tool /
one field per leaf.

`toTools(node, opts?)` in `packages/mcp-api-projector/src/project.ts` walks the tree and emits one
`McpTool` per leaf. Tool names are underscore-joined from tree position
(`catalog_search`, `books_bookId_get`). The `meta.mcp.name` field is a full override;
`meta.mcp.segment` overrides the per-node name contribution. See
`docs/design/graphql-projector.md` for the GraphQL enumerator.

For both modes, the projection reads `meta.tags` directly off each node (no inheritance,
see §4) to derive projection-specific semantics (HTTP verb, MCP annotation hints). One
authoring source, consistent behavior across surfaces.

### Codegen bridge

Projections that need runtime input schemas (MCP, OpenAPI) cannot read TypeScript types
at runtime — types are erased. `extractToolSchemas(entryFile)`
(`packages/api-tree/src/tree.ts`) uses the TypeScript compiler API (via
`@rhi-zone/fractal-type-ir`'s JSON Schema derivation) to walk the exported node tree at
the AST level, derive JSON Schema from each leaf's first parameter type, and extract
leading JSDoc text. The resulting `SchemaMap` is passed to `toTools` as `opts.schemas`.

---

## Quick reference

| Symbol | Package | What it is |
|---|---|---|
| `Node` | `@rhi-zone/fractal-api-tree/node` | The one tree node type |
| `Handler<I,O>` | `@rhi-zone/fractal-api-tree/node` | A plain callable: `(input: I) => O \| Promise<O>` |
| `Meta` | `@rhi-zone/fractal-api-tree/node` | Open metadata bag |
| `op(fn, ...contributions)` | `@rhi-zone/fractal-api-tree` | Construct a leaf node |
| `api(children, opts?)` | `@rhi-zone/fractal-api-tree` | Construct a branch node (children + optional meta/fallback) |
| `mergeMeta(...metas)` | `@rhi-zone/fractal-api-tree/node` | Deep-merge meta bags, later wins |
| `Tags` | `@rhi-zone/fractal-api-tree/tags` | Three-valued behavioral tag dict |
| `resolveTags(tags)` | `@rhi-zone/fractal-api-tree/tags` | Apply the implication lattice |
| `mapNodes(tree, fn)` | `@rhi-zone/fractal-api-tree/tags` | Pre-order tree-transform primitive (replaces removed tag inheritance) |
| `extractToolSchemas(entryFile)` | `@rhi-zone/fractal-api-tree/tree` | AST-level JSON Schema + JSDoc extraction |
| `naiveTransform(node)` | `@rhi-zone/fractal-http-api-projector/route` | `Node => HttpRoute` mechanical baseline |
| `httpProjection(node, opts?)` | `@rhi-zone/fractal-http-api-projector/dx` | One-call `Node => HttpRoute` with standard rewriters |
| `crud(handlers)` | `@rhi-zone/fractal-http-api-projector/dx` | Convention constructor for the 5-op REST resource |
| `verbFromTags(meta)` | `@rhi-zone/fractal-http-api-projector/tags` | Derive HTTP verb from the tag lattice |
| `makeRouterFromRoute(route)` | `@rhi-zone/fractal-http-api-projector/route` | Zero-build-cost `HttpRoute` dispatcher |
| `createFetch(node, opts?)` | `@rhi-zone/fractal-http-api-projector/preset` | OOTB HTTP handler (WHATWG `Request→Response`) |
| `toTools(node, opts?)` | `@rhi-zone/fractal-mcp-api-projector/project` | Enumerate tree → flat `McpTool[]` |
| `runCli(node, opts?)` | `@rhi-zone/fractal-cli-api-projector/cli` | Dispatch the tree as a CLI |
