export interface TypeKinds {
  boolean: { readonly kind: "boolean" }
  number: { readonly kind: "number" }
  integer: { readonly kind: "integer" }
  int32: { readonly kind: "int32" }
  int64: { readonly kind: "int64" }
  float32: { readonly kind: "float32" }
  float64: { readonly kind: "float64" }
  string: { readonly kind: "string" }
  uuid: { readonly kind: "uuid" }
  uri: { readonly kind: "uri" }
  datetime: { readonly kind: "datetime" }
  date: { readonly kind: "date" }
  time: { readonly kind: "time" }
  duration: { readonly kind: "duration" }
  bytes: { readonly kind: "bytes" }
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
  int32: "integer",
  int64: "integer",
  float32: "number",
  float64: "number",
  string: null,
  uuid: "string",
  uri: "string",
  datetime: "string",
  date: "string",
  time: "string",
  duration: "string",
  bytes: null,
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
  int32: { kind: "int32" } as const,
  int64: { kind: "int64" } as const,
  float32: { kind: "float32" } as const,
  float64: { kind: "float64" } as const,
  string: { kind: "string" } as const,
  uuid: { kind: "uuid" } as const,
  uri: { kind: "uri" } as const,
  datetime: { kind: "datetime" } as const,
  date: { kind: "date" } as const,
  time: { kind: "time" } as const,
  duration: { kind: "duration" } as const,
  bytes: { kind: "bytes" } as const,
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
}

export { partial, required, pick, omit, extend, nullable, withMeta, deepPartial, deepRequired } from "./derive.ts"
