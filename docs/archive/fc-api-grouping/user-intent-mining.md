# User-intent mining — FC API / grouping / projection

Recovered from two Claude Code transcripts, rigorously separating the USER's own
stated intent from assistant proposals. Every item is tagged:

- **[USER-ASSERTED]** — the user stated it as their own want/decision.
- **[USER-REJECTED]** — the user shot down a proposal; the rejected thing is recorded.
- **[ASSISTANT-PROPOSED, not user-confirmed]** — assistant floated it; the user did NOT
  clearly bless it. These are the over-blessing risk.

## Sources chosen (and why)

- **PREVIOUS session** (produced `docs/design/invariants.md`):
  `/home/me/.claude/projects/-home-me-git-rhizone-fractal/8031088c-c845-47c2-a611-cdfcd145d30d.jsonl`
  — 1159 lines, 30 "invariants" / 155 "projection" / 36 "carrier" / 17 "grouping" hits;
  76 real user turns. This is the long design conversation; matches the known candidate
  path and the handoff's own back-reference.
- **CURRENT session** (carrier-grouping / entropy / taste / local-vs-global):
  `/home/me/.claude/projects/-home-me-git-rhizone-fractal/49e4e3c5-3b51-4b22-a83e-f568d300627c.jsonl`
  — 346 lines but 75 "grouping" / 17 "flat sprawl" / 10 "entropy" hits (only file with
  entropy or flat-sprawl); today's mtime; the session driving this mining request.
- Rejected `d1a89ecc…` (8.3 MB, 606 "projection" but 0 entropy/grouping/flat-sprawl —
  an earlier different arc) and `1bb5bc0c…` (tiny).

Method: parsed JSONL, kept only genuine user text turns (dropped tool_result turns,
task-notifications, system-reminders, slash-command envelopes), and captured the
assistant tail each user turn reacts to so accept/reject/refine is legible.

---

## THEME 1 — Design method: first principles, honor what I already said, no retrofit

- **[USER-ASSERTED]** Design from first principles, do not retrofit HTTP.
  > "we should be designing from first principles, not 'oh yeah let's bullshit our way
  > into a HTTP api'. have you even reasoned what a good api should look like?" (CURRENT)

- **[USER-ASSERTED]** The design is over-blessing — the exact premise of this mining.
  > "i think the design is blessing way more than it should" (CURRENT)

- **[USER-ASSERTED]** My stated intent is already on record; mine it rather than re-derive.
  > "i'm pretty sure i've sent a lot of messages both this session and last (you should
  > have the uuid for the jsonl) about what i'm looking for. go mine?" (CURRENT)
  > "haven't i said... a nonzero amount of things this conversation? give a subagent this
  > session's uuid/jsonl log to mine it?" (PREVIOUS)
  > "why do i keep having to spoonfeed/correct you. this is kinda useless" (PREVIOUS)
  > "i mean, how the fuck is the most expensive frontier model on the market getting so
  > many things wrong" (PREVIOUS)

- **[USER-ASSERTED]** "data over code" is NOT a forcing principle — it was poisoning context.
  > "the data over code thing is kinda poisoning context" (PREVIOUS)
  > "'compiled from descriptors' was me forcing the data-over-code throughline" — user
  told assistant to strip it from CLAUDE.md. (PREVIOUS)

---

## THEME 2 — Core mental model: it's just a FUNCTION

- **[USER-ASSERTED]** The handler is a plain `T => U`; the transform is arbitrary `T => U`;
  composition is the base.
  > "the handler itself should be T => U, the transform should be arbitrary T => U as
  > well. and then: `(.) :: (a -> b) -> (b -> c) -> (a -> c)`..." (PREVIOUS)
  > "correction: it's just a fucking FUNCTION" (PREVIOUS)

- **[USER-ASSERTED]** Kleisli/applicative are derived and strictly less general — separate
  combinator.
  > "separate combinator? obviously? i don't see how kleisli arrows aren't OBJECTIVELY
  > strictly less general" (PREVIOUS)

- **[USER-REJECTED]** `view`/`review` (bidirectional) — overkill, poisons composability.
  > "wait, why do we need `review`." / "i think view + review is overkill and poisons the
  > architectural purity of composability" (PREVIOUS)

