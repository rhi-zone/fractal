# Design v1 — Carrier-Grouped Function Core (committed)

*This is the committed design, made concrete. It implements the position fixed by the
owner; it does not re-open it. Background: `synthesis.md` (same directory). Provenance:
everything here is design decision, not survey.*

---

## 0. The one sentence

Every operation is a plain function `(...args) => Result`. It is filed under exactly one
**carrier** — the invariant-bearing type it is responsible for keeping true. The carrier +
its ops is the protocol-agnostic truth. HTTP/CLI are computed *from* a carrier, downstream,
never authored per-surface. Truth lives in inferred TS types + JSDoc, never in a reified
runtime schema tree.

---

## 1. Authoring API

Four verbs, one predicate hook. Nothing else. No colon-path DSL. No second source of truth.

```ts
// ---- the carrier constructor ----------------------------------------------
// `carrier<T>()` opens a namespace bound to the type T. The type parameter IS the
// truth; there is no runtime schema. `invariant`/`law` are optional checkable
// predicates (plain functions returning boolean) — enforced where cheap, else
// conventional. They are NOT a schema; they are just closures the runtime can call.

interface CarrierDef<T> {
  /** Point-invariant: is a single T well-formed? Checked at op boundaries when cheap. */
  invariant?: (t: T) => boolean;
  /** Transition-law: does an op preserve a cross-state property? (before, after). */
  law?: (before: T, after: T) => boolean;
}

function carrier<T>(name: string, def?: CarrierDef<T>): Carrier<T>;

interface Carrier<T> {
  /** endomap: T => T (or T => small view of T). Maintains T's invariant. */
  op<A extends any[]>(name: string, f: (t: T, ...a: A) => T): this;

  /** intro / producer: _ => T. The point is to yield a VALID T. Docks to target T. */
  make<A extends any[]>(name: string, f: (...a: A) => T): this;

  /** elim / read: T => U, U !== T, introduces no new invariant. Docks to source T. */
  read<A extends any[], U>(name: string, f: (t: T, ...a: A) => U): this;

  /** the carrier's own type witness, for projection & composition wiring. */
  readonly type: TypeTag<T>;
}
```

That is the entire authoring surface. Ops are ordinary functions; `carrier` only files them.

### Capability (second tier) — a typeclass-like interface

A capability is declared once as an interface over a *carrier variable*, then implemented
per carrier. It is promoted only when the same op-set recurs across ≥2 carriers. Default is
capability; a functor/module is used ONLY for genuine map/traverse structure-preservation.

```ts
// declare the shape once (verb-keyed, ranges over carriers)
interface Archivable<T> {
  archive(t: T): T;      // endomap-shaped -> the impls live on each carrier
  restore(t: T): T;
}
function capability<Name extends string, Shape>(name: Name): CapabilityDef<Name, Shape>;

const Archivable = capability<"Archivable", Archivable<unknown>>("Archivable");

// implement it ON a carrier — the impl functions are that carrier's own ops.
User.implement(Archivable, {
  archive: (u) => ({ ...u, archivedAt: now() }),
  restore: (u) => ({ ...u, archivedAt: null }),
});
```

Key rule: a capability does not move ops off their carrier. The implementation *is* the
carrier's own `op`s, just conforming to a shared signature so cross-carrier code can be
written once. It is an index, never a home.

### Reified relation carrier

A relation is not special syntax — it is just `carrier<Transfer>()`. What makes it a
*relation* is only that its invariant/law ranges over more than one subject. The authoring
API is identical; that uniformity is the point.

---

## 2. Six worked examples (every case)

### (a) Endomap on an entity — `rename` → carrier **User**

```ts
const User = carrier<User>("User", { invariant: u => u.email.includes("@") });
User.op("rename", (u, name: string): User => ({ ...u, name }));
```
**Why:** `User => User`. The op mutates a User and is responsible for keeping User's
invariant true. Source = target = User; the home is unambiguous. Carrier = the subject.

### (b) Pure producer / constructor — `draft` → carrier **Document**

```ts
const Document = carrier<Document>("Document", { invariant: d => d.title.length > 0 });
Document.make("draft", (author: User): Document => ({ author, title: "", state: "draft" }));
```
**Why:** `User => Document`. Its point is to yield a valid Document. The invariant it must
satisfy on exit is Document's, not User's. Carrier = the constructed type (target), via
`make`. (It reads a User but introduces no User invariant, so it is not filed under User.)

