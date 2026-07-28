# Inference of structure from a corpus: current theory

**Status.** This is the current state of the inference theory. It supersedes
`inference-from-first-principles.md`, which is retained as a historical record of the
cleanroom derivation but is wrong in several load-bearing places (see §14).

**Confidence, stated plainly and up front.** Nothing in this document has been tested
against real JSON data. Every result here is either analytic or simulated on synthetic
structure constructed for the purpose. That includes the results that overturned earlier
claims. What the theory has survived is adversarial checking against published literature,
against simulation, and against a prototyping pass; what it has not survived, because it has
not faced it, is contact with a corpus. Read every quantitative claim below as "holds in the
constructed case, mechanism verified" and not as "holds on your data." The empirical phase
is scheduled and has not begun.

The derivation history is six rounds of adversarial correspondence with an independent
model, followed by design dialogue and a prototyping pass. Four substantive convergence
claims were proposed across the correspondence and three did not survive simulation. The
pattern is recorded in §12 because it is itself a finding: in this problem area, claims that
feel like clean unifications have a poor survival rate, and the thing that caught them every
time was running the numbers rather than inspecting the algebra.

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

Three properties are load-bearing, and one that used to be listed here is not (§14):

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
from — not JSON kind. Four classes:

- **(a) Human-authored under effort economy.** Zipf's law of abbreviation applies: length
  scales with log frequency-rank, optimal-coding-derived, and demonstrated to extend to
  programming identifiers specifically.
- **(b) Machine-generated to spec** — UUIDs, timestamps, IDs. Idiosyncratic per format;
  collapses into a format registry. This justifies the registry's irreducibility rather than
  replacing it.
- **(c) World-measured** — prices, physical quantities. Benford's law and
  multiplicative-process theory apply. Verified, but narrower than it first appears: most
  JSON numeric fields are machine-assigned, not world-measured.
- **(d) Application / business-logic-shaped** — status enums, sequential and relational IDs,
  boolean flags, computed aggregates. See §4.2: the class is real and its multi-model
  treatment is confirmed for the enum-shaped half, while IDs and computed aggregates remain
  unsimulated. Lowest-confidence material in this document, though no longer unverified.

### 4.2 The fourth class, and why it does not fit the other three

**Status: identified in design dialogue, then confirmed by a toy simulation.** All three
claims below — multi-model over blended, routing viability, per-subtree selection — were
measured and held. The limitations at the end are specific and load-bearing, not boilerplate:
one of them is a measured failure mode of the routing approach itself, and two of the four
value shapes in this class were never simulated at all.

Classes (a), (b) and (c) all work by appealing to a **universal, cross-domain regularity**:
Zipf holds broadly across natural languages and extends to code; Benford holds across
measurement domains; a format registry is externally specified and shared. Business-logic
values have no such law. Nothing predicts what fraction of orders in an arbitrary e-commerce
system are `completed` versus `pending`. The regularity is idiosyncratic to one application.

**The naive fix is circular, and the resolution is that this category never needed a
corpus-derived prior in the first place.** Using the scored corpus's own empirical
frequencies as the baseline means fitting the reference to the exact data being scored
against it — the same in-sample optimism the charge machinery exists to correct everywhere
else. But the legitimate credit for these fields comes from **domain restriction scored
against `top`** (§6.6), whose reference is external and given, and whose charge already
prevents a claim that merely reads off the observed sample from earning anything. That is
non-circular and needs no external corpus.

What it does *not* reach is the finer distributional shape within the restricted domain, and
no estimator computed from the same corpus can reach it either (§6.6). **That** is what the
multi-model approach below is for: it is not an optimisation over the single-corpus method,
it is the only way past a ceiling the single-corpus method provably has.

**The real alternative is an external empirical baseline, but not a single one.** Building
the reference from a large real-world sample outside the scored corpus avoids the
circularity. But there is no single such baseline to find, because business-logic
distributions are domain-specific: an e-commerce status distribution shares nothing with a
CI/CD build-status distribution. The structure indicated is therefore **multi-model** — many
kept-separate, domain-specific empirical references, with a nearest-precedent lookup — and
**not single-model**, meaning one shared global compressed representation blending across
domains.

Measured, on five hand-built discrete distributions over a shared 10-symbol alphabet
standing in for order-status, build-status, ticket-priority, payment-status and user-role
fields (pairwise Jensen-Shannon divergence 0.32–0.76, after an initial accidental
near-duplicate pair was caught and fixed):

```
matched multi-model, held-out    1.80 bits/symbol
single pooled model              2.92 bits/symbol      penalty 1.11 bits/symbol (~62% worse)
per-domain penalty range         0.77 - 1.54 bits      consistent across all 5
```

The heterogeneity trend confirms the mechanism rather than just the outcome. Pooling
1→2→3→4→5 domains, the single model's cost climbs monotonically — 2.07, 2.25, 2.69, 2.75,
2.92 — while matched multi-model cost stays flat at ~1.8–2.1 regardless of domain count.
Blending does not merely fail to help; it degrades in proportion to how much genuine
heterogeneity it is asked to absorb.

**Routing is architecturally separable from representation, and it works given enough
observations.** How a field is matched to its domain-specific baseline — nearest-neighbour
lookup, a trained classifier, something else — is a separate choice from whether the
baselines are kept separate, and the options have genuinely different prerequisites
(unsupervised clustering needs no labels; a trained classifier typically needs labelled or
pseudo-labelled data). A KNN-style router (empirical distribution over n observations, pick
the reference cluster with lowest JS divergence) on well-separated domains:

```
n=1   40%      n=5   92%      n=20+  100%
n=2   72%      n=10  99%
```

**Named risk: close-cluster confusability does not resolve with more data.** This is a
measured failure of the routing approach, not a sampling artifact, and it is called out
separately because it behaves qualitatively differently from ordinary small-sample error. A
deliberately-close pair of domains (JS = 0.007, against ≥ 0.32 between the genuine domains)
stayed stuck at **93% / 85% accuracy even at n=200**, while dissimilar domains reached 100%
by n=20. Dissimilar domains converge; near-duplicate domains plateau. Any deployment will
therefore have a population of field pairs that routing simply cannot separate, no matter
how much data accrues, and the design needs an answer for what happens to those — not more
samples. Open (§15.3).

**Baseline selection is per-subtree, not per-document** — consistent with, and arrived at
independently of, the tree-of-lattices structure in §7. Measured on a 300-record synthetic
corpus with `status` drawn from the e-commerce cluster and `priority` from the
ticket-priority cluster in the same records: per-field routing identified both correctly and
cost **2.05 bits/symbol**, against **3.17** for the best available single whole-record
baseline and 3.38–5.84 for every other single candidate. Per-subtree selection beats *any*
single whole-document choice, including the best one available in hindsight.

**Limitations, all specific to what was and was not simulated:**

- **Clusters were cleanly separated by construction.** Real domain distributions are unlikely
  to be this separable, and the close-pair failure above is probably representative of some
  real fraction of actual domains rather than a contrived edge case.
- **Accuracy was scored against ground-truth domain labels**, which a real deployment does
  not have. This measures routing quality under an oracle, not routing quality in situ.
- **Real per-field sample sizes are often below the n=10–20 threshold** these numbers show is
  needed for reliable routing.
- **Only categorical/enum-shaped fields were modelled.** This class also contains sequential
  and relational IDs and computed aggregates, and *neither was simulated at all* — the
  confirmation does not extend to them.
- **Only JS divergence and cross-entropy were tried.** No comparison against raw KL,
  chi-squared, or Wasserstein (which is the natural choice for ordinal fields like
  `priority`, and was not tested).

### 4.3 The same diagnosis, reached independently, used to justify the opposite conclusion

Baazizi, Colazzo, Ghelli & Sartiani (*Parametric Schema Inference for Massive JSON
Datasets*, VLDB J. 28:497–521, 2019) construct an information measure for their own
precision-versus-conciseness question and then decline to use it. Their footnote 10: with n
keys, the space of shape-sets has size 2^(2ⁿ); a label-reduced type identifies exactly one
point and so carries 2ⁿ bits; a kind-reduced type is compatible with many points and carries
fewer, computable per type. That is credit-against-`top`, built from scratch. Their reason
for abandoning it:

> "We do not pursue this avenue because this model embeds the unrealistic idea that every
> distribution of shapes has the same probability, and because we do not believe that this
> model, although mathematically coherent, is a useful model of the information needs of the
> data analyst."

The first clause is **§4's result, derived independently**: a uniform reference over the
hypothesis space is the wrong baseline. Two groups reaching it from unrelated directions is
mild evidence it is right.

The clauses need separating, because this framework answers them in different places and
with different confidence:

- **On the uniform-prior clause — answered, with a scope limit.** §4.2 is exactly the
  non-uniform alternative they did not pursue: baselines derived empirically from external
  real-world corpora and routed per domain, rather than any uniform or *a priori*
  mathematical prior. The measured penalty for blending domains (1.11 bits/symbol, §4.2) is
  direct evidence that the uniform-ish single model they rejected really is the wrong
  reference. **But the scope does not match theirs.** §4.2 was tested on *value*
  distributions over a small alphabet; their footnote is about *shape* distributions over
  2ⁿ key-subsets. Applying the multi-model answer to their exact question is an untested
  extension, not a result. It is the right shape of answer; it is not yet an answer to their
  instance.
- **On the usefulness clause — not answered by §4.2 at all**, and it would be a mistake to
  claim otherwise. That clause says a *correct* information measure still may not model what
  an analyst needs, which is a claim about the objective's relevance, not its calibration.
  This framework's response is structural rather than statistical: bits measure evidence, and
  what an analyst needs is policy applied at synthesis (§8), with the `(credit, charge)` pair
  kept un-collapsed precisely so the caller can pick their own tradeoff point (§6.4). The
  framework does not claim bits are the analyst's utility function. It claims the two should
  not be conflated, which is a version of their own point rather than a rebuttal to it.

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
allocation scheme (§8).

This same incomparability is why numeric thresholds are the wrong shape of knob (§7.4).

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

A **scheduled** charge does separate them:

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
the only admission bar, nothing is discarded" is **gone** (§14). Admission is approximate
net-total maximization, and it discards.

### 6.3 The charge is situational, not a fixed formula

Earlier drafts of this document stated the charge as `cᵢ = log₂(#candidates in fact i's
class)` without qualification. That is one case of a more general quantity, and stating it
as the definition is wrong.

The charge is `L(model)`: **however many bits it costs to tell a receiver which model you are
using, given what they already share with you.** This is the same two-part transmission-cost
logic the rest of the document already runs on, applied honestly. Two scenarios, which are
genuinely different situations rather than two terms that always sum:

- **Shared registry.** Both parties already hold a fixed, agreed registry of candidates. The
  model's internal structure is already known to the receiver, so nothing about it needs
  re-transmitting and the charge is a **pointer cost**, `log₂N`.
- **No shared entry.** The model is genuinely new. There is no pointer to send, so the **full
  specification cost** has to be paid instead.

That these are different quantities rather than interchangeable ones is easy to make
concrete: take a registry of N=2 in which one candidate is a full statistical language
model. The pointer cost is 1 bit. The specification cost of that candidate is enormous.
`log₂N` undercharges it by whatever the difference is, and no amount of careful calibration
of `log₂N` closes the gap, because it is measuring the wrong thing.

Consequence for the price schedule (§9.2): the schedule prices the *registry* case. A
vocabulary extension that introduces a genuinely new model is not priced by the pointer cost
of its family, and the escrow mechanism governs registry membership rather than
specification cost. Whether these want to be two ledgers or one with a case split is not
settled here.

### 6.4 Never collapse `(credit, charge)` to a scalar

