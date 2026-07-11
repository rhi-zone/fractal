# Design v2 — Carrier-Grouped Function Core (revised under adversarial attack)

*Reviser pass over `design.md` (v1) against attacks 1–5 (same directory). This is the
committed design, corrected. Where an attack landed, the change is made for real. Where the
design already survived, the hold is re-derived. Where an attack was fatal to a claim and no
fix preserves it, the claim is narrowed or retracted honestly rather than fudged.*

*Provenance: everything here is design decision. The per-attack disposition is in §7.*

---

## 0. The one sentence (revised)

Every operation has exactly one **home**: either a **carrier** — the invariant-bearing type
whose *non-trivial conserved predicate* the op is responsible for — or the **effect/service
tier**, for ops that maintain no such predicate. The typed carrier core (types, ops,
invariants, roles) is the single source of **domain** truth and is never re-declared per
surface. Each surface (HTTP, CLI) is a **thin projection**: a role supplies defaults, and an
additive, op-keyed manifest supplies the surface-only facts the domain does not contain.

The two words that changed from v1 carry the whole revision:

- v1 said *"filed under exactly one **carrier**"* → v2 says *"exactly one **home**; carriers
  are one kind of home."* (The totality-over-carriers claim is **retracted**; see §2.)
- v1 said *"the carrier + ops is the **protocol-agnostic truth**; HTTP is computed FROM a
  carrier"* → v2 says *"the core is the single **domain** truth; a surface is a projection
  that **adds** surface-only facts."* (The generate-the-surface-unaided claim is
  **retracted**; the no-duplication-of-domain-facts claim is **preserved**; see §5.)

---

## 1. Authoring API (revised: five carrier roles + an effect/service tier)

Attack 4 (Breaks 1, 4) proved the three-role set {make, op, read} has no faithful source for
*load-by-key* (`GET /users/:id` mis-projected to POST) and *remove* (DELETE had no role).
Attack 2 (Break C) proved `read` was defined too narrowly (foreign-key lookups returning a
carrier fell through to junk reification). Both are fixed by widening the role set. Attack 2
(Breaks A, B) and the global-query cases proved a large class of ops carries no invariant at
all; they get the **effect/service tier**.

```ts
interface CarrierDef<T> {
  /** Point-invariant: is a single T well-formed AS A CONSERVED PROPERTY (not schema
   *  well-formedness, not a read of ambient state)? Load-bearing — see §3. */
  invariant?: (t: T) => boolean;
  /** Transition-law: does an op preserve a cross-state property? (before, after). */
  law?: (before: T, after: T) => boolean;
}

function carrier<T>(name: string, def?: CarrierDef<T>): Carrier<T>;

interface Carrier<T> {
  /** intro / producer: ...ingredients => fresh valid T. Gated: T must have a
   *  NON-TRIVIAL invariant (§3). Projects POST by default. */
  make<A extends any[]>(name: string, f: (...a: A) => T): this;

  /** load / fetch-by-key: key => existing T. No delta, no new invariant. Persistence-facing.
   *  Projects GET by default. (NEW — closes attack-4 Break 1 fetch hole.) */
  load<K extends any[]>(name: string, f: (...k: K) => T): this;

  /** endomap: T => T (delta on the maintained subject). Projects PATCH by default. */
  op<A extends any[]>(name: string, f: (t: T, ...a: A) => T): this;

  /** remove / eliminate the stored subject: T => ∅. Projects DELETE by default.
   *  (NEW — closes attack-4 Break 1 delete hole.) */
  remove(name: string, f: (t: T) => void): this;

  /** elim / read: T => U, introduces no new invariant. U MAY be a carrier
   *  (foreign-key lookups dock here — closes attack-2 Break C). Projects GET by default. */
  read<A extends any[], U>(name: string, f: (t: T, ...a: A) => U): this;

  readonly type: TypeTag<T>;
  readonly edges: EdgeIndex<T>;   // dual-home discovery index (§4)
}

/** The non-carrier tier. Ops with no non-trivial conserved invariant over their own
 *  subjects' fields live here: ambient infra (rate-limit, audit, cache), auth exchange,
 *  global queries (search, feed, dashboard), orchestration (cron/batch), pure utilities
 *  (isEmail, hash). NOT projected by the verb-kind default rule — each declares its surface
 *  facts directly in the manifest (§5). (NEW — closes attack-2 Breaks A/B and global-query.) */
function service<A extends any[], R>(name: string, f: (...a: A) => R): ServiceDef;
```

