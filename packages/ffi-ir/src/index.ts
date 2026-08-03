import type { TypeRef } from "@rhi-zone/fractal-type-ir"

// FFI-IR — boundary-crossing vocabulary for modules/interfaces, function and
// method signatures, and opaque resource handles, layered ON TOP of type-ir
// rather than folded into it. See docs/design/ffi-ir-architecture-options.md
// for the full design record; this file implements the decided forks:
//
//   - Fork A (decided): a separate package depending on type-ir, referencing
//     its `TypeRef`s for data-shape rather than extending type-ir's own kind
//     vocabulary — "modules are not really types." Every parameter/return/
//     field position below is a type-ir `TypeRef`, not a re-derived shape.
//   - Fork C, "ownership representation: decided": ownership discipline is
//     metadata on a TypeRef node (`meta.ownership`), not a wrapping type
//     constructor (unlike WIT's `own<T>`/`borrow<T>`) — reusing the exact
//     mechanism `meta.optional`/`meta.nullable` already use in type-ir, not a
//     new one. See `OwnershipDiscipline` below.
//   - Fork C, "discipline-per-target: decided": the IR itself stays capable
//     of expressing all four disciplines (copy / opaque-handle+free-fn /
//     refcount / resource own-borrow) — which target backends implement
//     which is a projector concern (same explicit-throw-on-unsupported
//     pattern `wasm-bindgen.ts` already uses for type-ir kinds), not
//     something this schema restricts.
//   - Fork D (decided): one shared vocabulary, per-target coverage gaps —
//     nothing here is C-only or JS-only or WIT-only; a backend that can't
//     realize a given resource/ownership/async shape is expected to throw
//     explicitly rather than this schema forking per target.
//   - §5 target inventory: this schema models the boundary/module layer and
//     ownership metadata that type-ir's own `function`/`method` kinds don't
//     carry (they model in-language callable *values*, not an exported FFI
//     boundary's calling/ownership contract).
//
// Structural convention mirrors type-ir's own `TypeKinds`/`TypeShape`/
// `TypeRef` pattern exactly, but as ITS OWN separate kind space
// (`FfiKinds`/`FfiShape`/`FfiRef`) — not new entries registered into
// type-ir's `TypeKinds`/`parents` registry. Fork A's "modules are not really
// types" reasoning applies here too: boundary-semantics kinds (`function`,
// `method`, `resource`, `module`) have no business living in the same
// ancestor-fallback lattice as `type-ir`'s data-shape kinds, even though the
// *mechanism* (open kind vocabulary + ancestor fallback + open metadata bag)
// is deliberately the same mechanism, reused, not reinvented.

// ============================================================================
// Ownership metadata — Fork C's decided representation.
// ============================================================================

/**
 * The four disciplines named in the design doc's Fork C "deeper pass"
 * (Options 1-4 there), each cross-checked against C/JS/WIT's own native
 * tooling in the "discipline-per-target: decided" subsection:
 *
 *   - `"copy"` — crosses by value, always cloned/duplicated at the boundary.
 *     Native to all three targets (C: plain value copy; JS/wasm-bindgen:
 *     `Clone` + `getter_with_clone`, already shipped in `wasm-bindgen.ts`;
 *     WIT: any non-`resource` type crossing the Canonical ABI by value).
 *   - `"opaque-handle"` — an opaque pointer/handle plus an explicit,
 *     separately-declared free function; no compiler- or runtime-checked
 *     discipline beyond "call free exactly once." Native to C (cbindgen's
 *     own documented opaque-pointer pattern). `freeFn` names the exported
 *     free function a backend should emit a call to, when known.
 *   - `"refcount"` — shared ownership via a reference count, freed when the
 *     count reaches zero. Native to uniffi's `Arc` model and to JS via
 *     `FinalizationRegistry` decrementing a Rust-side `Arc` (not yet
 *     implemented in `wasm-bindgen.ts`, which uses the copy path instead).
 *     Explicitly NOT native to WIT — its Canonical ABI `resource` mechanism
 *     is a lend-count-and-trap discipline, not reference counting (see the
 *     design doc's Fork C "deeper pass," point 4).
 *   - `"resource"` — an owned-or-borrowed handle, WIT's own shipped
 *     `resource` + `own`/`borrow<T>` mechanism (per-instance handle table,
 *     lend-count tracking, trap on violation). `mode` distinguishes the two
 *     call-site qualifiers WIT itself distinguishes per reference, not per
 *     type — the same value's resource can be passed `"own"` in one
 *     signature and `"borrow"` in another, which is exactly why this lives
 *     on the reference's metadata (this TypeRef's `meta.ownership`), not on
 *     a type-level flag.
 *
 * Which of these a given target's projector actually implements is a
 * per-target coverage question (Fork D), not something this type restricts —
 * the IR can express all four; a backend throws explicitly (matching
 * `wasm-bindgen.ts`'s existing throw-not-degrade convention) on a value it
 * can't realize natively rather than silently mis-lowering it.
 */
