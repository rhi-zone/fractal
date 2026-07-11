# MCP projection — mental model

What the MCP (Model Context Protocol) tool projection encodes *about an operation*: the
concepts and distinctions MCP forces you to name when you present an op to a model as a
tool. Grounded in (1) server-less's real projection macro and (2) the real MCP tool spec.
Goal downstream: separate distinctions that RECUR across ≥2 projections (→ agnostic op
keys) from MCP-only ones (→ `mcp:`-namespaced keys).

## Sources

- server-less projection macro:
  `/home/me/git/rhizone/server-less/crates/server-less-macros/src/mcp.rs` (679 lines)
- parse-time metadata extraction:
  `/home/me/git/rhizone/server-less/crates/server-less-parse/src/lib.rs`
- skip/hidden flags:
  `/home/me/git/rhizone/server-less/crates/server-less-macros/src/server_attrs.rs`
- JSON type inference:
  `/home/me/git/rhizone/server-less/crates/server-less-rpc/src/lib.rs` (391–436)
- MCP tool spec: a tool is `{ name, title?, description?, inputSchema, annotations? }`
  where `annotations` (a `ToolAnnotations` object) carries `title?`, `readOnlyHint?`,
  `destructiveHint?`, `idempotentHint?`, `openWorldHint?` (MCP 2025-03-26). Tools are
  presented to a *model to plan over*, so description + hints are planning inputs, not
  human docs.

## The MCP concept list (what MCP encodes about an op)

MCP's tool object encodes eight distinguishable things about an operation:

1. **name** — machine identifier the model emits to call the tool.
2. **title** — human/display label (in `annotations.title`, and in 2025-06-18 also a
   top-level `title`).
3. **description** — natural-language account of *what the op does*; the model's primary
   planning signal.
4. **inputSchema** — JSON Schema (`type:"object"` + `properties` + `required`) describing
   arguments; both a call-construction guide and a validation contract.
5. **readOnlyHint** — does the op modify its environment? (`annotations`)
6. **destructiveHint** — may the op perform destructive/irreversible updates? (only
   meaningful when not read-only) (`annotations`)
7. **idempotentHint** — does repeating the call with the same args have no additional
   effect? (`annotations`)
8. **openWorldHint** — does the op touch an open/external world (web, filesystem, other
   systems) vs a closed/self-contained domain? (`annotations`)

Per concept: what MCP NEEDS to know, and where it could come from.

### name
- **Needs:** a stable, unique, model-facing identifier.
- **Could come from:** inferred from the op's identity (function/method name); or an
  agnostic "wire name / id" property shared with every projection; or MCP-specific override.
- **Classification: [LIKELY-AGNOSTIC]** — every projection needs an identifier (HTTP route
  segment, CLI subcommand, RPC method). The *identity* is agnostic; only the spelling
  conventions differ per projection.

### title
- **Needs:** a human-readable display label, distinct from the machine `name`.
- **Could come from:** agnostic "display name" property; or MCP-specific authoring.
- **Classification: [MCP-SPECIFIC] (weakly)** — a display title is a UI affordance of
  MCP's tool-list presentation. CLI has `help`/usage summaries and HTTP has
  OpenAPI `summary`, so a display label *concept* is arguably agnostic, but MCP's exact
  `annotations.title` slot is MCP-shaped. Treat as MCP-specific unless a second projection
  is shown to consume the same display-label key.

### description
- **Needs:** what the op does, in natural language, good enough for a model to *plan* with.
- **Could come from:** inferred from doc comments (`///`); or an agnostic "description/doc"
  property; or MCP-specific authoring.
- **Classification: [LIKELY-AGNOSTIC]** — doc/description text is consumed by CLI help,
  HTTP/OpenAPI `description`, and MCP alike. Strong cross-projection recurrence candidate.

### inputSchema
- **Needs:** the argument shape as JSON Schema (`type`, `properties`, `required`,
  per-property `type` + `description`).
- **Could come from:** inferred from the op's parameter types + per-param annotations.
- **Classification: [MCP-SPECIFIC] (format) / [LIKELY-AGNOSTIC] (source)** — the *set of
  parameters, their types, requiredness, and per-param help* is agnostic (HTTP query/body
  params, CLI flags/args all draw on the same underlying param model). The **JSON-Schema
  serialization** is MCP-specific (HTTP might emit OpenAPI schema, CLI emits flag specs).
  So: agnostic param model → MCP-specific JSON-Schema *rendering*.

### readOnlyHint / destructiveHint / idempotentHint / openWorldHint
- **Needs:** behavioral properties of the op — mutates? destructive? idempotent? touches
  an open world?