The reconciled role set: **make, load, op, remove, read** for carrier ops; **service** for
everything with no conserved invariant. Capability (§6) is unchanged in intent and is an
index, never a home.

---

## 2. The totality claim — honest status: **RETRACTED and replaced**

v1 §0 / §3.1 claimed *"the procedure is total and deterministic — every op lands in exactly
one carrier."* Attack 2 (Break A) refuted it by counterexample: zero-subject ops
(`sendEmail`, `incr`, `isEmail`, `hash`) satisfy no step's precondition — step 3 needs a
source carrier, step 4 needs ≥2 subjects, they have zero. Attack 4 (Break 1) refuted it
again: load-by-key and delete have no faithful role. **This claim is false and is retracted.**

Replacement claim (true): **every op lands in exactly one home, where a home is a carrier or
the effect/service tier.** The decision procedure (§3) is *total over homes*, and
*deterministic* in which home. It is total over **carriers** only for the invariant-bearing
subset — which is the honest scope of the abstraction. This is a scope correction, not a
capitulation: the carrier core was always sound for invariant-bearing domain ops; v1 simply
over-claimed it as total over *all* ops.

---

## 3. The load-bearing-invariant stop condition (CONSOLIDATED: attack-2 fix #2 + attack-3 fix #1)

Attack 2 (Break B) and attack 3 (fix #1) demand the **same** change, and it is the single
most important mechanical fix in v2: **carrier status must be earned by a non-trivial
conserved predicate over the type's own fields.** v1 had no such gate — `invariant` was
optional and *no step ever read it* (attack 2 Break B). Unified statement:

> **A type earns carrier status ONLY IF a predicate can be written that:**
> 1. reads **only its own declared subjects' fields** (for a relation carrier, ≥2 of them);
> 2. is a **conserved property** — a real law (conservation, acyclicity, cardinality bound),
>    **NOT**: constant-true / absent; **NOT** schema well-formedness (`timestamp != null`,
>    field-presence); **NOT** a read of ambient/global state outside its subjects;
> 3. for an edge, is **not reducible to "the row exists"** (`a => a.active` is not a law).
>
> **If no such predicate exists, the type is not a carrier.** The op goes to the
> effect/service tier, OR — for an `a.active`-only edge — docks as an `op`/`read` on the
> higher-cardinality subject with the counterpart passed as an argument (no reification).

This single gate does three jobs the two attacks each isolated:

- **Stops junk reification** (attack 3): the 20-entity domain's 17 reified relations collapse
  to the **3 with real laws** (Settlement/conservation, TaskDependency/acyclicity,
  OrgSeat/cardinality). The 11 `a.active` edges and 3 one-op edges dock back onto real
  subjects. "Carriers > entities" inverts to "3 relation vs 20 entity."
- **Stops junk carriers** (attack 2): RateLimitBucket, AuditEntry, CacheCoherence, Search,
  Report fail the gate (schema-shaped, or read ambient state, or no conserved property) →
  effect/service tier. The discriminator v1 lacked now exists and is mechanical.
- **Gates `make`** (attack 1): a `make` target must have a non-trivial invariant. Inert
  records (Receipt, Event, LogEntry, Confirmation, Session-as-token) fail the gate → they are
  **output projections**, not make targets. `charge` cannot file under Receipt.

`invariant` is no longer optional *for a carrier claim*: to file an op under a carrier via
reification or `make`, the conserved predicate must actually exist and be writable (checked or
conventional, but present). Types with no such predicate are simply not carriers.

---

## 4. The revised decision procedure (attack-1 fix: read-set FIRST, verb SECOND)

Attack 1's through-line: v1 routed by **return type** (§3.1) with the sound **read-set** test
(§3.2) demoted to a sub-case, so `charge→Receipt`, `login→Session`, `withdraw:Result<T>`, and
arg-bag `applyDiscount` all misrouted. The fix (attacks 1 & 4 converge): **read-set/delta is
the primary axis; return type/verb is secondary and only picks the verb once the carrier is
fixed.** Also normalize wrappers first (attack 1 Op 3-D: `Result` made dispatch operate on
the wrapper with no unwrap rule).

Run top to bottom, first match wins:

**Step 0 — Normalize.** Unwrap `Result<T,E>`, `Promise`, `Option`, and homogeneous arrays to
the payload type before any dispatch. (Closes attack-1 Op-3-D: without this, a mutating
`withdraw: Result<Account,E>` matched `read` → GET, silently.) Multi-output tuples: see §4.1.

**Step 1 — Identify the home by the breaking-predicate read-set (§3 gate applies).**
1. No non-trivial conserved predicate exists over any subset of subjects → **effect/service
   tier**. DONE. [isEmail, hash, sendEmail, search, nightlyBilling, rate-limit, audit]
2. Predicate reads **exactly one** subject's fields → that subject is the **home carrier**.
   [rename→User, charge→Card, withdraw→Account]
3. Predicate reads **≥2** subjects, none a superset, **and is a non-trivial conserved law** →
   **reify relation R** (it earned its noun); R is the home carrier. [transfer→Transfer,
   addDep→TaskDependency, join→OrgSeat]
4. Predicate reads ≥2 subjects but is only **"the edge exists"** (`a.active`) → **do not
   reify**; dock as `op`/`read` on the higher-cardinality subject, counterpart as an argument.
   [assign→User.op with project arg, tag, watch, grant]

**Step 2 — Pick the verb from read-set + delta (NOT from return type or arg shape).**
Attack 1 (Op 4) proved arg-shape/currying flips make↔op and thus POST↔PATCH; attack 1 (Op 1)
proved return-type flips it too. Verb is derived structurally:
- fetches an existing home value by key, no delta → **load** (GET)
- fresh value of the home type, no pre-existing home subject in the read-set, home type has a
  non-trivial invariant → **make** (POST)
- home subject appears in the output with a changed value (delta) → **op** (PATCH)
- home subject in, nothing out (elimination of the stored subject) → **remove** (DELETE)
- home subject in, non-home value out, no new invariant → **read** (GET); U may be a carrier

This makes the verb invariant to positional/bag/curried encodings and to the success-channel
type — the axes attack 1 showed were free authorial choices orthogonal to invariant ownership.

### 4.1 Multi-output pure ops — honest status: **BOUNDED EXCEPTION, claim narrowed**

Attack 1 (Op 2, the load-bearing fatal finding) is correct and cannot be waved away:
`settle(invoice, payment): [Invoice, Payment]` genuinely maintains **three** invariants at
once — a relational law (`invoice.paidAmount === payment.appliedAmount`) plus **two
independent point-invariants** (`invoice.status==="paid"`, `payment.status==="applied"`), each
owned by a different carrier. No single carrier "is responsible for keeping true" all three.
The v1 phrasing *"the carrier is the type it is responsible for keeping true"* — read as *one
op single-handedly owns all invariants it touches* — is **false for this class, and no fix
preserves it.** So it is narrowed, honestly:

> **Filing (home) is single. Invariant *enforcement* is per-type and automatic.** An op has
> exactly one home. A multi-output op is filed at the home named by its **strongest predicate**
> — the relational conserved law if one exists (`settle`→`Settlement`, the conservation
> carrier), else §4.2. Its **non-home outputs are validated against their own carriers'
> boundary invariants** when the values cross the type boundary — regardless of which op
> produced them. Invoice's `paid` invariant is enforced by Invoice's carrier boundary check on
> the returned Invoice, not by `settle`'s home.

This dissolves the tension between "exactly one home" and "one responsible owner per
invariant" by **separating the two**: an op has one *home* (filing/discovery/projection), and
every carrier *enforces its own point-invariant at its boundary* (correctness), independent of
op home. The narrowed, true claim: **an op has exactly one home; every carrier owns and
enforces its own invariant; a multi-output op is filed once and its foreign outputs are
boundary-checked.** The tuple return is classified (home = the relational carrier), not
"unclassifiable" — Step 0 unwraps the tuple and Step 1.3 finds the relational law.

The residue that is genuinely irreducible: when a multi-output op has **no** relational law,
only two independent point-invariants (a `settle` with no conservation), the home is a free
choice. That is UNRESOLVED-1 (§8).

### 4.2 The `login→Session` conflict (attack-2 Break D) — resolved by §3 + the service tier

v1's §3.1 said `Session.make`; §3.2 said the predicate reads `User.passwordHash` (a different
subject). Resolution: `login`'s validating predicate ("token issued only for verified
credentials") reads an **input subject plus the ambient credential store** — it does *not*
read Session's own fields, and Session-as-bearer-token has a trivial invariant. So `login`
**fails the §3 make-gate** and lands in the **effect/service tier** (auth exchange). No
conflict remains: both mechanisms now agree it is not a Session.make. This is the general
shape of Break D — the producer whose predicate reads a foreign/ambient subject is a service.