export type OwnershipDiscipline =
  | { readonly kind: "copy" }
  | { readonly kind: "opaque-handle"; readonly freeFn?: string }
  | { readonly kind: "refcount" }
  | { readonly kind: "resource"; readonly mode: "own" | "borrow" }

/** Convenience constructors for `OwnershipDiscipline` values — mirrors
 * type-ir's `types` object of shape constructors. */
export const ownership = {
  copy: (): OwnershipDiscipline => ({ kind: "copy" }),
  opaqueHandle: (freeFn?: string): OwnershipDiscipline =>
    freeFn === undefined ? { kind: "opaque-handle" } : { kind: "opaque-handle", freeFn },
  refcount: (): OwnershipDiscipline => ({ kind: "refcount" }),
  resource: (mode: "own" | "borrow"): OwnershipDiscipline => ({ kind: "resource", mode }),
}

// `meta.ownership` is the recognized convention key on a type-ir `TypeRef`'s
// existing open metadata bag (the same bag `meta.optional`/`meta.nullable`/
// `meta.readonly` already live in — see `@rhi-zone/fractal-type-ir`'s
// `index.ts` for those). Attach it to:
//   - a parameter's `type` (an `FfiParam.type`, below)
//   - a return type (an `FfiKinds.function`/`method`'s `returnType`)
//   - a field's `TypeRef` inside an `object`-kind shape referenced from
//     either position
// A resource handle crossing the boundary is conventionally represented as a
// type-ir `{ kind: "ref", target }` TypeRef whose `target` names an
// `FfiResource` declared in the enclosing `FfiModule`'s `resources` map,
// carrying `meta.ownership = { kind: "resource", mode: "own" | "borrow" }` —
// this is a convention this package documents and its own constructors
// (`resourceRef` below) follow, not a hard-enforced contract (same
// "convention, not contract" precedent type-ir's own metadata bag uses).
export function withOwnership(ref: TypeRef, discipline: OwnershipDiscipline): TypeRef {
  return { shape: ref.shape, meta: { ...ref.meta, ownership: discipline } }
}

/** A type-ir `ref` TypeRef pointing at a resource name, with resource
 * ownership metadata attached — the documented convention above, as a
 * constructor so callers don't have to hand-assemble the `{ kind: "ref" }`
 * shape themselves. */
export function resourceRef(resourceName: string, mode: "own" | "borrow"): TypeRef {
  return { shape: { kind: "ref", target: resourceName }, meta: { ownership: ownership.resource(mode) } }
}

// ============================================================================
// Boundary kind hierarchy — FfiKinds/FfiShape/FfiRef, mirroring type-ir's
// TypeKinds/TypeShape/TypeRef pattern (open kind vocabulary, ancestor
// fallback via resolve()/ancestors()/registerParent()) on ffi-ir's own,
// separate kind space.
// ============================================================================

/** One named parameter of a boundary function/method — `type` is a type-ir
 * `TypeRef`, per Fork A (data-shape stays in type-ir; ffi-ir references it
 * rather than re-deriving it). Ownership discipline, when applicable, is
 * metadata on `type` itself (`type.meta.ownership`) — see `withOwnership`. */
export type FfiParam = {
  readonly name: string
  readonly type: TypeRef
}

