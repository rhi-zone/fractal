# Inference of structure from a corpus, derived from first principles

> **SUPERSEDED — historical record.** Current theory is in
> [`inference-theory.md`](./inference-theory.md). This document is retained for its
> cleanroom provenance record (below), its retraction table (§13), and its convergence check
> against external prior art (§14), all of which remain accurate.
>
> Several load-bearing sections here are now **wrong**, not merely incomplete — in
> particular §4's "a fact's credit is computed from the fact alone" and "no description
> language anywhere", §5's "credit above zero is the only admission bar / nothing is
> discarded" and its memorization argument, §6's "no other fact-to-fact relation is
> required", and §9's account of what the core emits. See §13 of `inference-theory.md` for
> the full retraction table with reasons. Do not treat any numbered section below as current
> without checking it there first.

**Provenance.** Derived in a cleanroom session with no access to this project's inference implementation or its earlier design document. External prior art was read only after the derivation closed, as a convergence check (§14). Nothing below is JSON-specific; §2 states the only properties of the data actually used.

## 1. The problem

Given a finite collection of observed values, produce a description of the process that emitted them.

The first thing true of this problem is that **the answer is not determined by the data.** For any finite corpus, infinitely many descriptions are perfectly consistent with it — the corpus enumerated verbatim is one, "any value whatsoever" is another, and an unbounded range lies between. Consistency is free. A theory of inference here is therefore not principally a theory of checking; it is a theory of *preference over consistent descriptions*.

Second, the true type is not recoverable in either direction. From positive examples only: every proper subtype of the truth covering the observed values remains live, since everything it predicts the truth also predicts; and every proper supertype remains live, since the evidence against it would be a counterexample, and a positive-only corpus contains none by construction. The second never closes even in the limit, because absence is never observed.

The target is nonetheless the truth, understood intensionally: **the type as defined in source.** A finite expression someone wrote, not a set of values. Exact recovery is conceded as impossible; the theory's job is to say what the evidence warrants, not to claim recovery. Where the evidence warrants nothing, the theory should say so rather than guess.

## 2. What is given

Only this: values are finite structures built from a known set of constructors, with decidable equality. That is not a modelling assumption — it is what it means for the data to be in a known format.

Occurrences within a value are addressable. **Addresses are not identity.** An address locates a constituent within one value; whether two constituents in different values are instances of the same thing is a separate claim entirely.

That distinction is forced, not stylistic. Under recursion, a shared thing occurs at unboundedly many addresses and no finite address-based rule reaches them all; under mutual recursion the occurrences interleave across several distinct things. The conflation already fails visibly for arrays, where two different addresses are universally treated as the same thing — correspondence was always being derived by quotienting over indices in that case, while being asserted from addresses elsewhere. Recursion only makes the existing inconsistency impossible to hide.

## 3. The core primitive: a fact is a scope and a claim

A **fact** consists of the set of values it claims to apply to (its **scope**) and what it claims about them.

Scope is not an independently-existing grouping to be solved for. It is definitional: the scope of a fact is whatever set of values that fact claims to cover, fixed the moment the fact is stated. This matters because it removes what would otherwise be a circularity — if scope were a free variable determined jointly with the facts scoring it, credit would have no well-defined reference set. It does, because stating the fact fixes it.

Correspondence is therefore **not a separate entity.** Asserting that occurrences at unrelated addresses are the same thing simply *is* stating a scope. One primitive, not two.

Consequently there is **no partition and no global class structure.** Scopes may overlap, nest, or cross-cut arbitrarily, and nothing arbitrates between them. Nothing has to be split, chosen, or reconciled.

## 4. Credit

For a fact, the values occupying its scope form an observed multiset with a Shannon entropy. The fact's **credit** is the reduction in that entropy from knowing the fact — the mutual information between the fact and the occurrences it covers.

Four properties, each load-bearing:

