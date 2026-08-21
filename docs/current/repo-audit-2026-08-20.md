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
  `buildWireApplyValidationModuleCached` directly. Whether the sibling
  codebase still separately hand-reimplements the sequence was not
  re-checked this pass — no sibling checkout was available.
- `checkCache` gated on `ts.version` + `@rhi-zone/fractal-type-ir`'s version
  but not `fractal-api-tree`'s own. **Since fixed**: `cache.ts` now also
  gates on `apiTreeVersion` (`CacheFileShape.apiTreeVersion`, checked via
  `resolvePackageVersion("@rhi-zone/fractal-api-tree", entryFile)`), with a
  doc comment on the field citing this audit's §1.1 by name as the reason it
  was added. Both packages' versions are still pinned at a never-bumped
  `0.1.0-alpha.0`.

---

## 1. Live issues affecting the sibling codebase right now

### 1.1 The cache's only toolchain guard is inert in the sibling codebase — `typeIrVersion` is always `"unknown"` [**partially stale — see update below**]

**[evidenced at audit time]** `resolvePackageVersion` (`packages/api-tree/src/cache.ts`)
does `require.resolve("@rhi-zone/fractal-type-ir")` from cache.js's own location
and returns `"unknown"` on failure — documented in-code as
"stable-but-not-invalidating". In the sibling codebase, the only `@rhi-zone` links live at
`apps/web/node_modules/@rhi-zone/` (symlinks into this repo); resolution from
fractal's own package location finds nothing. Result at audit time: **all 89 of
the sibling codebase's cache metadata files recorded `"typeIrVersion": "unknown"`**.

**Update**: the known hole this combined with — api-tree's own version wasn't
in the cache shape at all — is now closed: `checkCache`/`toolchainMatches`
gate on `apiTreeVersion` too, via the same `resolvePackageVersion` helper.
**[inferred, not re-verified — no sibling checkout available this pass]** since
`apiTreeVersion` resolves the same way `typeIrVersion` did, it would plausibly
also read `"unknown"` under the sibling's symlink layout, meaning the fix adds
a second inert signal rather than a working one. This needs re-checking
against the sibling codebase's current cache metadata files before it's stated as fact.

The tracked closure does incidentally include fractal's `dist/*.d.ts` (verified
by reading `fractalMergedValidators.generated.ts.cache.json` — 3,094 files,
including `packages/type-ir/dist/derive.d.ts`, `packages/api-tree/dist/tree.d.ts`),
so fractal's **type surface** is fingerprinted. Its **runtime codegen logic**
(the `.js` that actually emits the artifact) is not.

### 1.4 the sibling codebase-side bug found in passing: a documented-at-length argument that doesn't exist

<!-- CITATION UNVERIFIED: this whole finding is about apps/web/scripts/codegen-fractal-validators.ts (`defaultShouldShare`, :146, :431-445), which lives in the sibling repo. No sibling checkout was available this pass (checked all sibling directories under ~/git/rhizone/ — no apps/web anywhere on disk), so this could not be re-verified against current sibling-repo state. The fractal-side half of the claim — that `buildSchemaModuleSource`/`buildSchemaModuleSourceIncremental` in packages/api-tree/src/schema-build.ts have no `shouldShare` parameter — was spot-checked and still holds (schema-build.ts, current source). Leaving the original claim below as-is pending a sibling-repo recheck. -->

**[evidenced at audit time]** `apps/web/scripts/codegen-fractal-validators.ts:146` imports
`defaultShouldShare`, and `:431-445` carries a long comment explaining why it's
passed for the recursive-`Expr` case — but `buildSchemaModuleSource`
and `buildSchemaModuleSourceIncremental` (both in `packages/api-tree/src/schema-build.ts`,
current source checked) have **no `shouldShare` parameter**. The value is never
used; the comment asserts a falsehood. Nothing catches it: apps/web's tsconfig
`include: ["src"]` excludes `scripts/`, and `noUnusedLocals` is off. (The
merged-validators script is fine — it goes through apply-validation-build,
which does accept `shouldShare`.)

### 1.5 the sibling codebase CI checks fractal out at floating `master` with no dist build step

<!-- CITATION UNVERIFIED: `.github/workflows/ci.yml:56-58` here refers to the sibling repo's CI workflow (fractal checking itself out makes no sense), which was not available to re-check this pass — no sibling checkout found on disk. -->

