# Bindings-generation survey: function-call boundaries beyond data shape

> Research artifact, not a design decision or a recommendation. Per this project's
> disposition, design choices are laid out as tradeoffs for the user to weigh, not
> resolved here. Claims about fractal's own codebase cite `file:line` and were read
> directly (**[VERIFIED-LOCAL]**). Claims about external tools come from web search
> results and general knowledge and are marked **[VERIFIED-EXTERNAL]** when a
> specific fact was directly confirmed by a search result, or **[UNVERIFIED]**
> when it is reported from background knowledge / plausible inference that this
> session did not independently confirm against source/spec text. Nothing in this
> document should be read as settled fact about a tool's internals unless so marked.

---

## 1. What type-ir currently models (the gap, precisely)

Source: `packages/type-ir/src/index.ts` (452 lines, read in full).

**`TypeKinds`** (`index.ts:8-126`) is an open, augmentable interface of *data-shape*
constructors only: `boolean`, `number`, `integer`, `string`, `null`, `void`,
`unknown`, `never`, `object` (`:17`), `instance` (`:35-39`, nominal class identity,
no methods), `array` (`:40`), `stream` (`:41-55`, async sequence), `page` (`:56-69`,
paginated collection), `tuple`, `map`, `union`, `literal`, `enum` (`:74-83`, closed
string-member set), `ref` (`:84`, resolved against a `TypeRefDocument`'s `defs`, see
`:297-305`), `intersection`, `function` (`:93-98`), `method` (`:108-113`, a
`function` subtype for interface members), and `interface` (`:122-125`, a named
bag of `method`-kind members — "the equivalent of Protobuf's `service`," per its own
comment at `:114-115`).

**What's already present that's binding-adjacent:**
- `function`/`method` kinds carry ordered `params: {name, type}[]`, a `returnType`,
  and an optional `thisType` (`:93-98`, `:108-113`) — this is a *call signature*,
  not a binding: no notion of how the call crosses a language boundary.
- `interface` (`:122-126`) models a service/contract surface — closest existing
  analogue to what a bindings IR needs for "the thing exposed across the boundary,"
  but it is nominal/structural only; it has no ABI, ownership, or async-transport
  information.
