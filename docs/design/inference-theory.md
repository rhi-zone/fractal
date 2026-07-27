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
  boolean flags, computed aggregates. See §4.2; this class is real but its treatment is the
  least settled material in this document.

### 4.2 The fourth class, and why it does not fit the other three — exploratory

**Status: identified in design dialogue, not verified. More "a promising direction" than a
result.** Recorded here because the gap it names is real and the three-class scheme above
silently failed to cover it.

Classes (a), (b) and (c) all work by appealing to a **universal, cross-domain regularity**:
Zipf holds broadly across natural languages and extends to code; Benford holds across
measurement domains; a format registry is externally specified and shared. Business-logic
values have no such law. Nothing predicts what fraction of orders in an arbitrary e-commerce
system are `completed` versus `pending`. The regularity is idiosyncratic to one application.

**The naive fix is circular and is rejected in its fully-naive form.** Using the scored
corpus's own empirical frequencies as the baseline means fitting the reference to the exact
data being scored against it — the same in-sample optimism the charge machinery exists to
correct everywhere else. Note, though, that this may not need a bespoke fix: the existing
charge term might already price this the way it prices everything else. That was not
resolved; it is recorded as open (§15.3).

**The real alternative is an external empirical baseline, but not a single one.** Building
the reference from a large real-world sample outside the scored corpus avoids the
circularity. But there is no single such baseline to find, because business-logic
distributions are domain-specific: an e-commerce status distribution shares nothing with a
CI/CD build-status distribution. The structure indicated is therefore **multi-model** — many
kept-separate, domain-specific empirical references, with a nearest-precedent lookup — and
**not single-model**, meaning one shared global compressed representation blending across
domains. Forcing genuinely disjoint domains into one representation would produce something
either meaningless or dominated by whichever domain is overrepresented in the sample.

Two further points, both consequences rather than additions:

- **Routing is architecturally separable from representation.** How a new field is matched to
  the right domain-specific baseline — nearest-neighbour lookup, a trained classifier,
  something else — is a separate choice from whether the baselines are kept separate. But
  the options have genuinely different prerequisites (unsupervised clustering needs no
  labels; a trained classifier typically needs labelled or pseudo-labelled data), which is a
  real practical constraint rather than an implementation detail. Open (§15.3).
- **Baseline selection is per-subtree, not per-document.** Different fields in the same
  document can belong to entirely different domain clusters. This is consistent with — and
  was arrived at independently of — the tree-of-lattices structure in §7.

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

Three smaller ones in the same bucket: which allocation scheme is the default (§9.4); whether
negative-net facts are dropped before allocation runs or emitted with a signed number (§6.4);
and whether the pointer-cost and specification-cost cases of the charge (§6.3) are two
ledgers or one ledger with a case split.

### 15.3 Open within the fourth baseline class — exploratory

Both of these are inside the §4.2 material, which is the least settled part of this document.

- **Is a corpus-empirical baseline actually circular, or does the charge already price it?**
  The fully-naive form — fit the baseline to the same data it scores — is circular. But the
  charge exists precisely to correct in-sample optimism elsewhere, and it may already do so
  here without a bespoke mechanism. Not resolved.
- **Routing mechanism.** Nearest-neighbour lookup, a trained classifier, or something else,
  for matching a field to its domain-specific baseline. Separable from the multi-model
  decision itself, but the options have different prerequisites (labels or no labels), which
  constrains the choice practically.

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

## 16. Relationship to other documents in this repo

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

## 17. Provenance of the quantitative claims

Every number in this document comes from one of the simulations run during derivation, or
from the prototyping pass behind §7. All are on synthetic structure. **None is measured on a
real corpus.**

The confidence is not uniform and should not be read as such:

- §5, §6, §8, §9 numbers come from targeted simulations built to test specific claims,
  several of which refuted the claim they were built to check.
- §7 numbers come from a prototyping pass — bottom-up versus brute-force agreement, the DU
  locality break, the three-policy composition check, and the refactor equivalence check.
  Same synthetic-data caveat applies.
- §4.2 has **no numbers and no verification.** It is a direction identified in dialogue.

The literature claims — Krimp's Standard Candidate Order (support-descending, then
cardinality-descending, then lexicographic) and Standard Cover Order (cardinality-descending,
then support-descending, then lexicographic), SLIM as the gain-ordered variant, Grünwald &
de Rooij on plug-in redundancy under misspecification, Vovk & Wang on admissible e-merging,
Wasserman/Ramdas/Balakrishnan on split-LR universal inference, Ieong & Shoham on MC-nets,
Deng & Papadimitriou on cooperative solution-concept complexity, De Bie's FORSIED — were each
checked against the sources rather than recalled, after two overclaims early in the
derivation were caught that way.
