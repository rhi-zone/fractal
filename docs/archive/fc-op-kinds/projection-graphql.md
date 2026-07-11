# GraphQL projection — mental model

What the GraphQL projection encodes about an operation, grounded in server-less's
real `#[graphql]` macro and the GraphQL spec. Purpose: separate distinctions that
RECUR across projections (→ agnostic op-core keys) from GraphQL-only ones
(→ `graphql:`-namespaced keys).

## Grounding source 1 — server-less `#[graphql]` (real code)

Repo: `/home/me/git/rhizone/server-less/`. Three proc macros, all behind the
`graphql` crate feature, in `crates/server-less-macros/src/`:

- `#[graphql]` → `graphql.rs`
- `#[graphql_enum]` → `graphql_enum.rs`
- `#[graphql_input]` → `graphql_input.rs`

**Key finding: the projection is convention-driven, not metadata-key-driven.**
There are NO declarative `query:` / `mutation:` / `subscription:` / `field:` /
`type:` / `nullable:` string-literal keys read from map-style op metadata.
Everything is inferred from Rust method names and type signatures, plus a shared
`#[server(...)]` attribute for per-method control.

What it actually consumes / infers (cited, `graphql.rs`):

- **Query vs Mutation** — inferred by method-name prefix (lines 658–669). Queries
  match `get_ / fetch_ / read_ / list_ / find_ / search_ / count_ / exists_ / is_ /
  has_`; everything else is a Mutation. **No subscription support at all.**
- **GraphQL return type** — inferred from the Rust return type (lines 816–883):
  `Option<T>` → nullable, `Result<T,E>` → non-null, `Vec<T>` → list, `()` →
  `Boolean`; scalar map for `String / Int / Float / Boolean / DateTime / UUID /
  Url / JSON`; unknown → `JSON` fallback.
- **Arguments** — Rust method params become GraphQL field args. Context params
  (`server_less::Context`) are partitioned out and injected at the call site, NOT
  exposed as args. Child services (methods returning `&ChildService`) are treated
  as composition/mount points, not fields.
- **Field naming** — method names → camelCase field names.
- **Per-method control** — via the shared `#[server(...)]` attribute:
  `#[server(skip)]` (excluded entirely), `#[server(hidden)]` (excluded from SDL
  but still callable). Attribute args parsed at lines 101–157: `name = "..."`,
  `enums(...)`, `inputs(...)`.

Emits (on the impl type): `graphql_schema() -> Schema`, `graphql_router() ->
Router` (GET playground + POST `/graphql`), `graphql_sdl() -> String`,
`graphql_openapi_paths()`, plus private resolvers `__graphql_resolve_query /
mutation` and child-composition mergers. Schema root types named
`{Struct}Query` / `{Struct}Mutation`, built via `async_graphql::dynamic`.

Companion macros: `#[graphql_enum]` (unit-variant enums → `dynamic::Enum`,
variants → `SCREAMING_SNAKE_CASE`, doc comments → descriptions);
`#[graphql_input]` (named-field structs → `dynamic::InputObject`, fields →
camelCase, `Option`/`Vec` nullability, serde_json round-trip).

Adjacent: `http.rs` (`#[serve(graphql)]` integration), `openapi.rs` (consumes
`graphql_openapi_paths`), `server-less-parse/src/lib.rs` (`MethodInfo`,
`extract_methods`, `partition_methods` — the raw op-shape the expander reads).

**Takeaway:** server-less GraphQL classification and typing derive from
method-name prefix + Rust type signature, never from declarative metadata. So the
"where could this come from" answer for server-less is always: *inferred from the
Rust type/signature*, sometimes overridden by the `#[server(...)]` attribute.

## Grounding source 2 — the GraphQL spec (real model)

Concepts GraphQL fixes about an operation:

- **Operation type**: `query` (read), `mutation` (write), `subscription`
  (stream). Spec §6.2.1: query fields "are conceptually side-effect-free" and MAY
  be executed in parallel. §6.2.2: mutation top-level fields MUST be executed
  serially, in order, because they cause observable side-effects. §6.2.3:
  subscription establishes a long-lived event stream. This split IS the
  read/write/safety axis, enforced by execution semantics.
- **Types / fields / resolvers**: every op resolves to a field on a root object
  type; the field has a resolver and lives at a named position in the type graph.
- **Arguments**: fields take named, typed arguments with their own nullability.
- **Nullability**: every type is nullable (`T`) or non-null (`T!`); lists `[T]`
  compose. Non-null propagates errors up.
- **Return type as a graph type**: a field returns a named type in the schema
  graph (object / scalar / enum / list), enabling nested field selection.

## The concepts, classified

### 1. Operation type: query vs mutation vs subscription — **[LIKELY-AGNOSTIC]**

This is the single most important cross-protocol signal. **query-vs-mutation IS
the read-vs-write / safety axis.** The spec forbids side-effects in queries and
mandates serial execution of mutations (§6.2.1–6.2.2) — this is not a
GraphQL-cosmetic label, it is the same safe/unsafe, idempotent-vs-not distinction
that:

- **HTTP** encodes as GET/HEAD (safe) vs POST/PUT/PATCH/DELETE, and the
  idempotency of PUT/DELETE (RFC 9110 §9.2.1–9.2.2).
- **CLI** encodes as read commands vs mutating commands (dry-run, `--force`).
- **MCP** encodes as `readOnlyHint` / `destructiveHint` / `idempotentHint` tool
  annotations.
