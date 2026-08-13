# Directive contract

A leaf/branch node's `meta` bag (`packages/api-tree/src/node.ts`) is open —
any projector may read any key. Two conventions carry the load in practice:

- **`meta.tags`** — agnostic, three-valued behavioral tags (`readOnly`,
  `idempotent`, `destructive`, `openWorld`, `streaming`, `deprecated`),
  defined in `packages/api-tree/src/tags.ts`. Read directly off each node's
  own meta — no ancestor inheritance. `resolveTags` applies the implication
  lattice (`readOnly ⇒ idempotent`; `readOnly ∧ destructive` → conflict).
- **`meta.<projector>`** — an open, per-projection override bag
  (`meta.http`, `meta.cli`, `meta.mcp`, `meta.graphql`, `meta.jsonrpc`,
  `meta.openapi`). Each projector exports its own `get<X>Meta(meta)` parser.
  Overrides always win over tag-derived defaults. All five dispatch
  protocols (http/cli/mcp/graphql/jsonrpc) converge on the SAME shape: a
  flat bag whose cardinality is expressed by value shape, not by a
  directive-envelope tag — at-most-one → scalar key (last-wins), keyed
  partial contribution → map key (key-merged), genuinely multiple/ordered →
  array key (appended). See HTTP's section below for the full rule (the
  migration all five now share) and `docs/design/wire-profiles-and-staged-
validation.md`'s "Prerequisite: meta unification" for the history.

This page is a lookup reference, not a narrative — see
`docs/design/dispatch-extensibility.md` for the DU + interpreter pattern
these bags follow, and `docs/design/router-model.md` /
`docs/design/routing-and-transforms.md` for the HTTP pipeline these
directives drive.

## Agnostic tags — `meta.tags`

| Tag           | Controls                                                    | Read by                                                                                                                                                                                                                                                                                 | Absent (default)                                                                                            |
| ------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `readOnly`    | Marks the operation as producing no observable side effects | HTTP (`verbFromTags` → `GET`), CLI (help annotation), MCP (`readOnlyHint`), GraphQL (`Query` vs `Mutation` inference)                                                                                                                                                                   | Unknown — no verb/type inferred from this tag alone                                                         |
| `idempotent`  | Calling N times ≡ calling once                              | HTTP (`verbFromTags` → `PUT`/`DELETE`), MCP (`idempotentHint`)                                                                                                                                                                                                                          | Unknown; implied `true` when `readOnly: true`                                                               |
| `destructive` | Irrevocably destroys state                                  | HTTP (`verbFromTags` → `DELETE` when combined with `idempotent: true`), CLI (confirmation gate: requires `--yes`/`--force`), MCP (`destructiveHint`)                                                                                                                                    | Unknown; conflicts with `readOnly: true`                                                                    |
| `openWorld`   | May reach external systems/networks                         | MCP (`openWorldHint`) only — MCP-specific, not a general tree-level tag; no other projector reads it                                                                                                                                                                                    | Unknown; explicitly out of scope for HTTP (not just unsurfaced — this tag has no HTTP projection by design) |
| `streaming`   | Yields a sequence of items over time (vs. a single value)   | CLI (`--jsonl` streaming output, help annotation), GraphQL (`Subscription` inference)                                                                                                                                                                                                   | Unknown; treated as non-streaming                                                                           |
| `deprecated`  | Operation slated for removal                                | CLI (`[DEPRECATED]` prefix in listings/help), MCP (`deprecated: true` on tool/resource/prompt descriptors), GraphQL (`@deprecated` SDL directive, unless `meta.graphql.deprecated` overrides), HTTP/OpenAPI (`OpenApiOperation.deprecated`, unless `meta.openapi.deprecated` overrides) | Not deprecated                                                                                              |

Verb derivation precedence in HTTP (`verbFromTags`, `packages/http-api-projector/src/tags.ts`):

1. `meta.http.verb` (see below) — always wins.
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

`meta.http` is a FLAT bag of scalar/map/array keys — no directive envelope,
no `kind`-tagged array, no fold-by-`kind` read-time resolution step
(`packages/http-api-projector/src/project.ts`, `verbs.ts`). Cardinality is
expressed by shape (docs/design/wire-profiles-and-staged-validation.md's
"Prerequisite: meta unification (directive dissolution)"):

