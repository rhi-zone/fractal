# Repo audit — 2026-08-20

Read-only audit of the `@rhi-zone/fractal-*` monorepo, same lens as the sibling codebase
sweep: what's there, what's inconsistent, what's broken, what's dead. Findings
are ordered by severity within each section. Every finding is tagged
**[evidenced]** (file:line read this session, or command output) or
**[inferred]** (a read of the evidence, not the evidence itself). No fixes or
plans here — this names what is, only.

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
  `buildWireApplyValidationModuleCached` directly (see §6.1, which needs the
  same update). Whether the sibling codebase still separately
  hand-reimplements the sequence was not re-checked this pass — no sibling
  checkout was available.
- `checkCache` gated on `ts.version` + `@rhi-zone/fractal-type-ir`'s version
  but not `fractal-api-tree`'s own. **Since fixed**: `cache.ts` now also
  gates on `apiTreeVersion` (`CacheFileShape.apiTreeVersion`, checked via
  `resolvePackageVersion("@rhi-zone/fractal-api-tree", entryFile)`), with a
  doc comment on the field citing this audit's §1.1/§2.1 by name as the
  reason it was added. Both packages' versions are still pinned at a
  never-bumped `0.1.0-alpha.0`.

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
in the cache shape at all — is now closed (§2.1): `checkCache`/`toolchainMatches`
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

### 1.2 Schema Tier-2 fingerprint omitted `description` — silent stale descriptions [**fixed since audit**]

**[evidenced, historical]** `buildSchemaModuleSourceIncremental`'s per-leaf
fingerprint was `{input, output}` only, but the artifact it carries forward
embeds `info.description` (`toolSchemaFrom`). So on any Tier-1 miss where a
tool's types didn't change but its **description did**, the prior artifact —
old description included — was reused verbatim, and the generated schema
module silently kept the stale text.

