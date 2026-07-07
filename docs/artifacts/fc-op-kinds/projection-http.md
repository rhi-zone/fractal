# HTTP Projection — Concept Inventory and server-less Analysis

> Source files examined:
> - `server-less/crates/server-less-macros/src/http.rs`
> - `server-less/crates/server-less-macros/src/openapi_gen.rs`
> - `server-less/crates/server-less-core/src/lib.rs` (lines 291–306)

---

## A. HTTP Concept Inventory

### [LIKELY-AGNOSTIC] HTTP Method (verb)

The verb encodes the *intent class* of the operation: whether it reads or mutates, whether it is safe (no server side effects) and idempotent (repeated calls converge to the same server state).

| Verb   | Safe | Idempotent | Intent class         |
|--------|------|-----------|----------------------|
| GET    | yes  | yes       | read / fetch         |
| HEAD   | yes  | yes       | read metadata only   |
| PUT    | no   | yes       | full replace / set   |
| DELETE | no   | yes       | remove               |
| POST   | no   | no        | create / command     |
| PATCH  | no   | no        | partial update       |

The safety/idempotency distinctions are not HTTP-specific in spirit. gRPC has unary vs. server-streaming; message queues distinguish at-most-once vs. at-least-once delivery; CLI distinguishes read-only from mutating subcommands. The *underlying properties* (safe? idempotent? produces a side effect?) are protocol-agnostic. The *binding to a specific verb string* is HTTP-specific.

**server-less:** `infer_http_method` (openapi_gen.rs:227–249) maps function-name prefixes to verbs:
- `get_`, `fetch_`, `read_`, `list_`, `find_`, `search_` → GET  
- `create_`, `add_`, `new_` → POST  
- `update_`, `set_` → PUT  
- `patch_`, `modify_` → PATCH  
- `delete_`, `remove_` → DELETE  
- Unrecognized prefix → POST (silent fallback, noted at line 245)

Explicit override: `#[route(method = "POST")]` parsed by `RouteOverride::parse_from_attrs` (openapi_gen.rs:57–61).

---

### [HTTP-SPECIFIC] Path Template

A URL path like `/users/{id}` is the primary identifier of an HTTP resource. The template syntax `{param}` is specific to HTTP/REST convention (OpenAPI/RFC 6570 URI templates).

**server-less:** `infer_path` (openapi_gen.rs:255–317) derives the path from the method name and parameter list:
- Strips known verb prefix, converts remainder to kebab-case, pluralizes.
- Appends `/{param_name}` for id-like parameters (line 313).
- Override: `#[route(path = "/custom")]` (openapi_gen.rs:62–65).
- Path is validated at compile time by `validate_http_path` (http.rs:1356–1501): checks leading slash, no trailing slash, no `?`, no `#`, brace balance, non-empty/non-duplicate parameter names.

---

### [LIKELY-AGNOSTIC] Path Parameters (positional identifiers)

These are identifiers baked into the hierarchical address (e.g. user ID in `/users/42`). Other protocols express the same concept differently (gRPC: field in request message; CLI: positional argument), but the underlying semantic — "the primary key of the resource being addressed" — is protocol-agnostic.

**server-less:** Parameters recognized as path params when `is_id = true` or `location = Some(ParamLocation::Path)` (http.rs:839–882). Generated with `axum::extract::Path<T>` for single param, `Path<(T1,T2,...)>` tuple for multiple (http.rs:854–882). OpenAPI spec emits `"in": "path"` (openapi_gen.rs:590–591).

---

### [LIKELY-AGNOSTIC] Query Parameters

Key-value pairs appended after `?`. Other protocols have analogous concepts: gRPC request fields, CLI flags, WebSocket init message fields. The underlying concept is "optional filter/modifier metadata passed alongside the primary input."

**server-less:** Default binding for GET-method non-id parameters (http.rs:837–843). Generated with `axum::extract::Query<HashMap<String,String>>` (http.rs:963–965). Warns on unknown query param names at runtime (http.rs:974–984). Override: `#[param(location = "query")]`. OpenAPI emits `"in": "query"` (openapi_gen.rs:594–606).

