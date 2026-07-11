# Primary vs Incidental Effects — re-analysis of the op corpus

Re-analysis of `induced-taxonomy-v2.md` to test one hypothesis: the prior pass concluded
"~77% of ops are multi-effect, therefore operations have no single 'kind'." A critique says
this conflates **an op having multiple effects** with **an op having no dominant effect**.
CRUD is verb-heavy precisely because most ops have one primary effect (what the caller
intends) plus incidental infrastructure (outbox events, cache busts, audit logs, read-before-
write, shadow-git commits). This document classifies each op by its **primary intended
effect** vs its **incidental effects**, then reports which view the data supports.

**Corpus-count note.** The v2 header table sums to 173, but the the consumer app "CLI / HTTP / worker"
section actually lists **36** bullets, not 31. The true count of listed ops is **178**. All
percentages below are over 178; using 173 shifts nothing material.

## Method

For each op: (1) name the PRIMARY effect — the single effect that is the reason the op exists
(what the caller asked for), judged from name+doc+described behavior; (2) treat as INCIDENTAL
the consequences that service the primary (deferred domain-event/outbox emission mirroring a
state change, cache read/write, audit/telemetry logging, secondary denormalized-view
re-stamps, read-before-write loads); (3) if two-or-more co-equal intended effects exist with
no dominant, mark AMBIGUOUS. Primary effects were bucketed into a set that emerged from the
data: **read · create · update-in-place · delete · replace · pure-compute · model-invocation ·
external-invoke** (external-invoke = gateway/subprocess/agent-spawn/daemon/HTTP/notify-send;
model-invocation split out because it is ~11% of the corpus and categorically distinct).

---

## THE KEY NUMBER

| | count | % of 178 |
|---|---|---|
| **CLEAR dominant primary effect** | **174** | **97.8%** |
| **Genuinely AMBIGUOUS (no dominant)** | **4** | **2.2%** |

Strict reading (only true dispatch-multiplexers, dropping the one borderline orchestration)
gives **3 ambiguous (1.7%)**. Either way: **~98% of ops have a single dominant intended
effect.** The 77% multi-effect number is real but measures effect-*atoms*, not intents.

---

## Primary-effect distribution (over 178)

| Primary kind | count | % |
|---|---|---|
| external-invoke (gateway / subprocess / agent-spawn / daemon / notify-send) | 40 | 22.5% |
| create | 39 | 21.9% |
| read (query / view / diagnostic / get) | 34 | 19.1% |
| update-in-place | 30 | 16.9% |
| model-invocation (LLM is the deliverable) | 19 | 10.7% |
| replace (wipe+recreate / self-replace / rebuild-overwrite / migrate) | 5 | 2.8% |
| delete | 4 | 2.2% |
| pure-compute (no I/O) | 3 | 1.7% |
| **AMBIGUOUS** | 4 | 2.2% |

Grouping: the CRUD-shaped persistence primaries (read+create+update+delete+replace) = **112
(63%)**. The procedure-invocation primaries (external-invoke + model) = **59 (33%)**. Pure
compute = 3. So even a plain verb model captures the *primary* of ~63% directly and the rest
as "invoke external procedure X" — a single verb each.

**Multi-effect (77%) vs multi-primary (2.2%).** These are different measurements. Most ops
that carry 2+ effect atoms carry exactly one *intended* effect plus infrastructure. Example:
a the consumer app "guarded state transition + announce" op reads (load, infra), mutates (PRIMARY),
and publishes a domain event (incidental outbox mirror) — three atoms, one intent.

---

## Per-architecture breakdown — the corpus-skew test

Does multi-effect / ambiguity concentrate in event-sourced + AI apps, leaving CLI / plain
ops clean single-primary? **The data says NO** — ambiguity does not track multi-effect at all.

| Architecture | ops | clear | ambiguous | % clear | ~multi-effect (v2) |
|---|---|---|---|---|---|
| event-sourced (the consumer app) | 99 | 97 | 2 | 98.0% | ~70% |
| AI-heavy (curilo) | 26 | 24 | 2 | 92.3% | ~88% |
| CLI (normalize/reincarnate/rescribe/myenv) | 35 | 35 | 0 | 100% | normalize 100% |
| daemon/pipeline (interconnect/chub) | 10 | 10 | 0 | 100% | high |
| plain HTTP (cch) | 8 | 8 | 0 | 100% | mixed |

**The killer datum: `normalize` is 100% multi-effect (v2: "0 single-effect ops") yet 100%
single-PRIMARY and 0% ambiguous.** Every normalize op reads source + does a subprocess/write/
shadow-git commit — many atoms — but each has one obvious dominant verb (grep=read,
edit.replace=update, history.prune=delete, tool:clippy=external-invoke, facts.rebuild=
replace). Multi-effect there is pure infrastructure. This alone refutes "multi-effect ⇒
no single kind."

