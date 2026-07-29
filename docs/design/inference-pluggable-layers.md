# Grouping and generalization as separate pluggable layers

**Status.** **Implemented.** `Grouping` / `Generalization` / `Stage` / `perPosition` /
`defaultStages` / `resolvedStrategy` all ship in `from-json-corpus.ts`, and `resolveEvidence`
is now a driver over the stage pipeline. Behaviour-preserving: the whole package went from
4482 to 4493 passing tests with no test changed to accommodate the refactor. §1–2 record two
corrections to the original brief that survived implementation; §7 records the one place the
design as written was wrong and had to change.

Companion to `inference-theory.md`, which supplies the policy content this document only
provides seams for.

---

## 1. Correction: the fused single pass already exists

The brief proposed fusing `from-json.ts` and `from-json-corpus.ts` because they "walk each
record's tree independently, then run a separate merge/generalization pass across all the
per-record results afterward," building N complete per-record trees. **That is not what the
code does**, and the correction matters because it removes most of the motivation for the
rewrite.

`collectEvidence` → `buildEvidenceNode` (`from-json-corpus.ts:253`) takes *all* values at a
position at once and folds them into a single `EvidenceNode` — counts, distinct-value sets,
per-field sub-evidence, per-index and index-agnostic array buckets. There is one accumulator
per tree position, not one tree per record. The architecture is already:

```
phase 1  collectEvidence   mechanical, no decisions, single accumulating pass
phase 2  resolveEvidence   every heuristic, behind ResolveStrategy
```

which is the fixed-mechanics / pluggable-policy split the brief asked for. `fromJson` is
called per-record only in three specific phase-2 paths that genuinely need per-value
re-inference (dirty-data detection, DU variant construction, root union resolution).

Merging the two *files* is also not indicated: `from-json.ts` is 217 lines of single-value
leaf inference (string-format detection, integer narrowing) and is imported independently by
`from-standard-schema.ts`. It is a leaf-typing library, not half of a two-pass pipeline.

**What is genuinely missing is the separation the brief identified**: grouping and
generalization are tangled together inside `resolveEvidence`, sharing one flat
`ResolveStrategy` bag of ~17 booleans and numbers. That is worth fixing on its own terms.

## 2. Correction: grouping cannot run before evidence accumulates

The brief places grouping "before any evidence even accumulates." Two of its three cases
cannot work that way:

- **DU splitting** needs the discriminant field's value distribution across the whole
  corpus. Record 1 cannot be assigned to a variant before record N is seen.
- **Entity identity** is inherently cross-record — §6.11 of `inference-theory.md` shows it
  needs comparison against all other candidate entities, and is undecidable from values
  alone regardless.
- **Tuple-vs-array** is the one case that *is* decidable per-position without cross-record
  evidence, and even it depends on the length distribution across records.

The existing design handles this correctly and should be preserved: phase 1 collects
evidence **under every candidate grouping simultaneously** — `array.element` (index-agnostic)
*and* `array.perIndex` (index-sensitive), plus `object.keySets` and `array.elementObjects`
for clustering — and defers the choice to phase 2. Gathering under all groupings and
selecting later is strictly more capable than committing during the walk.

So grouping is a **pluggable decision that consumes accumulated evidence**, not a pre-pass.

## 3. The two interfaces (as built)

```ts
export interface StageContext {
  readonly corpusSize: number
  readonly strategy: ResolvedStrategy
}

/** A stage that decides which occurrences constitute one position. */
export interface Grouping {
  readonly name: string
  apply(ref: TypeRef, node: EvidenceNode, ctx: StageContext): TypeRef
}

/** A stage that decides what type an already-grouped position emits. */
export interface Generalization {
  readonly name: string
  apply(ref: TypeRef, node: EvidenceNode, ctx: StageContext): TypeRef
}

/** One entry in the pipeline, tagged with which kind of judgment it makes. */
export type Stage =
  | { readonly kind: "grouping"; readonly step: Grouping }
  | { readonly kind: "generalization"; readonly step: Generalization }

/** Lift a per-position decision into a whole-tree stage, supplying the traversal. */
export function perPosition(
  fn: (ref: TypeRef, node: EvidenceNode,
       ctx: StageContext & { path: readonly (string | number)[] }) => TypeRef,
): (ref: TypeRef, node: EvidenceNode, ctx: StageContext) => TypeRef

export function defaultStages(resolved: ResolvedStrategy): Stage[]
export function resolvedStrategy(s?: ResolveStrategy, cfg?: CorpusInferConfig): ResolvedStrategy
```

