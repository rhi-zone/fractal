# Handoff — 2026-07-17 session: identity settled, routing model built

## Identity (settled)

Fractal is a codebase compression substrate. It gives codebases a skeleton —
the central structure supporting the entire app — as a single source of truth,
with everything else derived from it.

The "Parsec-style combinator composition" label was aspirational naming that
didn't match the built code. The actual pattern: inspectable declarations
(data) interpreted by projectors to produce surfaces. See
`docs/design/invariants.md` § Identity.

This resolved two long-standing open threads:
- **Combinator identity gap** — was a symptom of unclear self-description,
  not a structural deficiency
- **"Is it too general?"** — dissolved. The scope is bounded by what the
  codebase's skeleton needs to express.

## Routing model (settled and built)

### API tree ≠ route tree

The skeleton (API tree) is organized by domain — children are operations, not
path segments. Protocol-specific trees (HTTP route tree, CLI command tree) are
projections produced by `Node => ProtocolType` transforms — they cross a type
boundary, not endofunctors. Convention transforms (`Node => Node`) and
rewriters (`ProtocolType => ProtocolType`) are the endofunctors in this
pipeline.

### HttpRoute type

The HTTP route tree has its own type with explicit method dispatch:

```typescript
type HttpRoute = {
  methods?: Record<string, { handler: Handler; meta: Meta }>
  children?: Record<string, HttpRoute>
  fallback?: { name: string; subtree: HttpRoute }
  meta: Meta
  pipeline?: Pipeline
}
```

### Transform pipeline

1. **Naive transform** (`Node => HttpRoute`): every child → path segment,
   every handler → POST. Mechanical shape change.
2. **Rewriters** (`HttpRoute => HttpRoute`): DU-based, read directives from
   `meta.http.directives` — `applyMethods`, `applyMoveTo`, `applyResponse`.
3. Response overrides materialized as handler wrapping (composition).

### meta.http shape

Property bag (named properties for HTTP metadata) + `directives` DU array
(transform instructions). Convention transforms fill in directives where
not set; inline takes precedence.

### Relative node placement

Structural transform primitive: each node specifies where it goes via a
relative path string. `*` = wildcard segment, `..` = up, `/abs/path` =
absolute. Stringly-typed — acceptable because it's transform input, not
skeleton structure.

### Interceptable pipeline

Request/response lifecycle decomposed into typed stages:
```
Req → [Req transforms] → decode → [T transforms] → handler → [U transforms] → encode → [Res transforms] → Res
```
`decode`/`encode` are the symmetric protocol boundary. Every stage has meta
access. Pipeline lives on HttpRoute.

## What was built

### Code (committed)

- `packages/http-api-projector/src/route.ts` — `HttpRoute` type, `naiveTransform`,
  `applyMethods`, `applyMoveTo`, `applyResponse`, `composeTransforms`,
  `makeRouterFromRoute`. 23 tests, all passing. Commit `d0f1329`.
- Design docs updated: `invariants.md` (Identity section),
  `routing-and-transforms.md` (full routing model + DX),
  `operation-layer-design.md` (reframed under settled identity),
  `design-philosophy.md` (extracted from CLAUDE.md),
  `TODO.md` (multiple threads resolved/reframed).

### In-flight (may or may not have landed by handoff)

Two parallel agents were spawned:
1. **DX sugar**: `api()` constructor, `http.*` meta bundles, `crud()`,
   `httpProjection()` preset, `HttpMethods` interface
2. **Pipeline**: interceptable stages on HttpRoute, updated
   `makeRouterFromRoute`

Check git log to see if these committed. If not, the design is in
`docs/design/routing-and-transforms.md` — implement from there.

## DX direction (settled)

- `api(children, opts?)` — positional children, opts for meta/fallback
- `http.get`/`http.post`/etc — meta bundles for method directives
- `crud(handlers)` — convention constructor, partial handlers accepted
- `httpProjection(tree, opts?)` — pre-composed preset, configurable transforms
- `HttpMethods` — extensible interface via declaration merging
- DX is competitive with Hono for HTTP, then Hono stops. Fractal keeps
  going: CLI, JSON-RPC, MCP, OpenAPI — same skeleton, new projector.

## What's open

### Input parsing / decode

How `decode` sources T from protocol-specific locations (HTTP: query, body,
path segments, headers, cookies; CLI: params, env). Placeholder for now:
`await req.json()`. Separate from the structural routing model.

### Old HTTP projector coexistence

The new HttpRoute path was added alongside the existing direct tree-walk
dispatcher (`candidatesForUrl` + `makeRouter(Node)`). The old path handles
attribute dispatch (header/query/contentType), match conditions, fallback
slugs, `legacyPath` — features the new model doesn't yet cover. Needs
careful migration, not a flag-day rewrite.

### Operation layer design (§3-§7)

`docs/design/operation-layer-design.md` has open questions:
- §3: Operations as nodes vs separate type
- §5: Handler error model (throws vs Result)
- §6: Builder API shape
- §7: service() as operation factory

### Convention transforms

REST/CRUD as `Tree => Tree` — direction settled (conventions are just
functions, optional, not privileged), not implemented.

## Session transcripts

- `/home/me/.claude/projects/-home-me-git-rhizone-fractal/37f266e0-49b6-49de-b2f2-1d9cf68802bd.jsonl`
  — this session (2026-07-17): identity, routing model, DX

## Pointers

- Identity: `docs/design/invariants.md` § Identity
- Routing model: `docs/design/routing-and-transforms.md`
- Operation layer: `docs/design/operation-layer-design.md`
- Design philosophy: `docs/design/design-philosophy.md`
- Type layer (prior session): `docs/design/handoff-2026-07-16-type-layer.md`
- TODO.md — open threads
