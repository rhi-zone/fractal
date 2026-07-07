# CLI Projection — Concept Inventory and server-less Analysis

> Source files examined:
> - `server-less/crates/server-less-macros/src/cli.rs` (2560 lines, cited below as `cli.rs:N`)
> - `server-less/crates/server-less-parse/src/lib.rs` (cited as `parse/lib.rs:N`)
> - POSIX.1-2017, GNU Coding Standards, clap 4 docs (for concepts not in server-less source)

---

## A. CLI Concept Inventory

---

### [LIKELY-AGNOSTIC] Operation Name (subcommand name)

The CLI name of a leaf operation is derived by converting the Rust method name to kebab-case
(`create_user` → `create-user`). The transformation is in `cli_name` (cli.rs:597–599), which
calls `method.wire_name_or(|n| n.to_kebab_case())`.

An explicit override is possible at two levels:

- **Method level:** `#[cli(name = "...")]` (cli.rs:14). Stored in `MethodInfo::wire_name`
  (parse/lib.rs:44); `wire_name_or` returns it verbatim when set (parse/lib.rs:112–118).
- **Impl level:** `#[cli(name = "...")]` on the impl block sets the top-level binary name
  (cli.rs:688–706); falls back to `struct_name.to_kebab_case()` (cli.rs:706).

