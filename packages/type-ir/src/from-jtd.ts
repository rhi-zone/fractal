// packages/type-ir/src/from-jtd.ts — @rhi-zone/fractal-type-ir/from-jtd
//
// FROM-direction projector: JSON Type Definition (RFC 8927) -> TypeRef.
// Mirrors from-json-schema.ts's construction style (t(), types, the same
// extension-kind constructors) and is the reverse of jtd.ts's toJtd — see
// that module's per-form comments for the forward mapping this undoes.
//
// RFC 8927 §2.2.1 defines exactly one form per schema, discriminated by
// which of the eight form-defining keywords is present (type, enum,
// elements, properties/optionalProperties, values, discriminator/mapping,
// ref) — a schema with none of those is the empty form. jtd.ts's toJtd
// additionally encodes several type-ir kinds JTD can't natively express
// (int64, never, tuple, intersection, union, stream, function, non-string
// literal `const`) as an otherwise-valid form plus a flag under
// `metadata` (§2.2.7 — metadata is the spec's own explicitly-ignored
// extension point). fromJtd reverses both: first the form itself, then
// those escape-hatch flags.
//
// Known one-way lossiness (documented rather than silently guessed away):
//   - A JTD enum form is always read back as `types.enum`, even a
//     single-member one — RFC 8927 has no separate "single literal string"
//     form, so `fromJtd(toJtd(t(types.literal("x"))))` yields
//     `types.enum(["x"])`, not the original literal. This is the same
//     information JTD itself cannot distinguish, not a bug in the reverse
//     mapping.
//   - `metadata.function: true` (jtd.ts's degrade-to-empty-form for
//     `function`) carries no params/returnType, so it reconstructs to a
//     zero-param, `unknown`-returning `function` — a placeholder, not a
//     recovery of the original signature.
//   - `metadata.tuple: true` / `metadata.intersection: true` only ever
//     recover a single member (the "first element / first member" toJtd
//     kept) — the rest were already dropped on the way out.

import { t, types, type TypeRef, type TypeShape } from "./index.ts"
import {
  bytes,
  datetime,
  duration,
  email,
  float32,
  float64,
  int8,
  int16,
  int32,
  int64,
  time,
  uint8,
  uint16,
  uint32,
  uri,
  uuid,
} from "./kinds/common.ts"
import type { Jtd } from "./jtd.ts"

export type { Jtd }

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

function objectFields(ref: TypeRef): Record<string, TypeRef> {
  return ref.shape.kind === "object" ? { ...(ref.shape as TypeShape & { kind: "object" }).fields } : {}
}

function arrayElement(ref: TypeRef): TypeRef {
  return (ref.shape as TypeShape & { kind: "array" }).element
}

// ---------------------------------------------------------------------------
// Type form (RFC 8927 §3.3.2)
// ---------------------------------------------------------------------------

// Fixed-width numeric/boolean type names with no format-dependent variants.
// `timestamp` maps to `datetime()` — see jtd.ts's `datetime`/`date` handler
// comment for why type-ir's calendar-only `date` degrades to the same JTD
// form and can't be distinguished on the way back.
const typeForms: Record<string, () => TypeRef> = {
  boolean: () => t(types.boolean),
  float32: () => float32(),
  float64: () => float64(),
  int8: () => int8(),
  uint8: () => uint8(),
  int16: () => int16(),
  uint16: () => uint16(),
  int32: () => int32(),
  uint32: () => uint32(),
  timestamp: () => datetime(),
}

// `metadata.format` values jtd.ts's string handlers stamp onto an otherwise
// plain `{ type: "string" }` form — consumed (deleted from `metadata`) when
// recognized so they don't also survive verbatim into the result's meta bag.
const stringFormats: Record<string, () => TypeRef> = {
  uuid: () => uuid(),
  uri: () => uri(),
  email: () => email(),
  time: () => time(),
  duration: () => duration(),
}

function fromTypeForm(typeName: string, metadata: Record<string, unknown>): TypeRef {
  if (typeName === "string") {
    if (metadata.contentEncoding === "base64") {
      delete metadata.contentEncoding
      return bytes()
    }
    if (typeof metadata.format === "string") {
      const known = stringFormats[metadata.format]
      if (known !== undefined) {
        delete metadata.format
        return known()
      }
    }
    return t(types.string)
  }

  const known = typeForms[typeName]
  if (known !== undefined) return known()

  // Unrecognized type name (future JTD revision, or a non-standard
  // extension) — keep it visible rather than silently guessing a kind.
  return t(types.string, { jtdType: typeName })
}

// ---------------------------------------------------------------------------
// Properties form (RFC 8927 §3.3.5)
// ---------------------------------------------------------------------------

function fromProperties(jtd: Jtd): TypeRef {
  const properties = (jtd.properties as Record<string, Jtd> | undefined) ?? {}
  const optionalProperties = (jtd.optionalProperties as Record<string, Jtd> | undefined) ?? {}

  const fields: Record<string, TypeRef> = {}
  for (const [name, schema] of Object.entries(properties)) fields[name] = fromJtd(schema)
  for (const [name, schema] of Object.entries(optionalProperties)) {
    fields[name] = withMeta(fromJtd(schema), { optional: true })
  }

  const ref = t(types.object(fields))
  // `additionalProperties` (RFC 8927 §3.3.5) is a bare boolean flag (unlike
  // JSON Schema's schema-valued keyword of the same name) — no structural
  // TypeRef equivalent, so it rides in meta like any other JTD-only
  // annotation.
  return jtd.additionalProperties === true ? withMeta(ref, { additionalProperties: true }) : ref
}

