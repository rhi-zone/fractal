# Inference of structure from a corpus: current theory

**Status.** This is the current state of the inference theory. It supersedes
`inference-from-first-principles.md`, which is retained as a historical record of the
cleanroom derivation but is wrong in several load-bearing places (see §13).

**Confidence, stated plainly and up front.** Nothing in this document has been tested
against real JSON data. Every result here is either analytic or simulated on synthetic
structure constructed for the purpose. That includes the results that overturned earlier
claims. What the theory has survived is adversarial checking against published literature
and against simulation; what it has not survived, because it has not faced it, is contact
with a corpus. Read every quantitative claim below as "holds in the constructed case,
mechanism verified" and not as "holds on your data." The empirical phase is scheduled and
has not begun.

The derivation history is six rounds of adversarial correspondence with an independent
model, in which four substantive convergence claims were proposed and three did not survive
simulation. The pattern is recorded in §11 because it is itself a finding: in this problem
area, claims that feel like clean unifications have a poor survival rate, and the thing that
caught them every time was running the numbers rather than inspecting the algebra.

---

## 1. The problem

Given a finite collection of observed values, produce a description of the process that
emitted them.

The answer is not determined by the data. For any finite corpus, infinitely many
descriptions are perfectly consistent with it — the corpus enumerated verbatim is one, "any
value whatsoever" is another. Consistency is free. A theory of inference here is therefore
not principally a theory of checking; it is a theory of *preference over consistent
descriptions*.

The true type is not recoverable in either direction. From positive examples only, every
proper subtype of the truth covering the observed values remains live, and every proper
supertype remains live, since the evidence against a supertype would be a counterexample and
a positive-only corpus contains none by construction. The second never closes even in the
limit, because absence is never observed.

The target is nonetheless the truth, understood intensionally: the type as defined in
source. A finite expression someone wrote, not a set of values. Exact recovery is conceded
as impossible; the theory's job is to say what the evidence warrants.

## 2. What is given

Only this: values are finite structures built from a known set of constructors, with
decidable equality. That is not a modelling assumption — it is what it means for the data to
be in a known format.

Occurrences within a value are addressable. **Addresses are not identity.** An address
locates a constituent within one value; whether two constituents in different values are
instances of the same thing is a separate claim entirely. That distinction is forced, not
stylistic: under recursion a shared thing occurs at unboundedly many addresses and no finite
address-based rule reaches them all. The conflation already fails visibly for arrays, where
two different addresses are universally treated as the same thing.

## 3. The core primitive: a fact is a scope and a claim

A **fact** consists of the set of occurrences it claims to apply to (its **scope**) and what
it claims about them.

Scope is definitional, not solved for: the scope of a fact is whatever set that fact claims
to cover, fixed the moment the fact is stated. This removes what would otherwise be a
circularity — if scope were a free variable determined jointly with the facts scoring it,
credit would have no well-defined reference set.

Correspondence is therefore not a separate entity. Asserting that occurrences at unrelated
addresses are the same thing simply *is* stating a scope. One primitive, not two.

Consequently there is no partition and no global class structure. Scopes may overlap, nest,
or cross-cut arbitrarily.

## 4. Credit and the declared baseline

A fact's **credit** is a code-length difference against a **declared baseline**: the number
of bits saved, over the corpus, by coding it under the fact rather than under the baseline.
Absolute bits, corpus-relative, never measured against an unobservable "true" source.

Three properties are load-bearing, and one that used to be listed here is not (§13):

- **Absolute bits, not fractions.** Fractions are not additive across different
  denominators, and the shape of this theory is accumulation across facts about unrelated
  parts of the data.
- **Corpus-relative.** Entropy is measured against the observed multiset. Measuring against
  the source is not merely hard but ill-posed.
- **Against a declared baseline.** Not against `top`. An unconstrained or uniform `top` is
  **provably ill-defined**: no uniform probability measure exists on a countably infinite
  set. This is a theorem, not an analogy. `top` must be a declared, explicit partition.

### 4.1 Provenance is the right axis for declaring baselines

