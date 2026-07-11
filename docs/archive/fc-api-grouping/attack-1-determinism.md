# Attack 1 — Carrier-selection determinism via return type

Red-team target: `design.md` §3.1 (deterministic decision procedure) + §3.2 (read-set
test) + §3.3 (verb-kind → HTTP). Attack vector: the tie-break routes ops by return type,
which assumes the dev already picked the "right" return type — the very decision the rule
claims to automate.

Default assumption going in: broken. Below, four concrete ops walked through the design's
OWN procedure, each producing an arbitrary or wrong home.

---

## Structural precondition the design contradicts itself on

§0 line 11: **"Every operation is a plain function `(...args) => Result`."**
§1 lines 42–47: `make: (...a) => T`, `op: (t, ...a) => T`, `read: (t, ...a) => U`.

These disagree. Either every op returns the algebraic `Result<T,E>` (then §3.1's "does `f`
return `T`" never matches literally — every return type is `Result<…>`, and the dispatch
must peer *through* the wrapper at the success channel), or ops return bare `T`/`U` and
`Result` is a framework-imposed wrapper (then §0 is loose wording). Whichever is true,
§3.1's dispatch is **defined over the success-channel type**, and the success channel is a
free authorial choice orthogonal to invariant-ownership. Every attack below exploits that
orthogonality. This contradiction is itself a finding: the canonical signature and the
dispatch signature are not the same signature.

---

## Op 1 — `charge` (STRONGEST BREAK): producer-of-inert-record beats the true carrier

```ts
charge(card: Card, amount: Money): Receipt   // or Result<Receipt, CardDeclined>
```

Semantics: debit the card, emit an immutable audit record. The invariant that matters is
**Card's**: `card.balance >= 0`, `newBalance == oldBalance - amount`, no double-charge.
`Receipt` is an inert append-only record — its invariant is trivial or absent.

Walk the procedure (§3.1, first-match-wins, top to bottom):

1. **Step 1: "Does `f` return `T` and its purpose is to yield a valid `T`?"** Yes —
   it returns a `Receipt`, and constructing a valid Receipt is plainly a purpose of the
   call; `card`/`amount` read as "ingredients." → **file under `Receipt` with `make`.**
   First match wins. **Procedure halts here.**

The §3.2 read-set test — the design's actual sound idea — is **never reached.** §3.1's
prose says "The only judgment call is step 1 vs step 4… resolved by 3.2." §3.2 is scoped to
disambiguate *which type's invariant when reifying*; it is not a gate on step 1. And §3.2's
own tie-break makes it worse, not better: **"producers win over mutators (step 1 before step
2)."** So even if a dev notices `charge` also mutates Card, the tie-break *actively
instructs* them to file under the produced type. The rule doesn't merely permit the wrong
home; it **prescribes** it.

Now apply §3.2's read-set test manually (what SHOULD have happened): "write the predicate
that's false if buggy — whose fields does it read?" → `card.balance >= 0` and
`newBalance == oldBalance - amount` → reads **Card**. Receipt's fields don't appear in any
breaking predicate. Correct home = **Card** (endomap). The two halves of the design's own
rule (§3.1 return-type dispatch vs §3.2 read-set) name **different carriers**, and the
design provides **no reconciliation** for that — 3.2 only fires *inside* step 4.

Downstream blast radius (§3.3): `make → POST`, so `charge` projects to `POST /receipts`.
"Charge a card" becomes "create a receipt." The resource, the method's target, and the
mental model are all wrong — and no per-op annotation is allowed to fix it (§3.3 forbids it).

**This is a whole CLASS**: every "do X to A, return a record of X" op —
`charge→Receipt`, `publish→Event`, `login→Session`, `append→LogEntry`,
`submit→Confirmation`. All fire step 1, all get filed under the inert record, all misroute.

### Fatal or fixable?

**FIXABLE at the misfiling level — by inverting the procedure's order.** The defect is
precedence: §3.1 runs return-type matching *first* and subordinates the sound read-set
criterion to it. Minimal concrete fix:

> **Reorder: run §3.2's read-set test FIRST to fix the carrier; use return-type/verb only to
> pick the verb once the carrier is fixed.**
> 1. Compute the breaking-predicate read-set → identifies the invariant-bearing subject(s)
>    (one subject, or a reified relation if ≥2 with no superset).
> 2. Only *then* choose the verb: a newly introduced value with its own **non-trivial**
>    invariant that the args are consumed into → `make`; carrier→carrier → `op`;
>    carrier→non-carrier-no-invariant → `read`.
> Add a gate to `make`: **the returned type's invariant must be non-trivial.** A type whose
> invariant is empty/trivial (Receipt, Event, LogEntry) cannot be a `make` target; it is an
> output projection, and the op files under whatever subject the read-set actually names.

