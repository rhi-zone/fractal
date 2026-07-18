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
  // (`className`/`source`), never structure. Deliberately NOT a subtype of
  // `object` (see `parents` below): a class's fields are only half its
  // surface (methods are the other half, and often the point), so exposing
  // `fields` here would misrepresent the type as plain data. Projectors
  // that can express nominal identity read `className` (Zod's
  // `z.instanceof`, JSON Schema's `x-class-name`); projectors that can't
  // (protobuf, Cap'n Proto, SQL — anything that needs a structural shape to
  // emit) have no ancestor to fall back on and must degrade explicitly
  // (opaque/`Any`-like placeholder) rather than silently rendering an
  // object with no fields.
  instance: {
    readonly kind: "instance"
    readonly className: string
    readonly source: string
  }
  array: { readonly kind: "array"; readonly element: TypeRef }
  tuple: { readonly kind: "tuple"; readonly elements: readonly TypeRef[] }
  map: { readonly kind: "map"; readonly key: TypeRef; readonly value: TypeRef }
  union: { readonly kind: "union"; readonly variants: readonly TypeRef[] }
  literal: { readonly kind: "literal"; readonly value: string | number | boolean | null }
  enum: { readonly kind: "enum"; readonly members: readonly string[] }
  ref: { readonly kind: "ref"; readonly target: string }
  intersection: { readonly kind: "intersection"; readonly members: readonly TypeRef[] }
  // A callable type: ordered parameters, a return type, and an optional
  // `this` binding (present for class methods and other functions with an
  // explicit/implicit `this` — e.g. `types.instance("ClassName", source)`;
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
  instance: (className: string, source: string) => ({ kind: "instance", className, source }) as const,
  array: (element: TypeRef) => ({ kind: "array", element }) as const,
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