The axis along which baselines should be declared is **provenance** — where a value came
from — not JSON kind. Three classes, each with different published support:

- **(a) Human-authored under effort economy.** Zipf's law of abbreviation applies: length
  scales with log frequency-rank, optimal-coding-derived, and demonstrated to extend to
  programming identifiers specifically.
- **(b) Machine-generated to spec** — UUIDs, timestamps, IDs. Idiosyncratic per format;
  collapses into a format registry. This justifies the registry's irreducibility rather than
  replacing it.
- **(c) World-measured** — prices, physical quantities. Benford's law and
  multiplicative-process theory apply. Verified, but narrower than it first appears: most
  JSON numeric fields are machine-assigned, not world-measured.

## 5. The gross valuation: a set function

Credit is defined over **sets** of facts, not over facts individually.

For an accepted set `S`, the gross valuation `v(S)` is the total code-length drop over the
corpus when the corpus is coded under the background induced by all of `S` together, against
the declared baseline. `v(∅) = 0`, and `v` is monotone: accepting more constraints never
lengthens the code.

`v` is monotone but **neither superadditive nor subadditive, and neither sub- nor
supermodular.** In the constructed diamond case (|U|=4000, |A|=3000, |B|=1500, |A∧B|=600,
N=1000 occurrences):

```
v(A)+v(B) = 1830.1  vs  v(AB) = 2737.0    superadditive
v(A)+v(C) = 3152.0  vs  v(AC) = 2737.0    subadditive     (C nested in A)

marginal of A given {}  =  415.0
marginal of A given {B} = 1321.9    rises   -> supermodular here
marginal of A given {C} =    0.0    falls   -> submodular here
```

This matters downstream: the game is not convex, so the core of the cooperative game may be
empty, and any intuition imported from cost-sharing settings that assumes convexity does not
transfer. It also matches the known situation in MDL pattern mining, where the unconstrained
code-table objective is neither monotone nor submodular and greedy carries no approximation
guarantee (it becomes submodular only under a fixed cardinality constraint).

### 5.1 Why per-fact credit is not a core output

Per-fact credit is not well-defined by the corpus. It is well-defined only relative to an
allocation convention.

**The totals telescope; the attributions do not.** In the diamond, both orderings are legal
in the refinement lattice, and:

```
order (A,B):  credit(A) =  415.0   credit(B) = 2321.9   credit(C) = 0.0   TOTAL 2737.0
order (B,A):  credit(A) = 1321.9   credit(B) = 1415.0   credit(C) = 0.0   TOTAL 2737.0

attribution gap: -906.9 bits, on both A and B
interaction N·log2(|U||A∧B|/(|A||B|)) = -906.9 bits    -- exact identity, both slots
```

The gap *is* the mutual information between the two refinements. The identity is exact when
the refinements are independent, which is the case where you did not need it. A chain admits
a declared general-to-specific canon that fixes attribution; a **diamond does not**, because
the lattice supplies no order between incomparable elements. And diamonds are the normal
topology: facts on one numeric field — `number`, `integer`, `>= 0`, `<= 255`,
`multiple-of-8`, an enum, a format-registry hit — are pairwise incomparable in almost every
combination.

Therefore: **the core emits the order-free total and the constitution/overlap graph. It does
not emit per-fact credit.** Per-fact numbers are a synthesis artifact under a named
allocation scheme (§7).

## 6. The charge, and the net valuation

### 6.1 The problem the charge solves

Raw empirical mutual information is always non-negative and essentially always positive on
finite samples. Simulated: under true independence (8×8 categoricals, 300 trials per cell),
the fraction of candidates clearing a "credit > 0" bar was **100.0% at every sample size
tested**. This is estimator bias — the Miller-Madow plug-in bias — and it appears with a
*singleton* candidate class and no search at all.

A within-model complexity term fixes that entirely. Prequential (Dirichlet-½ plug-in)
scoring on the same nulls:

```
N=50    MI-credit>0 100.0%    prequential>0  38.3%    mean   -0.8 bits
N=200   MI-credit>0 100.0%    prequential>0   0.0%    mean  -32.2 bits
N=1000  MI-credit>0 100.0%    prequential>0   0.0%    mean  -87.6 bits
N=5000  MI-credit>0 100.0%    prequential>0   0.0%    mean -145.0 bits

power (N=1000, y=x with prob p):  p=0.10 -> 0.5%   p=0.20 -> 100%   p=0.50 -> 100%
```

But **search multiplicity is a different failure and is not paid for by any within-model
term.** Cheap candidates (2×2, one extra parameter, single-model penalty ≈ ½·log₂N ≈ 4.5
bits), N=500, null, maximum over K independent candidates:

```
K=1     max>0 in   0.0% of runs    mean max -3.13 bits
K=10    max>0 in  24.0%            mean max -1.21
K=100   max>0 in  88.0%            mean max +1.23
K=1000  max>0 in 100.0%            mean max +4.50
```

Vacuity returns in full. It did not show up in a first sweep using expensive 8×8 candidates
only because their ~88-bit penalty swamps the max-fluctuation at moderate K — and **an open,
extensible fact vocabulary is precisely a vocabulary full of cheap candidates.** So the
charge is irreducible and separate from the baseline: a perfect baseline does nothing about
selection over many candidates.

### 6.2 Flat charges are refuted; schedule-form charges work

On a heterogeneous corpus — field S high-entropy strings |U|=2⁴⁰ all distinct, field E a
16-value enum:

```
literal on field S            gain    40.0 bits
weak true fact on field E     gain    20.0 bits   (scope 20, narrows 16->8)
strong true fact on field E   gain  3000.0 bits
```

Killing literals needs c > 40. Keeping the weak true fact needs c < 20. **The admissible
window for a flat per-fact charge is empty.** This is structural, not a calibration failure:
once fields differ in entropy, no constant price separates memorization from weak
generalization.

A **scheduled** charge `cᵢ = log₂(#candidates in fact i's class)` does separate them:

```
literal            gain   40.0   charge  40.0   NET     0.0   rejected
weak true fact     gain   20.0   charge  21.7   NET    -1.7   rejected
strong true fact   gain 3000.0   charge  14.9   NET  2985.1   admitted
```

The literal's charge cancels its gain **exactly** — log₂|U| both ways, net zero, failing a
strict `> 0` bar. That cancellation is not a coincidence; it is the stratified-prior /
NML log-candidate-count appearing as a price.

Two honest consequences. First, the weak true fact also died, and its fate turns on a
declared assumption: it is admitted iff `log₂(#scopes) < 6.2`. A six-bit change in one
declared quantity decides whether that fact exists in the output. The price schedule is a
substantive object with real consequences, not bookkeeping. Second, "credit above zero is
the only admission bar, nothing is discarded" is **gone** (§13). Admission is approximate
net-total maximization, and it discards.

### 6.3 The two-ledger separation, and negative credit

`v_net(S) = v(S) − Σᵢ cᵢ` is **not monotone**, because a charge can exceed a gain.
Monotonicity was what guaranteed nonnegative allocations. Direct check with a weak,
expensively-named fact W:

```
Shapley on GROSS game:  phi(A)=868.4  phi(B)=1868.4  phi(W)=  0.1
Shapley on NET game:    phi(A)=863.4  phi(B)=1863.4  phi(W)=-59.9
```

Negative credit in bits, on a fact that is true. The adopted resolution is **two ledgers**:

- **Gross** — monotone, nonnegative, allocation guarantees intact. Attribution runs here.
- **Charges** — a separate visible column, never allocated.
- **Net** — derived; read at admission, displayed in synthesis.

A negative net is an ingestor verdict ("uneconomical on this corpus"), not a truth judgment.

### 6.4 Memorization

§5 of the superseded document claimed memorization was disposed of structurally, by
aggregates not inheriting their parts' credit. That argument was about per-fact ranking, and
it does not survive the re-scoping. Under a pure set function with per-occurrence coding
(|U|=4000, N=1000):

```
v({A,B}, 0 literals)             =  2737.0
marginal of each literal         =     9.2 bits   (= log2 600, after both broad facts)
v(0 broad facts, 1000 literals)  = 11965.8        == TOP exactly
```

