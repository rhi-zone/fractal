// Native ReScript (https://rescript-lang.org/) type-declaration projector —
// emits plain ReScript type syntax (records, variants, tuples, `option<T>`),
// no serialization glue (contrast elm-json.ts, which pairs a type with a
// decoder/encoder because Elm has no runtime reflection at all; ReScript code
// that needs JSON codecs typically reaches for a library — @glennsl/rescript-json,
// rescript-schema, etc. — so this projector, like flow-native.ts/php-native.ts,
// sticks to the type layer only).
//
// Design choice worth flagging explicitly (see this file's header for the
// tradeoff, not silently picked): ReScript has TWO sum-type constructs —
// ordinary (nominal) variants (`type t = Foo | Bar(int)`, must be declared
// under a name, cannot appear as an anonymous inline type) and polymorphic
// variants (`` [#foo | #bar(int)] ``, structurally typed, CAN appear inline
// with no prior declaration — see docs/design/type-ir-survey.md section 5).
// This projector renders `union`/`enum` as ORDINARY nominal variants, hoisted
// to their own top-level declaration exactly the way elm-json.ts hoists Elm's
// (also nominal-only) custom types — nested unions/enums encountered while
// rendering a field are lifted out to a synthetic top-level `type` and the
// field just references it by name. This was picked for consistency with the
// sibling ML-family projector (elm-json.ts) and because ordinary variants are
// the more idiomatic, more widely tooled ReScript default (better
// pattern-match exhaustiveness diagnostics, plays better with `@genType`/
// interop tooling). The real alternative — inline polymorphic variants,
// avoiding hoisting entirely and staying closer to how `union` behaves in the
// structural projectors (flow-native.ts, php-native.ts) — is a genuine,
// differently-shaped design with its own tradeoffs (no separate named
// declaration needed, but weaker exhaustiveness checking, `#tag` payload
// syntax instead of `Ctor(payload)`, and a less common idiom in ReScript
// codebases for closed, non-extensible sum types). Not chosen here; flagged
// rather than silently decided.
//
// Records are ReScript's `type name = { field: T, ... }`; unlike Elm,
// ReScript record types (like variants) must ALSO be declared under a name —
// there's no anonymous inline record-type syntax — so a nested `object`
// encountered in field position is hoisted exactly the same way a nested
// union/enum is (elm-json.ts didn't need this because Elm's `{ field : T }`
// IS a valid anonymous inline type).
import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// ============================================================================
// naming
// ============================================================================

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