// Core boundary kinds only, mirroring type-ir's own index.ts comment: this
// interface is the minimal vocabulary; extension modules can augment it via
// declaration merging + registerParent(), the same way type-ir's src/kinds/*
// extend TypeKinds.
export interface FfiKinds {
  // A free function exported at an FFI boundary — not a data-shape callable
  // value (that's type-ir's own `function` kind; a struct field or parameter
  // typed as "a callback" still uses type-ir's `function` TypeRef, unchanged)
  // but the boundary's own top-level export: a named entry point with an
  // ownership-annotatable parameter/return list.
  //
  // `meta` (on the enclosing `FfiRef`, not this shape) is the documented
  // extension point for calling-convention information the design doc's
  // Fork D/B explicitly leaves open — WIT has a first-class `async`
  // qualifier plus `stream<T>`/`future<T>` data types, C has no async
  // calling convention at all, and JS has native `Promise`; forcing a single
  // shared async model here would be inventing an answer the design doc
  // does not give (see Fork D: "genuinely unresolved... async calling
  // convention"). A future decision can add a recognized `meta` key (e.g.
  // `meta.callingConvention`) the same way `meta.ownership` was added to
  // type-ir's bag, without a schema change here.
  function: {
    readonly kind: "function"
    readonly params: readonly FfiParam[]
    readonly returnType: TypeRef
  }
  // A callable belonging to a resource's own method surface — same shape as
  // `function` plus `receiver`, naming the `FfiResource` (by its key in the
  // enclosing `FfiModule.resources` map) this method operates on. Kept
  // distinct from `function` for the same reason type-ir keeps `method`
  // distinct from `function`: registerParent("method", "function") below
  // means a projector without an explicit `method` handler automatically
  // falls back to its `function` handler.
  method: {
    readonly kind: "method"
    readonly params: readonly FfiParam[]
    readonly returnType: TypeRef
    readonly receiver: string
  }
  // An opaque/owned handle to an entity that exists at the FFI boundary —
  // informed by, but deliberately narrower than, WIT's `resource` (WIT's
  // own `own<T>`/`borrow<T>` qualifiers are NOT reproduced here as a type
  // constructor — per Fork C's decided representation, own/borrow is
  // metadata on the *reference* to a resource, not part of the resource
  // declaration itself; see `OwnershipDiscipline`'s `"resource"` case and
  // `resourceRef` above). A resource exposes behavior only through its
  // `methods` map, mirroring WIT's own constraint that resources "cannot be
  // plain data structures."
  resource: {
    readonly kind: "resource"
    readonly name: string
    readonly methods: Readonly<Record<string, FfiRef>>
  }
  // The "modules are not really types" construct from Fork A — groups the
  // functions and resources exported at one FFI boundary. Roughly analogous
  // to WIT's `interface` (named collection of types+functions), narrower:
  // this package does not model WIT's richer `world`/`package`
  // import/export/versioning layer, since the design doc's research (Fork
  // B's WIT deep-dive) found that composition layer to be ecosystem-bound to
  // the Component Model specifically, not something this document's forks
  // adopted as fractal's own vocabulary.
  module: {
    readonly kind: "module"
    readonly name: string
    readonly functions: Readonly<Record<string, FfiRef>>
    readonly resources: Readonly<Record<string, FfiRef>>
  }
}

export type FfiShape = FfiKinds[keyof FfiKinds]

export type FfiRef = {
  readonly shape: FfiShape
  // Open metadata bag, same "conventions over contracts" precedent as
  // type-ir's TypeRef.meta — e.g. a future calling-convention key (see the
  // `function` kind's doc comment above), `meta.description` for doc
  // comments, `meta.deprecated`, etc. No calling-convention key is defined
  // yet; this field exists so one can be added without a schema change,
  // per Fork D's still-open async question.
  readonly meta: Readonly<Record<string, unknown>>
}

const parents: Record<string, string | null> = {
  function: null,
  // A method IS a callable — projectors without an explicit `method`
  // handler fall back to their `function` handler, mirroring type-ir's own
  // method -> function relationship exactly.
  method: "function",
  resource: null,
  module: null,
}

