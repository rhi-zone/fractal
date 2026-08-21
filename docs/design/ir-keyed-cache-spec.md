# IR-keyed build cache: the cache unit is a leaf's type-IR, not a file

Status: **IMPLEMENTED in fractal.** Was: "design spec, certified by the
project owner — not yet implemented." Tier 2 (the leaf-level IR-keyed cache
this spec describes) shipped in `1f31a01` "feat(api-tree): IR-keyed build
cache v3 — leaf-level Tier 2 on top of Tier 1's file gate" (2026-08-02):
`cache.ts` carries v3 metadata (`leafFingerprints`/`bundleFingerprint`/
`defNamesFingerprint`/`leafArtifacts` alongside Tier 1's `files`/
`outputHash`), `buildValidatorModuleSourceIncremental`/
`buildSchemaModuleSourceIncremental` do the Tier-2 orchestration, and
`buildValidatorModuleCached`/`buildSchemaModuleCached` compose Tier 1 + Tier
2. `c84cf26` "fix(api-tree): track tsconfig in cache key, add header option,
engage CLI Tier-2 caching" (2026-08-21) then wired the CLI onto these
`*Cached`/`*Incremental` builders and extended the cache key to cover
`buildOptions`/tsconfig (`compilerOptionsHash`) alongside the header option,
closing the gap where those changes were silently ignored. The sections
below are kept as written — they remain the contract this implementation is
checked against. Note that the motivation section immediately below
describes `cache.ts` as it stood pre-`1f31a01` (the v2 FILE-closure-keyed
cache); that description is now historical context for why the leaf-level
redesign was needed, not a description of current HEAD. Sibling to
`typed-store-spec.md` / `meta-role-split-spec.md` in status and in the
convention this doc follows: code-verified claims, `[verify]` items
empirically checked in scratch before being asserted as fact (§6), an
explicit regression list (§8), open questions left open rather than
silently resolved (§9).

## 1. Motivation — grounded against `cache.ts` as it stands

Read directly from `cache.ts`'s own doc comments (lines 14–105), not
paraphrased:

- **The "Key-granularity decision" block (lines 14–66) is itself marked
  "SUPERSEDED 2026-08-02, see reachability.ts"** — but what `reachability.ts`
  (`25fa9fc`) resolved was the granularity at which the FILE SET is computed
  per entry (precise per-entry closures out of a shared multi-root
  `ts.Program`, instead of the whole batch's union closure applied to every
  entry). It did not change what identifies a cache unit: a cache entry's
  key is still "this entry's file closure's content hashes," now computed
  more precisely, but a file is still the atom being hashed.
- **The unit mismatch this produces, read directly**: `writeCacheMetadata`
  records `files: Record<string, TrackedFileEntry>` (line 242) — an entry's
  ENTIRE reachable file set, one hash per file. `checkCache`'s tiered
  re-validation (`711dfbb4`, lines 68–105, 286–300) makes RE-CHECKING that
  set cheap (a `stat` before a content hash — the measured 52ms→5ms/entry
  win the doc block records), but it does not change what a MISS does: on
  any tracked file's content actually changing, the entire entry is
  rebuilt and its entire output re-emitted — the checkCache → build →
  writeCacheMetadata orchestration (hand-inlined by each of build.ts,
  schema-build.ts, cli.ts) is a binary hit/miss over the WHOLE `outFile`,
  there is no partial-miss path.
- **A comment-only or implementation-only edit inside a leaf's own handler
  body forces a full re-emit of every artifact whose entry closure contains
  that file** — even though nothing about any leaf's resolved input/output
  TYPE changed. This is not a hypothetical: `extract.ts`'s
  `typeRefFromFunctionNode`/`typeRefFromReturnType` (used by
  `tree.ts`'s `extractRouteTypeRefs`, `build.ts`'s
  `buildValidatorModuleSource`) derive a leaf's IR purely from the checker's
  resolved TYPE of the handler's parameter/return — reading `extract.ts`
  directly, no code path there consults the handler BODY's statements at
  all beyond what TypeScript needs to resolve an inferred return type. The
  file-content hash the cache keys on necessarily changes on every edit to
  that file (body included), whether or not the derived IR does.