**Source:** agnostic op property (the operation's human-facing label), plus CLI-specific rendering
(kebab-case, clap `Command::name`).

**Cross-protocol:** Every protocol projection needs an operation name. server-less uses
`wire_name_or` identically in `http.rs`, `mcp.rs`, `grpc.rs`, `jsonrpc.rs`.

---

### [LIKELY-AGNOSTIC] Description / Help Text

Rust doc comments on a method are collected as a single string in `MethodInfo::docs`
(parse/lib.rs:33). `split_docs` (cli.rs:1422–1441) splits at the first blank line:

- **First paragraph** → clap `.about(text)` — the one-line summary in `--help` listings.
- **Subsequent paragraphs** → clap `.after_help(text)` — extended text shown in per-command
  `--help`. Emitted at cli.rs:1451, 1502, 1534.

A blank `about` emits an empty string; clap omits it from help. Missing docs are fine and common.

The impl-level description is authored via `#[cli(description = "...")]` (cli.rs:209), with an
optional `#[cli(description_prefix = false)]` that controls whether the app name is prepended as
`"name - description"` (cli.rs:711–715).

**Source:** agnostic op property — doc comments are the single source of truth for human-facing
descriptions across all projections. The CLI simply renders them in `--help`.

**Cross-protocol:** OpenAPI `summary`/`description`, MCP tool `description`, gRPC `comment`, and
CLI `--help` all read from the same doc-comment source. This is the strongest cross-protocol
candidate in the entire concept set.

---

### [CLI-SPECIFIC] Version

`#[cli(version = "...")]` (cli.rs:202–204) or the fallback `env!("CARGO_PKG_VERSION")` (cli.rs:709)
is passed to clap `.version(...)` (cli.rs:1354). Clap renders it under `--version`/`-V`.

No other server-less projection exposes a version string in this way; HTTP uses `info.version` in
OpenAPI but it is not wired to this field in the CLI macro.

**Source:** CLI-specific metadata authored at the impl level.

---

### [LIKELY-AGNOSTIC] Homepage / Contact URL

`#[cli(homepage = "...")]` (cli.rs:213–215) stores a URL that is carried in `CliArgs::homepage`
(cli.rs:118) but — in the current server-less source — is not wired into any clap call. It appears
to be reserved metadata for future use (e.g. `clap::Command::long_about` or man-page generation).

**Source:** agnostic op-tree property; parallel to OpenAPI `info.contact.url`.

---

### [LIKELY-AGNOSTIC] Skip / Exclude from Projection

`#[cli(skip)]` and its alias `#[cli(helper)]` (cli.rs:18–19, function `has_cli_skip` at
cli.rs:311–333) exclude a method from becoming a subcommand entirely. The function also checks
`#[server(skip)]` (via `has_server_skip` at cli.rs:312), so a cross-protocol skip exists at the
agnostic level.

`#[cli(helper)]` is a self-documenting alias — "this method is a display formatter or internal
helper, not a public operation" — with identical runtime behavior.

**Source:** agnostic op property (is-this-exposed). `#[server(skip)]` is the protocol-neutral
carrier; `#[cli(skip)]` and `#[cli(helper)]` are CLI-specific syntax sugar on top.

**Cross-protocol:** Every projection in server-less checks `has_server_skip` before emitting a
method. MCP, HTTP, gRPC, WS all skip methods flagged at the server level.

---

### [LIKELY-AGNOSTIC] Hidden (discoverable but not listed)

`#[cli(hidden)]` (cli.rs:20, function `has_cli_hidden` at cli.rs:499–521) keeps the subcommand
functional but passes `.hide(true)` to clap (cli.rs:1452, 1501, 1533), removing it from `--help`
listings. Also checks `#[server(hidden)]` via `has_server_hidden` (cli.rs:500).

This is distinct from skip: a hidden command still dispatches, but is not advertised. The analogy in
HTTP is an `x-internal: true` flag in OpenAPI specs; in MCP it is omitting a tool from the manifest
listing while keeping the handler registered.

**Source:** agnostic op property (is-this-discoverable). `#[server(hidden)]` is the protocol-neutral
carrier.

**Cross-protocol:** HTTP and MCP projections in server-less also check `has_server_hidden`.

---

### [CLI-SPECIFIC] Default Action (no-subcommand fallback)

`#[cli(default)]` (cli.rs:21, function `has_cli_default` at cli.rs:336–355) marks exactly one
method as the action to run when no subcommand is specified. At most one default is allowed
(compile error otherwise, cli.rs:906–917).

The default method is registered both as a regular subcommand AND as the `None =>` arm of the
dispatch match (cli.rs:941–954). Its args are also hoisted to the parent command so that
`app --flag` parses without naming the subcommand (cli.rs:922–939).

**Source:** CLI-specific authoring. Only meaningful in a subcommand-based CLI.

---

### [CLI-SPECIFIC] Display Formatter

`#[cli(display_with = "fn_name")]` (cli.rs:22–25, `get_display_with` at cli.rs:566–594) names a
method on the same impl block to call for human-readable text output. The generated dispatch
(cli.rs:2047–2050) calls `self.fn_name(&return_value)` and prints the result with `println!`.

This only affects text output; `--json`/`--jsonl`/`--jq` bypass it and use serde serialization
directly (cli.rs:2075–2078).

**Source:** CLI-specific authoring — terminal display formatting is meaningless to HTTP or MCP.

---

### [CLI-SPECIFIC] Alias / Migration Scaffolding

`#[cli(alias = "...")]` and `#[cli(aliases = ["a","b"]]` (cli.rs:15–17, `get_cli_aliases` at
cli.rs:535–564) add hidden clap aliases to the generated subcommand (cli.rs:1455–1456,
1503–1504, 1536). A hidden alias keeps the old command path working without advertising it, used
as one-release migration scaffolding when a verb is renamed or moved.

**Source:** CLI-specific authoring. HTTP and RPC handle renames via HTTP 301/308 redirects or
version negotiation, not command aliases.

---

### [LIKELY-AGNOSTIC] Exclude from Reference Document

`#[cli(manual = false)]` at the method level (cli.rs:357–382, `has_cli_manual_false`) excludes a
specific leaf or mount from the aggregated `--manual` reference document while leaving the command
itself intact and visible in `--help`. This is distinct from `hidden`.

The underlying concept — "include this op in the generated reference documentation" — is agnostic.
In OpenAPI, the equivalent is `x-internal` or `deprecated` status; in MCP it would be whether a
tool is included in a manifest.

**Source:** agnostic op property (is-this-in-generated-docs), with CLI-specific mechanism (the
`--manual` flag and `CliManualNode` tree).

---

### [LIKELY-AGNOSTIC] Method Grouping / Sections

Methods can be assigned to named sections via `#[server(group = "...")]` on the method, with the
groups declared in order via `#[server(groups(...))]` on the impl block. In the CLI projection,
groups produce ANSI-formatted section headings in `--help` output (cli.rs:862–882), because clap
itself does not support multiple subcommand sections (noted at cli.rs:775).

The group system is shared across projections via `server-less-parse`'s `GroupRegistry` and
`resolve_method_group`.

**Source:** agnostic op property (organizational category); CLI-specific rendering (ANSI headings
in `after_help`).

**Cross-protocol:** The same group metadata drives section headers in markdown docs
(`#[markdown]`) and could drive OpenAPI tag assignment.

---

### [LIKELY-AGNOSTIC] Subcommand Hierarchy (static mount)

A method with a reference return type and no parameters — `fn users(&self) -> &Users` — becomes a
static mount point: a named subcommand group that recurses into the child type's `CliSubcommand`
impl (cli.rs:29–33 doc, `generate_static_mount_subcommand` at cli.rs:1489–1519).

The child type must implement `CliSubcommand` (generated by its own `#[cli]` annotation). The CLI
renders this as `app users <subcommand>`. Dispatch delegates to the child's `cli_dispatch`
(cli.rs:2455–2461).

**Source:** structural inference from Rust type shape (`&T` return, no params → mount).

**Cross-protocol:** The same `&T` return shape drives HTTP `.nest_service("/users", ...)`,
MCP tool-name prefix `users_`, JSON-RPC prefix `users.`, and WebSocket equivalents.

---

### [LIKELY-AGNOSTIC] Parameterized Subcommand Group (slug mount)

A method with a reference return type and one or more value parameters — `fn user(&self, id:
UserId) -> &UserService` — becomes a slug mount: a named subcommand that takes positional
arguments before delegating to the child (cli.rs:29–33, `generate_slug_mount_subcommand` at
cli.rs:1521–1570).

Slug parameters become required positional args at index 1, 2, … (cli.rs:1547–1553). At dispatch,
they are extracted and passed to the mount method before delegating to the child's `cli_dispatch`
(cli.rs:2481–2518).

**Source:** structural inference from Rust type shape (`&T` return, has params → slug mount).

**Cross-protocol:** HTTP renders slug params as path segments `/:id/`; the tree position is the
same neutral concept rendered differently per protocol.

---

### [LIKELY-AGNOSTIC] Optional Parameter

A parameter of type `Option<T>` becomes a non-required flag (`--name <NAME>`, `.required(false)`)
in the CLI (`generate_arg`, cli.rs:1722–1735). At extraction, `get_one::<T>(name).cloned()`
returns `None` if the flag was not passed (cli.rs:1878–1895).

**Source:** inferred from type (`is_optional` flag set in `parse/lib.rs` when wrapping type is
`Option`).

**Cross-protocol:** Optionality is universal. OpenAPI marks params as `required: false`; JSON
Schema uses `"required"` list exclusion; MCP leaves fields out of `required`. The specific CLI
rendering (`--flag`) is CLI-specific; the optionality property itself is not.

---

### [LIKELY-AGNOSTIC] Multi-Value Parameter

A parameter of type `Vec<T>` becomes a repeatable flag with comma-delimited values
(`ArgAction::Append`, `.value_delimiter(',')`, cli.rs:1693–1707). Extraction accumulates into a
`Vec` (cli.rs:1858–1877).

**Source:** inferred from type (`is_vec` flag).

**Cross-protocol:** Array-valued parameters appear in HTTP (repeated query params, JSON body
arrays), gRPC (repeated fields), MCP (array properties in `inputSchema`). The accumulation
semantics are agnostic; the specific comma-delimiter / `--flag val1 --flag val2` surface is
CLI-specific.

---

### [CLI-SPECIFIC] Boolean Flag

A parameter of type `bool` becomes a boolean flag (`--flag`, `ArgAction::SetTrue`, cli.rs:1681–1691).
Presence → `true`, absence → `false`. No value is taken; the flag is self-contained.

**Source:** inferred from type (`is_bool` flag).

**Note:** In HTTP/RPC boolean parameters are query params (`?verbose=true`) or body fields — the
`--flag` idiom (presence = true) is CLI-specific. The underlying "is this a boolean" property is
agnostic; the SetTrue rendering is not.

---

### [CLI-SPECIFIC] Positional Argument

A parameter with `#[param(positional)]` or identified as an ID-like parameter (`is_id = true` in
`parse/lib.rs`) is registered as a positional arg with `.index(N)` (cli.rs:1708–1721). The index
is 1-based and assigned in declaration order.

**Source:** inferred from type/heuristic (`is_positional` flag) or explicit `#[param(positional)]`.

**Note:** Positional ordering is a CLI concept. HTTP/RPC have no positional argument ordering; ID
values appear in URL path segments (ordered by URL structure, not declaration order).

---

### [CLI-SPECIFIC] Short Flag Character

`#[param(short = 'x')]` (parse/lib.rs:82, emitted at cli.rs:1649, 1689, 1699, 1729) adds a
single-character `-x` flag as an alias for the long `--flag-name` form.

**Source:** CLI-specific authoring.

**Note:** No other projection in server-less reads `short_flag`.

---

### [LIKELY-AGNOSTIC] Parameter Name Override (wire name)

`#[param(name = "...")]` sets `ParamInfo::wire_name` (parse/lib.rs:75). `cli_param_name`
(cli.rs:601–611) uses this verbatim as the clap arg id, long flag name, and extraction key.

**Source:** agnostic op property — the wire-facing name of a parameter.

**Cross-protocol:** HTTP uses `wire_name` for query param names and OpenAPI property names; MCP
uses it for JSON property names; JSON-RPC uses it for method parameter names. The field is read
by every projection.

---

### [LIKELY-AGNOSTIC] Parameter Default Value

`#[param(default = ...)]` sets `ParamInfo::default_value` (parse/lib.rs:79). In the CLI, non-bool,
non-vec params use `clap_default_value` to strip string-literal quoting and pass
`.default_value(str)` to clap (cli.rs:653–660, 1654–1659). At dispatch, the `defaults` function
(if configured) is tried before raising a missing-argument error (cli.rs:1896–1919).

The `#[cli(defaults = "fn_name")]` impl-level option (cli.rs:235–237) names a method
`fn(&self, param_name: &str) -> Option<String>` used as a runtime fallback before raising a
missing-argument error.

**Source:** agnostic op property (parameter default value); `defaults` function is CLI-specific
runtime behavior.

**Cross-protocol:** OpenAPI `default` in schema; JSON Schema `default`; gRPC field defaults.

---

### [LIKELY-AGNOSTIC] Parameter Help Text

`#[param(help = "...")]` sets `ParamInfo::help_text` (parse/lib.rs:83). Used verbatim in clap
`.help(text)` (cli.rs:1683, 1697, 1712, 1724, 1737). When absent, the CLI generates a generic
default (`"Enable name"`, `"Repeatable: name"`, `"The name"`, `"Optional: name"`,
`"Required: name"`).

**Source:** agnostic op property (parameter description); CLI-specific rendering (clap `.help()`).

**Cross-protocol:** OpenAPI `description` on parameter objects; MCP `inputSchema` property
descriptions.

---

### [LIKELY-AGNOSTIC] Input Schema

`--input-schema` (enabled by default, suppressible via `#[cli(input_schema = false)]`, cli.rs:148,
1175–1183) causes the CLI dispatch arm to print a JSON Schema object of the method's input
parameters and exit without running the method (cli.rs:1773–1797).

The schema is built at compile time from `ParamInfo` types via `type_to_json_schema`
(cli.rs:1576–1640), with `required` populated from non-optional, non-bool params. The same
schema is embedded in `CliManualNode::input_schema` (cli.rs:2346–2315) for `--manual` output.

**Source:** agnostic op property (input type shape); CLI-specific mechanism (the `--input-schema`
flag).

**Cross-protocol:** MCP's `inputSchema` is structurally identical; OpenAPI's `requestBody` and
parameter schemas serve the same purpose. The underlying data — what types does this operation
accept — is the most cross-protocol concept in the system.

---

### [LIKELY-AGNOSTIC] Output Schema

`--output-schema` (enabled by default, suppressible via `#[cli(output_schema = false)]`, cli.rs:149,
1184–1192) causes the dispatch arm to print a JSON Schema of the return type and exit
(cli.rs:1800–1834).

When the `jsonschema` feature is active, it calls `cli_schema_for::<T>()` (schemars-derived,
cli.rs:1814); otherwise falls back to `type_to_json_schema` on the return type AST. The `ok_type`
of `Result<T,E>` is used, stripping the error wrapper (cli.rs:1801–1808).

**Source:** agnostic op property (output type shape); CLI-specific mechanism.

**Cross-protocol:** OpenAPI `responses` schemas; MCP lacks output schema by spec but the property
is agnostic. The data (what type does this operation return) is cross-protocol.

---

### [CLI-SPECIFIC] Output Format Flags (--json / --jsonl / --jq)

Four output-format flags are unconditionally injected at the root command and propagated globally
via `.global(true)` (cli.rs:1202–1232):

- `--json`: Serializes the return value via serde and prints compact/pretty JSON to stdout.
- `--jsonl`: Outputs one JSON object per line (for array returns, streams one item per line).
- `--jq <expr>`: Filters the JSON output through a jq expression.
- `--params-json <json>`: Replaces individual CLI flag parsing with a single JSON object as input
  (cli.rs:2227–2243). Enables programmatic invocation without constructing many `--flag value`
  pairs.

The format extraction runs in every leaf dispatch arm (cli.rs:2027–2031). JSON-mode error output
is `{"error": "msg"}` to stdout; text-mode errors go to stderr (cli.rs:2100–2116).

**Source:** CLI-specific mechanism for machine-readable output and programmatic input.

**Note:** `--params-json` is the CLI analog of an HTTP request body — both send all parameters as
a structured object — but the CLI mechanism is specific to this projection.

---

### [CLI-SPECIFIC] --manual (Reference Document)

`--manual` (enabled by default, suppressible via `#[cli(manual = false)]` at impl or method level,
cli.rs:144–146, 1193–1201) emits a tree-structured reference document for the command subtree and
exits. At the root, it aggregates `CliManualNode` entries from all leaves and mounts
recursively via `cli_manual_nodes` (cli.rs:1142–1148). At a leaf, it emits just that command's
entry (cli.rs:2166–2185).

Each `CliManualNode` records: command path, description (from doc comment first paragraph),
`input_schema`, and `output_schema`. The format respects `--json`/`--jsonl`/`--jq`: structured
output for machine consumers, rendered text for humans (cli.rs:2270–2285).

`#[cli(manual = false)]` on a method excludes it from `--manual` aggregation while leaving it in
`--help` (cli.rs:357–382).

**Source:** CLI-specific metadata aggregation surface. The underlying data (descriptions + schemas)
is agnostic.

---

### [CLI-SPECIFIC] Global Flags

`#[cli(global = [flag_name = "help text", ...])]` (cli.rs:216–232, `CliArgs::global`) registers
named boolean flags at the root command with `.global(true)`, making them propagate into every
subcommand's `ArgMatches` (cli.rs:1116–1135). The flags are delivered to the implementation via
the `CliGlobals` trait's `set_global_flag` method (cli.rs:2197–2216), before either extraction
path runs.

A parameter whose kebab name collides with a declared global is a compile error
(cli.rs:387–496).

**Source:** CLI-specific mechanism. HTTP handles cross-cutting flags via headers or middleware, not
clap globals.

---

### [CLI-SPECIFIC] Shell Completions

When the `completions` feature is active, the macro generates:

- `cli_completions(shell, out: &mut impl Write)` — writes a shell completion script for the
  given shell (Bash, Zsh, Fish, …) using `clap_complete` (cli.rs:1237–1250).
- `cli_manpage(out: &mut impl Write)` — renders a roff man page using `clap_mangen`
  (cli.rs:1252–1255).

**Source:** CLI/shell ecosystem specific. No analog in other projections.

---

### [CLI-SPECIFIC] Exit Codes

The CLI projection uses `process::exit(1)` for error conditions:

- `Result::Err` return (cli.rs:2115): error message to stderr (text mode) or `{"error":"msg"}`
  to stdout (JSON mode), then exit 1.
- `Option::None` return (cli.rs:2135): "Not found" to stderr, then exit 1.

Success (including unit returns) exits 0 implicitly (the `cli_run` return type is `Result<(),
Box<dyn Error>>` and the `main` wrapper calls `.unwrap()` or propagates).

**Source:** POSIX/GNU convention (0 = success, non-zero = failure). The specific value 1 is
conventional; cli.rs does not parameterize it.

**Note:** Not authored explicitly anywhere in cli.rs — it is hard-coded. There is no
`#[cli(exit_code = N)]` or equivalent.

---

### [CLI-SPECIFIC] stdout vs stderr Routing

- Successful output (all return types) → `println!` → stdout.
- Error text (`Result::Err`, `Option::None` message) → `eprintln!` → stderr.
- JSON-mode errors → `println!` of `{"error":"msg"}` → stdout (for pipeable machine consumers,
  cli.rs:2100–2113).

**Source:** POSIX/GNU convention (output on stdout, diagnostics on stderr). Encoded in the
generated dispatch arms; not configurable per-operation.

---

### [LIKELY-AGNOSTIC] Streaming / Iterator Return

A method whose return type is an iterator is dispatched via the streaming arm (cli.rs:2140–2157):
- Default and `--jsonl`: iterate and emit one JSON line per item (avoids collecting into memory).
- `--json`/`--jq`: collect, serialize as array, then format.

**Source:** inferred from return type (`is_iterator` flag set in parse/lib.rs `ReturnInfo`).

**Cross-protocol:** HTTP maps this to SSE/chunked transfer; WebSocket emits per-message frames;
the underlying "this operation produces a stream of items" property is protocol-agnostic.

---

### [CLI-SPECIFIC] Unit Return → "Done" Output

When a method returns `()`, the CLI prints `"Done"` and exits 0 (cli.rs:2090). This is purely
presentational feedback for the terminal user.

**Source:** CLI-specific convention. HTTP treats a unit return as a 204 No Content; the "Done"
text has no analog.

---

### Not in cli.rs — CLI Conventions cli.rs does not implement

The following are standard CLI/POSIX/GNU concepts that cli.rs does not generate or handle.
They are noted for completeness:

- **`--dry-run`**: A flag indicating "show what would happen without doing it." Not generated;
  must be authored manually as a `bool` param if desired. The underlying property
  (is-this-a-preview-run) would be [LIKELY-AGNOSTIC] — HTTP has analogous idempotency/safety
  concepts.

- **Confirmation prompts for destructive actions**: "Are you sure? [y/N]" prompts are not
  generated. Whether an operation is destructive is metadata that cli.rs does not consume.
  [LIKELY-AGNOSTIC] if represented as an op property; the prompt mechanism itself is
  [CLI-SPECIFIC].

- **Environment variable fallback**: clap supports `.env("VAR")` on args, but cli.rs does not
  inject it. [CLI-SPECIFIC] mechanism; the value-source concept (try env before arg) is
  CLI-specific.

- **Arg files (`@file`)**: clap supports `@file` expansion, but cli.rs does not enable it.
  [CLI-SPECIFIC].

- **Configurable exit codes per error kind**: not parameterized; always 1. [CLI-SPECIFIC].

---

## B. Classification Summary

### [LIKELY-AGNOSTIC] — Other protocols plausibly share this concern

| Concept | Source in cli.rs | Notes |
|---|---|---|
| Operation name | cli.rs:597–599 | `wire_name_or` used across all projections |
| Description / help text | cli.rs:1422–1451 | Universal: OpenAPI, MCP, gRPC, CLI |
| Skip / exclude | cli.rs:311–333 | `has_server_skip` is cross-protocol |
| Hidden (not discoverable) | cli.rs:499–521 | `has_server_hidden` is cross-protocol |
| Method grouping / sections | cli.rs:796–885 | Drives OpenAPI tags, markdown docs |
| Static mount (subcommand group) | cli.rs:1489–1519 | Same `&T` shape drives HTTP/MCP/RPC |
| Slug mount (parameterized group) | cli.rs:1521–1570 | Same shape drives HTTP path params |
| Optional parameter (`Option<T>`) | cli.rs:1722–1735 | Type-inferred; universal optionality |
| Multi-value parameter (`Vec<T>`) | cli.rs:1693–1707 | Type-inferred; universal array params |
| Parameter name override | cli.rs:601–611 | `wire_name` read by all projections |
| Parameter default value | cli.rs:1654–1659 | OpenAPI `default`, JSON Schema `default` |
| Parameter help text | cli.rs:1683–1739 | OpenAPI/MCP param descriptions |
| Input schema | cli.rs:1773–1797 | Same data as MCP `inputSchema`, OpenAPI params |
| Output schema | cli.rs:1800–1834 | Same data as OpenAPI response schema |
| Streaming / iterator return | cli.rs:2140–2157 | HTTP SSE, WS frames, etc. |
| Exclude from reference docs | cli.rs:357–382 | "is-this-in-generated-docs" is agnostic |
| Homepage URL | cli.rs:118 | OpenAPI `info.contact.url`, etc. |

### [CLI-SPECIFIC] — Only CLI cares

| Concept | Source in cli.rs | Notes |
|---|---|---|
| Version string | cli.rs:202–204, 1354 | `--version`/`-V` via clap |
| Default action (no-subcommand) | cli.rs:336–355, 904–954 | `#[cli(default)]` |
| Display formatter | cli.rs:566–594, 2047–2050 | `#[cli(display_with)]`, text output only |
| Hidden alias / migration | cli.rs:535–564 | Renames/moves in CLI path |
| Boolean flag (`bool` → `--flag`) | cli.rs:1681–1691 | SetTrue rendering |
| Positional argument | cli.rs:1708–1721 | `.index(N)` ordering |
| Short flag character | cli.rs:1649 | `-x` single-char alias |
| Output format flags (--json/--jsonl/--jq) | cli.rs:1202–1232 | Machine-readable output switching |
| --params-json bulk input | cli.rs:1226–1232 | JSON-object-as-all-params |
| --manual reference document | cli.rs:1142–1201 | Terminal reference aggregation |
| Global flags | cli.rs:1116–1135 | `.global(true)` clap propagation |
| Shell completions | cli.rs:1237–1250 | `clap_complete` |
| Man page | cli.rs:1252–1255 | `clap_mangen` roff output |
| Exit codes (0/1) | cli.rs:2115, 2135 | POSIX convention, not parameterized |
| stdout vs stderr routing | cli.rs:2095–2116 | Encoded in generated arms |
| Unit return → "Done" | cli.rs:2090 | Terminal feedback convention |
| Confirmation prompts | not in cli.rs | Convention; not generated |
| --dry-run | not in cli.rs | Convention; not generated |
| Env-var fallback | not in cli.rs | clap `.env()`, not wired |
| Arg files (@file) | not in cli.rs | clap feature, not enabled |

---

## C. Strongest Cross-Protocol Candidates

The following concepts appear in the CLI projection AND recur in at least two other projections
(HTTP, MCP, gRPC, JSON-RPC, WS) in server-less. They are the best candidates for placement in
the protocol-agnostic metadata bag:

1. **Description / help text** — CLI `--help`, OpenAPI `summary`/`description`, MCP tool
   `description`, gRPC comment, markdown docs. Already flows from the single doc-comment source
   through every projection.

2. **Operation name (wire name override)** — Every projection calls `wire_name_or(transform)`.
   The override mechanism is already agnostic; only the transform function (kebab-case, snake_case,
   etc.) differs per protocol.

3. **Input / output schema** — CLI `--input-schema`/`--output-schema`, MCP `inputSchema`, OpenAPI
   request/response schemas. The underlying type information is the same; only the schema format
   target (JSON Schema draft-07, OpenRPC, etc.) differs.

4. **Skip / hidden / exclude** — `has_server_skip` and `has_server_hidden` are already
   protocol-neutral in server-less. The "is this op exposed?" and "is this op discoverable?"
   properties are inherently agnostic.

5. **Hierarchical grouping** — Static and slug mounts (`&T` return shapes), method groups
   (`#[server(group)]`). Every projection addresses the same tree differently (URL path, tool
   prefix, subcommand chain, dot-path), but the tree structure itself is neutral.

6. **Optional / required / multi-value parameter** — Optionality and cardinality are universal.
   The type-inference rules (`Option<T>` → optional, `Vec<T>` → array) apply identically across
   HTTP, MCP, gRPC schemas, and CLI.

7. **Streaming return type** — HTTP SSE, WebSocket frames, CLI `--jsonl` line mode, gRPC
   server-streaming. The "this op produces a stream" property is agnostic; the rendering differs.
