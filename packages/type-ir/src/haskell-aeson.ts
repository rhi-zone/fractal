// Haskell output projector. Emits idiomatic Haskell source text — `data`
// declarations (records for `object`, sum types for `enum`/`union`), `deriving
// (Show, Eq, Generic)`, and Aeson ToJSON/FromJSON instances — not a runtime
// value. Spec references: Haskell 2010 report (data declarations, records),
// aeson (https://hackage.haskell.org/package/aeson) for the JSON convention.
//
// Haskell (unlike TypeScript/Zod/etc.) has NO anonymous structural type —
// every `object`/`enum`/`union` must become a NAMED top-level `data`
// declaration before it can be referenced. Mirrors capnp.ts's/flatbuffers.ts's
// hoisting pattern: a nested object/enum/union field is hoisted out as a
// sibling declaration (named from its enclosing type + field name), collected
// into an out-param array as the tree is walked, and rendered before the
// declaration that references it.
import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

function lowerFirst(name: string): string {
  return name.length === 0 ? name : name[0]!.toLowerCase() + name.slice(1)
}

// Haskell identifiers: letters/digits/underscore/prime, must not start with a
// digit. Anything else (spaces, punctuation, …) is stripped; an
// empty/digit-led result gets an `X` prefix so it's still a valid identifier.
function sanitizeIdent(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_']/g, "")
  if (cleaned.length === 0) return "X"
  return /^[0-9]/.test(cleaned) ? `X${cleaned}` : cleaned
}

// Haskell string literal — double-quoted with backslash/quote escaping.
// JSON.stringify's escaping is a superset compatible with Haskell's for the
// ASCII range this projector actually emits (identifiers, enum members,
// discriminator tag values).
function quote(value: string): string {
  return JSON.stringify(value)
}

// A type used as a type-application ARGUMENT (e.g. `Maybe T`, `[T]`,
// `Map K V`) needs parens if it's itself a multi-word application (`Maybe
// Int` -> `Maybe (Maybe Int)`), but not if it's already a self-delimiting
// form (`[T]`, `(a, b)`).
function wrapType(type: string): string {
  if (type.startsWith("[") || type.startsWith("(")) return type
  return type.includes(" ") ? `(${type})` : type
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Scalar mapping. Fixed-width int/float kinds use Data.Int/Data.Word/Float;
// semantic strings (uuid/uri/email) degrade to Text (Haskell has no built-in
// refined-string type); datetime/date/time/duration use Data.Time's domain
// types (matching type-ir's own domain-not-wire-format convention — see
// kinds/date-time.ts).
const handlers: Record<string, Converter> = {
  boolean: leaf("Bool"),
  number: leaf("Double"),
  integer: leaf("Int"),
  int8: leaf("Int8"),
  int16: leaf("Int16"),
  int32: leaf("Int32"),
  int64: leaf("Int64"),
  uint8: leaf("Word8"),
  uint16: leaf("Word16"),
  uint32: leaf("Word32"),
  uint64: leaf("Word64"),
  float32: leaf("Float"),
  float64: leaf("Double"),
  string: leaf("Text"),
  uuid: leaf("Text"),
  uri: leaf("Text"),
  email: leaf("Text"),
  datetime: leaf("UTCTime"),
  date: leaf("Day"),
  time: leaf("TimeOfDay"),
  duration: leaf("NominalDiffTime"),
  bytes: leaf("ByteString"),
  null: leaf("()"),
  void: leaf("()"),
  unknown: leaf("Value"),
  never: leaf("Void"),
  // A standalone (field-context-free) object/enum/union reference has no
  // name to hoist under — falls back to `meta.typeName` (the same
  // named-provenance convention `index.ts` documents for
  // `@rhi-zone/fractal-api-tree`'s declared-alias tracking) or an opaque
  // Aeson `Value` when even that's absent. Field-position references go
  // through `resolveFieldType` below instead, which always has a name to hoist under.
  object: (_shape, meta) => (typeof meta.typeName === "string" ? capitalize(meta.typeName) : "Value"),
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — referenced by
  // className directly, trusting the caller to import/declare it.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, meta) => {
    const s = shape as TypeShape & { kind: "array" }
    const element = wrapType(toHaskellType(s.element))
    return meta.vector === true ? `Vector ${element}` : `[${toHaskellType(s.element)}]`
  },
  // No native async-sequence type in Haskell's data-only vocabulary —
  // degrades to `[T]`, same fallback every other data-only projector uses.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `[${toHaskellType(s.element)}]`
  },
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return `[${toHaskellType(s.element)}]`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `(${s.elements.map(toHaskellType).join(", ")})`
  },
  map: (shape, meta) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = wrapType(toHaskellType(s.key))
    const value = wrapType(toHaskellType(s.value))
    return meta.hashMap === true ? `HashMap ${key} ${value}` : `Map ${key} ${value}`
  },
  union: (_shape, meta) => (typeof meta.typeName === "string" ? capitalize(meta.typeName) : "Value"),
  // Haskell has no literal-value type — degrades to the underlying scalar
  // type, same lossy fallback typescript.ts's sibling kinds use structurally
  // (there the literal IS representable; here it isn't, so this is honestly lossy).
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "()"
    if (typeof s.value === "string") return "Text"
    if (typeof s.value === "boolean") return "Bool"
    return Number.isInteger(s.value) ? "Int" : "Double"
  },
  enum: (_shape, meta) => (typeof meta.typeName === "string" ? capitalize(meta.typeName) : "Value"),
  ref: (shape) => capitalize((shape as TypeShape & { kind: "ref" }).target),
  // No intersection/mixin construct — lossy: falls back to the first
  // member's type, dropping the rest (same degrade capnp.ts/flatbuffers.ts use).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "Value" : toHaskellType(first)
  },
  // Haskell function type: `T1 -> T2 -> ReturnType`, an explicit `this`
  // (class method receiver) prepended as a leading argument since Haskell
  // functions have no separate `this` slot.
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const thisParam = s.thisType === undefined ? [] : [toHaskellType(s.thisType)]
    const params = [...thisParam, ...s.params.map((p) => toHaskellType(p.type))]
    return [...params, toHaskellType(s.returnType)].map(wrapType).join(" -> ")
  },
  // `method` has no explicit entry — falls back to `function` via
  // `registerParent("method", "function")`, same arrow-type rendering.
  //
  // A service surface embedded in field position has no single Haskell value
  // type to degrade to (its natural encoding is a typeclass, a top-level
  // declaration — see `buildClassDecl` below) — falls back to `meta.typeName`
  // same as `object`/`union` above.
  interface: (_shape, meta) => (typeof meta.typeName === "string" ? capitalize(meta.typeName) : "Value"),
}

