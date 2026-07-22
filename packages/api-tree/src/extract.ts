// packages/api-tree/src/extract.ts — @rhi-zone/fractal-api-tree
//
// BUILD-TIME EXTRACTOR: types + JSDoc are the truth. This module reads op
// source (via the TypeScript compiler API — read-only analysis, NOT a
// transformer) and DERIVES two things a runtime projection cannot see:
//
//   1. a JSON-Schema for an op's input parameter type
//   2. the op's leading JSDoc description text
//
// Scope: obvious shapes only. Object types with primitive fields
// (string/number/boolean), optional (`?` / `| undefined`), arrays, and nested
// objects are lowered structurally. Callable types (arrow/function values,
// callback params, method-shaped fields) lower to `types.function`. Anything
// still exotic (unions, generics, constructable types, …) is PUNTED to
// `t(types.unknown, { $comment })` carrying a `$comment` that names the
// unhandled case — self-documenting rather than silently lossy. Extraction
// goes TS type → TypeRef → JSON Schema; the
// TypeRef is produced here and projected via
// `@rhi-zone/fractal-type-ir/json-schema`'s `toJsonSchema`.
//
// Derived-from-type ONLY: there is no hand-authored schema anywhere. If a shape
// isn't recovered here, it degrades to the MCP spec minimum, never to a second
// source of truth.
//
// See:
//   packages/api-tree/src/node.ts    — the op model (`op(fn, meta)`)
//   packages/mcp-api-projector/src/project.ts  — the consumer (toTools inputSchema/description)

import ts from "typescript"
import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir"
import { toJsonSchema } from "@rhi-zone/fractal-type-ir/json-schema"
import { email, uri, uuid } from "@rhi-zone/fractal-type-ir/kinds/common"

// ============================================================================
// JSON-Schema value (structural subset we emit)
// ============================================================================

/**
 * The JSON-Schema shapes this extractor produces. `$comment` carries a
 * `TODO(codegen): …` marker on any punted node so the fallback is visible in
 * the emitted value itself. Punted nodes now come from `types.unknown` via
 * the TypeRef projector, so `type` is no longer guaranteed present.
 */
export type JsonSchema = {
  type?: "string" | "number" | "boolean" | "array" | "object"
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema | false
  prefixItems?: JsonSchema[]
  additionalProperties?: JsonSchema
  const?: string | number | boolean | null
  enum?: string[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  discriminator?: { propertyName: string }
  $comment?: string
  // `description`/`default` are emitted by the underlying type-ir projector
  // (json-schema.ts's `withMeta`) whenever a TypeRef carries
  // `meta.description`/`meta.default`. `typeRefFromType` populates both per
  // object-type property from source JSDoc: a leading `/** … */` comment →
  // `description`, an `@default` tag → `default` (see `propertyDescriptionOf`
  // / `propertyDefaultOf` above). Declared here so consumers (e.g. the CLI
  // projector's help text / default-value application) can read them without
  // an `as Record<string, unknown>` escape hatch at every read site.
  description?: string
  default?: string | number | boolean
}

// ============================================================================
// Core: TypeScript type → JSON-Schema
// ============================================================================

/** The TypeRef punt: `unknown` tagged with the unhandled case. */
const puntRef = (reason: string): TypeRef =>
  t(types.unknown, { $comment: `TODO(type-ir): unhandled type — ${reason}` })

/**
 * Lower a call signature to a `types.function` TypeRef: ordered params (name +
 * type), return type, and — when the signature carries an explicit/implicit
 * `this` parameter (e.g. a class method, where it resolves to
 * `types.instance(className, source)`) — `thisType`. Free functions with no
 * `this` parameter omit it.
 */
function functionRefFromSignature(
  sig: ts.Signature,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
): TypeRef {
  const params = sig.getParameters().map((param) => ({
    name: param.name,
    type: typeRefFromType(checker.getTypeOfSymbolAtLocation(param, loc), checker, loc, seen),
  }))
  const returnType = typeRefFromType(sig.getReturnType(), checker, loc, seen)
  const thisParam = sig.thisParameter
  const thisType = thisParam
    ? typeRefFromType(checker.getTypeOfSymbolAtLocation(thisParam, loc), checker, loc, seen)
    : undefined
  return t(types.function(params, returnType, thisType))
}

/**
 * Lower ALL call signatures of a callable type to `types.function` TypeRefs.
 * TypeScript represents an overloaded function as an intersection of its call
 * signatures (`((A) => X) & ((B) => Y)`), so more than one signature wraps as
 * `types.intersection([fn1, fn2, …])` — one member per overload. A single
 * signature (the common case) keeps prior behavior exactly: a bare
 * `types.function(...)`, no intersection wrapper. `seen` is shared across all
 * signatures of the same overload set (they're siblings on the same
 * type-position, not a recursion chain, but sharing avoids re-descending a
 * type already seen via another overload).
 */
function functionRefFromSignatures(
  sigs: readonly ts.Signature[],
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
): TypeRef {
  const refs = sigs.map((sig) => functionRefFromSignature(sig, checker, loc, seen))
  return refs.length === 1 ? refs[0]! : t(types.intersection(refs))
}

/**
 * Lower a class method's call signature to a `types.method` TypeRef (not
 * `types.function` — a method belongs to the class's contract, not a
 * standalone callable; see type-ir's TypeKinds.method doc comment).
 * `thisType` is always the class's own `types.instance` ref, passed in
 * explicitly rather than read off `sig.thisParameter` — a method's `this` is
 * always its declaring class, whether or not the signature carries an
 * explicit `this` parameter.
 */
function methodRefFromSignature(
  sig: ts.Signature,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  thisType: TypeRef,
): TypeRef {
  const params = sig.getParameters().map((param) => ({
    name: param.name,
    type: typeRefFromType(checker.getTypeOfSymbolAtLocation(param, loc), checker, loc, seen),
  }))
  const returnType = typeRefFromType(sig.getReturnType(), checker, loc, seen)
  return t(types.method(params, returnType, thisType))
}

/**
 * Lower ALL call signatures of a class method (overloads) to `types.method`
 * TypeRefs, wrapped in `types.intersection` when there's more than one — same
 * overload-as-intersection convention as `functionRefFromSignatures`, applied
 * to the method kind instead of the standalone-function kind.
 */
function methodRefFromSignatures(
  sigs: readonly ts.Signature[],
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  thisType: TypeRef,
): TypeRef {
  const refs = sigs.map((sig) => methodRefFromSignature(sig, checker, loc, seen, thisType))
  return refs.length === 1 ? refs[0]! : t(types.intersection(refs))
}

/**
 * A class's method surface as a `Record<name, TypeRef>` (each a
 * `types.method`), for building a `types.interface` alongside the class's
 * `types.instance`. A property counts as a method when its own declaration is
 * a `ts.MethodDeclaration`, OR — for arrow-function class properties (`foo =
 * (x: number) => void`, declared as a `PropertyDeclaration`, not a
 * `MethodDeclaration`) — when its resolved type carries a call signature.
 * Private/protected members are skipped (the method surface is public API,
 * same convention as the object-field extraction loop below).
 */
function methodsFromClassType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  thisType: TypeRef,
): Record<string, TypeRef> {
  const methods: Record<string, TypeRef> = {}
  for (const prop of checker.getPropertiesOfType(type)) {
    if (isPrivateOrProtected(prop)) continue
    const isMethodDecl = (prop.declarations ?? []).some(ts.isMethodDeclaration)
    const propType = checker.getTypeOfSymbolAtLocation(prop, loc)
    const sigs = checker.getSignaturesOfType(propType, ts.SignatureKind.Call)
    if (!isMethodDecl && sigs.length === 0) continue
    if (sigs.length === 0) continue
    methods[prop.name] = methodRefFromSignatures(sigs, checker, loc, seen, thisType)
  }
  return methods
}

