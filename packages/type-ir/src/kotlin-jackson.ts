// Kotlin data class / sealed class projector — Jackson variant. Emits the
// same idiomatic Kotlin shapes as kotlin-kotlinx.ts (data classes for
// `object`, `enum class` for `enum`, `sealed class` for `union`) but
// annotated for `com.fasterxml.jackson.module.kotlin`/`jackson-databind`
// instead of kotlinx.serialization — same "emit source text" convention every
// other projector in this package follows.
// Spec: https://kotlinlang.org/docs/basic-types.html,
// https://kotlinlang.org/docs/data-classes.html,
// https://kotlinlang.org/docs/sealed-classes.html,
// https://github.com/FasterXML/jackson-module-kotlin,
// https://github.com/FasterXML/jackson-annotations
import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

// jackson-module-kotlin resolves a data class's primary constructor via
// Kotlin reflection without needing @JsonCreator (unlike the classic Java
// POJO path in java-jackson.ts, which has no such reflection to lean on) — so
// this projector, like kotlin-kotlinx.ts, needs no per-declaration
// constructor annotation for the common case. @JsonCreator/@JsonValue are
// still emitted where Jackson has no other way to route deserialization: an
// enum's backing wire value (see toEnumClass below).

// A JSON field name isn't always a valid bare Kotlin identifier (kebab-case,
// leading digit, etc.) — reshaped into idiomatic camelCase the same way
// java-jackson.ts's toJavaIdentifier reshapes field names for Java, with
// `@JsonProperty` restoring the original wire name whenever the reshape
// changes it (see the "when name differs" convention this mirrors from
// kotlinx's always-on `@SerialName`: Jackson only needs the annotation when
// the identifier and the wire key diverge).
function toKotlinIdentifier(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0)
  if (parts.length === 0) return "value"
  const [first, ...rest] = parts
  // Only the leading character is lowercased — a `name` split into a SINGLE
  // part (no separators at all, e.g. an already-camelCase wire key like
  // "legacyField") must round-trip unchanged rather than having its whole
  // first segment flattened to lowercase, which would otherwise fabricate a
  // spurious identifier/wire-key divergence (and a needless `@JsonProperty`)
  // for a name that was already a valid, idiomatic Kotlin identifier.
  const leading = first!.charAt(0).toLowerCase() + first!.slice(1)
  const camel = [leading, ...rest.map(capitalize)].join("")
  return /^[A-Za-z_]/.test(camel) ? camel : `_${camel}`
}

