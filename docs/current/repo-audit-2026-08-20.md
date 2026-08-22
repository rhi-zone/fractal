# Repo audit — 2026-08-20

Read-only audit of the `@rhi-zone/fractal-*` monorepo, same lens as the sibling codebase
sweep: what's there, what's inconsistent, what's broken, what's dead. Findings
are ordered by severity within each section. Every finding is tagged
**[evidenced]** (file:line read this session, or command output) or
**[inferred]** (a read of the evidence, not the evidence itself). No fixes or
plans here — this names what is, only.

**Update, 2026-08-21**: the large majority of what this audit originally found
has since been fixed in code. This pass re-verified every remaining finding
against current source and deleted everything confirmed resolved — what's
left below is only what's still actually true. Section/item numbers are kept
stable (with gaps where resolved items were removed) since in-code comments
and cross-references elsewhere cite them by number.

Context folded in (established before this audit, not re-derived):

- `extractToolSchemas`/`extractToolTypeRefs` had an optional `treeId` nobody
  threaded → same-named leaves in different trees collided; made mandatory in
  `280ae55` (doc originally cited `b20ff00`, which is not a commit in this
  repo's history). The path-keyed sibling family (`extractRouteTypeRefs`/
  `extractRouteSchemas`, fixed in `423b8fa`) made treeId prefixing automatic
  and never recurred — the opt-in one did. That contrast (opt-in vs
  structural correctness) is used as a template in §4.
- `buildWireApplyValidationModuleCached`/`writeWireApplyValidationModuleCached`
  (`packages/api-tree/src/apply-validation-build.ts`) were exported and
  called by nothing at audit time. **Since fixed**: `cli.ts` now calls
  `buildWireApplyValidationModuleCached` directly. **Checked directly against
  the sibling codebase this pass**: it still separately hand-reimplements the
  sequence rather than calling the wrapper — see §8.1.
- `checkCache` gated on `ts.version` + `@rhi-zone/fractal-type-ir`'s version
  but not `fractal-api-tree`'s own. **Since fixed**: `cache.ts` now also
  gates on `apiTreeVersion` (`CacheFileShape.apiTreeVersion`, checked via
  `resolvePackageVersion("@rhi-zone/fractal-api-tree", entryFile)`), with a
  doc comment on the field citing this audit's §1.1 by name as the reason it
  was added. Both packages' versions are still pinned at a never-bumped
  `0.1.0-alpha.0`.

---

## 1. Live issues affecting the sibling codebase right now

### 1.1 The cache's only toolchain guard was inert in the sibling codebase — `typeIrVersion` used to always resolve `"unknown"` [**resolved**]

**[evidenced]** `resolvePackageVersion` (`packages/api-tree/src/cache.ts:183-205`)
now resolves via `createRequire(path.resolve(fromFile))` — `fromFile` is the
caller's own `entryFile`, not cache.ts's/`dist/cache.js`'s location — per
`60cdd08` ("fix(api-tree): close the cache's version/options blind spots").
Confirmed against the sibling codebase directly: `apps/web/node_modules/@rhi-zone/`
holds real symlinks into this repo's `packages/*` (`fractal-api-tree`,
`fractal-http-api-projector`, `fractal-type-ir`), and every call site that
matters (`codegen-fractal-validators.ts`, `codegen-fractal-merged-validators.ts`)
passes an `entryFile`/`ROOT_TREE_FILE` that lives under `apps/web/src/...` —
i.e. a sibling of `apps/web/node_modules`, so Node's upward `node_modules`
walk from that file reaches the real symlinks. `apiTreeVersion` was added in
the *same* commit (`60cdd08`) that fixed the resolution mechanism, calling
the identical `resolvePackageVersion(pkgName, entryFile)` — there is no
separate resolution path for it to inherit a stale bug from; both fields now
resolve the same way, from the same fixed mechanism. The only on-disk cache
file checked this pass (`apps/web/src/_generated/fractalMergedValidators.generated.ts.cache.json`,
mtime Aug 20 20:20) still shows `"typeIrVersion":"unknown"` and no
`apiTreeVersion` field at all — but that file predates `60cdd08` (22:45 the
same day) and is gitignored/untracked local build output, so it's stale
evidence of the pre-fix state, not a live counter-example; the next real
build regenerates it under the fixed mechanism. No sibling rebuild was run
this pass (read-only), so this is a code-level confirmation, not an observed
fresh cache file.