### 4.3 Discovery for reified edges (attack-3 fix #2 + #3, HELD-with-fix)

Attack 3 (Break B) is right that a reified edge lives under a third noun the searcher does not
hold. Fixed with machinery v1 already has ("index, never a home"):
- **Dual-home discovery index.** A reified edge is indexed under **both** endpoint carriers'
  `.edges` (`User.edges` and `Project.edges` both surface the edge). One home, no second
  source of truth, discoverable from either subject. Kills Break B.
- **Derived edge naming.** The edge's canonical id is its ordered subject pair + primary verb
  (`User×Project:assign`), not an invented singular noun — greppable, no bikeshed, no
  "no-suggesting-names" violation. Kills Break C. (A human URL alias may live in the manifest;
  see UNRESOLVED-4.)

---

## 5. The central framing call — protocol-agnostic vs CLI-shaped

**This is the most important decision in v2.** Attack 4 proved, information-theoretically, that
`role` carries ~1.58 bits while an HTTP endpoint is a joint choice over method, idempotency,
status, path/nesting, transport, cache, and scope — several of which are provably absent from
both role and types. And attack 4's deepest finding is correct: the same carrier drives **CLI**
faithfully (subcommand + flags + stdout + exit code — a low-dimensional space role is
near-surjective onto) and **HTTP** unfaithfully. v1's "protocol-agnostic truth" was **CLI-shaped
truth** — it fits whichever surface carries the fewest semantic axes.

