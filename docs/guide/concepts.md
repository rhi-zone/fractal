# Fractal — Core Concepts

A guide for newcomers grounded in the as-built code.

---

## 1. It's just a function

The atom of fractal is a plain function.

```ts
type Handler<I = any, O = any> = (input: I) => O | Promise<O>
```

An operation is a `T => U`. Composition (`compose`, `pipe`) and the `Result<T, E>`
type are in `@rhi-zone/fractal-core` (`packages/core/src/index.ts`) as base
primitives. Everything else — routing, HTTP, MCP — is built on top of bare functions,
not framework objects.

---

## 2. One tree = the router

There is one tree. It is both the grouping structure and the router. There is no separate
route table, no `ops` map, no two-level `{ops, children}` split. The tree IS the router.

### Node shape

Every node is a value of type `Node` (from `packages/core/src/node.ts`):

```ts
type Node = {
  readonly handler?: Handler      // present on leaf nodes
  readonly children?: Readonly<Record<string, ChildEntry>>
  readonly meta: Meta
}
```

- **Leaf node** — `handler` is present (a callable). May have no `children`.
- **Branch node** — `children` is present. May have no `handler`.
- A node may be both (uncommon but valid). `isLeaf(n)` tests `n.handler !== undefined`.

Children are keyed by **agnostic, lowercase names** — never HTTP verbs. A child's key
is its identity across all projections: a path segment for HTTP, a subcommand for CLI, a
tool-name segment for MCP.

### Two authoring surfaces, one primitive

Both supported surfaces lower to the same `Node` value:

- **`op(fn, ...meta)`** — produces a leaf node from a bare function.
- **`node({ children?, meta? })`** — produces a branch node.
- **`service(instance, opts?)`** — walks a class instance; each method becomes a
  leaf-node child, each `Node`/`ParamNode`-valued field is mounted as-is.

There is one `Node` primitive; `service()` and `node()` produce the identical
`{ handler?, children, meta }` value.

### Parameterized edges

A `ParamNode` (from `param(name, subtree)`) is a parameterized child edge. It contributes
`{name}` as an HTTP path segment and captures the runtime slug value into the handler's
input object under `name`. The handler sees one flat input object — it cannot distinguish
a path slug from a query param from a body field (provenance-blind by design).

```ts
// packages/core/src/node.ts
type ParamNode = { readonly _tag: "param"; readonly name: string; readonly subtree: Node }

// Usage:
const routes = node({
  children: {
    books: node({
      children: {
        bookId: param("bookId", node({ children: { ... } }))
      }
    })
  }
})
```

---

## 3. Dispatch by attribute — path is not special