- **At-most-one** → flat scalar key, last-wins (later `op()` contribution's
  value overwrites an earlier one — `mergeMeta`'s ordinary scalar-override
  rule, api-tree's node.ts).
- **Keyed partial contribution** → flat map key, key-merged (later
  contribution's keys win on overlap, whole-value replacement per key — see
  node.ts's `mergeRecords`/`MergeMetaValue` doc comments for the depth-capped
  merge this relies on).
- **Genuinely multiple/ordered** → plain array key, append (`MergeMetaValue`'s
  array-concatenation branch).

The RESOLVED shape (what a pre-migration `getHttpMeta` used to compute by
folding a directive array at read time) IS the AUTHORED shape now — the two
collapsed into one. `getHttpMeta` (project.ts) still exists as a stable,
typed read-site accessor, but is a thin pass-through: `meta.http` already
carries every field below by the time any contribution reaches it, since
`op()`'s own `mergeMeta` fold does all the resolving at compose time.

| Key                 | Shape                                                                | Cardinality                | Controls                                                                                                          | Read by                                                                                 | Absent                                                         |
| ------------------- | -------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `verb`              | `string`                                                             | at-most-one                | Explicit HTTP method override; wins over tag-derived verb                                                         | `verbFromTags` (`tags.ts`)                                                              | Verb falls through to tag-lattice derivation                   |
| `method`            | `string`                                                             | at-most-one                | Sets the HTTP method on a route's method entry in the `HttpRoute` tree                                            | `applyMethods` rewriter (`route.ts`)                                                    | Route keeps the `naiveTransform` baseline (`POST`)             |
| `moveTo`            | `string`                                                             | at-most-one                | Relative node placement in the output route tree (`..`, `../foo`, `*` path algebra)                               | `applyMoveTo` rewriter (`route.ts`)                                                     | Node stays at its tree-derived path                            |
| `response`          | `{ status?: number; headers?: Record<string,string> }`               | at-most-one                | Response status/header overrides, materialized into the handler                                                   | `applyResponse` rewriter (`route.ts`)                                                   | Default response shaping (200, no extra headers)               |
| `paginated`         | `{ style?, inputCursorParam?, inputOffsetParam?, inputLimitParam? }` | at-most-one                | Pagination hints overriding the client's shape-derived defaults — see `paginated()` (verbs.ts)                    | `extensions/pagination.ts`'s client extension                                           | Style/field names derived from response shape                  |
| `validate`          | a Standard Schema                                                    | at-most-one                | Validator run against the assembled input, after decode and before the handler — see `http.validate()` (verbs.ts) | `runRoute` (route.ts), via `runStandardSchema` (decode.ts)                              | No validation step                                             |
| `sourceMap`         | `SourceMap` (`Record<string, ParamSource>`)                          | keyed partial contribution | Per-param HTTP store overrides — see `http.source()` (verbs.ts)                                                   | `assemble` (api-tree's input.ts), via `naiveTransform`'s `sources.sourceMap` (route.ts) | Params resolve via the method-derived primary-store convention |
| `middleware`        | `readonly ((inner: Fetch) => Fetch)[]`                               | genuinely multiple/ordered | Subtree-scoped, dispatch-around request wrapping — see `http.middleware(...)` (verbs.ts)                          | `collectRoutes` (compile.ts), ancestor-composed root-to-leaf                            | No wrapping                                                    |
| `handlerMiddleware` | `readonly HttpHandlerMiddleware[]`                                   | genuinely multiple/ordered | Subtree-scoped, handler-around request wrapping — see `http.handlerMiddleware(...)` (verbs.ts)                    | `collectRoutes` (compile.ts), ancestor-composed root-to-leaf                            | No wrapping                                                    |

Retired along with the directive envelope itself: the `HttpDirective` DU, the
fold-by-`kind` `getHttpMeta` read-time switch, and the already-`[DEBT]`/
already-"currently unread" holdovers this dissolution deletes outright rather
than re-homing — `segment`, `when`, `legacyPath`, and the `dispatch` marker
(`{ kind: "method" | "header" | "query" | "contentType" }`) all predate the
`HttpRoute` pipeline (naiveTransform → rewriters → makeRouterFromRoute) and
were parsed by the pre-migration `getHttpMeta` but consumed by nothing —
verified read nowhere in the tree before deletion. Attribute dispatch
(header/query/contentType-based routing at the same path+method) still has no
equivalent in the current pipeline — an open design question, see TODO.md.

## OpenAPI — `meta.openapi`

Read by `packages/http-api-projector/src/openapi.ts`, on top of the HTTP
route tree `meta.http`'s flat keys already produced.

| Key               | Shape                                   | Controls                                                                                                                 | Scope                          | Absent                                             |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------- |
| `operationId`     | `string`                                | `OpenApiOperation.operationId`                                                                                           | Method-entry node              | Derived from codegen name or path                  |
| `summary`         | `string`                                | `OpenApiOperation.summary`                                                                                               | Method-entry node              | Omitted                                            |
| `description`     | `string`                                | `OpenApiOperation.description`                                                                                           | Method-entry node              | Omitted                                            |
| `tags`            | `string[]`                              | `OpenApiOperation.tags`                                                                                                  | Method-entry node              | Omitted                                            |
| `deprecated`      | `boolean`                               | `OpenApiOperation.deprecated` — **wins over** `meta.tags.deprecated` when explicitly set (back-compat override)          | Method-entry node              | Falls back to `meta.tags.deprecated`               |
| `security`        | `OpenApiSecurityRequirement[]`          | Per-operation security requirement; on the **root** node instead, becomes the spec-level default (`OpenApiDoc.security`) | Any node (root = spec default) | No security requirement emitted                    |
| `securitySchemes` | `Record<string, OpenApiSecurityScheme>` | Merged into `components.securitySchemes` from every node in the tree (last-write-wins per scheme name)                   | Any node                       | `components` omitted entirely if no node sets this |

## CLI — `meta.cli`

Read by `packages/cli-api-projector/src/cli.ts` via `getCliMeta`. Same flat
bag, same shape-directed fold semantics as HTTP's `meta.http` (see HTTP's
section above) — cardinality is by shape, not by an envelope tag, for every
key below.

| Key         | Shape                                      | Cardinality                | Controls                                                                                                                                                        | Absent                                                      |
| ----------- | ------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `name`      | `string`                                   | at-most-one                | Subcommand display name in listings/help                                                                                                                        | Falls back to the tree key                                  |
| `alias`     | `string`                                   | at-most-one                | Alternate leaf-lookup name (in addition to the tree key)                                                                                                        | No alias                                                    |
| `hidden`    | `boolean`                                  | at-most-one                | Excludes the leaf/branch from listings and help                                                                                                                 | Shown                                                       |
| `paginated` | `{ inputCursorParam?; inputOffsetParam? }` | at-most-one                | Overrides which flag name `--all-pages` merges the next cursor/offset into                                                                                      | Derived from the leaf's own cursor/offset input field names |
| `sourceMap` | `SourceMap`                                | keyed partial contribution | Per-param source override for input assembly (e.g. pull a field from `env` instead of a flag) — see `cli.source()` (`packages/cli-api-projector/src/source.ts`) | Params resolve via the default flag/slug convention         |

Also reads the shared `meta.description` (top-level Meta key, not
`meta.cli`-scoped) as a fallback when `meta.cli.description` isn't set — used
for command help text. `meta.tags.deprecated`/`destructive`/`readOnly`/`streaming`
drive help annotations and the destructive-confirmation gate (see tags table
above).

Resolution lifecycle: `meta.cli.sourceMap` is resolved once, into a
`Resolved.sourceMap` snapshot, at the point `resolveLeaf` finds the dispatched
leaf — the CLI-shaped equivalent of MCP/GraphQL/JSON-RPC's `Dispatch.sourceMap`
(each built once per leaf, at projection time) and HTTP's `meta.http.sourceMap`
(resolved once when the `HttpRoute` tree is built). CLI has no separate
build-once/dispatch-many projection phase the other four have — a leaf's
terminal argv segment can be a `fallback`-captured slug value only knowable
from that invocation's own argv — so the snapshot is taken at leaf-resolution
time within `runCli`, not ahead of it, but it IS taken exactly once per
dispatch rather than re-derived at each later point that reads it (see
`Resolved`'s doc comment, cli.ts).

## MCP — `meta.mcp`

Read by `packages/mcp-api-projector/src/project.ts` via `getMcpMeta`. One
leaf may target the tool, resource, or prompt surface via `as`. Same flat
bag, same shape-directed fold semantics as HTTP's `meta.http` (see HTTP's
section above).

| Key           | Shape                              | Cardinality                                                                                 | Controls                                                                                                       | Applies to                                                                 | Absent                                                                        |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `as`          | `"tool" \| "resource" \| "prompt"` | at-most-one                                                                                 | Which MCP surface the leaf projects to                                                                         | Leaf                                                                       | `"tool"` (default)                                                            |
| `name`        | `string`                           | at-most-one                                                                                 | Full name/URI override (prefix suppressed when set)                                                            | Tool, resource                                                             | Underscore-joined tree-position prefix + leaf key                             |
| `description` | `string`                           | at-most-one                                                                                 | Description text override                                                                                      | Tool, resource, prompt                                                     | Falls back to `meta.description`, then JSDoc-derived (codegen), then leaf key |
| `title`       | `string`                           | at-most-one                                                                                 | Emits `annotations.title`                                                                                      | Tool                                                                       | Omitted                                                                       |
| `segment`     | `string`                           | at-most-one                                                                                 | This branch node's contribution to the name/URI prefix                                                         | Branch                                                                     | Tree key used                                                                 |
| `annotations` | `McpAnnotations`                   | at-most-one (merged with tag-derived hints at read time, not folded as a meta contribution) | Merged over tag-derived hints (override wins per key)                                                          | Tool                                                                       | Tag-derived hints only (`hintsFromTags`)                                      |
| `uri`         | `string`                           | at-most-one                                                                                 | Full resource URI override                                                                                     | Resource                                                                   | Derived from tree position                                                    |
| `mimeType`    | `string`                           | at-most-one                                                                                 | Resource MIME type                                                                                             | Resource                                                                   | `"application/json"`                                                          |
| `sourceMap`   | `SourceMap`                        | keyed partial contribution                                                                  | Per-param source override for input assembly — see `mcp.source()` (`packages/mcp-api-projector/src/source.ts`) | Tool, resource template, prompt (not fixed resources — they take no input) | Params resolve via the default argument/URI-variable convention               |

`meta.tags.deprecated` surfaces as `deprecated: true` on the tool/resource/prompt
descriptor (omitted, not `false`, when unset — three-valued semantics).

## GraphQL — `meta.graphql`

Read by `packages/graphql-api-projector/src/project.ts` via `getGraphQLMeta`.
Same flat bag, same shape-directed fold semantics as HTTP's `meta.http` (see
HTTP's section above).

| Key                | Shape                                     | Cardinality                | Controls                                                                                                                                              | Absent                                                         |
| ------------------ | ----------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `operation`        | `"query" \| "mutation" \| "subscription"` | at-most-one                | Overrides tag-derived operation-type inference outright                                                                                               | Derived from tags (see precedence above)                       |
| `name`             | `string`                                  | at-most-one                | Full field-name override (prefix/camelCase-join ignored when set)                                                                                     | Underscore/camelCase-joined tree-position name                 |
| `namespace`        | `string`                                  | at-most-one                | This branch's contribution to the namespace path (Query only) — **declared, currently UNWIRED** (see `GraphQLBranchMetaProperties`'s doc, project.ts) | Tree key used                                                  |
| `description`      | `string`                                  | at-most-one                | Emitted as an SDL `"""..."""` block                                                                                                                   | Falls back to `meta.description`, then JSDoc-derived           |
| `deprecated`       | `boolean`                                 | at-most-one                | Overrides `meta.tags.deprecated`-derived deprecation                                                                                                  | Derived from `meta.tags.deprecated`                            |
| `deprecatedReason` | `string`                                  | at-most-one                | `@deprecated(reason: ...)` text — only meaningful when `deprecated` resolves `true`                                                                   | Bare `@deprecated` with no reason                              |
| `sourceMap`        | `SourceMap`                               | keyed partial contribution | Per-arg source override for input assembly — see `graphql.source()` (`packages/graphql-api-projector/src/source.ts`)                                  | Args resolve directly from the resolver's flattened `args` bag |