/** True for symbols with at least one private/protected declaration. */
function isPrivateOrProtected(prop: ts.Symbol): boolean {
  return (prop.declarations ?? []).some((decl) => {
    const mods = ts.getCombinedModifierFlags(decl as ts.Declaration & { kind: ts.SyntaxKind })
    return (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0
  })
}

/** True for symbols with at least one `readonly`-modified declaration. */
function isReadonly(prop: ts.Symbol): boolean {
  return (prop.declarations ?? []).some((decl) => {
    const mods = ts.getCombinedModifierFlags(decl as ts.Declaration & { kind: ts.SyntaxKind })
    return (mods & ts.ModifierFlags.Readonly) !== 0
  })
}

/**
 * A property symbol's own JSDoc comment (the `/** … *\/` text, excluding
 * `@tag` lines), flattened to a single trimmed string. Uses
 * `Symbol.getDocumentationComment`, the TS compiler API's dedicated
 * accessor for a symbol's doc comment — distinct from `extractJsDoc` below,
 * which walks AST nodes for an op's own leading JSDoc rather than a
 * property symbol's.
 */
function propertyDescriptionOf(prop: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  const text = ts.displayPartsToString(prop.getDocumentationComment(checker)).trim()
  return text.length > 0 ? text : undefined
}

/**
 * A property symbol's `@default` JSDoc tag value, if present. The tag text
 * is parsed as JSON first (`@default 10` → `10`, `@default true` → `true`,
 * `@default "x"` → `"x"`) so numeric/boolean defaults come through typed;
 * text that isn't valid JSON (`@default someValue`) is kept as a raw string.
 */
function propertyDefaultOf(prop: ts.Symbol, checker: ts.TypeChecker): string | number | boolean | undefined {
  for (const tag of prop.getJsDocTags(checker)) {
    if (tag.name !== "default") continue
    const text = tag.text ? ts.displayPartsToString(tag.text).trim() : ""
    if (text.length === 0) return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
        return parsed
      }
      return text
    } catch {
      return text
    }
  }
  return undefined
}

/**
 * JSDoc tag names carrying a refinement constraint, split by how their raw
 * tag text is parsed. Numeric tags (`@minLength 2`) parse via `Number(...)`;
 * string tags (`@pattern "^[a-z]+$"`/`@format email`) keep the raw text with
 * one layer of surrounding quotes stripped, if present. These are exactly
 * the meta keys `compile.ts` already validates and every projector
 * (json-schema, effect-schema, sql, …) already reads — see
 * `packages/type-ir/src/compile.ts` and `packages/type-ir/src/sql.ts`'s
 * shared refinement-key comment.
 */
const NUMERIC_REFINEMENT_TAGS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
])
const STRING_REFINEMENT_TAGS = new Set(["pattern", "format"])

/** Strip one layer of matching surrounding quotes (`"…"` or `'…'`), if present. */
function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1)
    }
  }
  return text
}

/**
 * A property symbol's refinement-related JSDoc tags (`@minLength`/
 * `@maxLength`/`@pattern`/`@format`/`@minimum`/`@maximum`/
 * `@exclusiveMinimum`/`@exclusiveMaximum`/`@multipleOf`), read the same way
 * as `@default` in `propertyDefaultOf` above: `Symbol.getJsDocTags`, one meta
 * entry per recognized tag present on the property. Numeric tags with
 * non-numeric/empty text are skipped rather than producing `NaN` in the meta
 * bag. Unrecognized tag names are ignored — this reads only the refinement
 * vocabulary `compile.ts` already validates, nothing broader.
 */
function propertyRefinementMetaOf(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  for (const tag of prop.getJsDocTags(checker)) {
    const text = tag.text ? ts.displayPartsToString(tag.text).trim() : ""
    if (text.length === 0) continue
    if (NUMERIC_REFINEMENT_TAGS.has(tag.name)) {
      const n = Number(text)
      if (!Number.isNaN(n)) meta[tag.name] = n
    } else if (STRING_REFINEMENT_TAGS.has(tag.name)) {
      meta[tag.name] = unquote(text)
    }
  }
  return meta
}

/** Property names conventionally used to tag a branded/opaque type. */
const BRAND_PROP_NAMES = ["__brand", "__tag", "_brand", "_tag"]

/**
 * Brand names (matched case-insensitively — `"UUID"`/`"Uuid"`/`"uuid"` all
 * hit the same entry) that promote to a real IR kind instead of degrading to
 * `t(types.string, { brand: "..." })`. See `promoteBrand` below and
 * type-ir's `kinds/semantic-strings.ts` (source of the canonical
 * `Uuid`/`Uri`/`Email` brand types a consumer authors against).
 */
const BRAND_KIND_CTORS: Record<string, (meta?: Record<string, unknown>) => TypeRef> = {
  uuid,
  uri,
  email,
}

/**
 * Promote a recognized brand to its IR kind, e.g. `string & { __brand: "uuid" }`
 * → `types.uuid` instead of `t(types.string, { brand: "uuid" })`. Only
 * applies when the base shape is `string` — every current brand-promotable
 * kind (uuid/uri/email) subtypes `string`, so a brand recognized over a
 * non-string base (a mismatched or unrelated tag reuse) is left as an
 * ordinary `meta.brand` annotation on its own base shape, never coerced.
 * Returns `undefined` for an unrecognized brand name, letting the caller
 * fall through to the plain `meta.brand` behavior.
 */
function promoteBrand(baseRef: TypeRef, brandValue: string): TypeRef | undefined {
  if (baseRef.shape.kind !== "string") return undefined
  const ctor = BRAND_KIND_CTORS[brandValue.toLowerCase()]
  if (!ctor) return undefined
  return ctor(baseRef.meta)
}

/**
 * Derive a brand name from a `unique symbol`-keyed brand property, e.g.
 * `declare const LocationIdBrand: unique symbol; type LocationId = string &
 * { readonly [LocationIdBrand]: never }`.
 *
 * Unlike the string-literal-tag pattern (`{ readonly __brand: "LocationId" }`),
 * there is no literal value to read — the symbol IS the tag, and the property's
 * value type is typically `never`. The brand name is instead read off the
 * `unique symbol` declaration's own identifier (`LocationIdBrand`), with a
 * trailing `Brand` suffix stripped for consistency with the string-literal-tag
 * convention (whose tag values are bare names like `"LocationId"`, not
 * `"LocationIdBrand"`). Returns `undefined` if the property isn't a computed
 * property name, or its expression doesn't resolve to a named symbol.
 */
function brandNameFromSymbolKeyedProp(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
): string | undefined {
  const decl = prop.declarations?.[0]
  if (!decl) return undefined
  const nameNode = (decl as ts.NamedDeclaration).name
  if (!nameNode || !ts.isComputedPropertyName(nameNode)) return undefined
  const sym = checker.getSymbolAtLocation(nameNode.expression)
  if (!sym?.name) return undefined
  return sym.name.endsWith("Brand") ? sym.name.slice(0, -"Brand".length) : sym.name
}

