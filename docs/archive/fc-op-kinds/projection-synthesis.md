# Projection Synthesis — Agnostic Op Metadata Key Set

> Mined from six projection mental-model documents (HTTP, CLI, MCP, gRPC, GraphQL, WS).
> Each document was grounded in real server-less macro source code, then classified
> distinctions as [LIKELY-AGNOSTIC] or [X-SPECIFIC].
>
> **Rule applied:** a distinction that ≥2 projections independently encode → AGNOSTIC
> op-core key (state once, projections derive). A distinction only one projection
> encodes → stays in that projection's namespace.

---

## 1. The Matrix

Columns are the six projections. Each cell names how that projection encodes the
distinction, or "—" if it does not. The final column marks whether the distinction
qualifies as agnostic (≥2 encodings).

| Distinction | HTTP | CLI | MCP | gRPC | GraphQL | WS | Agnostic? |
|---|---|---|---|---|---|---|---|
| **read-vs-write / safety** | GET vs POST/PUT/DELETE (name-prefix heuristic in `infer_http_method`) | read vs mutating subcommand (dry-run / confirm-prompt concept; not generated) | `readOnlyHint` in `ToolAnnotations` | `NO_SIDE_EFFECTS` in proto `idempotency_level` | `query` vs `mutation` op type (prefix heuristic in `graphql.rs:658–669`) | — | **YES** (HTTP, CLI, MCP, gRPC, GraphQL — 5) |
| **idempotency** | PUT/DELETE (idempotent) vs POST (not), via verb inference | re-run safety (`--dry-run` concept, not wired) | `idempotentHint` in `ToolAnnotations` | `IDEMPOTENT` in proto `idempotency_level` | query idempotent by convention (implicit) | — | **YES** (HTTP, MCP, gRPC — 3 explicit) |
| **destructive** | DELETE (implied by verb) | confirmation-prompt concept for destructive ops (noted as unimplemented, [LIKELY-AGNOSTIC]) | `destructiveHint` in `ToolAnnotations` | — | — | — | **YES** (HTTP, CLI, MCP — 3) |
| **openWorld / external-reach** | caching/sandboxing/permissioning concern noted as latent need | — | `openWorldHint` in `ToolAnnotations` | — | — | — | **YES** (MCP explicit + HTTP latent — 2) |
| **streaming cardinality** | `impl Stream<Item=T>` / `impl Iterator` → SSE (`http.rs:1166–1198`) | `is_iterator` flag → `--jsonl` line mode (`cli.rs:2140–2157`) | not emitted (spec implies subscription analog) | server-streaming RPC shape from `ret.is_stream` (`grpc.rs`) | `subscription` op type (not implemented in server-less) | `method.return_info.is_stream` flag recognized (`ws.rs:945`) | **YES** (HTTP, CLI, gRPC, GraphQL, WS — 5) |
| **op name / wire name** | method name → kebab path segment; `wire_name_or(kebab)` (`openapi_gen.rs:227–249`) | method name → kebab subcommand; `wire_name_or(kebab)` (`cli.rs:597–599`) | method name → tool name; `wire_name_or(identity)` (`mcp.rs:401–443`) | method name → UpperCamelCase RPC (`grpc.rs`) | method name → camelCase field (`graphql.rs`) | method name → JSON-RPC `"method"` field; `wire_name_or(identity)` (`ws.rs:373,929`) | **YES** (all 6) |
| **description / help text** | doc comments → OpenAPI `summary` / `description` | doc comments → clap `.about()` / `.after_help()` (`cli.rs:1422–1451`) | doc comments → tool `"description"` (`mcp.rs:407–410`) | doc comments → inline `//` before `rpc` line (`grpc.rs`) | doc comments → field description in SDL | doc comments → (shared source; implicit) | **YES** (HTTP, CLI, MCP, gRPC, GraphQL — 5+) |
| **param optionality** | `Option<T>` → not required in query / body schema | `Option<T>` → `.required(false)` flag (`cli.rs:1722–1735`) | `Option<T>` → excluded from `required[]` in `inputSchema` (`mcp.rs:419–443`) | `Option<T>` → proto3 `optional` field (`grpc.rs`) | `Option<T>` → nullable arg / nullable return | `Option<T>` → excluded from required in JSON params | **YES** (all 6) |
| **param multiplicity** | `Vec<T>` → repeated query params / JSON body array | `Vec<T>` → `ArgAction::Append` + comma-delimited (`cli.rs:1693–1707`) | `Vec<T>` → `"type":"array"` in `inputSchema` (`mcp.rs:419–443`) | `Vec<T>` → `repeated` field (`grpc.rs`) | `Vec<T>` → `[T]` list type | `Vec<T>` → array in JSON params | **YES** (all 6) |
| **hierarchical grouping / static mount** | `&T` return → `nest_service`; `HttpMount` trait (`http.rs:354–378`) | `&T` return → subcommand group; `CliSubcommand` (`cli.rs:1489–1519`) | `&T` return → tool-name namespace prefix (`mcp.rs`) | struct → service; package → namespace (`grpc.rs`) | `&T` return → mount point in type graph (`graphql.rs`) | `&T` return → `WsMount` dispatch tree (`lib.rs:272–289`) | **YES** (all 6) |
| **slug mount (parameterized group)** | `&T` + params → path params before nested resource (`openapi_gen.rs:255–317`) | `&T` + params → positional args before delegate (`cli.rs:1521–1570`) | `&T` + params → injected schema params in prefix namespace | not modelled in server-less gRPC projection | composition/mount points (`graphql.rs`) | `WsMount` (no slug injection) | **YES** (HTTP, CLI — explicit; others partial) |
| **skip / not exposed** | `#[route(skip)]`; checks `has_server_skip` (`openapi_gen.rs:42–44`) | `#[server(skip)]` + `#[cli(skip)]` (`cli.rs:311–333`) | `#[server(skip)]` fully excludes (`server_attrs.rs`) | implied (all projections share `has_server_skip`) | `#[server(skip)]` (`graphql.rs:101–157`) | `#[server(skip)]` (`ws.rs:331`) | **YES** (HTTP, CLI, MCP, GraphQL, WS — 5) |
| **hidden (dispatchable, not listed)** | `#[route(hidden)]` — router yes, OpenAPI no (`http.rs:501–507`) | `#[server(hidden)]` → clap `.hide(true)` (`cli.rs:499–521`) | `#[server(hidden)]` — dispatchable, not in manifest | — | `#[server(hidden)]` excludes from SDL | `#[server(hidden)]` — dispatchable, not in `ws_methods()` (`ws.rs:335–341`) | **YES** (HTTP, CLI, MCP, GraphQL, WS — 5) |
| **input schema** | OpenAPI `requestBody` + parameter schemas (`openapi_gen.rs:426–452, 590–606`) | `--input-schema` emits JSON Schema from param types (`cli.rs:1773–1797`) | `inputSchema` JSON Schema (`mcp.rs:419–443`) | request proto message fields (`grpc.rs`) | argument types in SDL (`graphql.rs`) | JSON `params` object shape (`ws.rs:657–675`) | **YES** (all 6) |
| **output schema** | OpenAPI response schema (concept present; not yet emitted per `openapi_gen.rs:471`) | `--output-schema` emits JSON Schema from return type (`cli.rs:1800–1834`) | not in MCP spec (concept latent) | response proto message fields (`grpc.rs`) | return field type in SDL (`graphql.rs:816–883`) | result shape in JSON-RPC response (`ws.rs:704–738`) | **YES** (HTTP, CLI, gRPC, GraphQL — 4) |
| **not-found / absent outcome** | `Option<T>` return → 404 (`http.rs:1156–1164`) | `Option::None` return → exit 1 + "Not found" (`cli.rs:2135`) | — | `NOT_FOUND` gRPC status (error taxonomy) | `Option<T>` → nullable return (null result on absent) | — | **YES** (HTTP, CLI, GraphQL, gRPC — 4) |
| **param name override (wire name)** | `#[param(name)]` → OpenAPI property / query key | `#[param(name)]` → clap long flag name (`cli.rs:601–611`) | `#[param(name)]` → JSON property in `inputSchema` | field name in proto message | camelCase from method param name | `#[param(name)]` → JSON key (`ws.rs:373`) | **YES** (all 6 — `wire_name` read by every projection) |
| **param default value** | OpenAPI `default` in schema | `#[param(default)]` → clap `.default_value()` (`cli.rs:1654–1659`) | JSON Schema `default` (per-param) | proto3 field defaults | argument default value (SDL) | — | **YES** (HTTP, CLI, MCP, gRPC, GraphQL — 5) |
| **param help text** | OpenAPI param `description` | `#[param(help)]` → clap `.help()` (`cli.rs:1683–1739`) | `#[param(help)]` → `inputSchema` property description (`mcp.rs:419–443`) | inline comment (derived from docs) | argument description in SDL | — | **YES** (HTTP, CLI, MCP — 3+) |
| **method grouping / sections** | `#[route(tags)]` → OpenAPI tags; `#[server(group)]` → tag assignment | `#[server(group)]` → ANSI section headings in `--help` (`cli.rs:862–882`) | — | service as structural grouping unit | `{Struct}Query` / `{Struct}Mutation` root type split | — | **YES** (HTTP, CLI — explicit; gRPC, GraphQL structural) |
| **auth requirement** | `Context.authorization()` + 401/403; Context hidden from OpenAPI (`http.rs:47–54`) | — | — | per-call metadata (transport concern, not op-def) | — | Context from HTTP upgrade headers (`ws.rs:593–610`) | **HTTP-dominant** (only HTTP models at op level; others runtime/transport) |
| **deprecated** | `#[route(deprecated)]` → OpenAPI `deprecated: true` (`openapi_gen.rs:48–55`) | — | — | — | — | — | **HTTP-specific** (single projection) |

