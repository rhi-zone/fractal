# FFI-IR architecture options: generalizing beyond one language pair

> Design-options artifact, not a recommendation. Per this project's disposition,
> every architectural fork below is laid out as named options with real costs — none
> is favored, none is picked. This document extends
> [`bindings-generation-survey.md`](./bindings-generation-survey.md) (§1-§5, its 7
> open questions Q1-Q7) with two new pieces of prior art researched specifically for
> the general-IR question, and organizes the combined evidence into concrete
> architectural forks. It does not rewrite or contradict that survey — Q1-Q7 there
> are still open and still valid; this document's forks are a finer-grained
> decomposition of the same territory, informed by the two tools below.
>
> Sourcing convention (same as the parent survey): **[VERIFIED-EXTERNAL: source,
> fetched 2026-08-03]** marks a fact this session directly confirmed by fetching the
> cited page's content. **[UNVERIFIED]** marks background knowledge or inference not
> independently confirmed this session. Nothing here should be read as settled
> without its marker.

---

## 0. Trigger for this document

The user's framing (verbatim): "really we'd want to design and build something like
type-ir for ffi *in general*, not just `* -> js`, but also at least `* -> c`,
possibly (?) also `* -> wasm/wit`." Since the parent survey was written, a concrete
data point was added to the codebase:
[VERIFIED-LOCAL] `packages/type-ir/src/wasm-bindgen.ts` (455 lines, read in full) is
a real, working type-ir → Rust `#[wasm_bindgen]` codegen projector. It is narrow by
explicit design: plain functions, structs, and fieldless/string-discriminant enums
only — `union`, `tuple`, `map`, `intersection`, and `method`/`interface` (receiver
types) all throw rather than degrade, because (per the file's own header comment,
`wasm-bindgen.ts:1-51`) wasm-bindgen's ABI is "a hard wall, not a best-effort data
shape" and a silent lossy degrade there would be a *compiled, wrong* output, not
just an imprecise one — a materially different risk than the lossy degrades every
other projector in the package uses for pure-data formats. This is the concrete
"how far does one narrow, single-target-pair FFI projector get you, and where does
it hit a wall" data point the rest of this document reasons from.

---

## 1. New prior art: cbindgen (Rust → C headers)

[VERIFIED-EXTERNAL: github.com/mozilla/cbindgen/blob/main/docs.md, fetched
2026-08-03]

- **Layout is opt-in and explicit, not inferred.** "Most things in Rust don't have a
  guaranteed layout by default" — every type crossing into the generated C header
  needs an explicit `#[repr(C)]` (or `#[repr(u8)]`/`#[repr(align(N))]`/
  `#[repr(packed)]`) annotation on the Rust side. cbindgen does not infer a C-safe
  layout for a type that doesn't already declare one; it reads the annotation and
  projects it. This is a *stronger* precondition than type-ir's projectors
  currently have anywhere: type-ir projects from IR shape alone, with no concept of
  "does this shape have a stable ABI layout at all."
- **Enums: two representation strategies, chosen by the Rust source, not the
  generator.** Fieldless enums project to a `#[repr(u8/u16/...)]` integer-backed C
  enum directly. Enums *with* per-variant data use RFC 2195's tagged-union
  strategy — a C struct pairing a discriminant tag with a union of per-variant
  payload structs — and the exact layout differs between `#[repr(C)]` (simpler,
  less compact) and `#[repr(u8)]` (more compact) source annotations. The
  significant fact for an FFI-IR: **cbindgen does not invent a tagged-union
  encoding on its own — it projects whichever one the Rust source already
  committed to via its repr attribute.** An IR-driven equivalent would need either
  (a) the author to pick a tagged-union strategy explicitly per type (mirroring the
  repr annotation), or (b) the IR/generator to own that choice, which is a new
  design decision cbindgen itself does not make for you.