Ambiguity is marginally highest in AI-heavy curilo (7.7%), but **not because of LLM-ness** —
it is driven by two endpoints that dispatch on an `action` param (a routing concern), and 12
of curilo's 13 LLM ops have a crystal-clear primary (model-invocation). The event-sourced app
is 98% clean. So the original 77% was **a corpus-fact about incidental outbox/cache/read
atoms, not evidence about intents**, and it was not a skew artifact either — the skew
hypothesis (that ambiguity hides in event-sourced/AI) is also not supported; genuine ambiguity
is a flat ~0–8% everywhere and is about *param/event dispatch*, not app architecture.

---

## The genuinely-ambiguous ops (no dominant effect), quoted

These are the real hard cases for a verb model. All four are **dispatch multiplexers** — one
entry point whose primary effect is selected at runtime by an event type or `action` param,
so no single static verb fits. None is ambiguous because of "too many effects."

1. **handleGoCardlessWebhook** (the consumer app) — "verifies webhook HMAC, **dispatches per event**:
   correlates payment->invoice + publishes PaymentSettled/Failed, updates mandate, invokes
   notify callback." An event router; the primary is whichever branch the inbound event
   selects (correlate-payment vs update-mandate vs notify). No static dominant.
   `packages/payments/src/application/v1/handleGoCardlessWebhook.ts:52`

2. **grant-parental-consent** (curilo) — "token-authed: **lookup mode returns status; grant
   mode flips status to granted** and nulls token." Read in one mode, update in the other,
   chosen by `action`. Cannot be assigned one verb.
   `supabase/functions/grant-parental-consent/index.ts:6`

3. **run-spot-check** (curilo) — "quiz engine: **get_questions randomizes; submit_answers
   grades** MC by key + open-ended via Gemini, logs skill_check events, invalidates cache."
   `get_questions` is read; `submit_answers` is model+create. Two co-equal intents behind one
   `action`. `supabase/functions/run-spot-check/index.ts:30`

4. **handleInboundTurn** (the consumer app, *borderline*) — "orchestrates one inbound conversational
   turn: resolve/idle-close conversation, idempotency-replay, append customer turn, compose
   LLM stance reply (or escalate), record assistant turn, flip mode, emit reply events." Five
   effects. Arguably dominant = produce the reply (model-invocation), which is why it is the
   weakest of the four; under a strict reading it is CLEAR (model) and the count drops to 3.
   `packages/knowledge/src/application/v1/handleInboundTurn.ts:125`

### The v2 flagship refutation, re-read: `award-progress` is actually CLEAN

The v2 doc's single strongest evidence for "no single kind" was:

> "The clearest refutation is a single handler exhibiting the whole create/mutate/delete
> quartet at once (`award-progress`: reads+creates+mutates+deletes)."

Under primary/incidental analysis this collapses to one intent. Doc: "on lesson completion:
derives score, **logs event, increments skill thread, invalidates dashboard caches**."
- reads = load session (infrastructure)
- creates = *logs event* (incidental audit)
- **mutates = increments the skill thread (PRIMARY — the reason the op exists)**
- deletes = *invalidates dashboard caches* (incidental cache-bust)

Strip the audit-log and cache-invalidation incidentals and the "whole write quartet" is a
single `update-in-place`. `award-progress` is the best demonstration that the v2 conclusion
conflated effect-atoms with intents. `supabase/functions/award-progress/index.ts:12`

Other v2 "hard cases" resolve the same way: `ic:Recv` ("a read that advances the cursor") is
read + incidental cursor bookkeeping → primary read; `generate-learning-plan` (wipe+insert)
and `context.migrate` (create+delete) are each one `replace` intent, not two co-equal effects.

---

## Honest verdict

**"An op has a dominant primary kind (+ an incidental effect vector)" holds for the data —
for ~97.8% of ops (174/178; ~98% even on the strict-vs-generous boundary).** The
no-single-kind view does **not** stand as stated. The v2 pass measured effect-atom
multiplicity (real: ~77% carry 2+ atoms) and mislabeled it as intent multiplicity. When you
separate intent from infrastructure, the corpus is overwhelmingly single-primary, and the
primaries fall into a small verb-like set led by external-invoke/create/read/update — i.e.
CRUD-plus-invoke, exactly as the critique predicted.

Two honest caveats that preserve part of the v2 finding:
- The **incidental effect vector is real and load-bearing** — deferred domain-event/outbox
  emission is the most common incidental in the consumer app and has no CRUD slot. The right model is
  **primary verb + incidental effect set**, not "pick one atom and discard the rest." So v2
  was right that a bare single-atom label is lossy; it was wrong that there is *no* dominant.
- The genuine ambiguity that exists (~2%) is not caused by effect count or by app
  architecture — it is caused by **endpoints that dispatch on a param/event type**. That is a
  routing/interface concern (one URL doing two jobs), addressable by splitting the endpoint,
  not evidence against a verb model.

**Bottom line: the critique is supported.** Operations have a dominant primary effect (a verb)
plus an incidental-effect vector; multi-effect ≠ no-single-kind; and the 77% figure was a
fact about infrastructure atoms, not a refutation of verbs — and not a corpus-skew artifact
either, since single-primary dominance holds uniformly across every architecture (100% in the
CLI / daemon / plain-HTTP tiers, 98% event-sourced, 92% AI-heavy).
