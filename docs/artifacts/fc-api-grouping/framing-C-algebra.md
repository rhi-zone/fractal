# Framing C — Algebra-First: What names a "group" of operations?

## The setup, stated exactly

The base is a category **C**:

- objects = types,
- morphisms = functions `f : A => B`,
- a composition `.` that is associative,
- an identity `id_A : A => A` for every object.

Nothing else is given. Users will author *many* morphisms. We fear a flat sprawl of
free functions. The question is **intrinsic**: using only the data above, what structure
*names a group of operations* — and does that grouping have to be **imposed** (declared by
hand) or does it **fall out** (derived from the structure)?

The discipline: refuse any grouping borrowed from OO ("methods on a class"), REST
("resources"), or filesystem convention ("modules"). Those are extrinsic labels. We only
get to use what the category itself can *see*.

---

## The single load-bearing observation

In the bare category, **the only intrinsic data a morphism carries is its domain and its
codomain.** A morphism is a typed arrow; it has a source object and a target object, and
— qua morphism in C — *nothing else*. It has no name, no "topic," no "module," no tag.
Two arrows `A => B` are distinguishable only by composition behaviour, not by any label.

This forces a theorem about what grouping *can* be:

> **Any grouping that is intrinsic to the bare category must be a function of `(source,
> target)`.** Equivalently, every intrinsic grouping is a *coarsening (quotient) of the
> hom-set partition.*

Everything below is a point on the lattice of such coarsenings, plus the question of what
you must *add* to escape that lattice. This is the spine of the whole answer: intrinsic
grouping is type-directed or it is not intrinsic at all.

---

## Candidate-by-candidate

### 1. Objects themselves as the groups

Idea: each object `A` *is* a group; its operations are "the operations of A."

Verdict: **underdetermined, not a partition.** Every non-identity morphism touches *two*
objects. "The operations of A" is ambiguous — arrows out of A? into A? both? An object
does not by itself select a set of morphisms. So "objects as groups" is not yet a grouping;
it is a *promise* of one that only becomes definite once you pick "out of" or "into"
(candidates 3/4). Objects index the groups; they don't constitute them.

(The one clean thing an object owns alone is `id_A` — a singleton. Useless as a grouping.)

### 2. The hom-set `hom(A,B)` as the group

Idea: the group is `hom(A,B)` = all arrows from A to B. A category *is literally* objects +
hom-sets + composition, so this is the most native grouping there is.

Verdict: **fully derived, the finest intrinsic grouping, but it shatters.** Membership is
forced: `f : A => B` lives in exactly one cell `hom(A,B)`. Zero declaration. It is a true
partition of all morphisms. This is the *meet* of the source- and target- groupings below.

Objection: granularity. For `n` types you have `n²` cells, almost all empty or singleton.
It groups by *exact signature*, so it co-locates `parse : String => Json` with an unrelated
`render : String => Json` and separates `parseFromString` from `parseFromBytes`. As an
authoring surface it is too fine and semantically blind.

### 3. Common source — the coslice category `A\C`

Idea: group all morphisms *out of* A. Formally these are the objects of the coslice
category `A\C` (arrows under A). This is the "what can I *do with* an A" view — the
elimination / consumer view; the honest, structural version of "fluent methods on a value."

Verdict: **fully derived, coarser than hom, ergonomic.** Source type alone is an intrinsic
invariant, so grouping by source partitions the non-identity arrows with no annotation.
"Browse the operations on `Request`" = browse the coslice of `Request`. This is the most
natural *authoring/navigation* primitive of the type-directed family.

Objection (shared with 4): an arrow `A => B` is "in A's group" yet is also *about* B; the
two slice views overlap rather than partition unless you pick one axis. And n-ary functions
break naïve source-grouping: `f : A×X => C` has source the *product*, so it files under the
product object, not under A or X — see candidate 5.

### 4. Common target — the slice category `C/B`

Idea: group all morphisms *into* B (objects of the slice `C/B`, arrows over B). The
"how do I *make* a B" view — the introduction / producer / constructor view. Dual to 3.

Verdict: **fully derived, the dual axis.** Source-grouping (3) gives "operations on A,"
target-grouping (4) gives "constructors of B." Together they are the two *atomic* intrinsic
groupings; `hom(A,B)` (candidate 2) is exactly their common refinement (group by both axes).
This trio — slice, coslice, hom — is the entire intrinsic lattice.

### 5. Products and the universal property

Idea: do products give a grouping?

Verdict: **no — but they fix what "source" means.** The universal property of `A×B` gives
canonical projections and pairing; it does not partition morphisms into topics. Its real
role here is to *define the domain of n-ary operations*: a multi-argument op is an arrow out
of a product. So products are what make candidate 3's "source" well-defined for real APIs
(and tell you that an n-ary op files under its product source). Monoidal structure
(candidate 9) is the same story for parallel composition `f ⊗ g` — a *combinator*, not a
grouping.

### 6. Fibers / fibrations

Idea: pick a functor `p : E => B`; the **fiber** over an object `b` is the subcategory of E
mapping to `b`. This groups E's morphisms by where they sit over the base.

Verdict: **derived — but only *after* a base functor is chosen.** A fibration gives a rich,
genuinely categorical grouping (this is how indexed/dependent structure is organised). But
the bare category hands you no canonical `p`. Choosing the base *is a declaration*. It
becomes "derived" only if the base is itself canonical — e.g. a "type-former" functor that
sends each operation to the type constructor it is about. That canonical base is exactly
candidate 8 in disguise.

### 7. Comma categories

Idea: `(S ↓ T)` for functors `S, T` generalises everything: slice = `(Id ↓ B)`, coslice =
`(A ↓ Id)`.