- **Generics: monomorphization is required and manual, not automatic per
  instantiation.** Generic structs/enums/unions/aliases are supported by cbindgen,
  but "cbindgen cannot support generic functions, as they do not actually have a
  single defined symbol" — there is no monomorphized-per-callsite C symbol the way
  Rust's own compiler would produce one per generic instantiation used. C mode
  requires explicit name-mangled monomorphization (i.e., the crate author writes
  concrete-typed wrapper functions/type aliases per instantiation they want
  exposed); C++ mode can use actual templates instead. This directly confirms the
  parent survey's Q-adjacent observation (bindings-generation-survey.md §1, "no
  parametric-type node... genericity is pushed to the host language") generalizes
  to C specifically: a C target categorically cannot receive a generic function
  symbol, full stop, independent of what an IR chooses to model.
- **Opaque-pointer pattern is the documented answer for anything without
  guaranteed layout.** "If the type doesn't have a guaranteed layout, only a
  forward declaration will be emitted. This may be fine if the type is intended to
  be passed around opaquely and by reference." This is architecturally close to
  UniFFI's opaque-handle strategy (parent survey §3) but resolved at the
  header-generation level rather than via a generated constructor/destructor glue
  layer — cbindgen emits `typedef struct Foo Foo;` with no body, and the C caller
  is expected to only ever hold a `Foo*` and call Rust-exported functions to
  operate on it. cbindgen itself does not generate the free function; that's left
  to the crate author to write and export like any other function.
- **Explicitly unsupported, by design:** anonymous tuples (no layout guarantee),
  wide/fat pointers (`&dyn Trait`, `&[T]` — ABI not guaranteed), zero-sized types
  as function arguments (conflicting C/Rust/C++ definitions of a zero-size
  parameter), and `PhantomData`/`PhantomPinned`/`()` (these "evaporate" — usable
  only as struct fields that vanish from the emitted layout, not as standalone
  types).
- **Ownership/memory-management convention: minimal, and mostly unaddressed by
  the tool itself.** [VERIFIED-EXTERNAL, same source] The docs give no systematic
  "who frees what" convention — slice decomposition into pointer+length
  (`slice::from_raw_parts`) is shown as a mechanical technique, not part of a
  documented ownership protocol. The implicit assumption the docs convey is that
  Rust manages its own lifetimes internally and C only ever receives POD data or
  opaque pointers back into Rust-owned memory — but this is this document's own
  reading of the material, not a claim the docs state in so many words; flagged as
  **[UNVERIFIED interpretation]** rather than a directly-quoted fact.

**What this means for an FFI-IR targeting C:** C is the target that most forces an
explicit answer to "does this type have a stable ABI layout," because unlike
JS (wasm-bindgen, via `JsValue` indirection) or WIT (via the Canonical ABI, see §2),
C has no fallback opaque-value primitive built into the language itself — cbindgen's
opaque-pointer pattern is a *convention* the generator and hand-written glue code
maintain, not a language-level safety net. An IR node for "this type's C
representation is: (a) a `#[repr(C)]`-equivalent inline layout, or (b) an opaque
handle behind a pointer, with free/dup functions declared explicitly" is the
minimum a C target needs that type-ir's current `TypeKinds` has no analogue for at
all.

---

## 2. New prior art: WASM Component Model / WIT

[VERIFIED-EXTERNAL: component-model.bytecodealliance.org/design/wit.html, fetched
2026-08-03]

WIT is architecturally the closest existing precedent to "one IR, many language
backends" for the boundary-crossing problem specifically — it is not tied to any
one source language the way cbindgen (Rust-only) and wasm-bindgen (Rust-only) are.

- **Type vocabulary:** 12 primitives (`bool`, `s8..s64`, `u8..u64`, `f32`/`f64`,
  `char`, `string`), plus compound/user-defined types: `list<T>` (ordered
  sequence), `option<T>`, `result<T, E>` (with sugar for omitted success/error
  arms: `result<u32>`, `result<_, u32>`, bare `result`), `tuple<...>`
  (fixed-length, positional), `record` (named fields, C-struct-like), `variant`
  (discriminated union with optional per-case payload — this is WIT's tagged-union
  construct, directly comparable to type-ir's `union` kind and to cbindgen's
  RFC-2195 enum-with-data encoding above), `enum` (a `variant` restricted to
  no-payload cases — i.e. WIT treats "fieldless enum" as a strict special case of
  "tagged union," not a separate primitive, which is a notably different
  factoring from type-ir's own separate `enum`/`union` kinds), and `flags` (named
  booleans, bitfield-encoded).