/**
 * Extract a literal's runtime value (string/number/boolean) from a resolved
 * `ts.Type`, or `undefined` if `type` isn't a literal. Booleans don't carry
 * `.value` on `ts.LiteralType` — they're read via `intrinsicName` instead
 * (mirrors the top-of-`typeRefFromType` literal handling).
 */
function literalValueOf(type: ts.Type): string | number | boolean | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral) return (type as ts.LiteralType).value as string
  if (type.flags & ts.TypeFlags.NumberLiteral) return (type as ts.LiteralType).value as number
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true"
  }
  return undefined
}

/**
 * True for a symbol-keyed property (`escapedName` starting `__@`, TS's
 * internal spelling for a `unique symbol`-keyed member) whose `unique
 * symbol` declaration is specifically named `RefinementTag` — the shared
 * marker every refinement-tag type in `kinds/refinements.ts` carries its
 * value under. Mirrors `brandNameFromSymbolKeyedProp`'s "read the tag off
 * the symbol declaration's own identifier" move, but confirms IDENTITY (is
 * this the refinement marker, as opposed to a brand's `BrandTag` or some
 * unrelated symbol-keyed member?) rather than deriving a brand NAME from it.
 * Declared ahead of `classifyIntersectionConstituent` so that function can
 * skip refinement-tag props instead of misreading one as an (unrecognized)
 * brand — `RefinementTag`'s value type is a literal-bearing OBJECT, not a
 * plain string literal or `never`, so left unchecked it would otherwise fall
 * into `brandNameFromSymbolKeyedProp`'s "no literal value" branch and read
 * the symbol's own name (`"RefinementTag"`) as a bogus brand.
 */
function isRefinementTagProp(prop: ts.Symbol, checker: ts.TypeChecker): boolean {
  if (!prop.escapedName.toString().startsWith("__@")) return false
  const decl = prop.declarations?.[0]
  if (!decl) return false
  const nameNode = (decl as ts.NamedDeclaration).name
  if (!nameNode || !ts.isComputedPropertyName(nameNode)) return false
  const sym = checker.getSymbolAtLocation(nameNode.expression)
  return sym?.name === "RefinementTag"
}

/** The meta keys a refinement tag's value-object properties are read from — see `kinds/refinements.ts`. */
const REFINEMENT_KEYS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const

/**
 * Read a single intersection constituent's refinement contribution, if it's
 * one of the branded refinement-tag types from
 * `@rhi-zone/fractal-type-ir/kinds/refinements` (`MinLength<2>`,
 * `Pattern<"^[a-z]+$">`, …). Each such type compiles to `{ readonly
 * [RefinementTag]: { <key>: <literal> } }` — a `unique symbol`-keyed
 * property (phantom, structurally inaccessible at runtime — same shape as a
 * symbol-keyed brand, see `brandNameFromSymbolKeyedProp`'s doc comment)
 * whose value is itself typed as a literal-bearing object. Reads the
 * literal value off every key in `REFINEMENT_KEYS` present on that inner
 * object type. Returns `undefined` when the constituent carries no
 * `RefinementTag`-keyed property, or when it does but no recognized key on
 * it resolves to a literal — i.e. this constituent isn't a refinement tag
 * at all.
 */