- **File organization is irrelevant to what actually needs to invalidate.**
  The thing being cached — `compileValidatorModule`'s generated
  check/errors/parse code (`build.ts`), `schema-build.ts`'s JSON-Schema
  artifact — is a pure function of a leaf's resolved input/output TypeRef
  (`extract.ts`'s own derivation, confirmed by reading it: no non-type
  input feeds `typeRefFromFunctionNode`/`typeRefFromReturnType`). Two
  entries that happen to share a file (a common imported type) invalidate
  together today whenever ANYTHING in that file changes, not just the part
  of it that actually feeds their leaves' resolved types — file-level
  granularity is coarser than the true dependency, and the true dependency
  is a TYPE-level fact TypeScript's checker already computes, not a
  file-level one this cache re-derives from scratch.

**Regression to record**: the per-entry-file granularity introduced by
`25fa9fc` — computing a PRECISE file closure per entry and hashing every
file in it — is superseded here as a cache-_key_ design, not removed as a
mechanism. §2 keeps Tier 1's file-closure gate (reachability computation and
all) as a cheap "could anything have changed" pre-filter; what changes is
that a Tier-1 MISS no longer directly implies "re-emit," it implies "go
compute the precise, leaf-level answer." Filed here because this is exactly
the class of mistake CLAUDE.md's coupling rules name: **file layout was
privileged as cache architecture** — the cache's correctness/granularity was
allowed to ride on how source happens to be organized into files, rather
than on the semantic unit (a leaf's resolved type) the cached artifact is
actually a function of.

## 2. Two tiers

### Tier 1 — whole-closure file gate (kept, unchanged mechanism, changed role)

Exactly today's `checkCache` mechanism: `reachability.ts`'s
`computeEntryClosures` file set, `711dfbb4`'s stat-before-hash tiering,
`63ebb35`'s `tsVersion`/`typeIrVersion`/`outputHash` toolchain/output
signals. Answers one question only: **"could any leaf's resolved type
possibly have moved, at all, since the last successful build of this
entry?"**

- **Hit** (every tracked file's stat, or content hash on a stat mismatch,
  matches the recorded value; toolchain versions unchanged; `outFile` bytes
  unchanged) → **done, no `ts.Program` built.** This is the fast path that
  makes a fully-warm run cheap — unchanged from today's behavior and
  today's measured cost (~5ms/entry warm-check, `711dfbb4`'s doc block).
- **Miss** (anything in the file closure changed, INCLUDING a
  comment/implementation-only edit — Tier 1 cannot tell those apart, by
  design; it is a file-content gate, not a type gate) → fall through to
  Tier 2. A miss here is strictly a "go find out precisely" signal, never
  itself a re-emit decision.

Tier 1 is retained (not replaced by hashing IR from scratch every run)
because it is what avoids building a `ts.Program` at all on a fully warm
run — the multi-GB cost the whole cache exists to dodge (`cache.ts`'s own
module doc, lines 3–11). Tier 2 cannot answer its question without a
`Program`; skipping straight to Tier 2 on every run would mean paying that
cost unconditionally, defeating the cache's own reason to exist.

### Tier 2 — leaf-level IR fingerprint (new — this spec's core change)

Runs only on a Tier-1 miss. One shared `ts.Program` is built for the
closure (today's `createExtractorProgram`/caller-supplied-Program path,
unchanged) and `extractRouteTypeRefs`'s existing walk (`tree.ts`) is run
once to get every leaf's `{path, input: TypeRef, output: TypeRef}` — this
is not new extraction machinery, it is the SAME extraction
`buildValidatorModuleSource`/`buildSchemaModuleSource` already run on a
miss today; the only new step is fingerprinting each leaf's IR and diffing
against the previously recorded per-leaf fingerprints before deciding what
to re-emit:

1. For each leaf path in the entry, compute `fingerprint = sha256(canonical
JSON of {input, output})` (canonicalization requirement discharged by
   §6's determinism check — no further canonicalization needed for the
   TypeRef shape as it exists today, see §6 for the precise scope of that
   finding).
2. Compare against the fingerprint recorded for that same leaf path at the
   last successful build (v3 cache metadata, §7).
3. **Only leaves whose fingerprint changed are re-emitted** into the
   output artifact; every other leaf's previously-generated code is carried
   forward unchanged into the new `outFile` (mechanically: `build.ts`'s
   `compileValidatorModule`/`schema-build.ts`'s schema-module builder already
   iterate leaf-by-leaf to produce the final module source — the change is
   which leaves that iteration re-derives from a fresh TypeRef vs. reuses
   from the prior cache record's stored per-leaf artifact fragment; §9 flags
   this as the one piece of implementation mechanics this spec does not
   fully prescribe).
