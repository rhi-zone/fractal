# Routing and tree transforms — settled design

## API tree ≠ route tree

The skeleton (API tree) is organized by domain — children are operations, not
path segments. The HTTP route tree is a separate tree organized by protocol
(paths, methods). The projector produces the route tree from the API tree.

Two operations that share an HTTP path (e.g. `GET /users` and `POST /users`)
are different nodes in the API tree (`list` and `create` under `users`). The
"same path, different methods" problem only exists in the route tree, never
in the skeleton.

## Tree transforms are functions

A tree transform is a function `Tree => Tree`. No special status, no pipeline,
no framework. Multiple transforms can be chained — they're endofunctors.

Three roles:

1. **Inline metadata** — one mechanism for explicit control. The user sets
   `meta.http.*` (or any projection-specific metadata) directly on operations.
2. **Convention transforms** — optional `Tree => Tree` functions that fill in
   metadata based on naming conventions (REST/CRUD, RPC-style, etc.). These
   are subjective — multiple can exist, none is privileged. They respect
   already-set inline metadata (don't overwrite).
3. **The projection transform** — the builtin `Tree => Tree` that reads
   `meta.http.*` and reshapes the API tree into the HTTP route tree. This is
   the HTTP projector's own transform, not a convention.

## Structural transform primitive: relative node placement

The structural transformation from API tree to route tree is: each node
specifies where it goes in the output tree relative to where it is now.

Encoding: a relative path string. This is stringly-typed, which is acceptable
because it's input to a transform function, not part of the skeleton's
structure.

- `.` — stay (identity)
- `./*` — down under a new wildcard segment
- `..` — up to parent
- `../../admin` — up two, under `admin`

`*` is the wildcard segment marker — universally "wildcard," not a valid
path segment or identifier in any ambiguous context. The parameter name comes
from the node's own metadata or the operation's input type, not from the path
encoding.

Default placement: identity (same position). Metadata (verb, status, parameter
binding) is separate from structural transforms — just properties on nodes.

### Motivating example

```
API tree:                    HTTP route tree:
users/                       /users
  list   (stay)                GET  → listUsers
  create (stay)                POST → createUsers
  get    (down under *)      /users/*
  update (down under *)        GET  → getUser
  delete (down under *)        PUT  → updateUser
                               DELETE → deleteUser
```

Operations that land at the same position group naturally. Method assignment
is metadata, not a tree operation.

## Route tree type

The HTTP route tree is a separate type from `Node`. The API tree uses `Node`;
the route tree uses `HttpRoute` with explicit method dispatch:

```typescript
type HttpRoute = {
  methods?: Record<string, { handler: Handler; meta: Meta }>
  children?: Record<string, HttpRoute>
  fallback?: { name: string; subtree: HttpRoute }
  meta: Meta
}
```

Each projection can have its own output type. CLI would have its own, MCP its
own. The user never writes these types directly — transforms produce them.

## Transform pipeline

### 1. Naive transform: `Node => HttpRoute`

Every child in `children` becomes a path-segment child. Every handler becomes
a single `POST` entry in `methods`. No inference, no convention — just a
mechanical shape change. This is the baseline the rewriters start from.

### 2. Rewriters: `HttpRoute => HttpRoute`

DU-based rewriters, configured by the user at construction time, reshape the
route tree. Each rewriter reads DU directives from `meta.http` and modifies
the route tree accordingly:

- **Method rewriter**: reads `{ kind: "method", value: "GET" }` directives,
  changes the method key in `methods`
- **Placement rewriter**: reads `{ kind: "place", path: "*" }` directives,
  moves nodes in the route tree
- **Response rewriter**: reads `{ kind: "response", status: 201 }` directives,
  wraps the handler to produce the correct HTTP response (function composition,
  not metadata — the override is materialized into the handler itself)

### 3. Composition everywhere

Response overrides are handler wrapping. Method assignment is tree rewriting.
Placement is tree rewriting. No special-casing — everything is either a
`Tree => Tree` transform or function composition on the handler.

## `meta.http` shape

On API tree nodes, `meta.http` is an object with:

- **Named properties** (property bag): HTTP-specific metadata that isn't a
  transform instruction — description, deprecation, docs URL, rate limit config.
  Open via declaration merging.
- **`directives` array** (DU): transform instructions for the rewriters.
  Each directive is a DU variant (`{ kind: "method", value: "GET" }`,
  `{ kind: "place", path: "*" }`, `{ kind: "response", status: 201 }`, etc.).
  Extensible via declaration merging on the DU.

Convention transforms (`Node => Node` or `HttpRoute => HttpRoute`) fill in
directives where they're not set. Inline directives take precedence (convention
transforms skip already-set directives).

Declaration merging by the user happens next to the API tree definition so
that `meta.http` type-checks at the authoring site.

## Open items

### Constructor sugar (DX)

The authoring surface needs convenience constructors that make DX competitive
with Hono/Elysia — e.g., helpers that set common directive patterns in one
call. Shape TBD; the requirement is "as good or better DX than incumbents."

### Input sources, validation, transformation

How handler inputs are sourced from protocol-specific locations (HTTP: query,
body, path segments, headers, cookies; CLI: params, env vars) and
validated/transformed. Not yet designed — separate from the structural
routing model.