---

## 2. AGNOSTIC KEY SET (≥2 projections)

Each key lists which projections read it, how each renders it, and whether it is
**type-inferable** (derivable from the Rust type/name without annotation) or
**must-be-authored** (not visible in a TS/Rust type alone).

### Behavioral keys

These are the additions fractal makes that no single projection could carry alone. The
server-less evidence: every projection either fell back to name-prefix heuristics or
dropped these concepts entirely, because there was no protocol-neutral place to read them.

---

**`safe` / `readOnly`** — must-be-authored (partially type-inferable from name prefix, but that is lossy)

| Projection | Rendering |
|---|---|
| HTTP | Selects GET/HEAD class vs POST/PUT/DELETE; safe methods are cacheable |
| CLI | Governs whether a dry-run / preview mode would suppress the call |
| MCP | Emitted as `annotations.readOnlyHint` |
| gRPC | Emitted as `option idempotency_level = NO_SIDE_EFFECTS` |
| GraphQL | Determines `query` vs `mutation` op type; queries may execute in parallel (spec §6.2.1) |

---

**`idempotent`** — must-be-authored

| Projection | Rendering |
|---|---|
| HTTP | Selects PUT/DELETE class (idempotent) vs POST (not); controls retry safety |
| MCP | Emitted as `annotations.idempotentHint` |
| gRPC | Emitted as `option idempotency_level = IDEMPOTENT` |