The pair is the primitive. `net = credit − charge` is derived, and derived quantities are
for reading, not for deciding on.

This is not a convenience preference. Collapsing to net **destroys information that is
present in the pair**, and the clearest case is at the two extremes of the abstraction range:

```
top     (no claim made)                 (credit=0, charge=0)   ->  net 0
literal (maximally specific claim)      (credit=X, charge=X)   ->  net 0
```

These are identical under net and are completely different points in the space, for
structurally different reasons. `top`'s zero is **trivial**: no claim was made, so there is
nothing to compare and nothing to pay for. The literal's zero is an **exact derived
cancellation**: specifying the maximally precise claim costs exactly what it saves. One is
an absence, the other is a coincidence of two large numbers, and a scalar cannot tell them
apart.

Keeping the pair makes the knob trivial to build. Maximize credit ignoring charge → the
literal end. Minimize charge → `top`. Any tradeoff between → the genuine middle. Collapse
first, and that knob cannot be constructed at all, because the axis it would turn has been
projected away.

This is the operational form of the **two-ledger** semantics:

- **Gross credit** — monotone, nonnegative, allocation guarantees intact. Attribution runs
  here.
- **Charge** — a separate visible column, never allocated.
- **Net** — derived; read at admission, displayed in synthesis, never the unit of decision.

The two-ledger split is additionally forced by a second, independent fact:
`v_net(S) = v(S) − Σᵢ cᵢ` is **not monotone**, because a charge can exceed a gain, and
monotonicity was what guaranteed nonnegative allocations. Direct check with a weak,
expensively-named fact W:

```
Shapley on GROSS game:  phi(A)=868.4  phi(B)=1868.4  phi(W)=  0.1
Shapley on NET game:    phi(A)=863.4  phi(B)=1863.4  phi(W)=-59.9
```

Negative credit in bits, on a fact that is true. Under two ledgers a negative net is an
ingestor verdict ("uneconomical on this corpus"), not a truth judgment.

The general lesson is recorded as a methodological pattern in §12.3, because the same
mistake was then made a second time inside the charge itself (§6.3).

### 6.5 Memorization

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
stays dead under the per-version Kraft bound (§9.3).

### 6.6 Worked case: domain restriction, and the ceiling one corpus can reach

The most common fact family in practice — "this field is restricted to exactly these K
observed values, out of D possible" — is worth working through explicitly, because it
instantiates almost every abstract claim above and settles an open question (§15.3).

Scored against `top`, which is external and given and therefore untouched by the corpus
being scored:

```
credit  =  N · log₂(D/K)
charge  ≈  K · log₂(D/K)            leading term of log₂ C(D,K), i.e. §9.2's schedule
                                     applied to the class "K-subsets of D"
net     =  (N − K) · log₂(D/K)      exact, given the leading-term charge
```

The charge is not a separate device bolted on here; it is the §9.2 price schedule evaluated
for this family, since the number of candidates in the class is exactly `C(D,K)`.

**Both degenerate ends land precisely on §6.4's pair, which is the point of §6.4 made
concrete.** With D = 10⁶ and N = 1000:

```
K = D    no restriction        credit      0.0   charge     0.0   -> (0, 0)   = top
K = N    every value distinct  credit   9965.8   charge  9965.8   -> (X, X)   = literal
K = 50   genuine restriction   credit  14287.7   charge   714.4   -> net 13573.3
K = 3    tight enum            credit  18346.6   charge    55.0   -> net 18291.6
```

`top` and pure memorization both net zero for structurally unrelated reasons — an absence
against an exact cancellation — exactly as §6.4 argued in the abstract. Anything that
collapsed to net first would be unable to tell the first and second rows apart.

**Under the exact charge the cancellation is better than break-even.** Using `log₂ C(D,K)`
rather than its leading term, memorization at K = N nets **strictly negative**, converging to
−log₂e ≈ **−1.443 bits per occurrence** (measured: −1.143 at N=10, −1.396 at N=100, −1.436 at
N=1000, −1.435 at N=10000). The leading-term approximation understates the case against
memorization; the exact schedule rejects it outright rather than merely declining to reward
it.

**`K ≪ N` is a static property of one snapshot, not a trajectory** — but it is not a
property of `(N, K)` alone. `D` is the dominant term and a 33-bit universe is enough to flip
`description` from reject to keep; see §17.5 before relying on the framing below. It is tempting to
describe the discriminating signal as "K stays flat as N grows," and that phrasing is wrong
in a way that matters. A trajectory would require either watching K accumulate over an
ordered sequence within one corpus — reintroducing order-dependence, in conflict with tests 1
and 2 (§11) — or comparing corpora of different sizes, which requires external data. Neither
is needed. `net = (N − K)·log₂(D/K)` is evaluated **once**, at the single observed (N, K)
pair: count total occurrences, count distinct values, done. Memorization (K ≈ N) and genuine
restriction (K ≪ N) are both static facts about one snapshot, and the formula separates them
without anything sequential. What that single evaluation *cannot* do without a declared `D`
is say where the boundary sits, and §17.5 measures how much work that declaration is doing:
the resulting ordering is robust to it (ρ = 0.989 across a 235-fold change in log₂D) and the
`net > 0` verdict is not.

**This is the ceiling reachable from one corpus alone**, which resolves the circularity
question of §15.3. The credit above is non-circular because its reference is `top` — external
and given, not fitted to the data being scored. Circularity re-enters only if one tries to
claim *additional* credit beyond domain restriction, by also fitting the distributional shape
*within* the K values ("and moreover they are 80/15/5, not uniform among the three") using an
estimator built from the same corpus. **Empirical frequency, Bayes-mixture, prequential and
KT estimators were all considered for this and all rejected** — not because they are wrong in
general (§6.1 uses prequential correctly for a different purpose) but because every one of
them derives its predictive component from the exact data being scored, which is the thing
that needed fixing. Changing which estimator does the fitting does not change that it is
fitting.

So: **domain-restriction credit against `top` is the legitimate ceiling achievable within a
single corpus.** Credit for the finer distributional shape requires genuinely external
data — which is precisely what the multi-model routing of §4.2 supplies, by pulling in *other*
corpora. That is not a cleverer trick performed within one dataset; it is the recognition
that no such trick exists.

#### Against published practice: a cardinality threshold cannot express this

Baazizi et al. (§16) propose the same decision, cut on a threshold over K alone: "the fusion
of two enumeration types would produce their union if the size of the result is less than k,
while it would produce the generic type `Str`... when the size is above k." Since the rule
never inspects N or D, §6.6 predicts it must fail in both directions. Tested (D = 10⁶,
their k = 100):

```
case                                 N          K     N/K   theirs    §6.6 net    §6.6
memorization, K just under k        50         50     1.0   keep           -68   reject
same K, mild repetition            150         50     3.0   keep         1,361   keep
same K, heavy repetition       100,000         50  2000.0   keep     1,427,989   keep
real restriction, K just over k 10,000,000    500 20000.0   DISCARD 109,651,645   keep
```

Rows 1–3 hold K fixed at 50 and vary only N: the threshold rule returns `keep` for all
three, including the row where every occurrence is distinct and the "enum" is the sample
read back. Row 4 is the opposite error — a restriction worth **110 million bits** discarded
because K exceeds an arbitrary cutoff.

**No fixed k avoids this**, which is a construction rather than an empirical observation:
for any k, take K = N = k−1 for a false positive, and K = k+1 with large N for a false
negative. Verified at k = 10, 100, 1000, 10000. This is the §6.2 result again in a different
costume — a threshold on one variable is the enum-shaped analogue of a flat charge, and
fails for the same reason: the quantity it needs to separate is not a function of the
variable it looks at.

The reason their rule reads K alone may be structural rather than an oversight: within their
line of work, per-path occurrence counts (N) and distinct values (K) live in separate papers
and are never available together (§16.3). A rule can only cut on what its inputs contain.

#### The ratio form is better, and still not right

Most practice does not cut on K alone. It cuts on the **ratio** `K/N` against a constant —
standard in data profiling and query optimisation, and what this repository already does
(`looksLikeEnum`: `K/N ≤ 1/3 → enum`, `≥ 0.5 → not enum`). That uses both N and K. It does
not use D, and §6.6 says the required ratio is a function of D:

```
D/K              required N/K
2                       1.959
16                      1.338
256                     1.174
10,000                  1.105
1,000,000               1.070
2^40                    1.035
```

The threshold that a fixed ratio needs to be is not fixed — it spans 1.03 to 1.96 across
realistic domain sizes. Concretely, three fields with **identical N, identical K, identical
ratio** and different domains:

```
field                        N     K    K/N            D   req. N/K    §6.6 net    §6.6
uuid-ish, huge domain      150   100  0.667         2^64      1.000     8,603.4    keep
byte-valued field          150   100  0.667          256      1.790       -39.4  reject
small enum domain          150   100  0.667          128      2.624       -40.0  reject
```

Any ratio rule returns one verdict for all three. §6.6 splits them.

**Two honest notes about this repository's own rule.** First, its 1/3 cutoff is
*conservative but safe*: `N/K ≥ 3` sits above the maximum required ratio (≈1.96 at D/K = 2),
so it produces **no false positives** at any domain size — swept over D from 128 to 2⁶⁴ at
K = 100, the rule and §6.6 agree everywhere it fires. Its errors are all false negatives, in
the band `1.0 < N/K < 3`, which is wide precisely for the high-cardinality domains where
restriction is most valuable. Second, the separate `K > 50 → not enum` cutoff **is** the
K-only form, and the criticism above of Baazizi et al.'s threshold applies to it unchanged.

The boundary the net actually draws is `N > log₂C(D,K) / log₂(D/K) ≈ K·(1 + log₂e/log₂(D/K))`:

```
K            D/K        exact N*     N*/K
10       100,000.0          10.7     1.069
1,000      1,000.0       1,144.1     1.144
10,000       100.0      12,159.4     1.216
100,000       10.0     141,178.9     1.412
```

So the criterion is "N must exceed K by a margin that grows as the restriction weakens" — a
strong restriction is nearly free once N > K, a weak one demands substantial repetition to
pay for itself. (The closed form is accurate for K ≪ D and degrades as K approaches D: at
D/K = 2 it predicts 2.44 against an exact 2.00.) A rule that reads K alone cannot express
any of this.

### 6.7 The ratio criterion, derived — and what the closed-domain fact was overclaiming

§6.6 glossed its criterion as `K ≪ N`. That gloss is **not implied by the formula**, and the
mismatch is exact rather than occasional. Derived directly rather than sampled.

**The boundary in closed form.** With `L = log₂(D/K)`, `c = log₂e`, `ρ = K/N`, and the
standard expansion `log₂C(D,K) = K·L + K·c − ½log₂(2πK) + O(K²/D)`:

```
net = (N−K)·L − K·c + ½log₂(2πK)
net > 0  ⟺  (1−ρ)L > ρc          (dropping the O(log K) term)
         ⟺  ρ < L/(L + log₂e)         equivalently   L > log₂e · ρ/(1−ρ)
```

So the admissible ratio is **not a constant**; it is `L/(L+c)`, a function of the declared
headroom:

```
L = log₂(D/K)      max K/N
0.5                 0.257
1.44                0.500
10                  0.874
23.22               0.941   <- npm description sits exactly here
100                 0.986
→ ∞                 → 1
```

**`net > 0` does not imply `K/N` is small.** As `D` grows the bound tends to 1, and in the
limit the criterion degenerates to `K < N` — "at least one value repeats." Confirmed against
the exact formula: for npm `description` (N=1094, K=1030, ρ=0.9415) the required headroom is
`c·ρ/(1−ρ) = 23.22` bits, giving `log₂D > 33.23`; the exact net is −8.2 at `log₂D = 33.0`
and +55.8 at 34.0. In `D/N` terms the condition is `log₂(D/N) > c·ρ/(1−ρ) + log₂ρ`.