- **Could come from:** an agnostic op-behavior property set; MCP just reads them.
- **Classification: [LIKELY-AGNOSTIC] — CALLED OUT EXPLICITLY.** These four MCP "hints"
  look *exactly* like protocol-agnostic op properties:
  - **readOnly** ≈ HTTP safe-method distinction (GET vs POST/PUT/DELETE); a CLI could grey
    out or dry-run read-only commands.
  - **destructive** ≈ HTTP DELETE / "dangerous" CLI ops needing confirmation.
  - **idempotent** ≈ HTTP idempotent methods (PUT/DELETE) vs non-idempotent (POST); retry
    logic in any RPC transport keys off this.
  - **openWorld** ≈ whether an op calls out to external systems — a caching / sandboxing /
    permissioning concern that HTTP and CLI both plausibly care about.
  MCP happens to be the projection that *names* these first, but the distinctions are op
  properties, not MCP inventions. These are the **strongest cross-protocol agnostic-key
  candidates** in the whole MCP surface. If HTTP's projection also wants safe/idempotent,
  these become agnostic keys (e.g. `op.readOnly`, `op.idempotent`, `op.destructive`,
  `op.openWorld`) that MCP merely *reads* into its `annotations`.

## Summary classification table

| MCP concept       | Needs                          | Classification                         |
|-------------------|--------------------------------|----------------------------------------|
| name              | model-facing identifier        | [LIKELY-AGNOSTIC]                      |
| title             | human display label            | [MCP-SPECIFIC] (weak)                  |
| description       | plannable NL account           | [LIKELY-AGNOSTIC]                      |
| inputSchema       | param shape as JSON Schema     | agnostic param model + [MCP-SPECIFIC] JSON-Schema render |
| readOnlyHint      | does it mutate?                | [LIKELY-AGNOSTIC] ★                    |
| destructiveHint   | irreversible update?           | [LIKELY-AGNOSTIC] ★                    |
| idempotentHint    | repeat = no extra effect?      | [LIKELY-AGNOSTIC] ★                    |
| openWorldHint     | external world?                | [LIKELY-AGNOSTIC] ★                    |

★ = the four hint fields; strongest agnostic-key candidates.

## What server-less ACTUALLY does (cited)

server-less's projection is a strict subset — it emits only **three** of the eight concepts,
and consumes **no** `mcp:`-namespaced keys.

### No `mcp:` key namespace
There is no `mcp:` metadata-key namespace anywhere in `mcp.rs`. The only "namespace" is a
flat **string prefix on tool names** (`namespace_prefix`, e.g. `myapp_create_user`), baked
directly into the `name` string. No MCP-spec namespace wire fields, no key-prefixing scheme.

### name (mcp.rs 401–443)
`format!("{}{}", namespace_prefix, base_name)` where
`base_name = method.wire_name_or(|n| n)` — the raw Rust method name (identity transform, no
case change). Overridable via `#[server(name=...)]` / `#[mcp(name=...)]` → `wire_name` in
`MethodInfo` (parse 362–387). Emits `"name"`.
- **Divergence flagged:** dispatch arms (mcp.rs 450, 459) match on `method.name` (raw
  ident), not `wire_name_or`, so a renamed method is *listed* under its wire name but
  *dispatched* under the raw name. Latent bug worth noting.

### description (mcp.rs 407–410)
`method.docs.clone().unwrap_or(base_name)` — inferred entirely from `///` doc comments
(parse 330–351, multi-line joined with `\n`), falling back to the method name. No separate
explicit description annotation. Emits `"description"`.

### inputSchema (mcp.rs 419–443)
Always `{"type":"object","properties":{...},"required":[...]}`. Param wire names from
`#[param(name=...)]` else the param name; per-param descriptions from `#[param(help=...)]`
else `"Parameter: <name>"`. Types inferred by `infer_json_type` (rpc 395–436): String→
string, ints→integer, f32/f64→number, bool→boolean, Vec/slice→array, maps→object,
`Option<T>`→recurse, else→object. `Option<T>` params are excluded from `required`;
context-injected params are stripped from the schema entirely. Emits `"inputSchema"`.

### The hints and title: ABSENT
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and `title` are
**neither consumed nor emitted**. The generated tool object has exactly three keys:
`name`, `description`, `inputSchema` (mcp.rs 432–442). No macro argument, server flag, or
param attribute exists for any hint or for `title`.

This is the **load-bearing gap**: server-less proves the agnostic op *properties* that MCP's
hint fields would surface (readOnly / destructive / idempotent / openWorld) are exactly the
distinctions currently unmodeled at the op core. When ≥2 projections want them, they graduate
to agnostic keys; `title` and the JSON-Schema *rendering* stay MCP-namespaced.

### Related projection mechanics (not tool-object fields)
- `#[server(skip)]` fully excludes an op; `#[server(hidden)]` excludes from *listing* but
  keeps it dispatchable (server_attrs.rs).
- Mount points compose the namespace prefix; slug mounts inject extra schema params.