---

### [LIKELY-AGNOSTIC] Request Body

The primary input payload for mutating operations. gRPC request message, CLI stdin, WebSocket send frame, MCP tool call arguments — the concept "structured payload sent to the operation" exists in all protocols.

**server-less:** Default binding for POST/PUT/PATCH non-id parameters (http.rs:841–843). Parsed from `axum::extract::Json<serde_json::Value>` (http.rs:887). Each body field individually deserialized with BAD_REQUEST (400) on missing required fields (http.rs:941–958). OpenAPI emits `requestBody` with `application/json` content type hardcoded (openapi_gen.rs:426–452, openapi_gen.rs:752–766).

**Observation:** Content-type for request body is always `application/json` — hardcoded, not author-driven. There is no `Accept` / content negotiation.

---

### [HTTP-SPECIFIC] Request Headers

Named string metadata accompanying the request. Conceptually headers overlap with protocol-agnostic "invocation metadata" (gRPC metadata, CLI env vars) but the HTTP header mechanism — lowercase canonical names, standard set (Authorization, Content-Type, etc.) — is HTTP-specific.

**server-less:** `#[param(location = "header")]` routes a parameter to `HeaderMap` extraction (http.rs:1063–1117). No unknown-header warnings (http.rs:1058–1061, comment explains why: standard headers would false-positive on every request). OpenAPI emits `"in": "header"` (openapi_gen.rs:608–620).

---

### [LIKELY-AGNOSTIC] Response Status Code

A numeric outcome classifier. The category (success, client error, server error, not found) maps to protocol-agnostic result types: Rust's `Result<T,E>`, gRPC status codes, CLI exit codes. The *specific numbers* (200, 404, 500) are HTTP-specific; the *category* is not.

**server-less:** Status is inferred from return type (http.rs:1129–1134):
- `()` → 204 No Content  
- `Result<T,E>` → 200 on Ok, error status via `HttpStatusHelper` trait (http.rs:1142–1152)  
- `Option<T>` → 200 on Some, 404 on None (http.rs:1158–1164)  
- Iterator/Stream → 200 (SSE)  
- Other T → 200  

Override: `#[response(status = 201)]` (openapi_gen.rs:131–134). OpenAPI success code inferred from return type (openapi_gen.rs:456–461).

---

### [LIKELY-AGNOSTIC] Response Body

The returned payload. Maps directly to a function's return value in every protocol.

**server-less:** All non-unit return types serialize as `axum::Json(value)` (http.rs:1204–1207). Streams and iterators wrap in SSE (http.rs:1166–1198). OpenAPI does not currently emit a response body schema — only a description string (openapi_gen.rs:471, 796).

---

### [HTTP-SPECIFIC] Response Headers

Named string metadata added to the response. Author-set custom response headers are HTTP-specific surface area; no other protocol reviewed here has an equivalent concept.

**server-less:** `#[response(header = "X-Foo", value = "bar")]` (openapi_gen.rs:139–146). Applied via `HeaderMap::insert` with `HeaderName::from_static` / `HeaderValue::from_static` (http.rs:1235–1244). Emitted in OpenAPI spec (openapi_gen.rs:647–661, 789–793).

---

### [HTTP-SPECIFIC] Content-Type / Accept

MIME-string representation negotiation.

**server-less:** Request body content-type is always `application/json` (hardcoded, not author-driven). Response `content_type` override: `#[response(content_type = "application/octet-stream")]` (openapi_gen.rs:135–138, http.rs:1248–1256). No `Accept` header processing.

---

### [HTTP-SPECIFIC] Caching (Cache-Control, ETag, Last-Modified)

HTTP-specific conditional-request and cache-directive headers. Nothing equivalent exists in gRPC, MQ, or CLI.

**server-less:** Not handled. No Cache-Control, ETag, or Last-Modified emitted or consumed anywhere in the examined code.

---

### [LIKELY-AGNOSTIC] Idempotency (semantic)