- **[USER-ASSERTED]** The library's purpose: transform/manipulate arbitrary data into
  arbitrary other data; HTTP is dogfood + a genuinely-wanted product.
  > "we want to build a library/framework to transform/manipulate arbitrary data into
  > arbitrary other data" (PREVIOUS)
  > "with e.g. 'a HTTP router' as both dogfood material (proving that a generic core will
  > work) and something we genuinely want beyond sota dx/mental model on and sota perf"
  > (PREVIOUS)

- **[USER-ASSERTED]** API-first; the interfaces themselves must be clean; router is a
  shallow shim.
  > "honestly i still am a huge fan of api first for lack of a better word. the
  > interface(s) themselves should be clean. the router itself imo should be a more or less
  > shallow shim that reconciles the input with the statically typed api function" (PREVIOUS)

- **[USER-ASSERTED, open]** "is it *too* general?" — the user raised the worry themselves;
  never resolved.
  > "is it *too* general?" (PREVIOUS)

---

## THEME 3 — Handler shape: typed named-params options, provenance-blind, no HTTP leak

- **[USER-ASSERTED]** The handler input is a strongly-typed named-params options object,
  NOT a wire `body`.
  > "`body` is the wrong input for the options object. it should be a strongly typed 'named
  > params' style object. putting `body` there is... what the fuck" (PREVIOUS)
  > "building up a typed 'context'/'options'/'parameters' object as *the* input to an
  > arbitrary api function" (PREVIOUS)

- **[USER-ASSERTED]** Inputs are already fully typed; there is no "raw"; coercion is
  impossible-by-construction via the type system.
  > "strings *are* already typed" / "input is not 'untyped', it is fully typed" (PREVIOUS)
  > "coercion is an implementation detail, and this should be impossible by construction of
  > the combined struct via, y'know, the type system" (PREVIOUS)

- **[USER-ASSERTED]** HTTP source-markers and capabilities never reach the api function;
  caps sit in the input shape and pass through untouched.
  > "and NEITHER of these should pass through to the api function" (PREVIOUS)
  > "do caps not just... sit in the input shape and pass through untouched? am i confused?"
  > (PREVIOUS)

- **[USER-REJECTED]** `InputSource` enum (`json|query|params|merge|session|none`) and
  path/body id-collision machinery — HTTP-shaped leak.
  > "disturbingly http shaped" (PREVIOUS)
  > "who. the fuck. said fields are implicitly added. it. won't. fucking. typecheck."
  > (PREVIOUS)

- **[USER-ASSERTED]** `Request => T` and `U => Response` are plain functions, OPTIONALLY
  handwritten, otherwise projected — not declarative markers.
  > "in manually authored HTTP trees, Request => T are OPTIONALLY handwritten as REGULAR
  > FUNCTIONS because OBVIOUSLY" (PREVIOUS)
  > "f(Request) => Response. values are FUCKING PROJECTED (Request => T; U => Response)"
  > (PREVIOUS)
  > "E -> HTTP Response is another plain function that the http package should probably
  > export for convenience" (PREVIOUS)

---

## THEME 4 — Single source of truth: inferred types + JSDoc

- **[USER-ASSERTED]** Truth = inferred TS types + JSDoc (constraints AND descriptions). No
  reified runtime meta / schema-as-second-source.
  > "why not? types are readable by typescript api" (PREVIOUS)
  > "the fuck? hello? jsdoc says hi?" / "not to mention fucking *descriptions* are also
  > readable from jsdoc..." (PREVIOUS)
  > "didn't we agree to use inferred types?" (PREVIOUS)

- **[USER-REJECTED]** A reified tree / reified runtime meta as the source.
  > "who the fuck said reified tree" (PREVIOUS)

- **[USER-REJECTED, self-abandoned]** The `{ closure, metadata }` struct — the user
  floated it, then dropped it once codegen-from-types covered it.
  > "{ closure, metadata } pretty sure this was already solved." (PREVIOUS) — later
  superseded by "types are readable by typescript api".

- **[USER-ASSERTED]** Codegen "just works for whatever's obvious"; user writes as much or as
  little as they want; output as good as handwritten structurally AND semantically.
  > "the point of codegen is to just work for whatever's obvious" (PREVIOUS)
  > "user can write as much or as little as they want" (PREVIOUS)
  > "it should be as good as a handwritten one structurally and semantically" (PREVIOUS)
  > "codegen'd is more consistent = better" (PREVIOUS)

- Prior art the user named: `~/git/the consumer app` (consumer + codegen prior art) and
  `~/git/rhizone/server-less` (existing projection system). NOTE: the consumer app is private —
  the user said NEVER write its name anywhere permanent.

---