## JSON-RPC — `meta.jsonrpc`

Read by `packages/json-rpc-api-projector/src/project.ts` via `getJsonRpcMeta`.
Same flat bag, same shape-directed fold semantics as HTTP's `meta.http` (see
HTTP's section above).

| Key               | Shape        | Cardinality                | Controls                                                                                                                | Absent                                                            |
| ----------------- | ------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `name`            | `string`     | at-most-one                | Full method-name override (dot-prefix ignored when set)                                                                 | Dot-joined tree-position prefix + leaf key                        |
| `description`     | `string`     | at-most-one                | Description text override                                                                                               | Falls back to JSDoc-derived text, then leaf key                   |
| `errorDataSchema` | `JsonSchema` | at-most-one                | Narrows the JSON-RPC error envelope's `data` field (`jsonRpcErrorSchema`)                                               | Unnarrowed error envelope                                         |
| `segment`         | `string`     | at-most-one                | This branch node's contribution to the dot-joined method-name prefix                                                    | Tree key used                                                     |
| `sourceMap`       | `SourceMap`  | keyed partial contribution | Per-param source override for input assembly — see `jsonrpc.source()` (`packages/json-rpc-api-projector/src/source.ts`) | Params resolve from the single `"params"` store by their own name |

## Cross-cutting: `meta.description`

A top-level `Meta` key (not namespaced to any one projector), used as a
shared fallback description source. Read directly by CLI and GraphQL, and
by MCP (`child.meta.description`) — each ranked below their own
`meta.<projector>.description` override and above JSDoc/codegen-derived text
or the bare leaf key. HTTP/OpenAPI does not read it directly; OpenAPI uses
`meta.openapi.description` or codegen-derived text instead.
