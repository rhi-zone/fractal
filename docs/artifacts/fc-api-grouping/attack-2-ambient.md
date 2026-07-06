# Attack 2 — Ambient / Cross-Cutting Ops vs the Carrier Rule

Target: `docs/artifacts/fc-api-grouping/design.md` (v1, committed).
Mandate: break the claim that **every op docks to exactly one carrier whose invariant it
maintains**, via ops that maintain no carrier's invariant. Default assumption: broken.

The design pre-empts this as self-critique #2 ("read-set says reify a relation for ops that
are really just effects — no principled stop condition"). It flags the wound but does not
close it. This attack shows the wound is deeper than #2 admits: it is not only *junk
reification*, it is also *non-totality* and an *internal 3.1-vs-3.2 conflict*. The headline
claims — §0 "filed under exactly one carrier" and §3.1 "total and deterministic, every op
lands in exactly one carrier" — are false by counterexample.

The two load-bearing mechanisms under attack:

- **§3.1 decision procedure** (first match wins):
  1. returns `T`, purpose is to yield a valid `T` → `make` under T
  2. endomap `T=>T` → `op` under T
  3. read `T=>U`, **U not a carrier**, no new invariant → `read` under T
  4. **otherwise** `f` touches **≥2 subjects**, none owns the property → reify relation `R`, GOTO 1.
- **§3.2 read-set test**: "write the predicate false if the op were buggy; whose fields does
  it read?" one subject → that carrier; ≥2 subjects, no superset → reify the relation.

---

## Break A (FATAL to the totality claim) — zero-subject ops file NOWHERE

Step 4 is the catch-all, but its own text requires **"touches ≥2 subjects."** A large class
of real ops touches **zero** domain subjects. Every step's precondition fails:

| op | shape | step 1 | step 2 | step 3 | step 4 |
|----|-------|--------|--------|--------|--------|
| `sendEmail(to,sub,body) => void` | effect | no (void, no valid-T purpose) | no | no `t:T` source | **no — 0 subjects, not ≥2** |
| `incr(counter) => void` (metrics) | effect | no | no | no | **no — 0 subjects** |
| `isEmail(s: string) => boolean` | pure validate | no (bool ∉ carriers) | no | source `string` is not a carrier → no home | **no — 0 subjects** |
| `hash(bytes) => Digest` | pure | only if `Digest` reified (junk) | no | no carrier source | 0 subjects |

`isEmail` is the cleanest kill: it is the design's *own* example of an invariant predicate
(`u.email.includes("@")`, §2a) hoisted into a reusable function. The design uses email
validation as the paradigm of a carrier invariant, yet the standalone validator that
computes it has no home in the procedure. Step 3 explicitly needs a source carrier `t:T`;
`string` is not one. Step 4 needs ≥2 subjects; it has zero. **The procedure is not total.**
"Every operation is a plain function filed under exactly one carrier" (§0) is refuted.

The only escapes both lose:
- Force a junk carrier (`Email.make`, `Digest.make`, `Validation`) → the noun-costume sprawl
  the design claims to prevent.
- Admit these live outside carriers → retract §0/§3.1 totality (this is the real fix, Break D).

---

## Break B (FATAL to the "one stop condition" claim) — no discriminator for junk carriers

For ambient ops that *do* materialize state, the procedure files them **confidently into junk
carriers, with zero signal that they are junk**, because the procedure never inspects
invariant *quality* and `CarrierDef.invariant` is **optional**.

Real systems always give ambient state a type (a Redis rate-limit record `{count,
windowStart, limit}`, an audit row, a cache entry). Once typed, it *has fields*, so:

- **rate-limit**: breaking predicate "requests-in-window ≤ limit" reads exactly **one**
  subject's fields (the `RateLimitBucket` record). §3.2 → one subject → dock to
  `RateLimitBucket`. The read-set cardinality test **passes cleanly** and files it as
  legitimately as `User`. But `RateLimitBucket` is infrastructure, not domain — and nothing
  in steps 1–4 or the read-set test can tell. The discriminator the design leans on
  (read-set *cardinality*) is **orthogonal** to the genuine-vs-junk distinction.
- **audit-log write** `audit(event) => AuditEntry`: step 1 fires (returns a valid
  `AuditEntry`) → `AuditLog.make`. The "invariant" is `entry.timestamp != null` — **schema
  well-formedness of a struct literal, not a conserved property.** The procedure cannot
  distinguish a schema check from a conservation law.
- **cache invalidation** `invalidate(key) => void`: breaking predicate "cache == source"
  reads **two** subjects (cache entry + source of truth), none a superset → §3.2 **fires
  step 4** and reifies a `CacheCoherence` relation with a genuine-looking two-subject law.
  So even the ≥2-subject branch — the design's supposed signature of a *real* relation
  (Transfer, Assignment) — manufactures junk. The conservation-law smell test is satisfied
  structurally by pure infrastructure.

**There is no principled stop condition.** The genuine cases (Transfer.total,
Assignment.active) and the junk cases (RateLimitBucket, AuditEntry, CacheCoherence) are
indistinguishable to the procedure, because:
- `invariant`/`law` are **optional** (§1: "enforced where cheap, else conventional"), so a
  junk carrier is created with `invariant: undefined` or `() => true` and the procedure is
  happy;
- **no step ever reads the invariant.** Steps 1–4 branch on return type and arg shape only.