function toPascalCase(name: string): string {
  return splitWords(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("")
}

// ReScript field/variant-payload label rules: identifiers must start with a
// lowercase letter or underscore. A wire field name that isn't a valid bare
// label (numeric-leading, kebab-case, reserved word, ...) is instead written
// with an explicit `@as("original")` attribute plus a sanitized label, the
// standard ReScript escape hatch for "the JS/JSON key doesn't look like a
// ReScript identifier" (https://rescript-lang.org/docs/manual/latest/bind-to-js-function#object).
const RESERVED = new Set([
  "and", "as", "assert", "constraint", "else", "exception", "external", "false", "for", "fun",
  "function", "functor", "if", "in", "include", "inherit", "initializer", "lazy", "let", "module",
  "mutable", "new", "of", "open", "or", "private", "rec", "sig", "struct", "then", "to", "true",
  "try", "type", "val", "virtual", "when", "while", "with", "switch",
])

function sanitizeLabel(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_")
  const lowered = /^[A-Z]/.test(cleaned) ? cleaned.charAt(0).toLowerCase() + cleaned.slice(1) : cleaned
  const prefixed = /^[a-z_]/.test(lowered) ? lowered : `_${lowered}`
  return prefixed
}

function fieldLabel(name: string): { label: string; asAttr: string } {
  const label = sanitizeLabel(name)
  const isValid = label === name && !RESERVED.has(name)
  return { label, asAttr: isValid ? "" : `@as(${JSON.stringify(name)}) ` }
}

// ============================================================================
// hoisting context — shared across a single `toReScript` call so a nested
// object/union/enum is declared once and every reference agrees on its name.
// ============================================================================

interface Ctx {
  /** Fully-rendered top-level `type ... = ...` declarations for hoisted
   * nested records/unions/enums, in the order first encountered (dependency
   * order: a referenced type is always pushed before the type referencing
   * it, since hoisting happens depth-first during rendering). */
  decls: string[]
  /** Names already claimed (top-level name + every hoisted name), so a
   * collision falls back to a numbered suffix. */
  used: Set<string>
  /** `TypeRef` identity -> the name it was hoisted under. */
  names: Map<TypeRef, string>
}

function newCtx(): Ctx {
  return { decls: [], used: new Set(), names: new Map() }
}

function freshName(ctx: Ctx, hint: string): string {
  const base = toPascalCase(hint) || "Anonymous"
  if (!ctx.used.has(base)) {
    ctx.used.add(base)
    return base
  }
  let n = 2
  while (ctx.used.has(`${base}${n}`)) n++
  const name = `${base}${n}`
  ctx.used.add(name)
  return name
}

/** Returns the name previously hoisted for `ref` (by identity), hoisting it
 * now (rendering its full `type` declaration into `ctx.decls`) if this is
 * the first time it's been seen. */
function hoistedName(ctx: Ctx, ref: TypeRef, nameHint: string): string {
  const cached = ctx.names.get(ref)
  if (cached !== undefined) return cached
  const name = freshName(ctx, nameHint)
  ctx.names.set(ref, name)
  ctx.decls.push(generateNamedType(ref, name, ctx))
  return name
}

// ============================================================================
// literal-string union detection — a union of all-string `literal` variants
// (TypeScript's "string literal union" idiom) renders as a no-payload variant
// with one constructor per member, same convention elm-json.ts uses.
// ============================================================================

function stringLiteralMembers(ref: TypeRef): readonly string[] | undefined {
  if (ref.shape.kind !== "union") return undefined
  const s = ref.shape as TypeShape & { kind: "union" }
  const members: string[] = []
  for (const variant of s.variants) {
    if (variant.shape.kind !== "literal") return undefined
    const value = (variant.shape as TypeShape & { kind: "literal" }).value
    if (typeof value !== "string") return undefined
    members.push(value)
  }
  return members
}

// ============================================================================
// type-expression rendering
// ============================================================================

type Converter = (shape: TypeShape, ctx: Ctx, nameHint: string) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

/** ReScript record-field list — used both for a hoisted named record
 * declaration and (there being no anonymous-record alternative) nowhere
 * else; every `object` in field position gets hoisted (see `typeHandlers.object`). */
function renderFields(fields: Readonly<Record<string, TypeRef>>, ctx: Ctx, nameHint: string): string[] {
  return Object.entries(fields).map(([fieldName, fieldRef]) => {
    const { label, asAttr } = fieldLabel(fieldName)
    const fieldType = rescriptType(fieldRef, ctx, `${nameHint}${toPascalCase(fieldName)}`)
    const type = fieldRef.meta.optional === true ? `option<${fieldType}>` : fieldType
    return `${asAttr}${label}: ${type}`
  })
}

const typeHandlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("float"),
  integer: leaf("int"),
  string: leaf("string"),
  null: leaf("unit"),
  void: leaf("unit"),
  // `Js.Json.t` — ReScript's standard "arbitrary JSON value" type
  // (https://rescript-lang.org/docs/manual/latest/api/js/json), the closest
  // analog to TS `unknown`/Elm `Json.Decode.Value`.
  unknown: leaf("Js.Json.t"),
  // ReScript has no built-in bottom/uninhabited type name (unlike Flow's
  // `empty`/TS's `never`) usable at an arbitrary inline type position — an
  // empty variant (`type t = |`) can express "uninhabited" but only as its
  // own named declaration, not inline, so `never` degrades to the same
  // opaque JSON-value placeholder `unknown` uses (honest degrade, not a
  // fabricated builtin name).
  never: leaf("Js.Json.t"),
  // A nested object type has nowhere to inline to (ReScript record types, like
  // variants, must be declared under a name — no `{ field: T }` anonymous
  // inline-type syntax the way Elm has) — hoisted exactly like union/enum.
  object: (_shape, ctx, nameHint) => {
    const ref = currentRef!
    return hoistedName(ctx, ref, nameHint)
  },
  // A class instance carries only nominal identity, never structure — no
  // ReScript construct to reconstruct it from, degrades to the same opaque
  // JSON-value placeholder other unrepresentable kinds use.
  instance: leaf("Js.Json.t"),
  array: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "array" }
    return `array<${rescriptType(s.element, ctx, `${nameHint}Item`)}>`
  },
  // No native async-sequence construct — degrades to its array equivalent,
  // same honest-degrade convention elm-json.ts/flow-native.ts use.
  stream: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `array<${rescriptType(s.element, ctx, `${nameHint}Item`)}>`
  },
  page: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "page" }
    return `array<${rescriptType(s.element, ctx, `${nameHint}Item`)}>`
  },
  // ReScript tuples are native and support arbitrary arity (unlike Elm, whose
  // tuple sugar tops out at 3) — `(a, b, c, d)` renders directly regardless
  // of element count.
  tuple: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `(${s.elements.map((el, i) => rescriptType(el, ctx, `${nameHint}${i}`)).join(", ")})`
  },
  // `Js.Dict.t<V>` — ReScript's standard string-keyed dictionary
  // (https://rescript-lang.org/docs/manual/latest/api/js/dict). Only a
  // faithful rendering for STRING keys; see the file-level design-choice note
  // for non-string-keyed maps (flagged as ambiguous below, not guessed at).
  map: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "map" }
    if (s.key.shape.kind === "string") return `Js.Dict.t<${rescriptType(s.value, ctx, `${nameHint}Value`)}>`
    // Non-string-keyed map: no idiomatic single ReScript construct carries
    // both a non-string key type and a value type together (`Js.Dict.t` is
    // string-keyed only; `Belt.Map.t` needs a first-class comparator module,
    // not just two type parameters) — degrades to an array of key/value
    // tuples, the closest structural analog that stays representable without
    // inventing a comparator. See file header: this is a real, flagged
    // design choice, not the only reasonable one.
    return `array<(${rescriptType(s.key, ctx, `${nameHint}Key`)}, ${rescriptType(s.value, ctx, `${nameHint}Value`)})>`
  },
  union: (_shape, ctx, nameHint) => hoistedName(ctx, currentRef!, nameHint),
  enum: (_shape, ctx, nameHint) => hoistedName(ctx, currentRef!, nameHint),
  // A bare literal in field position carries no distinguishing payload once
  // its single value is fixed — same `()` degrade elm-json.ts's type pass
  // uses (the literal's actual value only matters at the JSON boundary,
  // which this projector doesn't generate).
  literal: () => "unit",
  ref: (shape) => toPascalCase((shape as TypeShape & { kind: "ref" }).target),
  // ReScript has no structural intersection-type operator. Object members
  // merge fields (mirroring elm-json.ts's/flow-native.ts's own intersection
  // handling, hoisted as a merged record); anything else degrades to the
  // first member.
  intersection: (_shape, ctx, nameHint) => hoistedName(ctx, currentRef!, nameHint),
  // ReScript function-type syntax: `(paramTypes) => returnType` — positional
  // only (no named-parameter function types), so `thisType` (if present) is
  // prepended as a leading positional parameter, the same convention
  // flow-native.ts/typescript.ts use for a callable's `this`.
  function: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "function" }
    const thisParam = s.thisType === undefined ? [] : [rescriptType(s.thisType, ctx, `${nameHint}This`)]
    const params = [...thisParam, ...s.params.map((p, i) => rescriptType(p.type, ctx, `${nameHint}${i}`))]
    const paramList = params.length === 0 ? "unit" : params.join(", ")
    return `(${paramList}) => ${rescriptType(s.returnType, ctx, `${nameHint}Return`)}`
  },
  // `method` has no explicit entry — falls back to `function` via
  // `registerParent("method", "function")` in index.ts.
  //
  // No field-level construct for a method surface (a service/interface
  // contract, not data) — degrades to the same opaque JSON-value placeholder
  // `instance` uses.
  interface: leaf("Js.Json.t"),
}