/** Bare converter dispatch, with no `optional`/`nullable` -> `Maybe` wrapping
 * applied. Used internally by `resolveFieldType`'s leaf fallback, which
 * applies that wrapping itself exactly once (see `fieldHaskellType`) —
 * calling the wrapping `toHaskellType` there would double-wrap. */
function toHaskellTypeBase(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? "Value" : converter(ref.shape, ref.meta)
}

/** Inline type-expression form — usable anywhere a type already has a name to
 * reference (a `ref`, a leaf/primitive, or a standalone declared type via
 * `meta.typeName`). Field positions that may need to HOIST an anonymous
 * nested declaration go through `resolveFieldType` instead. */
export function toHaskellType(ref: TypeRef): string {
  const type = toHaskellTypeBase(ref)
  return ref.meta.optional === true || ref.meta.nullable === true ? `Maybe ${wrapType(type)}` : type
}

// ============================================================================
// Declaration hoisting — object/enum/union fields need a name before they can
// become a `data` declaration; `resolveFieldType` synthesizes one from
// `${prefix}${capitalize(fieldName)}` (mirroring capnp.ts's/flatbuffers.ts's
// nested-declaration naming) and pushes the built declaration into `decls`,
// returning the bare type name for the field to reference. Non-composite
// kinds fall through to `toHaskellType` unchanged.
// ============================================================================

