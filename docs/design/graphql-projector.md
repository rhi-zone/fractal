# GraphQL API projector — design decisions

Settled decisions for `graphql-api-projector`, following the same
`Node => ProtocolType` projection pattern as `http-api-projector`,
`cli-api-projector`, and `mcp-api-projector`. Companion to
`docs/design/decisions.md` (general log) and
`docs/archive/fc-op-kinds/projection-graphql.md` (earlier mental-model survey
that classified query/mutation/subscription as the agnostic safety/streaming
axes projected into GraphQL's vocabulary — the decisions below build on that
classification, they don't re-derive it).

---

## Field shape: nested Query, flat Mutation

**Decision:** Query fields from branch nodes produce nested GraphQL namespace
types (e.g. `query { books { list } }`). Mutation fields are flat with
camelCase-joined names (e.g. `mutation { booksCreate(...) }`). Overridable via
`meta.graphql.namespace` (on a branch) or `meta.graphql.operation` (on a leaf).

**Reasoning:** GraphQL's data model is a graph — nested namespaces for queries
reflect domain structure and are the natural idiom; it's how hand-written
GraphQL APIs are conventionally organized. However, the GraphQL spec (§6.2.2)
mandates that top-level mutation fields execute serially, giving clients
ordering guarantees for side-effecting operations; §6.2.1 permits query fields
to execute in parallel, consistent with them being conceptually
side-effect-free. Nesting mutations under a namespace object moves the "real"
fields one level down, where they resolve as children of a single parent — the
spec allows sibling fields of one parent to resolve in parallel, which would
silently break the serial-execution guarantee mutations depend on. Flat
mutations keep every mutation field at the top level, preserving spec-correct
ordering semantics. The alternative — nesting mutations too, for symmetry with
queries — was rejected because it trades a real correctness guarantee (ordered
side effects) for cosmetic consistency. The override exists because some
authors may want nested mutations anyway (e.g. a client library that doesn't
rely on cross-field ordering) and understanding the tradeoff is a legitimate
reason to opt out of the default.

---

## Execution engine: graphql-js

**Decision:** Use the `graphql` npm package (graphql-js, the GraphQL Foundation
reference implementation) for schema building (`buildSchema`) and query
execution (`execute`). SDL generation stays in-house, via
`packages/type-ir/src/graphql.ts`.

**Reasoning:** The projector's own job is exactly what schema-builder
libraries like Pothos or Nexus do — derive a GraphQL schema from code — and
that part is already covered by the projector's `Node => GraphQL` mapping and
the existing SDL generation in `type-ir`. The remaining question is narrower:
who parses query documents and executes them against the schema + resolvers?
graphql-js is minimal and unopinionated about transport, unlike Apollo Server,
whose bundled HTTP transport carries its own opinions (context construction,
response shaping, landing-page middleware) that conflict with fractal's
convention of the projector owning transport via its own preset
(`server.ts`/`presets.ts`), not a third-party server framework. Hand-rolling
an executor was considered and rejected: it would buy zero-dependency purity,
but the GraphQL spec's execution semantics — fragment merging, directive
evaluation (`@skip`/`@include`), abstract-type resolution, introspection — are
dense enough that reimplementing them is high cost for no type-safety gain,
since the projector already controls resolver types at projection time
regardless of which engine executes them. Execution is treated as a hot path
worth benchmarking (`resolve.bench.ts`), following the same discipline as
HTTP's compiled router matchers — if graphql-js becomes a measured bottleneck,
the dispatch layer around it gets hand-tuned rather than swapping the engine
outright. Pre-parsed / cached query plans for known operation shapes are the
likely first optimization if that need materializes.

---

## Subscriptions: included from the start

**Decision:** Support Query, Mutation, and Subscription from the first
implementation, not Query/Mutation now with Subscription deferred.
`tags.streaming === true` on a leaf projects to a Subscription root field.

**Reasoning:** Subscriptions are a first-class GraphQL operation type (spec
§6.2.3), not an optional extension, and the api-tree already has the
machinery this needs — `AsyncIterable` detection and the `StreamEffect` DU are
already shared across HTTP (SSE), MCP (`notifications/progress`), and CLI
(JSONL streaming). Adding a fourth column to that existing streaming
interpretation table is incremental, not a new subsystem. The transport for
subscriptions (graphql-ws over WebSocket) is a separate concern, kept in
`presets.ts` the same way HTTP's SSE transport detail lives in its own preset
layer rather than in `server.ts`'s protocol-agnostic core — this keeps
`server.ts` itself transport-agnostic. Deferring subscriptions was considered
(ship Query/Mutation first, add streaming later) and rejected: it would
produce a projector that can't fully replace HTTP+SSE for streaming use
cases, creating exactly the kind of partial-migration situation the codebase
avoids elsewhere (see CLAUDE.md's "finish migrations before building on top"
principle) — better to land the third root type alongside the other two than
leave a known gap for a later pass to backfill.

---

## Operation type derivation: tag inference with override (compositional)

**Decision:** `resolveTags(meta.tags).readOnly === true` → Query,
`tags.streaming === true` → Subscription, else → Mutation.
`meta.graphql.operation: "query" | "mutation" | "subscription"` overrides tag
inference when present.

**Reasoning:** This mirrors HTTP's verb derivation exactly: tag inference
supplies the default, and a projector-specific meta directive
(`{kind:"verb"}` for HTTP, `meta.graphql.operation` here) overrides it when
present. That compositional shape — an inference layer plus an escape-hatch
override layer — is the codebase's established convention for
conventions-not-contracts (see `design-philosophy.md` § Conventions, not
contracts): the tree stays silent by default and lets the projector infer,
but never traps an author who needs to diverge from the inferred default. The
query-vs-mutation split is itself the general safety/read-write axis (the
same one HTTP encodes as GET vs POST/PUT/PATCH/DELETE and MCP encodes as
`readOnlyHint`) projected into GraphQL's vocabulary, so reusing the same
`readOnly` tag HTTP already reads is not a new signal — it's the existing
signal read by a new projector. The override matters concretely: an operation
might be `readOnly` in the agnostic/HTTP sense (no observable side effect a
client needs to worry about) but still need GraphQL's serial-execution
guarantee for some other reason — forcing it into Mutation without touching
how HTTP or MCP interpret the same tag. A tags-only design with no override
was rejected because it would make tag semantics do double duty across
protocols with no way to diverge when a protocol's specific execution
contract calls for it.

---

## Store naming: reuse `argument` from MCP

**Decision:** GraphQL field arguments use the existing `argument` store name
(already declared in MCP's `StoreRegistry` augmentation), not a new
`graphqlArg` store.

**Reasoning:** GraphQL field arguments and MCP tool arguments are semantically
identical — a flat, named-argument bag decoded before the handler runs — so
there's no real distinction to encode in a separate name. Reusing the store
name means any cross-projector middleware already written against
`stores.argument` (e.g. an auth check reading a specific argument) works for
GraphQL for free, with no GraphQL-specific rewrite. TypeScript's declaration
merging on `StoreRegistry` handles the re-declaration cleanly — merging the
same store name from two packages is idempotent, not a conflict, precisely
because `StoreRegistry` was designed as an augmentable interface (see
`design-philosophy.md` § Extensible DU + interpreter pattern, which the store
registry follows even though it isn't itself a DU). The alternative — a fresh
`graphqlArg` store — was considered because it would keep each projector's
store surface visually distinct at a glance, but that's a distinction without
a semantic difference here, and it would silently break the free
interoperability middleware gets from a shared name for zero benefit.

---

## Field name derivation: camelCase join

**Decision:** Branch paths join into field names using camelCase — e.g.
`books.list` → `booksList` for a flat mutation field, or `list` when nested
under a `books` namespace type for a query field.

**Reasoning:** camelCase is the GraphQL field-naming convention (every major
hand-written schema and every schema-builder library — Pothos, Nexus,
async-graphql's own `#[graphql]` macro per the earlier survey — emits
camelCase field names), so deriving it automatically keeps generated schemas
indistinguishable from hand-written ones. This is the same structural move as
MCP's underscore-join (`users.get` → `users_get`) and HTTP's path-segment
join, adapted to GraphQL's own naming idiom rather than reusing either of
theirs verbatim — each projector transliterates the same tree path into the
separator/casing convention its target protocol actually uses. The
transformation runs at the same point in the projection pipeline as MCP's
underscore-join: during the `Node` walk in `project.ts`, so naming is derived
structurally from tree position rather than requiring authors to name fields
by hand.
