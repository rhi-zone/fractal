# Decisions

Running log of settled design decisions with context and rationale. Newest first.
Each entry: what was decided, why, and what evidence or prior work grounds it.

---

## `inputLimitParam` removed — cursor/offset's customizable name doesn't generalize to limit (2026-08-21)

**Context:** `paginated()`'s `inputCursorParam`/`inputOffsetParam`/`inputLimitParam`
options (`project.ts`'s `HttpLeafMetaProperties.paginated`) were added without any
written rationale — traced to one copy-pasted example in an original task prompt,
never explained in a commit message, doc, or design discussion. `inputCursorParam`
and `inputOffsetParam` were wired into both `extensions/pagination.ts` (client,
`nextRequestFor`) and `route.ts` (server, `pageLinkHeader`); `inputLimitParam` was
declared and documented in `directive-contract.md` but never wired up on either
side.

**Decision:** `inputCursorParam`/`inputOffsetParam` are customizable because of a
specific mechanical need: pagination state (`cursor`, or `offset`+`items.length`)
comes back on the *response*, and the framework has to read that value and write
it into the *next-page* request under some param name — `nextRequestFor`
(`extensions/pagination.ts`) and `pageLinkHeader` (`route.ts`) both do exactly
this `url.searchParams.set(paramName, valueReadFromResponse)`. The param name is
a free variable at that write site, so it needs a way to be told what name to use.

`limit` has no equivalent write site. A next-page request is built by cloning the
*original* request's URL (`new URL(original.url)` in `nextRequestFor`,
`new URL(req.url)` in `pageLinkHeader`) and only overwriting the cursor/offset
param on top — every other query param the caller sent, including whatever name
they used for limit, survives into every later page automatically, because the
framework never touches it. There is no response-side limit field to read (a page
response carries `items`/`cursor`/`hasMore` or `items`/`offset`/`total`/`hasMore`,
never an echoed limit), and no rewrite step for a name-override to attach to. So
this isn't a case of picking not to expose the same customization for a third
field — the mechanism cursor/offset's customization depends on (read off
response, rewrite into next-page URL) structurally doesn't apply to limit, which
is never touched by the framework in the first place.

`inputLimitParam` is removed: `project.ts`/`route.ts`'s `paginated` meta type,
`directive-contract.md`'s pagination row, and `verbs.ts`'s `paginated()` doc
comment all drop the field.

**Evidence:** `extensions/pagination.ts`'s `nextRequestFor` and `route.ts`'s
`pageLinkHeader` — both read `page.cursor`/`page.offset` from the decoded
response and `url.searchParams.set` it under the configurable name, then clone
the rest of the original URL unchanged. Neither function reads or writes a limit
param anywhere.

---

## `kind` is the canonical DU discriminant field name (2026-07-09)

**Context:** The codebase had inconsistent discriminant naming — `DispatchMarker` used
`by`, other DUs used `type` or ad-hoc names. Needed a single convention.

**Decision:** All tagged-union discriminant fields are named `kind`. Applied concretely
when `Result<T,E>` moved from `{ok: boolean}` to `{kind: "ok"|"err"}` (commit `f7dd940`,
2026-07-16). `DispatchMarker.by` was renamed to `kind` in commit `8e8329c`.

**Evidence:** Recorded in `docs/design/invariants.md` line 219.

---

## Projection is a type-crossing map, not an endofunctor (2026-07-16)

**Context:** Prior framing described projection as a tree transform (`Node => Node`).
This was a framing bug — projection crosses a type boundary.

**Decision:** Projection is `Node => ProtocolType` (e.g. `Node => HttpRoute`). Convention
transforms are `Node => Node` endofunctors applied before projection. Rewriters are
`ProtocolType => ProtocolType` endofunctors applied after projection. The three layers are
independent.

**Evidence:** Corrected across `docs/design/invariants.md` and
`docs/design/routing-and-transforms.md` (commit `21443d7`).

---

## One API tree drives multiple protocols via independent projections (2026-07-16)

**Context:** Open question whether one agnostic tree could auto-derive both HTTP and CLI,
given their input models have no 1:1 mapping.

**Decision:** One API tree drives all protocols. The seam is the projection function per
protocol (`Node => HttpRoute`, `Node => CliCommand`, etc.), not the tree. Each protocol
gets its own convention transforms and rewriters. The API tree is organized by domain, not
by protocol.

**Evidence:** Settled in `docs/design/routing-and-transforms.md`. TODO.md open question #9
struck through.

---

## `place` directive renamed to `moveTo`, self-based path resolution (2026-07-16)