**Why — and this is structural, not a missing term.** The dictionary costs `≈ K·L` and each
occurrence saves `L`, for `N·L` total. *Both sides scale with `L`*, so `L` cancels to first
order and `net ≈ (N−K)·L − K·c`. The leading question is only whether occurrences outnumber
dictionary entries. `D` survives solely in `K·log₂e`, a **fixed ~1.443 bits per entry that
does not grow with `D`**. Compression is therefore bought by *any* repetition; it never
required *concentrated* repetition. `K ≪ N` was always an informal reading of a formula that
never encoded it.

The formula is also blind to the shape of the counts, which the same reading assumed. Two
corpora, identical `(N, K, D)`:

```
A: one value ×65, 1029 singletons     N=1094 K=1030   net = 1975.8
B: 64 values ×2,   966 singletons     N=1094 K=1030   net = 1975.8
```

Identical credit, though only A has a genuinely repeated member.

**What is actually missing is a claim, not a term.** "The domain is exactly S" asserts
`P(novel) = 0` — the strongest claim available, since a code assigning probability zero to an
event that occurs costs unbounded bits. Nothing in `net` tests it, yet **the corpus carries
direct evidence about it**: Good–Turing's missing-mass estimate `p̂ = n₁/N`, where `n₁` is the
number of values seen exactly once. **The quantity that matters is `n₁/N` — singleton
*mass*, the share of occurrences — not `n₁/K`, the share of members.** For `description`,
those 997 singletons are 91.1% of *occurrences*. The fact being scored asserts 0; the corpus
says 0.911.

Keeping those two apart is not pedantry, it is the whole content of the criterion, and
conflating them yields a rule that is wrong on both sides. Real vocabularies are skewed —
§4.1(a)'s own Zipf material says so — so a genuine closed vocabulary routinely has *most of
its members* appear once:

```
field                                     N        K     n₁    n₁/K     n₁/N   verdict
npm .license (real SPDX vocabulary)    1084       38     21     55%    1.94%     KEEP
counts: [856,110,26,18,10,5,5,5,5,4,4,3,3,3,2,2,2, 1×21]
near-constant field w/ rare noise  1,000,000      51     50     98%   0.005%     KEEP
npm .description                       1094     1030    997     97%    91.1%   reject
```

By `n₁/K` the first two look like free text and are not. A field that is 999,950 copies of
one value plus 50 one-off oddities has 98% of its *members* appearing exactly once and is
obviously not free text; by mass it is 0.005% novel. `n₁/N` separates all three correctly.
The enum-vs-free-text framing is itself the wrong dichotomy — none of these fields is
"an enum" or "free text" as a kind. What the criterion measures is escape rate: how much
occurrence mass sits outside any finite domain you could name.

**Replacing the fact fixes the criterion.** Score a *domain-with-escape* fact instead: each
occurrence pays `H(p)` for an escape flag, then `log₂K` if in `S` or `log₂D` if novel.

```
net_esc = N(1−p)·L − N·H(p) − log₂C(D,K)
        = L·( N(1−p) − K ) − N·H(p) − K·c + ½log₂(2πK)
```

The sign is governed by `N(1−p) − K`, which is **D-free**. With `p = n₁/N`:

```
net_esc > 0   ⟺   N(1−p) > K   ⟺   K/N < 1 − n₁/N   ⟺   N − n₁ > K
```

**Non-singleton occurrences must outnumber distinct values.** That is a genuine ratio
criterion, it is independent of the declared universe, and it is what `K ≪ N` was reaching
for. Required cases, at `log₂D` = 34 through 8000 (verdict identical throughout):

```
case                                  N     K     n₁    n₁/N      net       net_esc   verdict
exact memorization K=N             1000  1000   1000  100.0%   −1,436       −55,471    reject
npm .license (real counts)         1084    38     21    1.9%   61,404        60,021      KEEP
near-constant + rare noise      1000000    51     50   0.005%  huge      58,320,828      KEEP
uniform 3-value enum               1000     3      0    0.0%   62,226        62,226      KEEP
npm description (real shape)       1089  1030    997   91.6%   +1,706       −52,579    reject
mixture: 50 specials + text        1085   950    900   82.9%   +5,940       −43,472    reject
```

Empirical verification against real corpora, including the calibration of `p̂` itself, is in
§17.7. Two caveats travel with this. First, it is a **change of fact vocabulary, not a repair
of the arithmetic** — `net` was always a correct statement about compression, and the
closed-domain *fact* was the thing overclaiming. Second, `n₁/N` is a same-corpus estimator,
so it grazes §15.3's circularity bar; the defence is that it estimates a scalar from the
frequency-of-frequencies rather than a predictive distribution over values, and that the
closed-domain claim already asserted `p = 0` about the same data. That defence is arguable
and the boundary is now softer than §15.3 states.

### 6.8 The escape fix breaks under corpus duplication, and cannot be repaired from counts

§6.7's criterion is **conditional on the corpus being an independent sample**, and that
condition is violated in exactly the way §17.2 already documented. This is not a caveat; it
is a break.

**The sharpest case: a maximally open source, duplicated once.** Take `M` records with every
value distinct — the most open-ended field constructible, true novelty as high as it gets.
Append an exact copy. Now `N = 2M`, `K = M`, every count is 2, `n₁ = 0`:

```
M          ORIGINAL (N=M, K=M, n₁=M)              DUPLICATED (N=2M, K=M, n₁=0)
        p̂      verdict       net_esc            p̂      verdict        net_esc
100     1.000  reject         −5,875            0.000  ACCEPT          +5,596
1000    1.000  reject        −55,471            0.000  ACCEPT         +52,598
10000   1.000  reject       −521,542            0.000  ACCEPT        +492,704
100000  1.000  reject     −4,883,296            0.000  ACCEPT      +4,594,776
```

`p̂` goes from 1.000 — correct, every value seen once — to **0.000**, the maximally wrong
answer, and the verdict inverts at every scale. The source did not change; a mechanical copy
of the data did.

**Why it is invalidation and not bias.** Good–Turing's `n₁/N ≈ P(novel)` rests on a
leave-one-out argument: hold out each observation and ask whether it is novel against the
rest. Under exact duplication every held-out point still has its twin in the sample, so it is
never novel and leave-one-out returns 0 *by construction*. Duplicate pairs are perfectly
dependent, which violates the exchangeability the argument requires. Note also that raw `net`
inverts identically here — **the `n₁` term buys nothing on this construction**; it is no
worse than §6.6 and no better.

**The collapse is exact and discontinuous.** Duplicating a corpus `r` times maps counts
`{c_v} → {r·c_v}`, so `N → rN`, `K` unchanged, and `n₁ = #{v : r·c_v = 1} = 0` for every
`r ≥ 2`. The condition `N − n₁ > K` becomes `rN > K`, trivially true. On the real npm
`description` shape:

```
r    N      K     n₁      N−n₁>K      net_esc
1    1089   1030  997     False       −52,579     <- correct
2    2178   1030    0     True        +60,503     <- one duplicate flips it
3    3267   1030    0     True       +119,299
```

`N` inflates smoothly; `n₁` goes 997 → 0 at `r = 2` and stays there. The statistic does not
degrade under duplication, it falls off a cliff.

**Partial duplication is undetectable and still breaks it.** Perfect duplication leaves a
signature — every count divisible by `r`, so `gcd` recovers `r` exactly. Realistic
duplication (pagination overlap, join fan-out) does not:

```
fraction duplicated   N      n₁    gcd   verdict
0.0                   1089   997   1     reject   <- correct
0.3                   1416   701   1     reject
0.5                   1654   477   1     KEEP     <- already wrong, gcd=1
1.0                   2178     0   2     KEEP     <- wrong but detectable
```

At `f = 0.5` the verdict has already flipped while `gcd = 1`. The detectable case is the one
that does not occur in practice.

**Impossibility, not an implementation gap.** Duplication leaves the normalised counts
`{c_v/N}` and `K` unchanged, so the duplication-invariant statistics are exactly the
functions of `({c_v/N}, K)` — they cannot use `N`. But the criterion *must* use `N`:
`K = 1030` at `N = 1094` is one-off free text, and `K = 1030` at `N = 10⁹` is a genuine
closed 1030-value domain, and those need opposite verdicts. Therefore:

> **No statistic of the value counts is both a valid missing-mass estimate and
> duplication-invariant.** Missing mass is inherently a claim about how many *independent*
> draws were observed, and duplication corrupts exactly that.

Stated at the level of the data: a corpus `B` = corpus `A` duplicated `r` times, and a
genuine i.i.d. corpus `C` of size `rN` realising the same counts, are **the same multiset of
values**. Nothing computed from the values can distinguish them, because there is no
difference in the values. What separates them is provenance — which fetch, page, or join row
each record came from — which is not in the data and has to be supplied.

**Part of §6.7's verification was circular, and the headline number is inflated.** Of the 107
paths, 20 have `n₁ = 0`; 18 of those are in api-examples, the corpus §17.2 found duplicated.
Worse, **the validation metric fails in the same direction as the criterion**: where a corpus
is duplicated, the held-out half contains copies of the training half, so held-out coverage
is trivially high.

```
group                              paths   median n₁/N   median held-out coverage
api, n₁ = 0 (duplication-suspect)     18          0.000                     100.0%
api, n₁ > 0                           28          0.974                       2.0%
npm, n₁ = 0                            2          0.000                     100.0%
npm, n₁ > 0                           59          0.438                      48.0%
```

Every `n₁ = 0` path scores exactly 100% coverage *by construction*. Criterion and ground
truth are fooled by the same artefact, so their agreement on those paths is not evidence.
Splitting by corpus:

```
subset               paths   net acc   net_esc acc
npm (clean)             61     65.6%         96.7%
api (duplicated)        46     82.6%        100.0%
all                    107     72.9%         98.1%
```

**The defensible figure is npm's 96.7%, not the 98.1% headline** — the api subset's 100%
measures nothing. §6.7's improvement over `net` is real (65.6% → 96.7% on clean data) but
smaller than reported.

**The full frequency-of-frequencies spectrum does not help with this**, though it is a real
improvement on a different axis. Under duplication the spectrum simply stretches
(`n'_{rj} = n_j`), which is detectable for uniform `r` and not otherwise — the same
`gcd` result in another notation. The separate concern that `n₁` alone is a crude cutoff is
**correct but orthogonal**: values seen 2–3 times are also weak evidence when `K` is large,
and a Simple-Good–Turing fit over the whole spectrum would grade them rather than treating
`n₂` as fully reliable. That improves the estimator's accuracy; it does nothing for
duplication-sensitivity, because every `n_j` shifts together.

**`K/N` in place of `n₁/N`: a better criterion, but not a duplication fix.** `K/N` was
proposed on the grounds that it degrades proportionally under duplication (`K` fixed, `N`
scaled, so `K/N → (K/N)/r`) where `n₁/N` collapses to a hard 0. That is true **of the
estimator's value** and mostly false **of the decision it drives**. With `p = K/N` the
leading-order condition `N(1−p) > K` becomes simply **`N > 2K`**. Tested against everything
already established:

```
case                        N        K    n₁/N     K/N    n₁ rule   K/N rule    want
npm license (real)       1084       38  0.0194  0.0351     accept     accept   accept
npm description (real)   1089     1030  0.9155  0.9458     reject     reject   reject
near-constant + noise 1,000,000     51  0.0001  0.0001     accept     accept   accept
exact memorization       1000     1000  1.0000  1.0000     reject     reject   reject
```