// `object`/`union`/`enum`/`intersection` converters need the original
// `TypeRef` (for hoisting-cache identity), not just its `shape` —
// `resolve()`/the `Converter` signature only carries `shape`, so
// `rescriptType` stashes the current ref here before invoking the converter.
// Reentrant-safe because it's saved/restored around each call.
let currentRef: TypeRef | undefined

function rescriptType(ref: TypeRef, ctx: Ctx, nameHint: string): string {
  const previous = currentRef
  currentRef = ref
  const converter = resolve(ref.shape.kind, typeHandlers)
  let type = converter === undefined ? "Js.Json.t" : converter(ref.shape, ctx, nameHint)
  currentRef = previous
  if (ref.meta.nullable === true) type = `option<${type}>`
  return type
}

/** Public, standalone type-expression rendering — for callers that just want
 * the ReScript type text (e.g. embedding it in hand-written source) without a
 * full `toReScript` declaration. Nested records/unions/enums still render
 * correctly (each gets its own name), but their hoisted declarations aren't
 * returned — use `toReScript` when the hoisted declarations need to be
 * emitted too. */
export function toReScriptType(ref: TypeRef): string {
  return rescriptType(ref, newCtx(), "Anonymous")
}

// ============================================================================
// full named-declaration rendering (record / variant `type ... = ...`)
// ============================================================================