- The open `meta: Readonly<Record<string, unknown>>` bag (`:130-133`, documented
  conventions at `:135-172`) is the extension point every existing semantic
  refinement (`optional`, `nullable`, `readonly`, `typeName`/`declarationFile`,
  `additionalProperties`) rides on, via declaration merging into `TypeKinds` from
  `src/kinds/*` extension modules (per the file's own header comment, `:1-7`).

**What is absent — confirmed by full read, not inferred:**
- **Ownership/borrowing.** No concept anywhere in `TypeKinds` or `meta`'s documented
  conventions of "who owns this value after the call," "is this borrowed vs. moved,"
  or lifetime relationships between a return value and its inputs.
- **ABI / calling convention.** No representation of how a function is actually
  invoked at the boundary (C ABI extern "C", WASM import/export table, JNI, a
  process/IPC boundary). `function`/`method` describe a *signature*, not a
  *calling convention*.
- **Async transport across the boundary.** `stream` (`:41-55`) models an
  in-language async iterable's *data shape* (the element type), not how an async
  call or callback is dispatched across an FFI boundary (polling, callback
  registration, promise/future bridging, thread-pool marshaling).
- **Error propagation across the boundary.** Nothing models "this call can fail and
  the failure crosses the boundary as X" — no exception-vs-result-vs-error-code
  distinction, no representation of a foreign error type.
- **Callbacks / higher-order boundary functions.** `function` as a *type* can appear
  as a param type (a callback signature), but nothing marks "this callback, once
  passed across the boundary, has calling-convention/lifetime obligations of its own
  (who invokes it, on what thread, how long may it be held)."
- **Generics/monomorphization.** No parametric-type node; type-ir's own
  `docs/design/type-ir-survey.md` SYNTHESIS section notes this is consistent with
  how runtime-validation libraries (Zod/Valibot/TypeBox) handle it — "genericity is
  pushed to the host language," not represented in the IR node vocabulary — but a
  binding generator that must emit monomorphized code per language pair may need
  more than that punt provides.

This is a genuine gap, not a fixable oversight: type-ir's kinds describe *what shape
a value has*, and every one of the missing concepts above is about *what happens at
the moment a value crosses a process/language/runtime boundary* — a different axis
entirely.

---

## 2. Design-philosophy precedent that bears on this (from `docs/design/design-philosophy.md`)

- **"Open metadata bag over fixed schema"** (`design-philosophy.md:15-25`): metadata
  is a plain object with conventional keys; projections read what they recognize,
  ignore the rest; no blessed set of fields. This is the mechanism every existing
  semantic refinement (nullable, optional, readonly, typeName) already rides on —
  and it is the same mechanism a first pass at ownership/ABI annotations *could*
  ride on, if that route were chosen (see §4).
- **"Conventions, not contracts"** (`:27-34`): where the metadata bag has expected
  keys, they are documented conventions, not IR-enforced contracts — "if you violate
  conventions, no guarantees it works." This matters directly for ownership/lifetime
  metadata specifically, because unlike `nullable`/`readonly` (whose worst failure
  mode if wrong is a bad projection), an incorrect ownership annotation in a
  binding generator's output is a memory-safety bug in the generated code, not just
  a wrong shape. Whether the "conventions not contracts" philosophy is safe to
  extend to something that can cause language-boundary UB is itself a scoping
  question, not a foregone conclusion — the philosophy's precedent doesn't disqualify
  it, but it doesn't underwrite it either without a specific answer to "how wrong can
  this data cost you."
- **"Hierarchy via subtyping, not taxonomy"** (`:36-46`) and **"Extensible DU +
  interpreter pattern"** (`:5-13`): both describe how new *type* kinds are meant to
  be added (subtype relationships, augmentable interfaces) — relevant if a bindings
  layer wanted new `TypeKinds` entries (e.g. a `callback` kind distinct from
  `function`) rather than only metadata annotations on existing kinds. This is the
  same open-question axis raised in §4 below (new kinds vs. metadata vs. separate
  layer), not something the philosophy already answers for the *bindings* case
  specifically — the precedent exists for data-shape kinds, and whether the same
  reasoning transfers cleanly to calling-convention/ownership concepts is exactly
  the open question.
- **"Three independent layers"** (`:48-55`) and **"Type projection is separate from
  routing"** (`:65-70`): fractal already treats routing (API structure) and type
  projection (data shape) as independent concerns that share structural patterns but
  operate on different data. A "bindings" concern — which needs *both* a call
  signature (routing-like) *and* ownership/ABI annotations on the types crossing the
  boundary (type-ir-like) — doesn't obviously map onto either existing layer alone;
  this is itself relevant to the "new layer vs. extend existing layer" open question
  in §4.

`docs/design/type-ir-survey.md`'s own scope statement (`type-ir-survey.md:1-11`)
frames type-ir as explicitly a *data-shape* IR — "a superset of all projection
targets" for structural/nominal type constructors. It surveys 12 systems
(JSON Schema, JTD, serde, TypeScript, OCaml, Haskell, protobuf, SQL, GraphQL,
Cap'n Proto/FlatBuffers, Avro, Zod/Valibot/TypeBox) — every one of them a
*data-shape or data-interchange* format. None of the 12 model a function-call
boundary between two running processes/runtimes with distinct ownership models;
the one partial exception the survey itself flags is Cap'n Proto's RPC/interface
methods (`type-ir-survey.md` §10, Cap'n Proto entry, "Interfaces" bullet — noted
there as "out of scope for a data-shape IR" but relevant precedent that one real
system's schema vocabulary spans both data-shape and behavior-signature concerns).
That is the closest existing precedent in fractal's own research trail, and it
stops at RPC method *signatures* — it does not extend to ownership/ABI/lifetime,
which is a strictly different problem from what any of the 12 surveyed systems
solve.

---

## 3. How real-world binding-generation tools model this problem

All of the below is from this session's web search results plus general
background; nothing here was verified against primary spec/source text unless
explicitly marked **[VERIFIED-EXTERNAL: <source>]**. Treat facts not so marked as
best-effort, second-hand reporting.

### typeshare (1Password) — narrow contrast case, data-shape only

**[VERIFIED-EXTERNAL: crates.io / typeshare book search results]** Typeshare
converts Rust struct/enum definitions (marked with a `#[typeshare]` attribute) into
equivalent type declarations in TypeScript, Kotlin, Swift, Scala, and Go. It is
explicitly *not* a function-call-boundary tool — it shares data-shape declarations
only, the same problem type-ir's existing 118 projectors already solve, just with
Rust as the one fixed source language instead of TypeScript. It does not touch
ownership, calling convention, async, or errors at all. Worth naming precisely
because it demarcates the boundary of the *already-solved* problem: typeshare is
functionally close to "type-ir's own projector fleet, inverted (Rust source instead
of TS source, but same data-shape-only scope)," not a precedent for anything in the
harder function-call-boundary problem this survey is about.

### uniffi (Mozilla) — full bindings generator, ownership/errors/async modeled

**[VERIFIED-EXTERNAL: github.com/mozilla/uniffi-rs, firefox-source-docs]** UniFFI
lets Rust code be written once and called from Kotlin, Swift, Python, and Ruby
(with third-party bindings for C# and Go), via Rust's C-compatible FFI layer plus
generated glue in each target language. Used extensively in Firefox mobile/desktop
for functionality shared between Kotlin (Android) and Swift (iOS). The interface is
described either in a dedicated Interface Definition Language file (`.udl`) or via
Rust proc-macros — notably an IDL *separate from* the source-of-truth type
declarations is one of its two supported authoring paths, the other being
attribute-macro annotation directly on Rust source (closer to type-ir's own
TS-extraction model).

What it must model beyond data shape **[UNVERIFIED — not independently confirmed
against the UniFFI book this session, reported from background knowledge]**:
object/interface types with owned-pointer handles across the boundary (a Rust
struct instance held as an opaque handle on the foreign side, with generated
constructor/method/destructor glue managing its lifetime — i.e., ownership is
resolved by the *generator's* runtime convention of "foreign side holds a handle,
Rust retains the actual allocation," not by an ownership annotation the schema
author writes per-type); a `Result<T, E>`-shaped error convention translated to
each target's native error mechanism (exceptions in Kotlin/Swift/Python, not
error codes); and only "a subset of Rust types" is FFI-safe at all (per the search
result) — i.e. UniFFI's answer to the ownership problem is largely to constrain
*what can cross the boundary* rather than to let arbitrary Rust ownership
patterns be expressed and translated.

### wasm-bindgen — Rust↔JS, ownership via JsValue table indirection

**[VERIFIED-EXTERNAL: docs.rs, rustwasm.github.io design docs]** The `#[wasm_bindgen]`
attribute is a procedural macro generating Rust-side shims plus JS-side glue that
translate a Rust type signature into something JS can call. Ownership is handled
via `JsValue`: a JS value doesn't live in Rust memory at all — it lives in an
index table owned by the generated JS glue, and Rust holds only an index into that
table; taking a `JsValue` by value (no `&`) means the Rust side is asserting
ownership/consumption of that table entry. This is a materially different strategy
from UniFFI's opaque-handle-plus-generated-destructor approach: wasm-bindgen
resolves cross-boundary ownership by *indirection through a side table the glue
code manages*, rather than by handing raw ownership across a C ABI boundary
directly. Search results did not surface wasm-bindgen's async/`Promise`↔`Future`
bridging mechanics or its error-propagation convention in enough depth to report
here — **flagged as unverified/incomplete**, not asserted.

### diplomat (rust-diplomat, originated at ICU4X/Google) — unidirectional, borrow-aware

**[VERIFIED-EXTERNAL: github.com/rust-diplomat/diplomat, docs.rs]** Diplomat
generates FFI bindings for calling *into* Rust from C, C++, C#, and
JavaScript/TypeScript — explicitly unidirectional (foreign code calls Rust, not the
reverse), unlike UniFFI/wasm-bindgen which both support bidirectional calling in
their respective pairs. It works by generating `extern "C"` functions, so it is in
principle portable to any language that can bind to C or WASM. One search result
title ("Safe borrowing across FFI with Diplomat") signals that borrow-safety across
the FFI boundary is a named, central design concern of the tool, distinct from
UniFFI's opaque-handle-ownership model — **[UNVERIFIED — this session did not read
the linked design-doc/blog content itself, only the search-result titles/snippets]**,
so the specific mechanism (lifetime annotations surfaced in the IDL? borrow-checked
codegen? a runtime borrow-flag?) is not confirmed here.

### Summary table (fields marked unverified are not independently confirmed this session)

| Tool | Direction | Languages | Ownership model | Error model | Async |
|---|---|---|---|---|---|
| typeshare | Rust → target (data only) | TS, Kotlin, Swift, Scala, Go | N/A (data-shape only) | N/A | N/A |
| uniffi | Rust ↔ target | Kotlin, Swift, Python, Ruby (+3rd-party C#, Go) | opaque handle + generated destructor **[UNVERIFIED]** | `Result<T,E>` → native exception **[UNVERIFIED]** | not confirmed this session |
| wasm-bindgen | Rust ↔ JS | JS/TS only | `JsValue` index-table indirection **[VERIFIED-EXTERNAL, partial]** | not confirmed this session | not confirmed this session |
| diplomat | Rust → target (unidirectional) | C, C++, C#, JS/TS | borrow-safety is a named design goal **[UNVERIFIED, mechanism unconfirmed]** | not confirmed this session | not confirmed this session |

No `flapigen`/`swig`-style tool was researched this session — out of scope of the
searches run; if relevant, it would need its own pass rather than being folded into
this table as an unverified guess.

**Cross-tool observation, held to VERIFIED-EXTERNAL evidence only:** every tool that
does more than typeshare's data-shape-only scope picks its own single language pair
(or a fixed small family — UniFFI's Rust-as-hub-language-to-several) and its own
fixed ownership/error/async strategy baked into the generator, rather than exposing
a general-purpose "describe your ownership model here" IR surface an author fills
in per-type. That is a genuine, observed pattern worth weighing in §4's tradeoffs —
though it is a pattern of two-to-four data points, not a proof that a general IR
surface is unworkable.

---

## 4. Gap analysis — open questions, not a proposed schema

The following are framed as questions with named, costed alternatives — not a
recommendation. Anywhere a question's answer depends on facts only the user has
(target language pairs, tolerance for maintenance surface, appetite for new-repo
scope), that dependency is called out explicitly rather than guessed.

### Q1. Where does ownership/lifetime information live?

- **(a) Don't model it — restrict "bindings" to plain-data function calls only**
  (params/return are pure data-shape types already representable in `TypeKinds`,
  no owned handles, no borrows). *Cost:* cheap, no new IR surface, ships fast —
  but excludes exactly the cases that make cross-language bindings hard in the
  first place (stateful objects, borrowed views, anything beyond call-by-value
  data). Mirrors typeshare's scope, which this survey's own comparison (§3) shows
  is a fundamentally narrower problem than what uniffi/wasm-bindgen/diplomat solve.
- **(b) Add ownership/borrow annotations to type-ir's existing open metadata bag**
  (e.g. `meta.ownership: "owned" | "borrowed" | "shared"`, following the same
  convention-not-contract pattern as `meta.nullable`/`meta.readonly`,
  `index.ts:135-172`). *Cost:* follows established precedent (design-philosophy.md
  §"open metadata bag"), no new IR surface to design from scratch — but as noted in
  §2, an incorrect value here is a memory-safety bug in generated code, not a
  wrong-shape bug; "conventions, not contracts" (no IR-level enforcement) is a
  materially bigger risk for this metadata than it is for `nullable`/`readonly`,
  and every one of the tools surveyed in §3 that handles ownership does so via a
  *generator-owned, fixed strategy* (opaque handles, index-table indirection)
  rather than an author-supplied per-type annotation — none of the surveyed
  precedent actually validates "let the schema author declare ownership freely,"
  which is a live risk for this option specifically, not a neutral unknown.
- **(c) A separate bindings-only IR layered on top of type-ir** (a new document/kind
  that references `TypeRef`s for data shape but carries its own
  ownership/ABI/async/error vocabulary, structurally parallel to how
  `TypeRefDocument`/`defs` layers over bare `TypeRef` today, `index.ts:297-305`).
  *Cost:* cleanest separation of concerns (data-shape stays exactly as stable as it
  is today, zero risk of memory-safety-relevant metadata leaking into the existing
  118 projectors' inputs) — but is a wholly new surface to design, document, and
  maintain, on top of an already-nontrivial existing system, and duplicates
  concepts (a bindings IR still needs "what type is this parameter" — either it
  re-embeds `TypeRef`s, meaning ownership metadata again attaches somewhere, or it
  reinvents data-shape modeling, which would be pure waste).

This question does not have enough information in the current fractal codebase to
answer from precedent alone — the three surveyed tools that solve it (§3) each pick
one fixed strategy per tool rather than exposing a general annotation surface, and
none matches fractal's own "many projectors over one IR" architecture, so there is
no clean prior-art transplant available here.

### Q2. Calling convention / ABI — how is "how this call actually happens" represented?

- **(a) Don't model it — assume the projector-per-language-pair knows its own ABI**
  (e.g. a hypothetical Rust↔Swift projector hardcodes "this means a C ABI extern
  function," the way a specific target's constraints are usually baked into a
  single-purpose tool per §3). *Cost:* cheapest, matches the observed pattern of
  every surveyed tool (each is single-pair or hub-and-spoke, not
  pair-agnostic) — but forfeits type-ir's core value proposition (one IR, many
  projectors) for the bindings case specifically, since ABI-baked-into-projector
  means a new projector per language *pair*, not per language, and the pair count
  grows combinatorially where type-ir's existing data-shape projectors only grow
  linearly (one per target language, any pair of them already interoperates via the
  shared IR).
- **(b) Model ABI as IR-level metadata** (an explicit `meta.callingConvention` or
  similar, naming the boundary mechanism — C ABI, WASM import/export, JNI,
  IPC/RPC). *Cost:* preserves the "one IR, many projectors" value proposition in
  principle — but ABI concerns are deeply target-pair-specific (a Rust↔Kotlin C-ABI
  convention is not the same shape of fact as a Rust↔JS WASM import), so this
  metadata key would likely need to be itself an open, per-pair-extensible
  sub-vocabulary, which is a nontrivial design problem, not a one-line addition.
- **(c) Treat ABI as entirely a projector concern, orthogonal to any IR
  extension** — the projector for a given language pair decides its ABI
  unilaterally from context (target languages named + call shape), no schema
  input at all. *Cost:* zero new IR surface — but removes the schema author's
  ability to express "no, use this specific ABI/strategy here," which several
  real tools' own escape hatches (e.g. UniFFI's dual UDL-file/proc-macro authoring
  paths) suggest is sometimes needed in practice **[the "sometimes needed"
  inference itself is this document's own reasoning, not sourced from a specific
  external fact — flagged as such]**.

### Q3. Async calling convention across the boundary

Type-ir already has `stream` (`index.ts:41-55`) for async *iterables* as a data
shape, but nothing for "this function call itself is asynchronous and the
async-ness must be bridged across the boundary" (JS `Promise` ↔ Rust `Future` ↔
Kotlin `suspend fun` ↔ Swift `async`, each with different threading/executor
assumptions). This session's web search did not surface confirmed detail on how
any of the four surveyed tools solve this (flagged unverified in §3's table) — so
this open question currently has **no confirmed prior art from this survey's
research to weigh options against**, only the observation that it is a real,
separate axis from Q1/Q2 that a bindings IR would need to answer, and that
answering it well likely requires a dedicated research pass (reading UniFFI's async
docs and wasm-bindgen's `Promise` interop docs directly) rather than being folded
into this document's existing evidence.

### Q4. Error propagation across the boundary

Distinct from Q1-Q3: does a failing call surface as a thrown exception, a `Result`
sum-type value, an error code plus out-parameter, or something else, and how is
that translated per target language's idiom? UniFFI's `Result<T,E>` → native
exception convention (§3, flagged unverified) is the one data point surfaced this
session, and it suggests error-propagation may be a comparatively easier problem
than ownership (any language pair broadly has *some* "did this fail" surface,
whereas not every language pair even has borrowing at all) — but this inference is
this document's own reasoning from one unverified data point, not an established
fact, and is flagged accordingly.

### Q5. Callbacks / higher-order boundary functions

Not covered by any option above: a parameter that is itself a `function`-kind
TypeRef (`index.ts:93-98`), once it crosses the boundary, acquires its own
lifetime/threading/re-entrancy obligations (who may call it, from what thread, how
long it may be retained, whether it may itself call back into the original
language). None of Q1-Q4's options address this directly — it may be a
special case of Q1 (ownership of a callback handle) or its own fully separate axis;
this document does not have enough researched evidence to say which, and flags it
as an open sub-question rather than folding it silently into Q1.

### Q6. Which language pairs are actually wanted first?

This cannot be answered by research — it is a scoping decision only the user can
make, and every option under Q1/Q2 above has costs that scale very differently
depending on the answer (a single fixed pair, e.g. Rust↔TypeScript, is a
qualitatively smaller problem than "any pair among N target languages," the way
type-ir's existing data-shape projectors already are pair-agnostic today). This
document deliberately does not guess an answer.

### Q7. Scope: "fractal itself" vs. delegated to a sibling project

`TODO.md:37` (verified read) records the precedent for exactly this kind of
scoping decision: general-purpose non-TypeScript source ingestion was deferred
indefinitely from fractal itself and handed to `rhi-zone/normalize`, a separate,
active, substantial sibling project (3,570+ commits at the time of that decision),
rather than built inside fractal — explicitly because the underlying problem
(tree-sitter-based structural parsing across 98+ languages) was judged to be a
different, harder, and already-being-solved-elsewhere problem than what fractal
itself needs to own. The same shape of question applies here: is
ownership/ABI/calling-convention modeling for cross-language function bindings
(a problem UniFFI, wasm-bindgen, and diplomat each treat as substantial enough to
be its own whole project) something fractal should build as a new layer on
type-ir, or is it — like general-purpose source ingestion — better treated as a
sibling-project concern fractal would *consume* rather than build? The TODO.md
precedent does not answer this question for bindings specifically (it is a
different problem: source-language parsing vs. boundary-crossing semantics), but
it establishes that this project has an existing, recent pattern of drawing that
line deliberately and recording the decision rather than defaulting to "build it
in fractal," which is worth naming explicitly as a live option here, not treating
"build it in fractal" as the only path.

---

## 5. What this document does not do

It does not propose a schema, does not pick among Q1-Q7's options, and does not
recommend a language-pair scope. It surfaces the gap (§1, verified against current
source), the project's own relevant precedent (§2, §4-Q7), and the external
landscape this session was able to research (§3, with unverified claims flagged
inline) as raw material for a scoping conversation the user would need to have
before any design work starts.