function resolveFieldType(prefix: string, fieldName: string, ref: TypeRef, decls: string[]): string {
  const kind = ref.shape.kind
  if (isA(kind, "object")) {
    const nestedName = `${prefix}${capitalize(fieldName)}`
    decls.push(buildRecordDecl(nestedName, ref, decls))
    return nestedName
  }
  if (kind === "enum") {
    const nestedName = `${prefix}${capitalize(fieldName)}`
    decls.push(buildEnumDecl(nestedName, ref))
    return nestedName
  }
  if (kind === "union") {
    const nestedName = `${prefix}${capitalize(fieldName)}`
    decls.push(buildUnionDecl(nestedName, ref, decls))
    return nestedName
  }
  if (kind === "array") {
    const s = ref.shape as TypeShape & { kind: "array" }
    return `[${resolveFieldType(prefix, fieldName, s.element, decls)}]`
  }
  if (kind === "map") {
    const s = ref.shape as TypeShape & { kind: "map" }
    const key = wrapType(resolveFieldType(prefix, `${fieldName}Key`, s.key, decls))
    const value = wrapType(resolveFieldType(prefix, `${fieldName}Value`, s.value, decls))
    return `Map ${key} ${value}`
  }
  return toHaskellTypeBase(ref)
}

/** `resolveFieldType` plus the field's own `Maybe` wrapping — the entry point
 * every field-building path (record fields, union-constructor payloads) uses. */
function fieldHaskellType(prefix: string, fieldName: string, ref: TypeRef, decls: string[]): string {
  const base = resolveFieldType(prefix, fieldName, ref, decls)
  return ref.meta.optional === true || ref.meta.nullable === true ? `Maybe ${wrapType(base)}` : base
}

// Haddock doc comment (https://haskell-haddock.readthedocs.io/en/latest/markup.html) —
// `-- | first line` then `-- continued` for every subsequent line, placed
// immediately above the declaration it documents. Driven by
// `meta.description`, same open-metadata-bag convention rust-serde.ts's/
// kotlin-kotlinx.ts's own doc-comment helpers use.
function haddockComment(meta: Readonly<Record<string, unknown>>): string[] {
  const description = typeof meta.description === "string" ? meta.description : undefined
  if (description === undefined) return []
  const lines = description.split("\n")
  return lines.map((line, i) => (i === 0 ? `-- | ${line}` : `-- ${line}`))
}

// `{-# DEPRECATED Name "reason" #-}` (https://wiki.haskell.org/Pragmas#DEPRECATED_pragma) —
// GHC's native deprecation pragma, emitted as a standalone line ahead of the
// `data` declaration it targets. `meta.deprecated` may be a bare `true` (no
// reason given — GHC requires a message string, so this falls back to a
// generic one) or a string (the reason itself, used verbatim).
function deprecatedPragma(name: string, meta: Readonly<Record<string, unknown>>): string[] {
  const deprecated = meta.deprecated
  if (deprecated === true) return [`{-# DEPRECATED ${name} "deprecated" #-}`]
  if (typeof deprecated === "string") return [`{-# DEPRECATED ${name} ${quote(deprecated)} #-}`]
  return []
}

/**
 * `object` -> a Haskell record `data` declaration. Field names are prefixed
 * with `lowerFirst(name)` (`Person` -> `personName`/`personAge`) since
 * Haskell record fields share their enclosing MODULE's namespace (not just
 * their own type) — two records with a same-named field is a compile error
 * without this convention (or `DuplicateRecordFields`, which this projector
 * doesn't assume the consumer has enabled). Aeson instances use
 * `genericToJSON`/`genericParseJSON` with a per-type `fieldLabelModifier` that
 * strips the prefix back off, so the wire JSON keys match the original
 * TypeRef field names exactly.
 */
function buildRecordDecl(name: string, ref: TypeRef, outerDecls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const prefix = lowerFirst(name)
  const fields = Object.entries(shape.fields).map(([fieldName, fieldRef]) => ({
    jsonName: fieldName,
    hsField: `${prefix}${capitalize(fieldName)}`,
    hsType: fieldHaskellType(name, fieldName, fieldRef, outerDecls),
  }))

  const dataDecl =
    fields.length === 0
      ? `data ${name} = ${name}\n  deriving (Show, Eq, Generic)`
      : [
          `data ${name} = ${name}`,
          `  { ${fields.map((f) => `${f.hsField} :: ${f.hsType}`).join("\n  , ")}`,
          `  } deriving (Show, Eq, Generic)`,
        ].join("\n")
  const decorated = [...haddockComment(ref.meta), ...deprecatedPragma(name, ref.meta), dataDecl].join("\n")

  const modifierName = `${prefix}FieldLabel`
  const modifierDecl = [
    `${modifierName} :: String -> String`,
    `${modifierName} s = case drop ${prefix.length} s of`,
    `  (c : rest) -> toLower c : rest`,
    `  []         -> []`,
  ].join("\n")

  const toJsonInstance = [
    `instance ToJSON ${name} where`,
    `  toJSON = genericToJSON defaultOptions { fieldLabelModifier = ${modifierName} }`,
  ].join("\n")
  const fromJsonInstance = [
    `instance FromJSON ${name} where`,
    `  parseJSON = genericParseJSON defaultOptions { fieldLabelModifier = ${modifierName} }`,
  ].join("\n")

  return [decorated, "", modifierDecl, "", toJsonInstance, "", fromJsonInstance].join("\n")
}

