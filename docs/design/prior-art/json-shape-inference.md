# Prior art: JSON shape/schema inference

This document surveys five lines of prior work relevant to `packages/type-ir`'s
JSON shape inference (`from-json.ts`, `from-json-corpus.ts`): tagged-union
discovery, probabilistic type inference for messy tabular data, quicktype's
map-vs-record heuristic, monoid-based distributed schema discovery, and
parametric map-reduce schema fusion. Each entry cites primary sources, unpacks
the algorithm, and connects it to the specific problems our inferrer solves:
enum detection, discriminated-union (DU) detection, dict-vs-record
disambiguation, and robustness against dirty/outlier data.

Sources were fetched directly (arXiv HTML/PDF, EDBT/VLDB proceedings, the
quicktype blog) rather than summarized from memory; PDF text was extracted
locally via `pdftotext` where WebFetch could not parse the binary stream.
Direct quotes are marked as such.

---

## 1. Klessinger et al. — "Extracting JSON Schemas with Tagged Unions" / Tagger

**Citation.** Stefan Klessinger, Meike Klettke, Uta Störl, Stefanie
Scherzinger. "Extracting JSON Schemas with Tagged Unions." *DEco@VLDB 2022*,
CEUR-WS Vol. 3306, pp. 27–40. Also: Klessinger, Fruth, Gittinger, Klettke,
Störl, Scherzinger. "Tagger: A Tool for the Discovery of Tagged Unions in JSON
Schema Extraction" (demo paper), *EDBT 2023*, pp. 827–830,
[10.48786/edbt.2023.75](https://doi.org/10.48786/edbt.2023.75). arXiv preprint:
[2306.07085](https://arxiv.org/abs/2306.07085). Tool:
[github.com/sdbs-uni-p/tagger-edbt2023](https://github.com/sdbs-uni-p/tagger-edbt2023).

### Core idea

A "tagged union" is JSON Schema's `if`/`then`/`else` pattern where one
property's *value* (the tag) determines the subschema of sibling properties
— e.g. in GeoJSON, `type: "Point"` implies `coordinates` is `number[]`, while
`type: "LineString"` implies `coordinates` is `number[][]`. Tagger is, per the
authors, "the first implementation of JSON Schema extraction capable of
detecting tagged unions," built as a post-processing layer over any
third-party schema extractor's output (composed via `allOf`).

### Algorithm

**Formalization as CFDs.** The paper formalizes tag→subschema implications as
*unary constant conditional functional dependencies* (ucCFDs), following
Bohannon et al.'s definition of CFDs for relational data cleaning. The
restricted form used is:

```
[A.value = const] → [B.type = σ]
```

where `A` and `B` are distinct property labels at the same JSON path, `const`
is a basic-value constant (the candidate tag value), and `σ` is the implied
subschema of sibling property `B`. This is a genuine relational-database
technique (conditional functional dependency discovery) applied to JSON via a
relational encoding, not a JSON-native algorithm.

**Relational encoding.** For every JSON path reached by the same JSONPath
(the paper's running example is `/geometries[*]`), each object becomes a
tuple. For each property, two columns are recorded: one for its *value*
(only for basic/primitive values — nested values are not captured this way)
and one for its inferred *subschema*. For the GeoJSON `Point`/`LineString`
example this yields tuples like:

```
id | type.value    | type.type | coordinates.type
3  | "Point"        | "string"   | t   = {type: array, items: {type: integer}}
11 | "LineString"    | "string"   | t'  = {type: array, items: {type: array, items: {type: integer}}}
```

**Dependency discovery.** Standard CFD-discovery algorithms (the paper cites
Chu et al.'s SIGMOD 2016 survey on data cleaning) are run over this relational
encoding to mine `[A.value=const] → [B.type=σ]` dependencies. This is
restricted to *unary* CFDs — a single tag column implying a single sibling's
subschema — because "CFD discovery is computationally expensive, scaling
exponentially in the number of attributes" (Rammelaere & Geerts 2018 is cited
for this complexity result); the authors explicitly flag multi-tag CFDs as
future work.

**Discriminant detection is implicit, not a separate scoring step.** There is
no dedicated "which field is the discriminant" heuristic distinct from CFD
mining itself — any candidate value-column can become the left-hand side of a
discovered dependency; the CFD discovery algorithm surfaces all of them, and
filtering (below) prunes the ones that aren't meaningful.

**Overfitting prevention / filtering heuristics.** The paper's own framing:
"a central part of our contribution are our heuristics, which filter out
dependencies that have insufficient support in the input data." Concretely,
per the EDBT demo paper: "a range of practical heuristics, such as a
configurable threshold and the removal of trivial constraints, to reduce
overfitting to the input." The demo GUI exposes these heuristics as adjustable
knobs and lets users watch dependency counts drop after filtering is applied —
the authors note in the demo scenario description that participants will find
"settings working well for one dataset yield poor results on another,"
i.e. the thresholds are corpus-dependent and there is no universal default.

**Translation to JSON Schema.** Once filtered, each surviving CFD
`[A.value=const] → [B.type=σ]` becomes a nested `if`/`then`/`else`:

```json
{ "if": { "properties": { "type": { "const": "Point" } }, "required": ["type"] },
  "then": { "properties": { "coordinates": { "type": "array", "items": { "type": "integer" } } } },
  "else": { "if": { "properties": { "type": { "const": "LineString" } }, "required": ["type"] },
            "then": { ... } } }
```

Multiple tag values chain through nested `else` branches. The resulting
tagged-union schema `T` is conjoined with the third-party extractor's schema
`Sᵢ` via `allOf: [Sᵢ, T]` — Tagger augments rather than replaces existing
extraction tools.

**Evaluation.** Real-world GeoJSON/TopoJSON datasets (open government data,
OpenStreetMap-derived maps of Germany and the EU) plus NYTimes article
metadata. The papers report that "meaningful tagged unions can indeed be
identified" but give no aggregate precision/recall numbers in the demo
paper — evaluation is qualitative/interactive (the GUI lets users compare
extracted schemas against "negative examples" that should fail validation).

### Relevance to our work

This is the closest prior art to our DU-detection pass
(`tryDetectDU` in `from-json-corpus.ts`). Both approaches:

- Require a discriminant field whose value is constant within a group and
  varies across groups.
- Explicitly guard against overfitting via a minimum-support / threshold
  mechanism rather than accepting every statistically-observed correlation.
- Emit a discriminated structure rather than a flat, unconstrained union.

The key structural difference: Tagger discovers the discriminant among
*arbitrary* sibling properties via CFD mining (general relational dependency
discovery, unrestricted candidate set, exponential worst case, hence the
unary restriction), whereas our `tryDetectDU` restricts the candidate set
up front to fields already typed `enum` or literal-union (`fieldRef.shape.kind
=== "enum"` or an all-literal union) — this sidesteps CFD discovery's
combinatorics entirely by only ever considering fields we've already
determined are low-cardinality, at the cost of being unable to discover a
tag from a field we haven't already flagged as enum-shaped.

### What we could adopt

- **CFD framing as the formal underpinning.** Even without adopting general
  CFD discovery, describing our discriminant check as "does `[tag=const]`
  functionally determine the sibling field-set" gives us a principled
  language for what "meaningfully different shapes" means, and a citation
  path if we ever need to defend the design against "why not just always
  union everything."
- **`allOf`-style composability.** Rather than baking DU detection
  irreversibly into the merged type, structuring it as an independent pass
  whose output *augments* a plain merged schema (as Tagger augments
  third-party schemas) would let DU detection be disabled/inspected
  independently — useful for the "before/after heuristics" transparency the
  Tagger demo explicitly showcases to build user trust.
- **Interactive threshold exploration as a design goal**, even if not a UI:
  the Tagger authors found that no single threshold setting worked across
  datasets. This is evidence for keeping our thresholds configurable
  (which we already do via `TryDetectDU`'s implicit `elements.length < 3`
  gate and the Jaccard 10% cutover) rather than hard-coding one "correct"
  value.

### Limitations

- Unary-only: cannot detect a tag formed from a *combination* of two fields.
- CFD discovery is exponential in attribute count in the general case; Tagger
  sidesteps this only by restricting to unary dependencies, not by a cheaper
  algorithm.
- Discriminant candidates are restricted to *basic* (primitive) values — the
  relational encoding doesn't capture nested-object tag values at all.
- Main-memory only; no distributed/streaming story (unlike JSONoid or
  Baazizi's Spark-based approach below).
- No quantitative precision/recall — evaluation is qualitative and
  demo-driven, so we can't cite a hit rate to benchmark against.

---

## 2. ptype — Probabilistic Type Inference (Alan Turing Institute)

**Citation.** Taha Ceritli, Christopher K. I. Williams, James Geddes. "ptype:
probabilistic type inference." *Data Mining and Knowledge Discovery* 34,
2020, pp. 870–904. [10.1007/s10618-020-00680-1](https://doi.org/10.1007/s10618-020-00680-1).
arXiv preprint (with appendices):
[1911.10081](https://arxiv.org/abs/1911.10081). Code:
[github.com/alan-turing-institute/ptype](https://github.com/alan-turing-institute/ptype).

### Core idea

ptype infers the type of a *column* of tabular (CSV-style) data by modeling
each candidate type, plus "missing" and "anomaly" as competing generative
processes over strings, and picking the type whose Probabilistic Finite-State
Machine (PFSM) mixture best explains the observed column — simultaneously
flagging which individual *cells* are missing/anomalous rather than assuming
the whole column is homogeneously one type.

### Algorithm

**PFSM definition.** A PFSM is a tuple `A = (θ, Σ, δ, I, F, T)`: states `θ`,
alphabet `Σ`, transitions `δ ⊆ θ×Σ×θ`, initial-state probabilities `I`,
final-state (stopping) probabilities `F`, and transition probabilities `T`.
Unlike a plain regular expression (which only accepts/rejects), a PFSM
assigns every string in `Σ*` a *probability* — this is the entire point: it
lets a value consistent with multiple types (e.g. `"1"` as integer, float,
Boolean, or string) receive a graded posterior rather than a hard match.
Structurally a PFSM is closest to an HMM but adds explicit final-state
probabilities per state, satisfying `F(q) + Σ_{α,q'} T(q,α,q') = 1` at every
state `q`.

Concretely: the integer PFSM has two initial states (sign vs. no-sign) and one
absorbing/final state that self-loops on digits with a fixed "keep going"
probability `1 − P_stop`, each digit getting an equal share `(1−P_stop)/10`.
Complex types (email, IP, date formats) are built by compiling regular
expressions to FSMs (via the `greenery` library) and assigning uniform
transition probabilities as a starting point.

**Three-way generative model per column.** A column type `t ∈ {1..K}` is
drawn uniformly; then *each row* `i` independently gets a row-type `zᵢ` that
is `t` with probability `π_t^t`, the missing-type `m` with probability
`π_t^m`, or the anomaly-type `a` with probability `π_t^a` (with
`π_t^t + π_t^m + π_t^a = 1`, and the weights hand-tuned so
`π_t^m, π_t^a < π_t^t` — regular values are favored a priori). The row value
`xᵢ` is then drawn from `p(xᵢ | zᵢ)`, the corresponding PFSM. This is the
key mechanism that separates ptype from validation-function approaches
(Trifacta, readr, etc.): missing/anomalous rows don't have to be excluded by
a preprocessing step, they're first-class alternative explanations scored by
the same posterior inference that picks the column type.

**Missing-value PFSM.** A fixed, extensible alphabet of known missing-data
encodings: `-1, -9, -99, -999, NA, NULL, N/A, "", " ", NaN, ...`. This
directly targets what Pearson (2006) calls "disguised missing data" — e.g.
`-99` inside an otherwise-clean integer column.

**Anomaly PFSM ("X-factor," after Quinn et al. 2009).** A PFSM with the
*widest possible alphabet* (all ~1.1M Unicode code points), so it always
assigns *some* nonzero probability to any string, but a lower one than a
specific type's PFSM would for a well-formed value. This guarantees the
mixture model never assigns zero total probability to an observation and lets
truly out-of-domain values (`"refer to euro"` in an integer column,
`"& country"` with an unsupported punctuation character) get flagged as
anomalous rather than silently coerced into the nearest type or forcing the
whole column to fall back to string.

**Inference (posterior over column type).** Assuming row-conditional
independence given `t`:

```
p(t=k | x) ∝ p(t=k) · Πᵢ [ π_k^k · p(xᵢ|zᵢ=k) + π_k^m · p(xᵢ|zᵢ=m) + π_k^a · p(xᵢ|zᵢ=a) ]
```

The column type is the `k` maximizing this (Eq. 1 in the paper). Per-row
type/missing/anomaly labels then follow from the row-level posterior:

```
p(zᵢ=j | t=k, xᵢ) = π_k^j · p(xᵢ|zᵢ=j) / Σ_{ℓ∈{k,m,a}} π_k^ℓ · p(xᵢ|zᵢ=ℓ)
```

(Eq. 2). Complexity is `O(U·K·M²·L)` where `U` = number of *unique* values
(not rows — repeated values are deduplicated before running the PFSM forward
algorithm), `K` = number of candidate types, `M` = max PFSM state count, `L`
= max value length. Reported throughput: ~10K unique values/second, scaling
linearly in `U`.

**Training: discriminative, not pure maximum-likelihood.** Parameters
(transition/initial/final probabilities) are tuned via a discriminative
objective `Σⱼ log p(tʲ|xʲ)` maximized by conjugate gradient over *labeled*
columns — explicitly chosen over plain maximum-likelihood because
"discriminative training... is generally superior to maximum likelihood
estimations, since a discriminative criterion is more consistent with the
task being optimized," citing the same rationale used for discriminative HMM
training in speech recognition. Missing/anomaly PFSM parameters are *not*
updated by this process (no labeled missing/anomaly examples exist), only
hand-crafted; training starts from hand-tuned initial values rather than a
uniform prior, because uniform-initialized training "[is] not competitive."
An unsupervised EM alternative (maximizing Σ log p(xᵢⱼ) over the full
mixture) is discussed as theoretically possible but "unlikely to give as good
classification performance as supervised training," and wasn't pursued.

**Results.** On 43 held-out messy real-world tabular datasets (UCI ML,
data.gov, data.gov.uk), ptype beat F#, messytables, readr, TDDA, hypoparsr,
and Trifacta on overall accuracy (0.93 vs. Trifacta's 0.90, the next best) and
on every per-type Jaccard index except date (0.67, tied/slightly below
Trifacta's 0.68). On missing/anomaly detection specifically (type/non-type
AUC), ptype averaged 0.93 AUC vs. Trifacta's 0.77 (paired t-test p=0.00005).

### Relevance to our work

ptype targets a genuinely different substrate — homogeneous CSV *columns*,
not heterogeneous JSON trees — but the core idea, **probability-weighted
type competition instead of first-match/validation-function type
assignment**, maps directly onto our dirty-data problem: when a field is
`number` in 995 samples and `string` in 5, do we union, coerce, or flag
outliers? ptype's answer is structural: model "anomaly" and "the dominant
type" as two competing explanations with different priors, and let the data
decide the split per-value rather than per-column.

### What we could adopt

- **A generic "anomaly" catch-all with a wide-alphabet/wide-domain prior**,
  analogous to the X-factor PFSM, as an explicit alternative hypothesis
  during merge — rather than our current implicit behavior where an outlier
  value just becomes another union member (or, worse, forces a coercion to a
  wider primitive kind). An explicit low-prior "this looks like an outlier,
  not a genuine variant" bucket would let corpus-level inference *report*
  outlier rate rather than silently absorbing it into the type.
- **A curated missing-value-sentinel alphabet** (`-1, -99, "", "NA", "N/A",
  null-as-string, ...) as a first-class detector, distinguished from "this
  field is genuinely nullable" — currently we'd likely just infer `number |
  string` or widen to `unknown` when a numeric field has stray `"NA"` values,
  rather than flagging that specific value as a probable missing-data
  encoding.
- **Discriminative-training framing as a validation target**, not literally
  gradient descent on PFSM weights, but the general idea of tuning our
  saturation/Jaccard thresholds against a labeled corpus of "should be enum"
  vs. "should not," the way ptype tuned Boolean-vs-integer preference for
  `{0,1}` against hand-crafted intuition plus discriminative correction. Our
  thresholds (`K/N < 1/3`, `K > 50`, Jaccard `> 0.1`) are currently
  hand-picked constants with no labeled-corpus validation behind them, per
  ptype's own finding that hand-crafted values needed data-driven correction
  even when the initial choice looked reasonable (their Boolean-vs-integer
  confusion at `{0,1,2}`).

### Limitations

- Designed for flat homogeneous columns, not nested/heterogeneous JSON — no
  notion of records, arrays, or discriminated unions at all; porting it would
  mean re-deriving the PFSM machinery per JSON leaf-path (which is roughly
  what our `collectFieldStats`/per-path enum stats already do, just without
  the probabilistic-competition machinery).
- Ambiguous cases still fall back to "pick the highest posterior" by default;
  the paper's own worked example (`NULL` and `1` in a column) gives a
  61/26/29-style split across Boolean/integer/float with no principled
  tie-break beyond the hand-tuned priors — this is a real unsolved problem
  for us too, not something ptype solves outright.
- The string PFSM's alphabet is a fixed punctuation set; it misclassifies
  valid strings containing unsupported characters (their own example:
  `Alzheimer's disease` flagged as anomalous purely because the apostrophe
  isn't in the alphabet) — a caution that any fixed-alphabet leaf-value model
  needs a documented, easily-extensible escape hatch, not just wide Unicode
  coverage for the "anomaly" bucket.
- Discriminative training requires labeled ground-truth columns; there is no
  bootstrapping story from unlabeled data alone (the unsupervised EM
  alternative was tried and rejected).

---

## 3. quicktype — Markov-chain map/class detection & union merging

**Citation.** Blog post: "Little Big Detail #3: Detecting Maps," quicktype
blog, [blog.quicktype.io/markov](http://blog.quicktype.io/markov/) (mirrored
at [quicktype.io/blog/markov](https://quicktype.io/blog/markov)). Code:
[github.com/glideapps/quicktype](https://github.com/glideapps/quicktype).

### Core idea

Given a JSON object, quicktype must decide whether to generate a fixed
`class`/`interface` (named, fixed properties) or a `Map<string, T>` (dynamic
keys, homogeneous value type). It answers this per-object using a Markov
chain over *property-name character sequences*, trained empirically on a
corpus of real-world JSON, to score "does this key look like a human-chosen
field name or an arbitrary/generated map key."

### Algorithm

**Character-trigram Markov chain.** The chain operates over 3-letter windows:
the first two letters of any 3-letter sequence in a property name form the
*state*, and the transition table gives `P(third letter | first two
letters)`. Given a property name, quicktype walks it 3 letters at a time,
looks up the transition probability at each step, and combines them.

**Combination via geometric mean, not arithmetic mean.** Per-transition
probabilities are combined as "the nth root of their product" — i.e. the
geometric mean of the letter-transition probabilities across the whole
property name, producing a single class-property-likelihood score per key.
Geometric mean is the natural choice here because it's the right aggregate
for a chain of multiplicative (probability) evidence — an arithmetic mean
would let one high-probability transition mask several near-zero ones.

**Multi-key aggregation.** For an object with several properties, quicktype
"averages the probabilities of all property names," and explicitly "allows
property names to be a bit 'weirder' when there are fewer of them" — i.e. the
map-vs-class decision threshold is itself sample-size-sensitive: a single
odd-looking key among 20 well-formed keys is weak evidence for "this is a
map," but the same key alone (an object with one property) is treated as
stronger evidence, because there's less corroborating "these look like
field names" signal to outvote it.

**Training.** Informal: "I wrote a little script and ran it over JSON data I
had lying around," with the author himself calling the approach "not very
scientific" — no published corpus size, domain composition, or held-out
validation methodology. This is a hand-built heuristic tool refined by
observation, not a benchmarked statistical model.

**Threshold.** Unspecified in the post — described only as empirically
determined; not a documented constant.

**General union-merging behavior (beyond the map/class post).** Separately
from map detection, quicktype's core type-inference algorithm merges the
types observed at the same "location" (JSONPath-equivalent) across a corpus
into a union, then a post-pass decides whether that location should render
as a tagged union, a plain union, a `Map`, or (if the union's constituent
object shapes are similar enough) a single class with optional fields —
quicktype refers to this general merge-and-simplify step as building "unified
types" and it is the same design point our `mergeAll`/`unifyTypes` occupies.

### Relevance to our work

This is the single closest piece of prior art to our dict-vs-record pass
(`detectDicts` in `from-json-corpus.ts`). Both quicktype and we solve exactly
the same disambiguation ("is this key set a fixed vocabulary of field names,
or an open vocabulary of dynamic data-derived keys") but via structurally
different evidence: quicktype scores *individual key strings* against a
learned character-level language model of "field-name-shaped" text; we score
*the key-set's growth behavior across the corpus* (stable across samples →
record; growing linearly with sample count → dict), per the `detectDicts`
comment: "If key set is stable (same keys in every sample), it's a record. If
distinct key count keeps growing linearly, it's a dict."

These are complementary, not competing, signals: quicktype's approach works
on a *single* object with no corpus (it must decide the moment it sees one
JSON document, which is why it needs a learned string-shape prior at all);
ours requires a multi-sample corpus but doesn't need any pretrained model or
language assumption, and correctly stays silent (falls back to record) below
`dictMinSamples`.

### What we could adopt

- **A single-document fallback signal.** Our `detectDicts` is entirely
  corpus-driven and produces no signal for a single JSON document (or a
  corpus below `dictMinSamples`). A lightweight key-shape heuristic (not
  necessarily a trained Markov chain — even something as simple as "keys
  look like UUIDs/hashes/numeric strings/emails" pattern checks) would give
  us *some* dict-vs-record signal in the single-sample case where corpus
  growth evidence doesn't exist yet.
- **Sample-size-sensitive thresholds.** quicktype's explicit "allow more
  weirdness when there are fewer keys" rule is a useful pattern independent
  of the specific Markov-chain mechanism — it's the same shape as our own
  `enumMinSamples`/`dictMinSamples` gates, but applied *within* a single
  decision rather than as a hard sample-count cutoff. Worth considering for
  our own enum/DU heuristics: e.g. loosen the `K/N` saturation ratio
  slightly as `N` grows very small, rather than using one flat threshold.
- **Geometric-mean combination** as the correct aggregator whenever we
  combine multiple independent per-item probability-like signals (e.g. if we
  ever score "does this whole object look enum-shaped" by combining
  per-field confidence scores) — arithmetic mean is the wrong default for
  multiplicative evidence.

### Limitations

- No formal training methodology or published evaluation — the author's own
  framing ("not very scientific") should be taken at face value; there is no
  accuracy number to compare against or replicate.
- English-only; the character-trigram model has no cross-lingual notion of
  "field-name-shaped."
- Explicitly cannot recognize structured key patterns (e.g. email addresses)
  purely from the Markov chain — the post suggests regex as a *separate*
  future mechanism, i.e. the authors themselves see the Markov-chain
  approach as necessarily supplemented by pattern-based checks, not
  sufficient alone.
- No multi-sample/multi-document correlation — each object's map/class
  decision is made independently of how the same path behaved in sibling
  documents, unlike our corpus-level `detectDicts`.

---

## 4. JSONoid — Monoid-based schema discovery

**Citation.** Michael J. Mior, et al. "JSONoid: Monoid-based Enrichment for
Configurable and Scalable Data-Driven Schema Discovery." arXiv:
[2307.03113](https://arxiv.org/abs/2307.03113), July 2023. Code:
[github.com/dataunitylab/jsonoid-discovery](https://github.com/dataunitylab/jsonoid-discovery).

### Core idea

Every piece of schema-relevant information extracted from a JSON document
(type, enum candidates, numeric range, string pattern, distinct-value
estimate, ...) is represented as a *monoid*: an identity element plus an
associative, commutative binary merge operation. Because monoid merge is
associative and commutative, schema discovery over a document collection
reduces to a distributed/streaming reduction — no different in structure
from a MapReduce word-count — with no central coordination needed beyond
tree-shaped reduction.

### Algorithm

**Structural monoids** compose the schema shape itself: `ObjectTypes` merges
attribute-key→schema maps by unioning attribute sets (this is directly
analogous to our own field-merging in `mergeObjectTypes`); `ArrayType`
merges element-type information with special-cased tuple-vs-homogeneous-array
handling.

**Value/statistics monoids** carry auxiliary information *alongside* the
structural type, each independently mergeable: `Examples` does reservoir
sampling (bounded-size representative sample, merge = weighted-by-count
resample); `Mean`/variance/skewness/kurtosis monoids use standard online
(Welford-style) running-statistics formulas so partial aggregates from
different shards combine exactly; `MaxMin` tracks numeric bounds;
`HyperLogLog` estimates distinct-value cardinality with sub-linear memory,
merging by taking the register-wise maximum; `Bloom filter` monoids support
approximate set-membership and, notably, approximate *subset* detection for
foreign-key discovery (`B₁ ⊆ B₂` is likely true when every set bit in `B₁`'s
filter is also set in `B₂`'s); `Histogram` monoids estimate value
distributions; `Multiple` uses running-GCD to detect "all values are
multiples of N" numeric patterns; `Pattern` detects common string
prefixes/suffixes (not full regex); `Format` matches against a fixed set of
pre-coded detectors (URL, date, UUID, ...); `Required`/`AttributeCounts`
track per-attribute presence frequency across the corpus for optional-vs-
mandatory field classification.

**Configurable granularity via equivalence relations.** Users choose how
aggressively structurally-different-but-related schemas get merged: "kind
equivalence" merges any two schemas of the same JSON kind (any two objects
merge, any two arrays merge — maximally concise, least precise), "label
equivalence" requires matching attribute sets before merging (more schemas
survive distinct, more precise, less concise). This is conceptually the same
knob as Baazizi et al.'s K/L equivalence below (§5) — both projects
independently arrived at "let a configurable equivalence relation, not a
single hardcoded merge rule, decide how eagerly structurally different
objects collapse into one schema."

**Product schemas for genuinely incompatible structures**, i.e. `oneOf` in
JSON Schema terms, rather than forcing a lossy common supertype when
documents at the same path have irreconcilably different shapes.

**Distributed/streaming execution.** Because merge is associative +
commutative, per-partition schemas combine via `O(log n)` tree-reduction
instead of `O(n)` sequential folding, giving linear scalability in document
count; the same monoid machinery supports incremental streaming updates with
bounded memory (only the running aggregate + current document needed).

**Evaluation.** On an NPM `package.json` corpus, using randomly-perturbed
documents that structurally conform but violate real semantic constraints as
a discriminative-power probe: with all monoids enabled, 100% rejection
accuracy on the perturbed set but 42.6% overfitting rate (legitimate
same-dataset documents incorrectly rejected too). Individual monoids trade
off very differently — `Required` alone: 98.7% accuracy, 1.1% overfitting
(a strong, cheap signal); `MaxMin` on string length alone: 76% accuracy but
40.4% overfitting (strict numeric bounds overfit badly on their own).
Runtime: minimal-monoid-set streaming mode processes 3,681 docs/sec; full
monoid set drops to 76 docs/sec (roughly 5–10× slower, but still linearly
scalable).

### Relevance to our work

JSONoid's central move — decompose "schema" into independently-mergeable,
associative pieces of evidence rather than one monolithic inference pass —
is architecturally close to our own tiered pass structure
(`fromJson` per value → `unifyTypes` pairwise merge → post-merge passes:
`detectEnums`, `tryDetectDU`, `detectDicts`). The *evaluation methodology*
is directly relevant to our enum/DU/dict thresholds: JSONoid's finding that
individual signals have wildly different accuracy/overfitting tradeoffs
(`Required` cheap and reliable; `MaxMin` on strings expensive and overfit-
prone) is exactly the shape of question we should be asking about our own
`looksLikeEnum` saturation heuristic and Jaccard-based DU-group-distinctness
check, but currently answer only by inspection, not by a held-out
discriminative-power probe.

### What we could adopt

- **The accuracy-vs-overfitting evaluation harness itself** — perturbed/
  synthetic "should be rejected" documents drawn from the same corpus family
  as a way to quantitatively score our own enum/DU/dict heuristics, the way
  JSONoid scored `Required` vs. `MaxMin`. We currently have no analogous
  measurement for `looksLikeEnum`'s `K/N` thresholds or the DU pass's
  Jaccard `0.1` cutoff.
- **A `Required`-style presence-frequency monoid as a cheap, high-value
  early signal** — JSONoid's evaluation shows this single cheap monoid
  achieves 98.7% accuracy at 1.1% overfitting essentially by itself; our
  optional-field detection already does something structurally similar
  (field present in all samples ⇒ mandatory) but isn't validated as a
  standalone discriminative signal the way JSONoid's ablation makes
  possible.
- **HyperLogLog-based cardinality estimation** for the enum-saturation check
  at corpus scale — our current `looksLikeEnum` materializes an exact
  `Set<string>` of distinct values per field (`FieldStats.distinctValues`),
  which is fine at our current scale but wouldn't scale the way JSONoid's
  monoid approach explicitly targets (JSONoid is built for "massive,"
  distributed corpora). Worth flagging as the scaling answer if/when our
  corpus sizes grow past in-memory-Set territory.
- **Product-schema (`oneOf`) as an explicit fallback** for object shapes at
  the same path that fail both the DU-discriminant check and normal
  structural merging — rather than only ever falling back to an
  unconstrained union.

### Limitations

- `Pattern` monoid is prefix/suffix only, not full regex — same limitation
  our own type-ir currently has no answer for either.
- `Format` detection needs hand-coded detector functions per format; no
  general format-learning mechanism.
- Document-level (not just field-level) outlier detection is explicitly
  deferred as future work.
- The paper's own conclusion: "heuristics to reduce overfitting remain
  unimplemented future work" — i.e. JSONoid's monoid framework provides the
  *infrastructure* for combining signals cheaply, but (per their own
  evaluation) does not yet solve the overfitting problem outright; naive
  "enable everything" still overfits at ~43% on their probe.

---

## 5. Baazizi et al. — Parametric schema inference (Spark, K/L equivalence)

**Citation.** Mohamed-Amine Baazizi, Houssem Ben Lahmar, Dario Colazzo,
Giorgio Ghelli, Carlo Sartiani. "Schema Inference for Massive JSON Datasets."
*EDBT 2017*, pp. 222–233, [10.5441/002/edbt.2017.21](https://doi.org/10.5441/002/edbt.2017.21).
Journal version with the parametric K/L precision knob: Baazizi, Colazzo,
Ghelli, Sartiani. "Parametric schema inference for massive JSON datasets."
*The VLDB Journal* 28(4), 2019, pp. 497–521,
[10.1007/s00778-018-0532-7](https://doi.org/10.1007/s00778-018-0532-7). See
also the interactive follow-up: Baazizi, Berti, Colazzo, Ghelli, Sartiani.
"Human-in-the-Loop Schema Inference for Massive JSON Datasets," *EDBT 2020*,
pp. 635–638.

### Core idea

Schema inference splits cleanly into two Spark stages: a **Map** phase that
infers a simple, exact structural type per individual JSON value (no
unions, no optionals — literally isomorphic to the value's own shape), and a
**Reduce** phase that iteratively **fuses** pairs of these types via a
provably commutative, associative, correct binary function. Associativity is
the load-bearing property: it is what lets Spark safely and correctly
distribute the fuse across partitions, and what makes incremental schema
maintenance (fuse only the delta, then fuse that into the existing schema)
correct without re-processing the whole corpus.

### Algorithm

**Type language.** `T ::= BT | RT | AT | SAT | ∅ | T+T` — basic types
(`Null | Bool | Num | Str`), record types (`RecT`/`OptRecT`, i.e. mandatory
vs. optional fields), array types (`ArrT`, an ordered list of per-position
element types), a *simplified* array type `SAT = [T*]` (a single "body" type
covering the whole array, used only as an intermediate/output form for
fusion — the paper is explicit that repetition types are never inferred at
Map time, only produced during fusion), and a union constructor `+`.
Semantics `⟦T⟧` are given denotationally (a straightforward "set of values
this type describes" definition) purely to state and prove the fusion
theorems below, not as an implementation detail.

**Map phase: per-value typing is a pure structural mirror.** The typing
judgment `⊢ V ; T` (Figure 4 in the 2017 paper) does no merging at all —
`Rec(l,V,W)` types to `RecT(l,T,RT)` where `T` is `V`'s type and `RT` is
`W`'s type, recursively; there is exactly one applicable rule per value
shape, so this phase is embarrassingly parallel per-document.

**Reduce phase: the `kind()` function and the fusion algorithm.** A `kind`
function maps every type to an integer 0–5 (`Null=0, Bool=1, Num=2, Str=3,
RT=4, AT/SAT=5`); fusion only ever recursively merges two types of the
*same* kind, and simply juxtaposes (unions) types of different kind. The
top-level entry point:

```
Fuse(T1, T2) := ⊕({ LFuse(U1,U2) | (U1,U2) ∈ KMatch(T1,T2) } ∪ { U3 | U3 ∈ KUnmatch(T1,T2) })
```

`KMatch`/`KUnmatch` (via the helper `◦(T)`, which flattens a union into a
multiset of its non-union addends) split each side's union members into
kind-matched pairs (recursively fused via `LFuse`) and kind-unmatched
leftovers (passed through untouched into the output union). `LFuse` itself:

- **Basic types (same kind):** identical → collapsed to the single type;
  this only fires when `kind(B) < 4`, i.e. atomic types, since the "same
  basic type twice" case is trivial — genuinely different basic types never
  reach `LFuse` because they have different `kind()`.
- **Record types:** matching keys recursively `Fuse`d (with cardinality
  `min(m,n)` — a field stays mandatory only if mandatory on *both* sides,
  using the convention `? < 1`); unmatched keys copied through as
  *optional*. This is the direct analogue of our own `mergeObjectTypes`
  field-union-with-optionality-widening.
- **Array types:** first *simplified* via `collapse` — an array's
  positional element types `[T1,...,Tn]` are folded via repeated `Fuse`
  into one union body type, becoming `[T*]` — before the two (now-
  simplified) array bodies are fused with each other. This deliberately
  discards positional information in exchange for size boundedness: array
  fusion is otherwise unbounded in the worst case (an array literally
  mixing many distinct shapes at different positions across the corpus).
  The paper is explicit that this loses precision for arrays where element
  *position* is informationally meaningful (their acknowledged tradeoff).

**Correctness/commutativity/associativity are proven theorems, not just
claimed properties**: `Fuse(T1,T2) = Fuse(T2,T1)` (Theorem 5.4); `Fuse(Fuse(
T1,T2),T3) = Fuse(T1,Fuse(T2,T3))` (Theorem 5.5); and `T1 <: Fuse(T1,T2)`,
`T2 <: Fuse(T1,T2)` for the subtyping relation `T <: U ⟺ ⟦T⟧ ⊆ ⟦U⟧`
(Theorem 5.2, "Correctness of Fuse") — i.e. the fused type is a genuine
supertype of both inputs, not merely "close enough."

**The parametric precision knob: K-equivalence vs. L-equivalence (VLDB
journal extension).** The 2017 paper's fusion always merges by `kind()`
alone — every record merges with every other record regardless of field-set
overlap. The VLDB-journal follow-up generalizes this into a *parametric*
choice of equivalence relation deciding which schemas are eligible to merge
at all:

- **K (kind) equivalence:** any two record types merge, any two array types
  merge — the 2017 paper's original behavior. Maximally concise, minimally
  precise; every possible field across every shape variant ends up optional
  on one giant record.
- **L (label) equivalence:** two record types merge only if they share the
  same top-level field-label set. Precise (distinct shapes stay visibly
  distinct, structural correlations like "`b` and `c` never co-occur" are
  preserved) but less concise (proportionally more distinct record types
  survive in the output).

The paper's own worked example: fusing `{a,b,d:{e,f}}`, `{a,c,d:{g,h}}`,
`{a,c,d:{e,f}}` under K produces one record `{a, b?, c?, d:{e?,f?,g?,h?}}`
that "hides important correlation information like the fact that `b` and `c`
never co-occur"; the same three objects under L keep `{a,b,d:{e,f}}`
separate from the (L-merged) `{a,c,d:+L({e,f},{g,h})}`, correctly preserving
that `b`⁻record never has `c`. This directly demonstrates the
precision-vs-conciseness tradeoff the parameter controls, and — per the
2020 interactive follow-up — the authors' conclusion was that *neither*
extreme is universally right, hence the follow-up work lets an analyst
choose K vs. L (and mix them at different nesting depths within the same
schema) interactively rather than picking one globally up front.

**Evaluation.** Four real datasets on Spark 1.6.1 (GitHub PR metadata,
Twitter, Wikidata, NYTimes), up to 21M records / 75GB. Fused-type size stayed
close to average per-value type size for homogeneous data (GitHub: fused
type size 760 vs. avg. input type size 674 at 1M records — ratio ≈1.1);
Wikidata (which encodes user IDs directly as object keys, defeating
key-based record fusion) fused far less cleanly (fused size 117,010 at 1M
records against 310 average input size, because effectively every record
looks structurally distinct when its keys are IDs) — the paper's own
diagnosis: "this has an impact on our fusion technique, which relies on
keys to merge the underlying records" — a direct, named instance of exactly
our dict-vs-record problem, encountered as a *failure mode* rather than
solved. Distributed scalability: linear in dataset size on a 6-node/120-core
cluster, 12.5 min for the full 22GB/1.18M-record NYTimes dataset once
partitioning was tuned to avoid HDFS/Spark data-locality bottlenecks.

### Relevance to our work

Three direct connections:

1. **Our `unifyTypes`/`mergeAll` is structurally the same `Fuse`/`LFuse`
   design** — kind-based dispatch, recursive same-kind merging, optional-
   field widening on key mismatch, union passthrough on kind mismatch. We
   should be able to state (and should verify, since we haven't proven it)
   the same commutativity/associativity properties Baazizi et al. prove
   formally, since our corpus-level merge is a repeated pairwise fold over
   the same shape of operation.
2. **Their K/L equivalence *is* our record/dict boundary, from the opposite
   direction.** K-equivalence (merge unconditionally by kind) is exactly
   what happens if a dict-detection pass never fires — every record
   collapses into one big optional-everything shape. L-equivalence (merge
   only same-label-set records) is what happens when dict detection
   *never* fires and records with genuinely different field sets are kept
   separate as distinct union variants. Our `detectDicts` pass is, in
   effect, choosing L-vs-K *automatically per corpus location* based on
   whether the key-set is stable or growing, rather than requiring the
   analyst to pick one policy globally (Baazizi 2017/2019) or interactively
   per-subtree (Baazizi 2020) — this is a genuine point of departure worth
   naming explicitly.
3. **Their Wikidata failure mode (user IDs used directly as object keys)
   is precisely the dict case our `detectDicts` targets**, and their own
   diagnosis of *why* it fails (key-based record fusion assumes keys are a
   fixed vocabulary) is independent confirmation that dict-vs-record
   disambiguation isn't a cosmetic nicety — without it, fusion size blows up
   by ~three orders of magnitude on real data (117,010 vs. 310 in their
   numbers) because every dynamically-keyed object looks like a novel shape.

### What we could adopt

- **A named, provable fusion algebra.** Adopting their `kind()`-dispatch
  framing explicitly (rather than the current ad hoc `unifyTypes` switch)
  and stating/testing the commutativity and associativity properties as
  actual test invariants (property-based tests, given we already use
  fast-check per the `from-json.fuzz.test.ts` precedent) would let us prove
  — not just assume — that our merge order doesn't affect the result, which
  matters if we ever want to parallelize or incrementally update inferred
  types the way Baazizi's associativity argument enables for Spark.
- **Array simplification via fold-to-union-body (`collapse`)** as the
  documented, principled fallback for arrays whose positional structure
  can't be preserved concisely — we likely already do something similar,
  but the explicit acknowledgment that this trades positional precision for
  boundedness is worth stating as a documented tradeoff rather than an
  implicit behavior.
- **Explicit min(m,n)-cardinality-on-key-mismatch as the field-optionality
  rule**, stated as precisely as their `RT` fusion rule, if our own
  `mergeObjectTypes` doesn't already document this as crisply.
- **The K/L-as-explicit-parameter framing**, even without building the full
  interactive UI: documenting our dict-detection thresholds
  (`dictMinSamples`, the "stable vs. growing key set" test) as *implementing
  a choice between two named, well-studied equivalence policies* rather than
  a bespoke heuristic gives us prior-art grounding for why the parameter
  exists at all, and a vocabulary (K vs. L) for describing what tuning it
  changes.

### Limitations

- Requires the *entire* Map-phase output to be materialized before Reduce
  can run any given fusion step meaningfully at the "final schema" level —
  it's designed for batch/Spark, not incremental single-document ingestion
  with immediate typed output (though the 2020 follow-up's incremental
  fuse-the-delta story partially addresses this).
- No probabilistic/statistical robustness layer at all — a single outlier
  value at a given path becomes a permanent union member forever; there is
  no analogue to ptype's anomaly modeling or a "this is probably dirty data,
  down-weight it" signal.
- Array fusion's `collapse`-to-single-body-type step is a real, acknowledged
  precision loss for positionally-meaningful arrays (tuples where position
  N always means something specific) — the paper does not offer a
  detect-and-preserve-tuple-shape mechanism.
- The K/L equivalence choice is coarse and global-per-subtree at best (even
  the 2020 interactive version applies one equivalence per nesting level a
  user has chosen to refine); it isn't a per-field discriminated-union
  detector — DU/tagged-union detection is explicitly out of scope (Tagger,
  §1, cites this same Baazizi line of work and notes "Baazizi et al. outline
  how to extend their schema inference approach to include tagged unions...
  they do not provide an implementation for this particular feature").

---

## Synthesis — what our approach does differently

Placed against this prior art, our inferrer (`from-json.ts` +
`from-json-corpus.ts`) sits at a specific, fairly narrow point in the design
space:

**Merge algebra.** Our `unifyTypes`/`mergeAll` occupies exactly the same
slot as Baazizi's `Fuse`/`LFuse` — kind-dispatched, recursive, optional-
field-on-mismatch. Unlike Baazizi, we have not stated or tested
commutativity/associativity as formal properties; this is a concrete,
low-cost thing to close given we already have fast-check property tests
(`from-json.fuzz.test.ts`) in the package.

**Enum detection.** `looksLikeEnum`'s core mechanism — distinct-count `K`
saturating well below sample count `N` — is a lightweight, corpus-scale
analogue of the *saturation intuition* that underlies JSONoid's
`AttributeCounts`/cardinality-style monoids and, more distantly, ptype's
"low entropy relative to a fixed alphabet suggests a closed type" intuition,
but implemented as a direct ratio-threshold (`K/N < 1/3` strongly enum-like,
`1/3 ≤ K/N < 1/2` needs corroborating integer-clustering evidence, `K ≥ N`
or `K > 50` rules it out) rather than either PFSM-style probabilistic
competition (ptype) or a monoid-composed cardinality estimator (JSONoid's
`HyperLogLog`). None of the surveyed prior art does *exactly* this — it's
closest in spirit to ptype's "does the data look drawn from a small closed
alphabet" framing, but arrived at from a cheap frequency-counting angle
rather than a trained generative model, and — unlike JSONoid's
`HyperLogLog`-monoid approach — uses an exact in-memory `Set`, which is a
scale ceiling worth flagging (§4's "what we could adopt") rather than a
design difference in kind.

**DU/discriminated-union detection.** `tryDetectDU`'s restriction of
candidate discriminants to fields *already* typed `enum` or all-literal
union is a narrower, cheaper version of Tagger's general CFD-discovery
approach — we never search the full space of `[A.value=const] →
[B.type=σ]` dependencies the way Tagger's relational-encoding + CFD-mining
pipeline does; we only ever check "does an already-low-cardinality field's
value partition the corpus into structurally distinct groups," verified via
Jaccard distance on the groups' field sets rather than Tagger's
functional-dependency formalism. This buys us tractability (no exponential
CFD search) at the cost of discovery power (a discriminant we haven't
already flagged as enum-shaped for other reasons can never be found).

**Dict-vs-record.** `detectDicts`'s corpus-growth-behavior signal (stable
key set → record, linearly-growing key set → dict) is architecturally
closest to quicktype's map/class problem statement but uses a
*complementary* evidence source: quicktype scores individual key strings
against a trained character-level language model with no corpus requirement
(works on one document); we score key-set *behavior across the corpus* with
no trained model requirement (needs `dictMinSamples` samples, but no
training data or language assumptions). Baazizi's K/L-equivalence parameter
is the closest *conceptual* framing — record-vs-dict is essentially choosing
L-equivalence (keep distinct shapes separate) vs. K-equivalence (merge
everything) per corpus location automatically, rather than requiring an
analyst to set the policy globally or per-subtree by hand.

**What no surveyed work does, and what remains genuinely open for us:**
none of the five approaches combines (a) corpus-scale statistical evidence
(saturation, growth-behavior) with (b) an explicit, tiered fallback from
cheap heuristics to more expensive corroborating checks only when the cheap
signal is ambiguous, in the way our `looksLikeEnum`'s "strongly saturated →
accept; borderline → check integer clustering; otherwise → reject" cascade
does. The framing our design work has been reaching for — a **tiered
heuristic model with explicit deopts** (cheap signal first, escalate to a
more expensive/specific check only on ambiguity, and *give up cleanly*
rather than guess when even the escalated check is inconclusive) and
**Zipf-aware weighting** (treating a field's value-frequency distribution
shape, not just its raw cardinality, as enum evidence — a value set with one
dominant mode and a long thin tail reads differently than one with uniform
frequency even at the same `K`) — is a genuine design direction, not
something borrowed wholesale from any single paper above. It is closest in
*spirit* to JSONoid's ablation-tested, independently-scored monoid signals
(cheap/reliable vs. expensive/overfit-prone, empirically measured) and to
ptype's probabilistic competition between alternative explanations, but
differs from both: JSONoid combines signals by enabling/disabling whole
monoids, not by escalating within a single decision; ptype's PFSM machinery
is a trained generative model, where our escalation ladder is closed-form
and untrained. This is flagged here as a design direction under active
development, not as a settled or evaluated technique — unlike the
cited papers' reported numbers, we do not yet have a discriminative-power
evaluation (à la JSONoid §4's ablation, or ptype's Jaccard/AUC comparison
table) backing our own threshold choices, which is the most concrete gap
this survey surfaces.