The tracked closure does incidentally include fractal's `dist/*.d.ts` (verified
by reading `fractalMergedValidators.generated.ts.cache.json` — 3,094 files,
including `packages/type-ir/dist/derive.d.ts`, `packages/api-tree/dist/tree.d.ts`),
so fractal's **type surface** is fingerprinted. Its **runtime codegen logic**
(the `.js` that actually emits the artifact) is not.

### 1.5 the sibling codebase CI checks fractal out at floating `master` [**"no build step" half is now wrong — a build step exists**]

**[evidenced]** `dist/` is still gitignored/untracked with no `prepare` script
(`packages/api-tree/package.json` unchanged: `files: ["dist"]`, `main`/`exports`
all point at `./dist/*`). the sibling codebase's `.github/workflows/ci.yml` still checks
fractal out at `ref: master` (floating, not pinned) as a sibling checkout
under `$GITHUB_WORKSPACE/rhizone/fractal`. But contrary to the audit-time
claim, there **is** a build step now: a `Build fractal packages` step runs
`bun run build:packages` (`tsc -b`) with `working-directory: rhizone/fractal`,
immediately after `bun install --frozen-lockfile` in that same directory and
before the sibling repo's own install — the step's own comment names exactly
the reason the audit flagged ("each fractal package's `main`/`exports` point
at `dist/*`, which is gitignored in fractal, so anything that imports
`@rhi-zone/fractal-*` ... needs `dist/` built first"). So the "floating ref"
half of this finding still holds; the "no dist build step" half is resolved
and should be treated as fixed, not merely unverified.

---

## 2. The cache design (`packages/api-tree/src/cache.ts`)

**Update**: everything originally filed in this section is fixed or removed.
`checkCache`/`toolchainMatches` now gate on `apiTreeVersion`,
`compilerOptionsHash` (a new `computeCompilerOptionsFingerprint`, sha256 of
`loadCompilerOptionsForFile`), and `buildOptionsKey` — closing the
version-gate hole (Tier 1 and Tier 2 both), the missing-tsconfig-tracking
hole, and the missing-build-options-in-cache-key hole, respectively (all
re-verified against current `cache.ts`). `writeCacheMetadata` now writes a
`process.stderr` warning when a path in `reachable` isn't present in the
Program's parsed source files, instead of silently dropping it from tracking.
`withCache` — the exported "shared orchestration" nothing actually used —
was deleted outright in `ae79532` rather than fixed in place; grep finds zero
occurrences repo-wide, including in comments.

---

## 3. Exported-but-unused surface & package inventory

Method: every identifier indexed across fractal (`packages/ examples/ spike/
scripts/ tooling/ docs/`) and the sibling codebase (`apps/ packages/ scripts/ examples/
tooling/ docs/`); each package's `package.json#exports` entry-file exports
checked for any consumer outside the defining file. 651 exports checked
(type-ir at subpath level). **[evidenced unless marked]**

### 3.1 Packages nothing imports at all

- **`auth-oidc`** — still zero importers; the one grep hit
  (`api-tree/src/auth.ts:2`) is still a comment. All 5 subpaths unimported.
- **`http-framework-projector`** — still zero importers anywhere; even its own
  `express.ts`/`fastify.ts` never import its `.` entry (they do import from
  `api-tree` and `http-api-projector`, just not from themselves).
- **`ffi-ir`** — count corrected: **26 files** in `src/` (13 impl + 13 test),
  not 49; ~7,700 lines, close to the doc's "~8.2k" estimate. Subpath count in
  `package.json` is **13** (re-verified this pass by reading `exports` keys
  directly — an earlier re-check of this doc had mistakenly said 41, which
  counted value strings, not export keys). "every `to*Ffi` projector referenced only
  by its own test" still holds — zero outside importers found.
- **`fractal`** (umbrella) — still 6 pure `export *` facade files
  (`cli.ts`, `json-rpc.ts`, `mcp.ts`, `graphql.ts`, `http.ts`, `index.ts`),
  still only exercised by its own `module-graph.test.ts`. Still not imported
  by fractal, examples, spike, or the sibling codebase. README sells the
  umbrella install, and `docs/guide/getting-started.md` now leads with the
  umbrella install too (both docs agree now — that split is fixed).
- **`api-explorer`** — reached only as a **string** emitted by codegen
  (`http-api-projector/src/http-route-reference.ts:259`, citation still
  correct) and by `examples/doc-site-verification/*` (out-of-workspace, `file:`
  deps, still confirmed). Size claim corrected: the actual component
  (`api-explorer.tsx`) is **183 lines**; 588 was the sum of the whole `src/`
  directory including tests.
- **`playground`** — private demo, consumed by nothing as a package import.
  "Not run in CI" is now **wrong**: `.github/workflows/ci.yml` builds it, and
  `deploy-docs.yml` copies its dist output into the docs site.

Consumed only inside fractal: `json-rpc-api-projector` (solely via the unused
`fractal` facade — so effectively zero real consumers), `graphql-api-projector`
(two api-tree test files + facade), `mcp-api-projector` (tests + example +
facade). `cli-api-projector`'s "exactly one the sibling codebase import" claim
is now **wrong**: it has several in-repo consumers —
`api-tree/otel.integration.test.ts`, `context.test.ts`, `extract.test.ts`
(dynamic import), a fixture-file type import, plus the `fractal/cli.ts`
facade. Load-bearing: `api-tree`, `http-api-projector`, `type-ir` — the sibling
codebase's per-subpath import counts (`/tree` ×76 etc.) were not re-verified
this pass, no sibling checkout available.

### 3.2 Dead exports — 89 symbols with no consumer anywhere [**citations updated, several no longer dead**]

- **api-tree: 45**, including in `index.ts` itself: `Fn` (:81, unchanged),
  `isErr` (now :135, not :111 — still zero uses anywhere, prose mentions
  only), `composeK` (now :316, not :292 — still own-test only); plus `isNode`
  (`node.ts`, now :380 — **not actually dead**: it's called internally from
  `node.ts:777` in addition to its test, so "dead export" overstates it —
  it's an unused-externally-but-used-internally export), `mapNodes`
  (`tags.ts:230`, unchanged — own test + internal recursive self-calls only),
  `schemaFromType` (`extract.ts`, now :180), `opFunctionNode` (`extract.ts`,
  now :628), the `TAG_*` constants (`tags.ts` — there are actually **7**, at
  :36/:43/:50/:62/:73/:84/:100, not 5; `TAG_IDEMPOTENT` and `TAG_UNVALIDATED`
  are referenced outside their own file — `TAG_UNVALIDATED` is used within
  api-tree itself, in `apply-validation.ts`, so not dead), `withCache`
  (**removed entirely** — the `cache.ts:630` citation is now a dead pointer
  to a deleted symbol, not a dead-but-present export),
  `computeBundleFingerprint` (`cache.ts`, now :672 — **not actually dead**:
  called internally from `writeCacheMetadata` at :601, no external caller
  though), `getActiveSpan` (`otel.ts`, now :216 — test-only, no non-test
  caller), `affectedEntries` (`reachability.ts`, now :245 — test-only),
  `writeSchemaModule` (`schema-build.ts`, now :106 — confirmed genuinely dead,
  zero references anywhere besides its own definition and a doc-comment
  mention) + `writeSchemaModuleCached` (now :283 — **not dead**: heavily used
  across `cache.test.ts`), both `*WireApplyValidationModuleCached` wrappers
  (no longer dead, `cli.ts` calls them now) + ~7 sibling option/result types.
- **http-api-projector: 23**, including the **entire `./webhook` module**
  (`computeWebhookSignature` :143, `webhookSignatureLayer` :162,
  `createInMemoryReplayStore` :242, `replayPreventionLayer` :282 — all
  confirmed still tests-only) and every non-Bun/Node platform adapter
  (`serveDeno` `adapter.ts:83`, `toCloudflareWorker` :96, `toVercelEdge` :109,
  `serveFastlyCompute` :118, `toAwsLambdaHandler` :169 — all still confirmed
  no callers); also `restCrud` (`dx.ts:125`), `toHttpRoutes` (`project.ts`,
  now :98).
- **ffi-ir: 18** (essentially every entry point), **auth-oidc: 2** more
  symbols, **mcp: 1** (`SamplingMessage`).

**[inferred]** Split between "intended public API awaiting external consumers"
(platform adapters, `./webhook`, ffi-ir, auth-oidc, the umbrella, api-explorer —
all have real tests and docs mentions) and "actually dead" (`isErr`,
`composeK`, `writeSchemaModule`, `spike/scale`). Several items originally
filed under "actually dead" (the `*Cached` wrapper family, `isNode`,
`computeBundleFingerprint`, `writeSchemaModuleCached`) turned out on
re-check to have live internal or in-repo callers, or to have since gained
one — "no external consumer" and "dead" are not the same claim, and this list
originally blurred them.

---

## 4. Opt-in vs automatic correctness (the treeId template)

Places where correctness depends on a caller remembering something, where the
`423b8fa`-style structural fix existed as an alternative (doc originally cited
`5de8117`, which is not a commit in this repo's history — see intro block).
**[evidenced mechanisms; the "recurrence-prone" framing is inferred.]**

1. **The byte-exact write contract** on the cached wrappers — `withCache`
   itself is gone (deleted, not fixed), but the two remaining `*Cached`
   wrappers (`buildWireApplyValidationModuleCached`, `buildSchemaModuleCached`)
   still require callers to write the exact bytes they computed as the cache
   key. A `header` option was later added that threads the header through
   the fingerprint rather than eliminating the byte-exactness requirement.
   **Checked against the sibling codebase directly: it's possible now but
   still unused.** Both scripts (`codegen-fractal-validators.ts`,
   `codegen-fractal-merged-validators.ts`) still hand-roll a
   `GENERATED_HEADER + built.source` prepend and call the lower-level
   `checkCache`/`readCarryForwardState`/`writeCacheMetadata` primitives
   directly, bypassing the `*Cached` wrappers entirely — not just missing the
   new `header` option, never went through the wrapper at all.
   `codegen-fractal-validators.ts`'s own in-repo comment (around its
   `rebuild` function) still gives the *pre-`header`-option* reason
   ("using the higher-level `buildSchemaModuleCached` wrapper directly here
   would hash the header-LESS `build()` return value instead, permanently
   mismatching the header-ful file this script writes and defeating the
   cache") — that comment is now stale relative to fractal's current
   `header` option, which exists specifically to close this gap
   (`schema-build.ts:220-227`, `apply-validation-build.ts:1044-1057`: "the
   reason a header-wanting consumer previously had to hand-roll its own
   write/hash orchestration around its own prepend step"). Fractal's own
   `cli.ts` has adopted it (`header: GENERATED_HEADER` passed to the cached
   wrapper); the sibling codebase has not.
2. **Per-artifact fingerprint completeness is hand-maintained** — the
   specific instance this pointed at (the schema Tier-2 fingerprint omitting
   `description`, so a description-only edit silently kept stale text) is
   fixed, but the structural point stands: nothing forces "everything that
   affects the emitted artifact is in the fingerprint" for the *next*
   artifact someone adds a field to.
3. **The toolchain gate depends on version bumps that never happen** — the
   gate itself grew (now also checks `apiTreeVersion` and
   `compilerOptionsHash`), but the conclusion is unchanged: correctness is
   still delegated to a release habit (bumping `0.1.0-alpha.0`) the repo
   doesn't have, so the gate remains inert in practice.

For contrast, the automatic mechanisms that never recur as bugs: path-keyed
treeId prefixing (`423b8fa`), `outputHash`, closure-from-Program.

---

## 5. Internal consistency

**[evidenced unless marked]**

6. **`meta-role-split-spec.md`'s status header — [investigated this pass;
   still a human call, not a bug].** The §9(4) regression the header points
   at is item 4 of the "Regression checklist" ("Projector-owned ambient
   augmentation") — and the spec's own Status header (lines 3-24) and §9(4)
   itself (lines 595-601) already name the concrete instance and flag it as
   an open question, not something this audit needed to discover fresh:
   `mcp-api-projector` and `json-rpc-api-projector` each carry a
   `declare module "@rhi-zone/fractal-api-tree/node"` block in
   `src/deployment-meta.test-support.ts`
   (`packages/mcp-api-projector/src/deployment-meta.test-support.ts`,
   `packages/json-rpc-api-projector/src/deployment-meta.test-support.ts`,
   both read this pass). Re-verified this pass: neither file is reachable
   from outside its own package — `deployment-meta.test-support.ts` is not
   listed in either package's `package.json#exports`, and grepping both
   packages' `src/` finds it imported only by their own `*.test.ts` files
   (`project.test.ts` in both, plus `client.test.ts` in json-rpc-api-projector)
   — so the exact hazard §9(4) rules out (an unrelated import silently
   flipping on ambient augmentation for a consumer who didn't ask for it)
   does not reach a real consumer through this path; it's scoped to each
   package's own test compilation. That's evidence toward "acceptable
   test-only exception," but the spec's Status header already says this
   verdict is **"flagged for a human call"** on the record (whether to also
   rework the file to not use `declare module` at all, to match the "exactly
   one augmentation file in the whole system" invariant literally) — a
   documentation fact-check doesn't settle a call the spec's author
   explicitly reserved. Left open pending that call.
10. **The wire-key/sourceMap union inlined four ways — still true, citation
    needs a full re-derive.** The pattern still exists at each site (cli.ts,
    json-rpc's `server.ts`, http's `route.ts`) but none of them literally
    write the doc's quoted expression — variable names differ per site
    (`flags`/`slugs`, `paramsObj`, `pathParamNames`/`searchParams`). mcp's
    named `paramNamesFor` and graphql's declared-arg-names approach are both
    still current. The dead-sourceMap-override lint is still http-only but
    has moved substantially (~:1519-1530, not :1585-1594) — this citation in
    particular needs someone to re-derive the exact current line ranges
    rather than trust the old ones.
14. **Small drift**: `preset.ts` (http) vs `presets.ts` (mcp, graphql) — still
    true. `source()` in `source.ts` for four projectors, `verbs.ts` for http —
    still true. (ffi-ir's six verbatim `toSnakeCase` copies of type-ir's
    `toSnakeCaseStripSeparators` are fixed — every ffi-ir target now imports
    it directly from `@rhi-zone/fractal-type-ir/codegen-helpers`.)
    `rescript-external.ts` still has a live replacement duplication: a
    `RESERVED` reserved-word set copied because `rescript-native.ts` doesn't
    export its set — not chased further this pass.

Explicitly checked and clean: the `source()` helper family, `escapeJoin`
adoption across graphql's three lookup-key call sites (`project.ts`,
`codegen.ts`, `client.ts` all now share `escapeJoin([...path, key], "_")`;
`underscoreJoin` is kept only "for source compatibility"), type-ir's registry
split, error-encoder composition, the per-package
`deployment-meta.test-support.ts` files (found in 2 of 5 projector packages
on a spot-check, not all five — "per-package" wording is generous but not
wrong).

---

## 7. Tests

**[evidenced unless marked]**

2. **No package is test-less; gaps are file-level — still true.** api-tree's
   `tree.ts` (1,042 lines), `tags.ts`, `schema-build.ts` still have no
   sibling test file. type-ir's `kotlin-jackson.ts` (464 loc) and
   `starlight-reference.ts` (427 loc) still get only the generic registry
   smoke loop (`registry.test.ts:87-97`) — no assertion the output is right.
   playground UI still untested.
4. **Where tests are strong — still true, unchanged.** Zero snapshot tests
   repo-wide; http/graphql codegen's 3-tier pattern
   (`http/codegen.test.ts:1-19`) still current; type-ir compile-checks 14 real
   toolchains, still 6 `describe.skip` blocks at :663-668 leaving
   java/kotlin/newtonsoft/dart/elm/elixir string-only in practice.
   `cross-projector.test.ts:188-198` still the weakest tier
   (`typeof result === "string" && length > 0`); mcp/cli `source.test.ts`
   still type-level only.

(The suite overall: `bun test` in `packages/api-tree` currently gives 436
pass / 0 fail across 23 files — up from the 17-tests-passing count at audit
time, consistent with the coverage additions noted above.)

---

## 8. The sibling codebase boundary

### 8.1 the sibling codebase hand-rolls that shadow existing fractal surface — and why [**re-checked directly against the sibling repo this pass**]

**[evidenced]** Checked live against the sibling codebase's checkout. Both scripts
still hand-roll the wrapper's job instead of calling
`buildWireApplyValidationModuleCached`/`buildSchemaModuleCached`:
`codegen-fractal-merged-validators.ts` builds `source = GENERATED_HEADER +
built.source` (:91, :121) then calls `writeCacheMetadata` directly (:126);
`codegen-fractal-validators.ts`'s `rebuild` function (:474-498) does the same
(`withHeader = GENERATED_HEADER + built.source` at :486, `writeCacheMetadata`
at :490) — both go through the lower-level `checkCache`/
`readCarryForwardState`/`writeCacheMetadata` primitives, never the `*Cached`
wrappers. Line numbers have drifted from the original citation (:100-125,
:485-505) but the shape is unchanged. The blocking reason is still written
down verbatim in `codegen-fractal-validators.ts` (its `rebuild` doc comment,
:462-469): using the wrapper directly "would hash the header-LESS `build()`
return value instead, permanently mismatching the header-ful file this script
writes and defeating the cache" — **this comment is now stale**: fractal's
`header` option (`schema-build.ts:220-227`, `apply-validation-build.ts:1044-1057`)
exists specifically to close this gap by folding the header into the hash
before the wrapper writes. The header string itself is still a private const
independently redefined in both sibling scripts
(`codegen-fractal-validators.ts:250`, `codegen-fractal-merged-validators.ts:78`,
both `"// @generated by @rhi-zone/fractal-api-tree — do not edit\n"`, matching
fractal's own `cli.ts:31`) rather than imported from anywhere. **Fractal's own
`cli.ts` has adopted the `header` option** (`header: GENERATED_HEADER` passed
to the cached wrapper, `cli.ts:289/421`); **the sibling codebase has not** —
the option exists and would mechanically resolve the documented blocker, but
is unused there. See §4.1 item 1.

Other hand-rolls of things fractal-shaped, re-checked directly:

- `findEntryFilesCached` + `directoryListingSignature`
  (`codegen-fractal-validators.ts:191-217`) and `findTreeTargetsCached`
  (:390-410) — still current, still mtime-signature caches bolted around
  entry/target discovery.
- `apps/web/src/server/lib/fractalMergedSchemas.ts` reimplements
  `buildNameMap`'s underscore-joined name computation — still true, but
  **the framing has changed**: its current header comment (:1-45) documents
  this as a considered, deliberate choice, not a stuck/blocked state.
  Switching the codegen pipeline to the path-keyed `extractRouteSchemas` is
  called out explicitly as "a real option but a bigger, separate change
  ... not needed for this migration to be correct" — the file is doing this
  on purpose for now, not blocked on fractal-side cache logic the way the
  original citation implied.

- `packages/fractal-support/src/serviceStores.ts` (in the sibling codebase)
  — `withServiceStoresOnInput` (now :34-42, close to the original :33-42) —
  still matches: generic store→input plumbing, sibling-codebase-free.
- `packages/fractal-support/src/errorEncoder.ts` (in the sibling codebase) —
  **citation drifted substantially**: the file is now only 233 lines total
  (the original cited :404-415 and :538, both past EOF). `formatValidationErrors`
  now lives at :60; the errors-export comment ("the sibling codebase's shape,
  counterpart to fractal's own `httpErrors`") is now at :163. The underlying
  claims still hold, just at much earlier line numbers — the file was
  significantly shortened since the original citation.
- `packages/fractal-support/src/scopes.ts` (in the sibling codebase) —
  same drift: file is now 252 lines total (original cited :1035-1060, past
  EOF). `wrapScopes` is now at :227, and its header comment (:3-22) still
  explicitly names `wrapValidators` (`@rhi-zone/fractal-api-tree/build`) as
  the shape it copies — the underlying claim holds, citation was stale.

`wrapScopes`'s tree walk was said to copy the recursive rebuild shape of the
since-deleted `wrapValidators`. **[evidenced, both halves now confirmed]**
`wrapValidators` really was deleted (commit `ffa08d4`, "migrate cli/mcp/graphql
to applyValidation, delete wrapValidators (phase 3)") — it survives only in
comments now. api-tree still exports no generic leaf-mapping primitive
(`walkTree`/`walkTreePositions` in `tree.ts`/`apply-validation.ts` are
internal, unexported), so the underlying claim — every consumer transform has
to re-implement the recursion — still holds on the fractal side, and the
sibling's `scopes.ts` comment (above) confirms it still holds on the sibling
side too.

### 8.2 What fractal assumes about its consumer

- **`dist/` exists** (§1.5) — confirmed still true on fractal's side
  (`packages/api-tree/package.json` has no `prepare` script, root `.gitignore`
  still excludes `dist/`), but the sibling codebase's CI now explicitly builds it
  (`rhi-zone/fractal` checkout gets its own `bun install --frozen-lockfile` +
  `bun run build:packages` step — see updated §1.5) — the assumption is
  still real, but the sibling side now satisfies it structurally in CI rather
  than leaving it to chance.
- **Version resolution works from fractal's own location** (§1.1) — was false
  under the sibling codebase's symlink layout; now fixed (`60cdd08`) to resolve
  from the caller's own entry file instead — confirmed directly against the
  sibling repo's symlink layout (`apps/web/node_modules/@rhi-zone/*` real
  symlinks into this repo, entry files under `apps/web/src/...`) — see
  updated §1.1.
- **Bun** — **fixed**: the write helpers now use `node:fs/promises` instead
  of `Bun.write`; the sibling codebase's own codegen scripts already used plain
  `node:fs` (`writeFileSync`/`mkdirSync`/`readFileSync`) for their own writes
  regardless, so this was never a live blocker there — confirmed, not just
  inferred.
- **tsconfig: nearest-to-entry-file wins** — citation drifted:
  `type-ir/src/from-typescript.ts:1547` (not :1517), and the call is
  `ts.findConfigFile(path.dirname(path.resolve(entryFile)), ts.sys.fileExists)`
  — the doc's quoted form dropped the `path.resolve()` wrap and the
  `ts.sys.fileExists` argument. Mechanism claim (nearest-to-entry-file tsconfig
  resolution, sibling's split-strictness consequence) not re-checked against
  sibling repo — no sibling tsconfig behavior was tested this pass either.
  **[evidenced mechanism; whether it changes any extracted type
  was not tested.]**
- **cwd** — confirmed still current: `discover.ts:52,77` still resolve
  relative roots against `process.cwd()` (actual `path.resolve()` calls at
  :175/:258/:269 in the same file). Sibling-side mitigation confirmed directly:
  `codegen-fractal-merged-validators.ts:68` computes `APP_ROOT` from
  `dirname(dirname(fileURLToPath(import.meta.url)))`, and the sibling
  codebase's root `package.json` runs every relevant script via
  `bun run --cwd apps/web ...` (codegen, dev, build, test, db scripts all use
  it). Low risk, as
  originally noted.