## THEME 5 — The tree: one explicit nested tree; abstract vs HTTP; addressing vs behavior

- **[USER-ASSERTED]** One explicit nested routing tree with record combinators; scattered
  flat declarations make routing intractable.
  > "when routing is just multiple unrelated declarations then the mental model of how
  > routing slices is fucking intractable" (PREVIOUS)
  > "what happened to the fucking routing combinators" (PREVIOUS)

- **[USER-REJECTED]** `tree([])`, opaque `leaf`, bound-variable / colon path-DSL.
  > "what the fuck is tree([]). why not path({ classes: })" (PREVIOUS)
  > "what the fuck is leaf. a) slop b) monolithic c) what the FUCK is q d) where is the
  > fucking input -> options object transformation" (PREVIOUS)
  > "how. the fuck. would bound variables even work. a fucking string \"id\" is fucking
  > fine" (PREVIOUS)

- **[USER-ASSERTED]** There is an abstract (protocol-agnostic) tree AND an HTTP tree; the
  tree stays explicit but not protocol-specific; decisions may not cut a clean axis.
  > "there's the http tree and the agnostic tree, no? haven't i (AND you!??!) made that
  > incredibly clear multiple times?" (PREVIOUS)
  > "the tree (if any) should still be explicit, no? just not a protocol specific one."
  > (PREVIOUS)
  > "keep in mind that decisions may not cut across a clean axis" (PREVIOUS)