function refinementMetaOfConstituent(
  constituent: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): Record<string, unknown> | undefined {
  const tagProp = checker.getPropertiesOfType(constituent).find((p) => isRefinementTagProp(p, checker))
  if (!tagProp) return undefined
  const tagType = checker.getTypeOfSymbolAtLocation(tagProp, loc)
  if ((tagType.flags & ts.TypeFlags.Object) === 0) return undefined

  const meta: Record<string, unknown> = {}
  for (const key of REFINEMENT_KEYS) {
    const prop = tagType.getProperty(key)
    if (!prop) continue
    const value = literalValueOf(checker.getTypeOfSymbolAtLocation(prop, loc))
    if (value !== undefined) meta[key] = value
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

/**
 * How a single intersection constituent classifies for
 * `typeRefFromBrandedIntersection` below: a refinement-tag value-object
 * (contributes meta entries), a brand tag (contributes a brand name), or
 * neither — a genuine base-shape constituent.
 */
type IntersectionConstituentKind =
  | { kind: "refinement"; meta: Record<string, unknown> }
  | { kind: "brand"; value: string }
  | { kind: "base" }

/**
 * Classify one constituent of an intersection as a refinement tag, a brand
 * tag, or a base-shape constituent — the per-constituent building block
 * `typeRefFromBrandedIntersection` walks the whole intersection with.
 *
 * Refinement check runs first (`refinementMetaOfConstituent`, unchanged).
 * Brand detection is the same pattern-match `brandFromIntersection` used to
 * run over a fixed base/tag pairing, generalized to a single constituent:
 * only OBJECT-flagged constituents are examined (a primitive constituent —
 * `string`, `number`, … — carries its own symbol-keyed properties, e.g.
 * `Symbol.iterator`, that would otherwise spuriously match), and a
 * refinement-tag property is skipped so it isn't misread as an
 * (unrecognized) brand. Named tags (`__brand`/`__tag`/…) and shared-symbol
 * tags carry the brand name as a string-literal property value; a
 * symbol-keyed tag with no literal value (typically `never`) falls back to
 * the `unique symbol` declaration's own identifier.
 */
function classifyIntersectionConstituent(
  constituent: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): IntersectionConstituentKind {
  const refinementMeta = refinementMetaOfConstituent(constituent, checker, loc)
  if (refinementMeta) return { kind: "refinement", meta: refinementMeta }

  if (constituent.flags & ts.TypeFlags.Object) {
    for (const prop of checker.getPropertiesOfType(constituent)) {
      const isSymbolKeyed = prop.escapedName.toString().startsWith("__@")
      const isNamedBrand = BRAND_PROP_NAMES.includes(prop.name)
      if (!isSymbolKeyed && !isNamedBrand) continue
      if (isSymbolKeyed && isRefinementTagProp(prop, checker)) continue

      const propType = checker.getTypeOfSymbolAtLocation(prop, loc)
      const brandValue =
        propType.flags & ts.TypeFlags.StringLiteral
          ? ((propType as ts.LiteralType).value as string)
          : isSymbolKeyed
            ? brandNameFromSymbolKeyedProp(prop, checker)
            : undefined
      if (brandValue !== undefined) return { kind: "brand", value: brandValue }
    }
  }

  return { kind: "base" }
}

/**
 * Detect a brand tag and/or one-or-more refinement tags intersected with a
 * single base type — e.g. `string & { __brand: "LocationId" }`, `string &
 * MinLength<2> & MaxLength<100>`, or both combined, `Email & MinLength<5>`
 * (which itself expands to `string & { [BrandTag]: "email" } &
 * { [RefinementTag]: { minLength: 5 } }`, three constituents). Any
 * combination of base type, brand tag, and refinement tags in a single
 * intersection collapses here — not just the brand-only or refinement-only
 * shapes each used to be recognized by a separate, narrower function.
 *
 * Walks every constituent via `classifyIntersectionConstituent`: refinement
 * tags merge their value objects into one meta bag; a brand tag's name is
 * recorded (first one found wins — a second brand-shaped constituent is
 * treated as an unrecognized base rather than silently dropped, so it makes
 * the base count ambiguous and the whole intersection falls through instead
 * of guessing which brand is real); everything else is a candidate base
 * type. Returns `undefined` — falling through to plain structural
 * `types.intersection` handling — when there's no brand and no refinement
 * (nothing recognized here) or when more than one constituent is left over
 * as a base (an ambiguous/genuine structural intersection, e.g. a mixin
 * pattern that happens to carry no brand or refinement tag at all).
 *
 * When recognized: the base type is extracted recursively; a brand promotes
 * via `promoteBrand` (known kind name over a `string` base) or falls back to
 * plain `meta.brand`; refinement meta merges on top of whichever of those
 * produced the working TypeRef, so brand promotion and refinement meta
 * compose (`Email & MinLength<5>` → `t(types.email, { minLength: 5 })`).
 */
function typeRefFromBrandedIntersection(
  type: ts.IntersectionType,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
): TypeRef | undefined {
  const bases: ts.Type[] = []
  const refinementMeta: Record<string, unknown> = {}
  let brandValue: string | undefined

  for (const constituent of type.types) {
    const classified = classifyIntersectionConstituent(constituent, checker, loc)
    if (classified.kind === "refinement") {
      Object.assign(refinementMeta, classified.meta)
    } else if (classified.kind === "brand" && brandValue === undefined) {
      brandValue = classified.value
    } else {
      bases.push(constituent)
    }
  }

  if (brandValue === undefined && Object.keys(refinementMeta).length === 0) return undefined
  if (bases.length !== 1) return undefined

  const nextSeen = new Set(seen).add(type)
  const baseRef = typeRefFromType(bases[0]!, checker, loc, nextSeen)

  const branded =
    brandValue !== undefined
      ? (promoteBrand(baseRef, brandValue) ?? t(baseRef.shape, { ...baseRef.meta, brand: brandValue }))
      : baseRef

  return Object.keys(refinementMeta).length > 0
    ? t(branded.shape, { ...branded.meta, ...refinementMeta })
    : branded
}

/**
 * Lower a resolved `ts.Type` to a TypeRef.
 *
 * Handles the obvious cases; punts everything else to `t(types.unknown, …)`
 * carrying a `$comment` naming the case. `loc` anchors symbol-type resolution.
 *
 * `seen` tracks the chain of object-like types currently being descended
 * (ancestors on this recursion path only — siblings don't share it). Re-entering
 * a type already on the path means the type is recursive; it lowers to
 * `t(types.ref(name))` when a name is recoverable, else punts.
 */
export function typeRefFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type> = new Set(),
): TypeRef {
  if (seen.has(type)) {
    const typeName = type.aliasSymbol?.name ?? type.symbol?.name
    return typeName ? t(types.ref(typeName)) : puntRef("recursive type")
  }

  const flags = type.flags

  // ── Literals (checked before the widening StringLike/NumberLike/BooleanLike
  //    checks below, else `"active"` widens to plain `string`) ───────────────
  if (flags & ts.TypeFlags.StringLiteral) {
    return t(types.literal((type as ts.LiteralType).value as string))
  }
  if (flags & ts.TypeFlags.NumberLiteral) {
    return t(types.literal((type as ts.LiteralType).value as number))
  }
  if (flags & ts.TypeFlags.BooleanLiteral) {
    const isTrue =
      (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true"
    return t(types.literal(isTrue))
  }

  // ── Primitives ────────────────────────────────────────────────────────────
  if (flags & ts.TypeFlags.StringLike) return t(types.string)
  if (flags & ts.TypeFlags.NumberLike) return t(types.number)
  if (flags & ts.TypeFlags.BooleanLike) return t(types.boolean)
  // `void` was never reachable before function-typed return positions existed
  // (object/param extraction never produces it) — a callable's `void` return
  // now flows through here via `functionRefFromSignature`.
  if (flags & ts.TypeFlags.Void) return t(types.void)
  if (flags & ts.TypeFlags.Null) return t(types.null)

  // ── Page<T>/CursorPage<T>/OffsetPage<T> (packages/api-tree/src/page.ts) —
  //    a handler returning one of these shapes signals "this endpoint is
  //    paginated," the same convention role AsyncIterable plays for `stream`
  //    (see the Object-types section below). Checked here, BEFORE the
  //    tuple/array/union branches, via `aliasSymbol` — the alias name
  //    survives regardless of whether the ALIASED type resolves structurally
  //    to a plain object (`CursorPage<T>`/`OffsetPage<T>`) or a union
  //    (`Page<T> = CursorPage<T> | OffsetPage<T>`), and checking it early
  //    (rather than only inside the object-types branch) is what catches the
  //    union case before `type.isUnion()` below claims it first and flattens
  //    it to a structural `union` TypeRef, losing the pagination signal.
  //    `CursorPage`/`OffsetPage` resolve to their own literal style directly;
  //    the general `Page<T>` alias is ambiguous between the two (a handler
  //    typed with the reader-facing union, not one concrete variant) and
  //    defaults to `"cursor"` — the more common convention of the two, and a
  //    deliberate, documented fallback rather than a silent guess. ──────────
  if (
    type.aliasSymbol &&
    (type.aliasSymbol.name === "CursorPage" ||
      type.aliasSymbol.name === "OffsetPage" ||
      type.aliasSymbol.name === "Page")
  ) {
    const nextSeen = new Set(seen).add(type)
    const [elem] = type.aliasTypeArguments ?? []
    const style = type.aliasSymbol.name === "OffsetPage" ? "offset" : "cursor"
    return t(
      types.page(
        elem ? typeRefFromType(elem, checker, loc, nextSeen) : puntRef("unknown page element"),
        style,
      ),
    )
  }

  // ── Tuples (checked before isArrayType — tuples fail that check and would
  //    otherwise fall through to the object branch as `{"0":…,"1":…,"length":…}`) ──
  if (checker.isTupleType(type)) {
    const nextSeen = new Set(seen).add(type)
    const elements = checker.getTypeArguments(type as ts.TypeReference)
    return t(
      types.tuple(elements.map((el) => typeRefFromType(el, checker, loc, nextSeen))),
    )
  }

  // ── Arrays (T[] / Array<T>) ───────────────────────────────────────────────
  if (checker.isArrayType(type)) {
    const nextSeen = new Set(seen).add(type)
    const [elem] = checker.getTypeArguments(type as ts.TypeReference)
    return t(
      types.array(
        elem
          ? typeRefFromType(elem, checker, loc, nextSeen)
          : puntRef("unknown array element"),
      ),
    )
  }

  // ── Unions: TS enums + literal unions lower to enum/literal-union shapes;
  //    everything else genuinely structural still punts ─────────────────────
  //
  // (optional `| undefined` is stripped upstream, so a surviving union here is
  // either a TS enum (which the checker resolves to a union of its member
  // literals), a hand-written literal union (`"a" | "b"`), or a genuine union
  // of non-literal types.)
  if (type.isUnion()) {
    const members = type.types

    // `true | false` collapses to the intrinsic `boolean` type before this
    // point (TS's `getUnionType` singleton-izes it, so `flags & BooleanLike`
    // above already catches it) — this check is a defensive backstop in case
    // a differently-constructed union of the two boolean literals reaches here.
    if (
      members.length === 2 &&
      members.every((m) => (m.flags & ts.TypeFlags.BooleanLiteral) !== 0)
    ) {
      const names = new Set(
        members.map(
          (m) => (m as ts.Type & { intrinsicName?: string }).intrinsicName,
        ),
      )
      if (names.has("true") && names.has("false")) return t(types.boolean)
    }

    const allStringLiteral = members.every(
      (m) => (m.flags & ts.TypeFlags.StringLiteral) !== 0,
    )
    if (allStringLiteral) {
      return t(
        types.enum(members.map((m) => (m as ts.LiteralType).value as string)),
      )
    }

    const isLiteralMember = (m: ts.Type): boolean =>
      (m.flags &
        (ts.TypeFlags.StringLiteral |
          ts.TypeFlags.NumberLiteral |
          ts.TypeFlags.BooleanLiteral)) !==
      0

    // All-number-literal (numeric TS enums) and mixed-literal unions both
    // lower the same way: a union of `types.literal(...)` TypeRefs — the IR's
    // `enum` kind is `readonly string[]` only, so numeric/mixed cases use
    // `types.union` of literals instead.
    if (members.every(isLiteralMember)) {
      return t(types.union(members.map((m) => typeRefFromType(m, checker, loc, seen))))
    }

    // ── Object-like unions: lower to `types.union([...variants])`, each
    //    variant a full object TypeRef. When every variant shares a field
    //    name whose value is a distinct literal, that field is the
    //    discriminator — recorded as `meta.discriminator` (open metadata bag,
    //    CLAUDE.md: open metadata over fixed schema). Discriminator-aware
    //    projectors (OpenAPI 3.0's native `discriminator`, Zod's
    //    `discriminatedUnion`, Valibot's `variant`) read it; others ignore it
    //    and just emit a plain union. A union with no shared discriminator
    //    field still lowers this way (no `meta.discriminator`) — only a union
    //    with a non-object-like variant (primitive, array, callable, …)
    //    genuinely punts below.
    const isObjectLikeMember = (m: ts.Type): boolean =>
      !m.isUnion() &&
      !m.isIntersection() &&
      (m.flags & ts.TypeFlags.Object) !== 0 &&
      !checker.isArrayType(m) &&
      !checker.isTupleType(m) &&
      checker.getSignaturesOfType(m, ts.SignatureKind.Call).length === 0 &&
      checker.getSignaturesOfType(m, ts.SignatureKind.Construct).length === 0

    if (members.every(isObjectLikeMember)) {
      const nextSeen = new Set(seen).add(type)

      const fieldNameSets = members.map(
        (m) => new Set(checker.getPropertiesOfType(m).map((p) => p.name)),
      )
      const [firstNames] = fieldNameSets
      const sharedNames = firstNames
        ? [...firstNames].filter((name) => fieldNameSets.every((names) => names.has(name)))
        : []

      let discriminator: string | undefined
      for (const name of sharedNames) {
        const seenValues = new Set<string | number | boolean>()
        const distinctLiteralOnEveryVariant = members.every((m) => {
          const prop = m.getProperty(name)
          if (!prop) return false
          const value = literalValueOf(checker.getTypeOfSymbolAtLocation(prop, loc))
          if (value === undefined || seenValues.has(value)) return false
          seenValues.add(value)
          return true
        })
        if (distinctLiteralOnEveryVariant) {
          discriminator = name
          break
        }
      }

      const variants = members.map((m) => typeRefFromType(m, checker, loc, nextSeen))
      return t(types.union(variants), discriminator ? { discriminator } : {})
    }

    return puntRef(`union (${checker.typeToString(type)})`)
  }

  // ── Intersections: detect the branded/opaque and/or refinement-tag
  //    pattern (any combination, single base only), else lower structurally ──
  //
  // `type LocationId = string & { readonly __brand: "LocationId" }` compiles to
  // an IntersectionType of a primitive constituent and an object constituent
  // whose sole property is a brand tag (`__brand`/`__tag`/`_brand`/`_tag`, or a
  // unique symbol key); `string & MinLength<2> & MaxLength<100>` compiles to a
  // primitive constituent plus one or more `{ [RefinementTag]: {...} }`
  // constituents; `Email & MinLength<5>` combines both (three constituents:
  // base + brand tag + refinement tag). `typeRefFromBrandedIntersection`
  // walks all constituents and recognizes any of these combinations, so long
  // as exactly one constituent is left over as the base. When a brand is
  // recognized, and the brand name (case-insensitively) matches a known
  // semantic-string kind (`uuid`/`uri`/`email` — see `promoteBrand`/
  // `BRAND_KIND_CTORS` above and type-ir's `kinds/semantic-strings.ts`), it
  // lowers directly to that kind (`types.uuid`/`types.uri`/`types.email`)
  // instead of the primitive; any other brand name lowers to the base's
  // TypeRef with `meta.brand` set to the tag's literal string value — an
  // open-metadata-bag annotation (see CLAUDE.md: open metadata over fixed
  // schema) that brand-aware projectors (zod, typescript, valibot) read and
  // others ignore. Refinement tags merge their value-object keys into the
  // same meta bag, composing with a recognized brand or plain base alike.
  //
  // Anything else intersecting is a genuine structural intersection — the
  // mixin pattern (`HasId & HasTimestamps & UserFields`), or an intersection
  // with more than one leftover base (ambiguous). Each constituent is
  // extracted recursively and carried as `types.intersection(members)`;
  // projectors that can represent it natively (JSON Schema's `allOf`,
  // TypeScript's `&`, Zod's `z.intersection`, …) do, and the rest fall back to
  // their first member (lossy but safe — see each projector's handler).
  if (type.isIntersection()) {
    const branded = typeRefFromBrandedIntersection(type, checker, loc, seen)
    if (branded) return branded
    const nextSeen = new Set(seen).add(type)
    const members = type.types.map((member) => typeRefFromType(member, checker, loc, nextSeen))
    return t(types.intersection(members))
  }

  // ── Object types: primitive/optional/array/nested fields ──────────────────
  if (flags & ts.TypeFlags.Object) {
    // Callable types (arrow/function-typed values, callback params, method
    // fields) lower to `types.function` — a real type-position shape, not a
    // punt. Constructable types (`new (...) => T`) have no IR representation
    // yet and still punt.
    const callSigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call)
    if (callSigs.length > 0) {
      return functionRefFromSignatures(callSigs, checker, loc, seen)
    }
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) {
      return puntRef(`constructable (${checker.typeToString(type)})`)
    }

    const nextSeen = new Set(seen).add(type)

    // Promise<T> in field position: unwrap to T, same as the return-type path.
    if (type.symbol?.name === "Promise") {
      const [inner] = checker.getTypeArguments(type as ts.TypeReference)
      if (inner) return typeRefFromType(inner, checker, loc, nextSeen)
    }

    // AsyncIterable<T>/AsyncGenerator<T, TReturn, TNext>/AsyncIterableIterator<T>
    // (the return type of an `async function*`) all describe an
    // asynchronously-produced sequence of `T` — lower to `types.stream(T)`,
    // checked before the general object-type extraction below (same
    // early-unwrap treatment as `Promise<T>` above, so `Promise<AsyncIterable<T>>`
    // resolves correctly too: the Promise unwrap at the call site — either
    // this branch on a re-entrant field-position call, or
    // `typeRefFromReturnType`'s own Promise-stripping — runs first, then this
    // branch catches the AsyncIterable underneath). Only the first type
    // argument (the yielded type) is captured; `AsyncGenerator`'s
    // `TReturn`/`TNext` have no IR slot, same as `Promise<T>`'s handling above
    // only keeping the resolved value type.
    if (
      type.symbol &&
      (type.symbol.name === "AsyncIterable" ||
        type.symbol.name === "AsyncGenerator" ||
        type.symbol.name === "AsyncIterableIterator")
    ) {
      const [elem] = checker.getTypeArguments(type as ts.TypeReference)
      return t(
        types.stream(
          elem ? typeRefFromType(elem, checker, loc, nextSeen) : puntRef("unknown stream element"),
        ),
      )
    }

    const properties = checker.getPropertiesOfType(type)

    // Pure index-signature types (Record<K,V>, `{ [key: string]: V }`) have no
    // own properties — without this they'd lower to `types.object({})`.
    const stringIndex = type.getStringIndexType()
    const numberIndex = type.getNumberIndexType()
    if (properties.length === 0 && (stringIndex || numberIndex)) {
      const valueType = stringIndex ?? numberIndex!
      const keyRef = stringIndex ? t(types.string) : t(types.number)
      return t(types.map(keyRef, typeRefFromType(valueType, checker, loc, nextSeen)))
    }

    // Class instances: a symbol with a ts.ClassDeclaration among its
    // declarations is a class, not a plain object literal type — lower to
    // `types.instance`, purely nominal (class name + declaring file), so
    // identity survives extraction instead of the class being flattened into
    // a bag of public fields (which would discard its methods and misrepresent
    // it as plain data). No need to walk `properties` for this case.
    const classDecl = type.symbol?.declarations?.find(ts.isClassDeclaration)
    if (classDecl && type.symbol) {
      const instanceRef = t(types.instance(type.symbol.name, classDecl.getSourceFile().fileName))

      // The class's method surface, if any, is its other half (see
      // TypeKinds.instance's doc comment in type-ir/src/index.ts: "a class's
      // fields are only half its surface — methods are the other half").
      // There's no separate multi-declaration output channel here (extraction
      // yields one TypeRef per type), so the `interface` TypeRef rides along
      // as `meta.interface` — an open-metadata-bag attachment (CLAUDE.md:
      // "open metadata bag over fixed schema") rather than a new return shape,
      // additive and non-breaking for every existing consumer of this
      // function. `instance` itself stays purely nominal; nothing here adds
      // fields to it.
      const methods = methodsFromClassType(type, checker, loc, nextSeen, instanceRef)
      if (Object.keys(methods).length > 0) {
        return t(instanceRef.shape, { ...instanceRef.meta, interface: t(types.interface(methods)) })
      }
      return instanceRef
    }

    const fields: Record<string, TypeRef> = {}

    for (const prop of properties) {
      // Skip private/protected members — internal state isn't part of the
      // public data shape. (Classes themselves are handled above and never
      // reach this loop — this guards structural types that still carry
      // private/protected member symbols.)
      if (isPrivateOrProtected(prop)) continue

      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0
      const readonly = isReadonly(prop)
      // Strip `| undefined` so `field?: string` lowers as a plain string.
      const propType = checker
        .getTypeOfSymbolAtLocation(prop, loc)
        .getNonNullableType()

      // Method-shaped fields (call signature) lower to `types.function` —
      // e.g. `callback: (x: number) => void` — same as any other callable
      // type position (see the call-signature branch above).
      const fieldRef = typeRefFromType(propType, checker, loc, nextSeen)

      // Per-field JSDoc: `/** … */` above a property → `meta.description`;
      // `@default` tag → `meta.default`. Both flow through the type-ir
      // json-schema projector's `withMeta` unchanged, surfacing in CLI
      // --help, OpenAPI specs, and MCP tool schemas.
      const description = propertyDescriptionOf(prop, checker)
      const defaultValue = propertyDefaultOf(prop, checker)
      const refinementMeta = propertyRefinementMetaOf(prop, checker)

      const extraMeta: Record<string, unknown> = { ...refinementMeta }
      if (optional) extraMeta.optional = true
      if (readonly) extraMeta.readonly = true
      if (description !== undefined) extraMeta.description = description
      if (defaultValue !== undefined) extraMeta.default = defaultValue

      fields[prop.name] =
        Object.keys(extraMeta).length > 0
          ? t(fieldRef.shape, { ...fieldRef.meta, ...extraMeta })
          : fieldRef
    }

    return t(types.object(fields))
  }

  // ── Generic type parameters: extract the CONSTRAINT, not the unresolved
  //    parameter itself. `T extends Searchable` guarantees the caller's `T`
  //    is at least shaped like `Searchable` — that's real information worth
  //    keeping instead of punting to `unknown`. `T extends string` likewise
  //    extracts `string`. An unconstrained `T` truly has no information to
  //    extract (its only guarantee is "anything"), so it stays `unknown` —
  //    now with a descriptive comment instead of the generic "unsupported"
  //    punt message. Only the `extends` clause is read; a type parameter's
  //    DEFAULT (`T = string`) describes what the caller may omit, not what
  //    the type guarantees, so `getDefault()` is deliberately not consulted.
  //    The constraint is lowered recursively — `T extends Record<string, V>`
  //    or `T extends OtherGeneric` both fall through this same path, so a
  //    constrained-generic constraint referencing another type parameter (or
  //    a named interface/object) resolves through the normal machinery
  //    above, `seen` included. A constraint too exotic to lower structurally
  //    (e.g. involving a conditional type) punts gracefully via the same
  //    recursive call, same as any other unhandled type.
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint()
    if (constraint) {
      const nextSeen = new Set(seen).add(type)
      const constraintRef = typeRefFromType(constraint, checker, loc, nextSeen)
      return t(constraintRef.shape, { ...constraintRef.meta, generic: true })
    }
    return t(types.unknown, {
      $comment: `unconstrained generic type parameter (${checker.typeToString(type)}) — no bound to extract`,
    })
  }

  // ── Everything else (unknown, any, branded, conditional types, …) ─────────
  return puntRef(`unsupported (${checker.typeToString(type)})`)
}