The honest call, reasoned out. There were two things bundled in v1's vision:

- **(V1a) The domain is a single source of truth, never re-declared per surface.** — *Defensible.*
- **(V1b) A surface is generated from the core unaided; zero per-op surface config; role alone
  yields the wire.** — *Refuted by counting (attack 4). Overreach.*

v2 **preserves V1a and retracts V1b.** The framing downgrades exactly as attack 4 proposed —
to *"typed core + a thin per-surface projection layer that adds surface-only facts"* — and I
judge this **preserves the original vision's load-bearing half and concedes only its
overreach.** The load-bearing intent was always *"do not maintain N copies of the domain."*
That survives intact: the surface-only bits (method, path, status, idempotency, scope, cache,
transport) **were never domain facts** — they are properties of the wire, not of the business
rule. Adding them in a projection is *decoration*, not a second declaration of the domain.
What is conceded — that the core cannot spit out a REST API by itself — was never true anyway;
v1 only appeared to have it because its examples were CLI-simple.

So the framing is not "protocol-agnostic" (false) but **"domain-agnostic-to-surface"**: the
domain truth is single and surface-blind; each surface reads it and adds what only that
surface needs. This is stronger honesty for a *weaker* word, and it is the version that ships.

### 5.1 The projection layer (CONSOLIDATED: attack-4 additive table + attack-5 opId/route-lock)

