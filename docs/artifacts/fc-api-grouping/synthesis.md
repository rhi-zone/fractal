# Synthesis — Grouping Principle for the Function Core (adversarial judgment)

*Judge brief: be skeptical, do not average. Find what survives the ~1.5-subjects gate.*

Inputs read in full: framing-A (type theory), framing-B (empirical survey), framing-C
(algebra). Provenance is marked throughout: **[grounded]** = stated in a doc; **[judge]** =
my inference/synthesis across them.

---

## 1. Convergence — the candidate spec beneath the vocabulary

Strip the three vocabularies (carrier/invariant ; operand/equilibria ; source-target/slice)
and the same four claims appear in all three, independently:

1. **Group by a TYPE the operation is structurally tied to — never by feature, caller, layer,
   or a free-text module name.** A: carrier sort. B: "home = operand," and feature/caller is
   *named as the wrong axis*. C: the only intrinsic data a morphism carries is `(source,
   target)`, so any intrinsic grouping is type-directed "full stop." **[grounded, all three]**

2. **The grouping must be DERIVED/CHECKED from the types, not asserted by convention.** A:
   membership decidable from types; sealing makes the compiler enforce the boundary; "checked,
   not narrated." B: membership decided by the data, which is *objective*, unlike "feature," a
   moving target. C: grouping "falls out" with zero declaration; "never a name someone typed."
   **[grounded, all three]**

3. **Free functions sprawl precisely because nothing forces closure/structure onto the
   morphism set.** A: "sprawl is the absence of an enforced closure condition." B: sprawl is
   "the middle" — many ops, no type-keyed home, *and* no uniform seam. C: a bare morphism is
   "nothing but a typed arrow," a bag with only `(src,tgt)`. **[grounded, all three]**

4. **There is a primary type-keyed tier plus a triggered second tier, and the second tier
   must also be structural (law-bearing), not a free-text bucket.** A: carrier-ADT default →
   promote to typeclass when a signature recurs across ≥2 carriers. B: type-home primary,
   feature is a *secondary index* only. C: slice/coslice derived primary → functor-with-laws
   for coarser semantic grouping; "require the declared thing to be an actual functor with
   laws, so the grouping is checkable." **[grounded, all three]**

