// Core structural + universal-primitive kinds only. Semantic refinements
// (int32/int64, float32/float64, uuid/uri, datetime/date/time, duration,
// bytes, …) are independently importable extension modules under
// src/kinds/* that augment this interface via declaration merging and
// register their parent relationship with registerParent() below — see
// src/kinds/common.ts for the full pre-1.0 vocabulary bundled with this
// package.
export interface TypeKinds {
  boolean: { readonly kind: "boolean" }
  number: { readonly kind: "number" }
  integer: { readonly kind: "integer" }
  string: { readonly kind: "string" }
  null: { readonly kind: "null" }
  void: { readonly kind: "void" }
  unknown: { readonly kind: "unknown" }
  never: { readonly kind: "never" }
  object: { readonly kind: "object"; readonly fields: Readonly<Record<string, TypeRef>> }
  // A class instance — purely nominal, carrying only class identity
  // (`className`/`declarationFile`), never structure. Deliberately NOT a
  // subtype of `object` (see `parents` below): a class's fields are only
  // half its surface (methods are the other half, and often the point), so
  // exposing `fields` here would misrepresent the type as plain data.
  // Projectors that can express nominal identity read `className` (Zod's
  // `z.instanceof`, JSON Schema's `x-class-name`); projectors that can't
  // (protobuf, Cap'n Proto, SQL — anything that needs a structural shape to
  // emit) have no ancestor to fall back on and must degrade explicitly
  // (opaque/`Any`-like placeholder) rather than silently rendering an
  // object with no fields.
  //
  // `className` is kept distinct from `meta.typeName` (see below) —
  // nominal class-instance identity and a named-type reference for codegen
  // imports are different mechanisms that happen to both carry a name — but
  // `declarationFile` (the declaring file's path) is the SAME concept
  // `meta.declarationFile` names, so the two are aligned on that one field.
  instance: {
    readonly kind: "instance"
    readonly className: string
    readonly declarationFile: string
  }
  array: { readonly kind: "array"; readonly element: TypeRef }
  // An asynchronously-produced sequence of values — TypeScript's
  // `AsyncIterable<T>`/`AsyncGenerator<T, TReturn, TNext>` (and the
  // `AsyncIterableIterator<T>` an `async function*` returns), or a server-
  // streaming gRPC/service response. Deliberately NOT a subtype of `array`:
  // an array is a materialized, synchronously-indexable collection, while a
  // stream is an ongoing production of values over time — collapsing the two
  // would misrepresent backpressure/laziness semantics that matter to
  // projectors capable of expressing them natively (TypeScript's
  // `AsyncIterable<T>`, GraphQL subscriptions, gRPC server-streaming RPCs).
  // Projectors without a native streaming construct degrade to their array/
  // list equivalent over the element type (same honest-degrade convention
  // `instance`/`interface` use elsewhere in this file), since a stream's
  // element type is still the closest structural analogue once the
  // asynchrony/laziness itself can't be preserved.
  stream: { readonly kind: "stream"; readonly element: TypeRef }
  // A paginated collection — TypeScript's `CursorPage<T>`/`OffsetPage<T>`/
  // `Page<T>` convention (`@rhi-zone/fractal-api-tree`'s pagination types): a
  // handler returning one of these shapes (or `Promise<...>` of one) signals
  // "this endpoint is paginated," the same convention-detection role
  // `AsyncIterable<T>` plays for `stream` above. `style` records which
  // variant was matched — `"cursor"` for `CursorPage<T>` (an opaque
  // `cursor`/`hasMore` continuation token) or `"offset"` for `OffsetPage<T>`
  // (a numeric `offset`/`total`/`hasMore` window). Deliberately NOT a subtype
  // of `array` (same reasoning as `stream`): a page is one WINDOW over a
  // larger, not-yet-fetched collection, not the collection itself — a
  // projector that can't express pagination natively degrades to its
  // array/list equivalent over `element` (the page's item type), same
  // honest-degrade convention `stream` uses.
  page: { readonly kind: "page"; readonly element: TypeRef; readonly style: "cursor" | "offset" }
  tuple: { readonly kind: "tuple"; readonly elements: readonly TypeRef[] }
  map: { readonly kind: "map"; readonly key: TypeRef; readonly value: TypeRef }
  union: { readonly kind: "union"; readonly variants: readonly TypeRef[] }
  literal: { readonly kind: "literal"; readonly value: string | number | boolean | null }
  // A closed set of string members with no associated payload — the same
  // information a `union` of same-valued `literal` strings would carry, kept
  // as a distinct kind because most target languages have a native construct
  // for it (TS/Kotlin/Swift/Rust string enums, protobuf/Cap'n Proto `enum`)
  // that a projector would rather emit directly than reconstruct by pattern-
  // matching a literal union. `members` is `readonly string[]` only — numeric
  // and mixed-type enums (e.g. a TS numeric enum) don't fit this kind and
  // lower to `union` of `literal` instead (see
  // `from-typescript.ts`'s union-lowering: search "numeric TS enums").
  enum: { readonly kind: "enum"; readonly members: readonly string[] }
  ref: { readonly kind: "ref"; readonly target: string }
  intersection: { readonly kind: "intersection"; readonly members: readonly TypeRef[] }
  // A callable type: ordered parameters, a return type, and an optional
  // `this` binding (present for class methods and other functions with an
  // explicit/implicit `this` — e.g. `types.instance("ClassName", declarationFile)`;
  // absent for free functions with no `this`). Deliberately NOT a subtype of
  // anything — see `parents` below. Not used to inline class methods onto
  // `instance` (which stays purely nominal); this kind is for callable types
  // that appear in type positions (callback params, fields, etc.).
  function: {
    readonly kind: "function"
    readonly params: readonly { readonly name: string; readonly type: TypeRef }[]
    readonly returnType: TypeRef
    readonly thisType?: TypeRef
  }
  // A callable that belongs to a type's contract — not a standalone callable
  // (that's `function`), but the shape of one entry in a service/interface's
  // method surface. Same fields as `function` (params/returnType/thisType)
  // because a method IS a callable; `registerParent("method", "function")`
  // below means any projector without an explicit `method` handler falls back
  // to its `function` handler automatically (see `resolve`). Kept distinct
  // from `function` so projectors that DO care about the difference (protobuf
  // RPCs, Cap'n Proto interface methods, TypeScript method-signature syntax
  // vs. arrow-function syntax) can special-case it.
  method: {
    readonly kind: "method"
    readonly params: readonly { readonly name: string; readonly type: TypeRef }[]
    readonly returnType: TypeRef
    readonly thisType?: TypeRef
  }
  // A type that carries methods — the equivalent of Protobuf's `service` or
  // Cap'n Proto's `interface`: not data, a contract of callable operations.
  // Structural (no name of its own — naming is a declaration concern, same as
  // `object`). `methods` are TypeRefs, typically (but not necessarily) of
  // `method` kind. Deliberately NOT a subtype of `object` (see `instance`'s
  // doc comment above for the parallel reasoning) — an interface's methods
  // are not `object` fields, and projectors that can't express a service
  // surface must degrade explicitly rather than silently rendering an object.
  interface: {
    readonly kind: "interface"
    readonly methods: Readonly<Record<string, TypeRef>>
  }
}