**Context:** The `place` directive used parent-based resolution (empty string `""` meant
"stay at parent"). User challenged this as the wrong resolution root.

**Decision:** Renamed to `moveTo`. Resolution root changed from parent-based to
self-based — `moveTo: "."` means stay at current position, `moveTo: ".."` means go up to
parent. Standard filesystem-style relative path semantics.

**Evidence:** Commit `6796def`. Documented in `docs/design/routing-and-transforms.md`.

---

## Attribute dispatch is not a routing-tree concern (2026-07-17)

**Context:** The old direct tree-walk dispatcher supported dispatching at the same
path+method by header, query, or contentType. The new `HttpRoute` pipeline has no
equivalent.

**Prior work:** The 2026-07-09 session identified a source×strategy split (exact hash vs.
ordered floor-lookup with pluggable comparator) as the generalization of this problem.

**Decision:** Parked. Header/query/contentType dispatch is rare in practice, requirements
are unpredictable, and it doesn't belong on the routing tree. The stores-based decode
already supports reading arbitrary headers/query params as handler input, so
version-conditional logic is a helper function in user code. OpenAPI has no native
mechanism for same-path/method header-differentiated schemas. If a real consumer need
surfaces, revisit.

**Evidence:** OpenAPI spec limitation (no header-conditional schemas); no major framework
ships this as a routing primitive (Hono, Elysia, Express, Fastify all handle it via
middleware/handler logic, not routing).

---

## Input-transform escape hatch: already built (2026-07-17)

**Context:** `TODO.md` said "not yet on the pipeline type," but `Pipeline.sources.transform`
already existed in `route.ts` and was wired into `defaultDecode`.

**Decision:** Confirmed as resolved. Landed as part of commit `cc10c04` (stores-based input
extraction). No further work needed; `TODO.md` entry was stale.

**Evidence:** `Pipeline.sources.transform` present in `route.ts`, referenced from
`defaultDecode`.

---

## Router auto-selection is a non-issue (2026-07-17)

**Context:** Benchmark data showed the hybrid Map+compiled-char strategy wins broadly, but
crossover heuristics weren't tuned into `createFetch`'s automatic strategy selection.

**Decision:** Not needed. The static/dynamic split already covers the performance space.
`createFetch` defaults to the zero-cost `makeRouterFromRoute`; compiled strategies are
opt-in. No heuristic-driven auto-selection is required.

**Evidence:** Routing benchmark results (see `routing-benchmarks.md`).

**Update (2026-07-30):** The "opt-in" half of this decision changed — `createFetch` now
defaults to `mapCharRouter` (the hybrid), not `makeRouterFromRoute`. The "no
heuristic-driven auto-selection" call still stands: the static/dynamic split inside
`mapCharRouter` itself is the resolution, not a runtime choice between whole-router
strategies. See `createFetch`'s `PresetOptions.router` default (`preset.ts`) and `bench-results/route-bench-2026-07-17T07-29-08-288Z.json`
(build cost: 1.9ms for the hybrid vs 13.3ms for full `compiledCharRouter`, alongside
near-best dispatch times) for why the hybrid was promoted to default.

---

## Verb/method override surface: fully built (2026-07-17)

**Context:** `TODO.md` listed verb/method convention override as an open design question.

**Decision:** Verified complete. All standard HTTP methods have DX helpers
(`http.get`/`post`/`put`/`patch`/`delete`/`head`/`options` via `verbs.ts`), the
`{ kind: "verb" }` directive overrides tag-based derivation, and `HttpMethods` supports
declaration merging for custom verbs. Only remaining gap: no exported convenience helper
for one-off custom verbs — users construct directives manually or extend `HttpMethods`.
Not blocking; can be added on demand.

**Evidence:** `verbs.ts` DX helpers; `{ kind: "verb" }` directive in the dispatch DU;
`HttpMethods` interface supports augmentation.

---

## Codegen CLI design (2026-07-17, commit `fa681b2`)

**Context:** Needed a CLI surface for the codegen tool covering build, watch, and
verification workflows across both committed-output and gitignored-output setups.

**Decision:**

- Subcommands: `build` (mtime skip, `--force`), `watch` (`fs.watch` + 150ms debounce),
  `check` (verify output is current, exit 1 if stale). (2026-08: the `stub` subcommand —
  an empty-map placeholder — was removed; `wrapValidators` is now loud, so an empty map
  means throw-for-every-leaf. The pre-codegen workflow is to omit the `validators` option
  entirely, not wire a placeholder — see docs/guide/codegen-cli.md.)
- `@generated` header on all output (GitHub collapses it in diffs; tools can skip it).
- No auto-formatting: emit readable code, let the user's own tooling handle formatting if
  they commit the output.