// Kotlin enum entries conventionally read SCREAMING_SNAKE_CASE
// (https://kotlinlang.org/docs/coding-conventions.html#property-names) —
// `@JsonProperty` on each entry (see toEnumClass below) preserves the
// original wire value regardless of how the identifier itself is reshaped.
function toEnumEntryName(member: string): string {
  const snake = member
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
  const cleaned = snake.replace(/^_+|_+$/g, "")
  if (cleaned.length === 0) return "UNKNOWN"
  // A Kotlin identifier can't start with a digit.
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Kotlin built-in types: https://kotlinlang.org/docs/basic-types.html. Named
// (object/enum/union) kinds have no anonymous Kotlin equivalent — a data
// class, enum class, and sealed class all require a declaration site — so in
// bare TYPE-EXPRESSION position (a field referencing a shape that isn't being
// separately declared here) they read `meta.typeName` when the caller
// supplied it (same provenance convention as index.ts's `meta.typeName`/
// `meta.declarationFile`) and otherwise degrade honestly rather than
// fabricating a name: `object` -> a structural `Map<String, Any?>`, `union`/
// `enum` -> `Any` (an enum could read `String`, but that would silently
// discard the closed-set constraint an enum actually asserts, which `Any`
// does not pretend to preserve either — both are lossy, `Any` just doesn't
// lie about being closed). Identical to kotlin-kotlinx.ts's handler table —
// the wire-level TYPE mapping doesn't depend on which serialization library
// annotates the declaration.
const handlers: Record<string, Converter> = {
  boolean: leaf("Boolean"),
  number: leaf("Double"),
  integer: leaf("Int"),
  int32: leaf("Int"),
  int64: leaf("Long"),
  float32: leaf("Float"),
  float64: leaf("Double"),
  string: leaf("String"),
  uuid: leaf("String"),
  uri: leaf("String"),
  email: leaf("String"),
  // kotlinx-datetime (https://github.com/Kotlin/kotlinx-datetime) is the
  // idiomatic choice for temporal types once a project depends on it; `time`/
  // `duration` degrade to `String`/`kotlin.time.Duration` since kotlinx-datetime
  // has no bare "wall-clock time of day" type of its own.
  datetime: leaf("kotlinx.datetime.Instant"),
  date: leaf("kotlinx.datetime.LocalDate"),
  time: leaf("String"),
  duration: leaf("kotlin.time.Duration"),
  bytes: leaf("ByteArray"),
  null: leaf("Nothing?"),
  void: leaf("Unit"),
  unknown: leaf("Any"),
  never: leaf("Nothing"),
  object: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "Map<String, Any?>"),
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — the caller
  // (whatever assembles this emitted source into a Kotlin file) is
  // responsible for having `className` in scope/imported from `source`.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => `List<${toKotlinType((shape as TypeShape & { kind: "array" }).element)}>`,
  // Kotlin has no native async-sequence value type analogous to
  // AsyncIterable<T> in field/property position (Flow<T> is coroutine-scoped,
  // not a plain data type) — degrades to `List<T>`, same convention every
  // other data-only projector's `stream` fallback uses.
  stream: (shape) => `List<${toKotlinType((shape as TypeShape & { kind: "stream" }).element)}>`,
  // No native pagination construct — degrades to `List<T>` of the page's
  // element type, same honest-degrade convention `stream` uses above.
  page: (shape) => `List<${toKotlinType((shape as TypeShape & { kind: "page" }).element)}>`,
  // https://kotlinlang.org/api/core/kotlin-stdlib/kotlin/-pair/ and -triple/ —
  // Kotlin's stdlib only ships 2- and 3-element product types; 4+ elements
  // have no stdlib equivalent and degrade to `List<Any?>` (lossy — drops
  // per-position typing, same tradeoff typescript.ts's peers take elsewhere).
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    if (s.elements.length === 2) {
      return `Pair<${toKotlinType(s.elements[0]!)}, ${toKotlinType(s.elements[1]!)}>`
    }
    if (s.elements.length === 3) {
      return `Triple<${toKotlinType(s.elements[0]!)}, ${toKotlinType(s.elements[1]!)}, ${toKotlinType(s.elements[2]!)}>`
    }
    return "List<Any?>"
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `Map<${toKotlinType(s.key)}, ${toKotlinType(s.value)}>`
  },
  union: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "Any"),
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "Nothing?"
    if (typeof s.value === "string") return "String"
    if (typeof s.value === "boolean") return "Boolean"
    return Number.isInteger(s.value) ? "Int" : "Double"
  },
  enum: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "Any"),
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No intersection/mixin construct outside experimental context receivers —
  // lossy: falls back to the first member's type, dropping the rest (same
  // convention protobuf.ts/capnp.ts use for their own missing intersection).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "Any" : toKotlinType(first)
  },
  // https://kotlinlang.org/docs/lambdas.html#function-types — `(A, B) -> R`.
  // An explicit `thisType` becomes a Kotlin function-type receiver
  // (`ThisType.(A) -> R`, https://kotlinlang.org/docs/lambdas.html#function-types-with-receiver).
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const params = s.params.map((p) => toKotlinType(p.type)).join(", ")
    const receiver = s.thisType === undefined ? "" : `${toKotlinType(s.thisType)}.`
    return `${receiver}(${params}) -> ${toKotlinType(s.returnType)}`
  },
  // `method` has no explicit entry — `registerParent("method", "function")`
  // falls back to the `function` handler above for the bare-type-expression
  // case (a method embedded in ordinary field position).
  //
  // A service surface has no Kotlin field-position construct of its own —
  // degrades to `Any`, same as `object`'s honest-degrade fallback above (an
  // `interface` TypeRef used as a top-level declaration instead becomes a
  // real Kotlin `interface` — see `toKotlin`'s interface branch below).
  interface: leaf("Any"),
}

/** Inline type expression — used for field types, list/map element types,
 * etc. Named (object/enum/union) kinds without `meta.typeName` degrade
 * honestly rather than fabricating a declaration site; see the `handlers`
 * doc comment above for the exact per-kind fallback. */
export function toKotlinType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const type = converter === undefined ? "Any" : converter(ref.shape, ref.meta)
  const nullable = ref.meta.nullable === true || ref.meta.optional === true
  return nullable && !type.endsWith("?") ? `${type}?` : type
}

// KDoc (https://kotlinlang.org/docs/kotlin-doc.html) comment above a
// declaration — driven by `meta.description`/`meta.deprecated`, same
// open-metadata-bag convention typescript.ts's docComment/jsdoc.ts use.
function docComment(meta: Readonly<Record<string, unknown>>, indent: string): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecated = meta.deprecated === true
  if (description === undefined && !deprecated) return ""
  if (description !== undefined && deprecated) {
    return [`${indent}/**`, `${indent} * ${description}`, `${indent} * @deprecated`, `${indent} */`, ""].join("\n")
  }
  if (description !== undefined) return `${indent}/** ${description} */\n`
  return `${indent}/** @deprecated */\n`
}

