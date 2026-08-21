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
`5de8117`-style structural fix existed as an alternative. **[evidenced
mechanisms; the "recurrence-prone" framing is inferred]**

1. **Builder options outside the cache key** (§1.3) — remembering that a
   changed `--tree-id`/`runtimeImport`/`shouldShare` needs `--force` is the
   caller's job; the structural form is options-in-fingerprint.
2. **The byte-exact write contract** on `withCache`/the cached wrappers (§2.4) —
   a caller prepending a header defeats the cache silently. This is not
   hypothetical: it is the documented reason the sibling codebase can't use the wrappers
   (§6.1).
3. **The `program`/`reachable` pairing** (§2.3) — pass a `reachable` computed
   against a different Program and files silently drop out of tracking.
4. **Per-artifact fingerprint completeness is hand-maintained** (§1.2) —
   nothing structural forces "everything that affects the emitted artifact is
   in the fingerprint"; the schema artifact's set drifted.
5. **The toolchain gate depends on version bumps that never happen** (§2.1) —
   correctness delegated to a release habit the repo doesn't have.

For contrast, the automatic mechanisms that never recur as bugs: path-keyed
treeId prefixing (`5de8117`), `outputHash`, closure-from-Program.

---

## 5. Internal consistency

Ordered worst-first. **[evidenced unless marked]**

1. **The core-blindness invariant is broken in the file that states it.**
   `docs/design/meta-role-split-spec.md:11-13` (and `node.ts:46`'s own doc
   comment) say no protocol name may appear in `api-tree/src/node.ts`. But
   `node.ts:579-593` has literal `"http"`/`"cli"` type args and error markers
   named `__http_encodingMap_decoder_type_mismatch`/`__cli_…`;
   `input.ts:630,664` has `NS extends "http" | "cli"`; `tree.ts:212` reads
   `meta.mcp.name`/`.segment` by name (`mcpMetaOverride`). Core knows about
   three projectors. Whether the invariant moved or the code drifted, the two
   are not both current.
2. **`caller` store: "populated by every projector" is false for two of five.**
   `input.ts:36,52-53` assert it; graphql (`resolve.ts:136`) and json-rpc
   (`server.ts:326`) pass `caller: {}`. Middleware written against `caller`
   silently sees nothing on those two.
3. **Two implementations of one meta-read, 14 lines apart.** `mcpMetaOverride`
   (`tree.ts:212-228`) is character-for-character
   `readMetaStringLiteral(nodeType, "mcp", key, loc, checker)` (`tree.ts:242-259`),
   whose own doc says it's "the SAME technique".
4. **The name-derivation tree walk exists ~4½ times**: mcp tools
   (`mcp/project.ts:527-563`), mcp prompts (:1028-1058, identical modulo the
   leaf builder), json-rpc (`project.ts:269-299`, delimiter `"."`), a
   type-level mirror (`api-tree/tree.ts:462-548`), and graphql's camelJoin
   outlier (`project.ts:249`) which `path.ts:40-46` flags as unfixable under
   the escape scheme. Only delimiter + meta namespace + leaf builder differ.
5. **Byte-identical codegen text helpers across a dependency edge.**
   `schemaToType`+`pascalCase`+`safeKey`+`typeBaseName` identical in
   `http-api-projector/codegen.ts:496-585`,
   `http-framework-projector/express.ts:305-392`, and `fastify.ts:323-418`
   (diffed — no drift yet). `express.ts:330-333` admits the duplication, and
   `http-framework-projector` **already depends on** `http-api-projector`
   (`package.json:49`), so no packaging excuse; express/fastify are even in the
   same package as each other. A 5th `pascalCase` in `graphql/codegen.ts:237`.
6. **`meta-role-split-spec.md` is future-tense about a shipped change.**
   Header (:3) says "not yet implemented"; its §2 "today, each projector
   declaration-merges…" narrative (:38-47) describes a state that's gone
   (zero projector-owned `declare module` blocks remain;
   `http/project.ts:39` says so). Every line ref in that passage is dead, as
   are all five in `typed-store-spec.md:77-81`, and `meta-role-split-spec.md:354`
   cites `:124-136` for a read now at `:243`. **[inferred]** Of ~485
   `file.ts:NNN` refs across docs/, a ~14-ref spot-check landed roughly half —
   the convention is probably decaying generally.
