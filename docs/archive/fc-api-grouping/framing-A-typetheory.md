# Framing A — Type-Theory Lens: What Clusters Operations?

*Cold, unanchored reasoning. Lens restricted to type theory / PL design. HTTP, REST, CLI
deliberately ignored. Question: from first principles, what is the* organizing principle *that
clusters a library of operations (`T => U` + composition) so the namespace does not sprawl,
and what — mathematically — *is* a "group" of operations?*

---

## 0. Restating the problem in type-theoretic terms

We have a category-like setting: objects are types, morphisms are functions `T => U`, and we
have composition. Users author many morphisms. Left alone, morphisms form a *flat set* — a
bag of arrows with names. A bag has no structure beyond cardinality. "Sprawl" is precisely
the observation that *a set of named morphisms carries no organizing structure of its own*;
any structure must be **imposed** (convention) or **derived** (from the types).

So the real question is: **what structure on the set of morphisms is forced by the type
system rather than chosen by a human?** Whatever is forced is the candidate organizing
principle, because forced structure cannot drift, cannot be skipped, and cannot be faked.

I will weigh five candidates, ask of each *what it forces vs merely permits*, then extract
the invariant they share and land on one answer.

---

## 1. Candidate: Namespace-as-convenience (flat modules / folders)

`User.rename`, `User.deactivate`, `Document.publish`, …

- **Mechanism:** a module is a bag with a dotted prefix. Nesting is allowed.
- **Forces:** *nothing.* The compiler never checks that `User.rename` relates to `User`. The
  prefix is a string. You can put `Document.rename` under `User` and it typechecks.
- **Permits:** any clustering a human invents.
- **Failure mode:** sprawl is not cured, only *foldered*. Cardinality grows; the only defense
  is taste, which does not scale and is not enforceable. There is no invariant.

Verdict: this is the disease's natural habitat, not a cure. Reject as *primary* principle.
(It remains a fine *secondary* convenience layer once a real principle decides membership.)

---

## 2. Candidate: Methods / receivers (group by the privileged first argument)

`user.rename()`. A method is sugar for a function whose distinguished argument is the
receiver. Grouping = "functions whose receiver type is `T`."

- **Forces:** every operation to elect *exactly one* argument as its home. The compiler does
  associate `rename` with `User` (via the receiver type) — so this is *more* than convention.
- **Permits:** arbitrary choice of *which* argument is the receiver.
- **Failure modes:**
  - **Binary-method problem.** When an operation acts symmetrically on two types
    (`merge : User -> User -> User`, or `assign : User -> Document -> Document`), the receiver
    choice is arbitrary and the operation has no canonical home.
  - **Privilege bias.** "First argument" is a syntactic accident, not a semantic fact.
- **What it gets right:** it *does* point at a real signal — operations cluster around a type
  they act on. It just over-commits by forcing exactly one such type and choosing it
  positionally.

Verdict: a degenerate (single-sort, positional) special case of a deeper principle (§5).

---

## 3. Candidate: Typeclasses / traits (group by capability, parameterized over the type)

`class Archivable a where archive :: a -> a`. A typeclass is *a signature* — a set of
operation symbols over a type variable — and instances are the types that satisfy it.

- **Forces:**
  - **Completeness:** to be an instance you must supply *all* the class's operations. You
    cannot have half a `Monoid`. The group is atomic.
  - **Coherence:** (Haskell) at most one canonical instance per type — the grouping is
    globally consistent, not a local opinion.
  - **Law-bearing:** classes carry equational laws (associativity, identity, …) by
    convention/QuickCheck; conceptually the class *is* an algebraic theory.
- **Permits:** a type to belong to many classes (many capabilities), and a class to range
  over many types.
- **Grouping axis:** **the verb.** A class names a *capability* and gathers the operations
  that constitute it; the carrier type is a *parameter*.