/** Register an ancestor relationship for an ffi-ir kind added by an
 * extension module — mirrors type-ir's `registerParent`. Deliberately a
 * separate registry from type-ir's own (see the file-level doc comment):
 * ffi-ir's boundary kinds and type-ir's data-shape kinds are different
 * namespaces that happen to share a mechanism, not one shared lattice. */
export function registerParent(kind: string, parent: string | null): void {
  parents[kind] = parent
}

/** Ancestor chain for an ffi-ir kind, walking `parents` to the root —
 * mirrors type-ir's `ancestors`. */
export function ancestors(kind: string): string[] {
  const chain: string[] = []
  let current = parents[kind] ?? undefined
  while (current !== undefined) {
    chain.push(current)
    current = parents[current] ?? undefined
  }
  return chain
}

/** Look up a handler for `kind`, falling back through `ancestors(kind)` when
 * no exact match exists — mirrors type-ir's `resolve`. */
export function resolve<T>(kind: string, handlers: Record<string, T>): T | undefined {
  if (kind in handlers) return handlers[kind]
  for (const ancestor of ancestors(kind)) {
    if (ancestor in handlers) return handlers[ancestor]
  }
  return undefined
}

/** Wrap an `FfiShape` with a metadata bag into an `FfiRef` — mirrors
 * type-ir's `t()`. */
export function f(shape: FfiShape, meta?: Record<string, unknown>): FfiRef {
  return { shape, meta: meta ?? {} }
}

// ============================================================================
// Shape constructors — mirrors type-ir's `types` object.
// ============================================================================

export const boundary = {
  function: (params: readonly FfiParam[], returnType: TypeRef) =>
    ({ kind: "function", params, returnType }) as const,
  method: (params: readonly FfiParam[], returnType: TypeRef, receiver: string) =>
    ({ kind: "method", params, returnType, receiver }) as const,
  resource: (name: string, methods: Record<string, FfiRef>) => ({ kind: "resource", name, methods }) as const,
  module: (name: string, functions: Record<string, FfiRef>, resources: Record<string, FfiRef>) =>
    ({ kind: "module", name, functions, resources }) as const,
}

// ============================================================================
// Provenance metadata — lineage of which ingestor/tool produced an FfiRef.
// ============================================================================

/**
 * A record of where an `FfiRef` came from — which ingestor (once ingestion
 * modules exist: a C-header parser, a `.wit` parser, etc.) or, today, which
 * hand-authored/projector-adjacent source produced it. `source` is an open
 * string tag, not a fixed union — matching the same "open kind vocabulary"
 * precedent `FfiKinds` itself uses, since enumerating every ingestor fractal
 * will ever have here would fix a vocabulary this schema otherwise leaves
 * open (e.g. `"c-header"`, `"wit-file"`, `"hand-authored"`,
 * `"wasm-bindgen-source"`). Beyond `source`, the record is an open bag —
 * callers can add whatever's useful for a given source kind (a file path, a
 * line number, a parser version, an original identifier) without a schema
 * change here, the same "conventions over contracts" precedent `FfiRef.meta`
 * itself already follows.
 */
export type Provenance = {
  readonly source: string
} & Readonly<Record<string, unknown>>

// `meta.provenance` is the recognized convention key on an `FfiRef`'s open
// metadata bag (the same bag `meta.ownership` lives in on a type-ir
// `TypeRef`, and the same bag `meta.description`/`meta.deprecated` are
// documented as living in on `FfiRef` itself — see the `FfiRef` doc comment
// above). Its natural attachment point is the `module`-level `FfiRef` — one
// module is the natural unit of "this came from one ingestion/generation
// event" — but nothing here restricts it to that level: `meta` exists on
// every `FfiRef` (function/method/resource/module alike), so a
// function-level or resource-level override is representable the same way,
// e.g. when a single module is assembled by hand from pieces stamped by
// different ingestors.
export function withProvenance(ref: FfiRef, provenance: Provenance): FfiRef {
  return { shape: ref.shape, meta: { ...ref.meta, provenance } }
}