- **`resource` — a first-class ownership primitive, not a metadata annotation.**
  "A resource is a handle to some entity that exists outside of the component...
  entities that can't or shouldn't be copied: entities that should be passed by
  reference rather than by value." Ownership is expressed *in the type position
  itself*, not as a side annotation: an unqualified resource name in a signature
  means an **owned handle** (ownership transfers across the call), while
  `borrow<resource-name>` explicitly means a **borrowed handle**, valid only for
  the duration of that call. Resources expose behavior only through
  methods/constructors/static functions declared on them — they cannot be plain
  data structures. This is a materially different design point from every option
  the parent survey's Q1 lays out (bindings-generation-survey.md §4, Q1 a/b/c):
  WIT's answer is neither "don't model ownership" (a) nor "an open metadata-bag
  annotation" (b) nor exactly "a separate parallel IR" (c) — it's **a distinct type
  *constructor*, `resource`, with owned-vs-borrowed as a call-site type
  qualifier**, which is a fourth shape the parent survey's Q1 didn't enumerate.
- **Async is a first-class function qualifier, with two dedicated compound types
  for streaming data.** Functions may be declared `async` (`handle: async
  func(...) -> result<response, error-code>;`), signaling the call may suspend;
  bindings generators are expected to emit the target language's native async
  idiom (Rust `async fn`, JS `Promise`-returning function). Separately, `stream<T>`
  (values delivered incrementally as available) and `future<T>` (a single
  typed value arriving later, "functioning like JavaScript Promises") are both
  distinct compound type constructors, paired for WASI 0.3. This gives WIT
  **two separate answers at two separate axes** to what the parent survey's Q3
  flagged as entirely unresearched: async-the-call-qualifier is orthogonal to
  future/stream-the-data-type, and WIT keeps them as two different constructs
  rather than collapsing async-call-boundary semantics into a data-shape kind the
  way type-ir's own `stream` kind currently only models the data-shape half
  (bindings-generation-survey.md §1, "stream... models an in-language async
  iterable's data shape... not how an async call... is dispatched").
- **Errors are modeled as ordinary data (`result<T, E>`), not a distinct
  boundary-crossing construct.** There is no separate "exception" or "trap"
  primitive in the type vocabulary surfaced by this fetch; a fallible function
  simply returns `result<T, E>` and each target language's bindings generator maps
  that onto its own idiom (this fetch did not surface the specific per-language
  mapping table, so which idiom — e.g. does the JS binding throw, or return a
  discriminated object — is **[UNVERIFIED, not confirmed this fetch]**).
- **Composition units — `interface`, `world`, `package` — are a separate layer
  above the type vocabulary,** roughly analogous to type-ir's own
  `TypeRefDocument`/`defs` layering (parent survey §1, `index.ts:297-305`) but
  richer: an `interface` groups named types+functions; a `world` declares a
  component's contract via `import`/`export` and can `include` another world's
  imports/exports; a `package` namespaces interfaces/worlds across files with
  optional versioning (`package ns:name@version;`). This is architecturally
  closer to a service/module system than to type-ir's flatter `defs` map.
- **The Canonical ABI** (named but not detailed in this fetch — surfaced only as:
  "a standard binary encoding so any language can produce and consume component
  types without custom serialization," per the WebSearch summary, **not
  independently confirmed against primary spec text this session** — flagged
  UNVERIFIED at the mechanism level) is WIT's answer to "how does a value actually
  cross the boundary in memory," analogous to what cbindgen's `#[repr(C)]`
  requirement and wasm-bindgen's `JsValue` table both are for their respective
  targets, but standardized once across every WIT-targeting language rather than
  bespoke per generator. This fetch did not go deep enough into the Canonical ABI
  spec itself to report its mechanics with confidence — a follow-up read of
  `component-model/design/mvp/CanonicalABI.md` directly would be needed before
  treating any Canonical ABI claim beyond the one quoted above as verified.

**Why this is the most directly relevant precedent in the survey so far:** WIT is
the only one of the four tools surveyed (uniffi, wasm-bindgen, diplomat — parent
survey §3 — plus cbindgen and WIT here) that was *designed from the start* as a
multi-language, source-language-agnostic interface IR rather than a
Rust-source-to-N-targets generator. It is the one piece of prior art that answers
"what does a general boundary-crossing IR's type vocabulary look like" with an
actual shipped, specified answer, rather than a single tool's internal
implementation choice.

---

## 3. Cross-referencing all five tools against the parent survey's open axes

| Axis | cbindgen (C) | WIT | uniffi (parent §3) | wasm-bindgen (parent §3 + `wasm-bindgen.ts`) | diplomat (parent §3) |
|---|---|---|---|---|---|
| Ownership | opaque pointer + hand-written free fn; no in-tool convention **[VERIFIED, partial]** | `resource` type + `borrow<T>` qualifier, first-class **[VERIFIED]** | opaque handle + generated destructor **[UNVERIFIED]** | `JsValue` index-table indirection **[VERIFIED, partial]** | "borrow-safety" named as a goal, mechanism unconfirmed **[UNVERIFIED]** |
| Enums-with-data | tagged union, strategy fixed by source `#[repr(...)]` **[VERIFIED]** | `variant` (payload-bearing), `enum` = payload-free special case **[VERIFIED]** | not confirmed this session | THROWS — out of scope, no dynamic-union mapping attempted **[VERIFIED-LOCAL, `wasm-bindgen.ts:172-175`]** | not confirmed this session |
| Generics | monomorphize manually per instantiation; no generic functions at all **[VERIFIED]** | no generics in the fetched type vocabulary **[not addressed in this fetch — absence, not confirmed exclusion]** | not confirmed this session | not modeled; type-ir itself has no generic node (parent §1) | not confirmed this session |
| Async | not applicable (C has no async calling convention) | `async` function qualifier + `stream<T>`/`future<T>` as separate data types **[VERIFIED]** | not confirmed this session | not confirmed this session (parent §3 flags this explicitly unresolved) | not confirmed this session |
| Errors | not modeled — C convention (error code / out-param) left to author | `result<T, E>` as ordinary data; per-language idiom mapping unconfirmed **[VERIFIED type, UNVERIFIED mapping]** | `Result<T,E>` → native exception **[UNVERIFIED]** | not confirmed this session | not confirmed this session |
| Layout precondition | explicit `#[repr(C)]` required per type, no inference **[VERIFIED]** | Canonical ABI, standardized once — mechanism not confirmed this session **[UNVERIFIED mechanism]** | n/a (handle-based) | `JsValue` sidesteps in-memory layout entirely for non-POD | n/a |

Observation this table supports (not new evidence, a synthesis of the rows above):
**every one of the five tools reaches essentially the same fork** — a type either
has a portable in-memory layout that can be described structurally (cbindgen's
`#[repr(C)]` structs, WIT's records/variants via Canonical ABI, wasm-bindgen's
`Copy` structs), or it doesn't, and gets handled via an opaque handle/pointer/index
convention instead (cbindgen's forward-declared opaque pointer, WIT's `resource`,
wasm-bindgen's `JsValue` table, uniffi's opaque handle). This two-way split
recurring independently across five tools with no shared lineage is the strongest
single piece of cross-tool evidence in either survey document for "an FFI-IR needs
at least this one binary distinction, no matter which targets it serves" — though
whether that observation should shape the IR's *node vocabulary* (a `layoutKind:
"inline" | "opaque"` field, or equivalent) or stay purely a target-projector
concern is still an open fork, addressed as Fork D below.

---

## 4. Architectural forks

Each fork lists options with costs; none is picked.

### Fork A — Where does an FFI-IR live relative to type-ir?

- **A1. Extend type-ir's existing metadata bag.** New `meta` keys
  (`meta.ownership`, `meta.layoutKind`, `meta.abiTarget`, ...) following the
  `nullable`/`readonly` convention-not-contract precedent
  (parent survey §4 Q1-b, `index.ts:135-172`). *Cost:* zero new package/repo
  surface, reuses the exact mechanism 118 existing projectors already read. *Cost
  against:* parent survey §4 Q1-b already names the core risk — an incorrect
  ownership/layout value here is a memory-safety bug in generated C/Rust output,
  not a wrong-shape bug, and "conventions, not contracts" (no IR-level
  enforcement) was designed for exactly the class of annotation where the failure
  mode is "wrong shape," not "undefined behavior." None of cbindgen/WIT/uniffi
  resolve this via an open author-supplied annotation surface — cbindgen reads a
  Rust-level `#[repr(...)]` attribute (itself compiler-checked, not a free-text
  convention), and WIT makes ownership a distinct *type constructor*
  (`resource`/`borrow<T>`), not a metadata flag on an existing type. Both real
  precedents point away from "loose annotation," which is new evidence this
  option's cost section in the parent survey didn't have.