/**
 * Lower a resolved `ts.Type` to a JSON-Schema value.
 *
 * Handles the obvious cases; punts everything else to `unknown` with a
 * `$comment` naming the case. `loc` anchors symbol-type resolution.
 */
export function schemaFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): JsonSchema {
  return toJsonSchema(typeRefFromType(type, checker, loc)) as JsonSchema
}

// ============================================================================
// Function/op input → JSON-Schema
// ============================================================================

/**
 * The declared-type provenance of a top-level extracted type: its name and
 * the absolute path of the file it's declared in — recoverable only when the
 * type is NAMED (a `type X = …` alias or an `interface X {…}`), not for an
 * anonymous/inline shape (`(input: { q: string }) => …`).
 *
 * Read only at the top level (a handler's own parameter type), not while
 * descending into `typeRefFromType`'s structural walk — nested named types
 * (e.g. a field typed `Address`) are still inlined structurally there, same
 * as before; only the OUTER type gets a name worth importing, since that's
 * the one a generated type-guard annotation needs to reference.
 *
 * Anonymous object-literal types resolve to a symbol whose sole declaration
 * is a `ts.TypeLiteralNode` (the `{ … }` syntax itself, not a named
 * declaration) — excluded here so those fall through to structural inlining
 * instead of being treated as "named".
 */
