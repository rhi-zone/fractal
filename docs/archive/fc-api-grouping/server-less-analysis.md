# server-less — analysis for the "unaided projection" impossibility claim

Analyst note: all claims below are grounded in files under `/home/me/git/rhizone/server-less`
read directly (paths + line numbers cited). Where I mark **[inferred]** it is my
interpretation, not a quote.

## 1. Where / what / goals

- **Path:** `/home/me/git/rhizone/server-less` (the rhizone-ecosystem copy; a Rust 2024
  workspace, `version = 0.6.0`). Two decoy dirs exist — `/home/me/git/serverless` (a small
  JS/HTML thing) and `/home/me/git/pteraworld/dist/server-less` (a single `index.html`) —
  neither is the project.
- **What it is:** a compile-time **projection system** built on proc-macros. You write a
  plain Rust `impl` block (ordinary methods, ordinary types) and attach protocol attributes
  (`#[http]`, `#[cli]`, `#[mcp]`, `#[ws]`, `#[jsonrpc]`, `#[graphql]`, plus schema/spec
  generators for gRPC/Cap'nProto/Thrift/Smithy/Connect/OpenAPI/…). 18 macros,
  `server-less-macros ~5,142 LOC`.
- **Stated goal (`README.md:7-9, 238-246`):** "Write less server code… you write an impl
  block — plain methods with plain types — and server-less projects it onto arbitrary
  protocols." Explicitly framed as *projection, not framework*, with Serde's derive model as
  the prior art ("derive macros as a projection interface, not a straitjacket"). Tagline:
  **"annotate once, project anywhere."**

The relevant design docs: `docs/design/impl-first.md`, `inference-vs-configuration.md`,
`error-mapping.md`, `route-response-attrs.md`, `mount-points.md`, `method-groups.md`,
`param-attributes.md`.

## 2. Projection mechanism

Given `impl S { pub fn foo(&self, ...) -> R { ... } }` + `#[http(prefix="/api")]`, the
macro reads three things per method — **the name prefix, the parameter names/types, and the
return type** — and emits an axum router + OpenAPI spec. No per-endpoint config is required;
attributes are overrides.

Authoring shape, real example (`crates/server-less/examples/http_service.rs:53-73`):

```rust
#[http(prefix = "/api")]
impl UserService {
    /// List all users
    pub fn list_users(&self) -> Vec<User> { ... }          // → GET  /api/users     200
    /// Create a new user
    pub fn create_user(&self, name: String, email: String)
        -> Result<User, UserError> { ... }                 // → POST /api/users     200/err
}
```

The developer writes: method name, params, return type, doc comment. Everything else —
verb, path, param locations, status, error mapping, OpenAPI — is **derived**.

Grounding for the derivation:
- Verb inference: `openapi_gen.rs:227-249` (`infer_http_method`) — prefix table
  get/fetch/read/list/find/search→GET, create/add/new→POST, update/set→PUT,
  patch/modify→PATCH, delete/remove→DELETE, **else→POST fallback**.
- Path inference: `openapi_gen.rs:255-317` (`infer_path`) — strips the verb prefix, kebabs
  the remainder, pluralizes (append `s` if not already ending in `s`), and appends
  `/{param}` when an id-like or `#[param(path)]` param exists; collection verbs
  (list/search/find) stay at `/resource`.
- Param location: `inference-vs-configuration.md:39-59` — name `id`/`*_id` → path; GET +
  non-id → query; POST/PUT/PATCH + non-id → JSON body; `Context` → injected from headers.
- Status: `route-response-attrs.md:92-100` + `http.rs:1133,1162,1228-1232` — `()`→204,
  `Option::None`→404, `Result::Err`→`ErrorCode.http_status()`, else→200.

## 3. The "unprojectable" bits — per-bit verdict

Legend for HOW: (a) inferred from types/structure; (b) supplied by naming/convention;
(c) annotation — DOMAIN re-declaration [bad] or SURFACE-only [ok]; (d) not supported.

| Bit | Emitted? | How | Grounding |
|-----|----------|-----|-----------|
| **HTTP method beyond CRUD** | Partial | (b) prefix→verb incl. PUT/PATCH/DELETE; unknown prefix→POST fallback. Override via `#[route(method=...)]` = (c) **surface-only** | `openapi_gen.rs:227-249`; `route-response-attrs.md:9-18` |
| **Idempotency (PUT/PATCH/POST, upsert)** | Only as a *side effect* of the verb table | (b) `update_/set_`→PUT (idempotent slot), `patch_/modify_`→PATCH, `create_`→POST. There is **no idempotency concept, no upsert, no Idempotency-Key** — the semantic guarantee is not modeled, just the verb string. | verb table only; grep for `idempoten`/`upsert` = **0 hits** |
| **Status codes (201/202/204/200; errors)** | Partial | 200/204/404 = (a) from return type; error statuses = (b) error *variant name* → `ErrorCode` → status. **201/202 are NOT inferred** — POST-create returns 200 unless you add `#[response(status=201)]` = (c) surface-only | `http.rs:1133,1162,1228`; `error-mapping.md:50-63`; `route-response-attrs.md:57-100` |
| **Path nesting / sub-resources** | Partial | Flat `/resource` and `/resource/{id}` = (a)+(b). Deep `/users/{id}/projects/{pid}` only via **mount points**: a method returning `&T` (`HttpMount`) = (a) **structural**, inferred from the *type graph*; slug mounts carry parent id into the child path prefix. No flat-impl way to express 2-level nesting. | `openapi_gen.rs:255-317` (flat); `mount-points.md:1-48` (structural nesting) |
| **Auth scopes per route** | **No** | (d) not supported. `Context` can expose `ctx.user_id()` and a method may return an auth-ish error, but there is **no per-route scope/role/permission projection**. Roadmap lists "auth" under *unshipped* middleware/hooks. | `README.md:228`; `extract.rs:26,55`; grep `scope` = only config-scoping + a ws example |
| **Caching headers (ETag/Cache-Control)** | **No** | (d) not supported. Only generic `#[response(header=..,value=..)]` = (c) manual surface header. No cache/ETag concept. | grep `cache/etag` = 0 relevant hits; `route-response-attrs.md:61-66` |
| **Content negotiation** | **No** (fixed) | (a) always `application/json`; single override `#[response(content_type=..)]` = (c) surface-only. No `Accept`-driven negotiation. | `route-response-attrs.md:100`; grep `negotiat` = 0 |
| **Pagination** | **No** | (d) not modeled. `limit/offset` params just become query strings like any primitive; no page-envelope, Link headers, or cursor semantics. | grep `paginat` = 0 relevant |

## 4. "Somewhat different goals" — the relaxations that matter

server-less is **RPC-shaped, not resource-shaped**, and this is the crux:

1. **Fallback is POST-RPC, not CRUD-completeness.** Any unrecognized method name becomes
   `POST /pluralized-name` (`openapi_gen.rs:244-248`). It doesn't *need* to project the full
   REST verb/idempotency space because its honest default is "expose the method as an RPC
   call"; CRUD verbs are an opportunistic nicety layered on top when the name matches.
2. **One method = one flat endpoint.** The default path space is exactly `/{resource}` and
   `/{resource}/{id}`. Multi-level resource nesting is delegated to the *type graph* (mount
   points), not inferred from a flat impl — so arbitrary `/a/{x}/b/{y}/c` is out of the
   zero-config surface.
3. **No cross-cutting concerns.** Auth, rate-limiting, caching, pagination, content
   negotiation are explicitly **unshipped** (`README.md:227-234`, "middleware/hooks … Up
   Next"). The projection covers the *call shape*, not HTTP's operational envelope.
4. **Surface facts stay surface.** Its override philosophy (`inference-vs-configuration.md`)
   is that annotations tune the *wire projection* (`#[route(path)]`, `#[response(status)]`,
   `#[param(query)]`) and are **not** re-declarations of domain logic — the domain lives in
   the method body/types. `#[derive(ServerlessError)]` maps *error-variant names* to statuses
   by convention, override only for odd names (`error-mapping.md:32-83`). This is the "good"
   kind of annotation by the user's own distinction.
5. **Multi-protocol pressure keeps it honest.** Because the same impl also projects to CLI /
   MCP / gRPC, server-less deliberately refuses HTTP-idiosyncratic semantics that wouldn't
   translate — it aims at the *intersection* of protocols, which is roughly "typed
   request→typed response," i.e. exactly the RPC core. That intersection is what makes
   unaided projection tractable.

## 5. Verdict

**Partial refutation — and, read carefully, it actually *supports* the impossibility claim's
boundary rather than overturning it.**

What server-less demonstrably projects **unaided** (no per-endpoint config, from name+types
alone):
- Verb *string* including PUT/PATCH/DELETE (naming convention).
- Flat path + `{id}` placement (name + param-name/type).
- param location: path/query/body (name + verb).
- 200/204/404 and typed-error→status (return type + error-variant name).
- Structural sub-resource nesting via the type graph (mount points, inferred from `&T`).
- OpenAPI spec, tags/groups — all derived.

What it **punts or omits**, i.e. the exact "unprojectable" bits:
- **Idempotency semantics / upsert:** not modeled at all (only the verb string is chosen).
- **201/202 and richer status semantics:** require `#[response(status=…)]` (surface-only
  annotation) — *not* inferred.
- **Arbitrary deep path nesting from a flat impl:** only via type-structure delegation, not
  from a leaf method's signature.
- **Auth scopes, caching, content negotiation, pagination:** **not supported** (roadmap /
  out of scope).

So the honest reading: server-less **refutes the strong form** of the claim ("role bits can
determine *nothing* beyond naive CRUD") — it clearly projects PUT/PATCH/DELETE, id-nesting,
and status-from-type unaided, using *more* signal than 1.58 bits of role (it also reads the
full method-name prefix, param names, param types, return type, error-variant names, and the
type graph). But it **does not refute the specific list** the adversary called unprojectable:
of those six items it truly *derives* essentially none from role+types alone — it derives
verb/path/basic-status from **naming convention + type structure**, and it **punts** exactly
idempotency-guarantee, 201/202, auth-scope, caching, content-negotiation, and pagination —
either to surface-only annotations or to "not supported."

The lever that makes its projection work is **goal relaxation**: it targets the RPC
intersection (typed call → typed result), defaults unknowns to POST-RPC, and declares HTTP's
operational envelope out of scope. Under that relaxation, "unaided projection" is real and
shipping. It does not show that the *full* HTTP surface (with idempotency, auth, caching,
negotiation, pagination) is projectable from types+role without surface-level input — on
those bits it either asks for a surface annotation or declines. Crucially, though, the
annotations it *does* require are **surface-only re-tunings, never domain re-declarations**,
which is consistent with the user's "arguably fine" category.

Net: a genuine counterexample to the *maximalist* impossibility claim, and a strong existence
proof that the RPC core projects cleanly; but a **dodge, not a refutation**, of the precise
six-bit list, achieved by scoping those bits out.
