# Candidate D — Operation kinds from mathematical operational properties

Framing: derive agnostic operation kinds from **checkable properties of the function
itself** — SAFETY (does applying it cause any observable effect) and IDEMPOTENCY (does
applying N times equal applying once), with TOTALITY considered as a third candidate axis.
These are protocol-neutral, mathematically defined properties of a `T => U` operation. The
question is which cells of the property space correspond to genuine, distinct kinds.

## 1. The property space

Define, over observable world-state:

- **safe(f)**  : running `f` produces no observable effect (pure read / no mutation).
- **idem(f)**  : for all reachable states, `f;f` ≡ `f` (repetition converges).

### The 2×2 collapses to a ladder of 3

|                | idempotent                     | not idempotent                  |
|----------------|--------------------------------|---------------------------------|
| **safe**       | ✅ **Query**                   | ⛔ *impossible*                 |
| **not safe**   | ✅ **Set**                     | ✅ **Call**                     |

Key theorem: **safe ⇒ idempotent.** If `f` has no observable effect, then `f;f` observably
equals `f` trivially (both are no-ops on state). So the (safe, ¬idempotent) cell is
**empty** — it is a logical contradiction, not a missing kind. This is a real result, not a
convenience: the space is not four kinds, it is a **guarantee ladder of exactly three**,
ordered by strength of promise:

    Query  (safe ∧ idem)   — strongest guarantee
      ⊐
    Set    (¬safe ∧ idem)  — mid guarantee
      ⊐
    Call   (¬safe ∧ ¬idem) — weakest guarantee (no promise)

Each step *drops* one guarantee. Call is the bottom: it promises nothing.

### The three kinds

- **Query** — *observe state without changing it.* safe ∧ idempotent.
  e.g. `getUser(id) => User`, `search(q) => Hit[]`, `computeQuote(cart) => Price`.

- **Set** — *drive the addressed state to a specified target; a repeat is a no-op.*
  ¬safe ∧ idempotent. e.g. `setProfile(id, p)`, `assignRole(u, r)`, `remove(id)`
  (removal is `Set(absent)` — once absent, re-applying changes nothing).

- **Call** — *invoke behavior; the effect is not guaranteed repeatable.* ¬safe ∧
  ¬idempotent. e.g. `charge(card, amt)`, `append(log, line)`, `increment(counter)`,
  `sendEmail(...)`. **This is the SETTLED POST kind — a method call / invocation.**

Note "create" deliberately does not appear as a kind. `PUT`-style create (idempotent, caller
supplies identity/target) is a **Set**; `POST`-style create (server invents identity, repeat
makes a second thing) is a **Call**. Creation is not a property of the function, so it is not
a kind — consistent with the settled constraint that create ≠ POST-because-creation.

### Why totality is NOT a third kind axis

Totality (defined for all inputs vs. partial/failing) is orthogonal *error modelling*, not a
kind generator. A partial Query is still a Query; a partial Call is still a Call. Crossing
totality with the ladder would double the cells (6) while producing **zero new kinds** — pure
apparatus sprawl. So totality is demoted to a **property annotation** carried in the type
itself (`=> Result<U, E>` / `=> U | undefined`), where TS *can* actually see it, rather than
a kind. Keep the ladder at three.

## 2. Per-kind projection & inferability

| Kind  | Inferable from `T => U`?          | HTTP    | CLI                                  | MCP                              |
|-------|-----------------------------------|---------|--------------------------------------|----------------------------------|
| Query | **No — must be authored** (see §)  | GET     | read subcommand / default, no mutation flags | tool + `readOnlyHint: true`      |
| Set   | **No — must be authored**          | PUT (or DELETE when target=absent) | `set`/`--field=v` subcommand | tool + `idempotentHint: true`    |
| Call  | **Default — needs NO annotation**  | POST *(settled)* | verb subcommand                | tool, no hints (open-world)      |

### Inferability — the honest answer

Safety and idempotency are **not expressible in a TypeScript `T => U` type.** `getUser` and
`deleteUser` can share the signature `(Id) => User`. TS has no effect system; purity and
idempotency are invisible. Therefore:

- **Call is the zero-annotation default.** Assert nothing and you get the weakest guarantee:
  unsafe, non-idempotent → Call → POST. This is *why* POST is the natural anchor: it is the
  bottom of the ladder, the kind that assumes nothing.
- **Query and Set are earned by a positive assertion.** An annotation here is a **promise**
  the author makes (`@safe`, `@idempotent`, or a marker type). Strengthening the guarantee
  requires stating it; the projection then upgrades GET/PUT accordingly.

So this framing is **authoring-first by construction**: the kinds are promises, not
inferences. Overrides are first-class because the "inference" is really a default (Call) that
the author overrides upward.

## 3. Leakage vs projection — verdict: **HTTP is secretly us.**

HTTP method semantics are *defined* (RFC 7231 §4.2) precisely by safety and idempotency:
GET/HEAD safe(+idem); PUT/DELETE idempotent(¬safe); POST neither. The HTTP method table **is
a lookup** `(safe?, idem?) → verb`. We did not reverse-engineer kinds from verbs; we derived
verbs' own defining axes and found the verbs fall out as a projection. The map is even
*lossy in HTTP's favour of us*: HTTP splits our single **Set** into PUT vs DELETE using
target-is-absent — an **addressing** detail, not a function property. That split lives in the
projection layer (it reads the tree's addressing), never in the kind. Coarser-us → finer-HTTP
confirms HTTP is the downstream, less-fundamental artifact.

Position: **projection, not leakage.** The properties are the real thing; HTTP verbs are one
lossy rendering of them.

Honest counter I must concede: the *choice* to axis on safety+idempotency could itself be
HTTP-anchored salience. Defense: both are standard, HTTP-independent
mathematics — idempotency from algebra (`f∘f=f`), safety from PL effect theory — that predate
and exist without HTTP. The axes are genuinely agnostic; HTTP merely also happens to use them.

## 4. Weakest points (for red team)

1. **Unverifiable authoring defeats "truth from types."** The entire scheme rests on
   properties TS cannot see, so *everything* above Call is an unchecked author promise. An
   author can label a mutating op `Query`/GET and nothing catches it — the type system won't,
   the compiler won't. "Truth = inferred types" degrades to "truth = author's honor." This is
   the sharpest wound: the framing that should maximize inference in fact *minimizes* it.

2. **Kinds underdetermine the projection (too coarse).** Three kinds can't pick DELETE vs PUT,
   or POST-create vs PUT-create, without re-consulting addressing/target-shape — i.e. the
   projection smuggles back HTTP-relevant info the kind refused to carry. Critics will say the
   kind is so agnostic it's nearly inert, and the real decisions have merely moved to an
   unaudited projection layer. Authors expecting an intuitive `create` kind will also chafe at
   "creation isn't a property," even though that stance is defensible.