- **Absolute bits, not fractions.** Fractions are not additive across different denominators, and the shape of this theory is accumulation across facts about entirely unrelated parts of the data. Absolute amounts sum; fractions of a scoped denominator do not. Picking any global denominator would break this.
- **Corpus-relative.** Entropy is measured against the observed multiset, not against the unobservable source. Measuring against the source is not merely hard but ill-posed — there is no way to locate what is missing from something unobserved.
- **By itself.** A fact's credit is computed from the fact alone. It does not inherit its constituents' credit. This is what prevents aggregates from borrowing.
- **No description language anywhere.** Credit is Shannon entropy of an observed multiset and its conditional. Nothing is charged for a fact's own size, because a fact's size is an artifact of whoever designed the vocabulary it is stated in, and charging for it would import that person's choices into the measure. The cost of a fact is not its length; a fact simply gets credit for what it explains and no credit for what it doesn't.

## 5. Admission

**Credit above zero is the only admission bar.** Anything explaining more than nothing is a fact. Nothing is discarded.

Two ends of the space fall out without any exclusion rule. The maximally general claim explains nothing and ranks at the bottom — nothing needs to forbid it. Memorization is powerful only in aggregate, and aggregates do not inherit their parts' credit (§4, §6), so taken individually each literal fact covers one occurrence while a broad fact covers many. Neither end needs a rule against it; the ordering handles both.

**Non-vacuity is guidance, not a rule.** A fact that constrains nothing below the top type contributes nothing, so a sensible implementor will not submit it. This is an observation about rational behaviour, not a condition the theory enforces. It is also a *weaker* test than the admission bar and must not be confused with it: a claim can narrow below top and still explain zero bits corpus-relative — "this field is never the string `zzz`" narrows the type but explains nothing if `zzz` never occurs.

## 6. Constitution: the sole fact-to-fact relation

A composite fact is **constituted by** its constituent facts. This is a part-whole relation — the composite is made of them, not merely licensed by them or expressible only through them.

It does two jobs:

1. **Prevents double-counting.** The composite's bits *are* its constituents' bits seen together. A consumer summing both has counted once.
2. **Prevents aggregates from borrowing credit**, which is what keeps memorization from winning (§5). This was adopted for the first reason and turned out to do the second.

No other fact-to-fact relation is required. A formal competition or exclusivity relation was considered and rejected: detecting that two unrelated facts explain overlapping bits is expensive, and there is no single well-defined answer about how to apportion between them. Constitution passes both tests — a composite knows its parts by construction, unambiguously.

**Sharing** — two composites having a constituent in common — is a genuinely distinct relation, not constitution seen from another angle. But it is *derivable* from constitution rather than separately recorded, which is why the compact representation of §9 needs no extra machinery.

## 7. The corpus is not a value

Any observed value is fair game at any depth. The corpus root is not, because we built it.

Three separate single-value documents and one document containing an array of those three values carry **identical element-level evidence** — three occurrences either way, same recurrence, same credit. Recurrence is counted over occurrences, and packaging is irrelevant to it. There is no within-sample versus across-sample distinction.

They differ in exactly one thing: the array version contains one additional occurrence, the array itself, whose properties (length, ordering, element distinctness, joint structure among elements) are facts about the source. The corresponding "facts" about the corpus — how many documents there are, what co-occurs with what — are facts about our collection procedure.

Hence: **if grouping is informationally real, it should be represented as data.** A batch that genuinely arrived together is a value and should be one, at which point its container facts are available exactly as they should be. If it is not data, it is not evidence. This keeps sample-boundary conventions out of the theory entirely.

## 8. Discriminated unions

A discriminated union requires no new machinery. It is a scope decision.

One fact has scope "occurrences where the tag is `a`" and claims the payload has shape A; another has scope "occurrences where the tag is `b`" and claims shape B. Within each, nothing is conditional. The correlation between tag and payload is the *reason* the facts earn credit, not a relation stored in the structure. Pure constitution survives intact.