`EvidenceNode` gained one field, `singletons` (Good–Turing's n₁), computed in phase 1. That
is what makes the `inference-theory.md` §6.10 coverage estimate (`1 − n₁/N`) expressible as a
policy instead of a separate pass — there is a test showing a working coverage-based
generalization built on it.

`ResolveStrategy.stages` overrides the pipeline wholesale. `resolvedStrategy()` returns the
fully-defaulted strategy so callers can start from `defaultStages(...)` and filter or splice
rather than reconstructing.

## 4. How the walk invokes them

```
resolve(node, ctx):
    grouping.entityKey?  ->  collapse occurrences sharing an entity key
    grouping.partition?  ->  if it splits, recurse per partition and union the results
    grouping.arrayGrouping?  ->  pick element vs perIndex evidence for array children
    recurse into children
    generalization.decide(evidenceOf(node), ctx)  ->  emitted type, or undefined to keep
                                                       the mechanically-merged literal type
```

Phase 1 is untouched. Phase 2 becomes a thin driver over two named interfaces instead of a
17-field strategy bag. The existing `ResolveStrategy` becomes the constructor argument of
the *default* implementations, so every current caller keeps working unchanged.

## 5. Defaults — settled vs. provisional

**Settled** (mechanics, not policy): phase 1's accumulating walk; collecting evidence under
all candidate groupings; deferring the grouping choice; `fromJson`'s leaf typing.

**Default grouping — reasonable, some parts provisional:**

| decision | default | status |
|---|---|---|
| array grouping | `element` unless lengths are near-constant and per-index types disagree | provisional — `inference-theory.md` §13 gives the criterion, §17.1 shows it did not replicate on this repo's corpora |
| object partition | `defaultDetectDU` → `defaultDetectDict` → `defaultDetectCfd` → `defaultSplitObjects`, each a swappable `Group` | settled as behaviour; `clusteringMethod` remains an open call (no method dominates) |
| entity key | `undefined` — every occurrence is its own observation | **provisional and known-wrong for API payloads.** §17.2 measured 50 PRs embedding one repo. §6.11 shows the correct key is not derivable; it must be declared. |

**Default generalization — SHIPPED, and it is the session's finding rather than the old
heuristic.** The decision **returns a type**: `ResolveStrategy.generalize: Generalize`, where

```ts
type Generalize = (ctx: PositionContext) => TypeRef | undefined
```

`undefined` means "no opinion" — the merged type stands and traversal continues into
children; a `TypeRef` commits the position and its children are left alone. `PositionContext`
carries `distinct` (K), `occurrences` (N), `singletons` (n₁), `distinctValues`, the parsed
`members`, `sortedNumeric`, the `path` from the root, the merged `ref`, the full `node`, and
the resolved `strategy`.

A yes/no rule is the degenerate case, `cond ? defaultGeneralize(c) : undefined`. Returning a
type is strictly more general, and lets a caller construct what the built-ins never would:

```ts
// a branded scalar rather than an enum
const branded: Generalize = (c) =>
  c.path.at(-1) === "status" ? t(types.string, { format: "x-status-code" }) : undefined
// a union structure with no built-in equivalent
const nullable: Generalize = (c) =>
  t(types.union([t(types.enum(nonNullMembers(c))), t(types.null)]))
// commit a whole subtree, skipping its children
const collapse: Generalize = (c) =>
  c.path.join(".") === "user" ? t(types.map(t(types.string), t(types.unknown))) : undefined
```

`defaultGeneralize` is the built-in, and `defaultEnumPredicate` remains exported so a caller
can reuse the evidence test without its construction. The four numeric knobs are **parameters
of that default**, not the only way to influence the outcome:

```
K === 1              -> literal, once N >= literalMinSamples      (unchanged)
K >= N               -> never a bounded vocabulary                (unchanged; held everywhere)
K > enumMaxMembers   -> reject; output-size guard, not evidence   (default 50)
K/N >= enumMaxRatio  -> reject; the DUPLICATION GUARD             (default 0.5)
1 - n1/N >= enumCoverageBar -> ACCEPT; the EVIDENCE TERM          (default 0.9)
```

The conjunction is the point. Neither term is sound alone:

- `1 − n₁/N` is the well-calibrated one — median absolute error 0.011 against held-out
  coverage over 41 real fields, ρ = 0.991 (`inference-theory.md` §6.10) — but it **inverts**
  under duplication, since every count becomes ≥ 2, `n₁` collapses to 0 and coverage reads a
  spurious 1.0 (§6.8).
- `K/N` is the robust one: under a duplication factor `r` it falls as `(K/N)/r`, degrading
  gracefully instead of inverting.

**This is the concrete answer to whether the unresolved entity-key question blocks the
coverage default: it blocks the coverage term *alone*, not the conjunction.** Verified on the
duplication construction — 1000 all-distinct values copied `r` times, which every rule should
reject:

```
r      K/N     1-n1/N    coverage alone    coverage AND K/N<0.5
1     1.000     0.000        reject               reject
2     0.500     1.000        ACCEPT (wrong)       reject
3     0.333     1.000        ACCEPT (wrong)       ACCEPT (wrong)
```

The conjunction survives exactly as long as the `K/N` term does, and adds a calibrated
estimate on top. It is not immune — nothing is, per §6.8 — but it is strictly no worse than
the guard alone, and measurably better on clean data (npm, n=61): 98.4% vs 82.0% for the old
rule at a 50% coverage bar, 96.7% vs 82.0% at 90%.

`enumCoverageBar` defaults to **0.9**, deliberately conservative: for codegen a wrong enum is
a runtime failure. §6.10 shows the "right" `K/N` cutoff is a function of this bar (0.19 at
90%, 0.535 at 50%), so any fixed ratio silently encodes one — naming it makes the choice
visible and swappable.

## 6. Behaviour that changed, and why

The refactor is not behaviour-preserving, by design — preserving heuristics this session had
already shown wrong was never the goal. Four test groups changed:

- **Strings in the 1/3–1/2 band now become enums.** The old rule could only clear that band
  via integer clustering, so a string field could never qualify there regardless of evidence.
  `a,b,c` over 8 samples (3/3/2, zero singletons, coverage 1.0) is now an enum. The asymmetry
  was an artifact of the escape hatch being integer-only.
- **`K <= range/2` integer clustering is gone.** It rejected `1,2,3,4` each seen 2–3 times,
  which is a bounded set by any reading, and had no empirical support.
- **CFD-discriminant tests now set their precondition explicitly.** They exist to exercise the
  fallback for discriminants the enum pass *declines* to type; they previously reached that
  state by accident, via the string/integer asymmetry above. Under the new default the same
  corpus types `tag` as an enum and `tryDetectDU` recovers a 4-variant union with a real
  discriminator — strictly better, and now pinned by its own test.
- **A superseded eval finding.** The harness had recorded that zipfian skew *improved*
  enum-detection F1 at small N, and a second test recorded that this "gain" was an illusion
  hiding silently-dropped rare members. The coverage rule closes that gap at the source: rare
  members are exactly the singletons the Good–Turing term measures, so skew now reduces
  estimated coverage instead of flattering the ratio. The spurious advantage is gone
  (meanDiff −0.075, p = 0.47, no longer significant) while the real member-fidelity cost
  remains (−0.052, p = 0.001) — the two axes now agree in sign instead of contradicting.

## 6a. Also implemented

`enumMaxMembers` (`from-json-corpus.ts`), default 50, previously the hardcoded
`if (K > 50) return false` in `looksLikeEnum`. Zero behaviour change; five new tests pin both
the default and its overridability.

This is small but it is the exact defect `inference-theory.md` §6.6–6.7 derived: a cut on `K`
alone cannot separate memorization from genuine restriction, because the evidence is in the
ratio. The default rejects a 60-value vocabulary observed 6000 times (`K/N = 0.01`,
unambiguous) purely for exceeding the cap. The cap is now documented as an output-size guard
rather than an evidence test, and is swappable — including `Infinity` to disable it.

## 6b. Grouping decisions are functions too

Same treatment as `Generalize`, applied to the four grouping passes:

```ts
interface GroupingContext extends PositionContext {
  readonly samples: readonly Record<string, unknown>[]   // raw objects here
  readonly corpusSize: number
}
type Group = (ctx: GroupingContext) => TypeRef | undefined
```

Four named instantiation points — `duGrouping`, `dictGrouping`, `cfdGrouping`,
`splitGrouping` — defaulting to `defaultDetectDU`, `defaultDetectDict`,
`defaultDetectCfd`, `defaultSplitObjects`. `objectSplitThreshold`, `cfdMinScore`,
`clusteringMethod`, `dictMinSamples` and the rest are read from `ctx.strategy` **inside those
defaults**, so they are parameters of the default rather than the customisation surface.

**Why four points and not one unified `group`.** The built-in ordering is load-bearing: CFD
only acts on positions DU left as plain objects, and structural splitting only sees what
neither resolved. A single hook would erase that precedence, and collapsing the four
whole-tree passes into one per-position cascade would change when children are visited
relative to later passes. This is the concrete structural reason, not caution — the four
share one interface, so it is still one concept with four ordered instantiations.

Extracting `tryDetectDict` out of `walkAndDetectDicts` was needed to give the dict decision
the same per-position shape the other three already had.

## 7. Where the design above was wrong

**Stages are whole-tree transforms, not per-position callbacks.** The first cut of §3
specified `Generalization.decide(ev: PositionEvidence, ctx)` — one call per position. That
does not match the built-ins: every `walkAndX` is a `TypeRef × EvidenceNode → TypeRef`
transform that owns its own recursion, and forcing them into a per-position shape would have
meant rewriting all six rather than relocating them. Worse, the first implementation attempt
silently invoked custom stages **only at the root**, which two tests caught immediately.

Resolved by making the stage contract whole-tree (matching reality) and supplying
`perPosition` as an adapter that provides the traversal for the common case. Policies that
need whole-tree context keep it; policies that are one repeated judgment get the ergonomics
the design intended. `PositionEvidence` was dropped — `EvidenceNode` plus `singletons` already
carries everything it listed, and a parallel type would have been redundant.

**The pipeline does not split into two clean phases.** `walkAndDetectDU` only fires on
positions whose discriminant is already typed as enum/literal, so the enum *generalization*
must precede the DU *grouping*. Grouping by a discriminant requires knowing the discriminant
is low-arity, which is itself a generalization decision. The pipeline is therefore an ordered
list of tagged stages rather than a grouping phase followed by a generalization phase, and a
test pins that reversing the order changes the result.

## 8. Open, and blocking

- **Entity key / unit of observation.** Blocks the Good–Turing default. Not derivable
  (§6.11); needs a caller-facing declaration.
- **Coverage bar.** No principled value; the optimal ratio cutoff is a function of it.
- **`clusteringMethod` default.** Unresolved; no method dominates across corpus shapes.
- **Array grouping criterion.** §13's rule did not replicate on this repo's corpora (§17.1).
