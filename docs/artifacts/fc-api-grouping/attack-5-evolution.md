# Attack 5 — Instability Under Change (evolution / refactor-coupling)

*Red-team of `design.md` (same dir). Thesis under test: carrier-derivation couples internal
code organization to the public projected surface, so you cannot refactor one without
breaking the other. Default assumption: broken; below is the proof.*

---

## 0. The coupling, stated as an identity

Read three load-bearing claims of the design together:

1. **URL/method are a pure function of carrier + verb-kind.** §3.3, line 227:
   `POST /transfers (transfer), PATCH /transfers/:id (reverse)`. The path is `/{carrier}s`,
   the id-ness comes from endo-vs-intro, the method comes from `make`/`op`/`read`. No per-op
   annotation, by explicit design ("nothing HTTP-shaped can flow back").

2. **Carrier is a deterministic function of the op's signature + breaking-predicate
   read-set.** §3.1 (decision procedure, "total and deterministic") + §3.2 ("decidable from
   the predicate's read-set"). The dev does not choose the home; the signature/invariant
   chooses it.

3. **The procedure is designed to RE-FILE ops when the signature/invariant changes.** §3.1
   step 4: "the missing carrier IS the relation. Reify `R`, then GOTO 1 with `T := R`." The
   whole point of the rule is that discovering a new cross-subject law *moves the home*.

Compose them:

> **public_URL(op) = f(carrier(op)) = f(g(signature(op), invariant_read_set(op)))**

There is **no indirection layer** anywhere on this path. The projector is total and
mechanical (§3.3: "total over any carrier"). It has no pin, alias, version map, or manifest.
Therefore **any internal change that the decision procedure would re-file is, by
construction, a change to the public URL** — and because the projector just re-emits, the
change is **silent**: the code compiles, the route table simply differs.

Internal filing and public URLs have *opposite* stability requirements — the design
*celebrates* re-filing as understanding improves (reify when you find a law), while public
URLs are a contract clients pin against. Coupling two artifacts with opposite change-freq
requirements through a pure function with no indirection is the break.

The rest of this doc makes it concrete and counts the blast radius.

---

## 1. Evolution sequence with blast radius per step

### Step 0 — baseline

```ts
Document.op("archive", (d): Document => ({ ...d, archivedAt: now() }));
```
- Carrier: **Document** (endomap, breaking predicate reads only Document's fields). §3.1 rule 2.
- Verb-kind: `op` → PATCH.
- **Projected public route: `PATCH /documents/:id`  (archive)**.

### Step 1 — the op gains a second subject (audit) → **carrier flips, URL breaks**

Product asks: archiving must be auditable — record *who* archived, immutably, and the
document's `archivedAt` must equal the audit record's timestamp (a cross-state law).

```ts
// the law now reads TWO subjects: the doc AND the audit record
Archival.make("archive", (d: Document, byUser: User): Archival =>
  ({ doc: d.id, by: byUser.id, at: now() }));
```

Run §3.2 honestly: the predicate that goes false if buggy —
`archival.at === document.archivedAt && actor exists` — **reads two subjects, none a
superset**. §3.1 rule 4 fires: **reify `Archival`, GOTO 1**. `archive` is now `make` on
Archival.

What the projector emits changes on **three axes at once**:

| axis | before | after |
|---|---|---|
| collection | `/documents` | `/archivals` |
| method | PATCH | POST (make→POST) |
| target shape | `:id` (mutate existing) | collection (create) |

- **Old route `PATCH /documents/:id (archive)` VANISHES. New route `POST /archivals`
  APPEARS.** Every HTTP/CLI/GraphQL client that archived a document now 404s / gets a
  different verb / must send a different body referencing the doc by id. This is a
  **complete client rewrite**, triggered by an *internal invariant refinement*, with **zero
  signal** — no deprecation, no type error, nothing in review flags that a public contract
  moved. The projector is total; it just prints the new table.
- Internal call sites: every `Document.archive(doc)` → `Archival.archive(doc, byUser)`
  (module move + new arg). These *are* caught by the compiler — ordinary, acceptable churn.
- Tests: every test asserting the old route or the old home moves.

**Blast radius (step 1): 1 public route destroyed + 1 created (silent, breaking); N call
sites + M tests re-pointed (compiler-caught).** The public break is the fatal-grade part;
the internal churn is normal.

Note the trap: the *safe* version of this change — storing `archivedBy` as a field on
Document so the predicate still reads only Document — does **not** flip the carrier. So
whether a refactor is a breaking API change depends on an invisible, internal modeling
choice (field-on-entity vs reified event) that has **no surface marker**. The dev refactoring
for audit has no way to know they just broke every client.

### Step 2 — a reified relation grows (Assignment)

```ts
Assignment.make("assign", ...); Assignment.op("revoke", ...);  // /assignments, POST + PATCH
```
- **Additive field** `role: "member"|"lead"`: invariant read-set unchanged (`a.active`) →
  carrier stays Assignment → **routes stable**. Additive growth is safe. Good.
- **Role gains a cardinality law** ("a project has exactly one lead"): the breaking predicate
  for `promote(assignment,"lead")` reads the *whole set* of Assignments for a project — a
  collection, owned by neither Assignment nor Project nor User. §3.1 rule 4 fires again but
  the target is ambiguous (self-critique #2): reify `Leadership`? treat as a law on Project?
  Whichever you pick, `promote` re-files → **`PATCH /assignments/:id` moves to
  `PATCH /leaderships/:id` or `PATCH /projects/:id/lead`** → clients break again.
- **Assignment becomes its own entity** (gains id/lifecycle, spawns sub-relations): every op
  re-homes across the split → route churn proportional to the op count.

### Step 3 — splitting a carrier when its invariant bifurcates

Design mandate (§ self-critique framing / prompt): "if a type accretes two invariants, split
it." Document accretes content-validity (`title.length>0`) **and** publication-workflow
(legal state transitions). Split → `Draft` + `Publication`.

- Every op on Document re-files to one of the two new carriers.
- `/documents` collection **splits into `/drafts` + `/publications`**; `publish` goes from
  `PATCH /documents/:id` to `POST /publications`.
- **Every existing client of `/documents/*` breaks.** The split is a purely *internal
  organizational* decision (two invariants shouldn't share a type) — and the design's own
  hygiene rule thereby *mandates a breaking public API change*. Following the design's
  refactoring advice breaks the design's stability guarantee.

**Blast radius (step 3): entire `/documents/*` surface re-partitioned; every client
touched.**

### Step 4 — capability promotion

`archive` recurs on a 2nd carrier → §1 says promote to `Archivable`, and claims "a capability
does not move ops off their carrier … the impls *are* the carrier's own ops."

- **Internal callers:** IF `implement` keeps `Document.archive` resolvable as a direct method,
  `Document.archive(doc)` still works → low internal churn. This part is fine — *provided*
  `implement` preserves direct dispatch (the design asserts it but shows the impl written
  inside `implement({...})`, so direct callability is unverified).
- **Projector:** §3.3 says the projector reads "make/op/read." It says **nothing** about
  whether it walks capability impls. If capability methods are not in the catalogue the
  projector enumerates, promoting `archive` to a capability **silently drops
  `PATCH /documents/:id (archive)` from the emitted surface**. If it does walk them, the
  verb-kind of a capability method (endomap-shaped → PATCH) is never specified. Either way,
  **promotion — a pure de-duplication refactor — has an unspecified effect on the public
  surface.** Underspecification here is itself instability.

---

## 2. The core question, answered

> Does carrier-derivation couple internal code organization to the public projected surface
> such that you can't refactor one without breaking the other?

**Yes, provably** (§0 identity), and demonstrated at steps 1, 2b, 3. The public URL namespace
is a *pure, un-indirected function* of internal filing decisions. The decision procedure's
central feature — re-filing ops as invariants are discovered — is *by construction* a public
API mutation, and the projector's totality makes that mutation **silent**: no type error, no
deprecation, no diff a reviewer would notice. A refactor is a breaking API change with no
signal. That is exactly the failure the attack predicted.

Severity amplifiers:
- **Silence.** The worst property. A loud break (compile error) is survivable; this is
  invisible until a client 404s in production.
- **Following the design's own advice triggers it.** §3.1 step 4 and the "split on two
  invariants" hygiene rule *mandate* the re-filings that break the surface.
- **The safe/unsafe distinction is sub-surface.** Field-on-entity vs reify-event decides
  breakage and has no marker at the API layer.

---

## 3. Verdict: **FIXABLE** (serious, one indirection layer short of fatal)

Not fatal, because the design *already* isolated the projector as a separate downstream
function (§3.3) — the seam where a fix belongs already exists. What's missing is one thing:
an indirection between carrier-identity and public-identity. The break comes from the
projector being a *pure function* with no pinning. Remove the purity at the surface boundary
only, and the coupling dissolves.

The design will resist this via self-critique #4 ("override config becomes a second,
surface-shaped source of truth — forbidden"). That objection **conflates two different
things**: (a) a second source of truth for the *op's definition/behavior* — genuinely bad,
keep forbidding it; and (b) a record of the *public contract's identity* — which is an
inherently separate artifact with its own lifecycle (versioning, deprecation). A public API
is not the op; it is a promise about names. Recording that promise is not a second schema.

### Minimal fix

1. **Stable op identity independent of carrier.** Give every op an id (a stable name) that
   **survives re-filing**. Today an op is identified by `carrier + name`; when the carrier
   moves, identity is lost. Make identity `opId` alone. (Small, mechanical.)

2. **A generated, append-only surface manifest ("route lock").** On first publish, the
   projector *freezes* `opId → { method, path }` for every currently-projected op. It is
   generated from the defaults (§3.3 stays the authoring ergonomics) but then pinned.

3. **Projector reads the lock first, defaults second.** A re-filed op keeps its locked
   `{method, path}` because the lock keys on `opId`, which the move preserved. Its *internal*
   home changed (compiler-caught call-site churn — fine); its *public URL* did not.

4. **CI diffs the lock — this restores the missing signal.** Any change to the public surface
   (a genuinely new op, or a deliberate re-route) now shows up as a **reviewable lock diff**.
   The silent break becomes an explicit, opt-in, versioned change: to move a URL you edit the
   lock on purpose, and reviewers see it.

This is exactly one indirection table plus stable op-ids. It preserves everything the design
values — single op definition, no per-op HTTP annotation *at authoring time*, projector stays
downstream — while cutting the pure-function coupling that turns every invariant refinement
into a silent client break.

### Residual (accept, don't fix)

Internal call-site + test churn on re-filing remains. That is ordinary refactor cost and is
**compiler-caught**, so it carries its own signal. The fatal-grade problem was specifically
the *silent public* break; the lock converts it to a reviewable one. Ship the lock before any
client depends on a projected surface, or the coupling is load-bearing before it's fixable.