- **Failure mode:** capabilities that genuinely apply to one type only become ceremony; and
  not every domain operation generalizes across types (`renameUser` is not obviously a
  capability shared by `Document`).

Verdict: structural and powerful. This is grouping *by column* (see §6).

---

## 4. Candidate: ML modules / signatures / functors (group as an abstract data type)

`module Stack : sig type t  val empty : t  val push : a -> t -> t  val pop : t -> ... end`.

- **Mechanism:** a structure is a record of *types + values*; a signature is its interface;
  sealing hides the representation. A functor is a structure parameterized by another
  structure.
- **Forces:**
  - **An abstraction boundary.** Sealing `type t` means the *only* way to make/observe a `t`
    is through the module's operations. This is the strongest enforceable notion of "these
    operations belong together": they are exactly the algebra that the carrier's hidden
    representation admits. Membership is checked, not asserted.
  - **Closure around a carrier.** The operations are the carrier's constructors (intro),
    transformations (endo), and observers (elim).
- **Permits:** multi-sort modules; functors abstract the grouping over *another* structure.
- **Grouping axis:** **the noun (carrier sort) + its invariant.** A group = a type and the
  operations that respect its representation/invariant.
- **Failure mode:** operations spanning two abstract types again strain "which module"; and a
  carrier can still accrete many operations (sprawl *within* the module) unless the boundary
  is the *invariant*, not the nominal type.

Verdict: structural, and the cleanest statement of "group = type + its algebra." This is
grouping *by row* (§6).

---

## 5. Candidate: Dependent records / Σ-types (the unifying formalism)

A structure is a dependent record: a carrier (or carriers) + operations + **laws as proofs**.

```
Monoid := Σ (A : Type). Σ (· : A → A → A). Σ (e : A).
          (assoc · ) × (left-id e ·) × (right-id e ·)
```

This is the most precise account, and it *subsumes* §3 and §4. A "structure" is a Σ-type
bundling a signature with its laws. The only difference between the typeclass view and the
ML/ADT view is **what you quantify over**:

- **Fix the carrier `A`, vary the operations** ⇒ you get an *abstract data type* (§4): the
  algebra of one type.
- **Fix the signature + laws, vary the carrier `A`** ⇒ you get a *typeclass / theory* (§3):
  one capability over many types.

Both are projections of the same dependent record. Mathematically the object in both cases is
an **algebra of a (multi-sorted) signature** — i.e., an **algebraic theory** together with a
**closure + coherence** condition.

---

## 6. The deep structure: the matrix, and the two structural axes

Lay operations in a matrix:

```
            rename   deactivate   publish   archive   assign
   User       •          •                    •
   Document                          •        •         •
```

- **Rows = carrier types.** Grouping by row = ADT / module / receiver (§2, §4) — *by the
  noun.*
- **Columns = capabilities.** Grouping by column = typeclass / trait (§3) — *by the verb.*

This is exactly the **expression problem**. Both axes are *real, structural, and forced by
the types* — they are transposes of the same data. Neither is "the" answer in the abstract;
the choice is which axis your operations actually cluster on, and which the type system can
enforce most cheaply.

**Why free functions sprawl, stated precisely:** a free function has a *signature* but no
*theory*. Nothing forces it into a row or a column; nothing forces *closure* (you can add or
drop one without consequence) or *coherence* (no shared law/invariant binds it to its
neighbors). Sprawl is the absence of an enforced closure condition on the morphism set. The
cure is to **make the boundary a type** — a record/signature/class — so membership is
*checked* rather than *narrated*.

---

## 7. The deepest invariant — what *is* a "group" of operations

> A group of operations is a **(multi-sorted) signature Σ together with laws — an algebraic
> theory — over one or more carrier sorts, subject to closure and coherence.** A concrete
> group is an **algebra** of that theory.
>
> - **Sorts** = the domain types the operations act on.
> - **Operation symbols** = the morphisms (intro `… → T`, endo `T → T`, elim `T → …`).
> - **Laws / invariant** = what makes the set a *unit* rather than a bag: every operation
>   preserves a shared invariant on the carrier(s), and the set is *closed* (you cannot add
>   or remove one without changing the abstraction).

