# Decisions

Running log of settled design decisions with context and rationale. Newest first.
Each entry: what was decided, why, and what evidence or prior work grounds it.

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