Every literal has strictly positive marginal gain against **any** accepted set; `v` is
monotone; **pure memorization alone attains the global maximum.** The re-scoping did not
create this problem — it removed the only thing managing it, and relocated the load onto the
charge. Under the schedule-form charge, memorization dies arithmetically (§6.2), and it
stays dead under the per-version Kraft bound (§8.3).

## 7. Synthesis, allocation, and cohort-relativity

Producing a single committed type, and producing per-fact numbers, is the caller's act.
All configurability lives here.

Description-length cost is **illegitimate** for scoring facts against data — it imports
arbitrary encoding choices — but **legitimate** as a criterion for choosing among
presentations of a result. That gives Occam's razor its proper home: minimizing the
description length of the *output*, not of the corpus. This resolves a real gap: a composite
can be strictly *less* credited than each of its constituents individually and still be the
preferred presentation, because it only earns credit for agreement among parts. Credit
ranking alone does not determine presentation.

Note that the core's admitted set is now structurally missing composites: in the diamond,
the conjunction receives **0.0 marginal in both legal orders**, so a marginal-gain bar
rejects the meets of accepted facts — which is to say, the composed type you would want to
emit. Synthesis must reconstruct conjunctions from the overlap graph. This is survivable but
must be a stated property, not a surprise.

### 7.1 Per-fact credit is cohort-relative — and the cohort tag is not sufficient

Allocation depends on the player set, and the player set is the admitted set, which depends
on prices. Varying only `c(D)`:

```
c(D)=200   admitted {A,B,D}   phi(A)=629.6  phi(B)=1448.3  phi(D)=922.1
c(D)=5000  admitted {A,B}     phi(A)=576.0  phi(B)=1576.0
```

The game is unchanged; the attribution moves by 53.6 bits from a change to a *price*. Hence
the conditioned invariant (test 7, §10): gross attribution is invariant under price changes
**that do not change the admitted set**. Allocating over all *submitted* facts instead would
restore unconditional invariance but reopens manipulation — a party could shift others'
credit by submitting a fact it knows will never be admitted.

**And the cohort tag does not capture what moves the number.** Three corpora in which fact A
has bit-identical evidence — same scope, same support, standalone credit 415.0 in all
three — differing only in field *y*'s structure:

```
                              |A∧B|   cohort tag   standalone v(A)   reported phi(A)
negatively associated           600      {A,B}          415.0             868.5
independent                    1125      {A,B}          415.0             415.0
y nested inside x              1500      {A,B}          415.0             207.5
```

A's reported credit ranges over **661 bits** while A's own evidence never changes, and the
cohort tag is **identical in every case**. The tag records *which* facts are in the cohort;
the number is moved by *how they interact*. Two reports bearing the same tag can assign
different credit to identical evidence.

The accurate statement is therefore stronger than "cohort-relative": **per-fact credit is a
function of the whole joint structure of the admitted set, not of the fact.** The reporting
decision this forces is open (§14.2).

## 8. The three declared objects

### 8.1 Baseline

Per §4: a declared, explicit partition, organized by provenance class. Not derivable from
the corpus.

### 8.2 Price schedule

Per §6.2: `cᵢ = log₂(#candidates in fact i's class)`, which by Kraft is a probability mass
over the vocabulary. A family of M members priced c each consumes mass `M·2⁻ᶜ`, so a family
granted mass m must price at `c = log₂(M/m)`.

### 8.3 Escrow and versioning

To let the vocabulary grow without repricing existing facts: `Σ2⁻ᶜⁱ < 1` strictly, with a
declared reserve tranche; prices immutable within a vocabulary version; reserve exhaustion
forces a declared version bump; extensions never reprice the past.

**Required property — corpus-blindness (test 8).** The schedule must not be a function of
the corpus. A corpus-conditioned price is p-hacking, and it is what makes the following
exploit an exploit rather than a legitimate discount.

**The fragmentation exploit.** The cheap move is a singleton family declared at a very low
price:

```
reserve R0 = 0.5
adversary takes half the reserve    singleton price 2.00 bits   next honest family (M=1000): 11.97 (+1.00 tax)
adversary takes 90% of the reserve  singleton price 1.15 bits   next honest family (M=1000): 14.29 (+3.32 tax)
```

The attacker's fact is admitted on 2 bits of evidence where the same fact inside a
1000-member family would need ~11, and every later family pays. Generalized, the scheme
rewards fragmenting the vocabulary into singletons.

But in MDL terms a singleton family genuinely *is* cheap — if you truly committed in advance
to one hypothesis, the low price is earned. The exploit is specifically **post-hoc family
declaration**, which is exactly the "fix the class in advance" requirement reappearing.
**With test 8 in force, the remaining cross-party reserve competition is a governance
problem, not a soundness one**, and should be labelled as such. A single-implementor
registry is self-governing until opened.

**The cross-version trade, stated as a trade.** "Never reprice the past" is purchased by
minting fresh budget per version, so cumulative declared mass exceeds 1 after the first
bump. Within a version Kraft holds; across versions the union of schedules is **not a valid
code**. Checked rather than assumed:

- **Memorization survives this.** A literal family over |U|=2⁴⁰ has 2⁴⁰ members, so at mass
  ≤ 1 its price is ≥ 40 bits, still cancelling its 40-bit gain. The per-version bound
  suffices.
- **Multiplicity calibration does not.** Every admission threshold drops uniformly by
  `log₂(cumulative mass)`. Whether that flips decisions depends on the margin distribution
  of near-threshold facts, which is corpus- and schedule-dependent and therefore
  unmeasurable until the empirical phase.

Escrow trades a **global** soundness property for a **local** compatibility property. That
may be right for an ingestor, but global conservation was the justification for the charge
being a legitimate complexity payment rather than a tunable knob, so the trade should be
recorded as one.

### 8.4 Allocation scheme

Named, and a first-class declared object rather than an implementation detail — it is where
the diamond's 906.9 bits actually land. Candidates: Shapley (symmetric, order-free; cost is
linear in the size of a compact representation *if one exists*, with representation size and
treewidth the governing parameters — **not** overlap-graph density, since sparse graphs can
have high treewidth); proportional; lexicographic-under-declared-canon.

Shapley requires **canonicalization before the game**, or credit is manipulable by
submitting aliases:

```
BEFORE (players = submissions)         AFTER (players = equivalence classes)
1 submission:  A-total 207.5           1 submission:  A 207.5
2 submissions: A-total 276.7           2 submissions: A 207.5
4 submissions: A-total 332.0           4 submissions: A 207.5
```

The canonicalization key is **the declared code** (§9.2), not corpus extension. A
corpus-extension key is ill-defined: two facts covering the identical set of occurrences can
have `v({A}) = 415.0` and `v({C}) = 2737.0`, so the merged class has two values.

### 8.5 Why three, and not fewer

Each of the three has independently resisted collapse into the others, and each collapse
attempt failed for a different reason (§11). The short version: the baseline does nothing
about search multiplicity; a perfect charge does nothing about attribution; and the
allocation scheme is required by the diamond regardless of both.

## 9. Axioms

### 9.1 P1 — normalization

> Any admission or scoring rule with coverage has a total mass. Declining to declare it
> means using an improper one.

This is Kraft doing the work. Four instances: description-language cost cannot be eliminated
but only relocated into the baseline; "prequential needs no explicit prior" is false (by
exchangeability and de Finetti, an order-free sequential predictor is a Bayes mixture — see
§11); NML regret diverges for an unstructured open class; the price schedule is a Kraft mass
over the vocabulary.

### 9.2 P2′ — code-sufficiency, for the gross ledger only

> The code a fact induces **over the declared universe** is a sufficient statistic for the
> gross ledger. Identity, equivalence, and comparison questions about gross credit reduce to
> code identity. The net ledger is *not* a function of the code — it additionally conditions
> on declared family membership.

Two qualifications, both load-bearing:

- **"Gross only" is not a hedge.** The price is indexed by declared family, not by induced
  code, so two facts inducing identical codes in different declared families receive
  different charges, hence different admission. An unqualified "the code adjudicates" would
  contradict the price schedule directly.
