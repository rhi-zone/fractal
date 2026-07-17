# Decisions

Running log of settled design decisions with context and rationale. Newest first.
Each entry: what was decided, why, and what evidence or prior work grounds it.

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
  `stub` (empty-map placeholder), `check` (verify output is current, exit 1 if stale).
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