/**
 * `enum` -> a sum type of nullary constructors (`Status = Active | Inactive`).
 * Aeson instances are hand-written pattern matches rather than
 * `genericToJSON`'s `constructorTagModifier`, since a member string (`"in
 * progress"`, arbitrary case) doesn't always round-trip through a mechanical
 * case transform back to its own PascalCase constructor name.
 */
function buildEnumDecl(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "enum" }
  const ctors = shape.members.map((m) => `${name}${capitalize(sanitizeIdent(m))}`)

  const dataDecl = [`data ${name}`, `  = ${ctors.join("\n  | ")}`, `  deriving (Show, Eq, Generic)`].join("\n")
  const decorated = [...haddockComment(ref.meta), ...deprecatedPragma(name, ref.meta), dataDecl].join("\n")

  const toJsonInstance = [
    `instance ToJSON ${name} where`,
    ...shape.members.map((m, i) => `  toJSON ${ctors[i]} = String ${quote(m)}`),
  ].join("\n")

  const fromJsonInstance = [
    `instance FromJSON ${name} where`,
    `  parseJSON = withText ${quote(name)} $ \\t -> case t of`,
    ...shape.members.map((m, i) => `    ${quote(m)} -> pure ${ctors[i]}`),
    `    other -> fail ("Unknown ${name} value: " ++ T.unpack other)`,
  ].join("\n")

  return [decorated, "", toJsonInstance, "", fromJsonInstance].join("\n")
}

/**
 * `union` -> a sum type. Two encodings depending on `meta.discriminator`
 * (open metadata bag convention — same one zod.ts's `discriminatedUnion` and
 * every JSON Schema/OpenAPI projector's `oneOf`+`discriminator` read):
 *   - present: each variant (must be `object`) becomes a RECORD constructor
 *     carrying its non-discriminator fields; Aeson's tag + fields are emitted
 *     flattened into one JSON object (Aeson's own "TaggedObject with record
 *     constructors" behavior — https://hackage.haskell.org/package/aeson —
 *     reproduced here by hand rather than via `sumEncoding` options, since the
 *     per-constructor `{..}`/applicative-parse form composes more simply with
 *     this projector's field-prefixing than threading `sumEncoding` through
 *     `genericToJSON`).
 *   - absent: each variant becomes a positional (non-record) constructor
 *     wrapping its own type; Aeson has no native "try each in turn" derive
 *     option, so ToJSON delegates to the wrapped value's own instance and
 *     FromJSON tries each variant via `<|>` (Control.Applicative) — the
 *     untagged-union convention.
 */
function buildUnionDecl(name: string, ref: TypeRef, outerDecls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "union" }
  const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
  const decl =
    discriminator === undefined
      ? buildPlainUnionDecl(name, shape.variants, outerDecls)
      : buildDiscriminatedUnionDecl(name, shape.variants, discriminator, outerDecls)
  // Both `build*UnionDecl` helpers always emit the `data` declaration as their
  // string's leading lines (see each one's own `dataDecl` construction) —
  // splicing the Haddock comment/DEPRECATED pragma in ahead of the whole
  // returned block puts them directly above that `data` keyword, same as
  // `buildRecordDecl`/`buildEnumDecl` do for their own declarations.
  const prefix = [...haddockComment(ref.meta), ...deprecatedPragma(name, ref.meta)]
  return prefix.length === 0 ? decl : [...prefix, decl].join("\n")
}

