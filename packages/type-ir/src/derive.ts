// Type derivation operators — pure functions that transform TypeRefs into new
// TypeRefs. These operate at the TypeRef level (not per-projection), so every
// projector benefits automatically.

import { t, type TypeRef, type TypeShape } from "./index.ts"

function isObjectShape(ref: TypeRef): ref is TypeRef & { shape: { kind: "object"; fields: Readonly<Record<string, TypeRef>> } } {
  return ref.shape.kind === "object"
}

/** All fields become optional (`meta.optional = true`). Non-object refs pass through unchanged. */
export function partial(ref: TypeRef): TypeRef {
  if (!isObjectShape(ref)) return ref
  const fields: Record<string, TypeRef> = {}
  for (const [key, fieldRef] of Object.entries(ref.shape.fields)) {
    fields[key] = t(fieldRef.shape, { ...fieldRef.meta, optional: true })
  }
  return t({ kind: "object", fields }, ref.meta)
}

/** Inverse of `partial` — all fields become required (`meta.optional` removed). Non-object refs pass through unchanged. */
export function required(ref: TypeRef): TypeRef {
  if (!isObjectShape(ref)) return ref
  const fields: Record<string, TypeRef> = {}
  for (const [key, fieldRef] of Object.entries(ref.shape.fields)) {
    const { optional: _optional, ...rest } = fieldRef.meta
    fields[key] = t(fieldRef.shape, rest)
  }
  return t({ kind: "object", fields }, ref.meta)
}

/** Keep only the named fields. Missing keys are silently skipped (conventions, not contracts). Non-object refs pass through unchanged. */
export function pick(ref: TypeRef, keys: string[]): TypeRef {
  if (!isObjectShape(ref)) return ref
  const fields: Record<string, TypeRef> = {}
  for (const key of keys) {
    if (key in ref.shape.fields) fields[key] = ref.shape.fields[key]!
  }
  return t({ kind: "object", fields }, ref.meta)
}

/** Drop the named fields. Missing keys are silently skipped. Non-object refs pass through unchanged. */
export function omit(ref: TypeRef, keys: string[]): TypeRef {
  if (!isObjectShape(ref)) return ref
  const omitSet = new Set(keys)
  const fields: Record<string, TypeRef> = {}
  for (const [key, fieldRef] of Object.entries(ref.shape.fields)) {
    if (!omitSet.has(key)) fields[key] = fieldRef
  }
  return t({ kind: "object", fields }, ref.meta)
}

/**
 * Merge two object TypeRefs — extension fields override base fields with the
 * same name. If either side isn't an object, the extension wins outright
 * (last-write-wins, no error — conventions, not contracts).
 */
export function extend(base: TypeRef, extension: TypeRef): TypeRef {
  if (!isObjectShape(base) || !isObjectShape(extension)) return extension
  const fields: Record<string, TypeRef> = { ...base.shape.fields, ...extension.shape.fields }
  return t({ kind: "object", fields }, { ...base.meta, ...extension.meta })
}

/** Sets `meta.nullable = true` on the ref. */
export function nullable(ref: TypeRef): TypeRef {
  return t(ref.shape, { ...ref.meta, nullable: true })
}

/** Merge additional metadata into a TypeRef (constraints, descriptions, etc.). */
export function withMeta(ref: TypeRef, meta: Record<string, unknown>): TypeRef {
  return t(ref.shape, { ...ref.meta, ...meta })
}

function deepPartialShape(shape: TypeShape, seen: Set<TypeShape>): TypeShape {
  if (seen.has(shape)) return shape
  if (shape.kind === "object") {
    seen.add(shape)
    const fields: Record<string, TypeRef> = {}
    for (const [key, fieldRef] of Object.entries(shape.fields)) {
      fields[key] = t(deepPartialShape(fieldRef.shape, seen), { ...fieldRef.meta, optional: true })
    }
    return { kind: "object", fields }
  }
  if (shape.kind === "array") {
    seen.add(shape)
    return { kind: "array", element: t(deepPartialShape(shape.element.shape, seen), shape.element.meta) }
  }
  return shape
}

/**
 * Like `partial`, but recurses into nested object fields (and object elements
 * of arrays), making every level optional. Non-object leaf fields just get
 * `meta.optional = true`. Non-object refs pass through unchanged. Cycle-safe:
 * a shape already visited is returned as-is rather than reprocessed.
 */
export function deepPartial(ref: TypeRef): TypeRef {
  if (!isObjectShape(ref)) return ref
  return t(deepPartialShape(ref.shape, new Set()), ref.meta)
}

function deepRequiredShape(shape: TypeShape, seen: Set<TypeShape>): TypeShape {
  if (seen.has(shape)) return shape
  if (shape.kind === "object") {
    seen.add(shape)
    const fields: Record<string, TypeRef> = {}
    for (const [key, fieldRef] of Object.entries(shape.fields)) {
      const { optional: _optional, ...rest } = fieldRef.meta
      fields[key] = t(deepRequiredShape(fieldRef.shape, seen), rest)
    }
    return { kind: "object", fields }
  }
  if (shape.kind === "array") {
    seen.add(shape)
    return { kind: "array", element: t(deepRequiredShape(shape.element.shape, seen), shape.element.meta) }
  }
  return shape
}

/**
 * Inverse of `deepPartial` — recurses into nested object fields (and object
 * elements of arrays), removing `meta.optional` at every level. Non-object
 * refs pass through unchanged. Cycle-safe like `deepPartial`.
 */
export function deepRequired(ref: TypeRef): TypeRef {
  if (!isObjectShape(ref)) return ref
  return t(deepRequiredShape(ref.shape, new Set()), ref.meta)
}