- **A2. A separate `ffi-ir` package that references type-ir `TypeRef`s for the
  data-shape portion and adds its own boundary-semantics nodes.** Mirrors parent
  survey §4 Q1-c, now informed by WIT: WIT itself effectively *is* this
  option relative to a hypothetical "pure data shape IR" — its `record`/`variant`
  types are data-shape (type-ir already has near-equivalents: `object`, `union`),
  while `resource`, `borrow<T>`, `async` function qualifiers, and
  `stream`/`future` are boundary-semantics constructs layered on top, with clean
  separation between the two groups in the spec itself. *Cost:* cleanest
  separation (type-ir's 118 existing projectors see zero risk of
  boundary-semantics leakage), and now has a real, shipped multi-language
  precedent for the split being viable rather than just plausible. *Cost against:*
  still a wholly new package to design/build/maintain; also raises a concrete
  sub-question A2 didn't have before this research — does the new package
  **re-derive** type-ir's `object`/`union`/`enum` kinds as its own `record`/
  `variant` nodes (WIT's actual factoring — note WIT's `enum` is a `variant`
  special case, whereas type-ir keeps `enum`/`union` as siblings, so a faithful
  reference-not-reinvent approach isn't a 1:1 structural match), or does it
  literally embed type-ir `TypeRef`s as boundary-node fields and add ownership
  metadata on the *reference*, not the type? This is a genuine open sub-fork this
  document surfaces but does not resolve.
- **A3. New `TypeKinds` entries inside type-ir itself** (e.g. a `resource` kind, a
  `callback` kind distinct from `function`), following the "hierarchy via
  subtyping" precedent (parent survey §2) used for all of type-ir's existing
  kinds. *Cost:* if boundary semantics genuinely are just more type-shape
  variation (which WIT's own factoring — `resource` living in the same type
  grammar as `record`/`variant` — suggests is a defensible position, not a
  stretch), this keeps everything in one IR with one kind-extension mechanism,
  and every existing data-shape projector's `unknown`/degrade-fallback pattern
  already knows how to safely ignore a kind it doesn't recognize. *Cost against:*
  couples type-ir's stability (currently: pure data shape, consumed by ~120
  projectors with no compiled-output correctness risk) to a concern where a
  wrong answer is a memory-safety bug, and every one of type-ir's 120 existing
  projectors would need to explicitly decide "ignore `resource`/`callback` kinds"
  rather than the new kinds being invisible-by-construction the way A2's separate
  package would be.

