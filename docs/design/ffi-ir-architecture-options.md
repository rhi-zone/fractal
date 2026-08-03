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

> **User input (2026-08-03, confirmed as decided):** Decided: ffi-ir as a
> separate package depending on type-ir (referencing its TypeRefs for the
> data-shape portion), reasoning: "modules are not really types" -- i.e.
> FFI-relevant concepts like modules/interfaces don't belong crammed into
> type-ir's own type-shape vocabulary.

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

#### Fork B follow-up: deeper WIT/Component-Model comparison (2026-08-03)

Additional research session, going past §2's type-vocabulary summary into WIT's
composition model, its design intent, and whether it is actually usable as a
plain-C-ABI-mediating layer. Sources fetched this session:
**[VERIFIED-EXTERNAL: component-model.bytecodealliance.org/design/worlds.html,
/design/wit.html, /design/why-component-model.html,
/language-support/building-a-simple-component/c.html — all fetched 2026-08-03]**,
plus WebSearch results for the Canonical ABI and wit-bindgen's C backend (marked
`[VERIFIED-EXTERNAL, via search snippet]` below where the primary spec page
itself 404'd — `component-model.bytecodealliance.org/advanced/canonical-abi.html`
is the correct current URL per search results but was not itself fetched this
session, so Canonical ABI claims here rest on search-snippet text, not a direct
primary-source read).

**1. Composition model.** A **package** groups interfaces/worlds across files in
one directory, optionally semver-versioned (`package ns:name@1.0.1;`)
**[VERIFIED-EXTERNAL, wit.html]**. An **interface** is a named collection of
types+functions. A **world** is the unit that actually binds a component's
contract: "a world describes the functionality a component provides, and the
functionality it requires in order to work," expressed as `import`/`export`
declarations of interfaces, with composition being the act of connecting one
component's exports to another's (or a host's) imports so "its imports must be
fulfilled, by a host or by other components" **[VERIFIED-EXTERNAL,
worlds.html]**. (The fetch of worlds.html did not surface `include` mechanics
specifically — flagged as not confirmed rather than assumed absent.) This is a
real module/service system, not a flat `defs` map — it answers "what does this
component need and provide," a question type-ir's own `TypeRefDocument`/`defs`
layer does not ask at all (type-ir has no import/export/binding concept, only a
flat namespace of type definitions).

**2. Is WIT a target format or a toolchain's source-of-truth grammar? —
the central question the user asked to resolve.** The spec is explicit about
its own scope: **"WIT isn't a general-purpose programming language and doesn't
define behaviour; it defines only *contracts* between components"**
**[VERIFIED-EXTERNAL, wit.html, direct quote]**. This settles the question in a
specific, narrow way: WIT is neither "a target you'd project into, full stop"
(like OpenAPI) nor "a general shared IR that could sit *underneath* C and JS
projectors the way type-ir sits underneath OpenAPI/protobuf/JSON-Schema
projectors today." It is the **authoring/source format of one specific
ecosystem** — the WASM Component Model — that its own bindings generator
(`wit-bindgen`) reads to emit per-guest-language glue code. Evidence for this
being ecosystem-bound rather than a neutral grammar: the Component Model's own
motivation page frames it as fundamentally WASM-scoped, not a general
cross-language FFI mechanism independent of WASM — "WebAssembly core modules
are already portable across different architectures and operating systems;
components retain these benefits and... add portability across different
programming languages" **[VERIFIED-EXTERNAL, why-component-model.html, direct
quote]** — the value proposition is stated as *built on top of* WASM's
sandboxing and portability, not as a standalone interface-description layer
that happens to also support a WASM backend among others.

Concretely, for fractal's Fork B framing this means: **"WIT as a target
format" (project type-ir's data-shape IR out into a `.wit` file, the way
type-ir already projects into OpenAPI text) is the framing WIT's own
self-description actually supports** — a `.wit` emission projector is a
plausible, bounded addition alongside the other ~120. **"WIT's grammar as
fractal's own internal shared boundary IR" (B2, replacing or sitting beneath
what C and JS projectors both consume) is not well-supported by this
research** — WIT's grammar is not a neutral data-shape+ownership vocabulary
that happens to also serialize to WASM; it *is* the Component Model's contract
language, inseparable in its own docs from WASM portability/sandboxing framing.
Adopting it as fractal's internal IR would mean every C and JS projector reads
an IR whose vocabulary was designed for, and is documented as being for,
components-that-run-on-WASM — a framing neither C nor plain JS/wasm-bindgen
targets share.

