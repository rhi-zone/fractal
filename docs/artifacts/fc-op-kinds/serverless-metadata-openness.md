# server-less metadata openness — OPEN vs CLOSED

Repo: `/home/me/git/rhizone/server-less` (Rust). Question: is the attribute/metadata
system OPEN (per-projection, new projection self-contained) or CLOSED (central whitelist
gates what's recognized)?

## 1. What is `PROTOCOL_ATTRS`?

`crates/server-less-parse/src/lib.rs:353-356`:

```rust
/// Known protocol attribute identifiers used by server-less macros.
const PROTOCOL_ATTRS: &[&str] = &[
    "server", "cli", "http", "mcp", "jsonrpc", "grpc", "ws", "graphql", "tool",
];
```

It IS a fixed list of 9 protocol-attribute identifiers. But it is **not a gate** and it does
not error on unknowns. Its only use is a lookup set inside `extract_wire_name`
(`lib.rs:362-386`), the single reference besides the definition (grep: only lines 354 and
367 mention it):

```rust
fn extract_wire_name(attrs: &[syn::Attribute]) -> Option<String> {
    for attr in attrs {
        let is_protocol = attr.path().get_ident()
            .is_some_and(|id| PROTOCOL_ATTRS.iter().any(|p| id == p));
        if !is_protocol { continue; }              // <-- unknown top-level attr: IGNORED
        ...
        if meta.path.is_ident("name") { found = Some(...) }
        else if meta.input.peek(syn::Token![=]) { /* consume & ignore other keys */ }
        ...
    }
    None
}
```

Behavior on a top-level attribute NOT in `PROTOCOL_ATTRS`: **silently ignored** (`continue`,
`lib.rs:369-370`) — no error, no pass-through munging. `PROTOCOL_ATTRS` exists only so that a
shared `name = "..."` wire-name override can be read off whichever protocol attr carries it.
It does not decide which attributes are "recognized" overall.

## 2. Are the per-projection attribute parsers independent?

Yes. Each projection macro lives in its own file in `crates/server-less-macros/src/` (http.rs,
cli.rs, mcp.rs, grpc.rs, ws.rs, jsonrpc.rs, graphql.rs, openapi.rs, capnp.rs, thrift.rs,
smithy.rs, asyncapi.rs, openrpc.rs, markdown.rs, connect.rs, jsonschema.rs, server.rs, tool.rs,
serve, …). Each registers its own `#[proc_macro_attribute]` in `server-less-macros/src/lib.rs`
(http:429, cli:549, mcp:615, ws:707, grpc:970, …).

Each macro parses its OWN top-level args with its OWN local `const VALID` list and errors on
unknown args — the whitelist is per-macro, not central:

- `http.rs:257` — `VALID = &["prefix","openapi","name","description","version","homepage","debug","trace"]`
- `mcp.rs:90`  — `VALID = &["namespace"]`
- `grpc.rs:83` — `VALID = &["package","schema"]`
- `ws.rs:292`  — `VALID = &["path"]`
- `cli.rs:272` — its own `VALID` list

So top-level projection attribute parsing is **decentralized**: each projection crate-file owns
its own keys and its own error message.

### The centralized part (shared method/param attrs)

`server-less-parse` DOES centralize the *shared, cross-projection* attributes, each with a
hardcoded `VALID` list that errors on unknown keys:

- `#[param(...)]` — parsed in `server-less-parse/src/lib.rs:585` (`parse_param_attrs`); unknown
  key -> hard error against `VALID = ["name","default","query","path","body","header","short",
  "help","positional","env","file_key","nested","serde","env_prefix"]` (`lib.rs:690-712`).
- `#[route(...)]` — parsed in `server-less-macros/src/openapi_gen.rs:37`; unknown key -> hard
  error against a `VALID` list (`openapi_gen.rs:78`).
- `#[response(...)]` — parsed in `openapi_gen.rs:126`; unknown key -> hard error
  (`openapi_gen.rs:154`).

These are the *shared vocabulary* every projection reuses, not per-projection keys.

## 3. Decisive test: adding a brand-new projection `#[foo]`

To add `#[foo]` with its own top-level metadata keys:

1. Add `crates/server-less-macros/src/foo.rs` with a `Foo`-args parser + its own local
   `const VALID` list + codegen. (self-contained, no core edit)
2. Register `#[proc_macro_attribute] pub fn foo(...)` in `server-less-macros/src/lib.rs`
   (mechanical, alongside the other ~25 registrations).

That is all that is required for a projection that owns its own attribute keys. **No edit to
`PROTOCOL_ATTRS` or any central match is needed** for the projection to define and error-check
its own keys.

Two things pull `#[foo]` toward the central crate, but ONLY if it wants to reuse shared
machinery:

- If `#[foo(name = "...")]` should feed the shared wire-name extraction, add `"foo"` to
  `PROTOCOL_ATTRS` (`lib.rs:354`). Otherwise `foo` can read its own `name` locally and skip this.
- If `#[foo]` wants to introduce a NEW *param-level* key (e.g. `#[param(foo_only = ...)]`), that
  is impossible without editing `parse_param_attrs`'s central `VALID` in `server-less-parse`.
  Reusing the existing `#[param]`/`#[route]`/`#[response]` keys as-is needs no edit.

## 4. Unknown-key behavior at the projection level / namespacing

Namespacing is by the **outer attribute path**. Each macro only inspects its own attribute
idents and strips them before re-emitting the impl; it leaves other projections' attributes
alone. E.g. `strip_http_attrs` (`http.rs:288-308`) retains everything except
`route`/`response`/`http`/`param` — it does NOT touch `#[cli]`/`#[mcp]`/`#[server]`, so stacked
projections coexist. A macro errors only on unknown keys *within its own attribute*
(`#[http(bogus)]` -> error at `http.rs:257`), never on a sibling projection's attribute.

`extract_wire_name` is deliberately tolerant even inside a protocol attr: non-`name` keys are
consumed and ignored (`lib.rs:377-379`), so `#[http(prefix="/x")]` doesn't confuse the shared
`name` reader.

## VERDICT: MIXED — open for new projections, with a small central seam

- **OPEN (per-projection):** A new projection and all of *its own* top-level metadata keys are
  self-contained — new file + macro registration, zero core edits. Each projection owns its own
  parser and its own `VALID` whitelist (http.rs:257, mcp.rs:90, grpc.rs:83, ws.rs:292). Projections
  coexist by path-namespacing and never error on each other's attributes.
- **GATED (central):** (a) `PROTOCOL_ATTRS` (`lib.rs:354`) is a fixed 9-element list — but it only
  gates the *shared `name=` wire-name convenience*, not recognition in general, and it *ignores*
  (never errors on) unknown attrs. (b) The shared cross-projection attrs `#[param]`, `#[route]`,
  `#[response]` have centralized hardcoded key whitelists in server-less-parse / openapi_gen; you
  cannot add a NEW key to those shared attributes without editing core.

### On the prior claim vs the author

The prior read ("every parser hard-codes valid keys and errors on unknowns; a NEW projection
cannot add keys without editing core, cite `PROTOCOL_ATTRS`") is **largely wrong on the crux**:

- `PROTOCOL_ATTRS` is **not** the whitelist that gates projection recognition and does **not**
  error on unknowns — it is a name-extraction lookup set that silently ignores non-members.
- The "hard-code valid keys / error on unknowns" behavior is real, but it is **per-projection**
  (each macro's own `VALID`), which is exactly the author's point — that makes new-projection
  top-level keys OPEN.

The author is right that parsers are per-projection. The one true "closed" residue is the
*shared* vocabulary: `PROTOCOL_ATTRS`'s `name` convenience and the central `param`/`route`/
`response` key lists. A new projection that stays within its own attribute namespace is OPEN;
extending the *shared* attributes requires core edits.