---

**`destructive`** — must-be-authored

| Projection | Rendering |
|---|---|
| HTTP | Selects DELETE; signals irreversible operation to API tooling |
| CLI | Would trigger confirmation prompt ("Are you sure? [y/N]") — not yet generated |
| MCP | Emitted as `annotations.destructiveHint` |

---

**`openWorld`** — must-be-authored

| Projection | Rendering |
|---|---|
| MCP | Emitted as `annotations.openWorldHint`; lets models reason about sandboxing/reach |
| HTTP | Caching, rate-limiting, and permission-gating decisions turn on external-reach |

---

**`streaming`** — **type-inferable** from `impl Stream<Item=T>` or `impl Iterator<Item=T>` return

| Projection | Rendering |
|---|---|
| HTTP | Return type maps to SSE / chunked response body |
| CLI | Drives `--jsonl` line-by-line emission mode |
| gRPC | Emits `stream` keyword on response in .proto; server-streaming RPC shape |
| GraphQL | Maps to `subscription` op type (spec §6.2.3) |
| WS | `is_stream` flag recognized as async gate (`ws.rs:945`); actual push via `WsSender` |

---

### Descriptive keys

**`name`** — **type-inferable** from method ident (each projection applies its own case transform)

| Projection | Rendering |
|---|---|
| HTTP | `method_name` → kebab-case path segment |
| CLI | `method_name` → kebab-case subcommand |
| MCP | `method_name` (identity, no case change) + namespace prefix |
| gRPC | `method_name` → UpperCamelCase RPC method name |
| GraphQL | `method_name` → camelCase field name |
| WS | `method_name` (identity) → JSON-RPC `"method"` field |

---

**`description`** — **type-inferable** from Rust `///` doc comments

