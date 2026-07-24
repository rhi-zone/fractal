import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// ============================================================================
// PHP/Symfony Serializer projector — TypeRef -> idiomatic PHP 8.1+ source
// using the Symfony Serializer component
// (https://symfony.com/doc/current/components/serializer.html) for JSON
// (de)serialization, instead of a hand-rolled `JsonSerializable`
// implementation (see php-native.ts, this projector's sibling and template —
// same PhpType split, same readonly-class-with-promoted-properties shape;
// only the annotation vocabulary and the class body differ).
//
// Symfony Serializer vs. native, structurally:
//   - Field naming: `#[SerializedName('wire-name')]`
//     (`Symfony\Component\Serializer\Attribute\SerializedName`,
//     https://symfony.com/doc/current/components/serializer.html#using-serialization-groups-and-name-conversion)
//     is a PHP 8 attribute placed directly on the constructor-promoted
//     property, read reflectively by the serializer — no
//     `jsonSerialize()`/`JsonSerializable` implementation needed the way
//     php-native.ts's hand-rolled encoding requires, since Symfony's
//     `ObjectNormalizer` walks the class's own properties.
//   - Field selection: `#[Groups(['group1', 'group2'])]`
//     (https://symfony.com/doc/current/components/serializer.html#attributes-groups)
//     restricts a property to specific (de)serialization contexts — this
//     projector reads an optional `meta.serializationGroups: string[]` (the
//     same open-metadata-bag convention every projector in this package
//     uses for its own out-of-band hints) and, when present, emits
//     `#[Groups([...])]` alongside `#[SerializedName]`.
//   - Enums: PHP 8.1 backed enums (the same construct php-native.ts's
//     `toPhpEnum` already emits) serialize natively through Symfony's
//     `BackedEnumNormalizer` by their own backing value — no extra
//     attribute needed, so this projector reuses the identical backed-enum
//     shape.
//   - Polymorphism/unions: Symfony's discriminator-based polymorphism is
//     declared on the *parent* type via
//     `#[DiscriminatorMap(typeProperty: 'type', mapping: [...])]`
//     (`Symfony\Component\Serializer\Attribute\DiscriminatorMap`,
//     https://symfony.com/doc/current/components/serializer.html#discriminator-fields-in-class-hierarchies) —
//     this projector emits an abstract base class carrying that attribute
//     plus one final class per variant extending it, when `meta.discriminator`
//     is present. A plain (non-discriminated) union has no Symfony
//     discriminator to attach and degrades to the same `A|B` native PHP
//     union type php-native.ts's `union` handler produces.
// ============================================================================

type PhpType = { type: string; doc?: string }

type Converter = (shape: TypeShape) => PhpType

const leaf =
  (type: string): Converter =>
  () => ({ type })

function quote(value: string): string {
  return JSON.stringify(value)
}

// PHP 8.1 enum case names must be valid identifiers — member strings (often
// lowercase/kebab/snake wire values) are PascalCased and sanitized into one.
function caseName(member: string): string {
  const cleaned = member.replace(/[^a-zA-Z0-9_]+/g, "_")
  const capitalized = cleaned.length === 0 ? "_" : cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return /^[0-9]/.test(capitalized) ? `_${capitalized}` : capitalized
}