function buildDiscriminatedUnionDecl(
  name: string,
  variants: readonly TypeRef[],
  discriminator: string,
  outerDecls: string[],
): string {
  type Ctor = {
    ctorName: string
    tagValue: string
    fields: { jsonName: string; hsField: string; hsType: string }[]
  }

  const ctors: Ctor[] = variants.map((variant) => {
    const vshape = variant.shape as TypeShape & { kind: "object" }
    const tagRef = vshape.fields[discriminator]
    const tagShape = tagRef?.shape as (TypeShape & { kind: "literal" }) | undefined
    const tagValue =
      tagShape !== undefined && tagShape.kind === "literal" && typeof tagShape.value === "string"
        ? tagShape.value
        : "Unknown"
    const ctorName = `${name}${capitalize(sanitizeIdent(tagValue))}`
    const prefix = lowerFirst(ctorName)
    const fields = Object.entries(vshape.fields)
      .filter(([fieldName]) => fieldName !== discriminator)
      .map(([fieldName, fieldRef]) => ({
        jsonName: fieldName,
        hsField: `${prefix}${capitalize(fieldName)}`,
        hsType: fieldHaskellType(ctorName, fieldName, fieldRef, outerDecls),
      }))
    return { ctorName, tagValue, fields }
  })

  const ctorLines = ctors.map((c) =>
    c.fields.length === 0 ? c.ctorName : `${c.ctorName} { ${c.fields.map((f) => `${f.hsField} :: ${f.hsType}`).join(", ")} }`,
  )
  const dataDecl = [`data ${name}`, `  = ${ctorLines.join("\n  | ")}`, `  deriving (Show, Eq, Generic)`].join("\n")

  const toJsonInstance = [
    `instance ToJSON ${name} where`,
    ...ctors.map((c) => {
      const pattern = c.fields.length === 0 ? c.ctorName : `${c.ctorName}{..}`
      const parts = [
        `${quote(discriminator)} .= (${quote(c.tagValue)} :: Text)`,
        ...c.fields.map((f) => `${quote(f.jsonName)} .= ${f.hsField}`),
      ]
      return `  toJSON (${pattern}) = object [${parts.join(", ")}]`
    }),
  ].join("\n")

  const fromJsonInstance = [
    `instance FromJSON ${name} where`,
    `  parseJSON = withObject ${quote(name)} $ \\o -> do`,
    `    tag <- o .: ${quote(discriminator)}`,
    `    case (tag :: Text) of`,
    ...ctors.map((c) => {
      if (c.fields.length === 0) return `      ${quote(c.tagValue)} -> pure ${c.ctorName}`
      const applicative = c.fields
        .map((f, i) => (i === 0 ? `${c.ctorName} <$> o .: ${quote(f.jsonName)}` : `<*> o .: ${quote(f.jsonName)}`))
        .join(" ")
      return `      ${quote(c.tagValue)} -> ${applicative}`
    }),
    `      other -> fail ("Unknown ${name} tag: " ++ T.unpack other)`,
  ].join("\n")

  return [dataDecl, "", toJsonInstance, "", fromJsonInstance].join("\n")
}

function buildPlainUnionDecl(name: string, variants: readonly TypeRef[], outerDecls: string[]): string {
  const used = new Set<string>()
  const ctors = variants.map((variant, index) => {
    const kind = variant.shape.kind
    let base: string
    if (kind === "literal") {
      const value = (variant.shape as TypeShape & { kind: "literal" }).value
      base = typeof value === "string" ? capitalize(sanitizeIdent(value)) : capitalize(sanitizeIdent(String(value)))
    } else if (typeof variant.meta.typeName === "string") {
      base = capitalize(variant.meta.typeName)
    } else {
      base = capitalize(kind)
    }
    let ctorName = `${name}${base}`
    if (used.has(ctorName)) ctorName = `${name}Variant${index + 1}`
    used.add(ctorName)
    const hsType = fieldHaskellType(name, `${base}Payload`, variant, outerDecls)
    return { ctorName, hsType }
  })

  const dataDecl = [
    `data ${name}`,
    `  = ${ctors.map((c) => `${c.ctorName} ${wrapType(c.hsType)}`).join("\n  | ")}`,
    `  deriving (Show, Eq, Generic)`,
  ].join("\n")

  const toJsonInstance = [
    `instance ToJSON ${name} where`,
    ...ctors.map((c) => `  toJSON (${c.ctorName} v) = toJSON v`),
  ].join("\n")

  const fromJsonInstance = [
    `instance FromJSON ${name} where`,
    `  parseJSON v =`,
    `    ` + ctors.map((c) => `(${c.ctorName} <$> parseJSON v)`).join("\n    <|> "),
  ].join("\n")

  return [dataDecl, "", toJsonInstance, "", fromJsonInstance].join("\n")
}

