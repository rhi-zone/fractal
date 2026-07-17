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
  array: { readonly kind: "array"; readonly element: TypeRef }
  tuple: { readonly kind: "tuple"; readonly elements: readonly TypeRef[] }
  map: { readonly kind: "map"; readonly key: TypeRef; readonly value: TypeRef }
  union: { readonly kind: "union"; readonly variants: readonly TypeRef[] }
  literal: { readonly kind: "literal"; readonly value: string | number | boolean | null }
  enum: { readonly kind: "enum"; readonly members: readonly string[] }
  ref: { readonly kind: "ref"; readonly target: string }
  intersection: { readonly kind: "intersection"; readonly members: readonly TypeRef[] }
}

export type TypeShape = TypeKinds[keyof TypeKinds]

export type TypeRef = {
  readonly shape: TypeShape
  readonly meta: Readonly<Record<string, unknown>>
}

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
  array: null,
  tuple: null,
  map: null,
  union: null,
  literal: null,
  enum: null,
  ref: null,
  intersection: null,
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
  array: (element: TypeRef) => ({ kind: "array", element }) as const,
  tuple: (elements: readonly TypeRef[]) => ({ kind: "tuple", elements }) as const,
  map: (key: TypeRef, value: TypeRef) => ({ kind: "map", key, value }) as const,
  union: (variants: readonly TypeRef[]) => ({ kind: "union", variants }) as const,
  literal: (value: string | number | boolean | null) => ({ kind: "literal", value }) as const,
  enum: (members: readonly string[]) => ({ kind: "enum", members }) as const,
  ref: (target: string) => ({ kind: "ref", target }) as const,
  intersection: (members: readonly TypeRef[]) => ({ kind: "intersection", members }) as const,
}

export { partial, required, pick, omit, extend, nullable, withMeta, deepPartial, deepRequired } from "./derive.ts"

// ============================================================================
// AOT validator codegen projector
//
// compile.ts (TypeRef -> TypeBox validator code) is a type-ir projector, so
// it lives alongside the other 20+ projectors. The extractor (extract.ts,
// TS source -> TypeRef), the tree walker (tree.ts, source-level api()/op()
// walk), the build orchestrator (build.ts), and the `fractal-api-tree`
// build/watch/stub/check CLI (cli.ts) live in @rhi-zone/fractal-api-tree
// instead — they walk api()/op() AUTHORING source, which is api-tree's
// concern, not type-ir's.
// ============================================================================

export { buildSchema, compileValidator, compileValidatorModule } from "./compile.ts"