7. **`inputLimitParam`: accepted, documented as consumed, read by nothing.**
   Declared (`http/route.ts:236`, `http/project.ts:157`), promised in
   `paginated()`'s doc (`verbs.ts:197-199`) and in
   `docs/design/directive-contract.md:87`; `extensions/pagination.ts:263-264`
   and `route.ts:1108-1109` read only the cursor/offset params. Zero reads.
8. **json-rpc lacks the middleware + ALS every other projector has.** No
   `composeMiddleware`, no `AsyncLocalStorage` in its src;
   `server.ts:478` gestures at it being someone else's job;
   `docs/guide/framework.md:104` documents the gap as a design.
9. **Three verbatim `composeMiddleware`s** (`cli/cli.ts:349-358`,
   `graphql/resolve.ts:155-164`, `mcp/server.ts:682-691`) **and six verbatim
   three-line `get*Meta`s** (graphql :121, cli :456, http openapi :246,:252,
   json-rpc :170, http :216, mcp :385) — while api-tree already hosts
   `assemble`/`composeErrorEncoders` for exactly this reason
   (`input.ts:8-10` argues the point).
10. **The wire-key/sourceMap union inlined four ways, with one real semantic
    divergence.** `[...new Set([...wireKeys, ...Object.keys(sourceMap)])]` at
    `cli/cli.ts:894-896`, `json-rpc/server.ts:325-327`,
    `http/route.ts:1054-1066`; only mcp named it (`paramNamesFor`,
    `server.ts:587-590`). graphql instead uses declared arg names
    (`project.ts:392-396`) — **[inferred]** it won't assemble an undeclared
    wire key the others would. The dead-sourceMap-override lint
    (`http/route.ts:1585-1594`) exists only for http.
11. **graphql's lookup-key convention derived independently in 3 files**
    (`project.ts:542`, `codegen.ts:180`, `client.ts:322`), self-described as
    "independent mirrors"; `underscoreJoin` kept exported "for source
    compatibility" while documented as something nothing should use.
12. **`traceState` declared, never touched.** `otel.ts:86` declares it;
    `parseTraceParent` (:175-195) never sets it, nothing emits it; the module
    doc (:27) claims `layers.ts`/`extensions/tracing.ts` handle
    `traceparent`/`tracestate` — they don't handle the latter.
13. **Two install stories.** `README.md:25` sells `bun add @rhi-zone/fractal`;
    `docs/guide/getting-started.md:12-14` teaches per-package installs and the
    docs site never mentions the umbrella once.
14. **Small drift**: `preset.ts` (http) vs `presets.ts` (mcp, graphql);
    `source()` lives in `source.ts` in four projectors but in `verbs.ts` for
    http — the file the other four cite as canonical; ffi-ir has six verbatim
    `toSnakeCase` copies of type-ir's exported `toSnakeCaseStripSeparators`
    (`rescript-external.ts:88-94` explains: `codegen-helpers.ts` isn't in
    type-ir's export map — blocked on one missing subpath, not oversight).
15. **Stale doc pointers to a phantom function.** `buildValidatorModuleSource`
    is referenced in doc comments at `cache.ts:2,34`, `discover.ts:4,103,110`,
    `tree.ts:757,784` — no such function exists; `build.ts` (named as its home)
    is 40 lines holding only the `GeneratedEntry` type. Presumably the
    pre-rename name of `buildWireApplyValidationModuleSource`.

Explicitly checked and clean: the `source()` helper family, `escapeJoin`
adoption, type-ir's registry split, error-encoder composition, the per-package
`deployment-meta.test-support.ts` files. Most of the above is drift at the
edges of an otherwise disciplined codebase.

---

## 6. The CLI (`packages/api-tree/src/cli.ts`, 339 lines)

Commands: `build`/`watch`/`check` + `-schema` triplet. Flags: `-o`,
`--tree-id`, `--force`, `--cache-file`, `--cache-dir`. **[all evidenced]**

1. **The CLI never engages Tier 2.** `runBuild` uses the non-incremental
   builders and calls `writeCacheMetadata` without `leafData` → the CLI writes
   cache files with empty `leafFingerprints`/`leafArtifacts`. The library's
   best path (the `*Incremental`/`*Cached` family) is bypassed by fractal's own
   CLI — the same shape as the sibling codebase hand-roll, from the other side.
2. **Header divergence between the CLI and the library wrappers.** The CLI
   writes `GENERATED_HEADER + source` and caches those bytes; the cached
   wrappers write the raw source with **no header**
   (`apply-validation-build.ts:1099`, `schema-build.ts:238`). Same artifact,
   two byte-shapes: alternating paths would thrash `outputHash` forever, and a
   wrapper-produced file lacks its `@generated` marker. This exact divergence
   is what forces the sibling codebase's reimplementation (§6.1 below / §1.5 of the
   boundary section).