**The distinction from a plain union is structural, not quantitative.** Corpus-relative and with no held-out data, an arbitrarily enumerated scope explains as many bits as a principled one — credit does not separate them. What separates them is whether the scope is **derivable from observed constituents** or only **extensionally enumerable**. A discriminated union is the derived case; a plain union is the enumerated case. Enumerated scopes are permitted but degenerate.

The discriminant must be **co-located within the same value** — not a sibling specifically. A tag nested deeper still yields a derivable scope. Siblinghood is the common case, not the condition. (Whether an implementation searches deep nesting is a cost question, §11.)

Nothing requires the discriminant to be a string literal in a fixed field. Any observed constituent determining the scope works: booleans, numbers, field presence, shape itself.

## 9. Output

The output is a **structure**, holding alternatives simultaneously with common substructure shared rather than duplicated — the sharing being a consequence of constitution, not a representational trick applied afterward.

It is deliberately not called a spectrum or a lattice; both names presuppose a topology that has not been derived. Nothing has been established about its shape beyond: facts, their credits, and constitution edges among them.

Alternatives coexist. Losing facts are present. Nothing is filtered on the way out.

## 10. Synthesis is a separate step

Producing a single committed type from the structure is **the caller's act, not the core's.** All configurability lives here: cutoffs above the admission bar, preferences between narrow and general facts, and any policy about what to do with weakly-supported facts.

The core is **indifferent to what callers do.** It does not model downstream use, and the "true type" is not use-case-relative — there is one truth, and different uses differ in what they do with the evidence about it, not in what the truth is.

Whether a given value should be committed to as a general type or as its literal type is a synthesis question. Both facts exist in the structure with their credits; the core has no opinion.

## 11. Explicitly out of scope

Each of these is implementation-relative, not theory-relative:

- **Search** over candidate scopes and candidate facts. The theory says what a legitimate fact is and how it is scored. Which candidates to generate is entirely the implementor's.
- **Pruning bounds** for skipping facts unlikely to clear the bar. A sound bound must be optimistic — never pruning something that would have cleared — and whether such a bound exists for this credit measure is unknown. Any bound is arbitrary and implementation-dependent.
- **Nesting-depth cost** for finding co-located discriminants. Theoretically unrestricted (§8), practically expensive with depth; no implementation is obliged to search deeply.
- **Deduplication and provenance.** All claims are relative to the corpus as given. If upstream processing distorted multiplicities, scoring is distorted accordingly. This is an accepted limitation, not a gap.

**Finiteness of the output is implementation-relative, not derived.** With an open, extensible fact vocabulary, the predicates assertable about a single occurrence are unbounded, so finiteness does not follow from values being finite. It follows from implementors submitting finitely many facts. The accumulation is over *submitted* facts clearing the bar, never over all conceivable facts.

## 12. Known limits

- **Exact recovery is impossible**, in both the narrowing and widening directions (§1), and conceded.
- **Source distinctions explaining zero bits are outside the domain**, not failures within it. The recoverable part of the source is exactly the part that explains entropy.
- **Corpus-relativity means silence where the corpus is silent.** With a single occurrence and no external prior, the theory has nothing to say. It does not fabricate a claim, and it also cannot borrow one from outside the corpus, because everything it measures is corpus-internal. See §14 for prior art that addresses this by leaving the corpus.

## 13. Self-audit: constructions proposed and retracted

Recorded because it is evidence of what survived scrutiny versus what merely sounded right.