function typeProvenanceOf(
  type: ts.Type,
  checker: ts.TypeChecker,
): { name: string; declarationFile: string } | undefined {
  const aliasSymbol = type.aliasSymbol
  const aliasDecl = aliasSymbol?.declarations?.[0]
  if (aliasSymbol && aliasDecl) {
    return { name: aliasSymbol.name, declarationFile: aliasDecl.getSourceFile().fileName }
  }
  const symbol = type.getSymbol()
  const decl = symbol?.declarations?.[0]
  if (symbol && decl && !ts.isTypeLiteralNode(decl)) {
    return { name: symbol.name, declarationFile: decl.getSourceFile().fileName }
  }
  return undefined
}

/**
 * Derive the input TypeRef from a function-typed node (arrow or function
 * expression): its first parameter's type is the op input. A niladic op
 * lowers to an empty object TypeRef.
 *
 * When the parameter type is a NAMED type (alias/interface, not an inline
 * object literal), the returned TypeRef carries `meta.typeName` +
 * `meta.declarationFile` — provenance a codegen consumer (e.g.
 * `@rhi-zone/fractal-type-ir`'s `compileValidatorModule`) can use to `import
 * type { X } from "…"` instead of inlining the type's structure into a
 * generated annotation. See index.ts's meta-bag convention doc comment.
 */
