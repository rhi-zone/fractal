// Elm output projector. Emits idiomatic Elm: a type alias/custom type per
// named TypeRef, plus a `Json.Decode.Decoder` and a `Json.Encode.Value`
// encoder function — Elm's standard pair for crossing the JSON boundary
// (https://package.elm-lang.org/packages/elm/json/latest/).
//
// Generated decoders use `Json.Decode.Extra.andMap`
// (https://package.elm-lang.org/packages/elm-community/json-extra/latest/Json-Decode-Extra#andMap)
// to build an applicative decoding pipeline uniformly for both required and
// `Maybe`-typed (optional) fields — a required field decodes with
// `Decode.field name inner`, an optional one with
// `Decode.maybe (Decode.field name inner)`, and both compose the same way via
// `andMap`, so there's no need for a separate NoRedInk-pipeline-style
// `required`/`optional` pair. Consumers of the generated source need
// `elm/json` and `elm-community/json-extra` as dependencies.
//
// Elm has no anonymous sum-type syntax (a `case` needs named constructors on
// a named `type`), so a union/enum encountered while rendering a nested field
// is "hoisted": a synthetic top-level declaration is generated once (type +
// decoder + encoder) and the field just references it by name. Anonymous
// *record* types don't need this — Elm supports inline `{ field : T }` types
// directly — so plain nested objects stay inline.
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