**No regression on any of the four** — that much holds. And on the 107 real paths it is
strictly better than the `n₁` rule:

```
subset              n₁ rule                    K/N rule
npm (clean)         93.4%  FA=4  FR=0          98.4%  FA=0  FR=1
all                 96.3%  FA=4  FR=0          99.1%  FA=0  FR=1
```

Zero false admissions against four. On its own merits `K/N` is the better criterion and worth
adopting for that reason.

But it does not survive duplication either:

```
duplication sweep                  n₁ rule breaks at   K/N rule breaks at
1000-unique construction                       r = 2               r = 3
real npm description                           r = 2               r = 2
```

One extra level of tolerance on the extremal construction, **none on real data**. The reason
is structural: `N > 2K` inverts once `rN > 2K`, i.e. at `r > 2K/N₀`, so the break point
depends on how repetitive the field already was — and a field that is already somewhat
repeated breaks immediately. Any criterion that uses `N` and is monotone increasing in `N`
inherits this, `K/N` included. It changes the constant, not the failure.

**Clarification: the "K/N rule" above already *was* a fixed, D-free threshold.** Substituting
`p = K/N` reduces `N(1−p) > K` to `N > 2K`, i.e. **`K/N < 0.5`** — a constant that fell out of
the algebra rather than being chosen. At `r = 2` on the unique construction `K/N = 0.500`
exactly, so `2M > 2M` is false and it **rejects**. "Breaks at `r = 3`" meant correct through
`r = 2`, wrong from `r = 3`; it never accepted at `r = 2`.

**A stricter constant buys a duplication budget, not immunity.** On that construction
`K/N = 1/r` exactly, so any threshold `c` is defeated at `r > 1/c`:

```
r        K/N     c=0.05    c=0.1    c=0.2    c=0.5
2      0.500     reject   reject   reject   reject
3      0.333     reject   reject   reject   ACCEPT
10     0.100     reject   reject   ACCEPT   ACCEPT
20     0.050     reject   ACCEPT   ACCEPT   ACCEPT
25     0.040     ACCEPT   ACCEPT   ACCEPT   ACCEPT
```

So `c = 0.1` tolerates ten copies and fails at eleven. That is a real, quantified robustness
margin and it is worth having, but it is not a fix — it rescales the failure.

**Every reasonable constant handles the four established cases** (`c` ∈ {0.05, 0.1, 0.2, 0.3}
all correct), though `license` sits at `K/N = 0.035`, so anything below ≈0.036 would wrongly
reject a genuine vocabulary. The usable band has a floor.

**But on real data, strict thresholds are worse, and `c ≈ 0.5` is near-optimal** — which is
the finding that matters here:

```
accuracy vs held-out coverage    c=0.05   c=0.1   c=0.2   c=0.3   c=0.5   |  net@2^64
npm (clean, n=61)                 63.9%   63.9%   65.6%   73.8%   98.4%   |     65.6%
all (n=107)                       72.9%   74.8%   79.4%   85.0%   99.1%   |     72.9%

best fixed threshold on clean npm: c = 0.53 → 98.4%
```

The intuition that a tight ratio bound is obviously right holds for four hand-picked cases
and fails across 107 real fields: many genuinely-restricted fields sit between `K/N` of 0.2
and 0.5, and a strict cutoff rejects them. The value the escape algebra derived, 0.5, is
within 0.03 of the empirical optimum.

**Reconciliation with the discovery-rate model: no contradiction — an undeclared free
parameter.** The model says a closed domain should show discovery tapering off, so `K/N = 0.5`
(half of all occurrences still new) ought to be a decisive reject, not a boundary. The
empirical sweep said `c = 0.5` is optimal. Both are right, because "genuine restriction" was
defined here as *held-out coverage ≥ 50%* — a bar chosen arbitrarily and never justified.
Move it and the optimal constant moves with it, near-linearly:

```
coverage cutoff   best c   acc at best c   acc at c=0.1
30%                0.765          100.0%          45.9%
50%                0.535           98.4%          63.9%
70%                0.380           93.4%          83.6%
80%                0.230          100.0%          96.7%
90%                0.190          100.0%         100.0%
```

