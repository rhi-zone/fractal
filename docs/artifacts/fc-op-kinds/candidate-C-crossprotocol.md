# Candidate C — Operation Kinds via Cross-Protocol Invariance

## Framing

A kind is REAL only if **at least two different protocols must treat it differently**.
Anything only one protocol cares about is that protocol's *projection detail*, not a kind.
So the method is: enumerate what HTTP, CLI, MCP/tool-calling, and gRPC each need to know
about an operation to project it correctly; then keep only the distinctions that RECUR
across ≥2 protocols.

The anchor constraint is honored throughout: **POST = a method call / invocation** is the
one fixed kind→HTTP-verb mapping. Kinds are NOT derived from verbs; they are derived from
what protocols independently need, and the verb falls out afterward.

---

## 1. What each protocol independently needs to distinguish

### HTTP
- **Safe vs. unsafe** (does it mutate? affects caching, prefetch, crawler behavior).
- **Idempotent vs. not** (retry-on-timeout safety → PUT/DELETE retriable, POST not).
- **Cacheable vs. not** (GET responses cache; others don't).
- **Verb selection** (GET/PUT/DELETE/PATCH/POST) — *HTTP-only surface detail*.
- **Body vs. no body** — *HTTP-only surface detail*.

### CLI
- **Read vs. write** → whether to prompt for confirmation on destructive actions
  (`rm`, `--force`), and whether the command is "safe to run in a script".
- **Output-to-stdout vs. side-effect** → a query streams data to stdout for piping; an
  action reports status/exit code.
- **Retriable / re-runnable** → can I safely re-run this in a Makefile without damage?
- **Flag naming / subcommand shape** — *CLI-only surface detail*.

### MCP / tool-calling
- **Query vs. action** → the model plans differently: a query is "gather information, cheap,
  reversible, call freely"; an action "changes the world, may need user consent, call
  deliberately". This is *the* MCP distinction (readOnlyHint / destructiveHint annotations).
- **Reversible vs. destructive** → whether to surface a consent gate before calling.
- **Idempotent hint** → whether the model may safely retry after an ambiguous result.
- **Tool name / JSON schema** — *MCP-only surface detail*.

### gRPC
- **Mutating vs. non-mutating** → `idempotency_level` (NO_SIDE_EFFECTS / IDEMPOTENT /
  non-idempotent) drives automatic retry policy in the client library.
- **Retriable vs. not** → retry & hedging config.
- **Method naming / streaming shape** — *gRPC-only surface detail*.

---

## 2. The recurring-distinctions matrix

| Distinction | HTTP | CLI | MCP | gRPC | Recurs? |
|---|---|---|---|---|---|
| **Reads-vs-mutates** (safe / side-effect-free) | ✅ safe→GET, cache | ✅ query→stdout, no prompt | ✅ readOnlyHint, plan freely | ✅ NO_SIDE_EFFECTS | **4 — REAL** |
| **Idempotent-vs-not** (safe to retry) | ✅ PUT/DELETE retriable | ✅ re-runnable in scripts | ✅ retry hint | ✅ IDEMPOTENT retry policy | **4 — REAL** |
| **Reversible-vs-destructive** (consent gate) | ~ (no native concept) | ✅ confirm prompt / --force | ✅ destructiveHint | ~ (no native concept) | **2 — REAL** |
| Verb / body shape | ✅ | — | — | — | 1 — projection detail |
| Streaming shape | — | ~ | ~ | ✅ | ≤1 strong — detail |
| Cacheable | ✅ | — | — | — | 1 — detail (derives from reads) |

Three distinctions recur across ≥2 protocols. Note **cacheable** collapses into
reads-vs-mutates (it's what HTTP *does* with "reads"), so it is not an independent kind.
**Idempotent** and **reversible** are orthogonal to reads-vs-mutates and to each other, so
they survive as independent axes.

### Key realization: kinds are a small product of orthogonal AXES, not a flat list

The three surviving distinctions are near-orthogonal boolean axes:
- **effect**: reads | mutates
- **idempotent**: yes | no  (only meaningful when it mutates)
- **destructive**: yes | no  (only meaningful when it mutates)

A "read" is always safe+idempotent+non-destructive, so it collapses to one kind. Mutations
fan out along the two remaining axes. Collapsing impossible/uninteresting combinations
yields a **bounded set of 4 kinds** (plus the fixed POST=call anchor as a 5th, which is the
one kind defined by *invocation semantics* rather than the effect axes).

---

## 3. The resulting kind set

| Kind | Agnostic 1-line definition | Example |
|---|---|---|
| **observe** | Returns a view of state without changing it; safe, cacheable, freely retriable. | fetch a user record; list orders |
| **set** | Mutates state to a caller-specified value; idempotent (re-applying is a no-op), non-destructive-by-default. | set a config value; upsert a profile |
| **erase** | Mutates by removing/tearing-down a named thing; idempotent (erasing twice = same end state) but **destructive** (consent-worthy). | delete a resource; revoke a token |
| **amend** | Mutates a *part* of existing state; NOT idempotent in general (depends on current value), non-destructive. | increment a counter; append to a log; apply a diff |
| **call** | *(anchor)* Invokes a procedure/method for its effect and/or return; not assumed safe, idempotent, or reversible. | send email; run a job; charge a card |

Why these five and not more/less:
- `observe` = the single collapsed "reads" cell (all four protocols need it).
- `set` / `erase` = the two idempotent-mutation cells, split by the **destructive** axis
  (which MCP+CLI both need). Without the destructive axis these would be one kind; because
  two protocols distinguish reversible-vs-destructive, the split is earned.
- `amend` = the non-idempotent-but-not-destructive mutation cell (the idempotent axis,
  needed by all four for retry policy, earns splitting it from `set`).
- `call` = the anchor. It is deliberately the *catch-all* invocation kind: anything whose
  effect/idempotency/destructiveness can't be statically promised is a `call`. This keeps
  the effect-typed kinds honest (they carry real guarantees) and gives POST its fixed home.

Bounded, head-holdable: **5 kinds, generated by 3 axes.** No apparatus sprawl.

---

## 4. Per-kind projection table

| Kind | (a) inferable or authored | (b) HTTP verb | (c) CLI | (d) MCP |
|---|---|---|---|---|
| **observe** | **Inferable** — pure `T => U`, no writes in signature/impl; JSDoc `@observe` override. | GET | subcommand or `get`/`list`; streams to stdout; no confirm; script-safe | tool with `readOnlyHint: true`; model calls freely |
| **set** | Authored-leaning — "idempotent full-write" is a promise the author makes; inferable if the fn is a total replace over a keyed store. | PUT | `set`/`put` subcommand; no confirm (re-runnable); idempotent flag | tool, `readOnlyHint:false, idempotentHint:true, destructiveHint:false` |
| **erase** | Authored — destructiveness is a semantic promise, rarely inferable. | DELETE | `rm`/`delete`; **confirm prompt** unless `--force`; idempotent | tool, `destructiveHint:true`; model surfaces consent |
| **amend** | Authored-leaning — partiality/non-idempotency usually not inferable from types. | PATCH | `edit`/`update`/`add`; confirm optional; **not** blindly re-run in scripts | tool, `idempotentHint:false, destructiveHint:false` |
| **call** | **Default when nothing else inferable / authored `@call`.** | **POST (fixed)** | verb subcommand (`send`, `run`); confirm if flagged; not auto-retried | tool, no safety hints (or explicit); model calls deliberately |

Inference rule of thumb: a statically-pure function ⇒ `observe`; everything else defaults to
`call` unless the author narrows it to `set`/`erase`/`amend` for the extra guarantees (and
the sharper projection they buy). Overrides are first-class via JSDoc tags.

---

## 5. Self-administered "secretly HTTP" test

**Question: is this observe/set/erase/amend/call just GET/PUT/DELETE/PATCH/POST renamed?**

The mapping *looks* 1:1, which is exactly the trap. Discriminating checks:

- **Did the verbs drive the kinds, or the protocols?** The kinds came from a 4-protocol
  matrix; the destructive axis (`set` vs `erase`) is earned by **CLI+MCP**, not by HTTP —
  HTTP has no native destructive concept, it just happens to have a DELETE verb. So `erase`
  is NOT "DELETE renamed"; it's "the destructive-idempotent-mutation cell that CLI's confirm
  prompt and MCP's destructiveHint both independently need." ✅ passes.
- **Does a kind exist that HTTP can't cleanly express?** `amend` maps to PATCH, but PATCH is
  HTTP's *weakest* verb (semantics undefined by spec). Our `amend` has a sharper agnostic
  definition (non-idempotent partial mutation) than PATCH does — the kind is more principled
  than the verb, so it's not verb-derived. ✅
- **Do two kinds ever share a verb / does one kind span verbs?** `call` deliberately
  absorbs many things HTTP would spread across POST *and* sometimes PUT (non-idempotent
  writes). And `set`+`call` both could be POST in sloppy HTTP but are distinct kinds. The
  kind boundary does NOT coincide with the verb boundary → not secretly HTTP. ✅
- **Weakness admitted:** the *count* (5) and the visual near-alignment with 5 HTTP verbs is
  genuinely suspicious (see §6). The defense is provenance (matrix-first), not appearance.

**Verdict: PASSES, but narrowly on appearance.** The derivation is verb-independent and the
axes are protocol-sourced; however the surface resemblance to CRUD-verbs is close enough
that a skeptic is right to demand the provenance audit above. Substance clean, optics risky.

---

## 6. Weakest points (for a red team)

1. **The 5≈5 coincidence.** Five kinds landing on GET/PUT/DELETE/PATCH/POST is *exactly*
   what a reverse-engineered-from-HTTP design would produce. Even though the derivation is
   independent, the outcome is indistinguishable-by-inspection from the failure mode. A red
   team should attack: "prove `amend` isn't just PATCH." The honest answer is that the
   idempotent axis is real (all 4 protocols use it for retry) — but if PATCH didn't exist,
   would we still have carved `amend` out of `call`? Arguably `amend` is the shakiest kind:
   its only cross-protocol customer beyond "it mutates non-idempotently" is HTTP's PATCH and
   gRPC's non-idempotent retry level — and gRPC's non-idempotent is the *default*, not a
   distinction it works to make. So `amend` may rest on **1.5 protocols**, not a clean 2.
   Candidate for merger into `call`.

2. **`set` vs `call` boundary is a promise, not a type.** Idempotency of `set` is almost
   never statically inferable — it's an authored claim the runtime can't check. If authors
   under-annotate (rational: `call` is the safe default), the effect-typed kinds starve and
   everything collapses to `observe` + `call` (a 2-kind world). That 2-kind world might
   actually be the *true* cross-protocol invariant (reads-vs-mutates is the only ✅×4 row;
   idempotent and destructive are ✅×4 and ✅×2 as *hints* but degrade gracefully to
   defaults). A red team could argue the principled minimum is **observe + call**, with
   set/erase/amend demoted to optional authored *refinements/annotations* on those two —
   which would dissolve half the kind set.