Plus a shared given: **composition is the uniform seam** (B clause 2, C "pipeline is a path
through the type graph"), and for a `T=>U` core it is *already* provided — so the only live
design choice is the *home* tier. **[grounded B/C]**

> **Convergent spec.** Operations cluster by an invariant-bearing TYPE derived from their
> signature; membership is checked from the types, not declared; the namespace is indexed by
> type so it grows with the *data*, not with operations × callers; units compose through the
> one uniform `T=>U` seam; and a coarser cross-type grouping is a *triggered, law-bearing*
> promotion, never a free-text module.

This is the spec all three would sign. It is necessary but, by the owner's gate, **not yet
sufficient** — none of the four clauses alone says where a 1.5-subject op lives.

---

## 2. Divergence — the genuine, non-cosmetic conflicts

These are real (not word-choice) and each is an unsettled question.

**D1 — Is there a privileged axis, or is the matrix symmetric?**
A privileges the *row* (carrier/noun) as default, column (verb) as exception. B sides with the
row (its "Equilibrium B" = the OO/stdlib/GraphQL shape). C *refuses to privilege either*:
coslice (by source, "ops on A") and slice (by target, "constructors of B") are duals, equally
primitive; picking one as "the home" is **not derivable** from the bare category. **Conflict:
A/B impose a primary axis that C proves is a choice, not a consequence.** **[grounded]**

**D2 — Source or target as the home?**
B's "primary operand it acts on / returns" silently conflates the two and is *the 1.0-subject
heuristic*. A's carrier for endomaps has source = target so the conflict is hidden. C makes it
explicit: these are two different partitions. Unsettled for non-endomaps. **[grounded]**

**D3 — What guarantees a real group: a signature, or laws/invariant?**
B is content with structural docking (home = operand, no law requirement). A *insists* the
true boundary is the **invariant**, not the nominal type (split the type if it carries two
invariants). C *insists* the only non-arbitrary imposed group is a **functor with laws**.
**Conflict: A and C demand law-bearing structure for the coarse tier; B does not.** This is a
rigor gap, and it bears directly on the gate. **[grounded]**

**D4 — What is the second tier: a typeclass (verb/column) or a functor (type-constructor
orbit)?** A's promotion target is a *typeclass* — quantify the signature over carriers. C's is
a *functor* — `Option`/`Parser`/`Ledger` as a type constructor with its natural ops. These are
**different objects**: one ranges a fixed signature over many carriers; the other is one
carrier-family's whole algebra. **[grounded; that they differ = judge]**

---

## 3. The Gate — ~1.5 subjects/op. Which framings survive?

The owner's hard constraint: ~100 slices × ~1.5 subject types each. Grouping by a *single
naked subject* is therefore known-insufficient. Every endorsed principle must give a precise,
non-arbitrary home for `transfer(from,to)`, `assign(user,project)`, join-shaped ops.

### Framing B — **FAILS as stated.**
B's load-bearing rule is "home = the type it *primarily* acts on / returns." For a symmetric
binary (`transfer(from,to)`, both `Account`) "primary" is undefined — exactly the binary-method
problem. B never resolves it; it offers feature-index as secondary (which the gate forbids as a
home) and its own counter-example (Unix/SQL) erases the operand entirely. B's *survey content*
gestures at the answer (SQL **relations**, DDD **aggregate = consistency boundary**), but B's
stated invariant does not. **B passes only if rescued by A's/C's relation move.** **[judge,
grounded in B's text offering no symmetric-binary rule]**

### Framing A — **PASSES, with the cleanest single-home rule.**
A §9 anticipates the gate exactly: cross-type ops are "a minority that carries information,"
signalling either a **missing relationship type** (reify it: give `Assignment` its own carrier
+ algebra) or a capability to lift to a typeclass once it recurs across ≥2 carriers. The home
is non-arbitrary because it is "the type whose invariant the op jointly preserves" — and when
no existing single type's invariant captures the op, *that absence is the evidence* a new
carrier (the reified relation) is needed. **[grounded]**

### Framing C — **PASSES the letter, derived and non-arbitrary, but the single semantic home
needs the functor.** C: an n-ary op `f : A×B => C` has source = the **product** `A×B`, so it
files under `coslice(A×B)` *and* under `slice(C)` — two derived, non-arbitrary locations, no
operand-pick required. It never promised a *single* home; multi-membership is fine under a
hom-partition. For a *single semantic* home C routes to the **functor orbit** (reify the
relation as a type constructor with laws). **[grounded]**

### The three gate-answers coincide — and that coincidence is the result.
- A: reify the relation → new carrier whose invariant the op preserves.
- C: the op files under its **product source** and **target slice**; semantic home = the
  functor that *is* the reified relation.
- B (survey, not its stated rule): SQL relation / DDD aggregate = the invariant boundary.

All three name the **same object**: the *relation reified as an invariant-bearing carrier*
(the join entity / edge / ledger). **[judge — the convergence is my synthesis; each piece is
grounded.]**

> **The multi-subject rule that survives:** *An operation lives on the type whose invariant it
> preserves. For an endomap that is the single entity. For a genuinely cross-cutting op there
> is no pre-existing single subject — and that is information, not a defect: the relation must
> be reified into its own carrier (`Transfer`, `Assignment`, `Membership`, the edge/ledger),
> and the op lives there. The home is never an arbitrary pick of one of the two operands.*

Grouping by a naked subject **fails** the gate (its premise). Grouping by the
**invariant-bearing carrier, reifying relations into carriers when no single subject owns the
invariant**, **passes**.

### Worked examples
- **`transfer(from: Account, to: Account, amt: Money)`** — no invariant lives on one
  `Account`; the conservation law (`from.balance + to.balance` constant) is a property *of the
  pair*. Reify `Transfer` (or `Ledger`): its invariant is `amt > 0` + conservation. `transfer`
  is its constructor; `reverse`, `settle` are its endomaps. Home = `Transfer`. *(A: missing
  relationship type. C: source `Account×Account×Money`, target `Transfer`/`Ledger`, functor =
  `Ledger`. B-survey: SQL ledger relation / DDD aggregate.)*
- **`assign(user: User, project: Project)`** — neither `User` nor `Project` owns the
  membership invariant ("a live user on an open project"). Reify `Assignment`; `assign` is its
  constructor, `revoke` its endomap. Home = `Assignment`.
- **A pure read, `displayName(u: User): string`** — a 1.0-subject elim morphism. Source = `User`,
  no new invariant introduced; docks to `User`'s carrier (coslice of `User`). No reification.
  *(All three agree; this is the easy case the gate does not stress.)*

---

## 4. Synthesis — the principle to stake the design on

> **Cluster every operation by the carrier whose invariant it preserves, where the carrier is
> derived from the operation's type; a genuinely multi-subject operation forces the *relation*
> to be reified as its own carrier (the join entity / edge / ledger), which is then its home.
> The namespace is indexed by invariant-bearing types — entities and reified relations alike —
> so it grows with the data, not with operations × callers, and everything composes through the
> single `T=>U` seam. The escape to a coarser cross-carrier grouping is a triggered, law-bearing
> promotion (a typeclass/functor), never a free-text module.**

This is *derived* as far as the algebra allows: C proves type-directed grouping falls out for
free, and that `(source, target)` — including the product source of n-ary ops — is the entire
intrinsic menu. A and B's "home = invariant-bearing type" is that menu read operationally.

**The minimal IMPOSED element, named honestly:** *the invariant.* Two things cannot be derived
from the bare category and must be declared:
1. **Which invariant bundles a carrier** (and therefore where a type should split, A §8) — the
   bare category sees only `(src,tgt)`, never *meaning* (C's theorem: semantic grouping is
   "orthogonal to anything the algebra can see").
2. **The decision to reify a relation as a carrier** when an op has no single invariant-home.

Why it can't be derived: an invariant is a *predicate over values*, not a fact about arrows;
the category cannot observe it. The honest mitigation (A and C agree, D3) is to make the
imposed thing **checkable** — an invariant/law, property-tested or proven — so the grouping is
verified, not asserted. That keeps the imposed element minimal and non-arbitrary: you declare a
*checkable predicate*, and membership then falls out of it.

**What stays OPEN (owner's call):**
- **O1 (from D1/D2):** Source vs target as the *primary* navigation/authoring locus. Both are
  derived and can coexist as two indexes; committing to one primary `Type.` locus is an imposed
  UX choice C proves is not derivable. *Recommend: expose both as queries (coslice = "ops on
  X", slice = "ways to build X"); pick one as the default authoring home only for ergonomics.*
- **O2:** Reification threshold. Every binary op → its own entity, vs. docking a 1.5-op to a
  "dominant" subject with a secondary index. Where the cost line sits is taste. *Recommend:
  reify when the op preserves a cross-pair invariant/law; otherwise dock + index.*
- **O3 (from D4):** Is the second tier a typeclass (verb/column) or a functor (type-constructor
  orbit)? Likely both exist, but which is the canonical promotion target is undecided.
- **O4 (from D3):** Laws enforced (proofs/property-tests) vs. conventional. Rigor vs. cost.

---

## 5. Authoring sketch (TypeScript-ish, tiny)

```ts
// A carrier = a type + the checkable invariant its ops preserve.
// Membership is DERIVED from each op's signature; the invariant is the one IMPOSED bit.

// (1) endomaps on one entity — home unambiguous (source = target = User)
carrier(User, { invariant: u => u.email.includes("@") })
  .op("rename",     (u: User, name: string): User => ({ ...u, name }))
  .op("deactivate", (u: User): User           => ({ ...u, active: false }))
  // (a pure read / elim morphism still docks to its source carrier — no new invariant)
  .read("displayName", (u: User): string => u.name ?? u.email);

// (2) a constructor — intro morphism _ => Document docks to its TARGET carrier
carrier(Document)
  .make("draft", (author: User): Document => ({ author, state: "draft" }));

// (3) THE CROSS-CUTTING OP — assign(user, project) has no single subject.
//     No invariant lives on User alone or Project alone => reify the relation.
//     assign lives HERE, non-arbitrarily: this carrier's invariant is its membership test.
carrier(Assignment, {
  invariant: a => a.user.active && a.project.open,   // checkable predicate
})
  .make("assign", (user: User, project: Project): Assignment =>
        ({ user, project, at: now() }))
  .op("revoke",   (a: Assignment): Assignment => ({ ...a, revokedAt: now() }));

// (4) transfer(from, to, amt) — same shape; the law is a property OF THE PAIR, not an account.
carrier(Transfer, {
  invariant: t => t.amount > 0,                       // local
  law: (before, after) => before.total === after.total, // conservation across the pair
})
  .make("transfer", (from: Account, to: Account, amount: Money): Transfer => /* ... */);
```

Reactable point: `assign` and `transfer` neither pick one operand as home nor float as free
functions — they earn a carrier because the *relation* is reified, and the carrier's invariant
is the non-arbitrary membership test. Everything an author types is `(signature → carrier)`
plus one checkable predicate; the grouping is then read off, not narrated.