/** Decapitalizes just the leading character — the inverse of the trivial
 * "first letter uppercased" step of PascalCasing, used below to check
 * whether a constructor name is a LOSSLESS rendering of its member (a pure
 * casing difference, e.g. `"active"` -> `Active`) vs. one that actually
 * dropped/reordered information (`"in-progress"` -> `InProgress`, the
 * hyphen is gone for good). */
function decapitalize(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1)
}

// A member whose PascalCased constructor name is more than a pure-casing
// rendering of the original (kebab/snake-case, leading digit, ...) gets an
// explicit `@as("original")` tag on the constructor — ReScript's documented
// mechanism for customizing a variant constructor's runtime representation
// (https://rescript-lang.org/docs/manual/latest/variant#constructor-tag) —
// so the exact wire string is still recoverable. A plain casing difference
// (`"active"` -> `Active`) needs no `@as`: decapitalizing the constructor
// name alone recovers the original.
function renderCtor(member: string): string {
  const name = toPascalCase(member)
  return decapitalize(name) === member ? name : `@as(${JSON.stringify(member)}) ${name}`
}

function renderEnumLike(typeName: string, members: readonly string[]): string {
  const ctorLines = members.map(renderCtor)
  return [`type ${typeName} =`, `  | ${ctorLines.join("\n  | ")}`].join("\n")
}

/** A tagged union: every variant is an `object` and all share
 * `meta.discriminator` (set on the union's own meta, mirroring zod.ts's/
 * elm-json.ts's existing convention) as a literal-valued field. Renders as
 * one constructor per variant, named from the discriminant's literal value,
 * carrying the variant's remaining fields as an inline-record payload
 * (`Ctor({field: T, ...})` — ReScript 10+ variant inline records,
 * https://rescript-lang.org/docs/manual/latest/variant#inline-records). */
function renderTaggedUnion(typeName: string, discriminator: string, variants: readonly TypeRef[], ctx: Ctx): string | undefined {
  const parsed: { tagValue: string; ctor: string; payload: Record<string, TypeRef> }[] = []
  for (const variant of variants) {
    if (variant.shape.kind !== "object") return undefined
    const fields = (variant.shape as TypeShape & { kind: "object" }).fields
    const tagRef = fields[discriminator]
    if (tagRef === undefined || tagRef.shape.kind !== "literal") return undefined
    const tagValue = (tagRef.shape as TypeShape & { kind: "literal" }).value
    if (typeof tagValue !== "string") return undefined
    const payload = { ...fields }
    delete payload[discriminator]
    parsed.push({ tagValue, ctor: toPascalCase(tagValue), payload })
  }

  const ctorLines = parsed.map(({ tagValue, ctor, payload }) => {
    const tag = decapitalize(ctor) === tagValue ? ctor : `@as(${JSON.stringify(tagValue)}) ${ctor}`
    const fields = renderFields(payload, ctx, `${typeName}${ctor}`)
    return fields.length === 0 ? tag : `${tag}({${fields.join(", ")}})`
  })
  return [`type ${typeName} =`, `  | ${ctorLines.join("\n  | ")}`].join("\n")
}

/** The general (untagged) union fallback — one positionally-named constructor
 * per variant (`Variant1`, `Variant2`, …), each wrapping that variant's own
 * rendered type as a single positional payload. */
function renderPositionalUnion(typeName: string, variants: readonly TypeRef[], ctx: Ctx): string {
  const ctors = variants.map((_, i) => `Variant${i + 1}`)
  const payloadTypes = variants.map((v, i) => rescriptType(v, ctx, `${typeName}${ctors[i]}`))
  const ctorLines = ctors.map((c, i) => `${c}(${payloadTypes[i]})`)
  return [`type ${typeName} =`, `  | ${ctorLines.join("\n  | ")}`].join("\n")
}