| Retracted | Why |
|---|---|
| Two-part description-length coding (model cost + data cost) | The model-cost term is definable only relative to a description language; charging for it imports that language's arbitrary choices |
| A formal notion of "loss," and a two-kind loss decomposition | Built on a word used colloquially in passing; both halves restate the admission bar viewed at its boundaries |
| A "minus one instance" deduction as the model-cost replacement | Superseded by absolute credit plus constitution, which does the same work natively; its removal also dissolved a spurious single-observation problem |
| Two hard exclusion mechanisms for the narrow and general ends | Exclusion is unnecessary when nothing is discarded; ranking suffices |
| Priced language extension as a coherence requirement | Dissolved once statement cost was waived — a construct invented for one use gets credit for one use |
| A warrant-versus-expressibility taxonomy of dependency | The real relation was constitution, which is neither |
| A formal competition relation | Failed both tests: not cheap to mark, no single answer about who competes with whom |
| "Spectrum" and "lattice" as names for the output | Both presuppose an underlying topology that has not been derived |
| Free-selector-versus-paid-selector as the DU/union distinction | Depended on charging for statement cost, which was waived; the real distinction is derived versus enumerated scope |
| The claim that the credit measure depends on which correspondences hold | False once scope is definitional; what survives is stronger — correspondence and structure are not different objects |
| A joint fixed point between class structure and credit | Dissolved by scope being definitional; there is no fixed point because there is nothing jointly determined |

## 14. Convergence check against external prior art

Performed after the derivation closed, against the five external published works only.

**Strongest independent convergence.** JSONoid's central move — decompose schema into independently scored, independently combinable pieces of evidence rather than one monolithic pass — is the same commitment as facts-with-scopes accumulated independently. Its ablation finding that individual signals have wildly different accuracy and overfitting profiles is direct support for surfacing all facts with their credits rather than emitting one merged answer. Baazizi et al.'s parametric equivalence knob, and specifically their 2020 conclusion that *neither* extreme is universally right and the choice should be exposed rather than fixed, is the same conclusion as synthesis-is-caller-configurable, reached from the opposite direction.

Tagger's tagged-union formalism, `[A.value = const] → [B.type = σ]`, is precisely a fact with a derived scope and a claim. That two derivations arrive at the same object from unrelated starting points is mild evidence for it. Its finding that no universal threshold works across datasets is consistent with the admission bar being zero and all thresholds living in synthesis. ptype's treatment of anomaly as a first-class competing explanation rather than a preprocessing exclusion matches nothing-is-discarded; its guarantee that no observation ever receives zero probability matches impossibility being unbounded bits rather than a hard exclusion.

**Notable divergences.**

*No merge operation.* Both JSONoid and Baazizi centre on an associative binary fusion, with associativity load-bearing for distribution and incrementality. This derivation produced no merge at all — facts are submitted and scored independently, never fused. Distribution is therefore free rather than earned by a theorem. Whether the absence of a merge is a simplification or a missing piece is worth examining; it is a real structural difference, not a notational one.

*No selection.* ptype selects the maximum posterior, Baazizi produces one fused type, Tagger emits one schema. This framework selects nothing, and their unresolved tie-breaking problems are not problems here — ties are surfaced. Conversely, they deliver a committed answer and this does not, which is why synthesis exists as a separate step.

*No widening.* Baazizi's fusion is monotone: the result is provably a supertype of both inputs. Nothing here widens; narrow and general facts coexist with different credits, and their subtyping-correctness theorem has no analogue and needs none.

*No aggregation problem.* quicktype needs a geometric mean to combine multiplicative per-item evidence. Absolute bits are additive, so the question does not arise.

**A limitation the survey confirms.** quicktype scores individual keys against a model trained on *other* corpora, which is how it produces signal from a single document where corpus evidence does not exist. This framework is strictly corpus-relative and therefore has nothing to say in that case — correctly, by construction, but it is a real limit. External priors are outside the theory by design. Any implementation wanting single-document signal must obtain it from outside the corpus, and that is not a gap the theory can close on its own terms.

## 15. Relationship to prior design work in this repository

This document was produced under a deliberate cleanroom constraint: no access to this project's `packages/type-ir/src/from-json-corpus.ts` implementation, and no access to the earlier `docs/design/json-inference-model.md` design document, which was itself written with that implementation in view. Whether this derivation supersedes, complements, or conflicts with that earlier document is an open question requiring a dedicated comparison pass — not established by this document and not to be assumed from its existence.