### (c) Cross-cutting op forcing reification — `transfer` → carrier **Transfer**

```ts
const Transfer = carrier<Transfer>("Transfer", {
  invariant: t => t.amount > 0,
  law: (before, after) => before.total === after.total, // conservation across the pair
});
Transfer.make("transfer", (from: Account, to: Account, amount: Money): Transfer =>
  ({ from: from.id, to: to.id, amount, total: from.balance + to.balance, at: now() }));
Transfer.op("reverse", (t): Transfer => ({ ...t, amount: -t.amount as Money }));
```
**Why:** the conservation law is a property of the *pair* `(from, to)`, not of either
Account. No single Account owns it. That absence is the signal a carrier is missing — so
the relation is reified as `Transfer`, whose invariant/law is exactly the conserved
property. `transfer` is its constructor; `reverse` its endomap. Home = the reified relation.

### (d) Many-to-many join — `assign(user, project)` → carrier **Assignment**

```ts
const Assignment = carrier<Assignment>("Assignment", {
  invariant: a => a.active,  // membership predicate: a live edge
});
Assignment.make("assign", (user: User, project: Project): Assignment =>
  ({ user: user.id, project: project.id, active: true, at: now() }));
Assignment.op("revoke", (a): Assignment => ({ ...a, active: false }));
```
**Why:** the membership invariant ("this user is currently on this project") lives on the
*edge*, not on User and not on Project. Reify the edge as `Assignment`. `assign` constructs
it, `revoke` is its endomap. Home = the reified relation. Same rule as (c); m-to-m is just a
relation with no cardinality constraint.

### (e) Capability across 2 carriers — `Archivable` on **User** and **Document**