export type TypeShape = TypeKinds[keyof TypeKinds]

export type TypeRef = {
  readonly shape: TypeShape
  readonly meta: Readonly<Record<string, unknown>>
}

// `meta` is an open bag — these are conventions read by consumers, not
// hard-typed fields (see design-philosophy: open metadata bag over fixed
// schema). Recognized conventions include:
//   - `meta.optional: boolean` — the field may be omitted (set via `partial`/
//     `required`/`deepPartial`/`deepRequired` in derive.ts).
//   - `meta.nullable: boolean` — the type additionally accepts `null` (set via
//     the `nullable()` helper in derive.ts).
//   - `meta.readonly: boolean` — the field is read-only/immutable and should
//     not be reassigned after construction. Set on a field's TypeRef (e.g. by
//     extractors reading a TS `readonly` modifier); consumed by projectors
//     that can express it (e.g. TypeScript's `readonly` keyword, JSON
//     Schema/OpenAPI's `readOnly: true`).
//   - `meta.typeName: string` + `meta.declarationFile: string` — a top-level
//     TypeRef's NAMED-type provenance (set by
//     `@rhi-zone/fractal-api-tree`'s `typeRefFromFunctionNode` when a
//     handler's parameter type is a declared alias/interface, not an inline
//     object literal). `declarationFile` is the absolute path of the file
//     `typeName` is declared in. Consumed by codegen that needs to reference
//     the type by name instead of inlining its structure — e.g.
//     `compileValidatorModule`'s generated type-guard annotations, which
//     `import type { typeName } from "…"` (path resolved by the caller,
//     which alone knows the emitted module's own location) when both are
//     present, and inline the structural TypeScript rendering otherwise.
//
//   - `meta.additionalProperties: boolean` — JSON-Schema-04/07/OpenAPI-style
//     closedness flag on an `object`-kind ref (`=== false` means "no extra
//     keys allowed"). Read by `compile.ts` and `standard-schema.ts`.
//   - `meta.additionalPropertyType: TypeRef` — the inferred value type for a
//     record's dynamic/varying keys, alongside its stable fields, set by
//     `from-json-corpus.ts` when it detects a mixed record+dict shape. Kept
//     as a distinct key from `meta.additionalProperties` above (they used to
//     collide under the same name with type-incompatible meanings — a
//     boolean flag vs. a TypeRef — see TODO.md's "Type-ir semantic types
//     cleanup" entry for history). No projector currently reads this
//     `TypeRef` back out (json-schema*.ts/openapi*.ts instead convert an
//     object-with-schema `additionalProperties` straight to `types.map` on
//     ingest, bypassing this meta key entirely); it's inert beyond
//     `from-json-corpus.ts`'s own tests today.

