# Prior art: server-less

Repo: `/home/me/git/rhizone/server-less`. A Rust proc-macro "projection system":
you write a plain `impl` block, and attribute macros (`#[http]`, `#[cli]`, `#[mcp]`,
`#[ws]`, `#[jsonrpc]`, `#[graphql]`, plus schema/spec generators) project it onto
protocols. Philosophy: "annotate once, project anywhere" — analogous to serde's
`#[derive(Serialize)]` projecting Rust types onto data formats.

## 1. Routes/operations defined

A route is just a plain method inside an `impl` block annotated with `#[http]`
(or composed via `#[serve(http, ws, ...)]`). No explicit route table — the macro
(`crates/server-less-macros/src/http.rs`, `expand_http`) walks `ItemImpl` methods
at compile time, classifies each as a "leaf" (real endpoint) or a "mount" (nested
sub-service, see §3), and generates an axum handler + `.route(...)` call per leaf.
Per-method escape hatches: `#[route(method = "...", path = "...", skip, hidden)]`
and `#[response(status = ..., header = ...)]`.

## 2. HTTP method derivation

Purely convention over the **function name prefix** (`infer_http_method` in
`server-less-macros/src/openapi_gen.rs:227`), no explicit declaration by default:

- `get_*, fetch_*, read_*, list_*, find_*, search_*` → GET
- `create_*, add_*, new_*` → POST
- `update_*, set_*` → PUT
- `patch_*, modify_*` → PATCH
- `delete_*, remove_*` → DELETE
- anything else → falls back to POST (explicitly noted as a silent-surprise case;
  users are told to use `#[route(method = "...")]` to override)

Explicit override always wins: `#[route(method = "PATCH")]` on a method bypasses
inference entirely (`http.rs:397-424`). Path is inferred the same way: the prefix
is stripped from the method name, the remainder kebab-cased and pluralized
(`infer_path`, `openapi_gen.rs:255`), e.g. `create_user`→`POST /users`,
`get_user`→`GET /users/{id}` (if an id-like or `Path`-located param exists),
`list_users`→`GET /users`. Duplicate route (method+normalized-path) detection
is a compile error with remediation hints.

## 3. Tree/router structure

Flat by default: one `impl` block → one axum `Router` with one `.route()` per
leaf method, built fresh each macro expansion. Nesting comes from **mount
points**: a method returning `&ChildService` (a reference, not a value) is
detected as a mount rather than a leaf (`partition_methods` in `server-less-parse`).
The parent's `http_mount_router`/`http_router` calls `.nest_service(path, Child::http_mount_router(...))`
under `/{mount_method_name}/`, and mounted children implement a shared
`HttpMount` trait (`http_mount_router()`, `http_mount_openapi_paths()`) so nesting
is recursive/composable. OpenAPI paths are merged the same way, with the mount
prefix applied to child paths (`mount_service.rs` example demonstrates this: a
`users(&self) -> &UsersService` method nests all of `UsersService`'s HTTP routes
under `/users/` and MCP tools under a `users_` prefix — one mount mechanism drives
multiple protocol trees).

## 4. Input extraction

Per-parameter, based on HTTP method + location inference
(`generate_param_handling`, `http.rs:797`):

- Default body-bearing methods (POST/PUT/PATCH) put non-path params in a JSON
  body; GET/DELETE put them in the query string.
- A parameter is treated as a **path** param if it's explicitly marked
  `#[param(path)]` / located via `ParamLocation::Path`, or if it looks like an
  id (`param.is_id`, e.g. named `id`/`user_id`).
- Explicit `#[param(query)]`, `#[param(header)]`, `#[param(body)]` override the
  default inference per-parameter.
- Single path param → axum `Path<T>`; multiple → `Path<(T1,T2,...)>` tuple,
  destructured into named locals.
- Body: single `Json<serde_json::Value>` extractor, then each declared field is
  pulled out and deserialized individually with per-field 400 errors ("field X
  required, expected type Y"); unknown body/query keys get a compile-time-known-fields
  runtime warning (`eprintln!`).
- Optional params (`Option<T>`) get `None`-on-missing; params with
  `#[param(default = ...)]` get a parsed default expression inlined at compile time.
- A `Context` parameter (server-less's own type, disambiguated from user types by
  scanning for qualified `server_less::Context` usage across the impl block) is
  injected, not user-supplied — carries headers/request-id/user-id, populated
  from HTTP headers.
- Return type also drives response shape: `Result<T,E>`→200 Json or mapped error
  status via `HttpStatusFallback`; `Option<T>`→200/404; `()`→204; `Vec`/plain
  `T`→200 Json; `impl Iterator`/`impl Stream`→SSE.

## 5. Multiple projections/surfaces

Each protocol is a separate attribute macro (`#[http]`, `#[cli]`, `#[mcp]`,
`#[ws]`, `#[jsonrpc]`, `#[graphql]`) that can be stacked on the *same* impl
block independently, each reading the same method signatures/doc-comments and
projecting its own artifact (router, clap command, MCP tool schema, etc.).
`#[serve(http, ws, jsonrpc, graphql)]` composes multiple protocol routers into
one axum `Router` via `.merge()`, plus a combined OpenAPI spec via
`OpenApiBuilder::merge_paths()` per protocol. Attribute metadata (e.g.
`#[param(help = "...")]`) is written once and interpreted by every active
projection (CLI help text, OpenAPI description, MCP input docs simultaneously)
— shared parsing lives in `server-less-parse` so each macro doesn't reimplement
method/param introspection. `#[app]` carries cross-protocol metadata (name,
description, version). Schema-only generators (`#[grpc]`, `#[capnp]`,
`#[thrift]`, `#[smithy]`, `#[connect]`, `#[openrpc]`, `#[asyncapi]`,
`#[jsonschema]`, `#[markdown]`) are the same idea but emit static
IDL/spec files instead of runtime dispatch.