| Projection | Rendering |
|---|---|
| HTTP | First paragraph → OpenAPI `summary`; rest → `description` |
| CLI | First paragraph → clap `.about()`; rest → `.after_help()` |
| MCP | Full text → tool `"description"` (planning signal for model) |
| gRPC | Emitted as inline `//` comment before `rpc` line in .proto |
| GraphQL | Emitted as field description in SDL |

---

### Structural keys

**`param.optional`** — **type-inferable** from `Option<T>` wrapper

Renders as: OpenAPI `required: false` (HTTP), clap `.required(false)` (CLI), excluded from `required[]` (MCP), proto3 `optional` (gRPC), nullable arg (GraphQL), excluded from required (WS).

---

**`param.multiple`** — **type-inferable** from `Vec<T>` wrapper

Renders as: JSON array / repeated query params (HTTP), `ArgAction::Append` (CLI), `"type":"array"` (MCP), `repeated` field (gRPC), `[T]` list (GraphQL), array in JSON params (WS).

---

**`param.name`** (wire name override) — **type-inferable** from Rust param ident; **must-be-authored** for override via `#[param(name)]`

Read by all 6 projections via `wire_name_or(transform)`. Divergences: HTTP uses kebab for query keys; MCP uses raw name; gRPC uses the Rust ident directly; CLI uses kebab for long flags.

---

**`param.default`** — **must-be-authored** (not visible in type alone)

Renders as: OpenAPI schema `default` (HTTP), clap `.default_value()` (CLI), JSON Schema `default` (MCP), proto3 field default (gRPC), SDL argument default (GraphQL).

---

**`param.description`** — **must-be-authored** via `#[param(help)]`

Renders as: OpenAPI param `description` (HTTP), clap `.help()` (CLI), `inputSchema` property description (MCP).

---

**`inputSchema`** (full param shape) — **type-inferable** from parameter type list

The underlying *data* (param names + types + requiredness) is the same across all projections; only the serialization format differs. Renders as: OpenAPI requestBody + parameter schema (HTTP), JSON Schema via `--input-schema` (CLI), `inputSchema` JSON Schema object (MCP), .proto request message fields (gRPC), SDL argument types (GraphQL), JSON params object (WS).

---

**`outputSchema`** (return type shape) — **type-inferable** from return type

Renders as: OpenAPI response schema (HTTP — concept present, not yet emitted), `--output-schema` JSON Schema (CLI), .proto response message fields (gRPC), SDL return field type (GraphQL). `Result<T,E>` is unwrapped to `T`; `Option<T>` flags nullable/notFound.

---

**`notFound`** (can-be-absent) — **type-inferable** from `Option<T>` *return* (distinct from `Option<T>` *param*)

Renders as: 404 response (HTTP), exit 1 + "Not found" (CLI), nullable null result (GraphQL), NOT_FOUND status (gRPC).

---

**`mount`** (hierarchical grouping) — **type-inferable** from `&T` return shape (no params → static mount; with params → slug mount)

Renders as: `nest_service` / `HttpMount` (HTTP), `CliSubcommand` subcommand tree (CLI), tool-name namespace prefix (MCP), proto service + package (gRPC), type-graph mount point (GraphQL), `WsMount` dispatch tree (WS).

---

**`skip`** — **must-be-authored** via `#[server(skip)]`

Excludes op from all projections that check `has_server_skip` (HTTP, CLI, MCP, GraphQL, WS).

---

**`hidden`** — **must-be-authored** via `#[server(hidden)]`

Op remains dispatchable but excluded from discovery listings: OpenAPI spec (HTTP), clap `--help` (CLI), MCP tool manifest, GraphQL SDL, `ws_methods()` (WS).

---

**`group`** — **must-be-authored** via `#[server(group)]`

Renders as: OpenAPI tag assignment / `#[route(tags)]` (HTTP), ANSI section headings in `--help` (CLI). gRPC service and GraphQL root-type split are structural analogs.

---

## 3. Per-Projection Namespaced Keys

Distinctions only one projection encodes. These belong in `http:`, `cli:`, etc. namespaces on the op
and should not be lifted to the agnostic core.

### `http:` namespace

