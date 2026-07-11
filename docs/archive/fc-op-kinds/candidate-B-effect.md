# Candidate B — Operation Kinds from State & Effect

Framing: derive kinds from **what an operation does to the world/state**, judged by
**how a caller must reason about it** (retriable? cacheable? reversible? observable?).
Reasoned from first principles; CQRS is a cousin, not a source.

## 0. The first-principles move

CQRS's split is **query vs command**. Push on it: "command" lumps together things a
caller must treat *completely differently*:

- overwrite a field to a target value (retry freely — lands the same),
- increment a counter (retry = double-count — corruption),
- send an email (retry = double-send — irreversible, escapes the system).

All three are "commands," yet the retry/reversibility contract differs at each. So
**query-vs-command is too coarse**: the distinctions that actually govern caller behavior
live *inside* "command." The right axis is not "does it mutate" but **"how much may the
caller assume about repeating / undoing / caching it."** That yields a *ladder of
caller-trust*, and the kinds are its rungs.

### Caller-facing effect axes (the only things that matter)
1. **Observability of change** — does calling it change any observable state? (safe vs unsafe)
2. **Convergence under repetition** — is the resulting state independent of how many times
   you call? (idempotent vs accumulative) → the retry contract.
3. **Reversibility / locus** — does the effect stay on the addressed subject (rollback-able
   in principle) or escape to the world (email, log, charge — not rollback-able)?

Everything else (full vs partial body, create vs delete) turns out **not** to be an
effect-kind — see §4. That is the whole payoff of this framing.

## 1. The kind set — a ladder of increasing caller-caution

Each rung relaxes one guarantee the caller could previously rely on.

| # | Kind | Agnostic definition | `T => U` example | Caller contract |
|---|------|---------------------|------------------|-----------------|
| 0 | **Observe** | Reads state; produces no observable change. | `getUser: UserId => User` | safe · cacheable · retry-free |
| 1 | **Converge** | Drives the subject to a *declared target state*; repeating lands the same state (idempotent). | `setStatus: (TaskId, Status) => Task` | unsafe · not-cacheable · **retry-safe** · reversible-by-re-converging |
| 2 | **Accumulate** | Applies a change whose result depends on current state / call-count (non-idempotent). | `incrementViews: PostId => Post`; `appendEntry: (Log, Entry) => Log` | unsafe · **retry-UNsafe** (dupes) · hard to reverse |
| 3 | **Invoke** | Runs a procedure; effect on the subject/computation is opaque to the type. **(settled = POST anchor)** | `rebuildIndex: BuildArgs => BuildReport` | unsafe · effect unknown · retry-contract unknown |
| 4 | **Emit** | Produces an effect on the *world beyond* the addressed subject; externally visible, not rollback-able. | `sendEmail: Email => DeliveryReceipt` | unsafe · **irreversible** · retry = double-fire · open-world |

Read top-to-bottom: Observe assumes the most (nothing happens); each rung below removes a
safety the caller had — first cacheability, then retry-safety, then reversibility, then
containment within the system. **That gradient is the theory of the set.** Five rungs;
head-holdable as "look → converge → accumulate → invoke → emit."

Why exactly these cuts and no more/fewer:
- Observe must exist: safe+cacheable is a category unto itself (the whole point of GET-like
  reasoning, but earned here from "no observable change," not from GET).
- Converge vs Accumulate must split: **idempotency is the single most retry-critical
  property** a caller has; collapsing them hides whether retry corrupts data.
- Invoke must exist and is *settled* as the POST anchor: the residual "just run this logic,
  effect not capturable as observe/converge/accumulate."
- Emit is the marginal rung (see §5): locus-escapes-to-world is a genuinely different
  contract (irreversible, un-retriable) — but it may be an *attribute of Invoke* rather than
  a peer. Kept separate here because the caller consequence (double-send, no rollback) is
  exactly what this framing exists to make legible.

## 2. Inferable vs authored

| Kind | Inferable from TS type? | Basis |
|------|-------------------------|-------|
| Observe | **Sometimes** — if typed pure / returns a read-model/`View` and takes only an address, infer read-only. | purity/return-shape heuristic |
| Converge | **No** — idempotency is invisible to the type. `(Task,Status)=>Task` looks identical to an accumulate. | **authored/annotated** |
| Accumulate | **No** — same signature shape as Converge. | **authored/annotated** |
| Invoke | Default fallback when nothing else is asserted. | authored (or defaulted) |
| Emit | **Rarely** — inferable only if return type is a `Receipt`/external-effect marker. | **authored** |

Honest consequence: **the effect strata are semantic, and TS types don't encode effects**,
so most of this set must be *authored*, not inferred. This is the framing's price (see §5.2).
It fits the "authored where underdetermined, overrides first-class" rule — but the
underdetermined set is large here.