- Git strategy is the user's choice — `--check` mode makes both committed and gitignored
  workflows work.
- Cross-runtime: `node:fs`/`node:path` instead of `Bun.write`.
- Watch suppresses no-op writes (content hash comparison) to avoid triggering downstream
  watchers.

**Evidence:** Implemented in commit `fa681b2`.

---

## Package naming convention (2026-07-17)

**Context:** Package names didn't communicate the architectural relationships.
`core` was opaque — it's specifically the API tree model, not generic "core
utilities." The protocol packages (`http`, `mcp`, `cli`, `openapi`, `client`)
didn't indicate they're all the same kind of thing: projectors of the API tree
into protocol surfaces.

**Decision:** Rename packages to reflect what they are:

- `core` → `api-tree` — the tree model (`Node`, `Op`, `Meta`, `mergeMeta`,
  `Result`, combinators)
- Protocol projectors get a `-api-projector` suffix: `http-api-projector`,
  `mcp-api-projector`, `cli-api-projector`, `openapi-api-projector`,
  `client-api-projector`
- `type-ir` and `codegen` stay as-is — they're build-time type tooling, not
  API tree projectors

The qualifier `api-` distinguishes these from type projectors (`type-ir`
projects `TypeRef` into format targets, not the API tree into protocols).

**Evidence:** `api-tree` matches `api()` as the primary tree constructor.
The `-api-projector` suffix makes the package family visible and communicates
the input (API tree) and the role (projector).

---

## Merge openapi-api-projector into http-api-projector (2026-07-18)

**Context:** `openapi-api-projector` was a separate package from
`http-api-projector`, even though OpenAPI only ever describes HTTP APIs — it
has no meaning apart from an HTTP surface (paths, verbs, request/response
bodies over HTTP). Keeping it separate meant `toOpenApi` re-derived its own
copy of path/verb logic (later consolidated onto walking `http-api-projector`'s
own `HttpRoute` tree instead of the raw `Node` tree — see `openapi.ts`'s module
doc), required a cross-package dependency and manual wiring in every consuming
app, and gave `createFetch` no way to auto-serve the spec it was already
positioned to generate: `createFetch` builds the exact `HttpRoute` tree the
OpenAPI projection walks, so serving `/openapi.json` from inside the preset is
free — the alternative is every app hand-wiring a route that calls `toOpenApi`
itself.

**Decision:** Merge `packages/openapi-api-projector` into
`packages/http-api-projector` as `src/openapi.ts`, re-exported from the
package root (`toOpenApi`, `toOpenApiFromRoute`, and the `OpenApi*` types) and
from a `./openapi` subpath. `createFetch` (`preset.ts`) gained an `openapi`
option — `true` by default — that auto-mounts a `GET /openapi.json` handler
serving a lazily-built, cached document derived from the same route tree the
router dispatches against. Pass `{ path, title, version, schemas, sourceFile }`
to configure it, or `false` to disable.

**Evidence:** `openapi-api-projector`'s former cross-package imports
(`@rhi-zone/fractal-http-api-projector/dx`, `/route`) became relative imports
now that the code lives in the same package. All references across the
monorepo (root `package.json` workspaces, README, docs, examples,
`TODO.md`) were updated; `packages/openapi-api-projector` was deleted.
`bun run typecheck` and `bun test` pass across the whole workspace after the
merge.

---

## Merge client-api-projector into http-api-projector (2026-07-18)

**Context:** `client-api-projector` was a separate package from
`http-api-projector`, even though the runtime client only ever builds HTTP
requests — it has no meaning apart from an HTTP surface (it derives each
leaf's method and path from `HttpRoute` and fires a `fetch` call against
them). Same reasoning as the OpenAPI merge earlier the same day: keeping it
separate meant a cross-package dependency and manual wiring in every
consuming app, for a projection that is definitionally HTTP-shaped.
`createClient`/`createClientFromRoute` already walked `http-api-projector`'s
own `HttpRoute` tree (a prior consolidation, see `client.ts`'s module doc),
so the only thing separating the packages was the workspace boundary itself.

**Decision:** Merge `packages/client-api-projector` into
`packages/http-api-projector` as `src/client.ts` (+ `src/client-error.ts`,
`src/client.test.ts`), re-exported from the package root (`createClient`,
`createClientFromRoute`, `ClientError`, and the `ClientOptions`/`AnyClient`
types) and from a `./client` subpath, matching the `./openapi` pattern.

**Evidence:** `client-api-projector`'s former cross-package imports
(`@rhi-zone/fractal-http-api-projector/dx`, `/route`) became relative imports
now that the code lives in the same package; its test's package-name import
of the library-api fixture became the same relative path
(`../../../examples/library-api/src/tree.ts`) `openapi.test.ts` already uses.
The client's in-process round-trip tests (using `createFetch` from this same
package for the injected `fetch`) still pass — they now exercise a
same-package round trip instead of a cross-package one. All references
across the monorepo (root `package.json` workspaces, README, docs, the
`api-tree`/`examples/library-api` cross-reference comments, and the `spike/`
tsconfig path maps) were updated; `packages/client-api-projector` was
deleted. `bun run typecheck` and `bun test` pass across the whole workspace
after the merge.