Verdict: **the unifying frame, derived once the functors are fixed.** Comma categories show
that candidates 3 and 4 are the *same construction* at different arguments, and that the
general type-directed grouping is "morphisms relating two functor images." Pure bookkeeping
clarity; it does not by itself escape the (source,target) lattice unless the chosen functors
add information the bare category lacks — which again points at candidate 8.

### 8. Functors as the grouping

Idea: a functor `F` picks out a coherent family. In a single category the *type
constructors* (`Option`, `List`, `Parser`, `Result`, …) are functors, and "the operations
of Option" = the morphisms natural in / built from `F` (its `map`, its unit/join if it's a
monad, its eliminators). "A module = a functor."

Verdict: **the deepest grouping, and *semi*-derived.** This is where the human notion of "a
module about X" actually lives, and crucially it is **not an arbitrary label**: a functor is
a structural object with laws (it must respect `id` and `.`). You *declare* the functor —
but you were going to build it anyway when you defined the type — and once it exists, *which
operations belong to it falls out* (the ones natural in `F`, the ones in the image of `F`,
the components of natural transformations to/from `F`). So the declaration is the type's
own definition, and the grouping is then derived from it. This is the principled version of
"objects as groups" (candidate 1): the group is owned not by an object but by the *functor
that constructs that family of objects*.

Objection: it is not visible to the **bare** category. It requires adding structure (the
functor / a canonical fibration over the functor, candidate 6). It is the minimal *honest*
addition — but it is an addition.

### 9. Monoidal structure

Covered under 5: `⊗` is a *combinator for building* arrows (parallel composition,
n-ary plumbing), not a partition of arrows into groups. Not a grouping mechanism.

---

## Synthesis — the intrinsic lattice and the one escape

Purely from the bare category, the groupings that are **derived, not declared**:

```
                hom(A,B)            ← finest: group by (source AND target)
               /        \
        by source        by target
        (coslice A\C)    (slice C/B)
               \        /
              connected component / object identity   ← coarsest
```

That is the *entire* intrinsic menu. There is nothing else the bare category can see,
because a morphism *is* nothing else but a typed arrow. So:

- **Does grouping need to be imposed? No — a grouping always exists for free.** The hom
  partition (and its two slice coarsenings) falls out of the definition of a category with
  zero authoring. You never have to *declare* a group for one to exist.
- **But the derived grouping is type-directed, full stop.** The only axes are "what it
  consumes" and "what it produces." The conventional notion of a *semantic* module ("the
  parsing stuff," irrespective of types) is **orthogonal to anything the algebra can see**
  and therefore *cannot* be derived from the bare category. To get it you must add
  structure, and the minimal principled structure is a **functor** (candidate 8) — i.e. a
  fibration over a canonical type-former base (candidate 6/7).

So the precise answer to "imposed vs falls out" is: **grouping falls out; semantic grouping
must be imposed — and the only non-arbitrary way to impose it is to make the imposed thing a
functor, not a name.**

---

## Single strongest answer

**Operations are grouped by their types, and that grouping is derived, not declared. The
intrinsic group of a morphism is its hom-set `hom(A,B)`, presented operationally along the
two slice axes: the coslice `A\C` is "the operations on A" (everything you can do with an
A) and the slice `C/B` is "the constructors of B" (everything that produces a B). A free
function `f : A => B` files itself under A's outgoing operations and B's incoming
operations automatically, with no module annotation. The sprawl is tamed not by hand-named
buckets but because the type lattice *indexes* the operations: a "module" becomes a *query*
over the category ("show me the coslice of `Request`"), never a declaration.**

When you genuinely need a coarser, topic-like group that types cannot express, do not
reintroduce a free-text module — introduce the **functor** that the topic actually is
(`Parser`, `Http`, `Json` as type constructors with their laws). Its operations then fall
out as "the morphisms natural in / built from that functor." That keeps even the coarse
grouping *structural*: every group is either a slice of the type graph or the orbit of a
functor — never a name someone typed.

### Authoring picture

- You write `f : A => B`. You never write `module Foo { ... }`.
- "What can I do with an `X`?" is answered by the coslice of `X` — derived.
- "How do I build a `Y`?" is answered by the slice over `Y` — derived.
- Composition chains are *paths through the type graph*; a pipeline is a path, and the API
  browser is a graph navigator keyed on types.
- A "library/module" is a saved query (a slice/coslice, or a functor's orbit), not a
  declared container.

---

## Strongest objection to my own answer

**Type-directed grouping is orthogonal to meaning.** The algebra's intrinsic grouping
co-locates semantically unrelated operations that happen to share a signature
(`parse : String=>Json` next to `prettyPrintError : String=>Json`), and *fragments a single
human concept across many type pairs* (the concept "parsing" lives across `String=>AST`,
`Bytes=>AST`, `Tokens=>AST`, …). So the grouping that "falls out" is precisely *not* the
grouping a human reaches for when they say "the parser." Two honest responses, both with a
cost:

1. **Accept it:** navigation is type-first and concept is emergent/secondary. Clean and
   fully derived, but it fights the user's mental model of "modules."
2. **Add the functor layer (candidate 8):** recover concept-level grouping — but this
   reintroduces a *declared* object. It is principled (a functor with laws, not a free-text
   tag), yet it is no longer "falls out of the bare category"; it falls out of *added*
   structure. The claim "grouping is fully derived" survives only for the type-directed
   layer; the concept layer is *derived-from-a-declared-functor*, which is weaker.

The residual risk: if authors reach for the functor layer too eagerly, it degrades back
into the very "named modules" we were fighting, only spelled with categorical vocabulary.
The guard is to require the declared thing to be an *actual functor with laws*, so the
grouping is checkable, not just asserted.