const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("float"),
  integer: leaf("int"),
  string: leaf("string"),
  // PHP has no native binary-string type — `string` is byte-oriented already
  // (no encoding assumption), same degrade `bytes` gets elsewhere.
  bytes: leaf("string"),
  null: leaf("null"),
  void: leaf("void"),
  unknown: leaf("mixed"),
  never: leaf("never"),
  // An inline/anonymous object (no name to hang a class declaration off of —
  // that's `toSymfonyClass`'s job for a *named* object) degrades to an
  // associative array with a PHPStan/Psalm array-shape PHPDoc, the same
  // honest-degrade convention other projectors use for constructs their
  // target can't express structurally.
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const shapeDoc = Object.entries(s.fields)
      .map(([fieldName, fieldRef]) => {
        const field = toPhpType(fieldRef)
        return `${fieldName}: ${field.doc ?? field.type}`
      })
      .join(", ")
    return { type: "array", doc: `array{${shapeDoc}}` }
  },
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — renders as a
  // reference to that class name; the caller assembling the emitted source
  // is responsible for the corresponding `use` import.
  instance: (shape) => ({ type: (shape as TypeShape & { kind: "instance" }).className }),
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    const element = toPhpType(s.element)
    return { type: "array", doc: `array<${element.doc ?? element.type}>` }
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const elements = s.elements.map((element) => {
      const el = toPhpType(element)
      return el.doc ?? el.type
    })
    return { type: "array", doc: `array{${elements.join(", ")}}` }
  },
  // No native async-stream construct — degrades to `iterable` (PHP's
  // Traversable|array union, the closest built-in analog to a lazily
  // produced sequence), same honest-degrade convention `array` uses above
  // for the element-type PHPDoc.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    const element = toPhpType(s.element)
    return { type: "iterable", doc: `iterable<${element.doc ?? element.type}>` }
  },
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    const element = toPhpType(s.element)
    return { type: "array", doc: `array<${element.doc ?? element.type}>` }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = toPhpType(s.key)
    const value = toPhpType(s.value)
    const keyDoc = s.key.shape.kind === "string" ? "string" : (key.doc ?? key.type)
    return { type: "array", doc: `array<${keyDoc}, ${value.doc ?? value.type}>` }
  },
  // PHP 8.0 union types — native, so no PHPDoc needed UNLESS a member itself
  // needed one (e.g. a union containing an array), in which case the doc
  // mirrors the union structure with each member's fuller annotation.
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    const members = s.variants.map(toPhpType)
    const types = Array.from(new Set(members.map((m) => m.type)))
    const needsDoc = members.some((m) => m.doc !== undefined)
    return needsDoc
      ? { type: types.join("|"), doc: members.map((m) => m.doc ?? m.type).join("|") }
      : { type: types.join("|") }
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return { type: "null" }
    if (typeof s.value === "string") return { type: "string" }
    if (typeof s.value === "boolean") return { type: "bool" }
    return { type: Number.isInteger(s.value) ? "int" : "float" }
  },
  // A bare (unnamed) enum TypeRef has nowhere to hang a PHP 8.1 backed-enum
  // declaration — that's `toSymfonyEnum`'s job when a name is available (see
  // `toSymfony`). In field/property position it degrades to its backing
  // scalar (`string`, matching the backed-enum cases `toSymfonyEnum`
  // generates) with a PHPDoc listing the literal members.
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { type: "string", doc: s.members.map(quote).join("|") }
  },
  ref: (shape) => ({ type: (shape as TypeShape & { kind: "ref" }).target }),
  // PHP has no structural intersection-type construct for anything but
  // interfaces — renders as a PHP intersection type (`A&B`, PHP 8.1+), which
  // is only actually valid when every member is a class/interface name; used
  // here as the closest native analog regardless (same best-effort stance
  // php-native.ts takes).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return { type: s.members.map((member) => toPhpType(member).type).join("&") }
  },
  function: leaf("callable"),
  // No field-level construct for a method surface — degrades to `object`,
  // same honest-degrade stance `instance`/`function` take above.
  interface: leaf("object"),
}

function isNullable(base: PhpType): boolean {
  if (base.type === "null" || base.type === "mixed") return true
  return base.type.split("|").includes("null")
}

// PHP's `?T` nullable shorthand only applies to a single type; a union
// (`A|B`) instead spells `null` out as an explicit member.
function applyNullable(base: PhpType): PhpType {
  if (isNullable(base)) return base
  const isUnion = base.type.includes("|")
  const type = isUnion ? `${base.type}|null` : `?${base.type}`
  return base.doc === undefined ? { type } : { type, doc: `${base.doc}|null` }
}

/** Convert a `TypeRef` to a PHP type expression usable in a property/param/
 * return-type position, plus (when PHP's native type system can't fully
 * express the shape) a richer PHPDoc annotation. `meta.optional`/
 * `meta.nullable` both render as PHP nullability — PHP has no notion of an
 * "absent key" distinct from an explicit `null` value, so an optional field
 * is modeled as a nullable one defaulting to `null` (see `toSymfonyClass`). */
export function toPhpType(ref: TypeRef): PhpType {
  const converter = resolve(ref.shape.kind, handlers)
  const base = converter === undefined ? { type: "mixed" } : converter(ref.shape)
  const nullable = ref.meta.optional === true || ref.meta.nullable === true
  return nullable ? applyNullable(base) : base
}