The design's worked examples all *happen* to carry clean invariants, which disguises that
the *procedure* never requires or checks one. The stop condition exists only in the author's
taste, not in the rule — which is exactly the "reify from taste" the design claims to have
eliminated (§3.2: "decidable from the read-set, not from taste"). It is not decidable.

---

## Break C (over-reification) — foreign-key reads returning a carrier type

Step 3 (`read`) is gated on **"U not a carrier."** But an enormous, ordinary class of reads
returns a *carrier* type:

- `whoami(session) => User`
- `author(doc) => User`, `owner(account) => User`, `project(assignment) => Project`

Every foreign-key traversal / lookup returns another entity. All are excluded from step 3.
They are not intro (step 1: not yielding a *new* valid entity, just fetching an existing one)
and not endomap (step 2). So they **fall through to step 4 → reify a relation.** A plain
`author(doc)` lookup would spawn a `DocumentAuthor` relation carrier. This is absurd
over-reification of the most common read in any system, and it is *forced by the rule*, not a
misuse. The `read` verb is defined too narrowly (scalar/value-object returns only), leaving
all entity-to-entity reads homeless-or-junk.

---

## Break D (internal conflict) — §3.1 step 1 contradicts §3.2 for producers whose predicate
reads a different subject than the produced type

`login(email, password) => Session`:
- **§3.1 step 1** fires: purpose is to yield a valid `Session` → `Session.make`. Producers
  win (step 1 before step 4).
- **§3.2** says the carrier is "the type whose invariant the breaking predicate reads." The
  predicate false if login is buggy is "the session was issued only for verified
  credentials" — which reads **`User.passwordHash`**, a *different* subject than the produced
  `Session`. So §3.2 points at User (or a two-subject Auth relation), while §3.1 points at
  Session.

The design asserts (§3.2 tie-break) that §3.2 *resolves* the step-1-vs-step-4 judgment call.
Here the two mechanisms give **different answers** for a mainstream op. The design only ever
tests the case where the producer's breaking predicate reads its *own* produced fields
(Transfer's predicate reads Transfer.total). It never handles "producer whose validating
predicate reads an input subject's fields." The decision procedure is therefore not the
single coherent rule it claims to be.

---

## Global queries & orchestration (confirming, same failure modes)

- **full-text `search(q) => Result[]`, dashboard, activity feed, cross-N report**: no `t:T`
  source (step 3 needs a first-arg subject; these range over *all* carriers), no single
  valid-T purpose. Land in step 4 → reify a `Search`/`Feed`/`Dashboard` carrier over the
  whole DB with **no invariant at all** (search asserts no conserved property). Pure junk
  carriers, mandated by the rule. (Break B, no-invariant variant.)
- **batch/cron `nightlyBilling() => void`**: sequences many carriers' ops; correctness is
  *temporal/sequential*, not a static conserved predicate. If `=> void`, falls through
  entirely (Break A). If `=> Report`, `Report.make` junk carrier. The invariant framing does
  not even type-check for a workflow.

---

## Verdict

**FATAL as written; the mechanism is FIXABLE, the headline claims are not.**

- The specific claims "every operation is filed under exactly one carrier" (§0) and "the
  procedure is total and deterministic — every op lands in exactly one carrier" (§3.1) are
  **false** — refuted by Break A (files nowhere) and Break C (mis-files). Non-negotiable
  retraction.
- Self-critique #2 undersells the damage: the problem is not merely "junk carriers possible"
  but (i) **non-totality**, (ii) **no discriminator exists at all** (read-set cardinality is
  orthogonal to junk-ness; invariant is optional and never inspected), (iii) an
  **internal §3.1/§3.2 contradiction**.
- The carrier core is genuinely sound for **invariant-bearing domain ops** (endomaps, real
  conservation-law relations, scalar reads). The break is a **scope error**: the design
  claims totality over *all* ops while the abstraction only fits the invariant-bearing
  subset.

### Minimal fix

Two changes, both additive to the core, neither dismantles it:

1. **Add an explicit non-carrier tier** ("service"/"effect" ops) and **retract the totality
   claim**. An op with no non-trivial invariant over its own subjects' fields is not a
   carrier op — it lives here (ambient infra, auth exchange, global queries, orchestration,
   pure utilities). This tier is *not* projected by the carrier→HTTP verb-kind rule; it needs
   its own projection (§3.3 already can't cover it).

2. **Make the stop condition explicit and make `invariant` load-bearing for reification.**
   A type may be a carrier (esp. via step-4 reify) **only if** a non-trivial invariant/law
   can be written that (a) reads **only its own declared subjects' fields** (for a relation,
   ≥2 of them), and (b) is a **conserved property**, not schema well-formedness and not a
   read of ambient/global state. Insert as step 0: *"if no such predicate exists → it is a
   service op, not a carrier."* This is the discriminator the design lacked:
   - **genuine relation** = conserved predicate over its subjects' own fields (Transfer.total,
     Assignment.active);
   - **junk carrier** = invariant absent / constant-true / schema-shaped / reads state
     outside its subjects (RateLimitBucket, AuditEntry, Search, CacheCoherence).

3. (Consequential) **Widen `read`** to permit carrier-typed `U` (Break C), so foreign-key
   lookups dock as reads on their source instead of reifying.

With (1)–(3) the core survives and the sprawl is fenced; without them the central promise is
false.
