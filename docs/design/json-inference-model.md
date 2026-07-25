# Design document: a model-comparison foundation for JSON type inference

## 1. What inference *is*, formally

### 1.1 The problem statement

A corpus `V = (v₁ … v_N)` of JSON values is assumed drawn from an unknown data-generating process `P` that has a true-but-unobserved schema `S*`. Inference produces `Ŝ`. The current code has no stated objective at all — each pass optimizes an unnamed local criterion, and the passes' relative authority is decided by *ordering* in `resolveEvidence` (steps 2–7), with several documented as needing "first refusal" over the next. That ordering is a hidden arbitration mechanism with no criterion behind it. Any candidate formalism must, at minimum, put all decisions at a position on one comparable scale.

### 1.2 The five candidates

**(a) Heuristic cascade (status quo).** "Confidence" is unrepresented; the only output is a boolean per pass, produced by comparing one or two summary statistics to a constant. Different passes' statistics live on incomparable scales (a K/N ratio, a Jaccard distance, a growth ratio, a skew percentage), so nothing can be traded off against anything else. The prior art is unanimously negative on this as a foundation, from three independent directions: Tagger's authors observed that "settings working well for one dataset yield poor results on another" and built a GUI specifically so users could watch thresholds fail (§1); quicktype's author calls the approach "not very scientific" outright (§3); JSONoid's own conclusion is that "heuristics to reduce overfitting remain unimplemented future work," with naive enable-everything overfitting at 42.6% (§4). **Handles none of the four failures**, by construction — all four are cases where a richer statistic was reduced to a scalar before the decision.

**(b) Frequentist hypothesis testing.** Null "this position is a record," alternative "map"; confidence = p-value, correctness = type-I error control. Genuinely fits failure 1 (a test of the growth curve against a fixed-vocabulary null is a real, standard test). Two structural problems: multiple testing (GitHub Issue alone has ~40 structural positions × 6 passes; family-wise error needs Bonferroni/FDR machinery that has no natural home in a tree walk), and — more fundamentally — testing *rejects* a null but does not *choose among* many non-nested alternatives. "Which of five sibling fields is the discriminant" is not a hypothesis test. **Fits failure 1; awkward for 2 and 4; wrong shape entirely for 3**, which is a mixture-estimation problem, not a test.

**(c) Bayesian model comparison.** At each position enumerate hypotheses `H` (record over field-set F, map with value type V, enum over member set M, union of k variants, DU conditioned on field f, …) and score `p(H | V) ∝ p(V | H)·p(H)`. Confidence = posterior probability, on one scale across all hypotheses at that position — which is precisely the property the cascade lacks. The priors are where configuration lives, and this is the formalism's honest answer to "hardcoding smells wrong": the constants don't vanish, they become *few, domain-meaningful, and user-owned*. This is directly what ptype does (§2): a column type is chosen by maximizing `p(t=k|x) ∝ p(t=k)·Πᵢ[π_k^k·p(xᵢ|k) + π_k^m·p(xᵢ|m) + π_k^a·p(xᵢ|a)]`, with the mixture weights hand-tuned but *stated as priors*, not buried in a threshold. **Handles 1, 3 and 4 naturally; handles 2 only if the hypothesis space is enlarged — see §3.**

**(d) MDL.** Score `= L(H) + L(V|H)` in bits; pick the shortest. Under a coding argument this is (c) with `−log p(H) = L(H)`, so it is not a competing theory — it's a different *notation* for the same procedure, in which "confidence" is a margin in bits (directly interpretable: "grouping by `type` saves 340 bits") and priors are code designs. It's especially natural for record-vs-map, where the tradeoff *is* literally a coding tradeoff: a record pays for its field vocabulary once in the model and near-nothing per sample; a map pays nothing in the model and a key-string code per entry per sample. **Same coverage as (c).**