// Unlike kotlin-kotlinx.ts (which only surfaces `meta.deprecated` in the KDoc
// `@deprecated` tag), Jackson output additionally carries Kotlin's own
// `@Deprecated` annotation — the compiler-enforced warning kotlinx's variant
// has no annotation-library reason to add, but this variant's brief calls
// for explicitly. `@Deprecated` requires a message argument
// (https://kotlinlang.org/docs/annotations.html), so a description-less
// deprecation still needs a placeholder string.
function deprecatedAnnotation(meta: Readonly<Record<string, unknown>>, indent: string): string {
  if (meta.deprecated !== true) return ""
  const description = typeof meta.description === "string" ? meta.description : "Deprecated"
  return `${indent}@Deprecated(${quote(description)})\n`
}

// Renders `meta.default` as a Kotlin literal when it's one of the JSON
// scalar shapes with an obvious Kotlin spelling (string/number/boolean/null).
// Anything else (an object/array default) has no single-expression Kotlin
// literal form worth fabricating here — undefined signals "no default
// literal available," and the caller falls back to `optional`'s plain
// `= null` (or omits a default entirely for a required field).
function defaultLiteral(value: unknown): string | undefined {
  if (value === null) return "null"
  if (typeof value === "string") return quote(value)
  if (typeof value === "boolean") return String(value)
  if (typeof value === "number") return String(value)
  return undefined
}

type FieldResult = { type: string; nested: string[] }

/**
 * A field's Kotlin type plus any nested declarations it needed to synthesize.
 * Nested object/enum/union fields have no anonymous Kotlin form (unlike
 * TypeScript's inline `{ ... }` object types), so — same convention
 * protobuf.ts's `toProtoMessage`/capnp.ts's `toCapnpStruct` use for their own
 * nested messages/structs — a nested declaration is synthesized here, named
 * by capitalizing the field name, and returned alongside the field's type
 * reference to that name.
 */
function declareField(fieldName: string, fieldRef: TypeRef): FieldResult {
  const nested: string[] = []
  let type: string

  if (isA(fieldRef.shape.kind, "object")) {
    const nestedName = capitalize(fieldName)
    nested.push(toKotlin(fieldRef, nestedName))
    type = nestedName
  } else if (
    fieldRef.shape.kind === "array" &&
    isA((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind, "object")
  ) {
    const nestedName = capitalize(fieldName)
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    nested.push(toKotlin(element, nestedName))
    type = `List<${nestedName}>`
  } else if (fieldRef.shape.kind === "enum") {
    const nestedName = capitalize(fieldName)
    nested.push(toKotlin(fieldRef, nestedName))
    type = nestedName
  } else if (fieldRef.shape.kind === "union") {
    const nestedName = capitalize(fieldName)
    nested.push(toKotlin(fieldRef, nestedName))
    type = nestedName
  } else {
    type = toKotlinType(fieldRef)
  }

  const nullable = fieldRef.meta.optional === true || fieldRef.meta.nullable === true
  if (nullable && !type.endsWith("?")) type += "?"
  return { type, nested }
}

// https://kotlinlang.org/docs/data-classes.html +
// https://github.com/FasterXML/jackson-annotations —
// `@JsonIgnoreProperties(ignoreUnknown = true)` (rather than kotlinx's
// `@Serializable`) marks the class for Jackson while tolerating wire fields
// the IR doesn't know about — the conventional default for a data class
// deserialized from an external/evolving API, matching java-jackson.ts's
// pojo style's tolerance-by-default posture. Every declared field becomes a
// primary-constructor `val`/`var`; an optional field gets a `= null` default
// (or `meta.default`'s literal, when Jackson-representable — see
// `defaultLiteral`) so callers can omit it, matching how `optional` is
// understood everywhere else in type-ir (a field that MAY be absent, not one
// that's merely nullable).
function toDataClass(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const nestedDecls: string[] = []
  const params = Object.entries(shape.fields).map(([fieldName, fieldRef]) => {
    const { type, nested } = declareField(fieldName, fieldRef)
    nestedDecls.push(...nested)
    const readonly = fieldRef.meta.readonly === true
    const optional = fieldRef.meta.optional === true
    const kotlinName = toKotlinIdentifier(fieldName)
    const jsonProperty = kotlinName !== fieldName ? `@JsonProperty(${quote(fieldName)}) ` : ""
    const fieldDoc = docComment(fieldRef.meta, "    ")
    const deprecated = deprecatedAnnotation(fieldRef.meta, "    ")
    const keyword = readonly ? "val" : "var"
    const literal = "default" in fieldRef.meta ? defaultLiteral(fieldRef.meta.default) : undefined
    const suffix = literal !== undefined ? ` = ${literal}` : optional ? " = null" : ""
    return `${fieldDoc}${deprecated}    ${jsonProperty}${keyword} ${kotlinName}: ${type}${suffix}`
  })

  const lines = [
    docComment(ref.meta, ""),
    deprecatedAnnotation(ref.meta, ""),
    "@JsonIgnoreProperties(ignoreUnknown = true)",
    `data class ${name}(`,
    params.join(",\n"),
    ")",
  ]
  const decl = lines.filter((l) => l !== "").join("\n")
  return [decl, ...nestedDecls].join("\n\n")
}

// https://kotlinlang.org/docs/enum-classes.html +
// https://github.com/FasterXML/jackson-annotations#jsonproperty — `@JsonProperty`
// per entry preserves the exact wire string regardless of how
// `toEnumEntryName` reshapes the Kotlin identifier (Jackson has supported
// `@JsonProperty` directly on enum constants since 2.6, so no separate
// backing-field + `@JsonValue`/`@JsonCreator` pair is needed the way
// java-jackson.ts's classic-Java rendering requires).
function toEnumClass(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "enum" }
  const entries = shape.members.map((member) => `    @JsonProperty(${quote(member)}) ${toEnumEntryName(member)}`)
  const lines = [docComment(ref.meta, ""), deprecatedAnnotation(ref.meta, ""), `enum class ${name} {`, entries.join(",\n"), "}"]
  return lines.filter((l) => l !== "").join("\n")
}

