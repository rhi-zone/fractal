# Router model — verbs, tags, and the tree

## The idiomatic path: tags

The idiomatic way to express HTTP semantics in a fractal tree is through the
`meta.tags` bag (`readOnly`, `idempotent`, `destructive`). A tag-shaped tree
reads as protocol-agnostic — any projection (HTTP, MCP, CLI, OpenAPI) derives
its surface from the same authored intent, so one authoring lights up every
projection consistently.

The tag lattice drives verb selection:

| tags                                  | HTTP verb |
| ------------------------------------- | --------- |
| `readOnly: true`                      | GET       |
| `idempotent: true, destructive: true` | DELETE    |
| `idempotent: true`                    | PUT       |
| (default)                             | POST      |

## When verbs are fine

Verbs are first-class and available via `meta.http.verb` override — use them
when you need HTTP-specific precision that the tag lattice cannot express (an
unusual verb, a legacy contract, a deliberate deviation from the tag inference).
The override wins over all tag-derived verb selection.

## The soft smell

A tree that is wall-to-wall raw `meta.http.verb` overrides is a soft smell: it
means the tree speaks HTTP exclusively and throws away the cross-protocol signal
that makes fractal worth using. It is not forbidden — sometimes an API is
genuinely HTTP-only — but it is worth noticing, because a tag-shaped equivalent
would be richer at no authoring cost.