3. **`check` trusts the cache.** `runCheck` prints "up to date" on a Tier-1 hit
   without rebuilding — a poisoned cache (§1.1/§2.1) fools `check` too. Only a
   missing cache file or `--force` yields a true from-scratch check.
4. **`watch` is non-recursive and watches the wrong scope.**
   `fs.watch(path.dirname(entryFile), …)` (`cli.ts:262`), no `recursive`
   option — edits to transitively imported files outside the entry's own
   directory (or in subdirectories) never trigger a rebuild, even though the
   cache tracks the full closure.
5. Minor: `runCheck` on a miss builds a full fresh Program and writes no
   metadata — repeated checks repay the full cost each time.
6. `writeWireApplyValidationModuleCached`/`writeSchemaModuleCached` use
   `Bun.write` in an otherwise `node:fs` package — the write helpers are
   Bun-only. `writeSchemaModuleCached`'s options type also dropped `reachable`
   while its validator twin kept it — copy drift between the twin wrappers.

---

## 7. Tests

**[evidenced unless marked]**

1. **The cache staleness bug was structurally uncatchable by the suite.**
   `CacheFileShape` has no api-tree self-version field to assert on. The only
   test contact with the version fields is `cache-v3.test.ts:282-283` copying
   them verbatim into a synthesized v2 fixture. **No test writes a different
   `tsVersion`/`typeIrVersion` and asserts a miss** — both invalidation
   branches in `checkCache` (`cache.ts:369-376`) have zero coverage. The 17
   cache test cases (run green this session) are all content-based (dep touch,
   entry edit, hand-edited output, mtime-only touch, `reachable` scoping,
   v2→v3).
2. **No package is test-less; gaps are file-level.** api-tree's `tree.ts`
   (1,050 lines), `tags.ts`, `schema-build.ts` have no sibling test file
   (indirect coverage only; schema-build appears once, in `cache.test.ts:186`).
   type-ir's `kotlin-jackson.ts` (464 loc) and `starlight-reference.ts`
   (427 loc) get only the generic registry smoke loop
   (`registry.test.ts:87-97`) — no assertion the output is right. playground UI
   untested.
3. **ffi-ir is string-assertion-only across all 13 targets** — no equivalent of
   type-ir's `compile-check.test.ts` (which shells out to real compilers), so
   12 FFI targets' output has never been fed to a real toolchain.
   **[inferred]** same bug class `compile-check.test.ts:1-8` itself says
   string tests can't see.
4. **Where tests are strong**: zero snapshot tests repo-wide; http/graphql
   codegen use a 3-tier structural → degraded-input → eval-import-and-drive-a-
   real-server pattern (`http/codegen.test.ts:1-19`); type-ir compile-checks
   14 real toolchains from the nix shell, with 6 declared `describe.skip`
   blocks (:663-668) leaving java/kotlin/newtonsoft/dart/elm/elixir emitters
   string-only in practice. Weakest tier:
   `cross-projector.test.ts:188-198` asserts `typeof result === "string" &&
length > 0`, as its own header admits. mcp/cli `source.test.ts` are
   type-level only (asserted at `typecheck`, not `bun test`).