// ---------------------------------------------------------------------------
// Discriminator form (RFC 8927 §3.3.7) — a tagged union. Each `mapping`
// entry is itself a properties-form schema that does NOT include the
// discriminator field (the tag is implicit); reconstruct it explicitly as a
// string-literal field on each variant so the union is self-describing
// structurally, mirroring from-json-schema.ts's oneOf+discriminator handling
// (same `meta.discriminator` convention).
// ---------------------------------------------------------------------------

function fromDiscriminator(jtd: Jtd): TypeRef {
  const discriminator = String(jtd.discriminator)
  const mapping = (jtd.mapping as Record<string, Jtd> | undefined) ?? {}

  const variants: TypeRef[] = Object.entries(mapping).map(([tag, schema]) => {
    const variantRef = fromJtd(schema)
    return t(types.object({ [discriminator]: t(types.literal(tag)), ...objectFields(variantRef) }))
  })

  return withMeta(t(types.union(variants)), { discriminator })
}

// ---------------------------------------------------------------------------
// Form dispatch (RFC 8927 §2.2.1 — exactly one of these keyword sets
// determines the form) + escape-hatch metadata flags (see module doc above).
// `metadata` is mutated in place: every key consumed to reconstruct a more
// precise TypeRef is deleted so it doesn't ALSO survive verbatim into the
// result's meta bag.
// ---------------------------------------------------------------------------

function baseFromForm(jtd: Jtd, metadata: Record<string, unknown>): TypeRef {
  if (typeof jtd.ref === "string") return t(types.ref(jtd.ref))
  if (typeof jtd.type === "string") return fromTypeForm(jtd.type, metadata)
  if (Array.isArray(jtd.enum)) return t(types.enum(jtd.enum as string[]))
  if (jtd.elements !== undefined) return t(types.array(fromJtd(jtd.elements as Jtd)))
  if (jtd.properties !== undefined || jtd.optionalProperties !== undefined) return fromProperties(jtd)
  if (jtd.values !== undefined) return t(types.map(t(types.string), fromJtd(jtd.values as Jtd)))
  if (typeof jtd.discriminator === "string" && jtd.mapping !== undefined) return fromDiscriminator(jtd)
  // Empty form (RFC 8927 §3.3.1) — matches anything.
  return t(types.unknown)
}

function applyEscapeHatches(base: TypeRef, metadata: Record<string, unknown>): TypeRef {
  let result = base

  if (metadata.type === "int64") {
    result = int64()
    delete metadata.type
  }
  if (metadata.never === true) {
    result = t(types.never)
    delete metadata.never
  }
  if (metadata.const !== undefined) {
    result = t(types.literal(metadata.const as string | number | boolean | null))
    delete metadata.const
  }
  if (metadata.function === true) {
    result = t(types.function([], t(types.unknown)))
    delete metadata.function
  }
  if (Array.isArray(metadata.union)) {
    result = t(types.union((metadata.union as Jtd[]).map(fromJtd)))
    delete metadata.union
  }
  if (metadata.tuple === true && result.shape.kind === "array") {
    result = t(types.tuple([arrayElement(result)]))
    delete metadata.tuple
  }
  if (metadata.intersection === true) {
    result = t(types.intersection([result]))
    delete metadata.intersection
  }
  if (metadata.stream === true && result.shape.kind === "array") {
    result = t(types.stream(arrayElement(result)))
    delete metadata.stream
  }

  return result
}

/**
 * Convert a single JTD schema (RFC 8927) to a `TypeRef`. Reverse of
 * jtd.ts's `toJtd` — see the module doc above for the escape-hatch
 * metadata flags this undoes and the one JTD form (enum) that can't
 * round-trip a `literal` back exactly.
 *
 * Does not resolve `definitions`/`ref` — a `ref` form always becomes
 * `types.ref(target)`, unresolved, matching from-json-schema.ts's `$ref`
 * handling. Use `fromJtdDocument` to convert a root schema's
 * `definitions` into a `TypeRefDocument`'s `defs` alongside it.
 */
export function fromJtd(jtd: Jtd): TypeRef {
  const metadata: Record<string, unknown> = { ...((jtd.metadata as Record<string, unknown> | undefined) ?? {}) }
  const nullable = jtd.nullable === true

  const base = applyEscapeHatches(baseFromForm(jtd, metadata), metadata)

  // jtd.ts's null/void handlers both degrade to exactly `{ nullable: true }`
  // (empty form, forced nullable, no metadata) — indistinguishable from each
  // other on the way back, so prefer `null`, same convention
  // from-json-schema.ts's forward direction already settled on ("void
  // projects forward to null; null round-trips to null, not void").
  if (base.shape.kind === "unknown" && nullable && Object.keys(metadata).length === 0) {
    return t(types.null)
  }

  let result = base
  if (Object.keys(metadata).length > 0) result = withMeta(result, metadata)
  if (nullable) result = withMeta(result, { nullable: true })
  return result
}

/**
 * Convert a root JTD schema plus its `definitions` (RFC 8927 §2.2.1's
 * document-level reuse mechanism) into a `TypeRefDocument`: `root` from the
 * schema itself (with `definitions` stripped before conversion — it's not a
 * form-defining keyword), `defs` from converting each named definition the
 * same way. Ref forms inside either are left as unresolved `types.ref`
 * targets, resolvable against the returned `defs` via `resolveRef`
 * (index.ts).
 */
export function fromJtdDocument(jtd: Jtd): { root: TypeRef; defs: Record<string, TypeRef> } {
  const { definitions, ...rest } = jtd
  const defs: Record<string, TypeRef> = {}
  for (const [name, schema] of Object.entries((definitions as Record<string, Jtd> | undefined) ?? {})) {
    defs[name] = fromJtd(schema)
  }
  return { root: fromJtd(rest), defs }
}