Under the fix: `charge` read-set = {Card.balance} → carrier **Card**; Receipt has trivial
invariant → not a make target → it's an output. Files under **Card** as `op`. Correct;
projects to `PATCH /cards/:id` (or a chosen sub-route). Fixable.

**Residual FATAL-adjacent caveat (see Op 2).** The fix assumes the op can be seen as
`Card → Card` with Receipt as a side output. In a *pure immutable* core the op can't mutate
Card, so it must physically **return the new Card somewhere**. If it returns only Receipt,
the updated Card is lost — the op is incomplete. The honest signature is
`charge(card, amount): [Card, Receipt]` — a multi-output op, which the rule cannot home
(Op 2). So carrier-grouping + purity + "record of an action" ops are in genuine tension; the
reorder fixes *classification* but only by declaring one of the two real outputs a
"projection," which is a stipulation, not a derivation.

---

## Op 2 — `settle` / multi-output: genuinely two owners; tuple return has no home

```ts
settle(invoice: Invoice, payment: Payment): [Invoice, Payment]
```

Invariants genuinely maintained, all three at once:
- relational: `invoice.paidAmount === payment.appliedAmount` (reads the pair)
- Invoice's own: `invoice.status === "paid"` (reads Invoice)
- Payment's own: `payment.status === "applied"` (reads Payment)

Walk §3.1:
1. Step 1: returns `[Invoice, Payment]` — a tuple, not a single carrier `T`. No match.
2. Step 2: endomap `T => T`? Input is `(Invoice, Payment)`, output is `[Invoice, Payment]`.
   Not a single-`T` endomap. No match.
3. Step 3: read? Returns carriers, introduces invariants. No.
4. Step 4: touches ≥2 subjects, no single owner → **reify `Settlement`, GOTO 1 with
   `T := Settlement`.** But the op returns `[Invoice, Payment]`, **not** a `Settlement`.
   To satisfy the reified home the dev must *rewrite the signature* to
   `settle(...): Settlement`. The rule **changes the op's return type to fit the home** — the
   inverse of "the return type determines the home." Circular.

And even after reifying: the op is now filed under `Settlement`, so **Invoice's own
point-invariant** (`status === "paid"`) is maintained by an op that lives on a *foreign*
carrier. §0 defines a carrier as "the invariant-bearing type it is responsible for keeping
true." After settle, Invoice's paid-status invariant is kept true by `Settlement.settle`,
which Invoice does not own. The "exactly one carrier per op" constraint is preserved on
paper (op files under Settlement) while the "one responsible owner per invariant" claim is
**false**: three invariants across three types genuinely depend on this one op.

### Fatal or fixable?

**FATAL for the responsibility claim; not fixable without abandoning "one op → one carrier
owns all its invariants."** You can *file* it (reify Settlement) but you cannot make the
filing *true*: two independent carriers' point-invariants ride on a foreign op. The only
"fixes" abandon the core promise — either allow an op to be co-owned by ≥2 carriers
(breaks "exactly one"), or forbid multi-invariant ops (forbids a legendarily common real
op: two-sided settlement/booking). The tuple-return sub-case is additionally fatal to the
dispatch: **no step accepts a multi-carrier return**, so every honest pure op that updates
two subjects is either unclassifiable or forced through a signature rewrite the rule then
pretends it derived.

---

## Op 3 — `withdraw`: return type is a free choice that flips the carrier three ways

```ts
// A (endomap):   withdraw(a: Account, amt): Account          -> §3.1 step 2 -> op@Account
// B (event):     withdraw(a: Account, amt): Transaction      -> §3.1 step 1 -> make@Transaction
// C (multi-out): withdraw(a: Account, amt): [Account, Receipt] -> no step matches -> stuck/reify junk
// D (wrapped):   withdraw(a: Account, amt): Result<Account,E> -> see below
```

Same semantics, three different homes and one dead end, selected purely by return style.
The design self-critiques A-vs-B (§4.1), so that alone isn't news. Two additions the
design does NOT cover:

**D — the `Result` wrapper case (per §0, the DEFAULT signature).** With
`Result<Account, InsufficientFunds>`:
- Step 1 literal: returns `Result<Account,E>`, not `Account`. No `carrier<Result<…>>`
  exists. Does it match? Only if the dispatch unwraps to the success type. If it does *not*
  unwrap: step 1 fails, step 2 fails (`Account => Result<Account>` is not `Account =>
  Account`), **step 3 matches** — `Account => U` where `U = Result<Account,E>` is "not a
  carrier" — so `withdraw` files as a **`read`**, projecting to `GET`. A balance-mutating op
  classified as a query. Catastrophic and silent.