Attacks 4 and 5 demand **one artifact**, verified: attack 4 wants an additive, op-keyed table
of surface-only bits; attack 5 wants a stable `opId` plus an append-only route-lock keyed on
that id. They are the same manifest, doing both jobs. Definition:

> **The projection manifest** (one per surface). Properties:
> 1. **Op identity is stable and carrier-independent.** Every op has an `opId` that **survives
>    re-filing** — identity is `opId`, not `carrier+name` (attack 5 fix #1). Re-homing an op
>    (a refactor discovering a new law) is a compiler-caught call-site change, NOT an identity
>    change.
> 2. **Additive only.** The manifest carries *only* surface-only facts the domain lacks:
>    method override, path template, success status, idempotency flag, auth scope, cache
>    policy, transport (query vs json vs multipart). It **cannot** re-declare or rename ops,
>    types, or invariants, and **cannot** change what an op does. The op never imports the
>    surface. This is the precise redefinition of *"no second source of truth"*: **no
>    re-declaration of DOMAIN facts per surface** — surface-only facts are not domain facts
>    (attack 4 fix #1).
> 3. **Role supplies the default; the manifest supplies the ~20% role provably lacks.**
>    Defaults: make→POST/201, load→GET/200, op→PATCH/200, remove→DELETE/204, read→GET/200.
>    Service-tier ops have **no** role default and declare their surface facts directly.
> 4. **Append-only / route-lock.** On first publish, defaults freeze into the manifest;
>    thereafter the manifest is the source of *surface identity*. A re-filed op keeps its
>    locked `{method, path}` because the lock keys on `opId` (attack 5 fixes #2–#3). Internal
>    home moves; public URL does not.
> 5. **CI diffs the manifest.** Any surface change — a new op, a deliberate re-route, an
>    idempotency change — is a **reviewable lock diff.** This restores the missing signal
>    attack 5 identified: a refactor is no longer a silent client break; to move a URL you edit
>    the lock on purpose and reviewers see it (attack 5 fix #4).

This closes attack 4's Breaks 2 (idempotency — a manifest flag), 3 (scope/status/cache —
manifest fields), and the method-override cases, **and** attack 5's whole coupling break, with
one artifact. Nesting (attack 4 Break 5) is the manifest's `path` template. Large-body reads
(Break 4) are the manifest's `transport: json` with cache policy stated explicitly.

### 5.2 What the manifest still cannot fix (held as scoped-out, not hidden)

- **Streaming/subscription** (`subscribe => AsyncIterable`) is neither a carrier role nor a
  clean manifest entry. v2 scopes it to the **service tier** with an explicit surface
  declaration; a `subscribe` role is added only if streaming becomes common (UNRESOLVED-3).
- **Capability projection** (attack 5 step 4): resolved — capability impls **are** the
  carrier's own ops and carry `opId`s, so they are in the projection catalogue by
  construction. Promotion to a capability does not drop or move a route. (Closes the
  underspecification attack 5 flagged.)

---

## 6. Capability tier (held from v1, one clarification)

Unchanged: a capability is declared once over a carrier variable, implemented per carrier; the
impls are that carrier's own ops (they have `opId`s and project normally); it is an index,
never a home; promoted only when the op-set recurs across ≥2 carriers; functor reserved for
genuine map/traverse structure-preservation. Clarification forced by attack 5: `implement`
**must** keep the impl directly callable as the carrier's method (`Document.archive(doc)`
resolves) and must register each impl's `opId` in the projection catalogue.

---

## 7. Per-attack disposition

| Attack | Verdict | What changed |
|---|---|---|
| 1 — determinism via return type | **FIX** + one **narrowed claim** | Reorder: read-set/delta primary (§4 Step 1), verb secondary (Step 2); Step-0 wrapper normalization; non-trivial-invariant gate on `make` (§3). Multi-output (`settle`) narrowed to bounded exception (§4.1); the "one op owns all its invariants" reading is **retracted**, replaced by one-home + per-carrier boundary enforcement. |
| 2 — ambient / cross-cutting | **FIX** | Totality-over-carriers **retracted** (§2); effect/service tier added (§1); invariant made load-bearing (§3); `read` widened to carrier-typed U (§1); `login`-type conflict resolved to service tier (§4.2). |
| 3 — sprawl into micro-carriers | **FIX** (same gate as attack 2) | Reification stop-condition = the §3 non-trivial-invariant gate (17→3 relation carriers); dual-home `.edges` discovery index; derived edge naming (§4.3). |
| 4 — HTTP projection = 2nd source of truth | **FIX**; central claim (role generates HTTP unaided) **retracted** | Framing downgraded to typed core + thin projection that adds surface-only facts (§5); "no 2nd source of truth" redefined as no re-declaration of domain facts (§5.1); load/remove roles added (§1); projection manifest added (§5.1). |
| 5 — instability under change | **FIX** (same artifact as attack 4) | Stable `opId` + append-only route-lock manifest + CI diff (§5.1); this IS the attack-4 projection manifest, unified. Capability-promotion projection specified (§5.2, §6). |

**Consolidations performed:** (i) attack-2's "invariant load-bearing" ≡ attack-3's
"reification stop-condition" → the single §3 gate. (ii) attack-4's "additive op-keyed
projection table" ≡ attack-5's "opId + route-lock manifest" → the single §5.1 projection
manifest.

---

## 8. UNRESOLVED — owner's call

1. **Multi-output op with no relational law — where is the home?** When an op returns two
   subjects with two independent point-invariants and no conserved cross-subject law, §4.1's
   "file at the strongest predicate" gives no unique answer. *Recommendation:* permit one
   explicit `home:` designation on such ops (the single genuine judgment call attack 1 exposed),
   validate the non-home output at its boundary, and keep it rare. Do **not** invent a
   law-less relation carrier just to have a home.

2. **`a.active` edge collapse target — higher-cardinality subject vs a shared `Edges` host?**
   §3 docks flag-edges back onto a real subject, but which. *Recommendation:* default to the
   higher-cardinality subject with the counterpart as an arg, plus the dual-home `.edges`
   index for discovery; fall back to a shared `Edges` host only when neither subject is
   clearly higher-cardinality. Owner sets the default.

3. **Streaming/subscription — service tier now, or a `subscribe` role?** *Recommendation:*
   keep it in the service tier with an explicit manifest surface declaration; add a fourth
   role only if streaming endpoints become common. Do not expand the role set speculatively.

4. **Derived edge names vs human URL aliases.** Canonical `opId` is derived
   (`User×Project:assign`); URLs may want a friendlier noun. *Recommendation:* keep the
   derived name as the stable identity anchor and allow an optional human alias **in the
   manifest** (surface-only, so no domain re-declaration). Owner decides whether public URLs
   use derived or aliased names.

5. **Is idempotency a domain fact or a surface fact?** §5.1 files it as a manifest flag
   (surface), but `f(f(x))===f(x)` is arguably a property of the function. *Recommendation:*
   treat it as a one-bit op-level annotation that lives *with the op* but is *consumed by*
   projection — recorded once, read by every surface. Owner decides which side of the
   domain/surface line it sits on; the manifest can hold it either way.

6. **Do `load`/`remove` belong in the carrier, or in a separate persistence layer?** They are
   persistence-facing (they concern stored identity, not value transformation). *Recommendation:*
   keep them as carrier roles for clean GET/DELETE defaults; if the core is meant to be strictly
   storage-agnostic, the owner may instead move CRUD-R/D into a persistence projection and drop
   the implication that the pure core alone yields a full REST surface (attack-4's alternative).
   Lean: keep as roles, mark persistence-facing.