/** True when every union variant is (or descends from) `object` and they all
 * carry the same literal-valued discriminant field named `discriminator` —
 * the shape `meta.discriminator` (the open-metadata-bag convention zod.ts /
 * json-schema.ts / openapi30.ts / valibot.ts all key discriminated-union
 * codegen off of) asserts. Required for the `@JsonTypeInfo`/`@JsonSubTypes`
 * encoding below; a plain union without this falls back to a bare marker
 * `sealed class` with no Jackson polymorphism annotations — Jackson has no
 * default way to pick among structurally arbitrary variants, so
 * deserialization of that case is left to the caller (e.g. a custom
 * deserializer), same honest-degrade convention java-jackson.ts's
 * `renderSealedInterface` uses for the same case. */
function discriminantValue(variant: TypeRef, discriminator: string): string | undefined {
  if (!isA(variant.shape.kind, "object")) return undefined
  const field = (variant.shape as TypeShape & { kind: "object" }).fields[discriminator]
  if (field === undefined || field.shape.kind !== "literal") return undefined
  const value = (field.shape as TypeShape & { kind: "literal" }).value
  return typeof value === "string" ? value : undefined
}

// https://kotlinlang.org/docs/sealed-classes.html +
// https://github.com/FasterXML/jackson-annotations#jsontypeinfo — Jackson (unlike
// kotlinx.serialization) has no automatic sealed-class polymorphism of its
// own, so the discriminant key is spelled out explicitly:
// `@JsonTypeInfo(use = Id.NAME, include = As.EXISTING_PROPERTY, property =
// "<discriminator>")` tells Jackson to resolve the concrete subtype from that
// existing field rather than injecting a synthetic wrapper property, and
// `@JsonSubTypes` maps each discriminant literal from the IR to its Kotlin
// subclass — both placed on the sealed parent (Jackson resolves polymorphism
// from the declared/static type, i.e. the parent), matching
// java-jackson.ts's `renderSealedInterface` placement for the same reason.
function toSealedClass(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "union" }
  const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
  const nestedDecls: string[] = []

  const variantNames = shape.variants.map((variant, i) => {
    const tag = discriminator === undefined ? undefined : discriminantValue(variant, discriminator)
    return tag !== undefined ? capitalize(tag) : `Variant${i + 1}`
  })

  const variantDecls = shape.variants.map((variant, i) => {
    const tag = discriminator === undefined ? undefined : discriminantValue(variant, discriminator)
    const variantName = variantNames[i]!

    if (isA(variant.shape.kind, "object")) {
      // The discriminant field itself is structural noise once it's encoded
      // as the sealed subclass's own type identity (via @JsonSubTypes on the
      // parent) — drop it from the generated data class's fields, same as
      // every other discriminated-union projector in this package (e.g.
      // from-jtd.ts's reconstruction, in reverse).
      const objShape = variant.shape as TypeShape & { kind: "object" }
      const fields =
        tag === undefined
          ? objShape.fields
          : Object.fromEntries(Object.entries(objShape.fields).filter(([fieldName]) => fieldName !== discriminator))
      const variantRef = { shape: { ...objShape, fields }, meta: variant.meta }
      const classDecl = toDataClass(variantName, variantRef)
      // `toDataClass` always ends its own class body with a bare ")" line
      // (see its `lines` array), so splicing `: Name()` onto the first
      // "paragraph"'s closing paren only ever matches that line, never a
      // nested declaration's closing paren (those are joined in afterwards,
      // with a blank-line separator, by `toDataClass`'s own return).
      const [ownDecl, ...rest] = classDecl.split("\n\n")
      return [`${ownDecl!.replace(/\)$/, `) : ${name}()`)}`, ...rest].join("\n\n")
    }

    // A non-object variant (e.g. a bare string/number in the union) has no
    // fields to lift into a data class — wrap it as a single-value carrier,
    // the idiomatic Kotlin pattern for a sealed subtype over a scalar.
    const { type, nested } = declareField(`${variantName}Value`, variant)
    nestedDecls.push(...nested)
    return `@JsonIgnoreProperties(ignoreUnknown = true)\ndata class ${variantName}(val value: ${type}) : ${name}()`
  })

  const header = [docComment(ref.meta, ""), deprecatedAnnotation(ref.meta, "")]
  if (discriminator !== undefined) {
    header.push(
      `@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.EXISTING_PROPERTY, property = ${quote(discriminator)})`,
    )
    header.push("@JsonSubTypes(")
    header.push(
      shape.variants
        .map((variant, i) => {
          const tag = discriminantValue(variant, discriminator)
          const jsonName = tag ?? variantNames[i]!
          return `  @JsonSubTypes.Type(value = ${variantNames[i]}::class, name = ${quote(jsonName)})`
        })
        .join(",\n"),
    )
    header.push(")")
  }
  header.push(`sealed class ${name}`)
  const decl = header.filter((l) => l !== "").join("\n")
  return [decl, ...variantDecls, ...nestedDecls].join("\n\n")
}