4. Tier 1's file closure and stat/hash records are rewritten to the new
   state regardless (so the NEXT run's Tier-1 gate is accurate), independent
   of how many leaves' fingerprints actually changed.

**Test scenario this makes correct** (record as a required test case for
the implementation, not yet run — no v3 code exists to run it against):
a comment-only or implementation-only edit inside one leaf's handler body,
in an entry with N≥2 leaves, must (a) trigger a Tier-1 miss (file content
changed) and (b) result in a Tier-2 pass where EVERY leaf's fingerprint is
unchanged, so `outFile` is re-verified but its bytes are byte-identical to
before and nothing is actually re-written to disk (or, if always rewritten
for simplicity, at minimum no leaf's generated CODE differs) — "re-emits
nothing" in the sense that matters: no leaf's generated validator/schema
changes, even though the whole entry took the Tier-2 path.

## 3. Bundled artifacts — rollup fingerprint, one level

An entry's output is typically ONE module bundling MANY leaves (confirmed
by reading `tree.ts`'s `extractRouteTypeRefs`: it returns a
`TypeRefMap`/`TypeRefMapWithDefs` keyed by leaf path, walking one entry's
whole tree in one pass, and `build.ts`'s `buildValidatorModuleSource`
compiles that whole map into one generated module — e.g. a per-subtree
validator module covering every leaf under it, or, in the sibling codebase's batch
caller today, one module per slice covering that slice's whole leaf set).

The bundle's own re-emit key is a rollup over its member leaves' fingerprints:

```
bundleFingerprint = sha256(concat(sorted-by-leaf-path(leafFingerprint_i for i in members)))
```

Sorted by leaf path (not encounter order) so the rollup itself is
insensitive to a member being extracted in a different order across runs —
`tree.ts`'s own walk order is already deterministic (a straightforward
tree traversal), but sorting removes the dependency on that being true
rather than assuming it.

**One rollup level, not recursive Merkle-over-bundles-of-bundles**: a bundle
is a flat set of leaves (per `extractRouteTypeRefs`'s own `TypeRefMap`
shape — no nested bundle-of-bundles structure exists in the extractor
today), so one level of hashing over member fingerprints is the whole
mechanism; there is no deeper tree to roll up through. This is deliberately
NOT the rejected Merkle-over-topology design (§4) — the rollup here is
computed AFTER every member leaf's fingerprint is already known (post
Tier-2 extraction), used only to decide "does this bundle's file need
rewriting at all," not used to PRUNE which leaves get extracted in the
first place. Every leaf in a Tier-1-missed entry is still extracted every
time (Tier 2 has no cheaper way to know a leaf's fingerprint than deriving
it) — the rollup only gates the FILE WRITE, and each leaf's own
fingerprint (not the rollup) gates which leaf's generated CODE gets
recomputed inside the bundle per §2 step 3.

## 4. Explicitly rejected: Merkle-over-topology

Considered and rejected, with the reasoning recorded so it isn't
re-litigated:

- **Interior hashes can't gate extraction.** A Merkle-style design would
  hash each source file (or each syntactic subtree) and roll those hashes
  up the IMPORT graph, letting an unchanged interior subtree's hash prove
  its leaves' IR is unchanged WITHOUT extracting them — the entire point of
  a Merkle structure being to prune work below an unchanged interior node.
  But a leaf's IR hash is only knowable AFTER extraction — extraction is
  what resolves a TYPE (potentially involving generic instantiation, mapped
  types, conditional types, cross-file alias resolution) to a concrete
  TypeRef; there is no cheaper file-content-level computation that yields
  the same answer. An interior file-content hash proves "these bytes are
  unchanged," which Tier 1 already establishes more cheaply (stat, no
  content read at all in the common case) — it does not prove "the TYPES
  this file's checker-visible surface resolves to, transitively, for every
  leaf below it, are unchanged," which is a strictly stronger claim a
  content hash cannot make on its own (a whitespace-only, comment-only,
  or refactor-preserving edit changes the content hash without changing
  any resolved type — exactly the case §1 motivates this whole spec
  around).