---

## Umbrella package `@rhi-zone/fractal` (2026-08-07)

**Context:** The five protocol projectors stay five packages for a reason —
each walks the tree for one protocol's own purpose (`docs/design/tree-lint-spec.md`),
and each carries that protocol's own runtime dependencies. The two merges above
(`openapi-api-projector`, `client-api-projector` into `http-api-projector`) were
the opposite call for the opposite reason: neither has meaning apart from HTTP.
Nothing about that split is being revisited here.

What the split left unsolved is discovery and install ergonomics for a consumer
who wants more than one protocol: there was no name to reach for except five
individual ones, each of which has to be known in advance.

**Decision:** Add `packages/fractal` (`@rhi-zone/fractal`) as a pure re-export
facade — no runtime code of its own, one module per entry, each a single
`export * from` line. The package root is the function core (`api-tree`), since
no projection subpath is usable without `api`/`op`; the five protocols are
subpaths (`/http`, `/cli`, `/json-rpc`, `/graphql`, `/mcp`). Deeper subpaths of
the fronted packages are deliberately NOT mirrored — mirroring
`http-api-projector`'s 23 subpaths would make the umbrella a second copy of
another package's module layout, which is the maintenance cost the facade
exists to avoid. Reach for the projector package directly for those.

Dependency policy, which is the whole design question:

- Hard `dependencies`: `api-tree`, `http-api-projector`, `cli-api-projector`,
  `json-rpc-api-projector` — the core plus every projector that carries NO
  third-party runtime dependency of its own.
- Optional `peerDependencies` (`peerDependenciesMeta.optional`):
  `graphql-api-projector`, `mcp-api-projector` — the two that do
  (`graphql`, `@modelcontextprotocol/sdk` respectively). Asking for those
  protocols costs one extra explicit install, and a subpath import without it
  fails at module resolution naming the missing package. Neither protocol's
  runtime is loaded by a consumer that does not import its subpath; on the
  install side, see the measured caveat below — the MCP SDK genuinely stays out
  of `node_modules`, graphql-js currently does not.

This is the same mechanism `type-ir` already uses to keep `protobufjs` and
`typescript` off consumers who don't touch those subpaths, applied one level up.

The rejected alternatives: all five as hard dependencies (simplest, but every
consumer installs the MCP SDK to get an HTTP router — precisely the bloat the
package split exists to prevent), and all five as optional peers (zero install
cost, but the consumer still runs five `bun add`s and must still know all five
names, so the friction the umbrella exists to remove survives intact).

The split criterion is deliberately "does this projector carry a
protocol-specific third-party runtime dependency", not a measurement of today's
install graph. Measured at this commit, the marginal install `@rhi-zone/fractal`
avoids is mostly `@modelcontextprotocol/sdk`: `graphql` and `flow-parser` are
hard dependencies of `type-ir`, which every projector depends on transitively,
so graphql-js lands in a consumer's `node_modules` regardless of this policy.
That is a `type-ir` dependency question (only its `from-graphql`/`graphql`
subpaths import graphql-js) and is out of scope here; the criterion above stays
correct if and when `type-ir` tightens it, which a footprint-of-the-day
criterion would not.

**Evidence:** `packages/fractal/src/module-graph.test.ts` verifies the
load-bearing property rather than asserting it: it walks the static import
graph out of each facade module — resolving workspace specifiers through the
fronted package's own `exports` map and parsing with `Bun.Transpiler.scanImports`,
which runs the real TS transpiler and so drops erased `import type` edges a
regex could not distinguish — and asserts that the `.`/`/http`/`/cli`/`/json-rpc`
closures contain neither `graphql` nor `@modelcontextprotocol/sdk`. Two positive
controls (`/graphql` does reach graphql-js, `/mcp` does reach the MCP SDK) keep
those negatives from passing vacuously. Runtime probes import each subpath and
assert a known export is present, and a purity check fails if any facade module
ever grows a line that is not a re-export. `bun run typecheck` and `bun run test`
pass across the workspace.
