# server-less — reference implementation writeup

Reference target: `/home/me/git/rhizone/server-less`, Rust, workspace `version = "0.7.0"`
(`crates/server-less/Cargo.toml:` version line; `git log` HEAD `d3e9033`). All citations are
`file:line` into that repo. Read directly from source; no reliance on prior summaries.

**Correction up front.** A prior read claimed server-less "infers structure from names / the
type-graph." That conflates two different things. Structure (the tree) is **authored
explicitly** by the developer via Rust `impl` blocks and mount methods; it is *not* inferred.
Name-based inference exists but is confined to **per-leaf HTTP defaults** (verb + REST path),
not to the tree. The tree is real and explicit; see §1.

---

## 1. THE TREE — explicit, authored as impl blocks + `&T` mount methods

**What it really is.** There is no separate tree DSL, config, or builder object. The tree *is*
the Rust type graph, made explicit by two authoring acts:

- **A node** = one `impl` block carrying a protocol attribute (`#[http]`, `#[mcp]`, `#[cli]`, …).
  The struct is the node; each `&self` method in the block is a **leaf operation**.
- **An edge (mount point)** = a method whose return type is a reference to another node type:
  `fn users(&self) -> &UsersService`. Returning `&T` is the explicit signal "nest child T here,
  under this method's name."

The shared, protocol-neutral classifier lives in the `server-less-parse` crate. Methods are
partitioned purely by shape:

- `crates/server-less-parse/src/lib.rs:1156-1200` — `partition_methods` splits methods into
  `leaf`, `static_mounts` (`fn f(&self) -> &T`, no params), and `slug_mounts`
  (`fn f(&self, id: Id) -> &T`, has params). The rule: `is_reference && !is_async` ⇒ mount,
  else leaf (`:1188-1196`).
- `crates/server-less-parse/src/lib.rs:919-937` — `parse_return_type` detects the `&T` case and
  records `is_reference` + `reference_inner`. The doc comment at `:919` literally says
  "`&T` (reference return — mount point)."
- `crates/server-less-parse/src/lib.rs:1132-1154` — `extract_methods` gathers the block's
  methods (skipping `_`-prefixed and receiver-less associated fns).

So the tree is a **recursive nesting of impl-block nodes joined by `&T` mount edges**, addressed
by method name. Depth is unbounded (mounts recurse into child types).

**Authoring shape (real example).** `crates/server-less/examples/mount_service.rs`:

- Child node: `#[http] #[mcp] impl UsersService { fn list_users(&self) -> Vec<String> … }`
  (`:37-57`).
- Parent node holds the child as a field and exposes the mount edge:
  `fn users(&self) -> &UsersService { &self.users }` (`:93-95`), alongside its own leaf
  `fn get_health(&self) -> String` (`:85`).
- The example's own header comment states the model plainly (`:1-20`): a `-> &ChildService`
  method makes the parent's router/tool-list include the child, "scoped under the mount method's
  name."

**Protocol-neutral or HTTP-shaped?** The *authoring* is protocol-neutral: the same impl blocks
and the same `&T` mount methods drive every projection. But there is **no single reified tree
object** at runtime — each protocol macro independently re-walks the block (via
`extract_methods`/`partition_methods`) and emits its **own** composition trait, and each imposes
its **own addressing convention** for the same mount edge:

- HTTP: nest under path segment `/users/` — `crates/server-less-macros/src/http.rs:349-379`
  (`.nest_service("/users", …)` + child OpenAPI paths prefixed).
- MCP: prefix child tool names `users_` — `crates/server-less/examples/mount_service.rs:16-20`,
  and `McpNamespace` trait `crates/server-less-core/src/lib.rs:216-241`.
- JSON-RPC / WS: dot-separated prefix `users.` — `JsonRpcMount`/`WsMount`,
  `crates/server-less-core/src/lib.rs:243-289`.
- CLI: nested clap subcommand group — `CliSubcommand` trait,
  `crates/server-less-core/src/lib.rs:126-160`.

So: **one neutral authored tree, N protocol-specific realizations.** The mount edge is neutral;
the prefixing/addressing rule is per-projection.