- **"Over the declared universe" is not a hedge either.** A fact assigns its constrained
  distribution to the occurrences in its scope and leaves the background elsewhere, so the
  induced code embeds the scope, and different scopes give different codes and different
  players. But two *derived* scopes that coincide on this corpus while differing in
  derivation rule induce the same corpus-level code and different universe-level codes.
  Stated over the corpus, P2′ re-merges them and reintroduces the §8.4 ill-definedness.

## 10. The metamorphic test suite

Nine tests, each corresponding to a degree of freedom that must be either declared or
absent. This is the operational form of "core outputs are a function of (corpus + declared
conventions)" — that formulation is not checkable as stated, because it quantifies over all
conceivable undeclared choices, and it is weakly unfalsifiable, since any violation is
repairable by declaring the offending choice. It is a ratchet, and the tests are what make
it bite.

1. **Corpus order.** Permuting the corpus produces byte-identical output.
2. **Submission order.** Permuting candidate submission order produces identical output.
3. **Clone invariance.** Duplicating or aliasing a submitted candidate produces identical
   output. Holds definitionally under §8.4 canonicalization.
4. **Meet membership.** Whether the meet of two accepted facts is itself a player is
   declared, not incidental. (It changes every allocation: φ(A) moves 868.5 → 358.7 when the
   conjunction is added as a third player.)
5. **Iteration order.** Hash and map iteration order do not affect output.
6. **Float summation order.** Identical output regardless of summation order. Named
   explicitly because it is the one that will actually bite: this system sums bits, and
   float addition is not associative.
7. **Conditioned price invariance.** Gross attribution is invariant under price-schedule
   changes *that do not change the admitted set*. The unconditioned form is false (§7.1).
8. **Corpus-blindness of the schedule.** Scoring a corpus must not change any price. A
   schedule derived by inspecting the corpus is invalid.
9. **Null-corpus vacuity, swept.** On null corpora, asserted facts ≈ 0 — **swept over
   candidate count and candidate cheapness**, not at K=1. A K=1 fixture passes trivially
   under any within-model complexity term (0.0% at N≥200) while the actual defect is
   untouched (100.0% at K=1000 with cheap candidates). A green K=1 fixture would close the
   audit with the bug intact.

## 11. Two axes, and the conservation pattern

### 11.1 Two axes, not one spine

There is a real recurring distinction — **declared vs. derived**, equivalently policy vs.
evidence — and it recurs at genuinely independent layers: core vs. synthesis; gross vs. net
(equivalently P2′, equivalently the two-ledger separation, which are one distinction stated
three ways rather than three distinctions); and the declared baseline against which evidence
is measured.

It does **not** cover everything. A second family of results is **structural** — neither
evidence nor policy, holding regardless of any declared choice:

- scope is definitional (§3)
- the corpus is not a value (§12)
- constitution as a part-whole relation (§12)
- discriminated unions are a scope decision, requiring no new machinery (§12)
- tuple-vs-array is the same DU/discriminant mechanism with position as discriminant (§12)