- **Verb string** — `GET`/`POST`/`PUT`/`PATCH`/`DELETE` as literal word; overridable via `#[route(method = "...")]`
- **Path template** — `/users/{id}` URI template syntax (RFC 6570); inferred by `infer_path`, overridable via `#[route(path = "...")]`; validated at compile time
- **Request headers** as param location — `#[param(location = "header")]` → `HeaderMap` extraction
- **Response headers** — `#[response(header = "X-Foo", value = "bar")]`
- **Content-Type / MIME** — `#[response(content_type = "...")]`; request body always `application/json` (hardcoded)
- **HTTP caching directives** — `Cache-Control`, `ETag`, `Last-Modified` (not handled in server-less; noted as absent)
- **Status code numbers** — 200, 201, 204, 400, 404, 500; override via `#[response(status = N)]`
- **Auth status semantics** — 401 vs 403; `WWW-Authenticate` header
- **`deprecated`** — `#[route(deprecated)]` → OpenAPI `deprecated: true`

### `cli:` namespace

- **Version string** — `#[cli(version)]` → clap `--version`/`-V`
- **Default action** — `#[cli(default)]`; args hoisted to parent command
- **Display formatter** — `#[cli(display_with = "fn_name")]`; human-readable text output
- **Hidden alias** — `#[cli(alias)]` / `#[cli(aliases)]`; migration scaffolding
- **Boolean flag rendering** — `bool` param → `--flag` (SetTrue, no value taken)
- **Positional argument** — `#[param(positional)]` or `is_id` → `.index(N)` ordering
- **Short flag character** — `#[param(short = 'x')]` → `-x`
- **Output format flags** — `--json`, `--jsonl`, `--jq <expr>`, `--params-json <json>` (global)
- **`--manual` reference document** — aggregated `CliManualNode` tree
- **Global flags** — `#[cli(global = [flag_name = "help"])]` + `.global(true)` propagation
- **Shell completions** — `clap_complete`; `clap_mangen` roff man page
- **Exit codes** — 0 (success), 1 (error/not-found); POSIX convention, not parameterized
- **stdout vs stderr routing** — success → stdout, errors → stderr (or `{"error":...}` → stdout in JSON mode)
- **Unit return → "Done"** — terminal feedback convention
- **`--dry-run`** concept (not implemented, would consume `destructive` agnostic key)
- **Env-var fallback** — clap `.env()`, not wired by server-less

### `mcp:` namespace

- **`title`** — human display label separate from machine `name` (`annotations.title`)
- **Tool annotations envelope** — `ToolAnnotations` object wrapper (the agnostic behavioral keys are *inside* it, but the envelope is MCP-shaped)
- **Namespace prefix baked into name string** — `{prefix}_{method_name}` concatenation
- **JSON-RPC shaped tool listing** — `{name, description, inputSchema}` wire object

### `grpc:` namespace

- **Field numbers** — stable integer wire tags (sequential in server-less, no pin mechanism — noted as stability risk)
- **Protobuf message layout** — distinct named `{Method}Request` / `{Method}Response` per RPC
- **Proto scalar type mapping** — `int32`, `bytes`, `google.protobuf.Empty`, etc. (`rust_type_to_proto_scalar`)
- **Package / syntax declarations** — `package foo.bar;`, `syntax = "proto3";`; override via `#[grpc(package)]`
- **gRPC status enum values** — `OK`, `NOT_FOUND`, `DEADLINE_EXCEEDED`, etc. (E is discarded by server-less)
- **Deadlines / timeouts** — transport concern; not in op definition
- **gRPC call metadata headers** — per-call k→v envelope; not in op definition
- **Four-way streaming shape** — unary / server-stream / client-stream / bidi (server-less only models unary + server-streaming)
- **Schema file path** — `#[grpc(schema = "path.proto")]` for compile-time diff validation

### `graphql:` namespace

- **Nullability semantics** — `T!` vs `T`; non-null error bubbling propagation
- **Field / resolver graph placement** — which object type a field hangs off, navigable type graph
- **Field selection** — client picks which subfields to return (no analog in any other listed protocol)
- **Return type as named graph type** — mapping return value to a navigable named schema type
- **`{Struct}Query` / `{Struct}Mutation` root type naming** — camelCase field names, `SCREAMING_SNAKE_CASE` enum variants
- **`dynamic::InputObject` / `dynamic::Enum`** — `#[graphql_input]`, `#[graphql_enum]` companion macros
- **SDL emission** — `graphql_sdl() -> String`, playground endpoint

### `ws:` namespace

