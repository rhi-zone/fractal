import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// A native PHP type expression (`type`) plus, when PHP's type system can't
// fully express the shape (arrays/maps need an element/key type PHP has no
// generics syntax for; tuples need a fixed shape; enums degrade to their
// backing scalar), a PHPDoc annotation (`doc`) carrying the fuller type for
// static analyzers (PHPStan/Psalm `array<T>`/`array<K, V>`/`array{...}`
// shapes — https://phpstan.org/writing-php-code/phpdoc-types#array-shapes).
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
  // that's `toPhpClass`'s job for a *named* object) degrades to an
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
  // PHP 8.0 union types (https://www.php.net/manual/en/language.types.declarations.php#language.types.declarations.union) —
  // native, so no PHPDoc needed UNLESS a member itself needed one (e.g. a
  // union containing an array), in which case the doc mirrors the union
  // structure with each member's fuller annotation.
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
  // declaration — that's `toPhpEnum`'s job when a name is available (see
  // `toPhp`). In field/property position it degrades to its backing scalar
  // (`string`, matching the backed-enum cases `toPhpEnum` generates) with a
  // PHPDoc listing the literal members, mirroring the `union`/`array` degrade
  // convention above.
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { type: "string", doc: s.members.map(quote).join("|") }
  },
  ref: (shape) => ({ type: (shape as TypeShape & { kind: "ref" }).target }),
  // PHP has no structural intersection-type construct for anything but
  // interfaces — renders as a PHP intersection type (`A&B`, PHP 8.1+), which
  // is only actually valid when every member is a class/interface name; used
  // here as the closest native analog regardless (same best-effort stance
  // protobuf.ts takes for constructs its target can't fully express).
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
// (`A|B`) instead spells `null` out as an explicit member
// (https://www.php.net/manual/en/language.types.declarations.php#language.types.declarations.nullable).
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
 * is modeled as a nullable one defaulting to `null` (see `toPhpClass`). */
export function toPhpType(ref: TypeRef): PhpType {
  const converter = resolve(ref.shape.kind, handlers)
  const base = converter === undefined ? { type: "mixed" } : converter(ref.shape)
  const nullable = ref.meta.optional === true || ref.meta.nullable === true
  return nullable ? applyNullable(base) : base
}

// PHPDoc block (https://docs.phpdoc.org/guide/guides/docblocks.html) —
// `/** ... */` immediately above the declaration it documents, driven by
// `meta.description`/`meta.deprecated`, same open-metadata-bag convention
// rust-serde.ts's/kotlin-kotlinx.ts's own doc-comment helpers use.
// `meta.deprecated` becomes an `@deprecated` tag
// (https://docs.phpdoc.org/guide/references/phpdoc/tags/deprecated.html) —
// with its reason text when `deprecated` is a string, bare otherwise.
function docComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecated = meta.deprecated
  const deprecatedTag = deprecated === true ? "@deprecated" : typeof deprecated === "string" ? `@deprecated ${deprecated}` : undefined
  if (description === undefined && deprecatedTag === undefined) return ""
  const lines = [description, deprecatedTag].filter((line): line is string => line !== undefined)
  return ["/**", ...lines.map((line) => ` * ${line}`), " */\n"].join("\n")
}

/**
 * PHP 8.1 backed enum (https://www.php.net/manual/en/language.enumerations.backed.php):
 * `enum Name: string { case Member = "member"; }`. Always string-backed since
 * `TypeKinds.enum.members` is a plain string list — the case name is a
 * PascalCased, identifier-safe rendering of the member value (see `caseName`);
 * the value itself preserves the original string exactly.
 */
export function toPhpEnum(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "enum" }
  const cases = s.members.map((member) => `    case ${caseName(member)} = ${quote(member)};`)
  return docComment(ref.meta) + [`enum ${name}: string`, "{", ...cases, "}"].join("\n")
}

/**
 * PHP 8.2 `readonly class` (https://www.php.net/manual/en/language.oop5.basic.php#language.oop5.basic.class.readonly-class)
 * with constructor-promoted properties (PHP 8.0,
 * https://www.php.net/manual/en/language.oop5.decon.php#language.oop5.decon.constructor.promotion) —
 * one property per object field, `implements JsonSerializable`
 * (https://www.php.net/manual/en/class.jsonserializable.php) so the class
 * round-trips through `json_encode()`. An optional field (`meta.optional`)
 * gets a `= null` constructor default alongside the nullable type
 * `toPhpType` already produces for it, since PHP has no "key may be absent"
 * notion distinct from an explicit null (see `toPhpType`'s doc comment).
 * Fields whose PHP type can't fully express the shape (arrays, maps, nested
 * anonymous objects, enums, …) get a `@param` PHPDoc line on the constructor.
 */
export function toPhpClass(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "object" }
  const fields = Object.entries(s.fields)

  const paramLines: string[] = []
  const docParams: string[] = []
  const jsonEntries: string[] = []

  fields.forEach(([fieldName, fieldRef], i) => {
    const phpType = toPhpType(fieldRef)
    const optional = fieldRef.meta.optional === true
    const trailingComma = i === fields.length - 1 ? "" : ","
    paramLines.push(`        public ${phpType.type} $${fieldName}${optional ? " = null" : ""}${trailingComma}`)
    if (phpType.doc !== undefined) docParams.push(` * @param ${phpType.doc} $${fieldName}`)
    jsonEntries.push(`            ${quote(fieldName)} => $this->${fieldName},`)
  })

  const docBlock = docParams.length === 0 ? "" : ["    /**", ...docParams, "     */"].join("\n") + "\n"

  return [
    docComment(ref.meta) + `final readonly class ${name} implements \\JsonSerializable`,
    "{",
    docBlock + "    public function __construct(",
    ...paramLines,
    "    ) {}",
    "",
    "    public function jsonSerialize(): array",
    "    {",
    "        return [",
    ...jsonEntries,
    "        ];",
    "    }",
    "}",
  ].join("\n")
}

/**
 * Top-level entry point: an `object` TypeRef becomes a `toPhpClass` readonly
 * class, an `enum` TypeRef becomes a `toPhpEnum` backed enum, and anything
 * else becomes a bare PHP type expression (`toPhpType`) — optionally wrapped
 * in a `@phpstan-type` alias annotation (https://phpstan.org/writing-php-code/phpdoc-types#local-type-aliases)
 * when `name` is given, since PHP itself has no type-alias declaration to
 * emit natively.
 */
export function toPhp(ref: TypeRef, name?: string): string {
  if (ref.shape.kind === "object") return toPhpClass(name ?? "GeneratedClass", ref)
  if (ref.shape.kind === "enum") return toPhpEnum(name ?? "GeneratedEnum", ref)

  const phpType = toPhpType(ref)
  if (name === undefined) return phpType.type
  return `/** @phpstan-type ${name} ${phpType.doc ?? phpType.type} */`
}