// PHPDoc block (https://docs.phpdoc.org/guide/guides/docblocks.html) —
// `/** ... */` immediately above the declaration it documents, driven by
// `meta.description`/`meta.deprecated`, same open-metadata-bag convention
// php-native.ts's own doc-comment helper uses. `meta.deprecated` becomes an
// `@deprecated` tag — with its reason text when `deprecated` is a string,
// bare otherwise.
function docComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecated = meta.deprecated
  const deprecatedTag = deprecated === true ? "@deprecated" : typeof deprecated === "string" ? `@deprecated ${deprecated}` : undefined
  if (description === undefined && deprecatedTag === undefined) return ""
  const lines = [description, deprecatedTag].filter((line): line is string => line !== undefined)
  return ["/**", ...lines.map((line) => ` * ${line}`), " */\n"].join("\n")
}

/** Reads `meta.serializationGroups: string[]` — an out-of-band hint (same
 * open-metadata-bag convention every projector in this package uses for its
 * own extension points) naming the Symfony serialization groups a field
 * belongs to. Absent by default; when present, renders as a
 * `#[Groups([...])]` attribute alongside `#[SerializedName]`. */
function serializationGroupsOf(meta: Readonly<Record<string, unknown>>): string[] | undefined {
  const groups = meta.serializationGroups
  return Array.isArray(groups) && groups.every((g) => typeof g === "string") ? (groups as string[]) : undefined
}

/**
 * PHP 8.1 backed enum (https://www.php.net/manual/en/language.enumerations.backed.php):
 * `enum Name: string { case Member = "member"; }`. Always string-backed since
 * `TypeKinds.enum.members` is a plain string list — the case name is a
 * PascalCased, identifier-safe rendering of the member value (see `caseName`);
 * the value itself preserves the original string exactly. Symfony's
 * `BackedEnumNormalizer` (de)serializes this shape natively, no attribute
 * needed.
 */
export function toSymfonyEnum(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "enum" }
  const cases = s.members.map((member) => `    case ${caseName(member)} = ${quote(member)};`)
  return docComment(ref.meta) + [`enum ${name}: string`, "{", ...cases, "}"].join("\n")
}

/**
 * PHP 8.2 `readonly class` with constructor-promoted properties, each tagged
 * `#[SerializedName('wire-name')]` (and, when `meta.serializationGroups` is
 * present, `#[Groups([...])]`) so Symfony's `ObjectNormalizer` reads/writes
 * it correctly without a hand-rolled `jsonSerialize()` method — unlike
 * php-native.ts's `toPhpClass`, this class doesn't implement
 * `\JsonSerializable` itself; Symfony's serializer walks the promoted
 * properties reflectively. An optional field (`meta.optional`) gets a
 * `= null` constructor default alongside the nullable type `toPhpType`
 * already produces for it. Fields whose PHP type can't fully express the
 * shape (arrays, maps, nested anonymous objects, enums, …) get a `@param`
 * PHPDoc line on the constructor.
 */
export function toSymfonyClass(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "object" }
  const fields = Object.entries(s.fields)

  const paramLines: string[] = []
  const docParams: string[] = []

  fields.forEach(([fieldName, fieldRef], i) => {
    const phpType = toPhpType(fieldRef)
    const optional = fieldRef.meta.optional === true
    const trailingComma = i === fields.length - 1 ? "" : ","
    const groups = serializationGroupsOf(fieldRef.meta)
    const attrs = [`#[SerializedName(${quote(fieldName)})]`]
    if (groups !== undefined) attrs.push(`#[Groups([${groups.map(quote).join(", ")}])]`)
    paramLines.push(`        ${attrs.join(" ")}`)
    paramLines.push(`        public ${phpType.type} $${fieldName}${optional ? " = null" : ""}${trailingComma}`)
    if (phpType.doc !== undefined) docParams.push(` * @param ${phpType.doc} $${fieldName}`)
  })

  const docBlock = docParams.length === 0 ? "" : ["    /**", ...docParams, "     */"].join("\n") + "\n"

  return [
    docComment(ref.meta) + `final readonly class ${name}`,
    "{",
    docBlock + "    public function __construct(",
    ...paramLines,
    "    ) {}",
    "}",
  ].join("\n")
}