**3. Concrete tooling check: does routing C through WIT actually work with
existing tooling? — No, not for a plain C-ABI target.** `wit-bindgen` does have
a C backend, but the worked example
**[VERIFIED-EXTERNAL, building-a-simple-component/c.html]** compiles C source
**to** `wasm32-wasip2` (target triple `wasm32-wasip2-clang`), producing a
`.wasm` binary that is then run via `wasmtime --invoke` or embedded through a
Wasmtime host — i.e. `wit-bindgen`'s "C" output is C source for a **WASM guest
compiled to wasm32**, consumed by a WASM runtime, not a native `.so`/`.a` with
a plain `extern "C"` ABI callable from arbitrary C code the way cbindgen's
output is. This directly confirms the concern already on record in B2's cost-
against paragraph and Fork C2's cost-against paragraph — WIT's Canonical ABI
lowers values into WASM linear memory and its "C" bindings exist to let
wasm32-compiled guest code speak that ABI, not to give a non-WASM C caller a
plain-C-ABI header. A WIT-mediated path to fractal's plain-C-ABI target (the
one §1's cbindgen research describes — arbitrary C callers, no WASM engine
required) would need a hand-written WIT→plain-C-ABI backend built from
scratch; it would gain nothing from `wit-bindgen`'s existing C support, because
that support solves a different problem (WASM-guest C, not native-C-ABI C).

**4. Philosophy alignment/divergence with fractal's own conventions.**
- **Open metadata bag vs. fixed spec:** WIT has no analogue to type-ir's
  `meta: Record<string, unknown>` extension point. Its vocabulary is fixed by
  the spec itself (`record`/`variant`/`resource`/`flags`/...); extensibility
  happens by the *spec evolving* (e.g. WASI 0.3 adding `stream`/`future`, per
  §2 above) not by a downstream consumer attaching arbitrary conventions to
  existing nodes. This is a direct divergence from "open metadata bag over
  fixed schema" — WIT is, structurally, the fixed-schema side of that design
  axis, not the open-bag side.
- **Closed/complete vs. incremental partial support:** nothing in the fetched
  pages suggests a WIT consumer is expected to handle "this construct isn't
  supported, throw" the way `wasm-bindgen.ts` explicitly does for
  union/tuple/map/intersection/method/interface. WIT's own model is that a
  `.wit` file is a complete, closed contract — every construct in it is
  meaningful to every conforming `wit-bindgen` backend (modulo that backend's
  own language-target limitations), not a superset grammar where each backend
  is expected to reject a subset. This is a different shape of "partial
  support" than fractal's per-projector throw-on-unsupported-kind pattern: WIT
  pushes incompleteness to *which backends exist*, not to *which constructs a
  given backend accepts from an otherwise-shared document*.
- **Hierarchy via subtyping vs. fixed vocabulary:** type-ir's kind
  extensibility (new `TypeKinds` entries via declaration merging, ancestor
  fallback for projectors that don't recognize a kind) has no counterpart in
  WIT — there is no ancestor-fallback or subtyping mechanism visible in what
  was fetched; a WIT backend either implements a construct or the spec adds it
  centrally. This reinforces the metadata-bag divergence above: both of
  fractal's two extensibility mechanisms (open metadata, kind-hierarchy
  fallback) are answered differently, or not answered at all, by WIT's design.

**Net finding, stated plainly (not a recommendation):** the evidence gathered
this session supports **WIT functioning far more naturally as one more
target/output format** (a `.wit` emission projector, analogous to fractal's
existing OpenAPI/protobuf/JSON-Schema projectors) **than as a replacement for,
or the shared substrate beneath, fractal's own internal boundary IR.** The
"one shared IR, N projectors" architecture (B1) and "WIT is just another
target" are not in tension with each other — WIT-as-a-target is compatible
with B1's own N-projector shape, it just means WIT is one of the N rather than
the IR itself. B2 specifically (WIT's grammar *as* the shared IR) is the
option this research weighs against most directly, on three independent
grounds: WIT's own stated scope ("only contracts between components," an
ecosystem-bound authoring format, not a neutral shared grammar), the concrete
tooling gap (no existing WIT→plain-C-ABI backend; `wit-bindgen`'s C output is
WASM-guest-only), and the philosophy mismatch (fixed spec + closed-contract
assumption vs. fractal's open-metadata-bag + incremental-partial-support
conventions). None of this forecloses B2 outright — a hand-built
WIT→plain-C-ABI backend is possible, just unproven and not free the way B2's
original cost paragraph's "near-zero-cost" framing for a WIT-native target
assumed — but the user's own instinct going in ("fractal may have different
goals than the Component Model does") is what this deeper pass corroborates,
not just repeats.

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