const parents: Record<string, string | null> = {
  boolean: null,
  number: null,
  integer: "number",
  string: null,
  null: null,
  void: null,
  unknown: null,
  never: null,
  object: null,
  // NOT a subtype of `object` — see the TypeKinds.instance doc comment above.
  instance: null,
  array: null,
  // NOT a subtype of `array` — see TypeKinds.stream doc comment above.
  stream: null,
  // NOT a subtype of `array` — see TypeKinds.page doc comment above.
  page: null,
  tuple: null,
  map: null,
  union: null,
  literal: null,
  enum: null,
  ref: null,
  intersection: null,
  function: null,
  // A method IS a callable — projectors without an explicit `method` handler
  // fall back to their `function` handler (see TypeKinds.method doc comment).
  method: "function",
  // NOT a subtype of `object` — see TypeKinds.interface doc comment above.
  interface: null,
}

export function registerParent(kind: string, parent: string | null): void {
  parents[kind] = parent
}

export function ancestors(kind: string): string[] {
  const chain: string[] = []
  let current = parents[kind] ?? undefined
  while (current !== undefined) {
    chain.push(current)
    current = parents[current] ?? undefined
  }
  return chain
}

export function resolve<T>(
  kind: string,
  handlers: Record<string, T>,
): T | undefined {
  if (kind in handlers) return handlers[kind]
  for (const ancestor of ancestors(kind)) {
    if (ancestor in handlers) return handlers[ancestor]
  }
  return undefined
}

export function t(shape: TypeShape, meta?: Record<string, unknown>): TypeRef {
  return { shape, meta: meta ?? {} }
}

export const types = {
  boolean: { kind: "boolean" } as const,
  number: { kind: "number" } as const,
  integer: { kind: "integer" } as const,
  string: { kind: "string" } as const,
  null: { kind: "null" } as const,
  void: { kind: "void" } as const,
  unknown: { kind: "unknown" } as const,
  never: { kind: "never" } as const,
  object: (fields: Record<string, TypeRef>) => ({ kind: "object", fields }) as const,
  instance: (className: string, declarationFile: string) => ({ kind: "instance", className, declarationFile }) as const,
  array: (element: TypeRef) => ({ kind: "array", element }) as const,
  stream: (element: TypeRef) => ({ kind: "stream", element }) as const,
  page: (element: TypeRef, style: "cursor" | "offset") => ({ kind: "page", element, style }) as const,
  tuple: (elements: readonly TypeRef[]) => ({ kind: "tuple", elements }) as const,
  map: (key: TypeRef, value: TypeRef) => ({ kind: "map", key, value }) as const,
  union: (variants: readonly TypeRef[]) => ({ kind: "union", variants }) as const,
  literal: (value: string | number | boolean | null) => ({ kind: "literal", value }) as const,
  enum: (members: readonly string[]) => ({ kind: "enum", members }) as const,
  ref: (target: string) => ({ kind: "ref", target }) as const,
  intersection: (members: readonly TypeRef[]) => ({ kind: "intersection", members }) as const,
  function: (
    params: readonly { name: string; type: TypeRef }[],
    returnType: TypeRef,
    thisType?: TypeRef,
  ) =>
    thisType === undefined
      ? ({ kind: "function", params, returnType } as const)
      : ({ kind: "function", params, returnType, thisType } as const),
  method: (
    params: readonly { name: string; type: TypeRef }[],
    returnType: TypeRef,
    thisType?: TypeRef,
  ) =>
    thisType === undefined
      ? ({ kind: "method", params, returnType } as const)
      : ({ kind: "method", params, returnType, thisType } as const),
  interface: (methods: Record<string, TypeRef>) => ({ kind: "interface", methods }) as const,
}