```ts
const Archivable = capability<"Archivable", { archive<T>(t: T): T; restore<T>(t: T): T }>("Archivable");
User.implement(Archivable,     { archive: u => ({ ...u, archivedAt: now() }), restore: u => ({ ...u, archivedAt: null }) });
Document.implement(Archivable, { archive: d => ({ ...d, archivedAt: now() }), restore: d => ({ ...d, archivedAt: null }) });
```
**Why:** the same `archive`/`restore` endomap-set recurred on ≥2 carriers, so it is
promoted to a capability. The ops still *live on* User and Document (they are those
carriers' own endomaps); the capability only lets `archiveAll(xs)` be written once over any
`Archivable`. Capability, not functor: there is no map/traverse structure being preserved,
just a recurring signature.

### (f) Pure read / query — `displayName` → carrier **User**

```ts
User.read("displayName", (u): string => u.name ?? u.email);
```
**Why:** `User => string`. Elim morphism; introduces no new invariant; the string is not a
carrier. It docks to its source carrier, User, via `read`. Reads always dock to their single
source subject — a read has nothing to reify because it asserts no cross-subject law.

---

## 3. Resolving the internal tensions

### 3.1 The deterministic decision procedure ("where do I file op `f`?")

A dev with a signature runs this, top to bottom, first match wins. It is total and
deterministic — every op lands in exactly one carrier.

1. **Does `f` return `T` and its *purpose* is to yield a valid `T`?** (intro / `_ => T`,
   or `... => T` where the incoming args are ingredients, not the maintained subject.)
   → file under **T** with `make`. [examples b, c-ctor, d-ctor]
2. **Is `f` an endomap `T => T` (or `T => small view of T`) for a single `T`?**
   → file under **T** with `op`. [examples a, c-reverse, d-revoke]
3. **Is `f` a read `T => U` (`U` not a carrier, no new invariant) for a single source `T`?**
   → file under **T** with `read`. [example f]
4. **Otherwise `f` touches ≥2 subjects and no single one owns the property it maintains.**
   → the missing carrier IS the relation. Reify `R`, then GOTO 1 with `T := R`.
   [examples c, d]

The only judgment call is step 1 vs step 4's "which type's invariant?" — resolved by 3.2.

### 3.2 What "the invariant it maintains" means operationally

Not philosophy — a mechanical test the dev can run:

> **Write down the predicate that would be FALSE if this op were buggy. Whose fields does
> that predicate read?**

- `rename` buggy → `email.includes("@")` could still hold, but the predicate that breaks is
  about *this User's* consistency → User owns it.
- `transfer` buggy → `before.total === after.total` breaks; that predicate reads *both*
  accounts → no single Account owns it → reify Transfer, whose fields the predicate reads.
- `displayName` buggy → nothing becomes false (it asserts no invariant) → it is a read,
  docks to source.

If the breaking predicate reads exactly one subject's fields → that subject is the carrier.
If it reads two-or-more subjects' fields and none is a superset → reify the relation and the
predicate becomes the relation's invariant/law. This makes "the invariant it maintains"
decidable from the predicate's *read-set*, not from taste.

**Tie-break (the one arbitrary-looking case made deterministic):** an op that both
constructs a `T` and could be read as mutating an input `A` (e.g. `transfer` "changes"
accounts) — the carrier is the type **whose invariant the breaking predicate reads**, and
producers win over mutators when both apply (step 1 before step 2). Transfer's predicate
reads the pair, so it reifies rather than docking to `from`. This is why the rule is "one
rule, not source-xor-target": you never choose source vs target; you choose *whose
predicate breaks*, and reify when the answer is "the pair's."

### 3.3 Carrier → HTTP projection without leaking HTTP back into the op

The carrier is protocol-agnostic. A projector is a *separate, downstream* function that
reads a carrier's op catalogue (via its `type` tag + op names/arities inferred from TS) and
emits a surface. The op never imports, mentions, or shapes itself for HTTP.

```ts
// downstream, in the http package — NOT in the carrier authoring:
const routes = projectHttp(Transfer, {
  make:  "POST",   // intro  -> create resource
  op:    "PATCH",  // endomap-> mutate resource
  read:  "GET",    // elim   -> query
});
// yields: POST /transfers (transfer), PATCH /transfers/:id (reverse) ...
```

The rule that prevents leakage: **the mapping is verb-kind → method** (`make`→POST,
`op`→PATCH, `read`→GET), derived purely from which of the three authoring verbs filed the
op. HTTP semantics are a function of the *category-theoretic role* (intro/endo/elim), which
is already recorded structurally by the choice of `make`/`op`/`read`. So no per-op HTTP
annotation is ever needed, and nothing HTTP-shaped can flow back: the op author only ever
picks a role, and the role is meaningful independent of HTTP (it is equally the source of
CLI subcommands, GraphQL mutation-vs-query, etc.). The projector is total over any carrier;
adding a surface adds a projector, never an op edit.

---

## 4. Self-critique — where a red team should attack

1. **The `make` vs `op` boundary hides the whole source/target problem rather than solving
   it.** The design claims "one rule, not source-xor-target," but step 1 ("purpose is to
   yield a valid T") smuggles intent back in. `transfer(from, to) => Transfer` and a
   hypothetical `withdraw(acct, amt) => Account` are structurally identical (both `... =>
   SomeType`); the first reifies, the second docks to Account — and the *only* thing
   separating them is the read-set of the breaking predicate. If a dev writes `transfer` to
   return an updated `Account` pair instead of a `Transfer`, the rule silently files it
   wrong. The determinism depends on the dev having already chosen the right return type,
   which is the very decision we claimed to automate.

2. **"The predicate that would be false if buggy" is not always writable, and read-set is
   gameable.** Many real ops maintain fuzzy or cross-aggregate invariants ("don't exceed
   rate limit", "keep audit log consistent") whose predicate reads global/ambient state,
   not any one subject's fields. The read-set test then says "reify a relation" for ops that
   are really just effects — producing junk carriers (a `RateLimitCheck` carrier). The rule
   has no principled stop condition distinguishing "genuine relation with a conservation
   law" from "op that happens to touch two things."

3. **Capability-vs-functor is asserted, not decided.** Section 1 says "functor ONLY for
   genuine structure-preservation, default capability," but gives no test a dev applies at
   authoring time to know which they have. In practice devs will default everything to
   capability (it is easier), and the functor case — the one with actual laws worth
   checking — will be under-used exactly where rigor matters most. The design privileges the
   weaker tier by making it the default.

4. **HTTP projection by verb-kind is too coarse for real APIs.** `make→POST, op→PATCH,
   read→GET` breaks on: reads that must be POST (large query bodies), endomaps that are
   idempotent PUTs vs non-idempotent PATCHes, sub-resource routing, bulk ops, and any op
   whose natural URL is not `/{carrier}s/:id`. The moment one op needs a non-default method,
   the projector needs per-op override config — and that override config becomes a second,
   surface-shaped source of truth, which is exactly what the design forbids. The clean
   three-way mapping is likely to survive only the demo.
```