> **User input (2026-08-03):** Not fully decided, but leaning toward ffi-ir as a
> separate package depending on type-ir (referencing its TypeRefs for data-shape),
> reasoning: "modules are not really types" -- i.e. FFI-relevant concepts like
> modules/interfaces don't belong crammed into type-ir's own type-shape vocabulary.
> This is a lean, not a final decision.

### Fork B — Shared boundary IR + N backend projectors, vs. per-pair IRs?

- **B1. One shared "boundary IR," N target projectors** (JS, C, WIT-native, and
  in principle any future target), mirroring type-ir's own "one IR, ~120
  projectors" architecture exactly. *Cost:* preserves the core value proposition
  the parent survey's Q2-a explicitly names as being forfeited by
  per-pair-baked-ABI approaches ("ABI-baked-into-projector means a new projector
  per language *pair*, not per language... grows combinatorially"). *Cost
  against:* per §3's table, the five real tools surveyed each solve the ownership
  question with genuinely different mechanisms (opaque pointer vs. `resource`
  type vs. `JsValue` table vs. generated destructor) — a shared IR node has to be
  abstract enough to *specialize* into all of these per target, which is exactly
  the design difficulty the parent survey's Q1/Q2 already flagged as unresolved,
  now with concrete confirmation (not just inference) that the mechanisms really
  do differ structurally, not just in naming.
- **B2. WIT itself as the shared boundary IR** — i.e., don't invent a new IR
  vocabulary at all; adopt WIT's actual type grammar (`record`/`variant`/`enum`/
  `resource`/`flags`/…) as fractal's boundary IR, and write projectors *from* WIT
  (or from type-ir + a thin WIT-shaped boundary layer) *to* JS, C, and WIT text
  itself (a WIT emission projector is nearly free once the IR already speaks WIT's
  grammar). *Cost:* WIT is a real, versioned, externally-maintained spec with its
  own tooling ecosystem (Canonical ABI, `wit-bindgen`, WASI) — adopting it avoids
  reinventing the resource/ownership primitive that this section's research
  suggests is genuinely hard to get right from scratch, and any WIT-native target
  becomes near-zero-cost. *Cost against:* couples fractal's boundary-IR design to
  an external spec fractal doesn't control, whose evolution (WIT is explicitly
  still evolving — WASI 0.3 async/stream/future support was cited in this
  session's search results as a current-year development, not a settled feature)
  is outside this project's control; also, C and JS are not WASM/Component-Model
  targets at all — projecting WIT's `resource`/`borrow<T>` model onto a C ABI or a
  JS/wasm-bindgen boundary is itself unproven work this document has no
  prior-art confirmation for (WIT's own bindings generators target source
  languages *compiling to* WASM components, not arbitrary non-WASM ABIs like
  cbindgen's plain C).
- **B3. Per-pair IRs, no shared boundary layer** — a JS-boundary IR, a
  C-boundary IR, and (if pursued) a WIT emission path, each independent,
  informed by shared research (this document plus the parent survey) but not by
  shared code/schema. *Cost:* matches the observed pattern the parent survey's §3
  closing observation already named ("every tool that does more than
  data-shape-only picks its own fixed strategy... rather than exposing a
  general-purpose IR surface") — lowest design risk, ships incrementally, and the
  existing `wasm-bindgen.ts` projector is already exactly this shape (a
  self-contained target-specific converter, per its own file header comment,
  "each projector file in this package is self-contained"). *Cost against:*
  explicitly forfeits the "one IR, many projectors" value proposition for the
  bindings case — three (or more) independent boundary-semantics vocabularies to
  design and maintain instead of one, with no cross-target consistency guarantee
  and combinatorial growth if a fourth target (e.g. JNI/Kotlin, per uniffi's
  scope) is added later.

> **User input (2026-08-03):** Not decided. WIT is worth investigating seriously
> as prior art since a lot of thought went into it, but fractal may have
> different goals than the Component Model does -- needs a deeper comparison
> before deciding, not just the surface-level type-vocabulary summary already in
> the doc.

### Fork C — How does ownership/lifetime get modeled generally enough for C, JS, and WIT?

- **C1. Binary layout-kind split, IR-level:** every boundary type carries (in
  metadata, a new kind, or a dedicated field, per Fork A's resolution) one of
  exactly two states — `inline` (portable value layout: crosses by copy, no
  ownership transfer semantics needed at the IR level) or `opaque`
  (crosses by handle: ownership transfer/borrow *must* be specified). This is
  directly motivated by §3's cross-tool observation that all five surveyed tools
  independently converge on this exact two-way split. *Cost:* has real
  convergent-evidence backing (not a guess) and is the smallest possible
  ownership vocabulary that's still non-trivial. *Cost against:* WIT's actual
  `resource` design is richer than a binary flag — it distinguishes owned vs.
  `borrow<T>` *per call site*, not per type (the same resource type can be
  passed owned in one signature and borrowed in another), so a type-level
  `layoutKind` flag alone under-models WIT's own precedent; would need the
  borrowed/owned distinction to live on the *reference* (parameter/return
  position), not the type declaration, adding a second axis beyond the simple
  binary split.
- **C2. Adopt WIT's `resource` + `borrow<T>` model directly** as the general
  vocabulary, then define per-target lowering rules: C lowers `resource` to
  cbindgen's opaque-pointer-plus-explicit-free-function pattern (§1), JS lowers
  it to something wasm-bindgen-shaped (`JsValue`-table indirection or a class
  wrapping an opaque handle — the existing `wasm-bindgen.ts` projector doesn't yet
  have a `resource`-equivalent kind to lower from, so this is new work, not a
  refactor of existing handlers), and WIT itself lowers to a no-op (already
  native). *Cost:* reuses a real, externally-vetted ownership primitive instead of
  inventing one, and gives C and JS lowering rules a principled single source
  (the `resource`/`borrow` distinction) instead of two separately-invented
  conventions. *Cost against:* per Fork B2's cost, WIT's `resource` was designed
  for the Component Model's own Canonical ABI and dynamic-linking model; whether
  its owned/borrowed semantics survive translation to a plain C ABI's
  compile-time-only linking model (no host runtime enforcing borrow duration the
  way a WASM component host might) is unconfirmed — C's caller can trivially hold
  a borrowed pointer past the call's return with nothing to stop it, which is a
  real gap WIT's own model may not directly close for a non-WASM target.
- **C3. No general ownership model — ownership is entirely a per-target-projector
  concern**, informed by the same research but not unified in the IR (this is
  Fork A/B's "don't model it" option specialized to ownership specifically, same
  as parent survey Q1-a). *Cost:* cheapest, avoids over-fitting a single ownership
  vocabulary to three targets whose real mechanisms (per §3's table) genuinely
  differ. *Cost against:* forfeits any cross-target ownership-correctness
  checking at the IR level — an author could describe a type as freely
  copyable when only one of the three targets can actually treat it that way, and
  the IR has no way to flag the mismatch before a target-specific codegen throws
  (or worse, silently produces unsound output, which is exactly the risk
  `wasm-bindgen.ts`'s throw-not-degrade design (§0) was built to avoid for its one
  target).

> **User input (2026-08-03):** Needs more information before any decision --
> explicitly said "need more info," not ready to choose between the named options
> yet.

### Fork D — What's shared across JS/C/WIT vs. genuinely target-specific?

Not a 2-4-option fork in the same shape as A-C — this is a classification
question the research above gives partial, not complete, evidence for. Laid out
as three buckets rather than options, since "how much goes in each bucket" is
itself contestable and downstream of Forks A-C:

- **Plausibly shared** (recurs structurally across all three, even if named
  differently): the data-shape primitives type-ir already has close analogues
  for (records/objects, tagged unions with payload, fieldless enums, lists,
  strings, numerics) — WIT's `record`/`variant`/`enum`/`list` line up closely
  enough with type-ir's `object`/`union`/`enum`/`array` that this bucket is
  probably a thin adapter, not new modeling; and the binary
  inline-layout-vs-opaque-handle split (§3's cross-tool observation) — three
  independent tools reaching the same fork is reasonably strong shared-primitive
  evidence, whichever of Fork C's options ultimately encodes it.
- **Plausibly target-specific, resists forcing into one model:** C's requirement
  that *every* crossed type have an explicit, source-declared layout
  (`#[repr(C)]-equivalent) with no fallback opaque-value primitive at the
  language level (§1) — C literally cannot receive "any value" the way JS's
  `JsValue` or WIT's Canonical ABI implicitly can, so an IR node meaning
  "opaque/unknown, figure it out at the boundary" (type-ir's own `unknown` kind,
  which `wasm-bindgen.ts` maps straight to `JsValue`, per `wasm-bindgen.ts:139`)
  has no honest C equivalent — it would have to be an error, not a degrade, for a
  C target specifically. Async calling convention is a second strong
  candidate: WIT has a first-class `async` qualifier plus dedicated
  `stream`/`future` types (§2); C has no language-level async calling convention
  at all (callback-based or poll-based conventions are a library/generator
  choice, not something C-the-ABI expresses); JS has `Promise` natively. Forcing
  one shared "async" IR construct across a target that has no async primitive
  (C) and two that do but via different mechanisms (native `Promise` vs. WIT's
  `async`+`stream`/`future` pairing) is a real risk of the shared construct being
  either C-target-inapplicable or a lowest-common-denominator that loses WIT's
  stream/future distinction.
- **Genuinely unresolved by this session's research (neither bucket, needs its
  own pass):** error propagation's per-target idiom mapping (WIT's `result<T,E>`
  → target-language mapping was not confirmed by this fetch, §2), and callback
  semantics (parent survey Q5, still open — this document's research did not add
  new evidence here; WIT's model doesn't obviously have a "raw callback function
  pointer" concept distinct from `resource`+methods, which may mean callbacks
  fold into Fork C's resource question, or may not — unconfirmed either way).

> **User input (2026-08-03):** User's own framing, treated as likely correct and
> worth recording as the working assumption: the full IR vocabulary is shared
> across all targets, but not every target has to support every construct --
> individual target projectors can support a subset and reject/error on the rest,
> same pattern already used by wasm-bindgen.ts today (throws on union/map/tuple/
> intersection rather than approximating). Not the same as constructs being
> "target-specific" by design -- it's uniform vocabulary with per-target coverage
> gaps.

### Fork E — Sequencing / build-order options

- **E1. C first.** Most universal target (any language with a C FFI can consume
  it), most constrained (§1's findings — no generics, explicit layout
  requirement, no async, no built-in opaque-value fallback), and per this
  document's Fork D analysis, forces the hardest questions (ownership encoding,
  layout-vs-opaque split) to be answered early rather than deferred, because C
  has no slack to punt on them into a fallback primitive. *Cost:* the payoff (a
  working C target) requires solving the IR's hardest sub-problem first, before
  any generalization has a second target to validate against — real risk of
  over-fitting the IR design to C's specific constraints if built as the sole
  reference target initially.
- **E2. WIT first (or WIT-as-shared-vocabulary, per Fork B2).** Most directly
  relevant prior art of the three (§2's closing point — the only source-language-
  agnostic, purpose-built multi-language boundary IR among everything surveyed
  across both documents) — building against it first means adopting/adapting a
  vetted vocabulary rather than inventing one from a blank page, and a WIT-text
  emission projector may be cheap once the IR already speaks WIT's grammar
  (Fork B2). *Cost:* couples early architecture to an external, still-evolving
  spec (§2's WASI 0.3 async/stream/future note); and building WIT-shaped first
  risks under-testing against C's much harsher constraints (no generics, no
  async, no opaque-value fallback) until later, potentially requiring rework once
  C is actually attempted.
- **E3. Generalize outward from the existing `wasm-bindgen.ts` projector.**
  Lowest-risk incremental path — take the one real, working, narrow-scope
  projector already in the codebase (§0) and its documented failure boundary
  (union/tuple/map/intersection/method/interface all explicitly unsupported,
  `wasm-bindgen.ts:1-51,172-209`) as the concrete list of gaps a general IR would
  need to close for even its *first* target, then widen. *Cost:* grounds the
  design in a real artifact rather than three tools' documentation, but JS/
  wasm-bindgen is arguably the *least* representative of the three targets for
  forcing general questions — its `JsValue` escape hatch (§1's closing
  observation, §3's table) means JS alone under-motivates the ownership/layout
  questions C and WIT both force explicitly; generalizing from it risks carrying
  forward assumptions ("there's always a `JsValue`-shaped fallback") that are
  false for C.

> **User input (2026-08-03):** Decided: build C, JS, and WIT/Component-Model
> target support together / interleaved, not one target fully first then the
> next -- explicit reasoning given: sequencing one target first risks
> overoptimizing the shared IR for that one target's assumptions.

---

## 5. What this document does not do

It does not choose among Forks A-E's options, does not pick a target sequencing,
and does not propose a concrete IR schema. §1 and §2's tool findings are marked
VERIFIED-EXTERNAL only where this session directly fetched and read the cited
page; the Canonical ABI's internal mechanics, WIT's per-language error-mapping
idiom, and callback semantics under any of the surveyed tools remain open
questions this document explicitly flags as needing a further, dedicated research
pass rather than treating silence as an answer. Q1-Q7 in
`bindings-generation-survey.md` remain the governing open-questions list; this
document's Forks A-E sharpen several of them (mainly Q1/Q2) with new prior-art
evidence but do not close any of them.