5. **`examples/library-api`'s committed generated artifact has no CI gate.**
   Its `codegen:check` script (`package.json:17`) is never invoked by
   `.github/workflows/ci.yml`, so the committed `src/generated/
apply-validation.ts` (imported for real at `tree.ts:19`, `app.test.ts:32`)
   is unchecked against current codegen output. **[partly inferred]** a
   wrap-time fingerprint-mismatch mechanism may catch drift at runtime; not
   chased.
6. Fixtures: no stale or orphaned fixtures found.

---

## 8. The sibling codebase boundary

### 8.1 the sibling codebase hand-rolls that shadow existing (dead) fractal surface — and why

**[evidenced]** `apps/web/scripts/codegen-fractal-merged-validators.ts:100-125`
is the near-exact body of `writeWireApplyValidationModuleCached`;
`codegen-fractal-validators.ts:485-505` likewise shadows
`buildSchemaModuleCached`/`writeSchemaModuleCached`. The blocking reason is
written down at `codegen-fractal-validators.ts:466-474`: the fractal wrappers
hash the header-**less** source while the sibling codebase prepends a `@generated` header
before writing — the recorded `outputHash` would permanently mismatch disk and
defeat the cache. The header string itself is a private const in fractal
(`cli.ts:13`) that the sibling codebase copy-pastes verbatim in two scripts (:246 and
merged:79). So the dead-wrapper finding and the header-divergence finding
(§6.2) are one story: the exported wrappers are unusable by the one consumer
that wants them, for a reason fractal's own CLI works around privately.

Other hand-rolls of things fractal-shaped:

- `findEntryFilesCached` + `directoryListingSignature`
  (`codegen-fractal-validators.ts:181-217`) and `findTreeTargetsCached`
  (:466ff) — mtime-signature caches bolted around `findEntryFiles`/
  `forEachTreeCandidate` because `discover.ts` unconditionally builds its own
  `ts.Program`.
- `packages/fractal-support/src/serviceStores.ts:33-42` —
  `withServiceStoresOnInput` is the sibling codebase-free generic store→input plumbing.
- `packages/fractal-support/src/errorEncoder.ts:404-415` —
  `formatValidationErrors` formats fractal's own `ValidationError[]`; the shape
  was reverse-engineered empirically (per its own doc at :438-457, discovered
  via a failing smoke test, not source).
- the sibling codebase's errors export (`errorEncoder.ts:538`) — documented as "fractal's
  `httpErrors` but matching `code`/`kind`/`type` instead of only `.kind`".
- `wrapScopes`'s tree walk (`scopes.ts:1035-1060`) copies the recursive rebuild
  shape of the since-deleted `wrapValidators`; **[evidenced]** api-tree exports
  no generic leaf-mapping primitive, so every consumer transform re-implements
  the recursion.
- `apps/web/src/server/lib/fractalMergedSchemas.ts:20-36` reimplements
  `buildNameMap`'s underscore-joined name computation; its own doc names
  `extractRouteSchemas` (`tree.ts:880`) as the real answer, blocked on cache
  logic.

### 8.2 What fractal assumes about its consumer

- **`dist/` exists** (§1.5) — nothing in the package or the consumer's CI
  guarantees it.
- **Version resolution works from fractal's own location** (§1.1) — false
  under the sibling codebase's symlink layout; degrades to `"unknown"` silently.
- **Bun** — `Bun.write` in the write helpers (§6.6).
- **tsconfig: nearest-to-entry-file wins** (`type-ir/from-typescript.ts:1517`,
  `ts.findConfigFile(path.dirname(entryFile))`). the sibling codebase's entries resolve
  `apps/web/tsconfig.json` — standalone, without `noUncheckedIndexedAccess`/
  `exactOptionalPropertyTypes` — while the `packages/*` code being extracted
  lives under `tooling/tsconfig.lib.json`. Codegen therefore resolves types
  under a different strictness than the code's own config. **[evidenced
  mechanism; whether it changes any extracted type was not tested.]**
- **cwd** — `discover.ts:52,77` resolves relative roots against
  `process.cwd()`; the sibling codebase sidesteps it by deriving `APP_ROOT` from
  `import.meta.url`, and the root script's `--cwd apps/web` satisfies the
  contract by convention. Low risk.