function toCamelCase(name: string): string {
  const pascal = toPascalCase(name)
  return pascal.length === 0 ? pascal : pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/** Wraps a type expression in parens when used as a type ARGUMENT (`List (Maybe Int)`) —
 * needed whenever the expression is a multi-word application, but not for a
 * bare name, a record (`{ ... }`, self-delimited), or a tuple (already parenthesized). */
function parenArg(type: string): string {
  if (!type.includes(" ")) return type
  if (type.startsWith("{") || type.startsWith("(")) return type
  return `(${type})`
}

// ============================================================================
// hoisting context — shared across the type/decoder/encoder passes of a
// single `toElm` call so a nested enum/union is only declared once and every
// reference (in the type, the decoder, and the encoder) agrees on its name.
// ============================================================================

interface Ctx {
  /** Fully-rendered top-level blocks (type + decoder + encoder) for hoisted
   * nested enums/unions, in the order first encountered. */
  decls: string[]
  /** Names already claimed (top-level name + every hoisted name), so a
   * collision falls back to a numbered suffix. */
  used: Set<string>
  /** `TypeRef` identity -> the name it was hoisted under, so the type,
   * decoder, and encoder passes over the same nested ref all agree. */
  names: Map<TypeRef, string>
  /** Set once an optional (`Maybe`-typed) field is encoded anywhere, so the
   * shared `encodeMaybe` helper is appended exactly once. */
  needsEncodeMaybeHelper: boolean
}

function newCtx(): Ctx {
  return { decls: [], used: new Set(), names: new Map(), needsEncodeMaybeHelper: false }
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
 * now (and rendering its full declaration into `ctx.decls`) if this is the
 * first time it's been seen. */
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
// is TypeScript's "string literal union" idiom and renders exactly like an
// `enum` (a custom type of no-arg constructors, decoded/encoded as strings).
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

type TypeConverter = (shape: TypeShape, ctx: Ctx, nameHint: string) => string

const leaf =
  (type: string): TypeConverter =>
  () =>
    type

/** Field list shared by named record type aliases and inline anonymous
 * record types — `{ camelName : Type, ... }`, one per line when joined by the
 * caller. */
function renderFieldTypes(fields: Readonly<Record<string, TypeRef>>, ctx: Ctx, nameHint: string): string[] {
  return Object.entries(fields).map(([fieldName, fieldRef]) => {
    const fieldType = elmType(fieldRef, ctx, `${nameHint}${toPascalCase(fieldName)}`)
    const type = fieldRef.meta.optional === true ? `Maybe ${parenArg(fieldType)}` : fieldType
    return `${toCamelCase(fieldName)} : ${type}`
  })
}

const typeHandlers: Record<string, TypeConverter> = {
  boolean: leaf("Bool"),
  number: leaf("Float"),
  integer: leaf("Int"),
  string: leaf("String"),
  null: leaf("()"),
  void: leaf("()"),
  unknown: leaf("Json.Decode.Value"),
  never: leaf("Never"),
  object: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = renderFieldTypes(s.fields, ctx, nameHint)
    return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`
  },
  array: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "array" }
    return `List ${parenArg(elmType(s.element, ctx, `${nameHint}Item`))}`
  },
  // Elm's tuple syntax only supports 2 or 3 elements
  // (https://elm-lang.org/docs/syntax#tuples) — 4+ degrades to an inline
  // record keyed by position (`field0`, `field1`, …), the same
  // honest-degrade convention other kinds use elsewhere in type-ir.
  tuple: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    if (s.elements.length <= 3) {
      return `(${s.elements.map((el, i) => elmType(el, ctx, `${nameHint}${i}`)).join(", ")})`
    }
    const fields = s.elements.map((el, i) => `field${i} : ${elmType(el, ctx, `${nameHint}${i}`)}`)
    return `{ ${fields.join(", ")} }`
  },
  // `Dict k v` — assumes `import Dict exposing (Dict)`, the common Elm
  // convention, so call sites can write the bare name instead of `Dict.Dict`.
  map: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "map" }
    return `Dict ${parenArg(elmType(s.key, ctx, `${nameHint}Key`))} ${parenArg(elmType(s.value, ctx, `${nameHint}Value`))}`
  },
  // No native async-sequence construct in Elm — degrades to its List
  // equivalent, same convention `array` uses (see TypeKinds.stream doc
  // comment in index.ts).
  stream: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `List ${parenArg(elmType(s.element, ctx, `${nameHint}Item`))}`
  },
  page: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "page" }
    return `List ${parenArg(elmType(s.element, ctx, `${nameHint}Item`))}`
  },
  union: (_shape, ctx, nameHint) => {
    const ref = currentRef!
    return hoistedName(ctx, ref, nameHint)
  },
  enum: (_shape, ctx, nameHint) => {
    const ref = currentRef!
    return hoistedName(ctx, ref, nameHint)
  },
  literal: () => "()",
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No structural equivalent in Elm — Elm's type system has no intersection
  // operator. Object members merge fields (mirroring TypeScript's `&` over
  // object types); anything else degrades to the first member.
  intersection: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.every((m) => m.shape.kind === "object")) {
      const merged: Record<string, TypeRef> = {}
      for (const member of s.members) {
        Object.assign(merged, (member.shape as TypeShape & { kind: "object" }).fields)
      }
      return typeHandlers.object!({ kind: "object", fields: merged }, ctx, nameHint)
    }
    const [first] = s.members
    return first === undefined ? "Json.Decode.Value" : elmType(first, ctx, nameHint)
  },
  // Elm has no callable-type or nominal-class-instance construct — both
  // degrade to an opaque JSON value, the same honest-degrade convention
  // `unknown` renders as.
  instance: leaf("Json.Decode.Value"),
  function: leaf("Json.Decode.Value"),
  method: leaf("Json.Decode.Value"),
  interface: leaf("Json.Decode.Value"),
}

// `union`/`enum` converters need the original `TypeRef` (for hoisting-cache
// identity), not just its `shape` — `resolve()`/the `Converter` signature only
// carries `shape`, so `elmType` stashes the current ref here before invoking
// the converter. Reentrant-safe because it's saved/restored around each call
// (nested `elmType` calls save their own value before recursing).
let currentRef: TypeRef | undefined

function elmType(ref: TypeRef, ctx: Ctx, nameHint: string): string {
  const previous = currentRef
  currentRef = ref
  const converter = resolve(ref.shape.kind, typeHandlers)
  let type = converter === undefined ? "Json.Decode.Value" : converter(ref.shape, ctx, nameHint)
  currentRef = previous
  if (ref.meta.nullable === true) type = `Maybe ${parenArg(type)}`
  return type
}

/** Public, standalone type-expression rendering — for callers that just want
 * the Elm type text (e.g. embedding it in hand-written source) without a full
 * `toElm` declaration. Nested unions/enums still render correctly (each
 * still gets its own name), but their hoisted declarations aren't returned —
 * use `toElm` when the nested declarations need to be emitted too. */
export function toElmType(ref: TypeRef): string {
  return elmType(ref, newCtx(), "Anonymous")
}

// ============================================================================
// decoder-expression rendering
// ============================================================================

function fieldDecoder(fieldName: string, fieldRef: TypeRef, ctx: Ctx, nameHint: string): string {
  const inner = elmDecoder(fieldRef, ctx, nameHint)
  const fieldAccess = `Decode.field ${JSON.stringify(fieldName)} ${parenArg(inner)}`
  return fieldRef.meta.optional === true ? `Decode.maybe (${fieldAccess})` : fieldAccess
}

/** `Decode.succeed ctor |> andMap dec1 |> andMap dec2 ...`, indented as a
 * standalone decoder body (used by both the named-record decoder and inline
 * anonymous-record decoders). */
function pipelineDecoderBody(ctorExpr: string, fieldDecoders: readonly string[]): string {
  const lines = [`Decode.succeed ${ctorExpr}`, ...fieldDecoders.map((d) => `    |> andMap ${parenArg(d)}`)]
  return lines.join("\n    ")
}

/** `recordLiteral` builds the constructed value from the field-lambda params
 * and a record literal of those same params (`{ name = name, ... }`) — the
 * default. A tagged-union variant passes a wrapper that pipes the record
 * literal through its constructor instead (`Ctor { name = name, ... }`). */
function recordDecoderExpr(
  fields: Readonly<Record<string, TypeRef>>,
  ctx: Ctx,
  nameHint: string,
  wrapRecordLiteral: (recordLiteral: string) => string = (r) => r,
): string {
  const entries = Object.entries(fields)
  const decoders = entries.map(([name, ref]) => fieldDecoder(name, ref, ctx, `${nameHint}${toPascalCase(name)}`))
  const params = entries.map(([name]) => toCamelCase(name))
  const recordLiteral =
    entries.length === 0 ? "{}" : `{ ${entries.map(([name]) => `${toCamelCase(name)} = ${toCamelCase(name)}`).join(", ")} }`
  const ctor = params.length === 0 ? wrapRecordLiteral(recordLiteral) : `(\\${params.join(" ")} -> ${wrapRecordLiteral(recordLiteral)})`
  return pipelineDecoderBody(ctor, decoders)
}

const decoderHandlers: Record<string, TypeConverter> = {
  boolean: leaf("Decode.bool"),
  number: leaf("Decode.float"),
  integer: leaf("Decode.int"),
  string: leaf("Decode.string"),
  null: leaf("Decode.null ()"),
  void: leaf("Decode.null ()"),
  unknown: leaf("Decode.value"),
  never: leaf('Decode.fail "never"'),
  object: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "object" }
    return recordDecoderExpr(s.fields, ctx, nameHint)
  },
  array: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "array" }
    return `Decode.list ${parenArg(elmDecoder(s.element, ctx, `${nameHint}Item`))}`
  },
  tuple: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const indexed = s.elements.map((el, i) => `Decode.index ${i} ${parenArg(elmDecoder(el, ctx, `${nameHint}${i}`))}`)
    if (s.elements.length === 2) return `Decode.map2 Tuple.pair ${indexed[0]} ${indexed[1]}`
    if (s.elements.length === 3) {
      return `Decode.map3 (\\a b c -> ( a, b, c )) ${indexed[0]} ${indexed[1]} ${indexed[2]}`
    }
    const ctor = `(\\${s.elements.map((_, i) => `f${i}`).join(" ")} -> { ${s.elements
      .map((_, i) => `field${i} = f${i}`)
      .join(", ")} })`
    return pipelineDecoderBody(ctor, indexed)
  },
  map: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "map" }
    const valueDecoder = parenArg(elmDecoder(s.value, ctx, `${nameHint}Value`))
    if (s.key.shape.kind === "string") return `Decode.dict ${valueDecoder}`
    // Non-string keys: elm/json's `Decode.dict` only ever produces
    // `Dict String v` — decode as that, then re-key through the target key
    // type's own decoder (round-tripped through a JSON string so ints/etc.
    // parse consistently) and drop entries whose key doesn't parse.
    const keyDecoder = elmDecoder(s.key, ctx, `${nameHint}Key`)
    return (
      `(Decode.dict ${valueDecoder} |> Decode.map (Dict.toList >> List.filterMap ` +
      `(\\( k, v ) -> Decode.decodeString ${parenArg(keyDecoder)} k |> Result.toMaybe |> Maybe.map (\\parsedKey -> ( parsedKey, v ))) >> Dict.fromList))`
    )
  },
  stream: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Decode.list ${parenArg(elmDecoder(s.element, ctx, `${nameHint}Item`))}`
  },
  page: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "page" }
    return `Decode.list ${parenArg(elmDecoder(s.element, ctx, `${nameHint}Item`))}`
  },
  union: (_shape, ctx, nameHint) => `${toCamelCase(hoistedName(ctx, currentRef!, nameHint))}Decoder`,
  enum: (_shape, ctx, nameHint) => `${toCamelCase(hoistedName(ctx, currentRef!, nameHint))}Decoder`,
  // Elm has no literal-value type — decodes the underlying JSON primitive and
  // verifies it equals the expected value, succeeding with `()` (the literal
  // carries no information once confirmed).
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return `(Decode.null ())`
    const primitiveDecoder = typeof s.value === "string" ? "Decode.string" : typeof s.value === "number" ? "Decode.float" : "Decode.bool"
    const expected = typeof s.value === "string" ? JSON.stringify(s.value) : s.value === true ? "True" : s.value === false ? "False" : String(s.value)
    return `(${primitiveDecoder} |> Decode.andThen (\\v -> if v == ${expected} then Decode.succeed () else Decode.fail "expected literal ${String(
      s.value,
    ).replace(/"/g, '\\"')}"))`
  },
  ref: (shape) => `${toCamelCase((shape as TypeShape & { kind: "ref" }).target)}Decoder`,
  intersection: (shape, ctx, nameHint) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.every((m) => m.shape.kind === "object")) {
      const merged: Record<string, TypeRef> = {}
      for (const member of s.members) {
        Object.assign(merged, (member.shape as TypeShape & { kind: "object" }).fields)
      }
      return recordDecoderExpr(merged, ctx, nameHint)
    }
    const [first] = s.members
    return first === undefined ? "Decode.value" : elmDecoder(first, ctx, nameHint)
  },
  instance: leaf("Decode.value"),
  function: leaf("Decode.value"),
  method: leaf("Decode.value"),
  interface: leaf("Decode.value"),
}

