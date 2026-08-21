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

> **Status update (2026-08-21):** this document was written while `ffi-ir` was
> still "decided but not built" (see the decision record in §Fork A below). It has
> since been built: `packages/ffi-ir/src/` now has real, non-stub implementations
> for target-language projectors covering Rust (`rust-c-abi.ts`,
> `rust-wasm-bindgen.ts`), Python (`python-ctypes.ts`), Ruby (`ruby-ffi.ts`), Java
> (`java-jni.ts`), C# (`csharp-pinvoke.ts`), OCaml (`ocaml-melange.ts`), ReScript
> (`rescript-external.ts`), Gleam (`gleam-external.ts`), TypeScript runtimes
> (`typescript-bun.ts`, `typescript-deno.ts`), and WIT (`wit.ts`), each with a
> corresponding `.test.ts`. The architectural forks discussed below (package
> boundary, shared-vs-per-pair boundary IR, etc.) reflect the design reasoning
> that shaped what got built, but the rest of this document is left as-written —
> it was not swept for tense/status after the fact, so later sections may still
> read as forward-looking about things that now exist.

---

## 0. Trigger for this document

The user's framing (verbatim): "really we'd want to design and build something like
type-ir for ffi _in general_, not just `* -> js`, but also at least `* -> c`,
possibly (?) also `* -> wasm/wit`." Since the parent survey was written, a concrete
data point was added to the codebase:
[VERIFIED-LOCAL] `packages/type-ir/src/rust-wasm-bindgen.ts` (500 lines, read in
full) is
a real, working type-ir → Rust `#[wasm_bindgen]` codegen projector. It is narrow by
explicit design: plain functions, structs, and fieldless/string-discriminant enums
only — `union`, `tuple`, `map`, `intersection`, and `method`/`interface` (receiver
types) all throw rather than degrade, because (per the file's own header comment,
`rust-wasm-bindgen.ts`) wasm-bindgen's ABI is "a hard wall, not a best-effort data
shape" and a silent lossy degrade there would be a _compiled, wrong_ output, not
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
  projects it. This is a _stronger_ precondition than type-ir's projectors
  currently have anywhere: type-ir projects from IR shape alone, with no concept of
  "does this shape have a stable ABI layout at all."
- **Enums: two representation strategies, chosen by the Rust source, not the
  generator.** Fieldless enums project to a `#[repr(u8/u16/...)]` integer-backed C
  enum directly. Enums _with_ per-variant data use RFC 2195's tagged-union
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
opaque-pointer pattern is a _convention_ the generator and hand-written glue code
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
  reference rather than by value." Ownership is expressed _in the type position
  itself_, not as a side annotation: an unqualified resource name in a signature
  means an **owned handle** (ownership transfers across the call), while
  `borrow<resource-name>` explicitly means a **borrowed handle**, valid only for
  the duration of that call. Resources expose behavior only through
  methods/constructors/static functions declared on them — they cannot be plain
  data structures. This is a materially different design point from every option
  the parent survey's Q1 lays out (bindings-generation-survey.md §4, Q1 a/b/c):
  WIT's answer is neither "don't model ownership" (a) nor "an open metadata-bag
  annotation" (b) nor exactly "a separate parallel IR" (c) — it's **a distinct type
  _constructor_, `resource`, with owned-vs-borrowed as a call-site type
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
  `TypeRefDocument`/`defs` layering (parent survey §1, type-ir's `TypeRefDocument`
  type) but
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
survey §3 — plus cbindgen and WIT here) that was _designed from the start_ as a
multi-language, source-language-agnostic interface IR rather than a
Rust-source-to-N-targets generator. It is the one piece of prior art that answers
"what does a general boundary-crossing IR's type vocabulary look like" with an
actual shipped, specified answer, rather than a single tool's internal
implementation choice.

---

## 3. Cross-referencing all five tools against the parent survey's open axes

| Axis                | cbindgen (C)                                                                         | WIT                                                                                                             | uniffi (parent §3)                                    | wasm-bindgen (parent §3 + `rust-wasm-bindgen.ts`)                                                          | diplomat (parent §3)                                                    |
| ------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Ownership           | opaque pointer + hand-written free fn; no in-tool convention **[VERIFIED, partial]** | `resource` type + `borrow<T>` qualifier, first-class **[VERIFIED]**                                             | opaque handle + generated destructor **[UNVERIFIED]** | `JsValue` index-table indirection **[VERIFIED, partial]**                                                 | "borrow-safety" named as a goal, mechanism unconfirmed **[UNVERIFIED]** |
| Enums-with-data     | tagged union, strategy fixed by source `#[repr(...)]` **[VERIFIED]**                 | `variant` (payload-bearing), `enum` = payload-free special case **[VERIFIED]**                                  | not confirmed this session                            | THROWS — out of scope, no dynamic-union mapping attempted **[VERIFIED-LOCAL, `rust-wasm-bindgen.ts`'s `handlers.union` entry]** | not confirmed this session                                              |
| Generics            | monomorphize manually per instantiation; no generic functions at all **[VERIFIED]**  | no generics in the fetched type vocabulary **[not addressed in this fetch — absence, not confirmed exclusion]** | not confirmed this session                            | not modeled; type-ir itself has no generic node (parent §1)                                               | not confirmed this session                                              |
| Async               | not applicable (C has no async calling convention)                                   | `async` function qualifier + `stream<T>`/`future<T>` as separate data types **[VERIFIED]**                      | not confirmed this session                            | not confirmed this session (parent §3 flags this explicitly unresolved)                                   | not confirmed this session                                              |
| Errors              | not modeled — C convention (error code / out-param) left to author                   | `result<T, E>` as ordinary data; per-language idiom mapping unconfirmed **[VERIFIED type, UNVERIFIED mapping]** | `Result<T,E>` → native exception **[UNVERIFIED]**     | not confirmed this session                                                                                | not confirmed this session                                              |
| Layout precondition | explicit `#[repr(C)]` required per type, no inference **[VERIFIED]**                 | Canonical ABI, standardized once — mechanism not confirmed this session **[UNVERIFIED mechanism]**              | n/a (handle-based)                                    | `JsValue` sidesteps in-memory layout entirely for non-POD                                                 | n/a                                                                     |

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
whether that observation should shape the IR's _node vocabulary_ (a `layoutKind:
"inline" | "opaque"` field, or equivalent) or stay purely a target-projector
concern is still an open fork, addressed as Fork D below.

---

## 4. Architectural forks

Each fork lists options with costs; none is picked.

### Fork A — Where does an FFI-IR live relative to type-ir?

- **A1. Extend type-ir's existing metadata bag.** New `meta` keys
  (`meta.ownership`, `meta.layoutKind`, `meta.abiTarget`, ...) following the
  `nullable`/`readonly` convention-not-contract precedent
  (parent survey §4 Q1-b, the `meta` conventions documented on type-ir's `TypeRef`
  type). _Cost:_ zero new package/repo
  surface, reuses the exact mechanism 118 existing projectors already read. _Cost
  against:_ parent survey §4 Q1-b already names the core risk — an incorrect
  ownership/layout value here is a memory-safety bug in generated C/Rust output,
  not a wrong-shape bug, and "conventions, not contracts" (no IR-level
  enforcement) was designed for exactly the class of annotation where the failure
  mode is "wrong shape," not "undefined behavior." None of cbindgen/WIT/uniffi
  resolve this via an open author-supplied annotation surface — cbindgen reads a
  Rust-level `#[repr(...)]` attribute (itself compiler-checked, not a free-text
  convention), and WIT makes ownership a distinct _type constructor_
  (`resource`/`borrow<T>`), not a metadata flag on an existing type. Both real
  precedents point away from "loose annotation," which is new evidence this
  option's cost section in the parent survey didn't have.