/**
 * Top-level declaration entry point — `toKotlin(ref, name)` emits a
 * `data class`/`enum class`/`sealed class` declaration (plus any nested
 * declarations synthesized along the way) for named kinds, or a `typealias`
 * for everything else. Without a `name`, only kinds that already have a bare
 * type expression (primitives, arrays, maps, tuples, refs, …) make sense — a
 * named kind with no name falls back to `"Anonymous"` rather than silently
 * producing unnamed Kotlin, since every named Kotlin declaration needs an
 * identifier.
 */
export function toKotlin(ref: TypeRef, name?: string): string {
  if (ref.shape.kind === "object" || ref.shape.kind === "union" || ref.shape.kind === "enum") {
    const declName = name ?? "Anonymous"
    if (ref.shape.kind === "object") return toDataClass(declName, ref)
    if (ref.shape.kind === "enum") return toEnumClass(declName, ref)
    return toSealedClass(declName, ref)
  }
  if (name === undefined) return toKotlinType(ref)
  return `typealias ${name} = ${toKotlinType(ref)}`
}

const JACKSON_IMPORTS = ["import com.fasterxml.jackson.annotation.*", "import com.fasterxml.jackson.module.kotlin.*"]

/** Renders every registry entry as a top-level declaration, preceded by the
 * two Jackson import lines every annotation above depends on
 * (`@JsonProperty`/`@JsonIgnoreProperties`/`@JsonTypeInfo`/`@JsonSubTypes`
 * live in `com.fasterxml.jackson.annotation`; `jackson-module-kotlin`'s
 * reflection-based data-class support lives in
 * `com.fasterxml.jackson.module.kotlin`). Unlike java-jackson.ts's
 * per-declaration `assembleSource` (which also handles a `package` line),
 * this package's Kotlin emission — like kotlin-kotlinx.ts's — has no
 * per-declaration package/import assembly of its own; imports are collected
 * once here, at the whole-file level, since the caller composing the
 * generated declarations into a single `.kt` file needs exactly one import
 * block regardless of how many types this registry declares. */
export function toKotlinDeclarations(registry: Record<string, TypeRef>): string {
  const body = Object.entries(registry)
    .map(([name, ref]) => toKotlin(ref, name))
    .join("\n\n")
  return [...JACKSON_IMPORTS, "", body].join("\n")
}