export function typeRefFromFunctionNode(
  fn: ts.Node,
  checker: ts.TypeChecker,
): TypeRef {
  const fnType = checker.getTypeAtLocation(fn)
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
  if (!sig) return puntRef("no call signature on op fn")
  const [param] = sig.getParameters()
  if (!param) return t(types.object({}))
  const paramType = checker.getTypeOfSymbolAtLocation(param, fn)
  const ref = typeRefFromType(paramType, checker, fn)
  const provenance = typeProvenanceOf(paramType, checker)
  return provenance
    ? t(ref.shape, { ...ref.meta, typeName: provenance.name, declarationFile: provenance.declarationFile })
    : ref
}

/**
 * Derive the input schema from a function-typed node (arrow or function
 * expression): its first parameter's type is the op input. A niladic op
 * lowers to an empty object schema.
 */
export function schemaFromFunctionNode(
  fn: ts.Node,
  checker: ts.TypeChecker,
): JsonSchema {
  return toJsonSchema(typeRefFromFunctionNode(fn, checker)) as JsonSchema
}

// ============================================================================
// Result<T, E> recognition — AST-level syntax approach
// ============================================================================

//
// ARCHITECTURE NOTE: The TypeScript compiler, when run with `skipLibCheck: true`
// on this project, keeps alias instantiations in an "unresolved" state
// (`type.flags === TypeFlags.Any` internally). This means:
//   - `type.isUnion()` is false for `Result<T, E>` even though it IS a union alias
//   - `aliasSymbol.declarations` is always undefined (modules not fully resolved)
//   - `getAliasedSymbol()` resolves to `unknown` with no declarations
//
// This rules out:
//   - Structural matching on the resolved union (type isn't a union yet)
//   - File-path nominal checks (no declarations to read)
//
// WHAT DOES WORK:
//   - `aliasSymbol.name` — the alias name is available on the unresolved type
//   - `aliasTypeArguments` — the type arguments are available
//   - AST syntax nodes — when an explicit return type annotation exists, the
//     TypeReferenceNode's typeName identifier and its typeArguments are accessible
//   - Local TypeAlias declarations — for local aliases like `type ApiResult<T> = Result<T, E>`,
//     the declaration IS in the same file and IS accessible (sym.declarations is defined)
//
// STRATEGY:
//   1. SYNTAX PATH (primary, for annotated returns):
//      Walk the function's return type annotation node (fn.type).
//      For a TypeReference named "Result" with ≥ 2 typeArgs → T = typeArgs[0].
//      For a TypeReference to a LOCAL TypeAlias whose body is Result<T,...> → T = typeRef's typeArgs[0].
//      Also handles Promise<Result<T,E>>: strip the Promise TypeReference first.
//      This covers: (a) direct import, (b) barrel import (no rename), (c) further-generic alias.
//
//   2. STRUCTURAL PATH (fallback, for INFERRED returns or fully-resolved types):
//      When the return type IS a proper union (rare in this extractor's usage but
//      possible when types resolve fully), check the exact DU shape:
//        `{ kind: "ok"; value: T } | { kind: "err"; error: E }`
//      This fires when the type was genuinely expanded to a union.
//
//   3. FALSE-POSITIVE GUARD:
//      The name check ("Result") is the primary discriminant. Arbitrary unions
//      without an alias named "Result" never trigger path 1.
//      The structural path (2) matches the exact DU fields (kind/value/error with
//      string literal discriminants "ok"/"err") — too specific for accidental collisions.

/**
 * Given a TypeReferenceNode (possibly `Promise<ResultRef<T,E>>`), try to find
 * the inner TypeReferenceNode that represents `Result<T,E>` and return the
 * first type argument node (the `T` in `Result<T,E>`).
 *
 * Unwrapping order:
 *   1. If the outermost ref is "Promise", descend to its first type argument.
 *   2. If the (possibly descended) ref is named "Result" with ≥ 2 type args →
 *      return the first type arg node.
 *      NOMINAL: covers (a) direct import and (b) barrel with no rename.
 *   3. If the ref's identifier is an IMPORT ALIAS (ImportSpecifier) and the
 *      original exported name is "Result" → it's a renamed barrel re-export
 *      (`import { Result as X } from "..."`). Extract the call site's first arg.
 *      NOMINAL: covers (b) barrel with rename.
 *   4. If the ref points to a LOCAL TypeAlias (declarations accessible in the
 *      same file) whose body is a TypeReference named "Result" with ≥ 1 type
 *      parameter → the first alias type parameter maps positionally to the call
 *      site's first type argument. Extract it.
 *      COVERS (c) further-generic aliases like `type ApiResult<T> = Result<T, E>`.
 *
 * Returns the T typeNode on success, undefined if the pattern doesn't match.
 */
function resultTypeArgNodeFrom(
  typeRefNode: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (!ts.isIdentifier(typeRefNode.typeName)) return undefined

  // Strip Promise<X> → recurse into X
  if (typeRefNode.typeName.text === "Promise") {
    const inner = typeRefNode.typeArguments?.[0]
    if (!inner || !ts.isTypeReferenceNode(inner)) return undefined
    return resultTypeArgNodeFrom(inner, checker)
  }

  // (a) / (b-no-rename): direct "Result" name with ≥ 2 type arguments.
  //   Covers: `import { Result } from "@rhi-zone/fractal-api-tree"` (a)
  //           `import { Result } from "./barrel"`               (b, no rename)
  if (
    typeRefNode.typeName.text === "Result" &&
    (typeRefNode.typeArguments?.length ?? 0) >= 2
  ) {
    return typeRefNode.typeArguments![0]
  }

  // Resolve the identifier's symbol for remaining cases.
  const sym = checker.getSymbolAtLocation(typeRefNode.typeName)
  if (!sym) return undefined

  // (b-rename): import alias → `import { Result as X } from "..."`.
  //   The import specifier's declarations ARE accessible (same file) even with
  //   skipLibCheck. We check that the specifier's ORIGINAL name (propertyName)
  //   is "Result". This verifies the barrel re-exports core's Result under a
  //   different local name.
  if (sym.flags & ts.SymbolFlags.Alias) {
    const specDecl = sym.declarations?.[0]
    if (specDecl && ts.isImportSpecifier(specDecl)) {
      // propertyName is set when renamed (`Result as X`); name is the local name.
      const originalName = specDecl.propertyName?.text ?? specDecl.name.text
      if (
        originalName === "Result" &&
        (typeRefNode.typeArguments?.length ?? 0) >= 1
      ) {
        return typeRefNode.typeArguments![0]
      }
    }
  }

  // (c): local TypeAlias → `type ApiResult<T> = Result<T, SomeError>`.
  //   Local alias declarations are accessible (same file, not behind skipLibCheck).
  //   If the alias's body is a TypeReference to "Result" with ≥ 2 type parameters,
  //   the first type parameter maps positionally to the call site's first type arg.
  if ((sym.flags & ts.SymbolFlags.TypeAlias) && sym.declarations?.[0]) {
    const decl = sym.declarations[0]
    if (
      ts.isTypeAliasDeclaration(decl) &&
      ts.isTypeReferenceNode(decl.type) &&
      ts.isIdentifier(decl.type.typeName) &&
      decl.type.typeName.text === "Result" &&
      (decl.typeParameters?.length ?? 0) >= 1
    ) {
      return typeRefNode.typeArguments?.[0]
    }
  }

  return undefined
}