**(e) Discovery-rate / Good–Turing vocabulary estimation.** Not a whole formalism, but the correct estimator for a sub-question that recurs in *three* of the four failures: "have I seen the whole vocabulary?" Good–Turing puts the unseen mass at ≈ `f₁/N` (singletons over sample count); Chao1 lower-bounds true richness at `S_obs + f₁²/(2f₂)`. That question is enum member-set completeness (failure 4 — this *is* the missing coupling), object-key vocabulary boundedness (failure 1), and unseen-variant count (failure 2's variant recall). The survey's own synthesis gropes toward this under the name "Zipf-aware weighting" — "treating a field's value-frequency distribution shape, not just its raw cardinality, as enum evidence" — and flags it as unevaluated. JSONoid's HyperLogLog (§4) answers the adjacent cardinality-at-scale question but not the completeness one.

### 1.3 Reading

(c) and (d) are the same procedure in two notations, and (e) is an estimator that lives *inside* their likelihood terms rather than a rival. So the real question isn't which of five, it's: **which notation do we write the scoring functions in.** Tradeoffs, impartially:

- *MDL*: no explicit prior elicitation; every knob is a code-length choice defensible by universal-coding arguments; margins in bits are legible in debug output and in `meta`. Cost: code design is prior specification wearing a different hat, and someone has to design the codes.
- *Bayesian*: priors are explicit and therefore honestly user-facing (which is exactly what question 2 asks for); posteriors are calibratable and testable. Cost: more surface to elicit, and normalizing constants across a heterogeneous hypothesis space need care.

## 2. "Dirty data" formally, and what belongs to the user

### 2.1 A generative model

At a position, model the corpus as a two-component mixture:

- with probability `1−ε`, an observation is drawn from the true schema: variant `k` with proportion `θ_k`, where `θ ~ Dirichlet(α)` over variants;
- with probability `ε`, it is **contamination** drawn from a broad noise distribution `Q` — ptype's X-factor PFSM (§2), deliberately given the widest possible alphabet so it assigns *some* nonzero probability to anything but always less than a specific type would to a well-formed value.

Per-value posterior: `p(noise | v) = ε·q(v) / (ε·q(v) + (1−ε)·Σ_k θ_k·p_k(v))`. The schema-level question — "is variant k real?" — is then a model comparison: does admitting variant `k` into the schema buy more than explaining its observations as contamination costs?

### 2.2 Why skew alone provably cannot decide this

Both hypotheses predict a small minority count. That's why `majorityRatio > 0.9` measured a significant *harm* to union recall (p=0.0005): it always pays the cost of collapsing a rare-but-real variant, and this session's case set contains no corpus where the minority is genuinely off-schema, so it can only ever show the downside. The discriminating signals *do* exist in the data and are simply unused:

1. **Concentration of the minority.** Five samples that are all `"N/A"` are five draws of one thing; five samples that are five distinct random strings are five draws of noise. Identical skew, opposite conclusion. Formally, a real variant is a *low-entropy* explanation, contamination is *high-entropy by construction*. `node.values` already retains everything needed to compute this — the current code just counts.
2. **Prior mass.** Under `Dirichlet(α)` with small α, a rare variant is a priori plausible; with large α it isn't. That's a single interpretable dial.
3. **Sentinel vocabulary.** ptype's curated missing-data alphabet (`-1, -9, -99, "", " ", "NA", "NULL", "N/A", NaN`) — §2 calls this "disguised missing data" after Pearson (2006). A value's *identity* is evidence of contamination independent of its count. The survey already lists this as adoptable ("a curated missing-value-sentinel alphabet... as a first-class detector, distinguished from 'this field is genuinely nullable'").
4. **Cross-position correlation.** Contamination is usually per-*record* (one bad row has several bad fields); a real variant is coherent. **This one is not currently observable** — evidence is gathered per position with no sample provenance. Flagging it as an evidence-layer gap, not an available signal.

### 2.3 The configuration split

**User-stated (honest priors, domain-meaningful):**
- expected contamination rate `ε` — or a `Beta` prior on it ("I think roughly 1% of these log lines are junk; I'm not sure").
- **asymmetric loss**: the cost of dropping a real variant vs. admitting noise into the schema. This is the decision-theoretic knob that *replaces* `0.9` — and unlike `0.9` it has a meaning the user can actually hold an opinion about.
- vocabulary concentration `α` (equivalently: "I expect a handful of variants" vs. "I expect many").
- optionally: a domain sentinel vocabulary; a domain-specific `Q`.

**Algorithm-assumed (documented, not user-facing):** i.i.d. sampling given the schema; contamination independent per observation; the functional form of `Q` (broad/diffuse over the observed domain).

**Output changes from a silent collapse to a report:** posterior contamination rate, per-value posteriors for the flagged observations, and a decision taken *under the stated loss*. This is the survey's own §2 recommendation, verbatim: "let corpus-level inference *report* outlier rate rather than silently absorbing it into the type."

**Honest caveat.** `ε` and the loss ratio are still numbers. The claim is not that configuration disappears — Tagger's finding that no threshold generalizes across datasets (§1) is exactly the argument that it *must not*. The claim is that there is one small set of numbers, on interpretable scales, whose mapping to behavior is *derived* rather than hand-tuned per pass — replacing eleven algorithm-internal cutoffs in `ResolveStrategy` whose interactions nobody can reason about.

## 3. Does one framework subsume all four? (No — three yes, one no)

**Failure 1, dict-vs-record: YES, cleanly.** This is the best case for the whole argument. Under MDL, "record over vocabulary F" pays `|F|` key-strings once in the model and ~0 per sample; "map" pays nothing in the model and a key code per entry per sample; a third hypothesis, "fixed fields + open map," is scored on the same scale rather than reached via the current `commonKeys.size > 0` special case. Equivalently in Bayesian terms: a CRP/Dirichlet-process predictive over keys has expected distinct-key growth `~ α log N` and **never plateaus**, while a fixed-vocabulary multinomial saturates. Discriminating `[3,9,13,16,17,18,18,19,20,20,20,20]` — zero new keys in the last four of twelve, i.e. `f₁ → 0` — from a CRP is a likelihood computation that the plateau dominates, and it is exactly the information the endpoint ratio 1.4167 discards. The full per-sample key sequence is **already collected** (`EvidenceNode.object.keySets`, in corpus order); `walkAndDetectDicts` throws it away at line 1470. Secondary benefit: this makes Baazizi's K/L equivalence (§5) a *scored* per-location choice rather than a global parameter — the survey already names automatic-per-location K/L selection as our point of departure from Baazizi 2017/2019/2020, and MDL finally supplies the criterion that departure was missing.

**Failure 4, enum under Zipf: YES, and it's the same machinery.** Under a Dirichlet-multinomial (or Pitman–Yor, which is the right model for Zipfian tails) over a position's value frequencies, one posterior computation yields both quantities that are currently divorced: (i) `p(closed small vocabulary | data)` vs. `p(open vocabulary)` — the shape question `enumDetection` measures; and (ii) the predictive probability of an unseen member, i.e. Good–Turing's `f₁/N` — the completeness question `enumMemberFidelity` measures. They are coupled *because they are marginals of the same model*: high discovery mass should temper the shape claim, and at minimum must be reported alongside it. The pathology the harness found — skew makes (i) look better and (ii) worse at the same N — becomes the model doing the right thing: skew raises tail singleton mass, which lowers completeness, which propagates. **Required evidence-layer change**: `EvidenceNode.distinctValues` is a `Set`, so `f₁`/`f₂` are *not derivable today*. This needs value frequency counts. It is the one genuinely necessary change below the resolution layer.

**Failure 3, dirty data: YES**, per §2 — this becomes a mixture posterior instead of a threshold, and the decisive signal (minority concentration vs. diffusion) is already sitting in `node.values`. So this is a wrong-decision-procedure failure and the formalism does fix it. The residual — cross-position correlation — is a refinement, not a requirement.

**Failure 2, envelope-pattern DU: NO. Not by formalism alone.** This is the one the brief was right to suspect. As measured, separation for `{type, data:{…}}` is **identically 0** for every candidate at every N: the feature is constant, not mis-scaled. A better decision rule over the same feature cannot help. What's needed is a **hypothesis-space and search-scope change**: the hypothesis "condition on field `f`" must be scored by the *recursive description length of the whole subtree* under that grouping, not by a flat distance between immediate sibling key sets. Under MDL that fix falls out for free — grouping by `type` turns `data` from one nine-field all-optional union into five tight records, an enormous compression win — **but only because the score was redefined to be recursive.** Two distinct changes, and the second is not implied by the first: a correct formalism applied at the wrong tree depth is still wrong. The framing that unifies it: today's `cohesion × separation` is a *flat proxy* for "compression gained by conditioning on `f`," and it happens to be degenerate on an important real-world class (every envelope-shaped API — Stripe, most webhook systems, JSON-RPC). MDL computes that quantity exactly and recursively. So the formalism supplies the right currency; the search scope is a separate, real piece of work.

**A fifth benefit none of the four failures names, worth stating because it's the strongest architectural argument.** Pass *ordering* currently arbitrates between mutually exclusive interpretations — the CFD pass "runs only after `tryDetectDU` has had first refusal," splitting "runs after dict detection (not before)," and so on, each documented with a plausible local rationale and no global criterion. Under model comparison this dissolves: all hypotheses at a position are scored in one currency and the best wins. That's not a patch to any of the four failures; it's the removal of the mechanism that made them individually invisible.

## 4. Architecture

### 4.1 The one primitive

Everything is built from a single recursive operation:

```
score(node: EvidenceNode, hypothesis: Hypothesis, priors) 
  -> { bits: number, ref: TypeRef, children: ScoredNode[], breakdown }
```

`resolve(node)` enumerates the candidate hypotheses applicable at that position, recursively costs each (children are costed *under the parent's hypothesis*, since conditioning on `f` changes how children are grouped — this is what makes failure 2 fixable), and returns the minimum-total-bits result plus its runner-up margin. Enum, dict, DU, CFD, structural split, and dirty-data stop being passes and become **hypothesis families** registered against this primitive. Today's architecture has six independent walkers, each re-traversing the tree and each able to overwrite the last; that becomes one traversal with one criterion.

### 4.2 What survives, what changes, what's new

**Survives essentially intact — `collectEvidence` / `EvidenceTree`.** This is the good news and it's substantial: the phase-1/phase-2 split was already the right cut, and phase 1 already gathers per-position type counts, per-sample key sets *in corpus order*, per-field presence counts, raw values, and raw element objects. Failure 1's entire signal is already there. Required additions: **value frequency counts** (for Good–Turing; failure 4's blocker) and, optionally, **per-sample provenance indices** (for cross-position contamination correlation). Neither is structural.

**Survives and becomes central — the eval harness.** `inference-eval.ts` and `stats.ts` are not collateral; they are the *acceptance mechanism* for every phase below. `runEvaluationTrials`' seed derivation (`name:n:trial`) was purpose-built so two configurations share corpora index-for-index, which is exactly what's needed to paired-bootstrap new-resolver-vs-old. `ablationRunner` generalizes from per-toggle to per-hypothesis-family. `realistic-corpora.ts` becomes the regression fixture set with baseline numbers recorded (GitHub Issue overallF1 0.876, npm package.json overallF1 0.280, Stripe webhook overallF1 0.472) to beat. **One genuine addition needed**: a *calibration* axis. If the engine emits posteriors, the harness must check that 0.8-confidence claims hold ~80% of the time — no current axis measures this, and an uncalibrated posterior is worse than an honest threshold.

**Survives as the within-hypothesis merge — `unifyTypes`/`mergeAll`.** Baazizi's `Fuse`/`LFuse` (§5) is still what builds the `TypeRef` once a hypothesis wins. The survey notes we've never stated or tested its commutativity/associativity, which Baazizi proves as Theorems 5.4/5.5; that gap gets more expensive under an engine that invokes it under more orderings, so it's worth closing (fast-check is already in the package per `from-json.fuzz.test.ts`).

**Replaced — `ResolveStrategy`.** Eleven threshold constants collapse to a small `InferencePriors` (noise rate, loss asymmetry, vocabulary concentration, minimum-evidence floor) plus escape hatches. `customResolvers` becomes "register a custom hypothesis family," which is strictly more expressive than today's post-hoc override hook.

**Genuinely new:** a bits/cost calculus (universal integer codes, string codes, Dirichlet-multinomial marginal likelihoods, CRP predictive) — small, pure, unit-testable in isolation; a per-position hypothesis enumerator; the recursive search with memoization; and a confidence surface on output `meta` (chosen hypothesis, runner-up, margin) — which is also what makes the engine debuggable, and matches the transparency Tagger's demo explicitly showcases to build user trust (§1).

## 5. Effort, risk, phasing

**Scope, honestly:** this is *predominantly* a `resolveEvidence` redesign, but not purely. One required evidence-layer change (value frequencies), one optional (sample provenance). `collectEvidence`'s structure survives; its output grows.

**Risks:**

- **Search blowup.** Recursive scoring where a parent hypothesis reshapes children's grouping is exponential if done naively. Mitigations: keep Tagger's unary discriminant restriction (which it imposes for exactly this reason, §1 — CFD discovery "scal[es] exponentially in the number of attributes"), greedy top-down with memoized child costs, cheap gates before costing. **Must be measured** — this session already hit an O(n³) surprise in complete-linkage clustering (6.9s → 52ms at n=500 after a rewrite).
- **The arbitrariness relocates, it doesn't vanish.** MDL moves judgment into code design. The defensible claim is that the choices become fewer, principled by universal-coding arguments, and *globally consistent* so hypotheses are comparable. It is not "no magic numbers," and this doc says so plainly.
- **Regression ambiguity.** ~3,200 lines of tests encode current behavior (`from-json-corpus.test.ts`, `from-json.adversarial.test.ts`, `from-json.fuzz.test.ts`). Some expectations *should* change — that's the point.
- **Calibration is unproven until measured.**
- **Small N is genuinely hard, and no formalism rescues it.** At N=5 the posterior is prior-dominated. `docs/roadmap.md` already names "confidence scaling at low sample counts" as an open design question; this is where it lands, and it lands as a policy choice, not a solution.

**Phases** (mirroring the 5-phase eval-rigor plan that shipped this session — each lands real, green code):

- **P0 — ratification, no code.** This document plus owner decisions (see "Resolved decisions" below).
- **P1 — cost calculus + evidence addition.** New pure module (`description-length.ts`), unit-tested against hand-computed bit counts; add value frequency counts to `EvidenceNode` (behavior-preserving). No integration. Ships green.
- **P2 — first family end-to-end: record vs. map vs. mixed.** Behind `resolver: "heuristic" | "model"`, defaulting to heuristic. Acceptance gate: package.json overallF1 moves off 0.280 with fieldCoverage recall off 0.06, *and* paired-bootstrap shows no `dictDetection` regression on the generated harness. This is failure 1, the cleanest case, and therefore the right proof of concept.
- **P3 — vocabulary family: enum shape ⊕ member completeness, jointly.** Dirichlet-multinomial + Good–Turing, emitting a completeness confidence. Acceptance: the zipfian paired test flips from "shape better / members worse" to a single coupled, calibrated report.
- **P4 — grouping family: DU / CFD / structural split unified**, scored by *recursive subtree* description length. This is where failure 2 is fixed and where the search-cost work lives. Acceptance: Stripe `unionFidelity` 0.00 → recovers `event` as a 5-variant DU.
- **P5 — noise model.** Contamination mixture with user-stated `ε` and loss, replacing `walkAndDetectDirty`. Acceptance: the p=0.0005 recall harm reverses on the dirty-outlier profile **and** a *new* generator profile with genuinely off-schema contamination — which the current case set cannot construct, as that test's own comment concedes ("This ablation set has no case where a corpus is contaminated with values that are genuinely NOT part of the schema") — demonstrates the intended upside.
- **P6 — flip the default,** deprecate the per-pass thresholds, record calibration numbers, update the survey's Synthesis.

## Resolved decisions (2026-07-25)

- **Current heuristic behavior is NOT contractual.** Correctness is prioritized over preserving existing pass/fail behavior. This means later phases (P2-P5) are free to be behavior-changing, not required to be strictly additive — the eval harness (paired bootstrap against the realistic corpora baselines) is the acceptance gate, not "does old behavior still hold."
- **Confidence surface on `meta`: approved.** The engine will emit chosen hypothesis, runner-up, and margin on output `meta`. This is additive to the `TypeRef` contract (a new optional field, not a breaking change to existing consumers).
- **`clusteringMethod`'s fate: deferred to P4.** Whether it's fully subsumed by the new grouping-family architecture or survives as a user-facing override will be decided when P4 is actually built, not speculated now.
- **Small-N policy: resolved as "commit to the conservative/coarser hypothesis, not abstain."** Not "refuse to output anything when confidence is low" and not "commit aggressively with a low-confidence label" — instead, when confidence is low, the engine should prefer the less-specific/less-risky hypothesis (e.g. widen rather than over-commit to a narrow guess). Concretely: a single-sample package.json corpus should still produce an approximately-correct schema, not an empty/refused result — this mirrors how single-value inference (`fromJson`) already never commits to a `literal` type from one sample, extended as a general principle to corpus-level low-confidence cases. This directly informs the calibration work in P1/P3: "low confidence" should route toward a coarser hypothesis in the same hypothesis family (e.g. `string` instead of a premature `enum`, a merged record instead of a premature narrow split) rather than an abstention/error state.
- **MDL vs. Bayesian notation: leaning Bayesian for user-facing surfaces** (priors/posteriors are more directly interpretable for a person stating "I expect ~1% noise" than a bit-margin), **MDL acceptable for internal implementation** where bit-additivity is convenient. Explicitly low-stakes — the two are mathematically equivalent per §1.3, so this doesn't constrain P1-P6's actual algorithms, only the vocabulary used in code/API/docs. Not a hard requirement, just a documented leaning.