#### Fork C, deeper pass (2026-08-03) — ownership mechanics confirmed from primary sources

This subsection is the information the user asked for before deciding among C1-C3
above. It does not choose among them; it adds four newly-verified data points (one
correcting a prior [UNVERIFIED] mark) and a representative-case comparison matrix,
then reframes C1-C3 as four named options explicitly cross-checked per target.

**New verified facts, each fetched directly this session:**

1. **cbindgen: confirmed, not just inferred, to give zero ownership guidance.**
   [VERIFIED-EXTERNAL: github.com/mozilla/cbindgen/blob/main/docs.md, searched
   specifically for ownership/free-convention content, 2026-08-03] — the docs
   contain no discussion of who allocates, who frees, or any allocation/free
   convention anywhere; they cover type layout, header config, type mappings, and
   function declarations only. This upgrades §1's earlier `[UNVERIFIED
   interpretation]` mark on the same claim to directly confirmed: cbindgen is
   silent on ownership by design, not by an oversight in this document's earlier
   reading.
2. **uniffi's real mechanism is `Arc`-based reference counting, not opaque-handle +
   destroy** — this **corrects** the parent survey's `[UNVERIFIED]` guess (§3
   there, "opaque handle + generated destructor"). [VERIFIED-EXTERNAL:
   mozilla.github.io/uniffi-rs/latest/types/interfaces.html, fetched 2026-08-03]:
   "UniFFI allocates every object instance on the heap using `Arc`... The foreign
   bindings will typically generate destructors, but regardless of the foreign
   semantics, they always hold an `Arc<>` to the Rust object, so these destructors
   will only drop their reference and may not drop the Rust object." A forgotten
   foreign-side destructor therefore leaks (refcount never reaches zero) rather
   than double-frees or use-after-frees — the `Arc` makes memory-safety violations
   structurally unreachable through normal use, at the cost of deferred/possible
   leaks being the tool's own accepted failure mode.
   For callbacks/closures held across the boundary: [VERIFIED-EXTERNAL:
   mozilla.github.io/uniffi-rs/latest/types/callback_interfaces.html, fetched
   2026-08-03] — UniFFI's newer "foreign traits" mechanism (the legacy "callback
   interfaces" are documented as soft-deprecated in favor of it) also moved from
   `Box<dyn Trait>` to `Arc<dyn Trait>` specifically for this case, i.e. the same
   refcounting answer is reused for callbacks, not a separate mechanism. The docs
   fetched did not spell out what happens if the *foreign* runtime garbage-collects
   its side of a callback while Rust still holds the `Arc<dyn Trait>` handle — this
   specific hazard remains **[UNVERIFIED]**, not found in the fetched pages.
3. **wasm-bindgen does have a zero-copy path, but it is a separate, unsafe escape
   hatch outside the safe struct/fn surface `wasm-bindgen.ts` targets** —
   correcting this document's earlier framing (§0, §3's table) that copying is the
   *only* path. [VERIFIED-EXTERNAL: docs.rs/js-sys, `Uint8Array::view`/
   `view_mut_raw`, fetched 2026-08-03]: `js_sys::Uint8Array::view()` returns a
   typed-array view directly into wasm linear memory with no copy, but its own
   documented safety warning is explicit: "Views into WebAssembly memory are only
   valid so long as the backing buffer isn't resized in JS. Once this function is
   called any future calls to `Box::new` (or malloc of any form) may cause the
   returned value here to be invalidated," and separately, "the returned object is
   disconnected from the input slice's lifetime, so there's no guarantee that the
   data is read at the right time." This is a real borrowed-reference mechanism —
   not hypothetical — but it is `unsafe`, is invalidated by any subsequent Rust-side
   allocation with no compiler or runtime check, and is a different code path
   entirely from the `#[wasm_bindgen(getter_with_clone)]` + `Clone` convention
   `wasm-bindgen.ts` implements (`wasm-bindgen.ts:20-23, 316-321`) — the projector's
   existing behavior is accurately described as "the safe subset of wasm-bindgen
   defaults to copy-only," not "wasm-bindgen itself has no zero-copy option."