The carrier type matters **not because of receiver position** but because operations cluster
around a *sort whose invariant they jointly preserve*. The verb-grouping (typeclass) is the
*same* invariant transposed: a signature + laws, with the carrier as parameter.

---

## 8. Single strongest first-principles answer

**Organizing principle:** *Cluster operations by the carrier type whose invariant they
jointly preserve — i.e., present each cluster as the algebra of an abstract data type (a
sealed signature over that carrier). Promote a cluster to a capability/typeclass (verb-axis)
only when, and exactly when, the same operation set recurs across two or more carriers.*

**Why carrier-ADT as the default:**

1. **It is structural, not conventional.** Membership is decidable from the types: an
   operation belongs to `T` iff `T` is its carrier sort *and* it preserves `T`'s invariant.
   Sealing makes the compiler enforce the boundary (cf. §4) — sprawl cannot accrete unchecked.
2. **It matches the actual shape of domain operations.** `renameUser`, `deactivateUser`,
   `publishDocument`, `archiveDocument` are overwhelmingly *endomaps on one entity*
   (`T => T`) that maintain that entity's invariant. They are carrier-closed by construction;
   the noun-axis is where they genuinely cluster.
3. **It gives a non-arbitrary home and a non-arbitrary boundary.** Unlike receivers (§2),
   the carrier is chosen by *closure under the invariant*, not by argument position. Unlike
   namespacing (§1), nothing can be misfiled and typecheck.
4. **It degrades gracefully into the deeper formalism.** ADT and typeclass are both Σ-types
   (§5); choosing carrier-first does not foreclose the verb-axis — it makes promotion a
   precise, triggered move.

**The refinement that prevents within-module sprawl:** the true boundary is the **invariant**,
not the nominal type. If a single nominal type accretes operations that preserve two
*different* invariants, that is a signal the type should split (newtype / refinement type),
each carrying its own algebra. "Group = carrier" is shorthand for "group = maintained
invariant on a carrier."

---

## 9. Strongest counter-argument against my own answer

**The expression problem says the noun-axis is an arbitrary choice of transpose.** Many real
operations are *not* closed over a single carrier:

- **Cross-type operations** (`assignUserToDocument : User -> Document -> Document`) have no
  natural carrier home — the binary-method problem resurfaces.
- **Cross-cutting capabilities** (`archive`, `publish`) recur across `User`, `Document`, … ;
  carrier-grouping *duplicates* them per type instead of naming the one capability once.

So one could argue the **capability/typeclass (verb) axis is the deeper unit**, because it is
defined *purely by a signature* (no privileged carrier at all), is type-parametric, maximally
reusable, and most naturally law-bearing.

**Rebuttal:**

1. Capability-grouping is *the same invariant transposed* (§5–§6), not a different or deeper
   one — it is a signature + laws with the carrier quantified. Choosing it does not escape the
   "group = algebraic theory" answer; it re-instances it.
2. For *domain entity* operations, the empirical column structure is **sparse** — most verbs
   touch one noun. Defaulting to columns would scatter tightly carrier-coupled operations and
   manufacture single-instance "capabilities" (ceremony, §3 failure mode).
3. Cross-type operations are a *minority that carries information*: they signal either a
   missing **relationship type** (give the `Assignment` its own carrier + algebra) or a
   capability that should be **lifted to a typeclass once it recurs across ≥2 carriers**.

**Net:** carrier-ADT is the right *default* axis; capability-typeclass is the right
*promotion path*, triggered by recurrence across carriers; relationship types absorb the
genuinely-binary operations. All three are the single invariant of §7 — *a group is an
algebraic theory (signature + laws + closure) over its carrier sorts* — applied along
whichever axis the types actually cluster on.