// ReScript doc comment (https://rescript-lang.org/docs/manual/latest/module#comment) —
// `/** ... */` immediately above the declaration, driven by
// `meta.description`/`meta.deprecated`, same open-metadata-bag convention
// elm-json.ts's/flow-native.ts's own `docComment` helpers use. `meta.deprecated`
// becomes a `@deprecated` attribute
// (https://rescript-lang.org/docs/manual/latest/attribute#deprecated) rather
// than a doc-comment line, since ReScript (unlike Elm) has a real
// compiler-recognized deprecation attribute.
function docComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  return description === undefined ? "" : `/** ${description} */\n`
}

function deprecatedAttr(meta: Readonly<Record<string, unknown>>): string {
  const deprecated = meta.deprecated
  if (deprecated === true) return "@deprecated\n"
  if (typeof deprecated === "string") return `@deprecated(${JSON.stringify(deprecated)})\n`
  return ""
}

/** Renders a complete named declaration for `ref` under `name` — a record
 * type, a variant type (union/enum), or a plain type alias for anything
 * else. Used both for the top-level `toReScript` call and (recursively, via
 * `hoistedName`) for nested objects/unions/enums/intersections. */
function generateNamedType(ref: TypeRef, name: string, ctx: Ctx): string {
  const typeName = toPascalCase(name)
  const kind = ref.shape.kind
  const header = docComment(ref.meta) + deprecatedAttr(ref.meta)

  if (kind === "enum") {
    const s = ref.shape as TypeShape & { kind: "enum" }
    return header + renderEnumLike(typeName, s.members)
  }

  const literalMembers = stringLiteralMembers(ref)
  if (kind === "union" && literalMembers !== undefined) {
    return header + renderEnumLike(typeName, literalMembers)
  }

  if (kind === "union") {
    const s = ref.shape as TypeShape & { kind: "union" }
    const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
    if (discriminator !== undefined) {
      const tagged = renderTaggedUnion(typeName, discriminator, s.variants, ctx)
      if (tagged !== undefined) return header + tagged
    }
    return header + renderPositionalUnion(typeName, s.variants, ctx)
  }

  if (kind === "object" || kind === "intersection") {
    const fields =
      kind === "object"
        ? (ref.shape as TypeShape & { kind: "object" }).fields
        : (() => {
            const s = ref.shape as TypeShape & { kind: "intersection" }
            const merged: Record<string, TypeRef> = {}
            for (const member of s.members) {
              if (member.shape.kind === "object") {
                Object.assign(merged, (member.shape as TypeShape & { kind: "object" }).fields)
              }
            }
            return merged
          })()
    const rendered = renderFields(fields, ctx, typeName)
    // A record type must have at least one field — ReScript/OCaml records
    // have no zero-field literal syntax (`{}` is not valid record syntax;
    // `{.}`/`{..}` are a structurally different construct, JS object types,
    // not records — using either here would be actively wrong, not just a
    // stylistic choice). A fields-less `object` degrades to `unit`, the same
    // "no information" convention `null`/`void`/`literal` already use in
    // this file.
    return rendered.length === 0
      ? header + `type ${typeName} = unit`
      : header + [`type ${typeName} = {`, `  ${rendered.join(",\n  ")},`, `}`].join("\n")
  }

  // Any other kind (a primitive, array, tuple, map, ref, …) at the top level:
  // a plain type alias to its rendered type.
  return header + `type ${typeName} = ${rescriptType(ref, ctx, typeName)}`
}

/**
 * Converts a `TypeRef` into idiomatic native ReScript source: a `type`
 * declaration (record for `object`, variant for `union`/`enum`, alias
 * otherwise) named `name`, plus one additional top-level declaration for
 * every nested object/union/enum hoisted out along the way (ReScript record
 * and variant types, like Elm's, must be declared under a name — no
 * anonymous inline record or sum-type syntax — see this file's header for
 * the union-vs-polymorphic-variant design choice this projector makes).
 *
 * This projector emits TYPES ONLY — no JSON encoder/decoder pair (contrast
 * elm-json.ts) — since idiomatic ReScript JSON handling is typically
 * delegated to a chosen library rather than baked into every generated type.
 */
export function toReScript(ref: TypeRef, name = "Value"): string {
  const ctx = newCtx()
  const typeName = toPascalCase(name)
  ctx.used.add(typeName)
  const main = generateNamedType(ref, typeName, ctx)
  return [main, ...ctx.decls].join("\n\n")
}