function elmDecoder(ref: TypeRef, ctx: Ctx, nameHint: string): string {
  const previous = currentRef
  currentRef = ref
  const converter = resolve(ref.shape.kind, decoderHandlers)
  let decoder = converter === undefined ? "Decode.value" : converter(ref.shape, ctx, nameHint)
  currentRef = previous
  if (ref.meta.nullable === true) decoder = `Decode.nullable ${parenArg(decoder)}`
  return decoder
}

// ============================================================================
// encoder-expression rendering
// ============================================================================

type EncoderConverter = (shape: TypeShape, ctx: Ctx, nameHint: string, valueExpr: string) => string

const encLeaf =
  (wrap: (valueExpr: string) => string): EncoderConverter =>
  (_shape, _ctx, _nameHint, valueExpr) =>
    wrap(valueExpr)

function fieldEncoderEntry(fieldName: string, fieldRef: TypeRef, ctx: Ctx, nameHint: string, valueExpr: string): string {
  const access = `${valueExpr}.${toCamelCase(fieldName)}`
  if (fieldRef.meta.optional === true) {
    ctx.needsEncodeMaybeHelper = true
    const inner = elmEncoderFn(fieldRef, ctx, nameHint)
    return `( ${JSON.stringify(fieldName)}, encodeMaybe ${parenArg(inner)} ${access} )`
  }
  return `( ${JSON.stringify(fieldName)}, ${elmEncoder(fieldRef, ctx, nameHint, access)} )`
}

