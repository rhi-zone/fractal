# Inferring types from JSON data

Sometimes there's no declared schema — only example data. [`docs/guide/ingestion.md`](./ingestion.md)
covers the format-parsing importers (JSON Schema, JTD, Zod, …) — reading a
_declared_ schema and converting it to a `TypeRef`. This page covers the
opposite problem: **guessing** a `TypeRef` from raw JSON values, when no
declared schema exists to parse.

`@rhi-zone/fractal-type-ir` ships two entry points:

- `fromJson(value, config?)` (`from-json.ts`) — infer from a single JSON value.
- `fromJsonCorpus(values, config?)` (`from-json-corpus.ts`) — infer from many
  values, unifying evidence across the corpus.

A third module, `inference-eval.ts`, infers nothing — it measures how good
the other two are, by running inference _backwards_ from a known-good schema
(§3). Both inferrers produce ordinary `TypeRef`s; nothing downstream needs
to know whether a `TypeRef` came from parsing a schema or guessing one.

## 1. Single-value inference — `fromJson`

### The core heuristic

The governing rule, from `from-json.ts`'s module doc: narrow away from a
wide type only when the observed value lands in a subspace that ~0% of the
wide type's inhabitants occupy — a number with zero fractional part, a
string that validates as a UUID. That rarity is the evidence. Two
consequences follow, both enforced in code:

- **Literal types are never inferred.** A literal is a single-inhabitant
  type — zero information gain once the shape is known. `true`/`false` both
  collapse to `boolean` (`inferValue`) — no code path emits `literal(true)`
  from one sample.
- **Integer width narrowing** picks the tightest fixed-width kind covering
  the value, checked tightest-to-widest with unsigned preferred at each
  width: `uint8 [0,255]`, `int8 [-128,127]`, `uint16 [0,65535]`, `int16
[-32768,32767]`, `uint32 [0,4294967295]`, `int32
[-2147483648,2147483647]`, then `uint64`/`int64` by sign for larger safe
  integers. A fractional value never narrows — it stays `number`.

