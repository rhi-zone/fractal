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
| object partition | existing DU/CFD/clustering cascade | settled as behaviour; `clusteringMethod` remains an open call (no method dominates) |
| entity key | `undefined` — every occurrence is its own observation | **provisional and known-wrong for API payloads.** §17.2 measured 50 PRs embedding one repo. §6.11 shows the correct key is not derivable; it must be declared. |

**Default generalization — provisional throughout.** The honest default given everything in
§6 of `inference-theory.md`:

1. `K ≥ N` → never a closed vocabulary (settled; the one boundary that held up everywhere).
2. Otherwise rank by `K/N`, and cut at a **declared coverage requirement** rather than a
   fixed constant — §6.10 showed the optimal `K/N` cutoff tracks the required coverage
   near-linearly (0.19 at 90%, 0.535 at 50%), so a bare constant silently encodes an
   undeclared bar.
3. Prefer the Good–Turing estimate `1 − n₁/N` where the corpus is trusted to be an
   independent sample, since it needs no constant and was the only rule stable across
   coverage bars — but it inverts under duplication (§6.8), so it must not be the default
   until the entity-key question above is answered.

Because (3) is blocked on (entity key), the recommended shipping default remains the current
ratio cascade, with the cutoffs *named* rather than inlined. That is what §6 implements.

## 6. Also implemented

`enumMaxMembers` (`from-json-corpus.ts`), default 50, previously the hardcoded
`if (K > 50) return false` in `looksLikeEnum`. Zero behaviour change; five new tests pin both
the default and its overridability.

This is small but it is the exact defect `inference-theory.md` §6.6–6.7 derived: a cut on `K`
alone cannot separate memorization from genuine restriction, because the evidence is in the
ratio. The default rejects a 60-value vocabulary observed 6000 times (`K/N = 0.01`,
unambiguous) purely for exceeding the cap. The cap is now documented as an output-size guard
rather than an evidence test, and is swappable — including `Infinity` to disable it.

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
