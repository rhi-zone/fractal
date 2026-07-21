# Directive contract

A leaf/branch node's `meta` bag (`packages/api-tree/src/node.ts`) is open —
any projector may read any key. Two conventions carry the load in practice:

- **`meta.tags`** — agnostic, three-valued behavioral tags (`readOnly`,
  `idempotent`, `destructive`, `openWorld`, `streaming`, `deprecated`),
  defined in `packages/api-tree/src/tags.ts`. Read directly off each node's
  own meta — no ancestor inheritance. `resolveTags` applies the implication
  lattice (`readOnly ⇒ idempotent`; `readOnly ∧ destructive` → conflict).
- **`meta.<projector>`** — an open, per-projection override bag
  (`meta.http`, `meta.cli`, `meta.mcp`, `meta.graphql`, `meta.openapi`).
  Each projector exports its own `get<X>Meta(meta)` parser. Overrides always
  win over tag-derived defaults.

This page is a lookup reference, not a narrative — see
`docs/design/dispatch-extensibility.md` for the DU + interpreter pattern
these bags follow, and `docs/design/router-model.md` /
`docs/design/routing-and-transforms.md` for the HTTP pipeline these
directives drive.

## Agnostic tags — `meta.tags`

| Tag | Controls | Read by | Absent (default) |
|---|---|---|---|
| `readOnly` | Marks the operation as producing no observable side effects | HTTP (`verbFromTags` → `GET`), CLI (help annotation), MCP (`readOnlyHint`), GraphQL (`Query` vs `Mutation` inference) | Unknown — no verb/type inferred from this tag alone |
| `idempotent` | Calling N times ≡ calling once | HTTP (`verbFromTags` → `PUT`/`DELETE`), MCP (`idempotentHint`) | Unknown; implied `true` when `readOnly: true` |
| `destructive` | Irrevocably destroys state | HTTP (`verbFromTags` → `DELETE` when combined with `idempotent: true`), CLI (confirmation gate: requires `--yes`/`--force`), MCP (`destructiveHint`) | Unknown; conflicts with `readOnly: true` |
| `openWorld` | May reach external systems/networks | MCP (`openWorldHint`) | Unknown; not surfaced |
| `streaming` | Yields a sequence of items over time (vs. a single value) | CLI (`--jsonl` streaming output, help annotation), GraphQL (`Subscription` inference) | Unknown; treated as non-streaming |
| `deprecated` | Operation slated for removal | CLI (`[DEPRECATED]` prefix in listings/help), MCP (`deprecated: true` on tool/resource/prompt descriptors), GraphQL (`@deprecated` SDL directive, unless `meta.graphql.deprecated` overrides), HTTP/OpenAPI (`OpenApiOperation.deprecated`, unless `meta.openapi.deprecated` overrides) | Not deprecated |

Verb derivation precedence in HTTP (`verbFromTags`, `packages/http-api-projector/src/tags.ts`):
1. `meta.http` directive `{ kind: "verb" }` (see below) — always wins.
2. `readOnly === true` → `GET`.
3. `idempotent === true && destructive === true` → `DELETE`.
4. `idempotent === true` → `PUT`.
5. Otherwise → `POST` (conservative default).

Operation-type derivation precedence in GraphQL (`deriveOperationType`,
`packages/graphql-api-projector/src/project.ts`):
1. `meta.graphql.operation` — always wins.
2. `tags.streaming === true` → `Subscription`.
3. `tags.readOnly === true` → `Query`.
4. Otherwise → `Mutation`.

## HTTP — `meta.http`

`meta.http.directives` is an array of tagged `HttpDirective` values
(`packages/http-api-projector/src/project.ts`). `getHttpMeta` resolves the
raw bag; last directive of a given `kind` in the array wins.

| `kind` | Shape | Controls | Read by | Absent |
|---|---|---|---|---|
| `verb` | `{ value: string }` | Explicit HTTP method override; wins over tag-derived verb | `verbFromTags` (`tags.ts`) | Verb falls through to tag-lattice derivation |
| `method` | `{ value: string }` | Sets the HTTP method on a route's method entry in the `HttpRoute` tree | `applyMethods` rewriter (`route.ts`) | Route keeps the `naiveTransform` baseline (`POST`) |
| `moveTo` | `{ path: string }` | Relative node placement in the output route tree (`..`, `../foo`, `*` path algebra) | `applyMoveTo` rewriter (`route.ts`) | Node stays at its tree-derived path |
| `response` | `{ status?: number; headers?: Record<string,string> }` | Response status/header overrides, materialized into the handler | `applyResponse` rewriter (`route.ts`) | Default response shaping (200, no extra headers) |
| `segment` | `{ value: string }` | Explicit path-segment rename | **Currently unread** — retired from HTTP's own dispatch along with the direct tree-walk dispatcher; parsed into `HttpMeta.segment` by `getHttpMeta` but no projector (HTTP, OpenAPI, client) consumes it today | n/a |
| `when` | `{ value: string }` | Per-child match-value override for non-method attribute dispatch | **Currently unread** — same retirement as `segment`; attribute dispatch (header/query/contentType) has no equivalent in the current `HttpRoute` pipeline | n/a |
| `legacyPath` | `{ value: string }` | [DEBT] Full-path override, bypasses tree-walk address | **Currently unread** — same retirement as `segment` | n/a |