- **JSON-RPC 2.0 frame protocol** — `{method, params, id}` request; `{result, id}` / `{error, id}` response (`ws.rs:657–738`)
- **Frame type discrimination** — Text dispatched; Binary/Ping/Pong silently ignored; Close terminates (`ws.rs:876–893`)
- **HTTP upgrade handshake** — `axum::WebSocketUpgrade` extractor; GET route → 101 Switching Protocols (`ws.rs:845–858`)
- **Per-connection async loop** — socket split into (sender, receiver); connection-scoped `WsSender` (`ws.rs:861–895`)
- **Bidirectionality** — server→client push via `WsSender` injection; client→server via receive loop
- **`WsSender` parameter detection** — widens dispatch signature; excluded from `WsMount` (`ws.rs:168–203, 256–268`)
- **Endpoint path** — `#[ws(path = "...")]` (the only declared ws: metadata key)
- **`x-websocket-protocol` OpenAPI extension** — emitted in generated OpenAPI spec (`ws.rs:795–841`)

---

## 4. Precedence — The Three-Layer Model

Confirmed from mining all six projections. For each agnostic key, the layer that usually supplies it:

```
type-inference  →  agnostic key  →  per-projection override
```

| Layer | What it supplies | Examples |
|---|---|---|
| **1. Type-inference** (first, no annotation needed) | Derivable from Rust types / return shape / doc comments alone | `streaming` from `impl Stream`; `param.optional` from `Option<T>`; `param.multiple` from `Vec<T>`; `name` from method ident; `description` from `///`; `notFound` from `Option<T>` return; mount structure from `&T` return |
| **2. Agnostic key** (second, explicit op-core authoring) | Protocol-neutral facts not visible in the type system | `safe`, `idempotent`, `destructive`, `openWorld` (behavioral); `param.default`, `param.description` (structural); `skip`, `hidden`, `group` (visibility/organization) |
| **3. Per-projection override** (third, only when agnostic value needs protocol-specific shaping) | Projection-specific rendering or literal values | HTTP: `#[route(method = "PUT")]`; gRPC: field numbers; WS: `#[ws(path = "/events")]`; MCP: `title`; CLI: `#[param(short = 'x')]` |

The model is strictly layered: a later layer can only override, not contradict, an earlier one. The agnostic key layer exists to bridge between what the type system can prove and what per-projection rendering needs.

---

## 5. Gaps the Mining Exposed

The central finding of this synthesis:

**server-less models all structural op concepts but omits all behavioral ones.** The structural
concepts — param shapes, mount hierarchy, optionality, multiplicity, streaming, name,
description — are all type-inferable from the Rust signature, so server-less could derive them
without any protocol-neutral op field. The behavioral ones — `readOnly`, `idempotent`,
`destructive`, `openWorld` — are not type-inferable; they require authoring. And because
server-less had no neutral op-core, every projection had to independently cope:

- **HTTP:** `infer_http_method` falls back on name-prefix heuristics (`get_`, `list_`, … → GET; `delete_`, … → DELETE). This is lossy — it breaks on unconventional names and is silent. No `is_readonly` annotation exists.
- **gRPC:** `idempotency_level` — the one official proto field for exactly this concept — is **not emitted at all** by server-less (`grpc.rs` explicitly noted as absent). Dropped because there was nowhere protocol-neutral to read it from.
- **GraphQL:** Query vs mutation is determined by the same name-prefix heuristic as HTTP (`graphql.rs:658–669`). Same lossiness, same failure mode.
- **MCP:** `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` are defined in the spec and wired into `ToolAnnotations`, but **server-less does not emit any of them** (`mcp.rs` confirmed: tool object has exactly three keys). The machinery to read them from the op did not exist.
- **CLI:** Confirmation-prompt and `--dry-run` are explicitly noted as conventions that "should be generated" but are **not generated** (`projection-cli.md`) — because there was no `is_destructive` key to read.

This pattern — every projection independently hit the same wall and dropped or heuristic-patched the same four properties — is the direct evidence that `safe`, `idempotent`, `destructive`, and `openWorld` are the real **addition fractal makes at the op-core level**. They are the keys that cannot live in any single projection but must be stated once, protocol-neutrally, for every projection to read.

---

*Document produced by synthesis of `projection-http.md`, `projection-cli.md`, `projection-mcp.md`, `projection-grpc.md`, `projection-graphql.md`, `projection-ws.md` in this directory.*