- **[USER-ASSERTED, CURRENT — the sharpest new cut]** The tree is ADDRESSING; behavior holds
  no address. You don't need to know where something is to know what it does.
  > "> But a leaf is no longer self-contained: to know what POST publish is, you walk up to
  > find you're under /users/:id/documents/:did — that's not really an issue. you don't
  > need to know where it is to know what it does" (CURRENT)
  (Reacting to assistant's "tree holds structure and references behavior; behavior holds no
  address" — the user confirmed the addressing/behavior split via this reply.)

- **[USER-ASSERTED]** `methods({})` is an HTTP construct and must still exist for dispatch;
  bespoke verb/path = explicit overrides.
  > "how the fuck is methods() not a fucking HTTP construct" / "where the FUCK did
  > methods({}) go" (PREVIOUS)

- **[USER-ASSERTED, open]** User does NOT necessarily want hand-authoring trees, but thinks
  it's near-mandatory for a general library; the consumer using HTTP for internal routing
  shouldn't care about exact shape — codegen'd is more consistent.
  > "for hand-authoring trees. i don't necessarily want hand-authoring trees, but the way i
  > see it, it's kinda mandatory for our library to be generally useful... the consumer...
  > shouldn't give a rat's ass what specific shape the api looks like" (PREVIOUS)

- **[USER-ASSERTED, not-against]** A higher-level 'global'/magic/metadata/decorator layer is
  acceptable as an even-higher level (undesigned).
  > "a 'global'/magic/metadata/decorator based solution as an even higher level i am *not*
  > against" (PREVIOUS)

- **[USER-ASSERTED, open pain]** One tree auto-deriving both HTTP and CLI is unreconciled:
  HTTP paths/headers vs CLI subcommands/env vars have no 1:1 mapping. The user visibly
  strained here but stated the real want underneath.
  > "what? but http path/headers vs cli subcommands/env vars etc have no 1:1 mapping"
  > "no single tree that auto-derives both HTTP and CLI — kms" (PREVIOUS)
  > "what if i have a way i want to structure my api but dont fucking care how it's
  > translated save for the fact that it should be as good as a handwritten one
  > structurally and semantically" (PREVIOUS)

---

## THEME 6 — Grouping to avoid a flat sprawl of free functions

- **[USER-ASSERTED]** The real question: how are APIs grouped to avoid a flat sprawl of free
  functions? (User posed this as THE first-principles question.)
  > "how are apis normally grouped to avoid a flat sprawl of free functions?" (CURRENT)

- **[USER-ASSERTED]** Subject/carrier-type grouping is a good hunch the user LIKES — but it
  is NOT the be-all/end-all, because operations average ~1.5 subject types (cross-cutting).
  > "subject type isn't a bad hunch and i like it, but it's not necessary the be-all and
  > end-all when you have 100 slices each with 1.5 subject types on average" (CURRENT)

- **[USER-REJECTED]** Grouping by full signature.
  > "grouping based on full signature sounnds weird :/" (CURRENT)
  > "a) what are the algebra and type theory lenses b) why are they the only two possible
  > lenses (if they even are)" (CURRENT) — user pushed back on the framing being complete.

- **[ASSISTANT-PROPOSED, not user-confirmed]** Everything in
  `docs/artifacts/fc-api-grouping/` — the "carrier whose invariant the op preserves"
  principle, the type-theory / survey / algebra "three lenses," the reify-a-relation rule
  for cross-cutting ops, `carrier<T>()` with `.make/.op/.read`, the capability/functor
  second tier, design v1/v2, the five red-team attacks, the entropy-partition. The user
  never blessed any of this as their decision. They liked the *subject-type hunch*, called
  full-signature grouping "weird," and demanded "single design, whatever you think is
  right, plus adversarial rounds" — i.e. authorized the *process*, not any conclusion.
  > "still performative. single design, whatever you think is right, plus adversarial
  > rounds" (CURRENT)

---

## THEME 7 — Verb / method model

- **[USER-ASSERTED]** POST = a method call / invocation. `new T()` / "create" is NOT a
  method call. Reject `create → POST /collection`.
  > "i am FUCKING SAYING post is a METHOD CALL and `new T()` is NOT A FUCKING METHOD CALL"
  > (PREVIOUS)
  > "why the FUCK does create translate to POST /todos" (PREVIOUS)

- **[USER-ASSERTED, lean]** For creation, user leans explicit `POST /the/:path/here/new`.
  > "POST is method call not fucking create... i'd probably prefer POST /the/:path/here/new"
  > (PREVIOUS)

- **[ASSISTANT-PROPOSED, not user-confirmed — flagged in invariants.md already]** The
  `read→GET / replace→PUT / remove→DELETE / partial→PATCH` access-verb table. Assistant-
  invented; the user never confirmed it. invariants.md already marks this CRITICAL/
  unconfirmed — that flag is correct and must stay.

---

## THEME 8 — Projection, taste, entropy, overrides (dominant CURRENT-session theme)

This is where the user says the design over-reached in BOTH directions, and states their
actual position.

- **[USER-ASSERTED]** There is NO single objective-correct API shape; a brainless program
  cannot divine user taste. (Rejecting the assistant's "enrich the vocabulary until
  overrides vanish / projection is total" swing.)
  > "you say that like there is an objective correct answer for every api shape and the
  > overrides are there for... what exactly? to be wrong?" (CURRENT)
  > "completely wrong. if there is more than one correct choice, why would a brainless
  > program be able to perfectly divine user taste" (CURRENT)

- **[USER-ASSERTED]** The definition carries a FINITE amount of Shannon entropy — residual
  taste bits exist and someone must pay them; you cannot enrich types until they vanish.
  > "*the definition has a finite amount of shannon entropy" (CURRENT)
  (Correcting the assistant's "the choice isn't information latent in the definition that a
  richer type could expose.")

- **[USER-ASSERTED]** Unaided projection working for the obvious case is a DEALBREAKER to
  lose — the user cited their own `server-less` as existence proof it can be done.
  > "> Or is losing unaided-projection a dealbreaker — imo yes. our own server-less does
  > it, iirc, although it has somewhat different goals" (CURRENT)

- **The reconciled user position (both quotes above are the same person):** projection must
  work UNAIDED with zero config for the obvious/common case (defaults), AND overrides are
  the legitimate, first-class channel for irreducible taste over genuinely underdetermined
  choices — overrides are NOT a "concession," NOT "being wrong," and must never contradict
  domain truth. "Just works for whatever's obvious" (Theme 4) + "finite entropy / can't
  divine taste" = defaults for the common, cheap overrides for the residual.

- **[ASSISTANT-PROPOSED, not user-confirmed]** "Downgrade unaided projection to a thin
  additive op-keyed projection manifest, conceding 'generated unaided'" (v2 residual #3) —
  the user REJECTED this framing as a dealbreaker.
- **[ASSISTANT-PROPOSED, not user-confirmed]** "Enrich the operation-kind vocabulary until
  overrides vanish / projection is total" — the user called this "completely wrong."
- **[ASSISTANT-PROPOSED, not user-confirmed]** "The core is CLI-shaped, not protocol-neutral
  — one tree drives CLI faithfully but cannot drive HTTP unaided." Presented by the
  assistant as proven; the user did NOT accept it (their server-less counter-cite and the
  taste framing cut against it). Treat as an open claim, not settled.
- **[ASSISTANT-PROPOSED, not user-confirmed]** The truth-locked-vs-taste-defaulted partition
  and the `H(dim | def)` per-dimension entropy-coding program — the user said "perhaps" to
  the entropy framing, then immediately pivoted to the local/global tension (Theme 9). A
  soft "perhaps," not a blessing of the partition.

---

## THEME 9 — Local vs global understandability (the user's own stated tension)

- **[USER-ASSERTED]** The mental model has two desiderata in tension (user's own words):
  > "there is a tension between the things i want, right? in terms of mental model:
  > - local understandability (each endpoint should be self-contained)
  > - global/large-scale/architectural understandability (the branching structure of the
  >   route tree should be understandable without having to look at every api function AND
  >   manually reconciling the shared prefixes)" (CURRENT)

- **[USER-ASSERTED]** "Self-contained endpoint" does NOT mean the leaf knows its address —
  behavior is understandable without its location (see Theme 5). This partially dissolves
  the tension: local = know what it does; global = the tree's branching structure is legible
  without reading every function or hand-reconciling shared prefixes.
  > "you don't need to know where it is to know what it does" (CURRENT)

- **[ASSISTANT-PROPOSED, not user-confirmed]** "Tree is canonical; local self-containment is
  a projected hover/doc view (inline the context on demand)" — the assistant's lean. The
  user did not explicitly bless the projected-view resolution; they reframed
  self-containment as behavior-without-address instead.

---

## THEME 10 — Explicit dealbreakers (in the user's words)

1. Losing UNAIDED projection for the obvious case. > "imo yes" it's a dealbreaker. (CURRENT)
2. Any claim that a program can divine the single correct API shape / that overrides mean
   "being wrong." > "completely wrong." (CURRENT)
3. HTTP shape leaking into the handler/options (`body`, `verb`, `InputSource`, source
   markers). > "disturbingly http shaped"; "and NEITHER of these should pass through."
4. Treating input as raw/untyped needing validation. > "strings *are* already typed."
5. A reified runtime meta/schema tree as a second source. > "who the fuck said reified tree."
6. `view`/`review`, Kleisli-as-base. > "overkill and poisons... composability."
7. Scattered flat route declarations / `tree([])` / opaque `leaf` / bound variables.
8. `create → POST` and arbitrary name→verb tables. > "POST is a METHOD CALL."
9. "data over code" as a forcing principle. > "kinda poisoning context."
10. The empty-call codegen shape / HTTP ceremony on the leaf. > "looks like a hack... horrible
    dx"; "query/body/header on the leaf. UGH. what the FUCK."

---

## Cross-check: what in `invariants.md` is over-blessed or incomplete

`invariants.md` is, to its credit, mostly verbatim-sourced and it already flags the
`read→GET/...` table as assistant-invented. The residual over-blessing risks:

- **The `read→GET/replace→PUT/remove→DELETE/partial→PATCH` table** — correctly flagged
  CRITICAL/assistant-invented. Keep the flag; do not let it drift into "settled."
- **`NoInfer<T>` + a root anchor is the inference mechanism** — the user asserted `NoInfer`
  ("NoInfer<T> says hello…") but the "+ root anchor" and the acceptance of a specific
  mechanism are more assistant than user; the user only rejected the *rationale* ("says who,
  exactly?"). Mild over-statement of settledness.
- **INCOMPLETENESS is the bigger problem.** invariants.md predates the CURRENT session and
  therefore MISSES the user's deepest stated desiderata, all [USER-ASSERTED]:
  (1) taste is irreducible — finite Shannon entropy in the definition; projection cannot be
  total and overrides are first-class, not a concession;
  (2) unaided projection for the obvious case is a dealbreaker to lose (server-less exists);
  (3) grouping to avoid a flat sprawl of free functions is the core first-principles
  question; subject/carrier-type is a liked hunch defeated at ~1.5 subjects/op; full-signature
  grouping is "weird";
  (4) the local-vs-global understandability tension, and the addressing-vs-behavior cut
  ("you don't need to know where it is to know what it does").
- **The entire `fc-api-grouping/` carrier apparatus** (carrier<T>, .make/.op/.read,
  reify-the-relation, capability/functor tiers, entropy partition, CLI-shaped-core claim) is
  [ASSISTANT-PROPOSED, not user-confirmed]. The user authorized the *method* ("single design
  + adversarial rounds"), liked the *subject-type hunch*, and rejected specific swings —
  none of the concrete apparatus is a user decision. It must NOT be promoted into
  invariants.md as settled.
</content>
</invoke>