/** A `Type -> Encode.Value` FUNCTION expression for a field's element type —
 * needed wherever the value isn't available as a simple accessor expression
 * yet (e.g. passed on to `encodeMaybe`, or `List.map`/`Encode.list`). */
function elmEncoderFn(ref: TypeRef, ctx: Ctx, nameHint: string): string {
  return `(\\v -> ${elmEncoder(ref, ctx, nameHint, "v")})`
}

function recordEncoderExpr(fields: Readonly<Record<string, TypeRef>>, ctx: Ctx, nameHint: string, valueExpr: string): string {
  const entries = Object.entries(fields).map(([name, ref]) =>
    fieldEncoderEntry(name, ref, ctx, `${nameHint}${toPascalCase(name)}`, valueExpr),
  )
  return `Encode.object\n        [ ${entries.join("\n        , ")}\n        ]`
}

const encoderHandlers: Record<string, EncoderConverter> = {
  boolean: encLeaf((v) => `Encode.bool ${v}`),
  number: encLeaf((v) => `Encode.float ${v}`),
  integer: encLeaf((v) => `Encode.int ${v}`),
  string: encLeaf((v) => `Encode.string ${v}`),
  null: () => "Encode.null",
  void: () => "Encode.null",
  unknown: encLeaf((v) => v),
  never: () => "Encode.null",
  object: (shape, ctx, nameHint, valueExpr) => {
    const s = shape as TypeShape & { kind: "object" }
    return recordEncoderExpr(s.fields, ctx, nameHint, valueExpr)
  },
  array: (shape, ctx, nameHint, valueExpr) => {
    const s = shape as TypeShape & { kind: "array" }
    return `Encode.list ${parenArg(elmEncoderFn(s.element, ctx, `${nameHint}Item`))} ${valueExpr}`
  },
  tuple: (shape, ctx, nameHint, valueExpr) => {
    const s = shape as TypeShape & { kind: "tuple" }
    if (s.elements.length <= 3) {
      const names = s.elements.map((_, i) => String.fromCharCode(97 + i))
      const entries = s.elements.map((el, i) => elmEncoder(el, ctx, `${nameHint}${i}`, names[i]!))
      return `(\\( ${names.join(", ")} ) -> Encode.list identity [ ${entries.join(", ")} ]) ${valueExpr}`
    }
    const entries = s.elements.map((el, i) => elmEncoder(el, ctx, `${nameHint}${i}`, `${valueExpr}.field${i}`))
    return `Encode.list identity [ ${entries.join(", ")} ]`
  },
  map: (shape, ctx, nameHint, valueExpr) => {
    const s = shape as TypeShape & { kind: "map" }
    const valueFn = parenArg(elmEncoderFn(s.value, ctx, `${nameHint}Value`))
    const keyFn = s.key.shape.kind === "string" ? "identity" : "String.fromInt"
    return `Encode.dict ${keyFn} ${valueFn} ${valueExpr}`
  },
  stream: (shape, ctx, nameHint, valueExpr) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Encode.list ${parenArg(elmEncoderFn(s.element, ctx, `${nameHint}Item`))} ${valueExpr}`
  },
  page: (shape, ctx, nameHint, valueExpr) => {
    const s = shape as TypeShape & { kind: "page" }
    return `Encode.list ${parenArg(elmEncoderFn(s.element, ctx, `${nameHint}Item`))} ${valueExpr}`
  },
  union: (_shape, ctx, nameHint, valueExpr) => `encode${hoistedName(ctx, currentRef!, nameHint)} ${valueExpr}`,
  enum: (_shape, ctx, nameHint, valueExpr) => `encode${hoistedName(ctx, currentRef!, nameHint)} ${valueExpr}`,
  literal: (shape, _ctx, _nameHint, _valueExpr) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return `Encode.string ${JSON.stringify(s.value)}`
    if (typeof s.value === "number") return `Encode.float ${s.value}`
    if (typeof s.value === "boolean") return `Encode.bool ${s.value ? "True" : "False"}`
    return "Encode.null"
  },
  ref: (shape, _ctx, _nameHint, valueExpr) => `encode${toPascalCase((shape as TypeShape & { kind: "ref" }).target)} ${valueExpr}`,
  intersection: (shape, ctx, nameHint, valueExpr) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.every((m) => m.shape.kind === "object")) {
      const merged: Record<string, TypeRef> = {}
      for (const member of s.members) {
        Object.assign(merged, (member.shape as TypeShape & { kind: "object" }).fields)
      }
      return recordEncoderExpr(merged, ctx, nameHint, valueExpr)
    }
    const [first] = s.members
    return first === undefined ? valueExpr : elmEncoder(first, ctx, nameHint, valueExpr)
  },
  instance: encLeaf((v) => v),
  function: () => "Encode.null",
  method: () => "Encode.null",
  interface: () => "Encode.null",
}

function elmEncoderBase(ref: TypeRef, ctx: Ctx, nameHint: string, valueExpr: string): string {
  const previous = currentRef
  currentRef = ref
  const converter = resolve(ref.shape.kind, encoderHandlers)
  const base = converter === undefined ? valueExpr : converter(ref.shape, ctx, nameHint, valueExpr)
  currentRef = previous
  return base
}

function elmEncoder(ref: TypeRef, ctx: Ctx, nameHint: string, valueExpr: string): string {
  if (ref.meta.nullable === true) {
    // `meta.nullable` widens the Elm type to `Maybe T` (see `elmType`) — reuse
    // the same `encodeMaybe` helper optional fields use. Recurses through
    // `elmEncoderBase` (not `elmEncoder`) on the SAME `ref` so a nested
    // enum/union's hoisting cache (keyed by `ref` identity) still hits.
    ctx.needsEncodeMaybeHelper = true
    return `encodeMaybe (\\v -> ${elmEncoderBase(ref, ctx, nameHint, "v")}) ${valueExpr}`
  }
  return elmEncoderBase(ref, ctx, nameHint, valueExpr)
}

// ============================================================================
// full named-declaration rendering (type alias/custom type + decoder + encoder)
// ============================================================================

function renderEnumLike(typeName: string, members: readonly string[], ctx: Ctx): string {
  const ctorNames = members.map((m) => toPascalCase(m))
  const decoderFn = `${toCamelCase(typeName)}Decoder`
  const encoderFn = `encode${typeName}`

  const typeDecl = [`type ${typeName}`, `    = ${ctorNames.join("\n    | ")}`].join("\n")

  const cases = members.map((m, i) => `                    ${JSON.stringify(m)} ->\n                        Decode.succeed ${ctorNames[i]}`)
  const decoder = [
    `${decoderFn} : Decoder ${typeName}`,
    `${decoderFn} =`,
    `    Decode.string`,
    `        |> Decode.andThen`,
    `            (\\str ->`,
    `                case str of`,
    cases.join("\n\n"),
    ``,
    `                    _ ->`,
    `                        Decode.fail ("Unknown ${typeName}: " ++ str)`,
    `            )`,
  ].join("\n")

  const encCases = members.map((m, i) => `            ${ctorNames[i]} ->\n                ${JSON.stringify(m)}`)
  const encoder = [
    `${encoderFn} : ${typeName} -> Encode.Value`,
    `${encoderFn} value =`,
    `    Encode.string`,
    `        (case value of`,
    encCases.join("\n\n"),
    `        )`,
  ].join("\n")

  void ctx
  return [typeDecl, "", decoder, "", encoder].join("\n\n")
}

/** A tagged union: every variant is an `object` and all share `meta.discriminator`
 * (set on the union's own meta, mirroring zod.ts's existing convention) as a
 * literal-valued field. Renders as one constructor per variant, named from
 * the discriminant's literal value, carrying the variant's remaining fields
 * as its payload record. */
function renderTaggedUnion(typeName: string, discriminator: string, variants: readonly TypeRef[], ctx: Ctx): string | undefined {
  const decoderFn = `${toCamelCase(typeName)}Decoder`
  const encoderFn = `encode${typeName}`

  const parsed: { tag: string; ctor: string; payload: Record<string, TypeRef> }[] = []
  for (const variant of variants) {
    if (variant.shape.kind !== "object") return undefined
    const fields = (variant.shape as TypeShape & { kind: "object" }).fields
    const tagRef = fields[discriminator]
    if (tagRef === undefined || tagRef.shape.kind !== "literal") return undefined
    const tagValue = (tagRef.shape as TypeShape & { kind: "literal" }).value
    if (typeof tagValue !== "string") return undefined
    const payload = { ...fields }
    delete payload[discriminator]
    parsed.push({ tag: tagValue, ctor: toPascalCase(tagValue), payload })
  }

  const ctorLines = parsed.map(({ ctor, payload }) => {
    const fields = renderFieldTypes(payload, ctx, `${typeName}${ctor}`)
    return fields.length === 0 ? ctor : `${ctor} { ${fields.join(", ")} }`
  })
  const typeDecl = [`type ${typeName}`, `    = ${ctorLines.join("\n    | ")}`].join("\n")

  const decoderCases = parsed.map(({ tag, ctor, payload }) => {
    const body =
      Object.keys(payload).length === 0
        ? `Decode.succeed ${ctor}`
        : recordDecoderExpr(payload, ctx, `${typeName}${ctor}`, (r) => `${ctor} ${parenArg(r)}`)
    const indented = body
      .split("\n")
      .map((l) => `                        ${l}`)
      .join("\n")
    return `                    ${JSON.stringify(tag)} ->\n${indented}`
  })
  const decoder = [
    `${decoderFn} : Decoder ${typeName}`,
    `${decoderFn} =`,
    `    Decode.field ${JSON.stringify(discriminator)} Decode.string`,
    `        |> Decode.andThen`,
    `            (\\tag ->`,
    `                case tag of`,
    decoderCases.join("\n\n"),
    ``,
    `                    _ ->`,
    `                        Decode.fail ("Unknown ${typeName}: " ++ tag)`,
    `            )`,
  ].join("\n")

  const encCases = parsed.map(({ tag, ctor, payload }) => {
    const fieldEntries = Object.entries(payload).map(([name, ref]) =>
      fieldEncoderEntry(name, ref, ctx, `${typeName}${ctor}${toPascalCase(name)}`, "fields"),
    )
    const payloadPattern = Object.keys(payload).length === 0 ? "" : " fields"
    const tagEntry = `( ${JSON.stringify(discriminator)}, Encode.string ${JSON.stringify(tag)} )`
    return [
      `        ${ctor}${payloadPattern} ->`,
      `            Encode.object`,
      `                [ ${[tagEntry, ...fieldEntries].join("\n                , ")}\n                ]`,
    ].join("\n")
  })
  const encoder = [
    `${encoderFn} : ${typeName} -> Encode.Value`,
    `${encoderFn} value =`,
    `    case value of`,
    encCases.join("\n\n"),
  ].join("\n")

  return [typeDecl, "", decoder, "", encoder].join("\n\n")
}

/** The general (untagged) union fallback — one positionally-named constructor
 * per variant (`Variant1`, `Variant2`, …), each wrapping that variant's own
 * rendered type as a single argument. Decoded via `Decode.oneOf`, tried in
 * variant order. */
function renderPositionalUnion(typeName: string, variants: readonly TypeRef[], ctx: Ctx): string {
  const decoderFn = `${toCamelCase(typeName)}Decoder`
  const encoderFn = `encode${typeName}`

  const ctors = variants.map((_, i) => `Variant${i + 1}`)
  const payloadTypes = variants.map((v, i) => elmType(v, ctx, `${typeName}${ctors[i]}`))
  const typeDecl = [
    `type ${typeName}`,
    `    = ${ctors.map((c, i) => `${c} ${parenArg(payloadTypes[i]!)}`).join("\n    | ")}`,
  ].join("\n")

  const decoderAlts = variants.map((v, i) => `Decode.map ${ctors[i]} ${parenArg(elmDecoder(v, ctx, `${typeName}${ctors[i]}`))}`)
  const decoder = [
    `${decoderFn} : Decoder ${typeName}`,
    `${decoderFn} =`,
    `    Decode.oneOf`,
    `        [ ${decoderAlts.join("\n        , ")}\n        ]`,
  ].join("\n")

  const encCases = variants.map(
    (v, i) => `        ${ctors[i]} value ->\n            ${elmEncoder(v, ctx, `${typeName}${ctors[i]}`, "value")}`,
  )
  const encoder = [`${encoderFn} : ${typeName} -> Encode.Value`, `${encoderFn} value_ =`, `    case value_ of`, encCases.join("\n\n")].join(
    "\n",
  )

  return [typeDecl, "", decoder, "", encoder].join("\n\n")
}

// Elm doc comment (https://package.elm-lang.org/help/documentation-format) —
// `{-| ... -}` immediately above the declaration it documents, driven by
// `meta.description`/`meta.deprecated`, same open-metadata-bag convention
// rust-serde.ts's/kotlin-kotlinx.ts's own `docComment` helpers use. Elm has no
// native deprecation annotation (no compiler-recognized `@deprecated`
// pragma), so a truthy `deprecated` instead becomes a leading
// `**Deprecated.**` (or `**Deprecated:** reason` for a string reason) line
// inside the doc comment body — the elm-lang community convention
// (https://package.elm-lang.org/help/documentation-format) for flagging a
// deprecated value from within a doc comment.
function docComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecated = meta.deprecated
  const deprecatedNote =
    deprecated === true ? "**Deprecated.**" : typeof deprecated === "string" ? `**Deprecated:** ${deprecated}` : undefined
  if (description === undefined && deprecatedNote === undefined) return ""
  const body = [deprecatedNote, description].filter((line): line is string => line !== undefined).join("\n\n")
  return `{-| ${body}\n-}\n`
}

/** Renders a complete named declaration — type alias/custom type + decoder +
 * encoder — for `ref` under `name`. Used both for the top-level `toElm` call
 * and (recursively, via `hoistedName`) for nested unions/enums. */
function generateNamedType(ref: TypeRef, name: string, ctx: Ctx): string {
  const typeName = toPascalCase(name)
  const kind = ref.shape.kind
  const doc = docComment(ref.meta)

  if (kind === "enum") {
    const s = ref.shape as TypeShape & { kind: "enum" }
    return doc + renderEnumLike(typeName, s.members, ctx)
  }

  const literalMembers = stringLiteralMembers(ref)
  if (kind === "union" && literalMembers !== undefined) {
    return doc + renderEnumLike(typeName, literalMembers, ctx)
  }

  if (kind === "union") {
    const s = ref.shape as TypeShape & { kind: "union" }
    const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
    if (discriminator !== undefined) {
      const tagged = renderTaggedUnion(typeName, discriminator, s.variants, ctx)
      if (tagged !== undefined) return doc + tagged
    }
    return doc + renderPositionalUnion(typeName, s.variants, ctx)
  }

  if (kind === "object") {
    const s = ref.shape as TypeShape & { kind: "object" }
    const fields = renderFieldTypes(s.fields, ctx, typeName)
    const typeDecl =
      fields.length === 0
        ? `type alias ${typeName} =\n    {}`
        : [`type alias ${typeName} =`, `    { ${fields.join("\n    , ")}\n    }`].join("\n")

    const decoderFn = `${toCamelCase(typeName)}Decoder`
    const fieldDecoders = Object.entries(s.fields).map(([n, r]) => fieldDecoder(n, r, ctx, `${typeName}${toPascalCase(n)}`))
    const decoder = [`${decoderFn} : Decoder ${typeName}`, `${decoderFn} =`, `    ${pipelineDecoderBody(typeName, fieldDecoders)}`].join(
      "\n",
    )

    const encoderFn = `encode${typeName}`
    const encoder = [`${encoderFn} : ${typeName} -> Encode.Value`, `${encoderFn} value =`, `    ${recordEncoderExpr(s.fields, ctx, typeName, "value")}`].join(
      "\n",
    )

    return doc + [typeDecl, "", decoder, "", encoder].join("\n\n")
  }

  // Any other kind (a primitive, array, tuple, map, ref, …) at the top level:
  // a plain type alias to its rendered type, with matching decoder/encoder
  // aliases.
  const typeDecl = `type alias ${typeName} = ${elmType(ref, ctx, typeName)}`
  const decoderFn = `${toCamelCase(typeName)}Decoder`
  const decoder = `${decoderFn} : Decoder ${typeName}\n${decoderFn} =\n    ${elmDecoder(ref, ctx, typeName)}`
  const encoderFn = `encode${typeName}`
  const encoder = `${encoderFn} : ${typeName} -> Encode.Value\n${encoderFn} value =\n    ${elmEncoder(ref, ctx, typeName, "value")}`
  return doc + [typeDecl, "", decoder, "", encoder].join("\n\n")
}

const encodeMaybeHelper = [
  "encodeMaybe : (a -> Encode.Value) -> Maybe a -> Encode.Value",
  "encodeMaybe encoder maybeValue =",
  "    case maybeValue of",
  "        Just value ->",
  "            encoder value",
  "",
  "        Nothing ->",
  "            Encode.null",
].join("\n")

/**
 * Converts a `TypeRef` into idiomatic Elm source: a type alias (records) or
 * custom type (enums/unions) named `name`, plus a `Decoder` and an encoder
 * function for it. Any union/enum nested inside (an object field, array
 * element, etc.) is hoisted into its own named declaration alongside the
 * requested one, since Elm has no anonymous sum-type syntax.
 *
 * Consumers of the generated source need `elm/json`
 * (`import Json.Decode as Decode exposing (Decoder)`, `import Json.Encode as
 * Encode`) and `elm-community/json-extra`'s `andMap`
 * (`import Json.Decode.Extra exposing (andMap)`) — plus `import Dict exposing
 * (Dict)` if the type involves a map.
 */
export function toElm(ref: TypeRef, name = "Value"): string {
  const ctx = newCtx()
  const typeName = toPascalCase(name)
  ctx.used.add(typeName)
  const main = generateNamedType(ref, typeName, ctx)
  const blocks = [main, ...ctx.decls]
  if (ctx.needsEncodeMaybeHelper) blocks.push(encodeMaybeHelper)
  return blocks.join("\n\n\n")
}