- **Sound file-based interior pruning would reintroduce the rejected
  layout-dependence.** The only way to make an INTERIOR (non-leaf) node's
  hash a sound proxy for "no leaf below it changed" is to tie that node to
  a FILE or SET OF FILES and hash their content — which is exactly the
  per-subtree-file-closure design §1 supersedes. There is no
  layout-independent way to define "this subtree's interior hash" that
  doesn't smuggle file organization back in as the unit of invalidation.
- **Local hash comparison at this scale costs nanoseconds; Merkle's payoff
  doesn't exist yet.** At the leaf counts this cache operates over (a
  single entry's leaf count is O(10¹–10²) per the the sibling codebase reference —
  17 slices' worth of routes, not 10⁵+), comparing every leaf's
  fingerprint against its previously recorded value is a flat local loop
  over ~10² sha256-sized strings — negligible next to the `ts.Program`
  build Tier 1 already exists to avoid, and negligible next to Tier 2's
  own extraction cost (which dominates any Tier-2 run regardless of
  fingerprint-comparison strategy, since extraction, not comparison, is
  what's expensive). Merkle's actual value proposition — pruning WORK by
  trusting an interior hash without descending below it — doesn't apply
  here because (as above) there is no sound interior hash cheaper than
  extraction itself.
- **Merkle's build cost is strictly additive, and its payoff is a
  transmission/trust-boundary concern not in sight.** Building and
  maintaining a Merkle tree (interior node hashing, tree-shape bookkeeping,
  proof generation/verification if inclusion proofs are ever wanted) costs
  MORE than a flat per-leaf fingerprint comparison for every property this
  cache currently needs. Its actual payoff — verifying a subtree's
  integrity WITHOUT re-deriving every leaf, e.g. across a network/trust
  boundary (a remote artifact store, a CI cache shared across untrusted
  machines, inclusion proofs a consumer can verify without downloading the
  whole tree) — has no consumer in this codebase today: this cache is a
  local, single-process, single-trust-domain build artifact, not a
  distributed store. If a remote/shared artifact store or a
  cross-trust-boundary transmission need appears later, Merkle becomes
  worth revisiting on its own merits at that point — not something to
  build speculatively now.

## 5. Cache key composition (v3 metadata shape, sketch)

Not a full implementation, but the shape §2–§4 imply, to anchor §7's
migration discussion:

```ts
type CacheFileShapeV3 = {
  readonly version: 3;
  readonly tsVersion: string;
  readonly typeIrVersion: string;
  readonly entryFile: string;
  // Tier 1 — unchanged from v2's `files`, still the whole-closure gate.
  readonly files: Record<string, TrackedFileEntry>;
  // Tier 2 — new: one fingerprint per leaf path, keyed the same way
  // extractRouteTypeRefs's own TypeRefMap already keys leaves.
  readonly leafFingerprints: Record<string, string>;
  // Rollup over leafFingerprints, sorted by leaf path (§3) — lets a v3
  // consumer short-circuit "did the bundle change at all" without
  // recomputing every member comparison, though nothing in this spec
  // requires that as a distinct fast path beyond the per-leaf compare.
  readonly bundleFingerprint: string;
  readonly outputHash: string;
};
```

`outputHash` is kept (same role as v2: catches `outFile` being hand-edited
or clobbered outside the codegen pipeline) — Tier 2's per-leaf
fingerprinting does not replace that check, it only changes what happens
on a Tier-1 miss.

## 6. `[verify]` findings — empirically checked this session

Both items the task named as load-bearing were checked against real
`extract.ts`/`from-typescript.ts` code, in a throwaway fixture (created and
deleted within `packages/api-tree/src/__scratch_verify__/`, not committed —
`entry.ts` importing `types.ts`'s `Widget` interface, one `op` returning
it), not reasoned about from memory.

### IR fingerprint determinism — CONFIRMED, byte-stable as-is

Method: built two INDEPENDENT fresh `ts.Program`s (via
`createExtractorProgram`, the same factory each cached-build caller
(build.ts, schema-build.ts, cli.ts) uses as its default Program constructor)
over the identical fixture source, ran `typeRefFromFunctionNode` +
`typeRefFromReturnType` against each, `JSON.stringify`'d both results, and
compared byte-for-byte.

Result: **identical**, both runs:

```
{"input":{"shape":{"kind":"object","fields":{"id":{"shape":{"kind":"string"},"meta":{}}}},"meta":{}},"output":{"shape":{"kind":"object","fields":{"id":{"shape":{"kind":"string"},"meta":{"readonly":true}},"label":{"shape":{"kind":"string"},"meta":{"readonly":true}},"count":{"shape":{"kind":"number"},"meta":{"readonly":true}}}},"meta":{}}}
```

Why this holds, read against `type-ir/src/index.ts`'s `TypeRef` shape: a
`TypeRef` (`{shape, meta}`) is a plain nested object of primitives and
other `TypeRef`s — no symbol identities, no per-run counters, no absolute
IDs anywhere in the shape (confirmed by reading `TypeKinds` — every field is
a primitive, a nested `TypeRef`, or a `readonly` array/`Record` of them).
`object.fields`/`interface.methods` are `Record<string, TypeRef>`, and
their JS key insertion order comes from the checker's property-iteration
order for a given type, which is itself derived from source DECLARATION
order — deterministic for a given source text, not from run-to-run
allocation or hashing. **No canonicalization pass is needed for this
shape as it stands** — no sorted-keys pass, no ID stripping, no path
relativization was required to get byte-stability in this check.

Scope of this finding, stated precisely (not overclaimed): checked against
a 3-field object leaf with no cross-file structural SHARING (no
`SharingRegistry` passed — `extractRouteTypeRefs`'s `shouldShare` path,
which introduces `defs`/`ref` naming via `uniqueRegistryName`, was NOT
exercised in this check). `uniqueRegistryName`'s naming is base-name-derived
(not an encounter-order counter for the non-colliding case, per reading
`from-typescript.ts`), so it is EXPECTED to be similarly deterministic, but
this was not independently re-verified against a scratch repro exercising
the sharing path — flagged as an implementation-time re-check, not asserted
as proven here. Absolute file paths were not present anywhere in the
checked output (`typeName`/`declarationFile` meta keys are populated by
`typeProvenanceOf` only for a NAMED top-level type — the fixture's `input`
was an inline object literal, so that path wasn't exercised either);
`declarationFile`-carrying meta, if present in a leaf's real IR, is an
ABSOLUTE path by construction (`extract.ts`'s `typeProvenanceOf` reads
`decl.getSourceFile().fileName>`, which `ts.Program` resolves to an
absolute path) — stable ACROSS two runs on the same checkout (both runs
resolve the same absolute path), but NOT portable across checkouts at
different filesystem locations (two clones of the same repo at different
absolute paths would fingerprint differently for a leaf whose type
provenance is tracked). This is a real, narrower caveat than full
byte-stability — recorded as an open scope note, not silently assumed
away: **if cache portability across machines/checkout paths is ever wanted,
`declarationFile`/similar absolute-path meta needs relativization before
fingerprinting; not needed for this cache's actual deployment shape today
(a single checkout, cache metadata alongside the output, never shipped
across machines).**

### IR locality — CONFIRMED, both directions

Same fixture. Two edits, checked independently against the determinism
baseline above:

1. **Implementation-only edit** (rewrote the handler body: replaced the
   returned literal, added a local variable, changed and lengthened the
   comment) — re-extracted IR compared **byte-identical** to the baseline.
   Confirms an implementation/comment-only change does NOT perturb a
   leaf's IR.
2. **Transitively-imported type change** (added a `newField: boolean`
   member to `Widget`, declared in the separate imported `types.ts`, with
   the handler body left untouched) — re-extracted IR **differed**,
   correctly gaining the new field:
   `"newField":{"shape":{"kind":"boolean"},"meta":{"readonly":true}}}`
   appended to the `output` object's `fields`. Confirms a type change
   reached only through an import IS correctly reflected.

Together these confirm Tier 2's central correctness claim: leaf IR
fingerprinting is sensitive to exactly the right thing (resolved type
shape, reachable transitively through imports) and insensitive to exactly
the right thing (implementation/comment text in the same file) — the
property Tier 1's file-content gate structurally cannot have, since a file
hash cannot distinguish the two edit kinds.

## 7. Interaction with the consumer's single-composed-tree direction

Named by the task as an open direction, not yet reflected in this repo's
own design docs (no doc under `docs/design/` was found describing it during
this pass — recorded here as owner-stated forward context, not as an
already-certified consumer decision): the sibling codebase's `codegen-fractal-validators.ts`
today builds one shared multi-root `ts.Program` across 17 slice-entry
files; a direction under consideration collapses that to ONE entry
tree/file for the whole batch.

Under this spec, that collapse changes Tier 1's SHAPE but not Tier 2's:

- **Tier 1 becomes one closure.** With one entry, there is exactly one
  file-closure gate to check instead of 17 (or 34, counting both
  validator and schema artifacts) — a single stat-tiered pass over the
  union of every file any leaf anywhere in the tree reaches. A miss on
  ANY file anywhere in that closure (which, for one combined entry, is
  effectively every file the whole batch touches) means Tier 1 can no
  longer discriminate "which slice" the way today's PER-SLICE entries do
  — every edit anywhere trips the one Tier-1 gate.
- **Tier 2 does all the precision work.** This is exactly why Tier 2
  exists rather than being an optional refinement: once Tier 1 stops being
  able to discriminate at slice granularity (single combined entry), the
  ENTIRE "did anything actually need re-emitting" question falls on
  per-leaf fingerprint comparison. A single-tree consumer with N leaves
  across all slices behaves, from Tier 2's perspective, identically to
  today's 17-entry batch with N total leaves summed — Tier 2 was already
  designed at leaf granularity (§2), independent of how many Tier-1-level
  "entries" the leaves are grouped into. The single-tree direction doesn't
  require a Tier-2 redesign; it just makes Tier 2 carry proportionally
  more of the invalidation precision, since Tier 1 carries less.
- **Bundle boundaries (§3) become the open question this collapse raises**
  — if there is one entry tree, does §3's bundle unit stay per-subtree (one
  generated module per domain slice, as today), become per-branch, or
  collapse to one bundle for the whole tree? This is NOT decided by this
  spec — see §9's open question to the owner. What IS certain regardless
  of that answer: each bundle's re-emit key is still the §3 rollup over
  its OWN member leaves' fingerprints, whatever set of leaves ends up
  inside a bundle.

## 8. Migration path: v2 → v3, extraction failure

- **Format bump, invalidate-all.** v3's cache file shape (§5) is not
  backward-read-compatible with v2 (`leafFingerprints`/`bundleFingerprint`
  don't exist in a v2 file). `checkCache`'s existing `meta.version !== 2`
  check (line 274) already treats a version mismatch as an unconditional
  miss — the identical mechanism extends to `meta.version !== 3` under v3,
  with `version: 3` recorded going forward. No migration/upcast path for
  existing v2 cache files is needed or proposed: every existing v2 cache
  entry simply misses once under v3 and gets rebuilt with the new shape,
  which is the same "changed cache format → treat as cold" behavior this
  cache has ALREADY exercised at least once (v1 → v2, implied by `version:
2`'s own existence as a literal in `CacheFileShape`) — not a new kind of
  event for this cache to handle.
- **Extraction errors: fail loud, no cache write.** If Tier 2's extraction
  step throws (a type the checker cannot resolve in a way
  `typeRefFromFunctionNode`/`typeRefFromReturnType` handles — read
  directly, `extract.ts` today PUNTS rather than throws for most
  unresolvable shapes via `puntRef`'s `$comment`-tagged `unknown`, so an
  actual throw would come from something outside that punting path, e.g.
  a compiler-internal exception, an out-of-memory condition building the
  `Program`, or a bug in the extractor itself) — the build must fail
  loudly (propagate the exception to the caller, matching each cached-build
  caller's existing un-caught-exception behavior — `build.ts` read directly:
  nothing in the hand-inlined checkCache → build → writeCacheMetadata
  sequence today swallows an exception from `build(program)`) and MUST NOT
  write cache metadata for that entry. A
  partial/corrupt `leafFingerprints` map recorded from a failed run would
  be WORSE than no cache file at all — a subsequent run would compare
  against fingerprints for leaves that were never actually validated
  against a successfully-compiled output, silently treating a stale or
  wrong artifact as current. This is the same reasoning `writeCacheMetadata`
  already embodies structurally today (it's only ever called AFTER
  `build(program)` returns successfully, never before or
  independent of it) — this spec states the extraction-failure case
  explicitly because Tier 2 introduces a NEW opportunity to fail mid-way
  through a MULTI-leaf entry (leaf 3 of 20 throws) where a naive
  implementation might be tempted to write partial results for the 2
  leaves that succeeded; that partial-write path is explicitly rejected
  here — one entry's cache write is all-or-nothing, exactly like v2's
  today.

## 9. Open questions for the owner

- **Where do bundle boundaries (§3) live once the consumer has one tree
  (§7)?** Per-subtree modules (today's shape, just re-rooted under one
  entry), per-branch, or one bundle for the whole tree? This spec fixes
  the ROLLUP MECHANISM (§3) for whatever the bundle unit turns out to be,
  not the unit itself — it's a codegen-output-shape decision (how many
  files does a consumer want to `import`, how much does one file's diff
  churn if it bundles everything) orthogonal to the cache-key design this
  spec settles.
- **Should Tier-2 fingerprints ALSO gate the AOT validator COMPILE step
  separately from module EMISSION?** `build.ts`'s pipeline today is
  extract → `compileValidatorModule` (AOT check/errors/parse codegen) →
  write. This spec (§2 step 3) treats "compile" and "emit" as one
  re-derive-or-carry-forward unit per leaf — a changed leaf fingerprint
  triggers BOTH a recompile and a re-emit for that leaf, an unchanged one
  carries forward the FULL previously-generated code fragment (not just
  the previously-written bytes). An alternative: cache the compiled
  fragment SEPARATELY from the emission decision, so (hypothetically) a
  fingerprint-unchanged leaf skips recompilation but something else about
  emission (an unrelated header/import-list change in the bundle) still
  forces a rewrite of that leaf's ALREADY-compiled fragment into the new
  file — a finer-grained two-stage cache inside Tier 2. Not designed here;
  flagged because the owner's phrasing ("whether tier-2 fingerprints should
  ALSO gate the AOT validator compile step separately from module
  emission") names it as a live question, not something this spec's §2
  silently forecloses by picking the single-stage version.

## 10. Regression checklist

Any future edit to this spec, or its implementation, MUST NOT reintroduce:

1. **File layout privileged as cache architecture.** The §1-named
   regression: a cache key/granularity design that ties invalidation to
   which FILE a piece of source lives in, rather than to the semantic unit
   (a leaf's resolved input/output type) the cached artifact is actually a
   function of. `25fa9fc`'s per-entry file-closure precision stays as
   Tier 1's cheap pre-filter (§2) — reintroducing it as the sole or final
   invalidation signal (skipping Tier 2 entirely on a Tier-1 miss) is the
   regression this whole spec exists to fix.
2. **Re-emitting a whole entry/bundle on any file-closure miss, without a
   per-leaf fingerprint check.** Defeats §2 Tier 2's entire purpose — a
   Tier-1 miss must fall through to per-leaf comparison, never straight to
   "rebuild everything," or the comment/implementation-only-edit case §1
   and §6 exist to fix regresses silently.
3. **A Merkle-over-topology redesign**, or any interior-file-hash scheme
   used to PRUNE which leaves get extracted on a Tier-1 miss, without a new,
   named consumer need that crosses a transmission/trust boundary (§4).
   Re-litigating this without such a need ignores the recorded reasoning:
   no sound interior hash exists that's cheaper than extraction itself.
4. **Scattered/partial cache writes on a mid-entry extraction failure.**
   §8's fail-loud-no-write rule — a partially-populated `leafFingerprints`
   map from a failed build is worse than no cache file; a future
   "optimization" that writes per-leaf results incrementally as they
   succeed, without gating the whole entry's write on the WHOLE entry's
   extraction succeeding, reintroduces the exact staleness hazard §8 rules
   out.
5. **Treating §6's determinism finding as unconditionally proven beyond its
   checked scope.** The empirical check (§6) covered an inline-object leaf
   with no `SharingRegistry`/`defs` path and no named-type provenance
   (`declarationFile`) in its output. A future change that starts exercising
   `extractRouteTypeRefs`'s `shouldShare` path, or a leaf carrying
   `typeName`/`declarationFile` meta, for Tier-2 fingerprinting MUST
   re-verify determinism (registry naming stability) and address the
   absolute-path portability caveat (§6) BEFORE relying on byte-stable
   fingerprints there — not assume §6's finding covers it by extension.
6. **A cache-format version bump without invalidating old-format entries.**
   §8's v2→v3 rule (any `meta.version` mismatch is an unconditional miss)
   must hold for any future version bump too — a partial-read/upgrade path
   that tries to interpret an old-shape cache file under new-shape logic
   reintroduces a correctness hazard for a cost (avoiding one cold rebuild
   per entry, once, on upgrade) this cache has never needed to pay before.