**This is fixed.** `buildSchemaModuleSourceIncremental`'s fingerprint (in
`packages/api-tree/src/schema-build.ts`) now includes `description` alongside
`input`/`output`, with an inline comment citing this audit's §1.2 by name as
the reason. `toolSchemaFrom` is unchanged in behavior, just moved a few lines.
The validator-side fingerprint remains more complete
(`{input, protocol, derivation, hookFields}`, in
`apply-validation-build.ts`'s leaf-fingerprint computation) — the two
artifacts' fingerprint completeness was hand-maintained separately and had
diverged; that divergence is what this fix closed for the schema side.
Whether the sibling codebase's schema codegen path
(`apps/web/scripts/codegen-fractal-validators.ts`, incremental sequence) has
picked up the fix was not re-verified this pass — no sibling checkout
available.

### 1.3 Builder options were not part of the cache key at all [**fixed since audit**]

**[evidenced, historical]** `CacheFileShape` had no field for build options,
and `checkCache(entryFile, outFile, opts)` consulted nothing else. Consequences
at audit time:

- `fractal-api-tree build-schema e -o out --tree-id A`, then the same command
  with `--tree-id B`: Tier-1 **hit** — tree B is never built; tree A's artifact
  is served as "up to date". Same forgotten-parameter family as the `280ae55`
  treeId collision, one layer up.
- `runtimeImport` (validator build option): change it between runs → hit → old
  import emitted indefinitely.
- `shouldShare`: same (fingerprints would move on a miss, but Tier 1 hits first
  since no input file changed).

**This is fixed.** `CacheFileShape` now carries a `buildOptionsKey: string`
field, checked by both `checkCache` and `toolchainMatches`, with a doc comment
citing this audit's §1.3/§4 by name as the motivating finding.

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

### 1.6 The stale merged-validators artifact: real, but NOT cleanly attributable to the cache bug

<!-- Note: this finding describes a transient working-tree snapshot in the sibling repo at audit time (mtime ordering, a hand-recomputed hash at that moment) — not a durable citation target even in principle. No sibling checkout was available to re-check it this pass, and nothing more durable to point at exists for this kind of point-in-time observation; left as historical record. -->

**[evidenced state at audit time, inferred attribution]** At audit time,
`apps/web/src/_generated/fractalMergedValidators.generated.ts` is stale w.r.t.
the working tree: the uncommitted `api-fractal/classes.ts:322` change
(`priceCents: number` → `price: { amountMinor; currency }`) is absent — the
artifact has 51× `priceCents`, 0× `amountMinor`, and is byte-identical to HEAD.
However:

- The mtime ordering is backwards for a codegen run (artifact 20:21, its
  cache.json 20:20; the script writes the artifact **before** the metadata).
- A hand-recomputed `checkCache` right now **misses** (recorded `outputHash`
  `9bbc6964…` vs current `91629bde…` → "output file changed outside codegen"),
  so the next codegen run rebuilds — the staleness is self-healing.

Reading: the artifact was restored/overwritten from HEAD outside the codegen
pipeline, amid the in-flight classes/money work — **not** a demonstration of
the §1.1/§2.1 version-gate hole. That hole is real in the code and real in the
`"unknown"` recordings; this particular artifact just isn't its smoking gun.

---

## 2. The cache design (`packages/api-tree/src/cache.ts`, 734 lines)

**Update**: three commits landed after this audit and fixed nearly everything
below — `c60cdd08` (close the version/options blind spots), `c84cf26` (track
tsconfig in the cache key, add a header option, engage CLI Tier-2 caching),
and `ae79532` (remove `withCache`, a dead reference implementation). §2.1-2.4
are rewritten below to describe what was found *and* what changed; only §2.5
(the sound parts) was never broken.

### 2.1 The version-gate hole extended to Tier 2 — carried-forward artifacts included [**fixed since audit**]

**[evidenced, historical]** `checkCache` gated on `tsVersion` + `typeIrVersion`,
never api-tree's own version. Additionally: `toolchainMatches` — the gate
`readCarryForwardState` uses for Tier-2 carry-forward — checked the
**identical** signal set (`version === 3`, `entryFile`, `tsVersion`,
`typeIrVersion`). Carried-forward leaf **artifacts** (compiled validator
fragments, `ToolSchema` values, stored verbatim in `leafArtifacts`) were
therefore reused verbatim across api-tree codegen-template changes — so even a
full Tier-1-miss rebuild emitted stale generated code for every
unchanged-fingerprint leaf.

**This is fixed.** Both `checkCache` and `toolchainMatches` now also gate on
`apiTreeVersion` (`resolvePackageVersion("@rhi-zone/fractal-api-tree", ...)`),
plus `compilerOptionsHash` and `buildOptionsKey` (§2.2, §1.3) — the signal set
grew well past what this section originally described. `leafArtifacts` itself
is unchanged in shape and still carried forward verbatim by
`readCarryForwardState`. Both packages' versions are still pinned at a
never-bumped `0.1.0-alpha.0` (`packages/api-tree/package.json:3`,
`packages/type-ir/package.json:3`), so the gate exists now but is still inert
in practice until a version bump actually happens — the mechanism changed,
the practical consequence (nothing invalidates on a fractal-internal release)
may not have.

### 2.2 tsconfig / compilerOptions were not tracked [**fixed since audit**]

**[evidenced, historical]** The module doc admitted it ("compiler options
embedded in tsconfig.json resolution … out of scope"). `tsconfig.json` was not
in `program.getSourceFiles()`, so not in `files`. An edit to `paths`/`types`/
`strict` could change extraction output while the cache still hit.

**This is fixed.** A new `computeCompilerOptionsFingerprint` (`cache.ts`)
sha256's `loadCompilerOptionsForFile(entryFile)`, tracked as
`compilerOptionsHash` on the cache-metadata shape and checked in both
`checkCache` and `toolchainMatches`. tsconfig changes are now a real cache
miss. The out-of-scope comment is gone.

### 2.3 `writeCacheMetadata` silently untracks mismatched `reachable` paths

**[evidenced]** Paths in `reachable` not present in the Program are silently
skipped — the doc comment frames this as "a caller bug worth surfacing as
'this file never got tracked', not a thrown exception". Nothing surfaces it;
the symptom is permanent stale hits for edits to the untracked files, invisible
until a wrong artifact. Still true, unchanged by the recent fixes.

(A related but distinct point the original write-up conflated: a `statSync`
failure inside `writeCacheMetadata`'s write-time stat does fall back to
`size: -1, mtimeMs: -1`, forcing a content hash on that file at the next warm
check — perf-only, correctness unaffected. `checkCache`'s own *read-time* stat
helper is a separate code path that returns `undefined` on failure and treats
a missing stat as `hit: false` outright, not as "content-hash forever".)

### 2.4 `withCache` — the exported "shared orchestration" that nothing used, including its claimed users [**removed since audit, not just fixed**]

**[evidenced, historical]** `withCache`'s doc comment claimed: "the shared
orchestration both build.ts and schema-build.ts use". False on both counts:
grep found **no non-test caller anywhere** (fractal, examples, spike, the
sibling codebase). `buildWireApplyValidationModuleCached`,
`buildSchemaModuleCached`, and `cli.ts`'s `runBuild` each hand-inlined the same
`checkCache → build → writeCacheMetadata` sequence — copies of the
orchestration plus one dead exported "shared" one.

**`withCache` no longer exists.** It was deleted outright in `ae79532`
("refactor: remove withCache, a dead reference implementation") rather than
fixed in place — grep across the whole repo now finds zero occurrences,
including in comments. `cli.ts`'s `runBuild` no longer hand-inlines its own
sequence either: it now delegates to `buildWireApplyValidationModuleCached`/
`buildSchemaModuleCached` via a `kind.cached(...)` call (see §6.1, also fixed).
`cli.ts`'s `runCheck` still does its own inline `checkCache`/
`writeCacheMetadata` pair, so the "two-plus copies of the same orchestration"
shape survives in reduced form — just without the third, dead "shared" export
alongside it. The byte-exact-write hazard this section used as its worst
example (§4 item 2) is now moot as an example citing `withCache` specifically,
since that symbol is gone — but the underlying hazard still applies to the two
remaining `*Cached` wrappers, which still require callers to write the exact
bytes they computed.

### 2.5 Fingerprint machinery that is otherwise sound

**[evidenced]** For contrast: `outputHash` catches hand-edited outputs; the
closure is content-addressed from the Program's own file set; mtime+size falls
back to a content hash (touch-tolerant); def-name-set fingerprinting
(`computeDefNamesFingerprint`) for leaf carry-forward is sound (def bodies are
recompiled unconditionally each build; leaves reference defs by name). Still
current, unchanged by the recent fixes.

The spec (`docs/design/ir-keyed-cache-spec.md`, still 522 lines) still opens
with "Status: design spec, certified by the project owner — not yet
implemented" — which was already an understatement at audit time and is more
wrong now: Tier-2 (`leafFingerprints`, `leafArtifacts`,
`defNamesFingerprint`, `readCarryForwardState`) has fully shipped. This is a
separate stale-doc finding from the fingerprint-completeness gap the original
sentence was pointing at (§1.2, itself now fixed) and is worth flagging to
whoever owns that spec file.

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
  `package.json` is **41**, not 13. "every `to*Ffi` projector referenced only
  by its own test" still holds — zero outside importers found.
- **`fractal`** (umbrella) — still 6 pure `export *` facade files
  (`cli.ts`, `json-rpc.ts`, `mcp.ts`, `graphql.ts`, `http.ts`, `index.ts`),
  still only exercised by its own `module-graph.test.ts`. Still not imported
  by fractal, examples, spike, or the sibling codebase. Note the doc split in
  §5.13: README sells the umbrella, `docs/guide/getting-started.md` now leads
  with the umbrella install too — that split is fixed, see §5.13.
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
  (**removed entirely**, see §2.4 — the `cache.ts:630` citation is now a dead
  pointer to a deleted symbol, not a dead-but-present export),
  `computeBundleFingerprint` (`cache.ts`, now :672 — **not actually dead**:
  called internally from `writeCacheMetadata` at :601, no external caller
  though), `getActiveSpan` (`otel.ts`, now :216 — test-only, no non-test
  caller), `affectedEntries` (`reachability.ts`, now :245 — test-only),
  `writeSchemaModule` (`schema-build.ts`, now :106 — confirmed genuinely dead,
  zero references anywhere besides its own definition and a doc-comment
  mention) + `writeSchemaModuleCached` (now :283 — **not dead**: heavily used
  across `cache.test.ts`), both `*WireApplyValidationModuleCached` wrappers
  (see intro block and §6.1 — no longer dead, `cli.ts` calls them now) + ~7
  sibling option/result types.
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

### 3.3 Broken-as-published subpaths and other inventory rot [**both findings fixed since audit**]

- **[evidenced, historical]** `type-ir/package.json` had 5 subpaths pointing
  at `./src/*.ts` instead of `./dist/*.js` (`./rescript`, `./rescript-native`,
  `./gleam`, `./gleam-native`, `./rust-wasm-bindgen`) while `files: ["dist"]`
  — broken in any published tarball. `rescript-native.ts`/`gleam-native.ts`
  were also not registered in `registry.ts`, unlike their non-native
  siblings.

  **This is fixed.** All 5 subpaths now point at `./dist/*.js`/`./dist/*.d.ts`
  (commit `e9f861e`, "fix(type-ir): point rescript/gleam/rust-wasm-bindgen
  subpaths at dist, register the two natives", dated the same day as this
  audit). `rescript-native.ts` and `gleam-native.ts` are now registered in
  `registry.ts` (imports at :123-124, entries at :697-698, alias map at
  :812-813). "24 of 129 type-ir subpaths never imported externally" was not
  re-verified this pass.
- **[evidenced, historical]** `spike/scale` imported
  `@rhi-zone/fractal-client-api-projector` — a package merged into
  http-api-projector on 2026-07-18 per `docs/api/index.md:9` (citation still
  correct) — making the import unresolvable and dead.

  **This is fixed.** `spike/scale/correctness.ts` and `spike/scale/gen/generate.ts`
  now both import `@rhi-zone/fractal-http-api-projector` directly; the dead
  import is gone, the migration this finding was waiting on already happened.
  The sibling codebase's `tooling/fractal-spike/tax-compliance/tree.ts:24`
  claim (naming a `@rhi-zone/fractal-core` that never existed) was not
  re-verified this pass — no sibling checkout available, and no
  `tooling/fractal-spike` directory exists in this repo either.

---

## 4. Opt-in vs automatic correctness (the treeId template)

Places where correctness depends on a caller remembering something, where the
`423b8fa`-style structural fix existed as an alternative (doc originally cited
`5de8117`, which is not a commit in this repo's history — see intro block).
**[evidenced mechanisms; the "recurrence-prone" framing is inferred. Several of
the items below describe holes that have since been closed — noted per item.]**

1. **Builder options outside the cache key** (§1.3) — **fixed**: this is no
   longer "remembering that a changed flag needs `--force`", it's now
   structural (`buildOptionsKey` folded into the fingerprint automatically).
   Kept here as the historical example of the pattern this section is about.
2. **The byte-exact write contract** on the cached wrappers (§2.4) — `withCache`
   itself is gone (deleted, not fixed), but the two remaining
   `*Cached` wrappers still require callers to write the exact bytes they
   computed; a header option was added (§6.2) that threads the header through
   the fingerprint rather than eliminating the byte-exactness requirement.
   Whether this is still the documented reason the sibling codebase can't use
   the wrappers was not re-checked — no sibling checkout available.
3. **The `program`/`reachable` pairing** (§2.3) — unchanged, still true: pass a
   `reachable` computed against a different Program and files silently drop
   out of tracking.
4. **Per-artifact fingerprint completeness is hand-maintained** (§1.2) — the
   specific instance this pointed at (schema fingerprint omitting
   `description`) is **fixed**, but the structural point stands: nothing
   forces "everything that affects the emitted artifact is in the
   fingerprint" for the *next* artifact someone adds a field to.
5. **The toolchain gate depends on version bumps that never happen** (§2.1) —
   the gate itself grew (now also checks `apiTreeVersion` and
   `compilerOptionsHash`), but the conclusion is unchanged: correctness is
   still delegated to a release habit (bumping `0.1.0-alpha.0`) the repo
   doesn't have, so the gate remains inert in practice.

For contrast, the automatic mechanisms that never recur as bugs: path-keyed
treeId prefixing (`423b8fa`), `outputHash`, closure-from-Program.

---

## 5. Internal consistency

Ordered worst-first at audit time. **[evidenced unless marked]** **Update: most
of this section has since been fixed in code** — items 1-6, 11, 12, 13, 15, and
part of 14 describe problems that no longer exist, several with fixes dated
the day after this audit. Rewritten per item below rather than left standing.

1. **The core-blindness invariant — fixed.** At audit time, `node.ts:579-593`
   had literal `"http"`/`"cli"` type args and protocol-named error markers,
   contradicting the no-protocol-names invariant `node.ts:46` and
   `docs/design/meta-role-split-spec.md:11-13` state for that file. Now: the
   error marker is generic (`__encodingMap_decoder_type_mismatch`), and the
   comment above it explicitly says node.ts "reads back only a
   namespace-generic result, never a namespace literal of its own." The
   `"http"|"cli"` literals the doc also cited at `input.ts:630,664` do still
   exist — but `input.ts` isn't `node.ts`, so that was never actually a
   violation of the node.ts-scoped invariant. `tree.ts`'s
   `meta.mcp.name`/`.segment` read via `mcpMetaOverride` is called out as a
   documented, intentional exception in `tree.ts`'s own module comments. The
   violation this item described in `node.ts` no longer exists.
2. **`caller` store: "populated by every projector" — fixed.** `input.ts`'s
   doc comment now documents exactly one exception (json-rpc's WebSocket
   transport, with rationale) instead of claiming universal population.
   graphql (`resolve.ts`, `callerFromContext`) and json-rpc (`server.ts`,
   `callerFromRequestHeaders`) both now populate `caller` from
   headers/context in their normal paths; only json-rpc's WS transport and
   graphql's unrecognized-context-shape fallback still pass `{}`, and both are
   now documented as deliberate.
3. **Two implementations of one meta-read — fixed.** `mcpMetaOverride`
   (`tree.ts`) is now a one-line delegate to `readMetaStringLiteral` rather
   than a character-for-character duplicate.
4. **The name-derivation tree walk existed ~4½ times — mostly fixed.** A
   shared `packages/api-tree/src/tree-walk.ts` (`walkNamedTree`) now exists;
   both mcp's tools/prompts walks and json-rpc's walk call it instead of
   duplicating. Its module doc explains why graphql's `camelJoin` outlier and
   the type-level mirror (`walkNodeType`) are deliberately *not* folded in
   (different escape scheme / different type-vs-value level) — so the
   duplication is down from ~4½ to 2 documented, irreducible outliers.
5. **Byte-identical codegen text helpers — fixed.** `express.ts`/`fastify.ts`
   no longer define their own `schemaToType`/`pascalCase`/`safeKey`/
   `typeBaseName` — they import them from
   `@rhi-zone/fractal-http-api-projector/codegen`. Only `http-api-projector`'s
   own `codegen.ts` still has the real definitions, plus graphql's separate
   `pascalCase`/`safeKey`/`typeBaseName` (legitimately standalone — different
   escaping needs).
6. **`meta-role-split-spec.md` future-tense about a shipped change — fixed.**
   Its header now reads "Status: … implemented" (was "not yet implemented"),
   and `typed-store-spec.md`'s header similarly now says "Status: IMPLEMENTED
   in fractal" with an "as implemented" correction paragraph immediately after
   its old dead refs. Both docs already got their own updates; this finding is
   commentary on an already-fixed staleness. **[inferred, unchanged]** the
   general point — that a ~14-ref spot-check of `file.ts:NNN` refs across
   `docs/` landed roughly half — is a separate, still-live observation about
   the citation convention generally (this very audit doc being exhibit A).
7. **`inputLimitParam` — resolved by removal, not by wiring it up.** The
   field is gone entirely: zero hits anywhere in `.ts`/`.md` except a new
   `docs/design/decisions.md` entry explaining it was removed because
   cursor/offset's customizable name doesn't generalize to limit. The
   accepted-but-unread param this item flagged no longer exists to be
   accepted.
8. **json-rpc lacks the middleware + ALS every other projector has — still
   true.** No `composeMiddleware`, no `AsyncLocalStorage` in its src; the
   gesture comment in `server.ts` and the design note in
   `docs/guide/framework.md` both still exist, just at shifted line numbers
   (`framework.md`'s paragraph moved to roughly :131-132). The only item in
   1-8 that's still an open finding as originally described.
9. **Verbatim `composeMiddleware`s — fixed; `get*Meta` duplication —
   unchanged.** All three former `composeMiddleware` copies (cli, graphql,
   mcp) now import a single `composeMiddleware` from
   `@rhi-zone/fractal-api-tree` — consolidated alongside `assemble`/
   `composeErrorEncoders`, as `input.ts:8-10` argues they should be. The six
   verbatim three-line `get*Meta`s (graphql, cli, http openapi ×2, json-rpc,
   http, mcp) are still duplicated as described, at slightly shifted lines.
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
11. **graphql's lookup-key convention — fixed.** All three former
    "independent" sites (`project.ts`, `codegen.ts`, `client.ts`) now call a
    shared `escapeJoin([...path, key], "_")`. `underscoreJoin` is still
    exported "for source compatibility," but the doc comment right above it
    already says the three call sites converged on `escapeJoin` — this item's
    "independently derived in 3 files" framing contradicts current code and
    should be read as resolved, folded into the "escapeJoin adoption" item in
    the clean list below.
12. **`traceState` declared, never touched — fixed by removal.** The field
    doesn't exist anywhere in `otel.ts` anymore (not just "declared, unused"
    — the declaration itself is gone). The module doc now plainly states only
    `traceparent` is handled end to end and `tracestate` is parsed by neither
    the module nor its HTTP-side callers — the doc no longer claims otherwise,
    so the contradiction this item flagged is gone along with the field.
13. **Two install stories — fixed.** `README.md`'s umbrella install (`bun add
    @rhi-zone/fractal`) is still accurate, and `docs/guide/getting-started.md`
    now *leads* with the umbrella install too, showing per-package installs
    only as an alternative after. Both docs agree now.
14. **Small drift**: `preset.ts` (http) vs `presets.ts` (mcp, graphql) — still
    true. `source()` in `source.ts` for four projectors, `verbs.ts` for http —
    still true. ffi-ir's six verbatim `toSnakeCase` copies of type-ir's
    `toSnakeCaseStripSeparators` — **fixed**: every ffi-ir target now imports
    `toSnakeCaseStripSeparators` directly from
    `@rhi-zone/fractal-type-ir/codegen-helpers`, which type-ir's
    `package.json` now exports. (`rescript-external.ts` now instead flags a
    *different*, still-real duplication: a `RESERVED` reserved-word set
    copied because `rescript-native.ts` doesn't export its set — a live
    replacement finding in the same spot, not chased further this pass.)
15. **Stale doc pointers to a phantom function — fixed.** Every reference in
    `cache.ts`/`discover.ts`/`tree.ts` already reads
    `buildWireApplyValidationModuleSource` (the real name); the phantom
    `buildValidatorModuleSource` string no longer occurs anywhere in the
    package. `build.ts` still matches the original description exactly: 40
    lines holding only the `GeneratedEntry` type.

Explicitly checked and clean: the `source()` helper family, `escapeJoin`
adoption (now also covers item 11 above), type-ir's registry split, error-encoder
composition, the per-package `deployment-meta.test-support.ts` files (found in
2 of 5 projector packages on a spot-check, not all five — "per-package"
wording is generous but not wrong). What was "drift at the edges of an
otherwise disciplined codebase" at audit time reads, one day later, like a
codebase whose owner used this audit as a punch list.

---

## 6. The CLI (`packages/api-tree/src/cli.ts`, 519 lines)

Commands: `build`/`watch`/`check` + `-schema` triplet. Flags: `-o`,
`--tree-id`, `--force`, `--cache-file`, `--cache-dir`. **[all evidenced at
audit time — every item below has since been fixed in code, several with
inline comments explicitly citing this section by name (e.g. "audit §6#1").
Rewritten per item; file grew from 339 to 519 lines in the process.]**

1. **The CLI never engaged Tier 2 — fixed.** At audit time, `runBuild` used
   the non-incremental builders and called `writeCacheMetadata` without
   `leafData`. Now: `runBuild` calls `kind.cached(...)`, which delegates to
   `buildWireApplyValidationModuleCached`/`buildSchemaModuleCached` — the
   Tier-2 wrappers, not the raw builders.
2. **Header divergence between the CLI and the library wrappers — fixed.**
   The CLI wrote `GENERATED_HEADER + source` and cached those bytes while the
   cached wrappers wrote raw source with no header — same artifact, two
   byte-shapes. Now: both `apply-validation-build.ts` and `schema-build.ts`
   take an `options.header` that's prepended and folded into the cache key,
   and the CLI's `GENERATED_HEADER` flows through as that option instead of
   being CLI-only.
3. **`check` trusted the cache — the underlying premise changed.** `runCheck`
   still takes the Tier-1-hit fast path without rebuilding, which is correct
   cache-consumer behavior on its own — the finding's actual complaint was
   that a poisoned cache (§1.1/§2.1, both since fixed) fooled `check` too.
   With the version-gate hole closed, this item's "only `--force` yields a
   true check" framing is worth re-evaluating rather than restating as a bug.
4. **`watch` was non-recursive and watched the wrong scope — fixed.**
   `runWatch` now computes `watchDirsOf(program)` — every directory in the
   tracked closure — and sets a non-recursive watcher per directory
   (deliberately avoiding platform-dependent `recursive: true` rather than
   relying on it). Edits anywhere in the closure now trigger a rebuild.
5. **Minor: `runCheck` on a miss wrote no metadata — fixed**, same change as
   item 1; metadata is now written on the up-to-date branch too.
6. **`Bun.write` in an otherwise `node:fs` package, and dropped `reachable`
   on one wrapper's options type — fixed.** Both
   `apply-validation-build.ts` and `schema-build.ts` now use
   `node:fs/promises`'s `writeFile`/`mkdir`, with comments explicitly citing
   "audit §6#6" for the switch away from `Bun.write`. `reachable` is present
   symmetrically in both wrapper option types now. (Note: the doc originally
   named these `writeWireApplyValidationModuleCached`/`writeSchemaModuleCached`
   — current names are `buildWireApplyValidationModuleCached`/
   `buildSchemaModuleCached`; possibly a naming mixup predating this fix, not
   verified.)

---

## 7. Tests

**[evidenced unless marked]** **Update**: item 1 and item 5 below were fixed
since the audit (both dated the day after); items 2-4 and 6 are unchanged and
still current.

1. **The cache staleness bug was structurally uncatchable by the suite — fixed.**
   At audit time, `CacheFileShape` had no api-tree self-version field to
   assert on, and no test wrote a different `tsVersion`/`typeIrVersion` to
   assert a miss. Now: `cache.ts` has the `apiTreeVersion` self-version field
   (§2.1), and there's a new test ("a different apiTreeVersion in the
   recorded metadata is a miss") explicitly citing "audit §1.1/§2.1". Running
   the suite: **25 tests pass, 0 fail** (was 17 at audit time — the count grew
   along with the coverage, still fully green).
2. **No package is test-less; gaps are file-level — still true.** api-tree's
   `tree.ts` (now 1,042 lines, was 1,050), `tags.ts`, `schema-build.ts` still
   have no sibling test file. type-ir's `kotlin-jackson.ts` (464 loc, exact
   match) and `starlight-reference.ts` (427 loc, exact match) still get only
   the generic registry smoke loop (`registry.test.ts:87-97`, lines
   unchanged) — no assertion the output is right. playground UI still
   untested.
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
5. **`examples/library-api`'s committed generated artifact had no CI gate —
   fixed.** `.github/workflows/ci.yml` now has a "Codegen check (library-api
   example)" step that runs `bun run codegen:check` in `examples/library-api`,
   with a comment explaining it catches drift `bun run test` can't see. The
   `package.json:17` script and `tree.ts:19`/`app.test.ts:32` import
   citations are still correct locations — only the "never invoked" claim was
   wrong as of this fix.
6. Fixtures: no stale or orphaned fixtures found — unchanged.

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
     same wrappers the intro block and §6.1 now confirm are used by fractal's
     own cli.ts — worth checking on next sibling-repo access whether the
     header-fix (§6.2, also since landed) changed this story too. -->

**[evidenced at audit time; not re-verified this pass]** `apps/web/scripts/codegen-fractal-merged-validators.ts:100-125`
was the near-exact body of `writeWireApplyValidationModuleCached`;
`codegen-fractal-validators.ts:485-505` likewise shadowed
`buildSchemaModuleCached`/`writeSchemaModuleCached`. The blocking reason
written down at `codegen-fractal-validators.ts:466-474`: the fractal wrappers
hashed the header-**less** source while the sibling codebase prepends a `@generated` header
before writing — the recorded `outputHash` would permanently mismatch disk and
defeat the cache. The header string itself was a private const in fractal
(`cli.ts:13`) that the sibling codebase copy-pastes verbatim in two scripts. So
the dead-wrapper finding and the header-divergence finding (§6.2) were one
story: the exported wrappers were unusable by the one consumer that wanted
them, for a reason fractal's own CLI worked around privately. **Both halves of
this have since changed on the fractal side** — the wrappers now have a
non-Bun-only write path and an explicit `header` option folded into the cache
key (§6.2, §6.6) — whether that unblocks the sibling's hand-roll needs
checking against the sibling repo directly.

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

<!-- CITATION UNRESOLVED: the two bullets below cite `packages/fractal-support/src/serviceStores.ts`
     and `packages/fractal-support/src/errorEncoder.ts`. This package has never
     existed in this repo's git history at all (checked `git log --all` for the
     path — no add, delete, or rename, ever), and `withServiceStoresOnInput`/
     `formatValidationErrors` don't exist anywhere in the codebase either. This
     may be a sibling-repo path mislabeled as fractal-side (this environment has
     no sibling checkout to check), or content that's been removed along with
     the whole package — could not determine which without more context, and
     guessing a replacement path felt worse than flagging it. Needs a human
     call. -->

- `packages/fractal-support/src/serviceStores.ts:33-42` —
  `withServiceStoresOnInput` was described as the sibling codebase-free generic
  store→input plumbing.
- `packages/fractal-support/src/errorEncoder.ts:404-415` —
  `formatValidationErrors` was described as formatting fractal's own
  `ValidationError[]`, its shape reverse-engineered empirically.
- the sibling codebase's errors export (same phantom `errorEncoder.ts:538`
  file as above) — documented as "fractal's `httpErrors` but matching
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
- **Bun** (§6.6) — **fixed**: the write helpers now use `node:fs/promises`
  instead of `Bun.write`, so this assumption no longer holds; a Node-only
  consumer should be unblocked here (unverified against the sibling directly).
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