**On "`&T` → HttpMount".** `HttpMount` (`crates/server-less-core/src/lib.rs:291-306`) is the
HTTP-specific trait auto-implemented by `#[http]` on a node; its `http_mount_router` +
`http_mount_openapi_paths` are what a parent calls when it hits a `&T` mount method. It is *not*
the tree — it is HTTP's realization of one mount edge. Each protocol has a sibling trait
(`McpNamespace`, `JsonRpcMount`, `WsMount`, `CliSubcommand`).

---

## 2. METADATA — attribute args on nodes/methods/params; the set is CLOSED

Metadata attaches at three levels, all as Rust attribute macros:

- **Node level** (on the impl block): the protocol attrs themselves + their args, e.g.
  `#[http(prefix = "/api")]` (`crates/server-less/examples/http_service.rs:53`),
  `#[cli(name = "myapp", version = "1.0")]`, `#[server(groups(...))]`.
- **Method level**: `#[server(...)]` cross-protocol (`skip`, `hidden`, `name`, `group` —
  `crates/server-less-macros/src/server_attrs.rs:14`); per-protocol `#[cli(...)]`, `#[route(...)]`
  (HTTP verb/path), `#[response(...)]` (HTTP status/content-type).
- **Param level**: `#[param(...)]` — `crates/server-less-parse/src/lib.rs:585-742`.

**The complete key list (enumerated from source):**

- `#[param(...)]` — `name`, `default`, `query`, `path`, `body`, `header`, `short`, `help`,
  `positional`, `env`, `file_key`, `nested`, `serde`, `env_prefix`
  (`crates/server-less-parse/src/lib.rs:688-691`).
- `#[server(...)]` (method) — `skip`, `hidden`, `name`, `group`
  (`server_attrs.rs:14`); plus block-level `groups(id = "Display")`
  (`crates/server-less-parse/src/lib.rs:417-450`).
- `#[route(...)]` (HTTP) — `skip`, `hidden`, `deprecated`, `method`, `path`, `tags`
  (`crates/server-less-macros/src/openapi_gen.rs:42-67`).
- `#[response(...)]` (HTTP) — `status`, `content_type`, `header`, `value`, `description`
  (`crates/server-less-macros/src/openapi_gen.rs:131-155`).
- `#[cli(...)]` (method) — `name`, `alias`/`aliases`, `skip`, `helper`, `hidden`, `default`,
  `display_with`, `manual`, `no_sync`, `no_async` (`crates/server-less-macros/src/cli.rs:14-48`,
  `:316-575`).
- `#[http(...)]` (method-level toggles) — `debug`, `trace`
  (`crates/server-less-macros/src/http.rs:193-199`).
- Cross-protocol `name` override is read from **any** protocol attr by
  `extract_wire_name`, scanning a fixed whitelist `PROTOCOL_ATTRS = ["server","cli","http","mcp",
  "jsonrpc","grpc","ws","graphql","tool"]` (`crates/server-less-parse/src/lib.rs:353-387`).

**Open or closed?** **Closed.** Every attribute parser hard-codes its valid-key set and
*rejects* unknown keys with a "did you mean" diagnostic:

- `#[param]`: `VALID` array + `meta.error("unknown attribute …")`
  (`crates/server-less-parse/src/lib.rs:688-719`).
- `#[server]`: `KNOWN_SERVER_FLAGS` + `validate_server_attrs` errors on unknown
  (`server_attrs.rs:14,30-59`).
- `#[response]`: valid set + error (`openapi_gen.rs:155-172`).
- The recognized protocol-attr *names* are themselves a fixed list (`PROTOCOL_ATTRS`,
  `lib.rs:354`).

A new projection **cannot** introduce a new metadata key or a new protocol attribute without
editing the core crates (`server-less-parse` and/or the protocol macro). There is no
open/extensible bag. This is a hard, load-bearing contrast with the fractal model (§5).

---

## 3. PROJECTIONS — each macro consumes the same (tree, metadata) and emits its surface