**String format detection** runs four conservative regexes in order, first
match wins: `date` (`^\d{4}-\d{2}-\d{2}$`), `datetime` (ISO 8601 with
optional fraction/offset), `uuid` (canonical 8-4-4-4-12 hex, case
insensitive), `email` (`^[^\s@]+@[^\s@]+\.[^\s@]+$`), `uri`
(`^[a-z][a-z0-9+.-]*://`). Per the module doc: "false negatives (missing a
weird format) are fine; false positives (claiming a date that isn't one)
are not" — hence the conservative patterns.

### Containers

Objects infer field-by-field. Arrays are ambiguous between "fixed tuple" and
"homogeneous list" from one sample, so:

- An **empty array** widens to `array<unknown>`, not an empty tuple — same
  zero-inhabitant reasoning as literals.
- **Arrays of objects** merge structurally (`mergeObjectShapes`) even when
  elements differ — a field in every element is required, in only some is
  `optional: true` — but only once the array has at least `arrayThreshold`
  elements; below that it's a `tuple` of per-element types.
- **Arrays of scalars/other arrays**: homogeneous _and_ `>= arrayThreshold`
  elements → `array<T>`. Otherwise (heterogeneous, or homogeneous but too
  short to be confident it isn't a fixed-arity tuple) → `tuple`.

### `InferConfig`

```ts
export interface InferConfig {
  arrayThreshold?: number; // default: 3
  narrowIntegerWidth?: boolean; // default: true
  detectStringFormats?: boolean; // default: true
  leafHeuristics?: LeafHeuristic[]; // default: []
}
type LeafHeuristic = (value: unknown) => TypeRef | undefined;
```

`leafHeuristics` run in order, at every node (leaves and containers alike),
before the built-ins. First heuristic to return a `TypeRef` wins;
`undefined` falls through — to the next heuristic, then to the built-in
default. Put one first to override a default; append one to extend without
touching default behavior.

### Example

```ts
import { fromJson } from "@rhi-zone/fractal-type-ir/from-json";

fromJson({
  id: 42,
  email: "a@b.com",
  createdAt: "2024-03-01T12:00:00Z",
  tags: ["x", "y", "z"],
});
```

```ts
t(
  types.object({
    id: uint8(),
    email: t(types.string, { format: "email" }),
    createdAt: datetime(),
    tags: t(types.array(t(types.string))),
  }),
);
```

`id: 42` narrows to `uint8`. `email`/`createdAt` hit the format regexes.
`tags` has exactly 3 elements (right at the default `arrayThreshold`) and is
homogeneous, so it infers `array<string>` rather than a 3-tuple.

## 2. Corpus inference — `fromJsonCorpus`

A single sample can't show optionality (a field absent elsewhere), enums (a
string field drawn from a small closed vocabulary), discriminated unions (a
field's shape depending on a sibling tag), or dict-vs-record (fixed field
names vs. dynamically generated keys). All four are accumulation signals —
they only exist once there's more than one sample to compare.

### Two-phase architecture

```
collectEvidence(values, config) -> EvidenceTree -> resolveEvidence(tree, strategy) -> TypeRef
```

- **Phase 1 — `collectEvidence`** is a purely mechanical upward pass: counts,
  buckets, and structurally mirrors the corpus (per-field evidence for
  objects, per-element/per-index evidence for arrays, distinct-value sets,
  per-sample key sets) but makes **no** type-commitment decision.
- **Phase 2 — `resolveEvidence`** reads that evidence tree and makes every
  heuristic decision: structural merge (incl. integer-width widening), enum
  detection, discriminated-union detection, dict-vs-record detection,
  discriminant-free union splitting, and opt-in dirty-data detection. Every
  tunable threshold lives here, behind `ResolveStrategy`.

`fromJsonCorpus(values, config)` runs both phases back to back; `config` is
exactly a `ResolveStrategy` (`CorpusInferConfig` is a back-compat alias).
Passes run in this fixed order over the merged type:

1. Per-value `fromJson`, then pairwise unification (`mergeAll`/`unifyTypes`)
   — same-kind merges structurally, integer widths widen to the tightest
   covering range, incompatible kinds fall back to a union, `null` merges to
   `nullable: true` instead of a union member.
2. Enum detection (`detectEnums`, default `true`).
3. Discriminated-union detection (`detectDiscriminatedUnions`, default `true`).
4. Dict detection (`detectDicts`, default `true`).
5. General structural union splitting (`splitDissimilarObjects`, default
   `true`) — runs _after_ dict detection, so a dict's ever-growing key set
   (which looks exactly as "dissimilar" under Jaccard distance as a genuine
   split) gets first refusal.
6. Dirty-data detection (`detectDirtyData`, default **`false`**).
7. Custom resolvers (`customResolvers`), tried last, at every node.

### Enum detection

`looksLikeEnum(K, N, sortedValues?, literalMinSamples)` combines three
signals, conservative when they disagree:

- **K == 1** (every sample shares one value): true only once `N >=
literalMinSamples` (default **5**, higher than `enumMinSamples` —
  committing to "exactly one value ever" is a stronger claim than a small
  closed set, and a corpus barely past `enumMinSamples` hasn't had much
  chance to show a second value).
- **K >= N**: definitely not an enum. **K > 50**: too many distinct values.
- Otherwise, `ratio = K / N`: `ratio < 1/3` → strongly repetitive, accept.
  `1/3 <= ratio < 0.5` → borderline; for integers, look for corroborating
  clustering (sorted distinct values leave large gaps relative to range:
  `K <= range / 2`) — clustering alone is never sufficient (timestamps
  cluster too), it only corroborates a borderline ratio. `ratio >= 0.5` →
  reject.

Runs once `node.leafCount >= enumMinSamples` (default **3**). K==1 becomes
`literal`; K>1 becomes `enum` (strings) or a union of integer literals.

**Example:** a `status` field with values from `{pending, active, done,
archived}` repeated across 50 samples: K=4, N=50, ratio=0.08 — well under
1/3, detected as `enum([...])`.

### Discriminated-union detection

`tryDetectDU` looks for an already enum-typed (or all-literal-union-typed)
field as a discriminant candidate. For each candidate, the corpus is grouped
by that field's value; the groups' sibling field sets (excluding the
discriminant) are compared pairwise via Jaccard distance (symmetric
difference over union of field names). If any pair exceeds **`> 0.1`**, the
groups become distinct union variants (instead of one optional-everything
record); the union carries `meta.discriminator`. Needs at least 3 elements
to fire at all.

This threshold is much lower than general splitting's `objectSplitThreshold`
(0.5) because a discriminant field has already established the groups are
separate populations — far less field-set disagreement is needed to
corroborate structural distinctness. DU detection fires from an array field
of union-shaped objects, and directly at object-typed positions — a
root-level corpus whose _top-level_ values are themselves union members is a
known gap (documented in `inference-eval.ts`'s test fixtures, §3).

**Example:** a `shapes` array mixing `{kind:"circle",radius}`,
`{kind:"rect",width,height}`, `{kind:"triangle",base,height}`. `kind` is
enum-typed (3 values); sibling field sets are maximally dissimilar, so it
splits into a 3-variant union with `discriminator: "kind"`.

### Dict-vs-record detection

`walkAndDetectDicts` measures key-set growth across samples at a position:
track the running distinct-key count as samples accumulate, compare first
count to last.

```
keyGrowth   = lastCount - firstCount
growthRatio = keyGrowth / sampleCount
```

If **`growthRatio > 0.5`** _and_ `lastCount > commonKeys.size + 2`, the
position is dict-shaped. Requires `dictMinSamples` (default **3**) values
and that many object samples to fire. Keys common to _every_ sample become
fixed record fields (mixed shape: `meta.additionalPropertyType` carries the
dict-entry value type); with no stable keys at all, the whole position
becomes `map(string, T)`.

**Example:** a `scores` field where every sample has a wholly different key
(`{alice_92: 7}`, `{bob_44: 3, carol_1: 9}`, …) — distinct key count grows
roughly linearly with sample count, past `growthRatio > 0.5`, so it infers
`map(string, integer)` rather than a record with dozens of optional fields.

### Optional-field detection

Falls out of structural unification (`mergeObjectTypes`), not a separate
pass: a field present in only one of two merged objects carries through with
`meta.optional = true`; present in both, required unless already optional on
either side. `{id:1, name:"a"}` merged with `{id:2, name:"b", nickname:
"bee"}` infers `nickname: string, optional: true`.

### Integer-width widening

`widenIntegerKinds` finds the tightest width covering the union of two
observed ranges, using the same tightest-to-widest table `fromJson` uses
per-value: a `uint8` sample (`42`) merged with an `int32` sample (`-100`)
widens to `int16` (tightest kind covering `[-100, 255]`).

### General structural union splitting

`trySplitDissimilarObjects` generalizes `tryDetectDU`'s Jaccard test to
positions with **no discriminant field** — most dissimilar corpora don't
have one, and would otherwise collapse into one optional-everything record.
It clusters per-sample field sets by similarity (`clusteringMethod`, default
`"single-linkage"`; `"complete-linkage"` and `"key-signature"` trade
cost/aggressiveness differently) and, if that yields 2+ clusters each backed
by >= 2 samples, keeps them as distinct variants.

`objectSplitThreshold` (default **0.5**) is five times DU detection's 0.1
because there's no discriminant corroborating that dissimilarity is real
signal rather than ordinary optional-field sparsity — two records each
missing a different one of two fields already score 0.5, and the default is
set so that alone never triggers a split. `objectSplitMinSamples` (default
**5**) gates it further, for the same "no corroborating prior" reason. An
empty sample (`{}`) is always distance 0 from any cluster — it reads as "all
fields absent," not a second population.

### Dirty-data detection (opt-in)

`detectDirtyData` (default `false`) re-infers each raw value at a 2-variant
union position and counts which variant it matches. If one variant accounts
for **`> 90%`** of values, the minority is flagged instead of kept as a
first-class member: the majority type is returned with
`meta.dirtyDataWarning` describing the anomalous count/percentage.

`CorpusInferConfig` extends `InferConfig` — `arrayThreshold`,
`narrowIntegerWidth`, `detectStringFormats`, `leafHeuristics` thread through
to the per-value `fromJson` pass phase 1 runs underneath.

### Example

```ts
import { fromJsonCorpus } from "@rhi-zone/fractal-type-ir/from-json-corpus";

fromJsonCorpus([
  { id: 1, name: "a" },
  { id: 2, name: "b", nickname: "bee" },
]);
```

```ts
t(
  types.object({
    id: uint8(),
    name: t(types.string),
    nickname: t(types.string, { optional: true }),
  }),
);
```

## 3. The evaluation harness — `inference-eval.ts`

The thresholds above — `K/N < 1/3`, Jaccard `0.1`/`0.5`, growth ratio `0.5`
— were hand-picked with no labeled-corpus validation, per the module's own
doc comment. `inference-eval.ts` closes that gap by running inference
**backwards**: start from a schema known correct, generate synthetic data
conforming to it, infer from that data, score the result against the schema
that generated it. Because ground truth is known by construction,
precision/recall/F1 are actually computable — unlike scoring on real-world
data with no labeled reference.

```
schema --(generateCorpus)--> synthetic values --(fromJsonCorpus)-->
  inferred schema --(scoreInference against original)--> quality report
```

- **`generateCorpus(schema, n, options?)`** — the inverse of inference: walks
  a `TypeRef` and produces `n` synthetic JSON values conforming to it, via a
  seeded PRNG so runs are deterministic. Options: `optionalPresenceRate`
  (default 0.75), `nullableNullRate` (default 0.15), `arrayLengthRange`
  (default `[0,5]`), `mapSizeRange` (default `[0,4]`), `defs` (for `ref`
  resolution), `maxDepth` (default 6 — forces arrays to length 0 past this
  depth, guaranteeing termination for recursive schemas).

- **`scoreInference(original, inferred)`** — flattens both schemas into path
  indexes (object fields append `.name`, arrays `[]`, tuples `[i]`, maps
  `{}`) and compares them across six precision/recall/F1 axes:
  `fieldCoverage` (found every path), `typeAccuracy` (`exactRate` — identical
  kind; `familyRate` — same root kind, e.g. `uint8` and `int32` both root to
  a numeric family via `ancestors`), `enumDetection`, `enumMemberFidelity`,
  `dictDetection`, and `unionFidelity` (plus `avgVariantCountDiff`).
  `enumDetection` is shape-only — did we recognize a position as enum-typed
  at all — while `enumMemberFidelity` compares the actual member sets at
  positions both schemas agree are enum-shaped, catching a gap shape
  detection can't see: a rare member that never appears in a small sample,
  producing an inferred enum with fewer members than the true schema (a
  `zipfian-presence`-profiled corpus at small N is the case that surfaced
  this: shape detection improves under skewed sampling — concentrated
  observations saturate K/N sooner — while member-set fidelity gets worse,
  see `inference-eval.test.ts`'s generator-profile FINDING tests). Both are
  micro-averaged (`comparedPositions === 0` reports the vacuous perfect
  score, same convention as `typeAccuracy`'s `compared === 0`). `overallF1`
  averages only the axes with something to find in the original — no free
  credit for an axis with nothing there.

- **`runEvaluation(cases, sizes?)`** — drives labeled `EvalCase`s through
  generate → infer → score at each size in `sizes` (default `[5, 10, 50,
100, 500]`), averaging per size (`bySize`) — this is how the harness
  answers "how much corpus does quality need before it stabilizes."
  `defaultLabeledCases` reuses schemas already trusted by cross-projector/
  compile-check test suites (`ecommerceOrder`, `apiResponse`, `kitchenSink`,
  `treeNode`), plus synthetic cases targeting specific heuristics (enum
  saturation, nested DU, dict growth). Comments on these fixtures record two
  gaps the harness itself surfaced: DU detection never fires on a root-level
  union schema (only from the array branch), and an empty-array sample
  unified with a populated one collapses the whole element type to `unknown`
  (`unknown` absorbs everything in `unifyTypes`).

**Tuning a threshold**, per the module doc — "change a threshold, rerun,
compare": add or reuse an `EvalCase` exercising the path in question, run
`runEvaluation` once with the current value and once with a candidate (via
`case.config`), and compare `ScoreReport`s — a real improvement raises the
relevant axis's F1 without depressing `fieldCoverage` (over-splitting shows
up as `extra`-status entries in `ScoreReport.fields`). The harness measures
**outcomes** (did the right shape come back), not **internals** (which
constant fired), so it stays valid across a threshold change instead of
needing rewriting alongside it.

## 4. Practical guidance

**Corpus size matters unevenly across signals.** Optionality falls out of
unification and needs only 2 samples in principle. Enum/dict detection gate
on `enumMinSamples`/`dictMinSamples` (3) before firing, and grow more
confident with more samples — `literalMinSamples` (5) exists specifically
because a single-value field at low N can't be distinguished from "haven't
seen variation yet." DU detection and general splitting need
`objectSplitMinSamples` (5) or DU's 3-element floor, _and_ real corroborating
structural difference — these are the signals most likely to need a larger
corpus before stabilizing. When in doubt, run `runEvaluation` at a few sizes
for a schema shaped like the target data rather than guess.

**When inference gets something wrong**, two escape hatches exist:

1. **`leafHeuristics` (single-value) / `customResolvers` (corpus).** Override
   or extend the decision at specific nodes without touching the rest of the
   pipeline — recognize a domain-specific string format the built-in regexes
   miss, or force a field to a fixed type regardless of what the heuristics
   conclude.
2. **Fall back to an explicit schema-based importer.** If the source has a
   declared schema somewhere (OpenAPI, JSON Schema, a Zod definition), or
   inference on a genuinely heterogeneous corpus keeps getting the shape
   wrong no matter how heuristics are tuned, use one of the format-parsing
   importers in [`docs/guide/ingestion.md`](./ingestion.md) instead.
   Inference exists for the case where no declared schema is available at
   all; when one is, or can be authored, parsing it is strictly more
   reliable than guessing from examples.
