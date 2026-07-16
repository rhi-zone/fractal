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