Whether repeated identical invocations converge to the same server state. This is a semantic property of the operation, not of HTTP — it exists for message queues (at-least-once delivery safety), distributed systems (retry safety), and CLI (dry-run reasoning).

**server-less:** Not surfaced as explicit metadata. Idempotency is implicitly coupled to method: PUT/DELETE are idempotent by HTTP convention, inferred through the verb mapping. There is no `is_idempotent` annotation.

---

### [LIKELY-AGNOSTIC] Safety (read-only, no side effects)

Whether the operation has observable server-side effects. Again a semantic property that maps to read-vs-mutate in every protocol.

**server-less:** Implicitly encoded in verb inference: `get_`, `list_`, `fetch_`, `read_`, `find_`, `search_` → GET (safe). No explicit `is_pure` or `is_readonly` annotation.

---

### [HTTP-SPECIFIC] Authentication / Authorization (401 vs 403)

WWW-Authenticate / Authorization headers, HTTP status code semantics (401 = unauthenticated, 403 = unauthorized). The header names and status codes are HTTP-specific.

**server-less:** `Context` injection (http.rs:47–54) exposes `ctx.authorization()` and `ctx.user_id()` which read the `Authorization` header. Context is hidden from OpenAPI (http.rs:52–54). No 401/403 generation in the macro — auth errors would have to come from the impl via `Result::Err` routed through `HttpStatusHelper`.

---

## B. What HTTP Needs to Know About an Op

| HTTP concept         | Can be inferred from op type/effects       | Agnostic metadata (explicit, protocol-neutral) | HTTP-specific authoring |
|----------------------|--------------------------------------------|------------------------------------------------|-------------------------|
| Method (verb)        | pure read → GET; mutating → POST/PUT       | `is_idempotent`, `is_readonly`, `has_side_effects` | `#[route(method = "PUT")]` |
| Path template        | resource name from method name             | resource identity / canonical name             | path string syntax `{id}` |
| Path parameters      | `is_id` flag, param name heuristics        | "this param identifies the resource"           | position in path template |
| Query parameters     | non-id params on GET-like ops              | "this param is optional modifier metadata"     | wire name, `?` serialization |
| Request body         | non-id params on mutating ops              | "this param is the primary input payload"      | `application/json` schema |
| Request headers      | none                                       | none                                           | `#[param(location = "header")]`, wire name |
| Response status code | return type (`()` → 204, `Option` → 404)  | `is_not_found`, `is_created`, outcome class    | numeric status code |
| Response body        | return type T → serialize                  | "returns structured data"                      | none |
| Response headers     | none                                       | none                                           | `#[response(header = ...)]` |
| Content-Type         | none (always JSON)                         | none                                           | `#[response(content_type = ...)]` MIME string |
| Caching              | none                                       | `is_cacheable`, cache TTL, ETag strategy       | Cache-Control directives |
| Idempotency          | verb (implicitly)                          | `is_idempotent` flag                           | none |
| Safety               | verb (implicitly)                          | `is_readonly` / `is_pure` flag                 | none |
| Auth/Authz           | none                                       | `requires_auth`, `required_role`               | 401/403 codes, WWW-Authenticate header |

---

## C. Classification Summary

**[LIKELY-AGNOSTIC]** — other protocols plausibly share these distinctions:
- HTTP method *intent* (safe/idempotent/mutating/creating/deleting) — maps to gRPC unary vs. server-stream, MQ delivery guarantees, CLI read vs. write subcommands
- Path parameters — maps to gRPC primary key fields, CLI positional args
- Query parameters — maps to gRPC optional filter fields, CLI flags
- Request body — maps to gRPC request message, CLI stdin/args, MCP tool call `arguments`
- Response body — maps to gRPC response message, CLI stdout
- Response status class (success/not-found/error/created) — maps to gRPC status codes, CLI exit codes
- Idempotency (semantic) — relevant to MQ retry safety, distributed systems
- Safety / read-only (semantic) — relevant to cache reasoning, audit logging