- **gRPC** — no built-in safety marker, but read vs write is a universal service
  distinction.

server-less confirms this is inferable, not authored: it derives query-vs-mutation
purely from a verb-prefix allowlist (`graphql.rs` lines 658–669). That the same
read/write split can be recovered from method-name convention, from HTTP verb,
from MCP hint, and from CLI shape is exactly the recurrence signal → this belongs
in the agnostic op core as a **safety / read-vs-write** key, and each projection
maps it to its own vocabulary (GraphQL query/mutation, HTTP method class, MCP
hints).

**subscription = streaming — also [LIKELY-AGNOSTIC].** The "produces a stream of
results over time" distinction recurs: gRPC server-streaming, HTTP SSE /
chunked / websockets, AsyncAPI channels, MCP has no first-class equivalent but
the concept is general. So a **streaming** op-core key projects to `subscription`
in GraphQL exactly as it projects to a streaming method in gRPC. (server-less
does NOT implement subscriptions, so this is spec-grounded only.)

### 2. Field / resolver placement in the type graph — **[GRAPHQL-SPECIFIC]**

Which object type a field hangs off, its position in the graph, and how nested
selection traverses it, is GraphQL's own composition model. server-less derives
it from Rust structure (impl type → root, child services → mount points), but the
*concept of a navigable type graph with field-level resolvers* has no clean
recurrence in HTTP/CLI/MCP/gRPC (each of which is flat request→response). →
`graphql:`-namespaced. Naming (camelCase field names, `{Struct}Query` root names)
is likewise GraphQL-specific presentation.

### 3. Nullability (`T` vs `T!`, list nesting) — **[GRAPHQL-SPECIFIC]**

The nullable/non-null distinction with error-propagation semantics is a GraphQL
type-system feature. The *underlying* optionality (`Option<T>` in Rust,
"required field" elsewhere) is agnostic and other schema projections
(JSON-Schema `required`, OpenAPI `nullable`, protobuf optionality) also encode it
— so raw optionality of a param/return MAY be an agnostic property. But
GraphQL's *specific* nullability semantics (error bubbling, `!` on the graph
type) are GraphQL's projection of that. Classify the semantics as
GRAPHQL-SPECIFIC; note the raw optionality underneath is a candidate agnostic
signal shared with other schema projections.

### 4. Field selection (client picks subfields) — **[GRAPHQL-SPECIFIC]**

That the caller chooses which subfields to return is unique to GraphQL among the
listed protocols. No recurrence → `graphql:`-namespaced.

### 5. Return type as a named graph type — **[GRAPHQL-SPECIFIC]**

Mapping a return value to a named schema type for nested traversal is GraphQL's
model. The *raw return type* is an agnostic op property (every projection needs
to know what an op returns), but its rendering as a graph-navigable type is
GraphQL's. server-less infers this from the Rust return type (lines 816–883).

### 6. Arguments — **[LIKELY-AGNOSTIC input surface, GRAPHQL-SPECIFIC framing]**

That an op takes named, typed inputs recurs everywhere (HTTP query/body params,
CLI flags/args, MCP tool inputSchema, gRPC request message). The op-core clearly
has an **inputs / parameters** concept. GraphQL's specific rendering (args on a
field, input-object types, arg-level nullability) is its projection of that
agnostic input surface. server-less confirms the shared origin: the SAME Rust
method params feed GraphQL args, HTTP params, and every other projection, with
Context partitioned out uniformly.

## Summary table

| Concept | Classification | Cross-protocol recurrence |
|---|---|---|
| query vs mutation | **LIKELY-AGNOSTIC** | = read/write **safety** axis: HTTP GET-vs-POST, MCP readOnlyHint, CLI read-vs-mutate |
| subscription | **LIKELY-AGNOSTIC** | = **streaming**: gRPC server-streaming, SSE/ws, AsyncAPI channels |
| arguments / inputs | **LIKELY-AGNOSTIC** (surface) | inputs recur everywhere; GraphQL arg framing is its own |
| raw return type | LIKELY-AGNOSTIC (the value) | every projection needs op return |
| raw optionality | candidate agnostic | shared with JSON-Schema/OpenAPI/protobuf `required` |
| nullability semantics (`T!`, error bubbling) | **GRAPHQL-SPECIFIC** | — |
| field/resolver graph placement | **GRAPHQL-SPECIFIC** | — |
| field selection (subfield picking) | **GRAPHQL-SPECIFIC** | — |
| return-as-named-graph-type | **GRAPHQL-SPECIFIC** | — |

## Sources

- server-less `#[graphql]`: `/home/me/git/rhizone/server-less/crates/server-less-macros/src/graphql.rs`
  — query/mutation prefix inference (lines 658–669), return-type→GraphQL-type
  inference (lines 816–883), attribute-arg parse (lines 101–157). Companions
  `graphql_enum.rs`, `graphql_input.rs`. Op-shape source
  `server-less-parse/src/lib.rs`.
- GraphQL spec: §6.2.1 (query parallel, side-effect-free), §6.2.2 (mutation
  serial, side-effects), §6.2.3 (subscription stream); §3 type system
  (nullability, lists).
- Cross-protocol safety anchors: RFC 9110 §9.2.1–9.2.2 (HTTP safe/idempotent);
  MCP tool annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint`).