/**
 * STRUCTURAL fallback: detect the exact Result discriminated-union shape.
 *
 * Fires only when the return type IS already a proper union — which happens
 * for inferred return types or when types are fully resolved (not under
 * skipLibCheck). It does NOT fire for the alias-instantiation case (those
 * types stay "unresolved" under this extractor's program configuration).
 *
 * Exact shape from packages/api-tree/src/index.ts:
 *   `{ readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly error: E }`
 *
 * Match criteria (all must hold to avoid false positives on arbitrary unions):
 *   1. Union of exactly 2 members
 *   2. Each member has property `kind` typed as a StringLiteral ("ok" or "err")
 *   3. The `kind: "ok"` member has a `value` property → T extracted from it
 *   4. The `kind: "err"` member has an `error` property (guards against accidental matches)
 *
 * Returns the type of the `value` property (T), or undefined on mismatch.
 */
function structuralResultValueType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): ts.Type | undefined {
  if (!type.isUnion()) return undefined
  const members = type.types
  if (members.length !== 2) return undefined

  let okMember: ts.Type | undefined
  let errMember: ts.Type | undefined

  for (const member of members) {
    const kindProp = member.getProperty("kind")
    if (!kindProp) return undefined
    const kindType = checker.getTypeOfSymbolAtLocation(kindProp, loc)
    if (!kindType.isStringLiteral()) return undefined
    if (kindType.value === "ok") okMember = member
    else if (kindType.value === "err") errMember = member
    else return undefined
  }

  if (!okMember || !errMember) return undefined

  // kind:"ok" branch must have `value` (T)
  const valueProp = okMember.getProperty("value")
  if (!valueProp) return undefined

  // kind:"err" branch must have `error` (E) — guards against accidental matches
  const errorProp = errMember.getProperty("error")
  if (!errorProp) return undefined

  return checker.getTypeOfSymbolAtLocation(valueProp, loc)
}

// ============================================================================
// Function/op return type → JSON-Schema
// ============================================================================

/**
 * Derive the output schema from a function-typed node by inspecting its return
 * type. Unwraps `Result<T, E>` and `Promise<Result<T, E>>` to yield T's schema.
 * Exotic/unresolvable return types punt to `unknown` with a TODO $comment,
 * consistent with the input-side fallback.
 *
 * Unwrapping uses two paths (see ARCHITECTURE NOTE above):
 *
 *   SYNTAX PATH (primary): reads the explicit return type annotation node.
 *     Handles `Result<T,E>` directly, barrel re-exports (no rename), and
 *     further-generic local aliases like `type ApiResult<T> = Result<T, E>`.
 *
 *   STRUCTURAL PATH (fallback): matches the exact DU shape when the return
 *     type IS a proper union — covers inferred-return cases or fully-resolved
 *     contexts outside of skipLibCheck.
 */
export function typeRefFromReturnType(
  fn: ts.Node,
  checker: ts.TypeChecker,
): TypeRef {
  const fnType = checker.getTypeAtLocation(fn)
  const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
  if (!sig) return puntRef("no call signature on op fn")

  // ── SYNTAX PATH: explicit return type annotation on the function node ────
  //
  // When the function has an explicit `: ReturnType` annotation, we read that
  // type node from the AST directly. This gives us the full structure (including
  // type argument positions) without relying on the checker's alias resolution,
  // which is blocked by skipLibCheck.
  //
  // We detect `Promise<Result<T,E>>` by stripping the outer Promise TypeRef and
  // recursing; we detect `Result<T,E>` by name + 2 type args; we detect local
  // aliases like `ApiResult<T>` by checking their declaration's body.
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const retTypeNode = fn.type
    if (retTypeNode && ts.isTypeReferenceNode(retTypeNode)) {
      const tNode = resultTypeArgNodeFrom(retTypeNode, checker)
      if (tNode !== undefined) {
        const tType = checker.getTypeAtLocation(tNode)
        return typeRefFromType(tType, checker, fn)
      }
    }
  }

  // ── TYPE-LEVEL PATH: inferred returns or non-annotated functions ─────────
  //
  // Fall through to the resolved return type from the call signature.
  let returnType = checker.getReturnTypeOfSignature(sig)

  // Strip Promise<T> at the type level (concrete Promise objects resolve fine).
  if (returnType.symbol?.name === "Promise") {
    const args = checker.getTypeArguments(returnType as ts.TypeReference)
    const inner = args[0]
    if (inner === undefined) return puntRef("Promise with no type argument")
    returnType = inner
  }

  // STRUCTURAL path: match the exact DU shape from core/src/index.ts.
  // Fires when the type is a proper union (not an unresolved alias instantiation).
  const structuralValue = structuralResultValueType(returnType, checker, fn)
  if (structuralValue !== undefined) {
    returnType = structuralValue
  }

  return typeRefFromType(returnType, checker, fn)
}

/**
 * Derive the output schema from a function-typed node by inspecting its return
 * type. Unwraps `Result<T, E>` and `Promise<Result<T, E>>` to yield T's schema.
 */
export function schemaFromReturnType(
  fn: ts.Node,
  checker: ts.TypeChecker,
): JsonSchema {
  return toJsonSchema(typeRefFromReturnType(fn, checker)) as JsonSchema
}

// ============================================================================
// JSDoc → description
// ============================================================================

/** Read the flattened JSDoc comment text off a single node, if present. */
function jsDocTextOf(node: ts.Node): string | undefined {
  for (const j of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(j)) {
      const text = ts.getTextOfJSDocComment(j.comment)
      if (text && text.trim().length > 0) return text.trim()
    }
  }
  return undefined
}

/**
 * Extract the leading JSDoc description of a node, flattened to a single
 * trimmed string. JSDoc attaches to the owning declaration statement, so this
 * climbs to the nearest statement if the node itself carries none. Returns
 * undefined when absent.
 */
export function extractJsDoc(node: ts.Node): string | undefined {
  const own = jsDocTextOf(node)
  if (own) return own
  let cur: ts.Node | undefined = node.parent
  while (cur && !ts.isSourceFile(cur)) {
    const text = jsDocTextOf(cur)
    if (text) return text
    if (ts.isStatement(cur)) break
    cur = cur.parent
  }
  return undefined
}

// ============================================================================
// Program helper + op-value extraction
// ============================================================================

/** Create a read-only Program over a single entry file. */
export function createExtractorProgram(entryFile: string): ts.Program {
  return ts.createProgram([entryFile], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  })
}

/**
 * Given an op VALUE expression from source, return the function node it wraps.
 * Supports `op(fn, meta)` calls and bare arrow/function expressions. `op` need
 * not resolve — the arrow's own parameter annotation is what we read.
 */
export function opFunctionNode(expr: ts.Expression): ts.Node | undefined {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr
  if (ts.isCallExpression(expr)) {
    const [first] = expr.arguments
    if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) {
      return first
    }
  }
  return undefined
}