**[HTTP-SPECIFIC]** — no counterpart in other protocols:
- HTTP verb strings (GET/POST/PUT/PATCH/DELETE as literal words)
- Path template syntax (`/users/{id}`, RFC 6570 URI templates)
- Request headers as a parameter location
- Response headers
- MIME Content-Type / Accept negotiation
- Caching headers (Cache-Control, ETag, Last-Modified, Vary)
- Authentication status codes (401 vs 403) and WWW-Authenticate header
- Status code *numbers* (200, 201, 204, 400, 404, 500)

---

## D. What server-less Actually Does — Citation Table

| Concept              | How server-less handles it | Key citations |
|----------------------|----------------------------|---------------|
| Verb inference       | Name prefix → verb enum    | openapi_gen.rs:227–249 |
| Verb override        | `#[route(method = "...")]` | openapi_gen.rs:57–61 |
| Path inference       | Kebab + pluralize + `{id}` | openapi_gen.rs:255–317 |
| Path override        | `#[route(path = "...")]`   | openapi_gen.rs:62–65 |
| Path validation      | Compile-time checks        | http.rs:1356–1501 |
| Path param extraction| `Path<T>` or `Path<(...)>` | http.rs:854–882 |
| Query param extraction| `Query<HashMap<String,String>>` | http.rs:963–1054 |
| Header param extraction| `HeaderMap` + `headers.get(name)` | http.rs:1063–1117 |
| Request body parsing | `Json<Value>` + field-by-field deserialize | http.rs:885–958 |
| Response 204         | `()` return type           | http.rs:1129–1134 |
| Response 404         | `Option<T>` return type    | http.rs:1156–1164 |
| Response error status| `Result<T,E>` + `HttpStatusHelper` | http.rs:1136–1152 |
| Response status override| `#[response(status = N)]` | openapi_gen.rs:131–134, http.rs:1226–1229 |
| Response Content-Type| `#[response(content_type = "...")]` | openapi_gen.rs:135–138, http.rs:1248–1256 |
| Response headers     | `#[response(header = ..., value = ...)]` | openapi_gen.rs:139–146, http.rs:1235–1244 |
| SSE streaming        | `impl Stream<Item=T>` / `impl Iterator<Item=T>` → SSE | http.rs:1166–1198 |
| Auth injection       | `Context` param hidden from OpenAPI | http.rs:47–54 |
| Route skip           | `#[route(skip)]`           | openapi_gen.rs:42–44 |
| Route hidden         | `#[route(hidden)]` (router yes, OpenAPI no) | openapi_gen.rs:45–46, http.rs:501–507 |
| Tags                 | `#[route(tags = "...")]`   | openapi_gen.rs:67–76 |
| Deprecated           | `#[route(deprecated)]`     | openapi_gen.rs:48–55 |
| OpenAPI body content-type| Always `application/json` (hardcoded) | openapi_gen.rs:438–449 |
| `HttpMount` trait    | Nested composition via `nest_service` | http.rs:354–378, core/lib.rs:296–306 |

---

## Key Cross-Protocol Candidates

The following are encoded in HTTP-specific ways by server-less but carry protocol-agnostic semantics that fractal's op-kind system could express as first-class agnostic metadata:

1. **Read vs. mutate** — inferred from verb prefix, never stated as neutral metadata. A `is_readonly: bool` on an op kind would let HTTP, gRPC, CLI, and audit systems all benefit without re-deriving it.

2. **Idempotency** — derived transitively from verb mapping. Explicit `is_idempotent: bool` would serve MQ retry safety and distributed system reasoning.

3. **Resource identity parameter** — the `is_id` flag on `ParamInfo` is the closest thing. This concept ("this parameter identifies the primary resource being operated on") maps to gRPC request key fields and CLI positional args.

4. **Not-found outcome** — `Option<T>` → 404 is a plausible canonical outcome across protocols. gRPC has `NOT_FOUND`, CLI might exit 1 with a specific message. An op-level `can_be_absent: bool` would abstract it.

5. **Streaming output** — `impl Stream` → SSE is a transport-specific binding of a protocol-agnostic capability (the op produces values incrementally). WebSocket and gRPC server-streaming share this intent.