- **A2. A separate `ffi-ir` package that references type-ir `TypeRef`s for the
  data-shape portion and adds its own boundary-semantics nodes.** Mirrors parent
  survey §4 Q1-c, now informed by WIT: WIT itself effectively _is_ this
  option relative to a hypothetical "pure data shape IR" — its `record`/`variant`
  types are data-shape (type-ir already has near-equivalents: `object`, `union`),
  while `resource`, `borrow<T>`, `async` function qualifiers, and
  `stream`/`future` are boundary-semantics constructs layered on top, with clean
  separation between the two groups in the spec itself. _Cost:_ cleanest
  separation (type-ir's 118 existing projectors see zero risk of
  boundary-semantics leakage), and now has a real, shipped multi-language
  precedent for the split being viable rather than just plausible. _Cost against:_
  still a wholly new package to design/build/maintain; also raises a concrete
  sub-question A2 didn't have before this research — does the new package
  **re-derive** type-ir's `object`/`union`/`enum` kinds as its own `record`/
  `variant` nodes (WIT's actual factoring — note WIT's `enum` is a `variant`
  special case, whereas type-ir keeps `enum`/`union` as siblings, so a faithful
  reference-not-reinvent approach isn't a 1:1 structural match), or does it
  literally embed type-ir `TypeRef`s as boundary-node fields and add ownership
  metadata on the _reference_, not the type? This is a genuine open sub-fork this
  document surfaces but does not resolve.
- **A3. New `TypeKinds` entries inside type-ir itself** (e.g. a `resource` kind, a
  `callback` kind distinct from `function`), following the "hierarchy via
  subtyping" precedent (parent survey §2) used for all of type-ir's existing
  kinds. _Cost:_ if boundary semantics genuinely are just more type-shape
  variation (which WIT's own factoring — `resource` living in the same type
  grammar as `record`/`variant` — suggests is a defensible position, not a
  stretch), this keeps everything in one IR with one kind-extension mechanism,
  and every existing data-shape projector's `unknown`/degrade-fallback pattern
  already knows how to safely ignore a kind it doesn't recognize. _Cost against:_
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
  projectors" architecture exactly. _Cost:_ preserves the core value proposition
  the parent survey's Q2-a explicitly names as being forfeited by
  per-pair-baked-ABI approaches ("ABI-baked-into-projector means a new projector
  per language _pair_, not per language... grows combinatorially"). _Cost
  against:_ per §3's table, the five real tools surveyed each solve the ownership
  question with genuinely different mechanisms (opaque pointer vs. `resource`
  type vs. `JsValue` table vs. generated destructor) — a shared IR node has to be
  abstract enough to _specialize_ into all of these per target, which is exactly
  the design difficulty the parent survey's Q1/Q2 already flagged as unresolved,
  now with concrete confirmation (not just inference) that the mechanisms really
  do differ structurally, not just in naming.
- **B2. WIT itself as the shared boundary IR** — i.e., don't invent a new IR
  vocabulary at all; adopt WIT's actual type grammar (`record`/`variant`/`enum`/
  `resource`/`flags`/…) as fractal's boundary IR, and write projectors _from_ WIT
  (or from type-ir + a thin WIT-shaped boundary layer) _to_ JS, C, and WIT text
  itself (a WIT emission projector is nearly free once the IR already speaks WIT's
  grammar). _Cost:_ WIT is a real, versioned, externally-maintained spec with its
  own tooling ecosystem (Canonical ABI, `wit-bindgen`, WASI) — adopting it avoids
  reinventing the resource/ownership primitive that this section's research
  suggests is genuinely hard to get right from scratch, and any WIT-native target
  becomes near-zero-cost. _Cost against:_ couples fractal's boundary-IR design to
  an external spec fractal doesn't control, whose evolution (WIT is explicitly
  still evolving — WASI 0.3 async/stream/future support was cited in this
  session's search results as a current-year development, not a settled feature)
  is outside this project's control; also, C and JS are not WASM/Component-Model
  targets at all — projecting WIT's `resource`/`borrow<T>` model onto a C ABI or a
  JS/wasm-bindgen boundary is itself unproven work this document has no
  prior-art confirmation for (WIT's own bindings generators target source
  languages _compiling to_ WASM components, not arbitrary non-WASM ABIs like
  cbindgen's plain C).
- **B3. Per-pair IRs, no shared boundary layer** — a JS-boundary IR, a
  C-boundary IR, and (if pursued) a WIT emission path, each independent,
  informed by shared research (this document plus the parent survey) but not by
  shared code/schema. _Cost:_ matches the observed pattern the parent survey's §3
  closing observation already named ("every tool that does more than
  data-shape-only picks its own fixed strategy... rather than exposing a
  general-purpose IR surface") — lowest design risk, ships incrementally, and the
  existing `rust-wasm-bindgen.ts` projector is already exactly this shape (a
  self-contained target-specific converter, per its own file header comment,
  "each projector file in this package is self-contained"). _Cost against:_
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
define behaviour; it defines only _contracts_ between components"**
**[VERIFIED-EXTERNAL, wit.html, direct quote]**. This settles the question in a
specific, narrow way: WIT is neither "a target you'd project into, full stop"
(like OpenAPI) nor "a general shared IR that could sit _underneath_ C and JS
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
quote]** — the value proposition is stated as _built on top of_ WASM's
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
that happens to also serialize to WASM; it _is_ the Component Model's contract
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
  happens by the _spec evolving_ (e.g. WASI 0.3 adding `stream`/`future`, per
  §2 above) not by a downstream consumer attaching arbitrary conventions to
  existing nodes. This is a direct divergence from "open metadata bag over
  fixed schema" — WIT is, structurally, the fixed-schema side of that design
  axis, not the open-bag side.
- **Closed/complete vs. incremental partial support:** nothing in the fetched
  pages suggests a WIT consumer is expected to handle "this construct isn't
  supported, throw" the way `rust-wasm-bindgen.ts` explicitly does for
  union/tuple/map/intersection/method/interface. WIT's own model is that a
  `.wit` file is a complete, closed contract — every construct in it is
  meaningful to every conforming `wit-bindgen` backend (modulo that backend's
  own language-target limitations), not a superset grammar where each backend
  is expected to reject a subset. This is a different shape of "partial
  support" than fractal's per-projector throw-on-unsupported-kind pattern: WIT
  pushes incompleteness to _which backends exist_, not to _which constructs a
  given backend accepts from an otherwise-shared document_.
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
the IR itself. B2 specifically (WIT's grammar _as_ the shared IR) is the
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
  (crosses by handle: ownership transfer/borrow _must_ be specified). This is
  directly motivated by §3's cross-tool observation that all five surveyed tools
  independently converge on this exact two-way split. _Cost:_ has real
  convergent-evidence backing (not a guess) and is the smallest possible
  ownership vocabulary that's still non-trivial. _Cost against:_ WIT's actual
  `resource` design is richer than a binary flag — it distinguishes owned vs.
  `borrow<T>` _per call site_, not per type (the same resource type can be
  passed owned in one signature and borrowed in another), so a type-level
  `layoutKind` flag alone under-models WIT's own precedent; would need the
  borrowed/owned distinction to live on the _reference_ (parameter/return
  position), not the type declaration, adding a second axis beyond the simple
  binary split.
- **C2. Adopt WIT's `resource` + `borrow<T>` model directly** as the general
  vocabulary, then define per-target lowering rules: C lowers `resource` to
  cbindgen's opaque-pointer-plus-explicit-free-function pattern (§1), JS lowers
  it to something wasm-bindgen-shaped (`JsValue`-table indirection or a class
  wrapping an opaque handle — the existing `rust-wasm-bindgen.ts` projector doesn't yet
  have a `resource`-equivalent kind to lower from, so this is new work, not a
  refactor of existing handlers), and WIT itself lowers to a no-op (already
  native). _Cost:_ reuses a real, externally-vetted ownership primitive instead of
  inventing one, and gives C and JS lowering rules a principled single source
  (the `resource`/`borrow` distinction) instead of two separately-invented
  conventions. _Cost against:_ per Fork B2's cost, WIT's `resource` was designed
  for the Component Model's own Canonical ABI and dynamic-linking model; whether
  its owned/borrowed semantics survive translation to a plain C ABI's
  compile-time-only linking model (no host runtime enforcing borrow duration the
  way a WASM component host might) is unconfirmed — C's caller can trivially hold
  a borrowed pointer past the call's return with nothing to stop it, which is a
  real gap WIT's own model may not directly close for a non-WASM target.
- **C3. No general ownership model — ownership is entirely a per-target-projector
  concern**, informed by the same research but not unified in the IR (this is
  Fork A/B's "don't model it" option specialized to ownership specifically, same
  as parent survey Q1-a). _Cost:_ cheapest, avoids over-fitting a single ownership
  vocabulary to three targets whose real mechanisms (per §3's table) genuinely
  differ. _Cost against:_ forfeits any cross-target ownership-correctness
  checking at the IR level — an author could describe a type as freely
  copyable when only one of the three targets can actually treat it that way, and
  the IR has no way to flag the mismatch before a target-specific codegen throws
  (or worse, silently produces unsound output, which is exactly the risk
  `rust-wasm-bindgen.ts`'s throw-not-degrade design (§0) was built to avoid for its one
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
   fetched did not spell out what happens if the _foreign_ runtime garbage-collects
   its side of a callback while Rust still holds the `Arc<dyn Trait>` handle — this
   specific hazard remains **[UNVERIFIED]**, not found in the fetched pages.
3. **wasm-bindgen does have a zero-copy path, but it is a separate, unsafe escape
   hatch outside the safe struct/fn surface `rust-wasm-bindgen.ts` targets** —
   correcting this document's earlier framing (§0, §3's table) that copying is the
   _only_ path. [VERIFIED-EXTERNAL: docs.rs/js-sys, `Uint8Array::view`/
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
   `rust-wasm-bindgen.ts` implements (its header comment plus `buildStruct`) — the projector's
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

| System                                                                          | Who allocates                                                                                                | Who frees                                                                                                  | Copy / move / borrow                                                                                                                                                                                | Failure mode if consumer gets it wrong                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C (cbindgen)                                                                    | Whichever side the author's hand-written convention says (cbindgen prescribes nothing — §1, confirmed above) | Same — author-defined free function, or raw `free()`/`libc::free` if the convention says so                | Either a full value copy (struct passed/returned by value into caller-provided storage) or an opaque pointer decomposed via `slice::from_raw_parts` for the buffer; no compiler-checked distinction | **Undetected UB** — double-free, use-after-free, or leak are all possible and cbindgen has no mechanism to catch any of them; the generated header is silent on which failure a given misuse produces                                 |
| uniffi                                                                          | Rust, via `Arc::new`                                                                                         | Rust's own `Arc` drop glue, triggered by the _last_ dropped reference (foreign destructors only decrement) | Shared ownership by reference count — the buffer field is not re-copied per access, it lives inside the `Arc`'d object                                                                              | **Leak only** (bounded, not UB) — a foreign side that never calls its generated destructor keeps the refcount above zero forever; memory-safety (no UAF/double-free) is preserved by construction                                     |
| wasm-bindgen (safe path, `rust-wasm-bindgen.ts`'s actual behavior)                   | Rust allocates; JS receives a `Clone`d copy wrapped as a `JsValue`-tracked object                            | JS's own GC frees the JS-side copy; Rust's original is unaffected/independently dropped                    | **Full copy**, always, for the `Vec<u8>` field (`getter_with_clone` requires `Clone`) — no sharing                                                                                                  | **None, memory-safety-wise** — the two copies are fully independent; cost is duplicated memory/CPU, not a safety bug                                                                                                                  |
| wasm-bindgen (unsafe path, `Uint8Array::view()`, not used by `rust-wasm-bindgen.ts`) | Rust allocates the buffer once                                                                               | Rust frees it (or reallocates it) whenever it chooses                                                      | **Zero-copy borrow** — a live typed-array view directly into wasm linear memory                                                                                                                     | **Use-after-free / read of invalid memory**, undetected — any subsequent allocation on the Rust side can silently invalidate the JS-held view with no error at the point of misuse                                                    |
| WIT (Canonical ABI `resource`)                                                  | Guest/host code, via its own constructor, registered under a handle in the per-instance handle table         | Explicit guest/host-supplied destructor, invoked by `canon resource.drop`                                  | **Handle** (`own` = ownership transfer, `borrow<T>` = scoped reference) — the underlying buffer is never copied by the ABI itself, only the handle crosses                                          | **Runtime-detected trap** (safe abort) if an `own` handle is dropped while `num_lends > 0`; the underlying allocation is still whatever the guest's destructor implementation is (a bug there is out of the Canonical ABI's coverage) |

**Named options, reframed with this session's per-target evidence (extends,
does not replace, C1-C3 above — none recommended):**

- **Option 1 — Copy-only, always clone across the boundary** (matches C1's
  "inline" case narrowed to "never opaque"; matches `rust-wasm-bindgen.ts`'s current,
  shipped default). _Cross-checked:_ **JS** — proven, this is exactly what
  `rust-wasm-bindgen.ts` does today (`getter_with_clone` + `Clone`, confirmed by direct
  read). **WIT** — a legitimate native subset: non-`resource` types (`record`,
  `list`, etc.) already cross the Canonical ABI by value/copy, so "copy-only" is
  simply "never emit a `resource`," which works but forecloses using WIT's own
  ownership primitive for anything that needs it. **C** — does _not_ fully
  eliminate the ownership question the way it appears to: per the matrix above,
  even a pure copy needs an explicit answer for who allocates the copy's backing
  storage and who frees it (cbindgen supplies no such convention, confirmed
  above), so "copy-only" only removes _aliasing/sharing_ concerns for C, not the
  alloc/free question itself.
- **Option 2 — Opaque handle + explicit free-function convention** (= C1's
  "opaque" case with a bare free-once discipline, no refcounting or lend-tracking
  on top). _Cross-checked:_ **C** — native fit; this is literally cbindgen's own
  documented opaque-pointer pattern (§1). **JS** — does not map cleanly: JS has no
  language-enforced "call free once" idiom (GC-managed), so this would need a
  bolted-on `.free()`/dispose convention with the same "forgotten call" risk
  uniffi's `Arc` approach was specifically built to avoid (per point 2 above,
  uniffi _could_ have used bare free-once and chose refcounting instead). **WIT**
  — a strict subset of `resource`'s actual mechanism: WIT already gives an opaque
  handle + explicit free call, _plus_ the lend-count/trap safety net this option
  omits (point 4 above) — adopting Option 2 for a WIT target means deliberately
  not using part of what WIT natively offers.
- **Option 3 — Adopt a resource/borrow-shaped model generally** (own-handle +
  `borrow<T>`-qualified reference, _including_ WIT's actual enforcement mechanism —
  a generated per-instance handle table with lend-count tracking that traps on
  violation, not just the naming). _Cross-checked:_ **WIT** — native, this is its
  own shipped model (point 4). **C** — cbindgen's opaque pointer has no equivalent
  handle-table/lend-count runtime; a C target adopting this option would need
  fractal to generate that bookkeeping itself as new runtime code shipped
  alongside the header, since plain C has no host runtime to enforce it the way a
  Wasm Component host does — real, uncosted implementation work, not a mapping
  onto anything cbindgen or the C ABI already provides. **JS** — likewise no
  native equivalent for the Rust-owns/JS-borrows direction; would need a
  generated handle-table wrapper (e.g. keyed via `Map`/`WeakMap` in the JS glue),
  distinct from wasm-bindgen's own `JsValue` index-table indirection (which
  handles the _opposite_ direction — JS-owned values Rust holds indices into) —
  no tool surveyed this session already does this for the Rust-owns direction.
  _Overall cost:_ richest safety guarantee (a trap instead of UB or a silent
  leak) but the most net-new implementation work for two of the three targets.
- **Option 4 — Reference counting (`Arc`/`Rc`-shaped shared ownership) as the
  general primitive**, per uniffi's actual (now-corrected) model. _Cross-checked:_
  **uniffi's own domain** — proven at scale (Firefox mobile/desktop). **JS** — a
  genuinely natural fit: JS's `FinalizationRegistry` can decrement a Rust-side
  `Arc` when a JS wrapper object is collected, giving a real (if not yet
  implemented in `rust-wasm-bindgen.ts`, which uses the Clone path instead) path to
  shared rather than copied ownership. **C** — expressible (a manually
  incremented/decremented count field, freed at zero) but, like Option 2, entirely
  author-maintained; cbindgen generates and verifies none of it, so C's failure
  mode stays "leak or worse if the author's hand-written refcount logic has a
  bug," not the structurally-safe "leak only" uniffi gets from a compiler-checked
  `Arc`. **WIT** — a confirmed structural mismatch: point 4 above establishes the
  Canonical ABI's `resource` semantics are explicitly _not_ reference counting
  (they're a lend-count-and-trap discipline); mapping refcounting onto a WIT
  target means either ignoring `resource`'s native mechanism or building a
  translation layer between two different safety models — a specific, newly-
  confirmed mismatch this deeper pass surfaces that was not visible from the
  surface-level type-vocabulary read alone.

#### Fork C, ownership representation: decided (2026-08-03)

A sub-question surfaced after the deeper pass above: independent of _which_
ownership discipline applies to a given value (Options 1-4, still open — see
below), how should the chosen discipline be _represented_ in the IR itself?
Two shapes were on the table — metadata on a value (an entry in the existing
per-TypeRef metadata bag, the same mechanism `optional`/`nullable` already
use) or a first-class type constructor wrapping any type (mirroring WIT's own
grammar-level `own<T>`/`borrow<T>` constructors). This is now decided, not a
lean:

- **Decision: metadata, not a wrapping type constructor.** Ownership
  discipline is recorded as an entry in a TypeRef node's metadata bag (e.g.
  something shaped like `meta.ownership: "copy" | "opaque" | "refcount" |
"resource"` — the exact key/value shape is implementation detail left for
  later, not part of this decision).
- **Reasoning.** type-ir already separates two independent failure surfaces:
  structural kind-resolution (which has ancestor fallback) and
  metadata-inspection. If ownership were a wrapping kind, a target unable to
  support that wrapper kind would have no fallback that preserves the
  underlying value — the whole node would die even when the inner type would
  otherwise project fine on that target. Metadata keeps ownership as a
  separate axis: a target resolves the structural shape independently, then
  separately decides whether it supports that specific value's ownership
  requirement, throwing scoped to just that requirement (the same
  explicit-throw-on-unsupported pattern `rust-wasm-bindgen.ts` already uses for
  kinds it can't handle) rather than failing the whole type.
- This reuses the existing per-TypeRef metadata bag mechanism — the same one
  `optional`/`nullable` already use — rather than introducing new mechanism;
  there is no new nesting-position ambiguity to solve, since metadata is
  already scoped per node.
- **Named cost, not hidden:** a WIT backend must synthesize `own<T>`/
  `borrow<T>` from `(innerType, meta.ownership)` at emit time, rather than
  reading it directly off a matching constructor already present in the
  source IR. This is ordinary projector-side mapping work, not a structural
  mismatch — but it's worth naming because WIT's own grammar does have
  ownership as a first-class constructor, and this translation step is one
  every WIT emission will need.

This decision resolves only the _representation shape_ sub-question. It does
not resolve Fork C's substance — which ownership discipline (Options 1-4,
per the deeper-pass comparison matrix above) applies to which value, and
which targets support which disciplines, remain open/unresolved.

#### Fork C, discipline-per-target: decided (2026-08-03)

The remaining open question from the subsection above — which discipline
applies to which target — is now decided.

- **Decision: each target implements only the ownership discipline(s) its own
  native tooling actually supports.** Not a subjective pick among Options 1-4;
  it's reading off which of those options each target's own tooling can
  realize natively, per the deeper-pass comparison matrix above, and declining
  to build new fractal-maintained runtime scaffolding to force-fit a
  discipline a target has no native support for.
  - **C:** Option 1 (copy, value semantics) + Option 2 (opaque handle plus
    explicit free-function). cbindgen's own documented opaque-pointer pattern
    (§1) is the closest thing to a "native" C convention, even though cbindgen
    itself prescribes no specific alloc/free discipline — fractal adopts that
    pattern as its convention rather than inventing a different one.
    Explicitly **not** Option 4 (refcounting): no native mechanism: it would
    be entirely fractal/author-maintained bookkeeping cbindgen doesn't
    generate or verify. Explicitly **not** Option 3 (resource/lend-count): no
    host runtime exists for plain C to enforce it — would require fractal to
    generate a full handle-table runtime from scratch, real uncosted work,
    excluded.
  - **JS/wasm-bindgen:** Option 1 (copy) — already shipped in
    `rust-wasm-bindgen.ts` via `Clone` — + Option 4 (`Arc`-refcounting via
    `FinalizationRegistry`), not yet implemented but a natural, native-feeling
    fit: `FinalizationRegistry` is a real JS-native GC hook. Explicitly
    **not** Option 2 (opaque-handle+free-fn) as a distinct mechanism: JS has
    no manual-free idiom; if shared ownership is needed the refcount path
    already covers it. Explicitly **not** Option 3 (resource/lend-count): no
    native support.
  - **WIT:** Option 3 (`resource` + `own`/`borrow`) — native, this is WIT's
    own shipped mechanism, and it already subsumes Option 1 (copy-by-value)
    for all non-`resource` types for free. Explicitly **not** Option 4
    (refcounting): confirmed structural mismatch from the deeper-pass matrix
    above — WIT's Canonical ABI does lend-count-and-trap, not refcounting.
- **Reasoning.** This directly follows Fork D's already-decided "shared
  vocabulary, per-target coverage gaps" pattern (below): the IR can still
  express all four disciplines in its vocabulary (per the
  representation-as-metadata decision above), but each target's projector
  only implements the subset it can realize, and errors explicitly — same
  pattern as `rust-wasm-bindgen.ts` today — on ownership metadata values it can't
  support.
- With both the representation-shape decision and this per-target discipline
  decision made, **Fork C as a whole is now resolved.**

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
  that _every_ crossed type have an explicit, source-declared layout
  (`#[repr(C)]`-equivalent) with no fallback opaque-value primitive at the
  language level (§1) — C literally cannot receive "any value" the way JS's
  `JsValue` or WIT's Canonical ABI implicitly can, so an IR node meaning
  "opaque/unknown, figure it out at the boundary" (type-ir's own `unknown` kind,
  which `rust-wasm-bindgen.ts` maps straight to `JsValue`, per the `unknown` entry
  in its `handlers` map) has no honest C equivalent — it would have to be an
  error, not a degrade, for a
  C target specifically. Async calling convention is a second strong
  candidate: WIT has a first-class `async` qualifier plus dedicated `stream`/
  `future` types (§2); C has no language-level async calling convention
  at all (callback-based or poll-based conventions are a library/generator
  choice, not something C-the-ABI expresses); JS has `Promise` natively. Forcing
  one shared "async" IR construct across a target that has no async primitive
  (C) and two that do but via different mechanisms (native `Promise` vs. WIT's
  `async` + `stream`/`future` pairing) is a real risk of the shared construct being
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
> same pattern already used by rust-wasm-bindgen.ts today (throws on union/map/tuple/
> intersection rather than approximating). Not the same as constructs being
> "target-specific" by design -- it's uniform vocabulary with per-target coverage
> gaps.

### Fork E — Sequencing / build-order options

- **E1. C first.** Most universal target (any language with a C FFI can consume
  it), most constrained (§1's findings — no generics, explicit layout
  requirement, no async, no built-in opaque-value fallback), and per this
  document's Fork D analysis, forces the hardest questions (ownership encoding,
  layout-vs-opaque split) to be answered early rather than deferred, because C
  has no slack to punt on them into a fallback primitive. _Cost:_ the payoff (a
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
  (Fork B2). _Cost:_ couples early architecture to an external, still-evolving
  spec (§2's WASI 0.3 async/stream/future note); and building WIT-shaped first
  risks under-testing against C's much harsher constraints (no generics, no
  async, no opaque-value fallback) until later, potentially requiring rework once
  C is actually attempted.
- **E3. Generalize outward from the existing `rust-wasm-bindgen.ts` projector.**
  Lowest-risk incremental path — take the one real, working, narrow-scope
  projector already in the codebase (§0) and its documented failure boundary
  (union/tuple/map/intersection/method/interface all explicitly unsupported,
  the `unsupported()`-wrapped entries in `rust-wasm-bindgen.ts`'s `handlers` map)
  as the concrete list of gaps a general IR would
  need to close for even its _first_ target, then widen. _Cost:_ grounds the
  design in a real artifact rather than three tools' documentation, but JS/
  wasm-bindgen is arguably the _least_ representative of the three targets for
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

## 5. Target inventory: LuaJIT/Deno/Bun/JNI/P-Invoke/C++/Go/Rust

Prompted by the user expanding scope to "comprehensive ffi-gen" and naming seven
additional candidate targets (items 1-7 below). Item 8 (Rust as consumer) was added
in a later correction pass: the original C++ entry (item 6) had answered a
different question than this section asks — "can C++ _expose_ itself via a stable
ABI" rather than "does generated C++ _consume_ a plain C ABI" — and was rewritten
in place; Rust-as-consumer was entirely missing from the original inventory (which
only covered Rust-as-source, `rust-wasm-bindgen.ts`) and is added here as a new entry.
This section answers one narrow, factual question per
target — **does it consume a plain, ordinary C ABI dynamic library (the shape a C
compiler produces from `extern "C"`, no name mangling, no special binary format), or
does it require its own non-C-ABI-shaped glue/marshaling layer?** — sourced from
official docs fetched this session. It does not propose an architecture, does not
choose among Forks A-E, and does not decide how many fractal backends this implies;
that classification is left as a finding for the user to weigh, consistent with this
document's own (§6) disposition against picking among options.

**1. LuaJIT `ffi.C`/`ffi.load`.**
[VERIFIED-EXTERNAL: luajit.org/ext_ffi_semantics.html, fetched 2026-08-03] —
`ffi.cdef`'s C parser's "only purpose is to parse C declarations, as found e.g. in C
header files"; it is explicitly "not a C compiler." Symbols are resolved by name
against "shared libraries or the default symbol namespace," with the resulting
symbol/type/address binding cached. Platform calling-convention handling is
automatic and C-ABI-native (e.g. `__stdcall` vs `__cdecl` detection on Windows/x86).
No intermediate compiled format, no custom binary layer — `cdef` is purely a
declaration syntax describing an ordinary C ABI library. **Plain-C-ABI consumer:
yes.**

**2. Deno FFI (`Deno.dlopen`).**
[VERIFIED-EXTERNAL: docs.deno.com/runtime/fundamentals/ffi/, fetched 2026-08-03] —
`Deno.dlopen` "loads dynamic libraries and creates JavaScript bindings to the
functions they export," i.e. a standard `dlopen`-based C ABI consumer, described via
a type-signature object, not a special format. **Struct passing:** supported by
value via a `{ struct: [...] }` field-list, with padding matching C compiler
behavior; passed as a `TypedArray`, returned as `Uint8Array`. [VERIFIED-EXTERNAL, via
WebSearch snippet, not independently re-confirmed by direct fetch of the FFI struct
page] struct-by-value functions are currently incompatible with Deno's "Turbocall"
fast-path optimization (V8 Fast API) — a performance limitation, not a
correctness/coverage one. **Callback support:** exists via `Deno.UnsafeCallback`,
letting native code call back into JS; not auto-freed (must call `.close()`) to
avoid use-after-free. **Plain-C-ABI consumer: yes**, with one documented
performance-path limitation for structs (not a capability gap).

**3. Bun FFI (`bun:ffi`).**
[VERIFIED-EXTERNAL: bun.com/docs/runtime/ffi, fetched 2026-08-03] — "It works with
any language that supports the C ABI, including Zig, Rust, C/C++, C#, Nim, and
Kotlin"; `dlopen()` loads a library by name/path with platform-specific suffix
handling (`.so`/`.dylib`/`.dll`). **Struct passing: not supported** — the documented
FFI type table covers only primitives (integers, floats, booleans, pointers,
strings, buffers) and function pointers; no composite/struct type is listed, meaning
struct data must be handled manually via raw pointers. **Callback support:** present
via `JSCallback` (including an experimental thread-safe mode with a performance
cost), but async functions are explicitly not supported as callbacks. The docs
themselves state `bun:ffi` "is **experimental**, with known bugs and limitations,
and should not be relied on in production." **Plain-C-ABI consumer: yes** for the
underlying loading mechanism, but with a **real capability gap** (no struct support,
not just a performance caveat) relative to LuaJIT/Deno — distinguishing it from
"partial" in a different way than Deno's Turbocall caveat.

**4. JNI (Java Native Interface).**
[VERIFIED-EXTERNAL: docs.oracle.com/en/java/javase/12/docs/specs/jni/design.html and
related Oracle JNI spec pages, fetched via search 2026-08-03] — native methods
require generated glue functions whose first parameter is the `JNIEnv*` interface
pointer (a struct of function pointers in C; a C++ class instance in C++, where the
`JNIEnv` argument is then implicit), with `jobject`/`jclass` and friends as JNI's own
reference-type system. Local references are VM-managed and freed automatically when
the native method returns; the VM must track every object handed to native code so
the GC doesn't collect it prematurely. The underlying call itself does follow the
platform's native calling convention (C convention on Unix, `__stdcall` on Win32),
but the _signature shape_ — `JNIEnv*`, opaque `jobject`/`jclass` handles, VM-managed
reference lifetime — has no analogue in a plain `extern "C"` function signature.
**Plain-C-ABI consumer: no.** Categorically different from items 1-3: it is not "a
C-ABI library plus a loader," it is a distinct glue-generation target requiring
JNI-shaped function signatures compiled specifically for the JVM's own
reference/type system.

**5. .NET P/Invoke.**
[VERIFIED-EXTERNAL: learn.microsoft.com/en-us/dotnet/standard/native-interop/pinvoke
and related Microsoft Learn P/Invoke pages, fetched via search 2026-08-03] — a
`[DllImport]`-attributed `static extern` method declaration (or, since .NET 7, the
source-generator-based `[LibraryImport]`) is the mechanism; `[MarshalAs]` and
`DllImport`'s `CharSet` control how managed types (e.g. `string`) are marshaled to
native representations, and simple blittable types (numeric widths, etc.) pass
through with no marshaling step at all. This does not require the target library to
be built for .NET or contain any .NET-specific glue — a signature declared with the
correct native layout and marshaling attributes calls directly into an ordinary C
ABI export. **Plain-C-ABI consumer: yes, with an additional declarative marshaling
layer on the .NET-caller side** — structurally different from JNI: the target
library needs nothing JNI-shaped, and the .NET-side attributes exist to tell the CLR
how to convert its own managed representations at the boundary, not to describe a
non-C-ABI target shape.

**6. C++ as a consumer of a plain C ABI (idiomatic wrapper-class codegen).**
This entry was originally scoped backwards — it answered "can arbitrary C++ _expose
itself_ via a stable ABI," which is the wrong direction for this section's actual
question (item 4's framing: does the target _consume_ a plain C ABI library, the
same direction as LuaJIT/Deno/Bun/cgo/P-Invoke above). The C++-ABI-instability fact
from the original research is still correct background and is kept: [VERIFIED-
EXTERNAL: oracle.com/technical-resources/articles/it-infrastructure/stable-
cplusplus-abi.html and docs.rs/cxx, fetched 2026-08-03] "C is the only de facto
ABI-stable lingua franca," and name mangling, non-POD struct/class layout, and
vtable layout are all part of the C++ ABI with no single cross-compiler-stable
answer — the documented, standard answer for _exposing_ a C++ API is `extern "C"`,
at which point it degenerates to the plain-C-ABI case (item's-1-3 shape). That fact
answers a different question than the one this section asks, though: the actual
target-inventory question for C++ is whether generated idiomatic C++ **consumer**
code — a hand-shaped-looking RAII wrapper class whose constructor calls a C init
function and whose destructor calls the matching C free function, wrapping an
opaque pointer or POD struct — can be produced _from_ a C-ABI-shaped type-ir
projection, the same direction as bindgen-for-Rust (item 8 below) or this section's
loader-stub pattern.
[VERIFIED-EXTERNAL: github.com/mozilla/cbindgen/blob/main/docs.md, re-checked for
C++-mode output specifically, fetched 2026-08-03] cbindgen's own C++ language mode
is the closest existing tool-generated C++ output surveyed, and it answers this
narrowly: it adds C++ _syntax_ over the same C declarations (namespaces, `enum
class`, operator overloads, opt-in constructors via config) but does not, by
default, generate an RAII wrapper class that owns and destroys an opaque C
resource — its opaque-type handling (§1 above) still emits a bare forward
declaration (`typedef struct Foo Foo;`-equivalent), with no generated constructor/
destructor pair calling the crate author's init/free functions. **No established,
broadly-adopted C-header-to-idiomatic-C++-RAII-wrapper generator tool analogous to
bindgen was found this session** — search results turned up only niche,
per-project generator scripts (e.g. `wrap-vpp`, a Python script generating one
RAII wrapper for one specific C API; the `webgpu_raii` project's generator script,
scoped to `webgpu.h`'s release functions) rather than a general-purpose tool people
reach for the way they reach for bindgen or cbindgen. **[UNVERIFIED, this session's
search coverage, not exhaustive]** The actual, widely-documented state of practice
for C++ consuming a C API is a **hand-written** idiom, not a generated one: either
a hand-rolled RAII class per resource, or `std::unique_ptr<T, Deleter>` with a
custom deleter bound to the C free function — a pattern common enough to appear
directly in cppreference's own `unique_ptr` documentation (e.g. wrapping `FILE*`
with `fclose` as the deleter). **Plain-C-ABI consumer: yes, but heavier than a
loader stub** — unlike LuaJIT/Deno/Bun/cgo/P-Invoke (item 9's finding), which only
need a thin re-declaration of an already-settled C signature in each runtime's own
syntax, idiomatic C++ wrapper-class generation must additionally know the C API's
_ownership shape_ (which function pairs are init/free, which parameters are
borrowed vs. owned) to decide what the constructor/destructor should call — the
same ownership-discipline vocabulary this document's Fork C (§4) already treats as
a genuinely hard, unsettled question. This makes C++ closer in weight to a real
codegen target than to a stub, even though — like the other loader-stub cases — it
consumes the exact same plain C ABI shape at the bottom.

**7. Go (cgo).**
[VERIFIED-EXTERNAL: go.dev/src/runtime/cgocall.go and related search results on cgo
call overhead, fetched 2026-08-03] — cgo does link against and call plain C ABI
functions/libraries directly; no bespoke binary format is involved. The real,
verified gotchas are operational rather than ABI-shaped: each cgo call switches the
calling goroutine off its own stack onto the OS thread's `g0` stack and coordinates
with the Go scheduler (`entersyscall`, signaling "this M is blocked in foreign code,
run other goroutines elsewhere"), which is real, measured per-call overhead — search
results cited a "30-40x" penalty relative to a native Go call in one comparison, and
Go 1.26 is reported to have reduced this overhead by roughly 30% versus earlier
versions (this specific figure is **[UNVERIFIED — via WebSearch snippet, not
independently confirmed against a primary Go release-notes source this session]**).
GC interaction: arguments passed into C live in a stack-local frame of `uintptr`
fields the GC treats as non-pointer data, and the foreign call runs on `g0`'s stack
so the calling goroutine's own stack stays in a GC-scannable state throughout — i.e.
the mechanism is designed to keep the ABI boundary GC-safe, at the cost of the
stack-switch overhead. **Plain-C-ABI consumer: yes**, with real per-call runtime
overhead that a codegen target would need to account for (e.g. batching calls,
avoiding cgo in hot loops) even though the ABI itself requires no special shape.

**8. Rust as a consumer of a plain C ABI (idiomatic binding codegen).** Missing
from the original inventory, which only covered Rust-as-_source_
(`packages/type-ir/src/rust-wasm-bindgen.ts`, type-ir → Rust exposing JS — the opposite
direction). The well-established, real prior art here is `bindgen`
(rust-lang/rust-bindgen): [VERIFIED-EXTERNAL: WebSearch results for
rust-lang/rust-bindgen's documented scope and the ecosystem's `*-sys`-crate
convention, fetched 2026-08-03] bindgen reads a C header and generates `unsafe
extern "C"` function declarations plus corresponding Rust type declarations
(structs, enums) directly — this is bindgen's actual, documented job, and (per
Rust 2024 edition's RFC 3484) those extern blocks are now required to be marked
`unsafe extern` at the declaration level, not just at each call site. **Confirmed,
not assumed: bindgen itself does not generate safe wrapper types with `Drop` impls
for owned resources** — that layer is conventionally hand-written on top, in a
_separate_ crate, following the ecosystem's well-established `-sys` crate
convention: a `foo-sys` crate holds bindgen's raw unsafe output and links the
native library, while a plain `foo` crate (e.g. `libgit2-sys` → `git2-rs`, the
canonical real-world example found this session) hand-writes the idiomatic safe
surface — replacing raw pointers with `&`/`Box`, null returns with `Option`, and
adding `Drop` impls that call the C library's free functions, hiding `unsafe` from
the crate's own users. This is architecturally the same two-layer shape as the C++
finding above (item 6): an automated tool produces the raw, ownership-unaware
C-ABI-shaped declarations, and idiomatic-consumer wrapping (RAII-via-`Drop` in
Rust, RAII-via-constructor/destructor in C++) is where the ownership-shape
knowledge has to be supplied, hand-written in both ecosystems' actual practice
rather than inferred by the declaration-generation tool itself. **Plain-C-ABI
consumer: yes** for bindgen's own scope (it reads and re-declares an ordinary C
header) — but, like C++, producing the _idiomatic, safe_ consumer surface (not
just the raw unsafe declarations) requires the same ownership-shape information a
loader stub never needs, making "safe idiomatic Rust bindings" a heavier target
than the pure loader-stub cases even though bindgen's own raw-declaration output
is a thin, direct, near-stub-weight re-description of the C header.

### Classification table

| #   | Target                                                       | Plain-C-ABI consumer?                               | Distinguishing factor (verified)                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | LuaJIT `ffi.C`/`ffi.load`                                    | **Yes**                                             | `cdef` is pure C-declaration parsing, not a compiler or custom format; symbols resolved by name against an ordinary shared library                                                                                                                                                                                                                                                                                           |
| 2   | Deno `Deno.dlopen`                                           | **Yes**                                             | Struct-by-value and callbacks (`UnsafeCallback`) both supported; one performance-only caveat (struct args disable the V8 Fast-API "Turbocall" path), not a capability gap                                                                                                                                                                                                                                                    |
| 3   | Bun `bun:ffi`                                                | **Yes** (loading), **partial** (type coverage)      | dlopen-based C ABI loader, but no struct type in the documented type table (manual pointer handling required); docs self-describe as experimental with known bugs                                                                                                                                                                                                                                                            |
| 4   | JNI                                                          | **No**                                              | Requires `JNIEnv*`/`jobject`/`jclass`-shaped generated glue and a VM-managed reference system; not expressible as an ordinary `extern "C"` signature                                                                                                                                                                                                                                                                         |
| 5   | .NET P/Invoke                                                | **Yes, plus a declarative marshaling layer**        | `[DllImport]`/`[LibraryImport]` call ordinary C ABI exports directly; `[MarshalAs]`/`CharSet` convert managed↔native representations on the .NET side only — the target library needs no .NET-specific shape                                                                                                                                                                                                                 |
| 6   | C++ as consumer (idiomatic RAII wrapper-class codegen)       | **Yes, but heavier than a stub**                    | Underlying ABI is still plain C (`extern "C"`, since C++ itself has no cross-compiler-stable ABI); no established general-purpose C-header-to-C++-RAII-wrapper generator tool found (cbindgen's C++ mode adds only syntax, not ownership-aware wrapper classes) — established practice is hand-rolled RAII (`unique_ptr<T, Deleter>` or a hand-written class), requiring ownership-shape knowledge a loader stub never needs |
| 7   | Go (cgo)                                                     | **Yes**                                             | Links against ordinary C ABI libraries directly; the real cost is per-call runtime overhead (goroutine stack switch onto `g0`, scheduler coordination) and GC-safety bookkeeping, not an ABI shape difference                                                                                                                                                                                                                |
| 8   | Rust as consumer (idiomatic `bindgen`-based binding codegen) | **Yes, but heavier than a stub for the safe layer** | `bindgen` generates raw `unsafe extern "C"` declarations directly from a C header (near-stub-weight); confirmed it does not itself generate safe wrapper types with `Drop` impls — that layer is conventionally hand-written on top in a separate crate (the ecosystem's `-sys`-crate convention, e.g. `libgit2-sys` → `git2-rs`), same ownership-shape burden as item 6                                                     |

### Finding: implied scope for a fractal FFI backend, not a decision

Of the eight, four (LuaJIT, Deno, Bun, Go/cgo) and one qualified case (.NET
P/Invoke) all consume the _same_ plain C ABI shape that a `cbindgen`-style backend
(§1 of this document) would already produce — the difference between them is only
in each runtime's own idiomatic _loader/declaration_ code (LuaJIT's `cdef` string,
Deno's `dlopen` type-signature object, Bun's `dlopen` type table, cgo's `import "C"`
preamble, a C#/.NET `[DllImport]` signature block), not in the shape of the library
itself. If that observation holds, those five would not need five independent
FFI-IR backends with their own ownership/ABI modeling — they would need **one
plain-C-ABI backend plus five small "loader stub" projectors**, each one
significantly narrower in scope than the C target itself (no layout/ownership
decisions of its own to make, since it's just re-describing an already-settled C
signature in each runtime's declaration syntax).

**C++ (item 6) and Rust (item 8) extend this same one-C-ABI-backend hypothesis, as
two more consumers of it, but not as pure loader stubs.** Both sit underneath the
same plain C ABI as the five stub cases — a C++ RAII wrapper class and a Rust
`bindgen`+safe-wrapper crate both ultimately call the identical `extern "C"`
symbols a cbindgen-style backend would emit — but idiomatic-consumer generation for
both is real codegen, heavier than a stub, because generating a constructor that
calls the right init function and a destructor/`Drop` that calls the matching free
function requires knowing the C API's **ownership shape** (which functions
allocate, which free, which parameters are borrowed vs. owned) — the same
vocabulary this document's Fork C (§4) already treats as a genuinely open,
unsettled design question for fractal's own IR. Rust's raw-declaration half
(bindgen's actual, verified scope) is closer to stub-weight — a near-mechanical
re-declaration of the C header, same shape as the five loader stubs — but the safe/
idiomatic wrapper half that the ecosystem hand-writes on top (`Drop` impls,
`&`/`Box` in place of raw pointers) is where the ownership-shape burden lands, same
as C++'s wrapper class as a whole.

JNI remains the clear, categorical exception to the whole hypothesis — it has its
own non-C-ABI signature shape and VM-managed reference system end to end, not
reducible to "C ABI plus thin syntax" at any layer, unlike C++ and Rust which both
bottom out in the same plain C ABI once you get past their respective
idiomatic-wrapper layers. Bun's missing struct support is a narrower, tooling-
maturity-shaped exception (a coverage gap in an experimental runtime feature, not a
structural one).

This reframes the "comprehensive ffi-gen" scope as a question the user has not yet
weighed in on, presented here as options rather than a pick: **(a)** one C-ABI IR/
backend (per this document's Forks A-E) plus N narrow loader-stub projectors for
LuaJIT/Deno/Bun/Go/.NET/Rust's-raw-half, plus two heavier-but-still-C-ABI-consuming
idiomatic-wrapper projectors for C++ and Rust's-safe-half that additionally need
Fork C's ownership-shape answer, with JNI and WIT (§2) as the only targets needing
their own full boundary-semantics treatment; versus **(b)** treating every named
runtime as its own independent FFI-IR backend regardless of ABI-shape overlap,
trading a larger number of backends for not needing to first prove out and
stabilize a shared C-ABI backend that every stub and wrapper-generator would then
depend on.

---

## 6. What this document does not do

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