## 3. Projections (proving agnosticism)

POST is fixed to **Invoke**. Note the mapping is deliberately **many-to-many** with HTTP
verbs — the kind set is *finer* than the verb set.

| Kind | HTTP | CLI | MCP (tool + annotation) |
|------|------|-----|-------------------------|
| Observe | `GET` | `get` / `show` / `list` (read-only, no confirm) | tool · `readOnlyHint: true` |
| Converge | `PUT` if target=present · **`DELETE` if target=absent** · idempotent `PATCH` (merge) | `set` / `apply` / `ensure` · `rm` for →absent | `idempotentHint: true` · `destructiveHint` iff →absent |
| Accumulate | `PATCH` (delta) else `POST` | `add` / `append` / `incr` (may warn on repeat) | `idempotentHint: false`, `destructiveHint: false` |
| Invoke | **`POST` (fixed)** | `run` / `exec` / verb-named subcommand | tool · defaults (`idempotentHint: false`) |
| Emit | `POST` | `send` / `notify` / `dispatch` | `openWorldHint: true` |

Two agnosticism proofs fall out:
- **MCP's own annotation fields (`readOnlyHint`, `idempotentHint`, `destructiveHint`,
  `openWorldHint`) are effect properties the MCP designers invented independently.** This
  set projects onto them almost 1:1 — strong evidence the axes are protocol-neutral, not
  HTTP-derived.
- **Converge fans out to PUT *and* DELETE** from a single kind, chosen by whether the
  declared target is present/absent. The verb is downstream of an effect property, not the
  source of the kind.

## 4. What this framing *dissolves* (the real payoff)

- **create / destroy is NOT a kind.** "Make it exist" with a client-chosen identity =
  Converge-to-present (idempotent). "Make it not exist" = Converge-to-absent (idempotent).
  "Make a new thing with server-assigned id" = Accumulate/Invoke (repeat → duplicates).
  Existence-change decomposes into the idempotency axis. No create/destroy kind needed —
  which is exactly why we don't back into DELETE.
- **partial vs full is NOT a kind.** "Partial body" (PATCH's defining trait) is a *payload
  shape* orthogonal to effect: a merge-patch can be Converge (idempotent) or a delta-patch
  can be Accumulate. So PATCH splits *across* kinds — there is no "partial" kind.

## 5. Self-administered "secretly HTTP" test

Test each verb: is a kind just that verb renamed?

- **GET → Observe?** Observe is defined by "no observable change" (a caller property) and
  projects to CLI-read and MCP-`readOnlyHint`, not only GET. GET is Observe-shaped, not vice
  versa. **PASS** (closest 1:1 — mild smell, see §5.3).
- **PUT → Converge?** Converge is *broader* than PUT: one kind → PUT + DELETE + idempotent
  PATCH. Not PUT renamed. **PASS.**
- **DELETE → ???** **No dedicated kind exists.** Delete folds into Converge-to-absent. A
  "Remove/Destroy" kind would have been the failure mode; there isn't one. **STRONG PASS.**
- **PATCH → ???** **No dedicated kind exists.** "Partial" is payload shape; PATCH splits
  across Converge and Accumulate. **STRONG PASS.**
- **POST → Invoke?** Invoke is the settled anchor, but Accumulate and Emit *also* funnel
  onto POST — the set is finer than POST. **PASS.**

**Verdict: NOT secretly HTTP.** The 5-kinds/5-verbs count is a coincidence; the mapping is
non-diagonal (Converge→{PUT,DELETE}, Accumulate→{PATCH,POST}, Invoke/Emit→POST, and no kind
answers to DELETE or PATCH alone). The kinds were derived from retry/reversibility
reasoning and are *finer* than and *skew* to the verb set — the signature of a set that
earned itself.

## 6. Weakest points (for red team)

1. **Emit vs Invoke may not be kind-level.** "Effect escapes to the world" is arguably an
   *attribute* (`openWorldHint`) hung on Invoke, not a fifth kind. Collapsing gives a
   tighter 4-kind set (Observe/Converge/Accumulate/Invoke). Defense: the caller consequence
   (irreversible double-send) is severe and deserves node-level legibility — but this is a
   judgment call, and a critic could reasonably demote Emit to an annotation.

2. **The set is mostly not type-inferable — the framing's power is exactly what TS can't
   see.** Converge/Accumulate/Emit differ by idempotency and locus, which the type system
   does not encode; only Observe is sometimes inferable. So this framing leans hardest on
   *authoring*, cutting against the "inferable where obvious" goal. A framing whose central
   distinctions are structurally invisible to the truth-source (inferred types) is paying a
   real tax. (Deepest weakness.)

3. **Observe↔GET is a near-1:1** that invites the "secretly HTTP" suspicion even though it
   survives on merit; a skeptic will keep poking here.