4. **WIT's Canonical ABI resource mechanism confirmed: not reference counting — a
   per-instance handle table plus a runtime-checked "lending" discipline that traps
   on violation.** [VERIFIED-EXTERNAL:
   raw.githubusercontent.com/WebAssembly/component-model, `design/mvp/CanonicalABI.md`,
   fetched 2026-08-03]. Each component instance has its own growable handle table
   (`ComponentInstance.handles`); each `ResourceHandle` entry carries an `own` flag
   (true for an owning handle, false for `borrow<T>`) and, for borrowed handles, a
   `borrow_scope` tracking which calling task lowered it. Lifetime safety is
   enforced via a **lend count**, not a reference count: "The `num_lends` field
   maintains a conservative approximation of the number of live handles that were
   lent from this handle" — incremented when a borrow is lifted as a call
   parameter, decremented when that subtask resolves. Critically: "`canon
   resource.drop`... is ensured to be zero when an `own` handle is dropped" — i.e.
   **dropping an owning handle while a live borrow still exists is a runtime trap
   (a caught, safe abort), not undefined behavior.** The actual destruction of the
   underlying resource is still explicit, guest-supplied code triggered by
   `resource.drop` — the ABI's contribution is the bookkeeping and the trap-on-
   violation check around that explicit call, not automatic reclamation the way
   `Arc` provides. This is the one mechanism among the four surveyed tools with a
   runtime-detected safety net for ownership misuse rather than silent UB (C) or a
   leak (uniffi's `Arc`, if never dropped) or an unchecked stale-view read
   (wasm-bindgen's `Uint8Array::view()`).

**Comparison matrix — representative case: a struct/object with one heap-allocated
field (e.g. a `Vec<u8>` byte buffer) crossing each system's boundary:**

| System | Who allocates | Who frees | Copy / move / borrow | Failure mode if consumer gets it wrong |
|---|---|---|---|---|
| C (cbindgen) | Whichever side the author's hand-written convention says (cbindgen prescribes nothing — §1, confirmed above) | Same — author-defined free function, or raw `free()`/`libc::free` if the convention says so | Either a full value copy (struct passed/returned by value into caller-provided storage) or an opaque pointer decomposed via `slice::from_raw_parts` for the buffer; no compiler-checked distinction | **Undetected UB** — double-free, use-after-free, or leak are all possible and cbindgen has no mechanism to catch any of them; the generated header is silent on which failure a given misuse produces |
| uniffi | Rust, via `Arc::new` | Rust's own `Arc` drop glue, triggered by the *last* dropped reference (foreign destructors only decrement) | Shared ownership by reference count — the buffer field is not re-copied per access, it lives inside the `Arc`'d object | **Leak only** (bounded, not UB) — a foreign side that never calls its generated destructor keeps the refcount above zero forever; memory-safety (no UAF/double-free) is preserved by construction |
| wasm-bindgen (safe path, `wasm-bindgen.ts`'s actual behavior) | Rust allocates; JS receives a `Clone`d copy wrapped as a `JsValue`-tracked object | JS's own GC frees the JS-side copy; Rust's original is unaffected/independently dropped | **Full copy**, always, for the `Vec<u8>` field (`getter_with_clone` requires `Clone`) — no sharing | **None, memory-safety-wise** — the two copies are fully independent; cost is duplicated memory/CPU, not a safety bug |
| wasm-bindgen (unsafe path, `Uint8Array::view()`, not used by `wasm-bindgen.ts`) | Rust allocates the buffer once | Rust frees it (or reallocates it) whenever it chooses | **Zero-copy borrow** — a live typed-array view directly into wasm linear memory | **Use-after-free / read of invalid memory**, undetected — any subsequent allocation on the Rust side can silently invalidate the JS-held view with no error at the point of misuse |
| WIT (Canonical ABI `resource`) | Guest/host code, via its own constructor, registered under a handle in the per-instance handle table | Explicit guest/host-supplied destructor, invoked by `canon resource.drop` | **Handle** (`own` = ownership transfer, `borrow<T>` = scoped reference) — the underlying buffer is never copied by the ABI itself, only the handle crosses | **Runtime-detected trap** (safe abort) if an `own` handle is dropped while `num_lends > 0`; the underlying allocation is still whatever the guest's destructor implementation is (a bug there is out of the Canonical ABI's coverage) |

**Named options, reframed with this session's per-target evidence (extends,
does not replace, C1-C3 above — none recommended):**

- **Option 1 — Copy-only, always clone across the boundary** (matches C1's
  "inline" case narrowed to "never opaque"; matches `wasm-bindgen.ts`'s current,
  shipped default). *Cross-checked:* **JS** — proven, this is exactly what
  `wasm-bindgen.ts` does today (`getter_with_clone` + `Clone`, confirmed by direct
  read). **WIT** — a legitimate native subset: non-`resource` types (`record`,
  `list`, etc.) already cross the Canonical ABI by value/copy, so "copy-only" is
  simply "never emit a `resource`," which works but forecloses using WIT's own
  ownership primitive for anything that needs it. **C** — does *not* fully
  eliminate the ownership question the way it appears to: per the matrix above,
  even a pure copy needs an explicit answer for who allocates the copy's backing
  storage and who frees it (cbindgen supplies no such convention, confirmed
  above), so "copy-only" only removes *aliasing/sharing* concerns for C, not the
  alloc/free question itself.
- **Option 2 — Opaque handle + explicit free-function convention** (= C1's
  "opaque" case with a bare free-once discipline, no refcounting or lend-tracking
  on top). *Cross-checked:* **C** — native fit; this is literally cbindgen's own
  documented opaque-pointer pattern (§1). **JS** — does not map cleanly: JS has no
  language-enforced "call free once" idiom (GC-managed), so this would need a
  bolted-on `.free()`/dispose convention with the same "forgotten call" risk
  uniffi's `Arc` approach was specifically built to avoid (per point 2 above,
  uniffi *could* have used bare free-once and chose refcounting instead). **WIT**
  — a strict subset of `resource`'s actual mechanism: WIT already gives an opaque
  handle + explicit free call, *plus* the lend-count/trap safety net this option
  omits (point 4 above) — adopting Option 2 for a WIT target means deliberately
  not using part of what WIT natively offers.
- **Option 3 — Adopt a resource/borrow-shaped model generally** (own-handle +
  `borrow<T>`-qualified reference, *including* WIT's actual enforcement mechanism —
  a generated per-instance handle table with lend-count tracking that traps on
  violation, not just the naming). *Cross-checked:* **WIT** — native, this is its
  own shipped model (point 4). **C** — cbindgen's opaque pointer has no equivalent
  handle-table/lend-count runtime; a C target adopting this option would need
  fractal to generate that bookkeeping itself as new runtime code shipped
  alongside the header, since plain C has no host runtime to enforce it the way a
  Wasm Component host does — real, uncosted implementation work, not a mapping
  onto anything cbindgen or the C ABI already provides. **JS** — likewise no
  native equivalent for the Rust-owns/JS-borrows direction; would need a
  generated handle-table wrapper (e.g. keyed via `Map`/`WeakMap` in the JS glue),
  distinct from wasm-bindgen's own `JsValue` index-table indirection (which
  handles the *opposite* direction — JS-owned values Rust holds indices into) —
  no tool surveyed this session already does this for the Rust-owns direction.
  *Overall cost:* richest safety guarantee (a trap instead of UB or a silent
  leak) but the most net-new implementation work for two of the three targets.
- **Option 4 — Reference counting (`Arc`/`Rc`-shaped shared ownership) as the
  general primitive**, per uniffi's actual (now-corrected) model. *Cross-checked:*
  **uniffi's own domain** — proven at scale (Firefox mobile/desktop). **JS** — a
  genuinely natural fit: JS's `FinalizationRegistry` can decrement a Rust-side
  `Arc` when a JS wrapper object is collected, giving a real (if not yet
  implemented in `wasm-bindgen.ts`, which uses the Clone path instead) path to
  shared rather than copied ownership. **C** — expressible (a manually
  incremented/decremented count field, freed at zero) but, like Option 2, entirely
  author-maintained; cbindgen generates and verifies none of it, so C's failure
  mode stays "leak or worse if the author's hand-written refcount logic has a
  bug," not the structurally-safe "leak only" uniffi gets from a compiler-checked
  `Arc`. **WIT** — a confirmed structural mismatch: point 4 above establishes the
  Canonical ABI's `resource` semantics are explicitly *not* reference counting
  (they're a lend-count-and-trap discipline); mapping refcounting onto a WIT
  target means either ignoring `resource`'s native mechanism or building a
  translation layer between two different safety models — a specific, newly-
  confirmed mismatch this deeper pass surfaces that was not visible from the
  surface-level type-vocabulary read alone.

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