- If the dispatch *does* unwrap `Result<T,E>` to `T`: fine for `T`, but now the **error
  type `E` carries routing-relevant information the rule ignores** — and worse, an op like
  `charge: Result<Receipt, Declined>` unwraps to `Receipt` and lands back in Op 1's break.

Since §0 makes `Result` the universal return, **the entire steps-1–3 dispatch is defined
over `Result<…>` unless an unwrap rule is specified — and the design specifies none.** This
is the return-wrapper attack landing directly.

### Fatal or fixable?

**FIXABLE, but only by adding rules the design claims it doesn't need.** Required additions:
(1) an explicit "unwrap `Result<T,E>` (and `Promise`, `Option`, arrays) to the payload type
before dispatch" normalization step; (2) a decision for multi-output (case C) — which is
Op 2's fatal problem. So the wrapper half is fixable with a normalization pass; the
multi-output half inherits Op 2's verdict.

---

## Op 4 — `applyDiscount`: option-bag / arg-shape defeats the make-vs-op (verb) choice

```ts
// positional:  applyDiscount(order: Order, coupon: Coupon): Order   -> step 2 -> op   -> PATCH
// option-bag:  applyDiscount(args: {order, coupon, actor}): Order    -> step 1 -> make -> POST
```

Both return `Order` and mutate `order.total`. In the positional form the first arg IS the
maintained subject → endomap → `op` → `PATCH`. In the bag form the input is an *object
containing* order, so `order` reads as an "ingredient" (§3.1 step 1's language: "incoming
args are ingredients, not the maintained subject") → producer → `make` → `POST`. **Same
semantic op, opposite HTTP method, decided by calling convention.**

The §3.2 read-set test partly rescues this: the breaking predicate `order.total` correct ==
Σ(line items) − discount reads **Order** either way, so the *carrier* is stable = Order.
**But read-set fixes only the carrier, never the verb.** §3.3's entire HTTP story hangs on
the verb (`make→POST`, `op→PATCH`, `read→GET`). So even when §3.2 nails the home, the
`make`/`op` distinction — which is what actually reaches the wire — remains undetermined and
flips on `{}` vs positional args. Currying is the same wound: `applyDiscount(coupon)(order)`
partially-applied makes `order` "the last arg," inviting `make` reading.

### Fatal or fixable?

**FIXABLE.** Rule change: the make-vs-op verb must be decided from the **read-set + delta**,
not arg position: if the read-set subject also appears in the output with a changed value
(a delta on an existing subject) → `op`; if the output is a fresh value with no
pre-existing subject in the read-set → `make`. This makes the verb invariant to
positional/bag/curried encodings. Cheap, concrete, closes the wound — but again it means the
verb is derived from read-set analysis, **not from the return type or signature shape**,
confirming that return-type-directed dispatch (§3.1's headline) is the wrong primary axis.

---

## Verdict summary

| Op | Break | Fatal? |
|----|-------|--------|
| 1 `charge`→Receipt | §3.1 step-1 + §3.2 "producers win" tie-break prescribe the WRONG home (inert record beats true invariant carrier); read-set backstop unreachable | **Fixable** — invert order (read-set first) + non-trivial-invariant gate on `make`. Residual purity/multi-output tension is fatal-adjacent. |
| 2 `settle`→[I,P] | Multi-output has no step; two carriers' own invariants genuinely ride one op; reify only files, doesn't make the responsibility claim true | **Fatal** for "one op owns all its invariants" + tuple return unclassifiable |
| 3 `withdraw` (D=`Result`) | §0's universal `Result` return makes dispatch operate on the wrapper; without an unwrap rule, mutation → `read`/`GET` | Fixable (add normalization) except multi-output part |
| 4 `applyDiscount` bag | verb (make/op → POST/PATCH) flips on arg shape; read-set fixes carrier but not verb | **Fixable** — derive verb from read-set+delta |

**Through-line (the real thesis under attack):** the design's headline is "route by the
return type / verb the author picked" (§3.1) with the read-set test (§3.2) demoted to a
sub-case. Every break above is the same shape: **the sound axis is read-set + delta on the
invariant-bearing subject; the return type is a free authorial choice orthogonal to it.**
The design has the right idea (§3.2) wired in the wrong priority (subordinate to §3.1).
Reordering — read-set/delta primary, return type only for verb-flavor with a non-trivial-
invariant gate — repairs Ops 1, 3, 4. **Op 2 (genuine dual ownership + multi-output pure
ops) is not repairable within "exactly one carrier owns an op and all its invariants"; it
is the load-bearing fatal finding for carrier-grouping as a total scheme.**