Every internal node dispatches its children by **one attribute of the request**. By default
that attribute is the path segment (the child's key becomes the next path segment). But
path-segment dispatch is not privileged — it is just the default.

The `meta.http.dispatch` field on a node selects the dispatch attribute for its children
(type `DispatchMarker` in `packages/http/src/project.ts`):

| `dispatch` value | Children distinguished by |
|---|---|
| _(absent)_ | path segment (default) |
| `"method"` | HTTP method (derived from tags) |
| `{ by: "header", name: "X-Foo" }` | request header value |
| `{ by: "query", name: "mode" }` | query parameter value |
| `{ by: "contentType" }` | Content-Type header value |

**Multi-verb same path** is expressed by setting `dispatch: "method"` on a node whose
leaf children are the individual operations. Those children share the node's own URL path;
HTTP distinguishes them by verb. No special node shape is needed — it is the same
`Node` type, just a different dispatch attribute at that level.

When a node uses non-segment dispatch, branch children still contribute a path segment as
normal; only leaf children are resolved at the same URL path. Non-HTTP projections (MCP,
CLI) ignore the `dispatch` marker and key children by their agnostic name as always.

The `buildRoutes` function in `packages/http/src/project.ts` implements this at build time,
producing a flat `Route[]` where each route carries a `conditions: MatchCondition[]` array
that encodes whatever attribute dispatch was in effect.

---

## 4. Tags

Tags are **agnostic behavioral markers** that live in `meta.tags` on any node. They drive
behavior across all projections from one authoring site.

```ts
// packages/core/src/tags.ts
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

`resolveTags(tags)` (in `packages/core/src/tags.ts`) applies two lattice rules:

- `readOnly = true` implies `idempotent = true`
- `readOnly = true` AND `destructive = true` is a conflict (both cannot hold)

### Inheritance — closest-wins

Tags inherit down the tree. `effectiveTags(path)` (in `packages/core/src/tags.ts`)
walks an array of nodes from root to leaf; a defined value (`true` or `false`) at a closer
node overrides a farther one. `undefined` defers upward. This means you can tag an entire
subtree as `readOnly` at the branch node, and individual leaves can override.

### How projections read tags

| Projection | Tag use |
|---|---|
| HTTP (`buildRoutes`) | derives HTTP verb via the lattice |
| MCP (`toTools`) | derives `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| CLI _(planned)_ | drives confirmation prompt on destructive ops |

The same `effectiveTags` call and the same `meta.tags` bag drive all of these. One
authoring site, consistent semantics everywhere.

> **Note:** The `readOnly` tag name is provisional. The canonical tag-set document uses
> `safe`; `readOnly` is a working alias pending final naming resolution.

---

## 5. Verbs stay out of the tree (by taste, not law)

HTTP verb strings (`GET`, `POST`, `PUT`, `DELETE`) do not appear as node keys in a
well-formed fractal tree. They are uppercase HTTP vocabulary; they are meaningless to MCP,
CLI, and any other projection.

The verb for a leaf is **derived from tags** at build time by `verbFromTags(meta)` in
`packages/http/src/project.ts`:

```
readOnly = true                           → GET
idempotent = true, destructive = true     → DELETE
idempotent = true, destructive ≠ true     → PUT
else                                      → POST  (conservative default)
```

`meta.http.verb` is an escape hatch that overrides the derived verb when needed.

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
// packages/core/src/node.ts
type Meta = { tags?: Tags; readonly [key: string]: unknown }
```

Projection namespaces are per-key sub-bags (`meta.http`, `meta.mcp`, etc.). The bag is
never a second source for domain data — TypeScript types and JSDoc are the source of truth
for data. `Meta` carries only the non-type-expressible projection and taste concerns:
verb, segment names, idempotency, auth hints.

### `mergeMeta`

Composing meta bags — whether merging a verb helper bundle with explicit tags, or
accumulating inherited tags down a tree walk — uses one primitive: `mergeMeta(...metas)`
(in `packages/core/src/node.ts`).

`mergeMeta` is a deep merge with precedence:
- Later bags win per key; `undefined` defers (does not override a previously-set value).
- Sub-bags that are plain objects (like `tags` or `http`) are merged **one level deep**
  — not spread-replaced. Spreading would silently drop keys from the losing sub-bag.

This is the same closest-wins logic as `effectiveTags`, generalized to the whole meta
bag. `op(fn, ...contributions)` applies `mergeMeta` across all provided meta contributions
so a verb bundle and extra explicit tags compose without clobbering each other.

---

## 7. Projections — dispatching vs enumerating

A **projection** reads the one Node tree and produces a surface. There are two modes:

### Dispatching projections

**HTTP** and **CLI** (planned): a request arrives → walk the tree → find one leaf → call
its handler → return a response.

`buildRoutes(node)` in `packages/http/src/project.ts` compiles the tree to a flat
`Route[]` at build time. `makeRouter(routes)` dispatches each live request against that
table in O(routes) with full condition evaluation. The `createFetch(node, opts?)` preset in
`packages/http/src/preset.ts` composes `buildRoutes` + `makeRouter` +
`autoMethodLayer` (HEAD-from-GET, OPTIONS/405) into a WHATWG
`(req: Request) => Promise<Response>` handler suitable for Bun, Deno, Cloudflare Workers,
and Node.

### Enumerating projections

**MCP** and (planned) **OpenAPI, GraphQL, generated client**: flatten all leaves in the
tree to produce a surface — one tool / one schema object / one client method per leaf.

`toTools(node, opts?)` in `packages/mcp/src/project.ts` walks the tree and emits one
`McpTool` per leaf. Tool names are underscore-joined from tree position
(`catalog_search`, `books_bookId_get`). The `meta.mcp.name` field is a full override;
`meta.mcp.segment` overrides the per-node name contribution.

For both modes, the projection reads `meta.tags` via `effectiveTags` to derive
projection-specific semantics (HTTP verb, MCP annotation hints). One authoring source,
consistent behavior across surfaces.

### Codegen bridge

Projections that need runtime input schemas (MCP, OpenAPI) cannot read TypeScript types
at runtime — types are erased. `@rhi-zone/fractal-codegen` (`packages/codegen`) bridges
this gap: `extractToolSchemas(entryFile)` uses the TypeScript compiler API to walk the
exported node tree at the AST level, derive JSON Schema from each leaf's first parameter
type, and extract leading JSDoc text. The resulting `SchemaMap` is passed to `toTools` as
`opts.schemas`.

---

## Quick reference

| Symbol | Package | What it is |
|---|---|---|
| `Node` | `@rhi-zone/fractal-core/node` | The one tree node type |
| `Handler<I,O>` | `@rhi-zone/fractal-core/node` | A plain callable: `(input: I) => O \| Promise<O>` |
| `Meta` | `@rhi-zone/fractal-core/node` | Open metadata bag |
| `op(fn, ...meta)` | `@rhi-zone/fractal-core/node` | Construct a leaf node |
| `node({ children?, meta? })` | `@rhi-zone/fractal-core/node` | Construct a branch node |
| `service(instance, opts?)` | `@rhi-zone/fractal-core/node` | Lower a class instance to a branch node |
| `param(name, subtree)` | `@rhi-zone/fractal-core/node` | Parameterized child edge |
| `mergeMeta(...metas)` | `@rhi-zone/fractal-core/node` | Deep-merge meta bags, later wins |
| `Tags` | `@rhi-zone/fractal-core/tags` | Three-valued behavioral tag dict |
| `resolveTags(tags)` | `@rhi-zone/fractal-core/tags` | Apply the implication lattice |
| `effectiveTags(path)` | `@rhi-zone/fractal-core/tags` | Closest-wins tag inheritance down a path |
| `dispatch(node, segs, input)` | `@rhi-zone/fractal-core/node` | Minimal runtime tree walker |
| `buildRoutes(node)` | `@rhi-zone/fractal-http/project` | Compile tree → flat `Route[]` |
| `verbFromTags(meta)` | `@rhi-zone/fractal-http/project` | Derive HTTP verb from the tag lattice |
| `makeRouter(routes)` | `@rhi-zone/fractal-http/project` | Runtime verb+path+conditions dispatcher |
| `createFetch(node, opts?)` | `@rhi-zone/fractal-http/preset` | OOTB HTTP handler (WHATWG `Request→Response`) |
| `toTools(node, opts?)` | `@rhi-zone/fractal-mcp/project` | Enumerate tree → flat `McpTool[]` |
| `DispatchMarker` | `@rhi-zone/fractal-http/project` | `"method"` \| header \| query \| contentType dispatch |