/**
 * Discriminated (`meta.discriminator`) union -> an abstract base class
 * carrying `#[DiscriminatorMap(typeProperty: '...', mapping: [...])]`
 * (https://symfony.com/doc/current/components/serializer.html#discriminator-fields-in-class-hierarchies)
 * plus one `final` subclass per variant, extending the base. The
 * discriminator field itself is dropped from each variant's constructor
 * (Symfony reads/writes it through the discriminator map, not as a regular
 * property, mirroring the convention csharp-systemtextjson.ts's
 * `emitUnionType` uses for the same field). A non-object variant (no fields
 * to lift into a subclass) is wrapped in a single-property carrier class.
 * A plain (non-discriminated) union has no Symfony attribute to attach — it
 * degrades to the bare native PHP union type `toPhpType` already produces.
 */
export function toSymfonyDiscriminatedUnion(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "union" }
  const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
  if (discriminator === undefined) {
    const phpType = toPhpType(ref)
    return `/** @phpstan-type ${name} ${phpType.doc ?? phpType.type} */`
  }

  const names = shape.variants.map((variant, i) => {
    if (typeof variant.meta.typeName === "string") return variant.meta.typeName
    return `${name}Variant${i + 1}`
  })

  const mapping = names
    .map((vName, i) => {
      const tag = discriminatorValue(shape.variants[i]!, discriminator)
      return `${tag ?? vName}: ${vName}::class`
    })
    .join(", ")

  const decls = shape.variants.map((variant, i) => {
    const vName = names[i]!
    if (variant.shape.kind !== "object") {
      const inner = toPhpType(variant)
      return `final readonly class ${vName} extends ${name}\n{\n    public function __construct(\n        #[SerializedName('value')]\n        public ${inner.type} $value,\n    ) {}\n}`
    }
    const objShape = variant.shape as TypeShape & { kind: "object" }
    const fields = Object.fromEntries(
      Object.entries(objShape.fields).filter(([fieldName]) => fieldName !== discriminator),
    )
    const variantRef = { shape: { ...objShape, fields }, meta: variant.meta }
    const body = toSymfonyClass(vName, variantRef)
    // `toSymfonyClass` always renders `final readonly class {vName}\n{` as
    // its declaration line (once any KDoc-style comment precedes it) —
    // swap in `extends {name}` so the variant participates in the
    // discriminator hierarchy.
    return body.replace(`final readonly class ${vName}\n{`, `final readonly class ${vName} extends ${name}\n{`)
  })

  const header = [
    docComment(ref.meta),
    `#[DiscriminatorMap(typeProperty: ${quote(discriminator)}, mapping: [${mapping}])]`,
    `abstract class ${name}`,
    "{",
    "}",
  ]
    .filter((l) => l !== "")
    .join("\n")

  return [header, ...decls].join("\n\n")
}

function discriminatorValue(variant: TypeRef, discriminator: string): string | undefined {
  if (variant.shape.kind !== "object") return undefined
  const field = (variant.shape as TypeShape & { kind: "object" }).fields[discriminator]
  if (field === undefined || field.shape.kind !== "literal") return undefined
  const value = (field.shape as TypeShape & { kind: "literal" }).value
  return typeof value === "string" ? quote(value) : undefined
}

/**
 * Top-level entry point: an `object` TypeRef becomes a `toSymfonyClass`
 * readonly class, an `enum` TypeRef becomes a `toSymfonyEnum` backed enum, a
 * discriminated `union` TypeRef becomes a `toSymfonyDiscriminatedUnion`
 * hierarchy, and anything else becomes a bare PHP type expression
 * (`toPhpType`) — optionally wrapped in a `@phpstan-type` alias annotation
 * when `name` is given, since PHP itself has no type-alias declaration to
 * emit natively.
 */
export function toSymfony(ref: TypeRef, name?: string): string {
  if (ref.shape.kind === "object") return toSymfonyClass(name ?? "GeneratedClass", ref)
  if (ref.shape.kind === "enum") return toSymfonyEnum(name ?? "GeneratedEnum", ref)
  if (ref.shape.kind === "union") return toSymfonyDiscriminatedUnion(name ?? "GeneratedUnion", ref)

  const phpType = toPhpType(ref)
  if (name === undefined) return phpType.type
  return `/** @phpstan-type ${name} ${phpType.doc ?? phpType.type} */`
}