/**
 * `interface` -> a typeclass: the closest Haskell analogue of a service
 * surface (a set of operations any instance type `a` must implement), same
 * KEY use case `method`/`interface` were added for (see capnp.ts's
 * `toCapnpInterface`/flatbuffers.ts's `toFlatBuffersService` for the parallel
 * rationale). The receiver becomes the class's own type variable `a`
 * (prepended as the leading argument of every method), rather than an
 * explicit `thisType` slot.
 */
function buildClassDecl(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "interface" }
  const lines = Object.entries(shape.methods).map(([methodName, methodRef]) => {
    const m = methodRef.shape as TypeShape & {
      kind: "method" | "function"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
    }
    const params = ["a", ...m.params.map((p) => toHaskellType(p.type))]
    return `  ${methodName} :: ${[...params, toHaskellType(m.returnType)].map(wrapType).join(" -> ")}`
  })
  return [`class ${name} a where`, ...lines].join("\n")
}

/**
 * Lower a top-level TypeRef to its Haskell declaration(s) — the main entry
 * point. `name` (defaulting to `ref.meta.typeName`, or `"T"` if neither is
 * given) names the top-level declaration; nested object/enum/union fields are
 * hoisted out as sibling declarations ahead of it, same convention
 * capnp.ts's `toCapnpStruct`/flatbuffers.ts's `toFlatBuffersTable` use.
 * Non-declarable kinds (a bare primitive, array, map, …) degrade to a `type`
 * alias instead of a `data` declaration, since Haskell only needs `data` for
 * genuinely new nominal types.
 */
export function toHaskell(ref: TypeRef, name?: string): string {
  const typeName = capitalize(name ?? (typeof ref.meta.typeName === "string" ? ref.meta.typeName : "T"))
  const decls: string[] = []
  const kind = ref.shape.kind

  let mainDecl: string
  if (isA(kind, "object")) {
    mainDecl = buildRecordDecl(typeName, ref, decls)
  } else if (kind === "enum") {
    mainDecl = buildEnumDecl(typeName, ref)
  } else if (kind === "union") {
    mainDecl = buildUnionDecl(typeName, ref, decls)
  } else if (kind === "interface") {
    mainDecl = buildClassDecl(typeName, ref)
  } else {
    mainDecl = `type ${typeName} = ${toHaskellType(ref)}`
  }

  return [...decls, mainDecl].join("\n\n")
}

/**
 * Lower a registry of top-level TypeRefs (as would back a whole module) to a
 * complete Haskell module: `LANGUAGE`/`import` boilerplate every generated
 * declaration needs (`DeriveGeneric`, aeson, Data.Text, …) followed by each
 * entry's declaration in registry order — the Haskell analogue of
 * typescript.ts's `toTypeDeclarations`/flatbuffers.ts's
 * `toFlatBuffersDeclarations`.
 */
export function toHaskellModule(moduleName: string, registry: Record<string, TypeRef>): string {
  const header = [
    `{-# LANGUAGE DeriveGeneric #-}`,
    `{-# LANGUAGE RecordWildCards #-}`,
    `module ${moduleName} where`,
    ``,
    `import Control.Applicative ((<|>))`,
    `import Data.Aeson`,
    `import Data.ByteString (ByteString)`,
    `import Data.Char (toLower)`,
    `import Data.HashMap.Strict (HashMap)`,
    `import Data.Int (Int8, Int16, Int32, Int64)`,
    `import Data.Map (Map)`,
    `import Data.Text (Text)`,
    `import qualified Data.Text as T`,
    `import Data.Time (Day, NominalDiffTime, TimeOfDay, UTCTime)`,
    `import Data.Vector (Vector)`,
    `import Data.Void (Void)`,
    `import Data.Word (Word8, Word16, Word32, Word64)`,
    `import GHC.Generics (Generic)`,
  ].join("\n")

  const decls = Object.entries(registry).map(([name, ref]) => toHaskell(ref, name))
  return [header, ...decls].join("\n\n")
}