**[evidenced that the step is missing at audit time; consequence unverified]** Every api-tree
export points at `./dist/*.js` (`packages/api-tree/package.json`,
`files: ["dist"]` — spot-checked, still current), `dist/` is gitignored and
untracked, and there is no `prepare` script. the sibling codebase CI checks fractal
out at `ref: master` — floating, not pinned — and runs
`bun install --frozen-lockfile` with no `build:packages` step found anywhere in
the workflow. Whether bun's workspace-symlink resolution papers over the missing
dist was **not** verified this session; flagged as-is.

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
occurrences repo-wide, including in comments. One item survives:

### 2.5 A stale status header on the design spec

`docs/design/ir-keyed-cache-spec.md` (522 lines) still opens with "Status:
design spec, certified by the project owner — not yet implemented," which was
already an understatement at audit time and is more wrong now: Tier-2
(`leafFingerprints`, `leafArtifacts`, `defNamesFingerprint`,
`readCarryForwardState`) has fully shipped. Worth flagging to whoever owns
that spec file.

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
   Whether this is still the documented reason the sibling codebase can't use
   the wrappers was not re-checked — no sibling checkout available.
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

6. **`meta-role-split-spec.md`'s status header — [flagged, not fully
   resolved].** The original finding here (future-tense "not yet
   implemented" language about an already-shipped change) is fixed: the
   header now reads "Status: design spec, settled by the project owner —
   mostly implemented, with one confirmed regression against §9(4) below."
   `typed-store-spec.md`'s header similarly now says "Status: IMPLEMENTED in
   fractal." **But** that "mostly implemented, with one confirmed regression"
   phrasing is new since this section was last rewritten, and this pass did
   not investigate what the §9(4) regression actually is — flagging rather
   than asserting it's nothing, since the spec file itself is claiming an
   open problem this audit hasn't looked at.
8. **json-rpc lacks the middleware + ALS every other projector has — still
   true.** No `composeMiddleware`, no `AsyncLocalStorage` anywhere in its
   `src/`; the gesture comment in `server.ts` and the design note in
   `docs/guide/framework.md` both still exist, just at shifted line numbers
   (`framework.md`'s paragraph moved to roughly :131-132).
9. **`get*Meta` duplication — unchanged.** The six verbatim three-line
   `get*Meta`s (graphql, cli, http openapi ×2, json-rpc, http, mcp) are still
   duplicated as described, at slightly shifted lines. (The verbatim
   `composeMiddleware` copies this item originally paired with this are
   fixed — cli, graphql, and mcp all now import a single `composeMiddleware`
   from `@rhi-zone/fractal-api-tree`.)
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
3. **ffi-ir is string-assertion-only across all 13 targets — still true.** No
   test shells out to a real compiler (checked for spawnSync/execSync/
   Bun.spawn/child_process — zero hits across the 13 test files).
   `compile-check.test.ts:1-8`'s header still makes the same point about what
   string tests can't see.
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

### 8.1 the sibling codebase hand-rolls that shadow existing (dead) fractal surface — and why

<!-- CITATION UNVERIFIED (sibling-repo side): the whole opening paragraph plus the
     findEntryFilesCached/directoryListingSignature/findTreeTargetsCached and
     fractalMergedSchemas.ts bullets cite apps/web/scripts/*.ts and
     apps/web/src/server/lib/*.ts. No sibling checkout exists anywhere on this
     disk (checked every sibling directory under ~/git/rhizone/ and beyond) —
     none of these could be re-verified this pass. Note also: the
     buildWireApplyValidationModuleCached/buildSchemaModuleCached wrappers this
     paragraph says are "unusable by the one consumer that wants them" are the
     same wrappers the intro block confirms are used by fractal's own cli.ts. -->

**[evidenced at audit time; not re-verified this pass]** `apps/web/scripts/codegen-fractal-merged-validators.ts:100-125`
was the near-exact body of `writeWireApplyValidationModuleCached`;
`codegen-fractal-validators.ts:485-505` likewise shadowed
`buildSchemaModuleCached`/`writeSchemaModuleCached`. The blocking reason
written down at `codegen-fractal-validators.ts:466-474`: the fractal wrappers
hashed the header-**less** source while the sibling codebase prepends a `@generated` header
before writing — the recorded `outputHash` would permanently mismatch disk and
defeat the cache. The header string itself was a private const in fractal
(`cli.ts:13`) that the sibling codebase copy-pastes verbatim in two scripts. So
the dead-wrapper finding and the header-divergence finding were one story: the
exported wrappers were unusable by the one consumer that wanted them, for a
reason fractal's own CLI worked around privately. **Both halves of this have
since changed on the fractal side** — the wrappers now have a non-Bun-only
write path and an explicit `header` option folded into the cache key — whether
that unblocks the sibling's hand-roll needs checking against the sibling repo
directly.

Other hand-rolls of things fractal-shaped (sibling-repo side, unverified this
pass, same caveat as above):

- `findEntryFilesCached` + `directoryListingSignature`
  (`codegen-fractal-validators.ts:181-217`) and `findTreeTargetsCached`
  (:466ff) — mtime-signature caches bolted around `findEntryFiles`/
  `forEachTreeCandidate` because `discover.ts` unconditionally builds its own
  `ts.Program`.
- `apps/web/src/server/lib/fractalMergedSchemas.ts:20-36` reimplements
  `buildNameMap`'s underscore-joined name computation; its own doc names
  `extractRouteSchemas` (`tree.ts:880`) as the real answer, blocked on cache
  logic.

<!-- Cross-repo citation: the three bullets below cite files in the sibling
     codebase, not this repo — `packages/fractal-support/src/serviceStores.ts`
     and `packages/fractal-support/src/errorEncoder.ts` don't exist in
     fractal's own git history because they were never meant to. Out of scope
     for this repo's citation-cleanup pass, same as the cross-repo material in
     `docs/design/prior-art/server-less.md` and
     `docs/design/operation-layer-spec.md`. -->

- `packages/fractal-support/src/serviceStores.ts:33-42` (in the sibling
  codebase) — `withServiceStoresOnInput` was described as the sibling
  codebase-free generic store→input plumbing.
- `packages/fractal-support/src/errorEncoder.ts:404-415` (in the sibling
  codebase) — `formatValidationErrors` was described as formatting fractal's
  own `ValidationError[]`, its shape reverse-engineered empirically.
- the sibling codebase's errors export (`errorEncoder.ts:538`, same file as
  above) — documented as "fractal's `httpErrors` but matching
  `code`/`kind`/`type` instead of only `.kind`".

`wrapScopes`'s tree walk (sibling-side `scopes.ts:1035-1060`, unverified) was
said to copy the recursive rebuild shape of the since-deleted `wrapValidators`.
**[evidenced, fractal-side half confirmed]** `wrapValidators` really was
deleted (commit `ffa08d4`, "migrate cli/mcp/graphql to applyValidation, delete
wrapValidators (phase 3)") — it survives only in comments now. api-tree still
exports no generic leaf-mapping primitive (`walkTree`/`walkTreePositions` in
`tree.ts`/`apply-validation.ts` are internal, unexported), so the underlying
claim — every consumer transform has to re-implement the recursion — still
holds on the fractal side.

### 8.2 What fractal assumes about its consumer

- **`dist/` exists** (§1.5) — confirmed still true: `packages/api-tree/package.json`
  has no `prepare` script, root `.gitignore` still excludes `dist/`, and
  nothing in the package or (as far as checkable from here) the consumer's CI
  guarantees the build step ran.
- **Version resolution works from fractal's own location** (§1.1) — was false
  under the sibling codebase's symlink layout; degrades to `"unknown"`
  silently. Not re-verified against current sibling state, but the mechanism
  (`resolvePackageVersion`) is unchanged — see updated §1.1 for the follow-on
  wrinkle now that `apiTreeVersion` uses the same resolution path.
- **Bun** — **fixed**: the write helpers now use `node:fs/promises` instead
  of `Bun.write`, so this assumption no longer holds; a Node-only consumer
  should be unblocked here (unverified against the sibling directly).
- **tsconfig: nearest-to-entry-file wins** — citation drifted:
  `type-ir/src/from-typescript.ts:1547` (not :1517), and the call is
  `ts.findConfigFile(path.dirname(path.resolve(entryFile)), ts.sys.fileExists)`
  — the doc's quoted form dropped the `path.resolve()` wrap and the
  `ts.sys.fileExists` argument. Mechanism claim (nearest-to-entry-file tsconfig
  resolution, sibling's split-strictness consequence) not re-checked against
  sibling repo. **[evidenced mechanism; whether it changes any extracted type
  was not tested.]**
- **cwd** — confirmed still current: `discover.ts:52,77` still resolve
  relative roots against `process.cwd()` (actual `path.resolve()` calls at
  :175/:258/:269 in the same file). Sibling-side mitigation (`APP_ROOT` from
  `import.meta.url`, `--cwd apps/web`) not re-verified. Low risk, as
  originally noted.