export { partial, required, pick, omit, extend, nullable, withMeta, deepPartial, deepRequired } from "./derive.ts"

// ============================================================================
// TypeRefDocument — a self-contained TypeRef plus named definitions.
//
// `ref: { kind: "ref"; target: string }` has always existed as the recursive-
// type marker, but until now `target` was a bare name with nothing to resolve
// against — an external registry was implied but never modeled. `defs` closes
// that gap: a `TypeRefDocument` carries its own `root` TypeRef plus every
// named definition `ref`s in the tree point into, keyed by name. Recursive
// types (and, per a caller's own `shouldShare` heuristic — see api-tree's
// extractor — types reused enough to be worth sharing structurally) live in
// `defs`; a recursive def's own body contains a `ref` back to its own name.
//
// Backwards compatibility: every function that historically took a bare
// `TypeRef` keeps working unchanged — a `TypeRef` with no `defs` is simply a
// document with no shared definitions (`{ target }` refs it contains, if any,
// are just unresolvable, exactly as before this change). `typeRefDocument()`
// below is the wrap-a-bare-TypeRef helper for callers that want to start
// threading `defs` through.
// ============================================================================

export type TypeRefDocument = {
  readonly root: TypeRef
  readonly defs: Readonly<Record<string, TypeRef>>
}

/** Wrap a bare `TypeRef` (optionally with `defs`) into a `TypeRefDocument`. */
export function typeRefDocument(root: TypeRef, defs?: Record<string, TypeRef>): TypeRefDocument {
  return { root, defs: defs ?? {} }
}

/** Duck-types `v` as a `TypeRef` — every `TypeRef` carries `shape.kind` +
 * `meta`, which no other value shape appearing inside a `TypeShape` does
 * (plain strings, arrays of `{ name, type }` params, etc.). Used by
 * `childTypeRefs` to walk an arbitrary (possibly extension-registered) kind's
 * shape generically, without a per-kind switch. */
function isTypeRef(v: unknown): v is TypeRef {
  if (typeof v !== "object" || v === null) return false
  const shape = (v as { shape?: unknown }).shape
  return (
    "meta" in v &&
    typeof shape === "object" &&
    shape !== null &&
    typeof (shape as { kind?: unknown }).kind === "string"
  )
}

/**
 * The immediate TypeRef children of a shape — generic over kind, so a kind
 * registered by an extension module (src/kinds/*, or a consumer's own
 * declaration merge) is walked correctly without this file knowing its name.
 * Every built-in kind's TypeRef-valued fields fall into one of three shapes:
 * a bare TypeRef (`array.element`, `map.key`/`value`, …), an array of TypeRef
 * or `{ name, type: TypeRef }` (`tuple.elements`, `union.variants`,
 * `function.params`, …), or a `Record<string, TypeRef>` (`object.fields`,
 * `interface.methods`). `ref.target` is a plain string, not a TypeRef, so refs
 * contribute no children here — walking root+defs can never cycle structurally.
 */
export function childTypeRefs(shape: TypeShape): TypeRef[] {
  const out: TypeRef[] = []
  for (const value of Object.values(shape)) {
    if (isTypeRef(value)) {
      out.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isTypeRef(item)) {
          out.push(item)
        } else if (typeof item === "object" && item !== null && isTypeRef((item as { type?: unknown }).type)) {
          out.push((item as { type: TypeRef }).type)
        }
      }
    } else if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value)) {
        if (isTypeRef(nested)) out.push(nested)
      }
    }
  }
  return out
}