Every protocol is a proc-macro attribute in `crates/server-less-macros/src/lib.rs`
(`:428` http, `:496` openapi, `:548` cli, `:614` mcp, `:706` ws, `:758` jsonrpc, `:799` openrpc,
`:969` grpc, `:1102` smithy, `:1057` thrift, `:1013` capnp, `:887` asyncapi, `:925` connect,
`:1281` graphql, `:843` markdown, …). Presets compose several: `#[server]` =
`#[http] + #[openapi] + #[serve(http)]` (`crates/server-less-macros/src/server.rs:1-3`).

**Consumption pattern (uniform):** each macro calls `extract_methods` + `partition_methods`,
then for leaves derives a surface and for mounts emits the recursive composition call.

**Defaults, then overrides — HTTP is the clearest case:**

- Verb default from name prefix: `infer_http_method` — `get_/list_/find_…` ⇒ GET, `create_/add_`
  ⇒ POST, `update_/set_` ⇒ PUT, `patch_/modify_` ⇒ PATCH, `delete_/remove_` ⇒ DELETE, else POST
  (runtime mirror at `crates/server-less-core/src/lib.rs:554-580`).
- Path default from name + params: `infer_path` strips the verb prefix, pluralizes the resource,
  and appends `/{id}` for single-resource ops (`crates/server-less-core/src/lib.rs:622-673`;
  the richer compile-time version is `openapi_gen::infer_path`).
- Override wins: `http.rs:388-431` — for each leaf it parses `RouteOverride`; if
  `overrides.method` is set it uses that verb (`:397-423`), else `infer_http_method`; if
  `overrides.path` is set it uses that path (`:426-430`), else `infer_path`. Same override-beats-
  default logic for `#[response(status=…)]`.
- Names: `wire_name_or(transform)` returns the `#[…(name="…")]` override if present, else applies
  the projection's transform (`crates/server-less-parse/src/lib.rs:99-118`). Per projection: CLI
  kebab-cases (`cli.rs:8` "`create_user` → `create-user`"), gRPC snake_cases
  (`grpc.rs:280`), MCP/JSON-RPC/WS pass the raw name (`mcp.rs:405`, `jsonrpc.rs:164`).
- Data schemas come from the **types**: params → input schema, return type → output schema, doc
  comment → description (`extract_docs`, `crates/server-less-parse/src/lib.rs:330-351`;
  `CliManualNode` carries `input_schema`/`output_schema`, `core/src/lib.rs:39-50`).

**One op, two surfaces (from `mount_service.rs`).** Child leaf
`/// List all users\n pub fn list_users(&self) -> Vec<String>` (`:41-42`):

- **HTTP**, mounted under parent: `GET /users/users` — verb inferred GET (`list_` prefix), path
  inferred `/users` then nest-prefixed with `/users/` (`http.rs:349-379`); OpenAPI path emitted
  with the same prefix. Example header narrates exactly this (`mount_service.rs:10-13`).
- **MCP**: tool `users_list_users` (child tool `list_users` + mount prefix `users_`), callable via
  `mcp_call("users_list_users", {})` (`mount_service.rs:16-20,124-143`). Input schema = params
  (none), output schema = `Vec<String>`.

Same function `T => U`, same doc, same types; HTTP and MCP each read the metadata keys they know
and derive the rest from the signature.

---

## 4. SEPARATION OF CONCERNS — largely clean, with named leaks

Three concerns, and where each lives:

1. **Structure / addressing (the tree):** the `&T` mount methods + impl-block nesting,
   classified neutrally in `partition_methods` (`parse/src/lib.rs:1156-1200`). Neutral at
   authoring time.
2. **Per-op projection metadata:** the attribute args of §2 — orthogonal knobs (`#[route]`,
   `#[response]`, `#[param(query|path|header)]`, `#[cli(default|hidden)]`, `#[server(skip|hidden)]`).
3. **Typed data (truth):** the function signature — param types, return type, and doc comments.
   Schemas and descriptions are *always* derived from these, never restated in metadata
   (`extract_docs`, `parse_return_type`, `CliManualNode` schemas). This matches the fractal tenet
   "types + JSDoc are the single source of truth for the data."

**Where it blurs / leaks (honest):**

