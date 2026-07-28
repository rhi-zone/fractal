# Grouping and generalization as separate pluggable layers

**Status.** Design, plus one small implemented change (§6). The larger refactor is
specified but **not** built, for reasons in §1 — the motivating premise turned out to be
factually wrong about the current code, and the remaining delta is much smaller than a
rewrite.

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

## 3. The two interfaces

```ts
/** Which occurrences count as one position. Consumes accumulated evidence. */
export interface Grouping {
  /** Split an object-typed position into variants, or return undefined to keep it whole. */
  partition?(node: EvidenceNode, ctx: GroupingContext): readonly Partition[] | undefined

  /** Choose how an array position is grouped: one shared element position, or per-index. */
  arrayGrouping?(node: EvidenceNode, ctx: GroupingContext): "element" | "perIndex"

  /**
   * Identity of an embedded object, for deduplication. Occurrences whose enclosing
   * entity has the same key count once. Returning undefined means "every occurrence is
   * its own observation" (today's behaviour).
   *
   * NOT derivable from the data — see inference-theory.md §6.11. Whatever this returns
   * encodes a declared unit of observation.
   */
  entityKey?(value: unknown, ctx: GroupingContext): string | undefined
}

export interface GroupingContext {
  readonly path: readonly (string | number)[]
  readonly depth: number
  readonly corpusSize: number
}

/** One variant produced by a partition, with the occurrence indices it owns. */
export interface Partition {
  readonly label?: string
  readonly memberIndices: readonly number[]
  /** The field whose value induced the split, when there was one. */
  readonly discriminant?: string
}

/** Given evidence at an already-grouped position, decide what type to emit. */
export interface Generalization {
  decide(ev: PositionEvidence, ctx: GroupingContext): TypeRef | undefined
}

/** The evidence a generalization policy is allowed to see. Deliberately narrow. */
export interface PositionEvidence {
  readonly n: number            // occurrences (N)
  readonly distinct: number     // distinct values (K)
  readonly singletons: number   // values seen exactly once (n1) — the coverage estimate
  readonly nullCount: number
  readonly typeCounts: Readonly<Record<string, number>>
  readonly distinctValues: ReadonlySet<string>
  readonly sortedNumeric: readonly number[]
  /** The mechanically-merged type, before any generalization policy runs. */
  readonly literalType: TypeRef
}
```

`PositionEvidence` deliberately exposes `singletons`, which the current `EvidenceNode` does
not carry. That is the one field addition the refactor requires, and it is what makes the
`inference-theory.md` §6.10 coverage estimate (`1 − n₁/N`) expressible as a policy rather
than needing a separate pass.

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

## 6. Implemented now

`enumMaxMembers` (`from-json-corpus.ts`), default 50, previously the hardcoded
`if (K > 50) return false` in `looksLikeEnum`. Zero behaviour change; five new tests pin both
the default and its overridability.

This is small but it is the exact defect `inference-theory.md` §6.6–6.7 derived: a cut on `K`
alone cannot separate memorization from genuine restriction, because the evidence is in the
ratio. The default rejects a 60-value vocabulary observed 6000 times (`K/N = 0.01`,
unambiguous) purely for exceeding the cap. The cap is now documented as an output-size guard
rather than an evidence test, and is swappable — including `Infinity` to disable it.

The rest of the refactor is deliberately **not** built in this pass. The interfaces above are
additive and can land incrementally behind the existing `ResolveStrategy`; doing it as one
rewrite against 192 passing tests, for an architecture whose main claimed benefit turned out
to already exist, is not a good trade.

## 7. Open, and blocking

- **Entity key / unit of observation.** Blocks the Good–Turing default. Not derivable
  (§6.11); needs a caller-facing declaration.
- **Coverage bar.** No principled value; the optimal ratio cutoff is a function of it.
- **`clusteringMethod` default.** Unresolved; no method dominates across corpus shapes.
- **Array grouping criterion.** §13's rule did not replicate on this repo's corpora (§17.1).