At a strict reading of "closed domain" — 90% of future values already seen — the optimal
threshold is **0.19** and `c = 0.1` scores **100%**, exactly matching the discovery-rate
intuition. At the weak reading used earlier (coverage ≥ 50%, i.e. merely "more likely than
not already seen") a loose constant is correct. The two claims answer different questions and
the constant `c` is silently encoding which one is being asked.

**It is not a small-N effect.** The 0.2–0.5 band holds 21 real paths, *all* with coverage
≥ 50%, spanning `N` from 124 to 10,354 (median 303) — including `keywords[*]` at
N = 10,354, K = 3,374. They are semver ranges (`devDependencies.*`), file paths
(`main`, `types`, `module`, `exports.*`), version strings and npm usernames: vocabularies
that are genuinely **unbounded but heavily head-skewed**, so future values are often
previously-seen ones without the domain being closed. High coverage without closure is a real
category, and it is what occupies the band.

**Adding `N` as a second factor does nothing.** A two-factor sweep over `(c, N_min)` returns
`c = 0.50, N ≥ 0` → 98.4%, identical to the ratio alone. On clean npm the single
misclassification at `c = 0.5` is `.scripts.clean` (K/N = 0.529, coverage 50.8%), a boundary
case. `N`'s absolute scale is not the missing factor.

**The rule that survives the whole range has no constant at all.** Re-scoring every rule at
each definition of "genuine":

```
cov cutoff   K/N@best   K/N@0.5   K/N@0.1   net@2^64   n₁ rule   1−n₁/N ≥ cutoff
30%            100.0%     80.3%     45.9%      83.6%     88.5%            100.0%
50%             98.4%     98.4%     63.9%      65.6%     93.4%             88.5%
70%             93.4%     82.0%     83.6%      45.9%     73.8%             88.5%
80%            100.0%     68.9%     96.7%      32.8%     60.7%             86.9%
90%            100.0%     65.6%    100.0%      29.5%     57.4%             96.7%
95%            100.0%     65.6%    100.0%      29.5%     57.4%             98.4%
```

`1 − n₁/N ≥ cutoff` is not a threshold rule — it uses Good–Turing's reliable-mass estimate
*directly as a prediction of coverage* and compares it against whatever coverage the caller
requires. It carries **no free constant**, needs no retuning, and is the only rule stable
across the range. `net@2^64` degrades monotonically as the bar rises (83.6% → 29.5%): the
D-dependent formula is worst exactly when a strong claim is wanted.

**So the previous round's conclusion needs qualifying.** "`K/N < 0.5` is basically sufficient,
drop the machinery" is right only for one undeclared choice of required coverage, and the
constant must move with that choice — 0.19 at 90%, 0.765 at 30%. What is genuinely sufficient
is the Good–Turing estimate, which predicts the quantity rather than thresholding a proxy for
it. That leaves a clean tension worth stating: **the principled, constant-free rule (`n₁`) is
the one that dies under duplication (§6.8), and the duplication-tolerant rule (`K/N`) is the
one that needs a constant tied to an undeclared requirement.** Neither is unconditionally
better, and the choice between them is a choice about which failure is cheaper.

**On what the machinery is for.** A one-line, D-free `K/N < 0.5` check scores
98.4% on clean real data where the full D-dependent `net` scores 65.6%. For *this* decision
the credit/charge apparatus is not merely unnecessary, it is worse, and §17.3's finding that
`D` dominates the verdict is the reason. Two things the constant genuinely cannot do, both
already load-bearing elsewhere: it yields a boolean rather than bits, so it supports no
ranking (§17.5's ρ = 0.803 comes from the magnitude), and it is blind to sample size —
`K/N = 0.1` at `N = 30` and at `N = 30,000` are the same ratio and very different evidence
(`net` = 1,683 versus 1,411,809). A threshold treats them identically.

**Relation to §17.2 — same cause, strictly worse effect.** Both follow from the corpus not
being an i.i.d. sample of the source. §17.2 showed `N` is inflated, which distorts credit
*magnitudes* smoothly. This shows the sign of the criterion flips on a single duplicate. So
§17.2 is promoted: it is not an accepted limitation about precision, it is a **precondition**
for §6.7 meaning anything. And it cannot be discharged from the values — deduplication
requires either identical-record collapsing (which destroys genuine evidence when two
distinct records legitimately share a value) or provenance metadata the corpus does not
carry. **This is unresolved**, and §6.7 should be read as correct only for corpora certified
to be duplicate-free by means outside this framework.

**Conclusion, stated plainly: deduplication is a hard precondition, not a robustness
property the formula could acquire.** The charge `log₂C(D,K)` sees only `(D, K)`, both fixed
under duplication, so it is constant; credit scales with `N`. Any rule of the form
`credit(N,K,D) − charge(K,D)` therefore increases monotonically and without bound as a corpus
is duplicated:

```
r      N       net          net_esc
1    1000     −1,436        −55,471
2    2000    +52,598        +52,598
4    4000   +160,666       +160,666
8    8000   +376,803       +376,803
16  16000   +809,077       +809,077
```

No choice of charge repairs this, because the charge cannot see `N`; and a charge that *did*
grow with `N` would penalise genuine evidence identically, since more real observations are
indistinguishable from more duplication by construction (§6.8's impossibility above). So the
corpus must be an independent sample **before** any of this machinery runs, and establishing
that requires provenance the values do not carry.

There is an irony worth recording: §13 already holds that the corpus is not a value and that
facts about the collection procedure are not evidence about the source. Duplication is
precisely a fact about the collection procedure — and `N`, `n₁` and `K/N` all silently encode
it. The framework's own principle says duplication should not count, and none of its
statistics can avoid counting it.

## 7. The abstraction space is a tree of lattices

**Status: argued in design dialogue, then confirmed by a prototyping pass. Numbers below
are from that pass, on synthetic data.**

The space of "how specific should this document's inferred type be" is not one flat manifold
with a global knob. JSON is recursively defined — objects and arrays nest values — so the
abstraction space is a **recursive product of per-node lattices**, one per subtree, composed
the same way the document itself is composed. It is self-similar across nesting depth: the
same local decision shape recurs at every level.

This is a structural result in the sense of §12.1 — it follows from the data being
recursively constructed, not from any declared choice. What sits on top of it (the decision
function, §7.3) is policy.

### 7.1 Bottom-up per-node evaluation is correct, not merely efficient

Because the space decomposes, the correct way to compute over it is per-node and bottom-up.
This was checked against brute-force joint evaluation on 2000 records with independent
fields:

```
credit   bottom-up 31220.55   vs   brute-force joint 31225.24 bits    (within 0.015%)
charge   bottom-up    89.69   vs   brute-force joint   398.63 bits    (4.4x cheaper)
```

Credit agrees to within measurement noise. Charge does not, and the direction is
informative: **joint charge scales with the product of field cardinalities, bottom-up charge
with the sum.** Decomposing is not an approximation that happens to be cheap; on the charge
axis it is a materially different — and much smaller — quantity, because you are naming each
field's model once rather than naming one model over the cross-product.

### 7.2 Locality breaks exactly at correlated siblings, and by a measurable amount

The clean independent-decomposition picture holds only while sibling subtrees are
independent. It breaks where they are correlated, and the clearest case is a **discriminated
union**, where a discriminant field determines which other fields are meaningful. Measured on
a circle/square DU:

```
naive independent-per-field              5.158 bits/record
DU-aware (split by discriminant first)   3.158 bits/record
excess                                   2.000 bits/record
```

The excess matches the hand-derived prediction of exactly `2 × H(discriminant)`. Locality
genuinely breaks there — measured, not asserted — and the size of the break is predictable
from the discriminant's entropy.

This gives the structural DU result of §13 a quantitative form: the reason a DU wants to be
treated as a scope decision rather than as independent per-field facts is worth exactly
`2 × H(discriminant)` bits per record, and a per-node bottom-up pass that ignores it pays
that amount.

### 7.3 The knob is a caller-supplied decision function, not a threshold

Each node's decision is local, so the right shape for "how abstract should this subtree be"
is a **caller-supplied predicate over local node context** — an arbitrary function, not a
number. Confirmed by running three genuinely different policies through the same bottom-up
traversal:

- a strict `net > 0` threshold,
- a credit-favouring policy that ignores charge entirely,
- a non-numeric predicate: "never abstract this specific field."

All three composed correctly through the same traversal and produced different, sensible
outputs on the same tree. The third is the important one: it is not expressible as a
threshold at all, and it is an entirely ordinary thing for a caller to want.

### 7.4 Numeric thresholds are ill-defined here, not merely inconvenient

A threshold presupposes a total order over candidates. This space provably is not one, and
the counterexample is already in this document: the diamond of §5.1. Within a single node,
incomparable claims (`integer`, `≤ 255`, `multiple-of-8`) have no natural order to threshold
against; across sibling nodes, the choices are independent, so there is no single scalar to
compare. A threshold silently invents a total order that the space does not have.

This is the same objection, arrived at from a different direction, as §6.4's refusal to
collapse `(credit, charge)` to a scalar. Both are cases of projecting away structure that
the decision actually needs.

### 7.5 What is uniform and what is not

A single generic recursive procedure handling object, array and scalar nodes uniformly
**does** hold for the decision-*application* step. This was confirmed by refactor: unifying
three separate code paths into one produced byte-identical output.

It **does not** hold for candidate *construction*, which stays irreducibly kind-specific:

- objects sum their children's credit and charge,
- arrays flatten into one synthetic child,
- scalars use leaf entropy.

This is real structural content — the kinds genuinely differ in how candidates are built —
and it is recorded here specifically so that "one uniform recursive procedure" is not claimed
for more than it covers. The unification is real for application and false for construction.

**Rejected for array flattening: prequential scoring.** Because an array contributes many
occurrences of the same field, sequential per-occurrence scoring is an obvious-looking
candidate for composing them. It is rejected here specifically. Prequential requires
committing to an order, which conflicts with tests 1 and 2 (§11) and would make the inferred
type depend on array element ordering — which is exactly the thing that should not matter.
The correct composition is an **aggregate over sufficient statistics of the whole set**
(counts), computed once and order-invariantly, as in §6.6's static (N, K) pair.

This is not a rival to prequential so much as its order-free summary. Per §12.2's de Finetti
result, an order-free predictor *is* the average of the prequential score over every possible
ordering — so the aggregate computation is the same underlying quantity, obtained properly
instead of by committing to one arbitrary sequence and inheriting its bias. Prequential
remains correct elsewhere in this document for a different purpose (§6.1, where the question
is within-model complexity rather than composition).

Independently confirmed from type theory rather than from de Finetti: Baazizi et al.'s
counting types (§16.3) compose by `Intⁱ ⊕ Intʲ → Int^(i+j)`, associative and commutative, and
they adopt counts as the aggregate for the same reason — it is the statistic that does not
depend on the order the occurrences arrived in.

## 8. Synthesis, allocation, and cohort-relativity

Producing a single committed type, and producing per-fact numbers, is the caller's act.
All configurability lives here.

Description-length cost is **illegitimate** for scoring facts against data — it imports
arbitrary encoding choices — but **legitimate** as a criterion for choosing among
presentations of a result. That gives Occam's razor its proper home: minimizing the
description length of the *output*, not of the corpus. This resolves a real gap: a composite
can be strictly *less* credited than each of its constituents individually and still be the
preferred presentation, because it only earns credit for agreement among parts. Credit
ranking alone does not determine presentation.

**On "too many options": the split answers it architecturally, but the document does not yet
answer it concretely.** Baazizi et al. (§16) argue against exposing a choice at all — "the
analyst should not be presented with too many options, since this risks to be more confusing
than helpful" — from experience running their system on seven real datasets. The core/
synthesis split is a genuine answer in principle: the core holds all the evidence, synthesis
commits to one answer, and nobody is handed a menu unless they ask for one. An analyst sees
a single schema by default and reaches for the knob only when the default disappoints.

That answer is only as good as the default, and **this document does not specify one.** §7.3
makes the knob a caller-supplied predicate, which is *more* freedom than the K/L choice they
consider already excessive, and §15.2 still lists the default allocation scheme as an open
decision. As written, a faithful implementation would require every caller to supply a
policy — precisely the failure they name. Their objection is therefore best read not as a
refutation but as an argument that the open item in §15.2 is more urgent than its placement
suggests: the architecture reserves a place for a sane default, and until one is chosen the
architecture's answer is unbanked.

Note that the core's admitted set is now structurally missing composites: in the diamond,
the conjunction receives **0.0 marginal in both legal orders**, so a marginal-gain bar
rejects the meets of accepted facts — which is to say, the composed type you would want to
emit. Synthesis must reconstruct conjunctions from the overlap graph. This is survivable but
must be a stated property, not a surprise.

### 8.1 Per-fact credit is cohort-relative — and the cohort tag is not sufficient

Allocation depends on the player set, and the player set is the admitted set, which depends
on prices. Varying only `c(D)`:

```
c(D)=200   admitted {A,B,D}   phi(A)=629.6  phi(B)=1448.3  phi(D)=922.1
c(D)=5000  admitted {A,B}     phi(A)=576.0  phi(B)=1576.0
```

The game is unchanged; the attribution moves by 53.6 bits from a change to a *price*. Hence
the conditioned invariant (test 7, §11): gross attribution is invariant under price changes
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
decision this forces is open (§15.2).

## 9. The three declared objects

### 9.1 Baseline

Per §4: a declared, explicit partition, organized by provenance class. Not derivable from
the corpus. Selected per subtree, not per document (§4.2).

### 9.2 Price schedule

Per §6.2 and §6.3: for the shared-registry case, `cᵢ = log₂(#candidates in fact i's class)`,
which by Kraft is a probability mass over the vocabulary. A family of M members priced c each
consumes mass `M·2⁻ᶜ`, so a family granted mass m must price at `c = log₂(M/m)`. The
no-shared-entry case pays specification cost instead and is not governed by this schedule
(§6.3).

### 9.3 Escrow and versioning

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

### 9.4 Allocation scheme

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

The canonicalization key is **the declared code** (§10.2), not corpus extension. A
corpus-extension key is ill-defined: two facts covering the identical set of occurrences can
have `v({A}) = 415.0` and `v({C}) = 2737.0`, so the merged class has two values.

### 9.5 Why three, and not fewer

Each of the three has independently resisted collapse into the others, and each collapse
attempt failed for a different reason (§12.2). The short version: the baseline does nothing
about search multiplicity; a perfect charge does nothing about attribution; and the
allocation scheme is required by the diamond regardless of both.

## 10. Axioms

### 10.1 P1 — normalization

> Any admission or scoring rule with coverage has a total mass. Declining to declare it
> means using an improper one.

This is Kraft doing the work. Four instances: description-language cost cannot be eliminated
but only relocated into the baseline; "prequential needs no explicit prior" is false (by
exchangeability and de Finetti, an order-free sequential predictor is a Bayes mixture — see
§12.2); NML regret diverges for an unstructured open class; the price schedule is a Kraft
mass over the vocabulary.

### 10.2 P2′ — code-sufficiency, for the gross ledger only

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
  Stated over the corpus, P2′ re-merges them and reintroduces the §9.4 ill-definedness.

### 10.3 P2′ worked: computing the loss on a published merge

Baazizi et al. (§16.3) observe that merging counting types is sometimes lossless and
sometimes not, and that "the loss is more severe when the merged types are farther one from
the other" — naming a distance without measuring it. P2′ says the measure is the credit
difference, since two types denoting the same set of multisets induce the same code. Computed
on their own worked example, declaring `top` as an arbitrary 64-bit JSON number per field
slot and `Int` as 32 bits:

```
union   {a:Int¹,b:Int¹}¹ ⊕ {a:Int²,b:Int²}²
merged  {a:Int³,b:Int³}³

L(corpus | top)     = 384.000 bits
L(corpus | union)   = 192.000 bits    credit 192.000
L(corpus | merged)  = 192.000 bits    credit 192.000
CREDIT DIFFERENCE   =   0.000000 bits
```

Zero, exactly, matching their "no loss of information" — and not zero by construction, since
the same measure returns a non-zero answer on a lossy merge. Constructed control, disjoint
shapes:

```
union   {a:Int¹}¹ ⊕ {b:Int²}²          merged  {a:Int¹, b:Int²}³

L(corpus | union)   =  96.000 bits    credit 288.000
L(corpus | merged)  =  99.170 bits    credit 284.830
CREDIT DIFFERENCE   =   3.169925 bits
    = log₂C(3,1) + log₂C(3,2) = 1.585 + 1.585
```

The loss is exactly the cost of re-identifying which records carry which field — information
the union's branch structure holds and the merged type's counts do not. That is the quantity
their prose names and declines to compute.

One thing the pair shows that a "lossless" verdict alone hides (§6.4): in the first example
the union additionally names a branch structure the data cannot distinguish, since both
branches have identical content types and so `Î(branch; value) = 0`. Equal credit, strictly
more structure named — so under any schedule that charges for naming, the merged type wins on
net rather than merely tying. The exact charge is schedule-dependent (§6.3, §9.2) and no
number is quoted for it; the credit result above is not schedule-dependent.

## 11. The metamorphic test suite

Ten tests, each corresponding to a degree of freedom that must be either declared or absent.
This is the operational form of "core outputs are a function of (corpus + declared
conventions)" — that formulation is not checkable as stated, because it quantifies over all
conceivable undeclared choices, and it is weakly unfalsifiable, since any violation is
repairable by declaring the offending choice. It is a ratchet, and the tests are what make
it bite.

1. **Corpus order.** Permuting the corpus produces byte-identical output.
2. **Submission order.** Permuting candidate submission order produces identical output.
3. **Clone invariance.** Duplicating or aliasing a submitted candidate produces identical
   output. Holds definitionally under §9.4 canonicalization.
4. **Meet membership.** Whether the meet of two accepted facts is itself a player is
   declared, not incidental. (It changes every allocation: φ(A) moves 868.5 → 358.7 when the
   conjunction is added as a third player.)
5. **Iteration order.** Hash and map iteration order do not affect output.
6. **Float summation order.** Identical output regardless of summation order. Named
   explicitly because it is the one that will actually bite: this system sums bits, and
   float addition is not associative.
7. **Conditioned price invariance.** Gross attribution is invariant under price-schedule
   changes *that do not change the admitted set*. The unconditioned form is false (§8.1).
8. **Corpus-blindness of the schedule.** Scoring a corpus must not change any price. A
   schedule derived by inspecting the corpus is invalid.
9. **Null-corpus vacuity, swept.** On null corpora, asserted facts ≈ 0 — **swept over
   candidate count and candidate cheapness**, not at K=1. A K=1 fixture passes trivially
   under any within-model complexity term (0.0% at N≥200) while the actual defect is
   untouched (100.0% at K=1000 with cheap candidates). A green K=1 fixture would close the
   audit with the bug intact.
10. **Decomposition fidelity.** Bottom-up per-node evaluation agrees with joint evaluation on
    independent subtrees (§7.1), and is *expected to diverge* on correlated siblings by the
    predicted `2 × H(discriminant)` (§7.2). Both halves are the test: agreement where the
    structure factors, and the predicted gap where it does not. A version that agrees
    everywhere is not detecting DUs.

## 12. Two axes, and two methodological patterns

### 12.1 Two axes, not one spine

There is a real recurring distinction — **declared vs. derived**, equivalently policy vs.
evidence — and it recurs at genuinely independent layers: core vs. synthesis; gross vs. net
(equivalently P2′, equivalently the two-ledger separation, which are one distinction stated
three ways rather than three distinctions); the declared baseline against which evidence is
measured; and the caller-supplied decision function sitting on top of the derived per-node
lattice structure (§7.3).

It does **not** cover everything. A second family of results is **structural** — neither
evidence nor policy, holding regardless of any declared choice:

- scope is definitional (§3)
- the corpus is not a value (§13)
- constitution as a part-whole relation (§13)
- discriminated unions are a scope decision, requiring no new machinery (§13)
- tuple-vs-array is the same DU/discriminant mechanism with position as discriminant (§13)
- the abstraction space is a recursive product of per-node lattices (§7)

Describing the design as one spine would misdescribe these as instances of a distinction they
do not participate in. Two axes is the accurate statement. (This is an interpretive judgment
about the theory's organization, not a verified technical claim.)

### 12.2 Complexity charges relocate; they do not vanish

Instances found, each initially presented as an elimination:

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
6. The re-scoping to a set function — removed the only mechanism against memorization (§6.5).
7. "The charge now lives in the objective where it can't relocate further" — its *value*
   became the free parameter, which is where it relocated.

The methodological consequence: **the correct response to an apparent elimination is to look
for where the charge went, and the way to find out is to run the numbers.** Six rounds, four
convergence claims, three refuted by simulation, none by inspection.

The corollary — "therefore choose the accounting where the payment is most visible" — is
*not* adopted as a principle. Visibility is not formalized and can conflict with
theorem-backed criteria: crude two-part codes are maximally visible and worse in redundancy
than Bayes mixtures. It is an ergonomics criterion competing with a robustness criterion, and
which should win is a live call, not a derived result.

### 12.3 Before combining two quantities, find a case where they diverge

A companion pattern to §12.2, and one that bit twice in quick succession:

1. **`(credit, charge) → net`.** `top` at (0,0) and a literal at (X,X) are the same scalar
   and structurally unrelated points (§6.4). The collapse erases the axis a caller would want
   to turn.
2. **Inside the charge itself.** Pointer cost `log₂N` and full specification cost were
   treated as one quantity; a two-element registry containing one enormous model separates
   them by an unbounded amount (§6.3).

Both were found the same way — by constructing a concrete case where the two components pull
apart, rather than by reasoning about whether the combination "seemed" safe. The rule this
generalizes to: **whenever two things are being summed or otherwise combined into one
number, construct a divergence case before accepting the combination.** Note the family
resemblance to §4's "absolute bits, not fractions", which is the same concern about lossy
combination, found earlier and stated narrowly.

## 13. Structural results (baseline-independent)

These hold regardless of any declared choice. §7's recursive-decomposition result also
belongs to this family and is stated there.

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
claimed (§14); it handles structural part-whole overlap only, not two unrelated facts that
happen to explain overlapping bits.

**Discriminated unions require no new machinery.** A DU is a scope decision: one fact scoped
to "occurrences where the tag is `a`" claiming shape A, another scoped to tag `b` claiming
shape B. The correlation between tag and payload is the *reason* the facts earn credit, not a
relation stored in the structure. The distinction from a plain union is structural, not
quantitative: whether the scope is **derivable from observed constituents** or only
**extensionally enumerable**. The discriminant must be co-located within the same value;
siblinghood is the common case, not the condition. §7.2 gives this a quantitative form:
ignoring it costs `2 × H(discriminant)` bits per record.

**Tuple-vs-array is the same mechanism**, with array position as the discriminant:
`Credit_tuple − Credit_array = N·Î(position; value)`. A real unification — and under the set
function it is cleanly a comparison of two fact sets, which is what it always was. Note it
carries the same finite-sample bias as everything else, so tuple framing wins essentially
always without a charge. Fixed array length (near-zero length entropy) indicates
schema-determined arity; this shares a common cause with position-dependent content rather
than causing it — scope is conserved under ragged arrays, since Σnᵢ = N always.

**Borrowed external support, which did not replicate — see §17.1.** Baazizi et al. (§16.3) measured array cardinality across Twitter, GitHub and NYTimes
and report that fixed-size arrays range 0–4 in length while variable-size arrays range 0–35;
that many Twitter arrays have length 2 and "correspond to longitude and latitude
coordinates"; and that "most of the time, the content of fixed size arrays is a tuple of
numeric values, whereas the content of variable size arrays are lists of records." Fixed
length co-occurring with tuple-shaped numeric content, variable length with homogeneous
lists, on three real corpora — which is the claim above, measured by someone who was not
trying to test it. Note the limits: it is a co-occurrence observed by direct inspection, not
a controlled test, and it says nothing about the `N·Î(position; value)` quantity itself.
**On this repository's own corpora the pattern does not appear at all** (§17.1): zero of
three fixed-length array paths hold numeric tuples, and position-signature MI is zero across
all of them. The claim now has one supporting measurement and one non-replication.

## 14. Retractions from the superseded document

`inference-from-first-principles.md` retains its own retraction table, which remains
accurate for what it covers. These are additional, and they are the reason that document is
superseded rather than merely extended.

| Retracted | Why |
|---|---|
| §4 "A fact's credit is computed from the fact alone" | Credit is a set function; per-fact numbers require an allocation convention (§5.1). The 906.9-bit diamond gap is exactly the interaction no single fact earns. |
| §5 "Credit above zero is the only admission bar. Nothing is discarded." | Admission is net-total maximization and it discards (§6.2). The weak-but-true fact at −1.7 net is the intended behaviour, not a defect. |
| §5 memorization argument (aggregates don't inherit credit, so ordering handles it) | The argument was about per-fact ranking; under the set function memorization attains the global maximum (§6.5). Handled by the charge instead. |
| §6 "No other fact-to-fact relation is required" | Constitution covers part-whole overlap only. Refinement and crossing overlap are ordinary type refinement, not edge cases, and the framework needed the allocation scheme for them. |
| §4 "No description language anywhere" | Correct for scoring facts against data; **wrong as an absolute**. Kraft makes declaring a code and declaring a distribution the same act, so the cost relocated into the baseline. It is also legitimate at synthesis time (§8). |
| §9 output = facts, their credits, and constitution edges | The core emits the total and the graph; credits are synthesis artifacts (§5.1, §8.1). |
| §12 "silence where the corpus is silent" as unqualified | Still true in spirit, and now sharpened: the net bar makes it operational rather than aspirational. |

An earlier revision of *this* document is also corrected: the charge was stated as
`log₂(#candidates)` without qualification, which is one case of a situational quantity rather
than its definition (§6.3).

## 15. What is open

### 15.1 Theoretical — will NOT be closed by empirical work

**Pricing a never-before-submitted fact type.** `log₂(#candidates in the class)` is
well-defined for enumerable classes and undefined for a fact type nobody has invented yet.
Escrow *localizes* this to reserve-sizing at version time; it does not answer it. Corpus work
cannot answer it either — you cannot calibrate the price of a hypothesis class that does not
exist. This is the open-class problem in its fourth costume (unbounded NML regret →
stratified priors → e-merging weights → reserve sizing), and it should be expected to remain
open after the empirical phase rather than to fall out of calibration data.

Note that §6.3 sharpens this rather than solving it: the no-shared-registry case is exactly
the case where the pointer price does not apply and a specification cost must be paid
instead, and what that specification cost is for an arbitrary new model is the same open
question in different words.

### 15.2 Design decisions needed before the empirical phase

**Cohort reporting.** Given §8.1, does a per-fact credit report carry standalone gross credit
`v({i})` alongside the allocated `φ(i)`, making the interaction component visible as the
difference — or is the cohort identifier extended to cover the interaction structure
(precise, but churns on every corpus change)? This determines what the real-data audit is
permitted to compare across corpora, and so must be settled before the audit is designed,
not after it produces numbers.

**Default synthesis policy.** Promoted from a footnote to a named item on the strength of
Baazizi et al.'s objection (§8, §16): without a default, every caller must supply an
abstraction predicate, which is the "too many options" failure they observed on real
datasets. The architecture reserves the slot; nothing fills it. This covers both the default
abstraction policy and the default allocation scheme (§9.4).

Two smaller ones in the same bucket: whether negative-net facts are dropped before allocation
runs or emitted with a signed number (§6.4); and whether the pointer-cost and
specification-cost cases of the charge (§6.3) are two ledgers or one ledger with a case
split.

### 15.3 Open within the fourth baseline class

§4.2's three structural claims are confirmed, and the circularity question that stood here is
now **resolved** (§6.6): domain-restriction credit against `top` is non-circular and is the
ceiling reachable from one corpus; anything finer requires external data, which is what the
multi-model approach supplies. Empirical-frequency, Bayes-mixture, prequential and KT
estimators were considered for closing that gap within a single corpus and rejected, since
each still derives its predictive component from the data being scored. These are what
remain.

- **What happens to fields whose domains are not separable.** Close-cluster confusability
  (§4.2) plateaus rather than converging — 93%/85% at n=200 for a JS=0.007 pair, against 100%
  by n=20 for well-separated ones. More data is not the answer, so the design owes an answer:
  merge indistinguishable clusters, fall back to a coarser baseline, or surface the ambiguity
  to the caller as a first-class outcome. Unaddressed.
- **Routing mechanism choice.** Nearest-neighbour lookup, a trained classifier, or something
  else. The KNN form is now shown viable at n≥10–20 under an oracle, but the prerequisites
  still differ (labels or no labels) and no alternative was compared.
- **Similarity metric.** Only JS divergence was tried. Ordinal-valued fields such as
  `priority` have a natural metric structure that JS discards, and Wasserstein was not
  tested.
- **The unsimulated half of the class.** Sequential and relational IDs, and computed
  aggregates, were not modelled. Whether the multi-model result extends to them is unknown,
  and there is reason to doubt it transfers unchanged: an ID's regularity is sequential
  rather than distributional.

### 15.4 Empirical

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
- **How often sibling correlation actually breaks locality**, and by how much, on real
  documents. §7.2 establishes the mechanism and its size in one constructed DU; the
  distribution of that break across real corpora is unknown and directly determines how much
  the bottom-up decomposition is actually leaving on the table.

## 16. External prior art bearing directly on this framework

`docs/design/prior-art/json-shape-inference.md` surveys five lines of work at
implementation level. Two bear on the *theory* specifically and are recorded here.

### 16.1 XTRACT (Garofalakis, Gionis, Rastogi, Seshadri & Shim, SIGMOD 2000)

MDL-based DTD inference for XML, and the closest published relative of this framework's core
move. It is not in the survey and should be.

The structure is the same one derived here, twenty-six years earlier and for a different data
model. XTRACT ranks candidate DTDs by two-part MDL cost — "(A) the length of the theory, in
bits, and (B) the length of the data, in bits, when encoded with the help of the theory" —
which is `charge + data cost`, i.e. §6.3's `L(model)` plus the coded corpus. Specific
correspondences:

- **Their DTD-encoding cost is n·⌈log(|Σ|+|M|)⌉** — symbols in the DTD times bits per symbol
  over a declared alphabet plus metacharacters. That is §6.3's *pointer cost over a shared
  registry*, with the registry being the alphabet, and §9.2's price schedule for a
  fixed-length code. Notably they declare this encoding without remarking that it is a
  choice — which is exactly what §14's retraction of "no description language anywhere" says
  is unavoidable: the cost does not disappear, it becomes a declared convention.
- **Union encoding costs ⌈log m⌉ bits** to say which of m disjuncts matched. That is §6.6's
  domain-restriction credit in miniature.
- **Repetition counts use a self-delimiting code** (unary length prefix, then the index),
  i.e. a prefix-free code — so their scheme satisfies Kraft by construction, which is P1
  (§10.1) honoured in an implementation that predates the statement of it here.
- **Candidate selection reduces to the Facility Location Problem**: minimise
  `Σ_{j∈F} c(j) + Σ_{i∈C} min_{j∈F} d(j,i)` over subsets F — cost of chosen models plus cost
  of coding each datum under its best chosen model. This is structurally the net set function
  of §6.4/§6.5. **They get an approximation guarantee where we do not**: FLP is NP-hard but
  reduces to set cover and is approximable within a logarithmic factor, and they use a
  constant-factor randomised algorithm (noting their distance function is not a metric, so
  the constant-factor guarantee does not strictly apply). §5 records that the general
  set-function here is neither sub- nor supermodular and carries no guarantee. Whether the
  domain-restriction family specifically has FLP structure — and therefore inherits an
  approximation bound — is **an open question worth pursuing**, and would be a real
  strengthening.

Two divergences worth keeping. XTRACT commits to a single minimum-cost DTD, where the core
here commits to nothing and leaves that to synthesis (§8). And XTRACT has no charge for
*search* multiplicity: candidates are generated per-sequence and then selected, with no
payment for how many were examined, which is the §6.1 vacuity gap. Their generalisation
module is explicitly noted to over-generalise, with MDL relied on to filter — the exact
configuration §6.1 shows is insufficient once candidates are cheap and numerous.

### 16.2 Baazizi, Colazzo, Ghelli & Sartiani (VLDB J. 28:497–521, 2019)

Already surveyed at implementation level. Its theoretical relevance is that it is **the
strongest published argument against this framework's premise**, made from evidence this
document does not have:

> "We are aware of the existence of mathematical approaches to establish an 'optimum' balance
> between size and precision for an inferred schema, such as the one based on the Minimum
> Description Length used in [XTRACT] for the DTD inference of an XML document, but our
> inspection of these real-world datasets seems to indicate that such a mathematical
> 'optimum' does not make sense here: the optimal choice is typically not objective but
> depends on the current needs of the analyst."

Seven real datasets against this document's zero. How much it lands:

- **Against XTRACT-style commitment: it lands.** XTRACT picks one minimum-cost DTD, and that
  is the thing they inspected and found does not match analyst need.
- **Against the core here: it does not, because the core does not commit.** "The optimal
  choice depends on the analyst" is §8 restated — the core emits an order-free total and a
  graph, and every act of committing is caller policy.
- **Against §7.3's interface: it lands, and is not yet answered.** See §8 and §15.2.

Their footnote 10 independently derives §4's uniform-baseline diagnosis (§4.3). Their
commutativity and associativity theorems for `Fuse` are order-invariance *proven* where
§11's tests 1 and 2 only assert it as an obligation, and their `collapse` of array positions
into one body type matches §7.5's array flattening including the acknowledged loss. These are
genuine convergences, not gaps.

### 16.3 Baazizi, Colazzo, Ghelli & Sartiani, *Counting Types* (DBPL 2017)

Their quantitative-types extension, and the closest existing thing to the statistics §6.6
needs. Contains no MDL, entropy, description length, probability or threshold — zero hits for
all of them. It is a type system, not a scoring criterion.

**It supplies N but not K.** Every type constructor is annotated with an absolute occurrence
count: `{title: Str²⁰ᴷ, author: {…}²ᴷ}²⁰ᴷ`, where the count is how many items the
corresponding path yields. That is exactly §6.6's N, collected per path, map-reduce-able,
with a formal semantics. But nothing counts *distinct values* — `Num³` means three numbers,
not three different ones. K lives in the *other* paper's enum extension (`StrEnum{s₁…s_j}`,
§16.2), and within this line of work the two are never combined.

**Correction to an earlier revision of this document.** A previous version generalised that
into a claim that the (N, K) pair has no prior art. **That was wrong**, and a broader search
found it wrong quickly. Tracking row count and distinct count together is routine:

- **Data profiling.** Abedjan, Golab & Naumann's survey (*Profiling relational data*, VLDB J.
  2015) treats distinct-value count as a core single-column task alongside row counts, and
  the distinct-to-total **cardinality ratio** is the standard device for separating
  low-cardinality categorical columns from identifier-like ones.
- **Query optimisation.** Number-of-distinct-values against row count is the basis of
  selectivity estimation, and has been since the earliest cost-based optimisers.
- **Storage engines.** ClickHouse's `LowCardinality` is this decision made in production.
- **This repository.** `from-json-corpus.ts`'s `looksLikeEnum` already cuts on
  `ratio = K/N` — `≤ 1/3 → enum`, `≥ 0.5 → not enum` — with a separate hard
  `K > 50 → not enum`.

So the honest claim is narrow: N and K are combined all the time, **as a ratio compared
against a constant**, and that form is what §6.6 improves on, not a vacuum. See §6.6 for what
the ratio form gets right and where it breaks.

**Their PER parameter sits exactly where a credit difference would go.** They observe that
merging is sometimes free — `{a:Int¹,b:Int¹}¹ ⊕ {a:Int²,b:Int²}² = {a:Int³,b:Int³}³` loses
nothing — and sometimes lossy, and that "the loss is more severe when the merged types are
farther one from the other." Having named a distance governing the size of the loss, they
parameterise by an equivalence relation rather than measure it. This framework predicts the
loss is the credit difference, hence exactly zero on their lossless example. **Computed in
§10.3: 0.000000 bits on theirs, 3.170 bits on a lossy control**, the latter equal to
`log₂C(3,1) + log₂C(3,2)`. That is the clearest available statement of what this framework
adds to theirs: they locate the decision, we score it.

Three convergences worth recording, all independently derived:

- **Counts are the order-invariant sufficient statistic.** `Intⁱ ⊕ Intʲ → Int^(i+j)`,
  associative and commutative. That is §7.5's argument for aggregating array-composed facts
  over counts rather than scoring sequentially, reached from type theory instead of from
  de Finetti.
- **Set-of-multisets semantics**, adopted because the objects being described are occurrences
  rather than values. Same commitment as §2's addresses-are-not-identity and §13's
  corpus-is-not-a-value, forced by the same consideration.
- **Same information, several presentations, one canonical.** Their types (3), (4) and (5)
  all express mutual exclusion between two optional fields; (5) is "canonical, since it
  separately lists each distinct possibility," and full correlation costs 2ⁿ. That is §8's
  position that presentation is a synthesis choice not fixed by the evidence, plus §7.2's
  correlation cost, arrived at independently.

**A practical warning for §6.6.** They report that an existing streaming implementation
"introduces counting errors when optional fields are found." If domain-restriction credit
depends on accurate per-path N, that is a known real-world failure mode in the exact statistic
it consumes.

**What it does not change.** No candidate search and no selection problem — reduction is a
deterministic fold once E is fixed — so it bears on neither §16.1's Facility Location question
nor §6.1's multiplicity gap. Both stand as they were.

## 17. First contact with real corpora

**Status: the first test of anything in this document against real JSON.** Corpora at
`.local-data/corpora/` (gitignored): 1098 npm registry `package.json` manifests, 394
schemastore JSON Schemas, 22 real API payloads (GitHub, PokeAPI, CoinGecko, Stripe's OpenAPI
spec, npm's full lodash document, others). Run adversarially — looking for breakage, not
confirmation. **Four failures, no clean confirmations.** One corpus proves little either way;
a claim surviving would have been weak evidence, and none did.

### 17.1 §13's borrowed array support does not replicate

§13 cites Baazizi et al.'s Twitter/GitHub/NYTimes measurement — fixed-size arrays hold
"a tuple of numeric values," variable-size hold "lists of records" — as the document's only
externally-corroborated claim. On npm + api-examples, restricted to array paths with ≥20
non-empty observations (20 paths qualify):

```
FIXED length (H(len)<0.05)   3 paths   dominant element kind: {str: 3}   MI(pos;sig) = 0.0000 for all
MID  (0.05<=H<1)             3 paths   {obj: 2, str: 1}
VARIABLE (H>=1)             14 paths   {obj: 5, str: 9}
```

**Zero of three fixed-length paths hold numeric tuples.** They are `.cpu` (`["x64"]`),
`.libc`, and `[*].base.repo.topics` — all homogeneous string lists, none position-dependent.
And 9 of 14 variable-length paths hold strings rather than records, so the other half of the
claim fares no better. `MI(pos;sig) = 0` across every fixed-length path: there is no
position-dependent content for fixed length to share a common cause with.

Honest limits: 20 qualifying paths is a small sample, and these corpora differ in character
from theirs — package manifests and REST payloads rather than social/news firehoses. The
claim is not refuted in general. But **the document should no longer describe itself as
having external real-data support for §13**, because the nearest corpus available does not
reproduce it.

### 17.2 N counts occurrences, and real payloads duplicate entities

Not a claim under test — a hazard the corpus surfaced. Real API responses embed parent
entities once per child:

```
file                                     path            N   distinct   ratio
github_pulls_microsoft_typescript.json   base.repo      50          1    0.020
github_releases_nodejs.json              author         30          5    0.167
github_issues_facebook_react.json        user           50         23    0.460
github_commits_torvalds_linux.json       commit.author  50         50    1.000  (control)
coingecko_markets.json                   id            100        100    1.000  (control)
```

Fifty pull requests against one repository embed that repository fifty times. Every credit
computed over `base.repo.*` sees N = 50 where the evidence is one observation. The controls
confirm the measurement is not an artefact. The superseded document listed corpus
multiplicity distortion as an accepted limitation; this shows it is **not an edge case but
the normal shape of REST payloads**, and it silently multiplies the N that §6.6 consumes.

### 17.3 §6.6's verdict is decided by the declared `D`, and no non-circular choice works

The sharpest failure. §6.6 requires a declared universe size D. For string fields every
corpus-independent choice is astronomically large, and §6.6's own boundary table already
shows the required N/K ratio → 1.0 as D/K → ∞. On real npm fields, under three defensible
declared universes:

```
field         N     K    K/N     empirical D   D=64^32    D=26^8      verdict
license    1085    38  0.035           6,947   195,479    33,825      KEEP  KEEP  KEEP
main        927   286  0.309           2,026   117,434    18,466      KEEP  KEEP  KEEP
version    1098   543  0.495             859   100,740    15,050      KEEP  KEEP  KEEP
homepage   1059   919  0.868            -858    24,182     2,567    reject  KEEP  KEEP
description 1094 1030  0.941          -1,141    10,168       286    reject  KEEP  KEEP
name       1098  1098  1.000          -1,331    -1,578    -1,578    reject reject reject
```

Under either corpus-independent universe, §6.6 asserts that `description` — **94% distinct
values**, where the repeats are empty strings and boilerplate — is a closed domain restricted
to exactly those 1030 observed strings. Same for `homepage`. That is memorization admitted
with positive credit, which is precisely what §6.2 and §6.5 claim the charge prevents.

The only universe that produces sensible verdicts is the empirical one, D = distinct strings
observed corpus-wide — **which §15.3 rules out as circular.** So the dilemma is exact: the
non-circular choices give wrong answers on real string fields, and the choice that gives
right answers is the one the theory forbids. §6.6's `K = N` boundary does hold (`name`
rejects everywhere, as designed) — the failure is in the band `0.85 < K/N < 1.0`, which is
where most real string fields live.

(Numerical note: computing `log₂C(D,K)` by `lgamma` differences loses all precision at
D ≈ 10⁵⁷. The figures above use the Stirling form `K·log₂(D/K) + K·log₂e − ½log₂(2πK)`,
validated against the exact computation where both are reliable. An earlier run of this
analysis reported nonsense for that column before the substitution.)

### 17.4 Mutual information is blind exactly where real dependence is strongest

§7.2, §13's DU credit, and §13's `N·Î(position; value)` all rest on mutual information
between siblings or positions. Measured against a shuffled null — the same data with one
column permuted, which is provable independence:

```
path                       a × b                 N   K(a)  K(b)   MI_obs  MI_null  excess
npm .dist                  shasum × integrity 1098   1098  1098   10.101   10.101   0.000
api [*][*]                 id × iso2Code       295    295   295    8.205    8.205   0.000
npm .maintainers[*]        name × email       3383   1918  1931   10.362    9.020   1.341
api [*].user               login × id          100     50    50    4.993    3.499   1.494
npm .scripts               test × build        477    266   315    6.492    5.942   0.550
```

Two failures in one table. First, **raw MI is mostly bias** — 9.02 of the 10.36 bits for
`name × email` survive shuffling. That is §6.1's vacuity result reproduced on real data, and
§7 prescribes MI with no charge term anywhere.

Second and worse: **the null-corrected excess is exactly 0.000 for the two strongest real
dependencies in the corpus.** `integrity` is a deterministic re-encoding of `shasum`; `id`
and `iso2Code` are a fixed pairing. Both are functions, the most dependent pairs available,
and the statistic reports nothing — because when both fields are unique per record the true
joint and the shuffled joint are both N cells of count 1, and no amount of data helps, since
every new record adds a new cell.

So the framework's correlation apparatus cannot see functional dependency between
high-cardinality fields. §7.2 presents the discriminated union as "the clearest case" of
locality breaking; on real data the common case is a derived-identifier pair, for which the
DU mechanism (a scope decision over a low-cardinality tag) does not apply and MI returns
zero. This is a gap in what §7 can represent, not only in how it is estimated.

### 17.5 Following §17.3 down: the mechanism, a refuted fix, and what actually works

**The mechanism, confirmed and sharper than expected.** `net = (N−K)·log₂(D/K) − K·log₂e +
½log₂(2πK)`. The margin `(N−K)` is fixed by the data; `log₂(D/K)` is a free declaration;
their product is unbounded. For npm `description` (N=1094, K=1030, margin **64**):

```
declared universe                log₂ D          net    verdict
K itself (no headroom)             10.0            0    reject
2^16                               16.0       -1,084    reject
2^32                               32.0          -72    reject
2^33.2  (break-even)               33.2            0    --
2^34                               34.0          +56      KEEP
2^64                               64.0       +1,976      KEEP
2^1000                           1000.0      +61,880      KEEP
```

Break-even is `log₂(D/K) > K·log₂e/(N−K)`, here 23.2 bits, so `log₂D > 33.2`. **It does not
take an astronomical D — a 33-bit universe already flips it**, and every string field
trivially exceeds that. The failure is not an artefact of extreme declarations; it is the
normal case for strings.

This does not contradict anything §6.6 states — its boundary table already shows the required
ratio → 1.0 as D/K → ∞ — but §6.6's "count total occurrences, count distinct values, done"
framing invites reading `(N, K)` as sufficient. They are not. **`D` is the dominant term**,
and the criterion is only as trustworthy as a declaration the corpus cannot check.

**A mixture fact was proposed as the fix. It scores better and does not resolve the
problem.** Hypothesis: `description` is not a closed domain but a mixture — mostly open text,
with a few boilerplate values recurring. (The data supports the description: **96.8% of
distinct values occur exactly once**, covering 997 of 1094 occurrences; the top repeat is a
package blurb appearing 10×.) Modelled as a DU between "one of M special values" and "open
text", charged `log₂C(D,M) + ½log₂N`:

```
log₂D = 64      pure restriction (M=K=1030):  net = 1,976
      M=10   net = 2,005      M=25   net = 2,870      M=50   net = 3,134      M=300  net = 2,133
```

**The mixture wins**, peaking around M=50. An earlier argument in this session that it *could
not* win — because its repetition margin `Σ_{v∈S}(count−1)` is a subset of `N−K` — was
wrong: the margin identity holds, but the mixture's charge scales with M rather than K, and
that dominates. Recorded because the wrong version was asserted before it was run.

But it does not resolve the dilemma. Pure restriction still nets **+1,976**, so the
mischaracterisation is still admitted; the mixture merely outranks it. And held out, the
mixture's special set covers only **2.0–3.3%** of unseen occurrences at M=5…50 — the
boilerplate is package-specific, not a stable vocabulary. The mixture is a better
*compression* of this corpus and not a better *prediction* of the next one.

**What does discriminate: held-out coverage.** Fit the domain on half the corpus, measure how
much of the other half it covers. Across **107 string-valued paths** with N ≥ 120 from npm +
api-examples:

```
                                net@2^64   held-out coverage
npm .dist.signatures[*].keyid     71,756              100.0%
npm .license                      61,404               96.5%
npm .main                         35,386               69.8%
npm .description                   1,976                6.2%
npm .name / .dist.shasum / ._id   -1,578                0.0%
```

- **Spearman ρ(net, held-out coverage) = 0.803** (n=107). Net is a *good ordering*.
- **As an admission bar it is not**: 81 of 107 paths clear `net > 0`, their coverage ranging
  2.0%–100%, and **12.3% of admitted paths have under 20% held-out coverage**.
- The `K = N` boundary is exact: every one of those paths (`name`, `tarball`, `shasum`,
  `integrity`, `_id`, `sig`) nets negative and covers 0.0%.

**And the ranking is D-robust where the sign is not**, which is what makes this actionable:

```
log₂ D      ρ(net, coverage)   %KEEP   % of KEEP with coverage <20%
34                     0.862   73.8%                          10.1%
64                     0.829   75.7%                          12.3%
1000                   0.813   77.6%                          14.5%
8000                   0.813   77.6%                          14.5%

Spearman between the net ORDERINGS at log₂D = 34 and log₂D = 8000:  0.9885
```

A 235-fold change in the declared exponent barely moves the order (ρ = 0.989) while moving
the admission count and the error rate. **So the D-dependence is concentrated almost entirely
in where the threshold falls, not in the ranking.**

That relocates the problem rather than solving it, but it relocates it somewhere the
architecture already wanted it: §5.1 has the core emit an ordering and §8 has synthesis
commit, and §6.6's `net > 0` bar is one of the few places the document departs from that.
The empirical result says the departure is the part that fails. Two things remain genuinely
unresolved: a cutoff still has to come from somewhere, and the only calibrator found — held-out
coverage — requires stepping outside the corpus-relative frame that §4 makes definitional.
That is the same wall as §15.3's circularity, reached from a different direction.

### 17.6 What this does and does not establish

It does not refute the framework. Every failure above is a failure of a *specific* claim
against a *specific* corpus, and three of the four point at things the document already flags
as declared choices or accepted limitations — they show those choices bite harder in practice
than the document conveys. §17.4 is the exception: it identifies a representational gap that
was not previously named.

What it removes is the document's one piece of external empirical support (§17.1), and it
replaces "we have not tested this" with four specific places where testing went badly.

## 18. Relationship to other documents in this repo

`inference-from-first-principles.md` — superseded by this document; retained for its
cleanroom provenance record, its own retraction table, and its convergence check against
external prior art (JSONoid, Baazizi, Tagger, ptype, quicktype), all of which remain
accurate. Read §14 above before treating any of its numbered sections as current.

`json-inference-model.md` — older still, written with the existing
`packages/type-ir/src/from-json-corpus.ts` implementation in view. Its "never abstain, commit
to a conservative hypothesis" stance is in direct tension with this document's position that
admission discards and that the corpus is allowed to be silent. Its fact/synthesis reframing
is broadly compatible with §3 here. Fully reconciling the two is not load-bearing for this
revision and has not been attempted; where they conflict, this document is current.

## 19. Provenance of the quantitative claims

Every number in this document comes from one of the simulations run during derivation, or
from the two prototyping passes behind §7 and §4.2. All are on synthetic structure. **None
is measured on a real corpus.**

The confidence is not uniform and should not be read as such:

- §5, §6, §8, §9 numbers come from targeted simulations built to test specific claims,
  several of which refuted the claim they were built to check.
- §6.6 is the one place where the result is **analytic rather than simulated**, and is
  correspondingly firmer: `net = (N − K)·log₂(D/K)` is an identity, verified numerically
  against the exact `log₂ C(D,K)` charge rather than assumed. The −log₂e per-occurrence
  penalty at K = N was measured across four orders of magnitude in N. The comparison against
  the K-only threshold rule is likewise a construction, not a sample: the both-directions
  failure is exhibited for arbitrary k rather than found by search. It all still rests on a
  declared `top` (the value of D), which is a modelling choice, not a measurement.

**The document has now had first contact with real corpora, and it went badly (§17).** Four
claims were tested adversarially against npm manifests, schemastore schemas and real API
payloads; four failed. The one previously-corroborated claim (§13, borrowed from Baazizi
et al.) did not replicate. §6.6's verdict was shown to be decided by the declared `D`, with
no non-circular choice that behaves. And the mutual-information statistic underpinning §7 and
§13 was shown to be both mostly bias and blind to the strongest real dependencies. None of
this refutes the framework; it does mean the numbers below are no longer the only evidence,
and the new evidence is negative.

**The strongest external check remains unmet.** Baazizi et al. inspected seven real datasets
and concluded a mathematical optimum "does not make sense here" (§16.2). Part of that lands
on committing-to-one-answer rather than on this core, and part of it lands squarely on §7.3's
interface and is unanswered. Either way it is an empirical finding from real data set against
a document that has essentially none. The numbers here are still all synthetic, and this
framework's central bet — that quantified evidence plus caller-side policy beats a declared
parameter — has not been tested against a corpus, let alone against an analyst.

Worth noting that they consider the latter test the only real one, and did not run it either.
On whether their own quantitative types help: "This theme is inherently subjective: knowing
the frequency of one specific field or the frequency of a combination of fields in a record
may be extremely important, or totally irrelevant, depending on the role of the field or the
record and on the need of the data analyst. The only way to measure the practical benefit
would be by collecting and…" — the sentence is cut off at a column break in the source, so
what they proposed collecting is not recoverable from the copy read here.
- §7 numbers come from a prototyping pass — bottom-up versus brute-force agreement, the DU
  locality break, the three-policy composition check, and the refactor equivalence check.
  Same synthetic-data caveat applies.
- §4.2 numbers come from a toy simulation over five hand-built distributions. The three
  structural claims held, but the confidence here is **weaker than §7's**, for reasons
  internal to the setup rather than generic: the clusters were separable by construction,
  accuracy was scored against oracle labels a deployment will not have, and two of the four
  value shapes in the class (IDs, computed aggregates) were not simulated at all. The one
  result that should be read as strong is the *negative* one — close-cluster confusability
  plateauing at n=200 — because a failure found in a setup built to be favourable is more
  likely to survive contact with reality than a success found there.

The literature claims — Krimp's Standard Candidate Order (support-descending, then
cardinality-descending, then lexicographic) and Standard Cover Order (cardinality-descending,
then support-descending, then lexicographic), SLIM as the gain-ordered variant, Grünwald &
de Rooij on plug-in redundancy under misspecification, Vovk & Wang on admissible e-merging,
Wasserman/Ramdas/Balakrishnan on split-LR universal inference, Ieong & Shoham on MC-nets,
Deng & Papadimitriou on cooperative solution-concept complexity, De Bie's FORSIED — were each
checked against the sources rather than recalled, after two overclaims early in the
derivation were caught that way.