`meta.http.dispatch` (a `{ kind: "method" | "header" | "query" | "contentType" }`
marker, collapsed by `getHttpMeta` to `{ kind: "method" | "attr" }`) is parsed
but likewise not consumed by the current `HttpRoute` pipeline — a holdover
from the retired direct tree-walk dispatcher.

## OpenAPI — `meta.openapi`

Read by `packages/http-api-projector/src/openapi.ts`, on top of the HTTP
route tree the `meta.http` directives already produced.

| Key | Shape | Controls | Scope | Absent |
|---|---|---|---|---|
| `operationId` | `string` | `OpenApiOperation.operationId` | Method-entry node | Derived from codegen name or path |
| `summary` | `string` | `OpenApiOperation.summary` | Method-entry node | Omitted |
| `description` | `string` | `OpenApiOperation.description` | Method-entry node | Omitted |
| `tags` | `string[]` | `OpenApiOperation.tags` | Method-entry node | Omitted |
| `deprecated` | `boolean` | `OpenApiOperation.deprecated` — **wins over** `meta.tags.deprecated` when explicitly set (back-compat override) | Method-entry node | Falls back to `meta.tags.deprecated` |
| `security` | `OpenApiSecurityRequirement[]` | Per-operation security requirement; on the **root** node instead, becomes the spec-level default (`OpenApiDoc.security`) | Any node (root = spec default) | No security requirement emitted |
| `securitySchemes` | `Record<string, OpenApiSecurityScheme>` | Merged into `components.securitySchemes` from every node in the tree (last-write-wins per scheme name) | Any node | `components` omitted entirely if no node sets this |

## CLI — `meta.cli`

Read by `packages/cli-api-projector/src/cli.ts` via `getCliMeta`.

| Key | Shape | Controls | Absent |
|---|---|---|---|
| `name` | `string` | Subcommand display name in listings/help | Falls back to the tree key |
| `alias` | `string` | Alternate leaf-lookup name (in addition to the tree key) | No alias |
| `hidden` | `boolean` | Excludes the leaf/branch from listings and help | Shown |
| `sourceMap` | `SourceMap` | Per-param source override for input assembly (e.g. pull a field from `env` instead of a flag) | Params resolve via the default flag/slug convention |

Also reads the shared `meta.description` (top-level Meta key, not
`meta.cli`-scoped) as a fallback when `meta.cli.description` isn't set — used
for command help text. `meta.tags.deprecated`/`destructive`/`readOnly`/`streaming`
drive help annotations and the destructive-confirmation gate (see tags table
above).

## MCP — `meta.mcp`

Read by `packages/mcp-api-projector/src/project.ts` via `getMcpMeta`. One
leaf may target the tool, resource, or prompt surface via `as`.

| Key | Shape | Controls | Applies to | Absent |
|---|---|---|---|---|
| `as` | `"tool" \| "resource" \| "prompt"` | Which MCP surface the leaf projects to | Leaf | `"tool"` (default) |
| `name` | `string` | Full name/URI override (prefix suppressed when set) | Tool, resource | Underscore-joined tree-position prefix + leaf key |
| `description` | `string` | Description text override | Tool, resource, prompt | Falls back to `meta.description`, then JSDoc-derived (codegen), then leaf key |
| `title` | `string` | Emits `annotations.title` | Tool | Omitted |
| `segment` | `string` | This branch node's contribution to the name/URI prefix | Branch | Tree key used |
| `annotations` | `McpAnnotations` | Merged over tag-derived hints (override wins per key) | Tool | Tag-derived hints only (`hintsFromTags`) |
| `uri` | `string` | Full resource URI override | Resource | Derived from tree position |
| `mimeType` | `string` | Resource MIME type | Resource | `"application/json"` |
| `sourceMap` | `SourceMap` | Per-param source override for input assembly | Tool, resource template, prompt (not fixed resources — they take no input) | Params resolve via the default argument/URI-variable convention |

`meta.tags.deprecated` surfaces as `deprecated: true` on the tool/resource/prompt
descriptor (omitted, not `false`, when unset — three-valued semantics).

## GraphQL — `meta.graphql`

Read by `packages/graphql-api-projector/src/project.ts` via `getGraphQLMeta`.

| Key | Shape | Controls | Absent |
|---|---|---|---|
| `operation` | `"query" \| "mutation" \| "subscription"` | Overrides tag-derived operation-type inference outright | Derived from tags (see precedence above) |
| `name` | `string` | Full field-name override (prefix/camelCase-join ignored when set) | Underscore/camelCase-joined tree-position name |
| `namespace` | `string` | This branch's contribution to the namespace path (Query only) | Tree key used |
| `description` | `string` | Emitted as an SDL `"""..."""` block | Falls back to `meta.description`, then JSDoc-derived |
| `deprecated` | `boolean` | Overrides `meta.tags.deprecated`-derived deprecation | Derived from `meta.tags.deprecated` |
| `deprecatedReason` | `string` | `@deprecated(reason: ...)` text — only meaningful when `deprecated` resolves `true` | Bare `@deprecated` with no reason |
| `sourceMap` | `SourceMap` | Per-arg source override for input assembly | Args resolve directly from the resolver's flattened `args` bag |

## Cross-cutting: `meta.description`

A top-level `Meta` key (not namespaced to any one projector), used as a
shared fallback description source. Read directly by CLI and GraphQL, and
by MCP (`child.meta.description`) — each ranked below their own
`meta.<projector>.description` override and above JSDoc/codegen-derived text
or the bare leaf key. HTTP/OpenAPI does not read it directly; OpenAPI uses
`meta.openapi.description` or codegen-derived text instead.