Describing the design as one spine would misdescribe these as instances of a distinction they
do not participate in. Two axes is the accurate statement. (This is an interpretive judgment
about the theory's organization, not a verified technical claim.)

### 11.2 The conservation pattern

**Complexity charges relocate; they do not vanish.** Instances found, each initially
presented as an elimination:

1. Two-part description-length cost was "eliminated" — it had moved into the baseline.
2. "Prequential needs no fixed class, no description language, no explicit prior" — the
   order-free plug-in *is* a Bayes mixture. Permutation test: 200 random permutations of the
   same corpus, spread **exactly 0.0 bits**, min = median = max. The order-free predictors
   are priors; the prior-free ones (ML plug-in) are order-dependent and have worse-than-½ln n
   redundancy under misspecification, which is the regime this project always operates in.
3. E-values as a universal unifier — merging under arbitrary dependence must be a *weighted
   arithmetic average*, and the weights are literally a prior over the vocabulary. The
   unifier resolved into one of the things it was meant to unify.
4. Conditional-credit-given-accepted-set as the overlap fix — it is Krimp's mechanism, and
   Krimp achieves it by *disjoint cover*, which contradicts §3's overlapping scopes.
5. FORSIED as unifying baseline and conditional credit — architecturally clean, but its
   scoring is `SI = IC/DL`, a description-length denominator and a *ratio*, both of which §4
   removed on stated grounds.
6. The re-scoping to a set function — removed the only mechanism against memorization (§6.4).
7. "The charge now lives in the objective where it can't relocate further" — its *value*
   became the free parameter, which is where it relocated.

The methodological consequence, and the reason it is recorded here rather than as a slogan:
**the correct response to an apparent elimination is to look for where the charge went, and
the way to find out is to run the numbers.** Six rounds, four convergence claims, three
refuted by simulation, none by inspection.

The corollary — "therefore choose the accounting where the payment is most visible" — is
*not* adopted as a principle. Visibility is not formalized and can conflict with
theorem-backed criteria: crude two-part codes are maximally visible and worse in redundancy
than Bayes mixtures. It is an ergonomics criterion competing with a robustness criterion, and
which should win is a live call, not a derived result.

## 12. Structural results (baseline-independent)

These hold regardless of any declared choice.

**The corpus is not a value.** Any observed value is fair game at any depth; the corpus root
is not, because we built it. Three single-value documents and one document containing an
array of those three carry identical element-level evidence. They differ in exactly one
thing: the array version contains one additional occurrence — the array itself — whose
properties are facts about the source, while the corresponding facts about the corpus are
facts about our collection procedure. Hence: if grouping is informationally real, represent
it as data.

**Constitution.** A composite fact is *constituted by* its constituents — a part-whole
relation. It prevents double-counting: the composite's bits *are* its constituents' bits seen
together. It is **not** the sole fact-to-fact relation, which the superseded document
claimed (§13); it handles structural part-whole overlap only, not two unrelated facts that
happen to explain overlapping bits.

**Discriminated unions require no new machinery.** A DU is a scope decision: one fact scoped
to "occurrences where the tag is `a`" claiming shape A, another scoped to tag `b` claiming
shape B. The correlation between tag and payload is the *reason* the facts earn credit, not a
relation stored in the structure. The distinction from a plain union is structural, not
quantitative: whether the scope is **derivable from observed constituents** or only
**extensionally enumerable**. The discriminant must be co-located within the same value;
siblinghood is the common case, not the condition.

**Tuple-vs-array is the same mechanism**, with array position as the discriminant:
`Credit_tuple − Credit_array = N·Î(position; value)`. A real unification — and under the set
function it is cleanly a comparison of two fact sets, which is what it always was. Note it
carries the same finite-sample bias as everything else, so tuple framing wins essentially
always without a charge. Fixed array length (near-zero length entropy) indicates
schema-determined arity; this shares a common cause with position-dependent content rather
than causing it — scope is conserved under ragged arrays, since Σnᵢ = N always.

## 13. Retractions from the superseded document

`inference-from-first-principles.md` retains its own retraction table, which remains
accurate for what it covers. These are additional, and they are the reason that document is
superseded rather than merely extended.

| Retracted | Why |
|---|---|
| §4 "A fact's credit is computed from the fact alone" | Credit is a set function; per-fact numbers require an allocation convention (§5.1). The 906.9-bit diamond gap is exactly the interaction no single fact earns. |
| §5 "Credit above zero is the only admission bar. Nothing is discarded." | Admission is net-total maximization and it discards (§6.2). The weak-but-true fact at −1.7 net is the intended behaviour, not a defect. |
| §5 memorization argument (aggregates don't inherit credit, so ordering handles it) | The argument was about per-fact ranking; under the set function memorization attains the global maximum (§6.4). Handled by the charge instead. |
| §6 "No other fact-to-fact relation is required" | Constitution covers part-whole overlap only. Refinement and crossing overlap are ordinary type refinement, not edge cases, and the framework needed the allocation scheme for them. |
| §4 "No description language anywhere" | Correct for scoring facts against data; **wrong as an absolute**. Kraft makes declaring a code and declaring a distribution the same act, so the cost relocated into the baseline. It is also legitimate at synthesis time (§7). |
| §9 output = facts, their credits, and constitution edges | The core emits the total and the graph; credits are synthesis artifacts (§5.1, §7.1). |
| §12 "silence where the corpus is silent" as unqualified | Still true in spirit, and now sharpened: the net bar makes it operational rather than aspirational. |

## 14. What is open

### 14.1 Theoretical — will NOT be closed by empirical work

**Pricing a never-before-submitted fact type.** `log₂(#candidates in the class)` is
well-defined for enumerable classes and undefined for a fact type nobody has invented yet.
Escrow *localizes* this to reserve-sizing at version time; it does not answer it. Corpus work
cannot answer it either — you cannot calibrate the price of a hypothesis class that does not
exist. This is the open-class problem in its fourth costume (unbounded NML regret →
stratified priors → e-merging weights → reserve sizing), and it should be expected to remain
open after the empirical phase rather than to fall out of calibration data.

### 14.2 Design decisions needed before the empirical phase

**Cohort reporting.** Given §7.1, does a per-fact credit report carry standalone gross credit
`v({i})` alongside the allocated `φ(i)`, making the interaction component visible as the
difference — or is the cohort identifier extended to cover the interaction structure
(precise, but churns on every corpus change)? This determines what the real-data audit is
permitted to compare across corpora, and so must be settled before the audit is designed,
not after it produces numbers.

Two smaller ones in the same bucket: which allocation scheme is the default (§8.4), and
whether negative-net facts are dropped before allocation runs or emitted with a signed number
(§6.3).

### 14.3 Empirical

- **Reserve policy** — how much mass to hold back per version, and the minting rule per bump.
  Note the cumulative-decay curve depends on this: `log₂(V)` if each bump mints a full
  budget, `log₂(1 + (V−1)R)` if it mints only a reserve tranche. The functional form is not
  yet pinned down.
- **Price calibration** — actual candidate-class sizes for the real vocabulary.
- **Component distribution** — how often the overlap graph actually disconnects. This is the
  real tractability story for allocation (disconnection, not sparsity), and it is measurable
  against this repo's existing test corpora.
- **Cumulative-mass measurement** — the standing falsification prediction is that cumulative
  decay stays below the admission-flip margin over a vocabulary lifetime. As stated this
  reduces to a version count, which is crisp; but the threshold it was stated against (6
  bits) is a single-instance number from one constructed example and does not bear that
  weight. The governing quantity is the margin distribution of near-threshold facts.

## 15. Relationship to other documents in this repo

`inference-from-first-principles.md` — superseded by this document; retained for its
cleanroom provenance record, its own retraction table, and its convergence check against
external prior art (JSONoid, Baazizi, Tagger, ptype, quicktype), all of which remain
accurate. Read §13 above before treating any of its numbered sections as current.

`json-inference-model.md` — older still, written with the existing
`packages/type-ir/src/from-json-corpus.ts` implementation in view. Its "never abstain, commit
to a conservative hypothesis" stance is in direct tension with this document's position that
admission discards and that the corpus is allowed to be silent. Its fact/synthesis reframing
is broadly compatible with §3 here. Fully reconciling the two is not load-bearing for this
revision and has not been attempted; where they conflict, this document is current.

## 16. Provenance of the quantitative claims

Every number in this document comes from one of the simulations run during derivation, all
on synthetic structure. None is measured on a real corpus. The literature claims —
Krimp's Standard Candidate Order (support-descending, then cardinality-descending, then
lexicographic) and Standard Cover Order (cardinality-descending, then support-descending,
then lexicographic), SLIM as the gain-ordered variant, Grünwald & de Rooij on plug-in
redundancy under misspecification, Vovk & Wang on admissible e-merging, Wasserman/Ramdas/
Balakrishnan on split-LR universal inference, Ieong & Shoham on MC-nets, Deng & Papadimitriou
on cooperative solution-concept complexity, De Bie's FORSIED — were each checked against the
sources rather than recalled, after two overclaims early in the derivation were caught that
way.