- **No single reified tree.** Each protocol re-derives structure and owns its own mount trait
  (`HttpMount`, `McpNamespace`, `JsonRpcMount`, `WsMount`, `CliSubcommand`;
  `core/src/lib.rs:126-306`) and its own prefix convention. The neutral tree exists only as a
  shared *parsing pass*, not as a shared *object*. Add a protocol ⇒ add a mount trait + re-walk.
- **Name-inference couples data-naming to projection behavior.** HTTP verb/path/method-location
  are inferred from the *method name* and *param names* (`is_id` ⇒ `/{id}` and CLI-positional:
  `parse/src/lib.rs:778-779`, `1126-1130`). Renaming a function or a param silently changes the
  HTTP surface. Structure-truth (naming) and projection are not fully decoupled — the name is
  overloaded as both identity and routing hint.
- **`#[param(location)]` mixes addressing into per-param metadata**: `query`/`path`/`body`/
  `header` is genuinely HTTP-projection concern living on the param, defaulted by HTTP method +
  name and overridable (`parse/src/lib.rs:506-509,629-642`). Fine, but it is HTTP-shaped
  metadata sitting on the neutral data declaration.
- **Config concerns bleed into `#[param]`**: `env`, `file_key`, `nested`, `serde`, `env_prefix`
  are `#[derive(Config)]` concerns riding the same param attribute
  (`parse/src/lib.rs:521-543`) — a closed attribute doing double duty across unrelated
  projections.

---

## 5. GAPS vs the fractal model (real, non-surface)

Ignoring Rust-macros-vs-TS-codegen (not a real difference), the substantive deltas:

1. **CLOSED metadata vs OPEN metadata — the biggest gap.** fractal wants an op to carry an
   *arbitrary, extensible* metadata bag; a *new projection defines new keys without touching the
   core*. server-less is the opposite: every key and every protocol-attr name is a hard-coded
   whitelist that errors on unknowns (`param` VALID `parse/src/lib.rs:688-691`; `server`
   `server_attrs.rs:14`; `response` `openapi_gen.rs:155`; `PROTOCOL_ATTRS` `parse/src/lib.rs:354`).
   Adding gRPC-only or MCP-only metadata means editing shared crates. server-less *ignores*
   unrecognized-*by-this-projection* keys (each macro reads only its own attrs), which is the
   "projection reads keys it knows, ignores the rest" tenet — but the *universe* of keys is
   fixed centrally. fractal wants the universe itself open.

2. **No reified, shared tree object.** fractal's "tree" is a first-class structure a projection
   consumes. server-less's tree is an authoring convention + N independent re-derivations, one
   composition trait per protocol. There is no single artifact a *new* projection can consume
   without re-implementing traversal and its own mount trait.

3. **Op identity is not a plain value.** fractal: "an operation is just a function `T => U`
   carrying metadata," a first-class thing. server-less ops are `&self` methods reachable only
   through their impl block + attribute expansion; there is no standalone op value you can pass
   around, list, or attach metadata to independent of the enclosing node/macro.

4. **Name-based inference is load-bearing, not just a convenience.** fractal wants defaults "from
   the types where obvious." server-less leans harder: HTTP verb, REST path, `/{id}` segments,
   and CLI positionality are all inferred from *method/param names* (`infer_http_method`/
   `infer_path` `core/src/lib.rs:554-673`; `is_id` `parse/src/lib.rs:1126-1130`). That is
   inference from *names*, not from *types* — a different, more fragile source than fractal's
   "types are truth."

**Where server-less matches fractal well (don't manufacture a gap):** ops are plain typed
functions; data schemas + descriptions come only from types + doc comments (never restated in
metadata); each projection reads the metadata keys it recognizes and ignores the others; the
same neutral authored structure fans out to HTTP/CLI/MCP/gRPC/JSON-RPC/WS/GraphQL/OpenAPI/OpenRPC/
AsyncAPI/Smithy/Thrift/Cap'n Proto/markdown. It is genuinely the closest prior art; the
distance is (1) closed-vs-open metadata and (2) tree-as-convention-vs-reified-object.