/** Count of TypeRef nodes in a subtree (the node itself + every descendant
 * reachable without crossing a `ref` — refs don't expand structurally, see
 * `childTypeRefs`). Used by the default `shouldShare` heuristic (see api-tree's
 * extractor) to decide whether a reused type is big enough to be worth sharing
 * via `defs` rather than inlining at every use site. */
export function nodeCount(node: TypeRef): number {
  let count = 1
  for (const child of childTypeRefs(node.shape)) count += nodeCount(child)
  return count
}

/** Resolve a `{ kind: "ref"; target }` TypeRef against a document's `defs`.
 * Throws if the target is missing — an unresolvable ref is a malformed
 * document, not a valid "no-op" state (unlike a bare `TypeRef` with no `defs`
 * at all, which simply never contains a ref in the first place for callers
 * that don't produce one). Non-ref input is returned unchanged. */
export function resolveRef(doc: TypeRefDocument, ref: TypeRef): TypeRef {
  if (ref.shape.kind !== "ref") return ref
  const target = (ref.shape as TypeShape & { kind: "ref"; target: string }).target
  const resolved = doc.defs[target]
  if (resolved === undefined) {
    throw new Error(`resolveRef: unresolved ref target "${target}" (no such entry in defs)`)
  }
  return resolved
}

/** Per-node context handed to a `walkTypeRef` visitor. */
export interface WalkContext {
  /** Nodes on the path from the walk's starting point (`root`, or a `defs`
   * entry's own root when walking that entry) down to — but not including —
   * the current node. Does NOT descend through unresolved `ref`s (see
   * `childTypeRefs`); a visitor that manually resolves a ref via
   * `resolveRef` and walks the result can use `isRecursionTarget` on that
   * resolved node to detect having come full circle. */
  ancestors: readonly TypeRef[]
  /** `resolveRef(doc, ref)` bound to this walk's document. */
  resolveRef(ref: TypeRef): TypeRef
  /** True when `node` is reference-equal to one of `ancestors` — i.e.
   * revisiting it (typically after a caller-driven `resolveRef`) would
   * recurse infinitely. */
  isRecursionTarget(node: TypeRef): boolean
}

/**
 * Depth-first walk of a `TypeRefDocument`: every node reachable from `root`,
 * followed by every node reachable from each `defs` entry (each starting its
 * own `ancestors` chain from empty, since a def is an independent named root,
 * not structurally nested under `root`). `visitor` is invoked once per node,
 * pre-order; its return value is not collected (a caller after a fold should
 * accumulate into a closed-over variable — the walk itself is for its side
 * effects, e.g. the extractor's use-count tracking or compile.ts's per-def
 * codegen).
 */
export function walkTypeRef(doc: TypeRefDocument, visitor: (node: TypeRef, ctx: WalkContext) => void): void {
  const boundResolveRef = (ref: TypeRef) => resolveRef(doc, ref)
  function visit(node: TypeRef, ancestors: readonly TypeRef[]): void {
    const ctx: WalkContext = {
      ancestors,
      resolveRef: boundResolveRef,
      isRecursionTarget: (n) => ancestors.includes(n),
    }
    visitor(node, ctx)
    const nextAncestors = [...ancestors, node]
    for (const child of childTypeRefs(node.shape)) visit(child, nextAncestors)
  }
  visit(doc.root, [])
  for (const name of Object.keys(doc.defs)) visit(doc.defs[name]!, [])
}

// ============================================================================
// AOT validator codegen projector
//
// compile.ts (TypeRef -> standalone check/errors/parse validator code, no
// runtime dependency) is a type-ir projector, so it lives alongside the other
// 20+ projectors. The extractor (extract.ts,
// TS source -> TypeRef), the tree walker (tree.ts, source-level api()/op()
// walk), the build orchestrator (build.ts), and the `fractal-api-tree`
// build/watch/stub/check CLI (cli.ts) live in @rhi-zone/fractal-api-tree
// instead — they walk api()/op() AUTHORING source, which is api-tree's
// concern, not type-ir's.
// ============================================================================

export { compileValidator, compileValidatorModule, typeRefToString, type ValidationError } from "./compile.ts"
