import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// built_value (https://pub.dev/packages/built_value) is Dart's older
// code-generation package for immutable value types built around the
// abstract-class-plus-generated-concrete-class pattern:
// `abstract class Foo implements Built<Foo, FooBuilder>` declares the shape,
// and a `build.yaml`/build_runner pass generates the concrete `_$Foo` (the
// class actually instantiated, via `Foo((b) => b..field = value)`) plus a
// mutable `FooBuilder`. Unlike dart-freezed.ts's `const factory` constructor
// syntax, built_value's declaration idiom is:
//
//   - Fields are ABSTRACT GETTERS (`String get name;`), not constructor
//     parameters — built_value derives the builder's mutable fields from
//     these getter signatures, so there's no parameter list to write at all.
//   - `Foo._()` is a required private, empty, unnamed constructor (built_value's
//     own convention — the generated `_$Foo` subclass calls it internally;
//     https://github.com/google/built_value.dart/blob/master/built_value/README.md#value-types).
//   - `static Serializer<Foo> get serializer => _$fooSerializer;` is
//     built_value's `@BuiltValueSerializer`-adjacent hook wiring the type
//     into a `built_value.serializer` `Serializers` registry (this
//     projector's rendering of "how does this type participate in JSON
//     (de)serialization" — the direct analogue of freezed's
//     `fromJson`/`_$FooFromJson` factory).
//   - `factory Foo([void Function(FooBuilder) updates]) = _$Foo;` is the
//     public constructor surface a caller actually uses
//     (`Foo((b) => b.name = 'x')`), replacing freezed's `const factory`.
//
// Nested object/union/enum fields, collection fields, and (de)serialization
// all round-trip through the shared `Serializers` registry built_value's
// generated code assembles — no manual conversion expressions needed here
// (same "the generated machinery handles it" reasoning dart-freezed.ts's
// header comment gives for its own nested fields).
//
// built_value collections (https://github.com/google/built_value.dart/blob/master/built_collection/README.md)
// use its own immutable `Built*` types rather than Dart's core mutable
// `List`/`Map` — `BuiltList<T>`/`BuiltMap<K, V>`/`BuiltSet<T>` are what a
// built_value field getter actually returns, since a plain `List<T>` getter
// would let a caller mutate what's supposed to be an immutable value.
//
// Discriminated unions: built_value's abstract-class model has no native
// sealed-union/sum-type construct the way Dart 3's `sealed class` (which
// freezed's union mode leans on) does — built_value predates Dart 3 pattern
// matching. This degrades honestly (same convention dart-freezed.ts's own
// discriminator handling would if built_value had no answer) to a plain
// union-of-abstract-classes rendering with a comment naming the
// per-variant-class-plus-manual-dispatch pattern as the idiomatic
// built_value workaround.

interface Ctx {
  declarations: string[]
  declaredNames: Set<string>
  usesBuiltValue: boolean
  usesBuiltCollection: boolean
}

type Converter = (shape: TypeShape, ctx: Ctx, hint: string) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Dart string literals (https://dart.dev/language/built-in-types#strings) use
// single quotes by convention (Effective Dart: prefer_single_quotes); `$`
// additionally needs escaping since it's Dart's own string-interpolation
// marker and this quotes arbitrary content (enum member text) that may
// contain it.
function quote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$")
  return `'${escaped}'`
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// Dart style (https://dart.dev/effective-dart/style#identifiers): fields and
// variables are lowerCamelCase. Converts snake_case/kebab-case/SCREAMING_SNAKE
// source field/enum-member names; leaves an already-camel/Pascal name alone
// apart from lowercasing its leading character. Identical to
// dart-freezed.ts's `toLowerCamel`.
function toLowerCamel(name: string): string {
  if (/[_\-\s]/.test(name)) {
    const parts = name.split(/[_\-\s]+/).filter((p) => p.length > 0)
    return parts
      .map((part, i) => {
        const lower = part.toLowerCase()
        return i === 0 ? lower : capitalize(lower)
      })
      .join("")
  }
  if (name.length > 0 && name === name.toUpperCase() && name !== name.toLowerCase()) {
    return name.toLowerCase()
  }
  return name.length === 0 ? name : name[0]!.toLowerCase() + name.slice(1)
}

// The generated `_$foo.g.dart` `part` filename built_value's build_runner
// step reads/writes is the snake_case spelling of the source file's own
// basename — identical convention to dart-freezed.ts's `toSnakeCase`.
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
}

function isNullable(ref: TypeRef): boolean {
  return ref.meta.optional === true || ref.meta.nullable === true
}

function docComment(meta: Readonly<Record<string, unknown>>, indent = ""): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  if (description === undefined) return ""
  return `${indent}/// ${description}\n`
}

// `@Deprecated('reason')` (https://api.dart.dev/stable/dart-core/Deprecated-class.html) —
// Dart's native deprecation annotation, identical to dart-freezed.ts's
// `deprecatedAnnotation`.
function deprecatedAnnotation(meta: Readonly<Record<string, unknown>>, indent = ""): string {
  const deprecated = meta.deprecated
  if (deprecated === true) return `${indent}@Deprecated('deprecated')\n`
  if (typeof deprecated === "string") return `${indent}@Deprecated(${quote(deprecated)})\n`
  return ""
}

// Scalar type name — identical to dart-freezed.ts's table (freezed and
// built_value differ only in how object/union/enum *declarations* and their
// builder/serialization plumbing are emitted, not how a field's static
// scalar type is spelled). Collection kinds are handled separately below
// (built_value's own `Built*` collection types), not through this table.
const scalarHandlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("double"),
  integer: leaf("int"),
  int32: leaf("int"),
  int64: leaf("int"),
  float32: leaf("double"),
  float64: leaf("double"),
  string: leaf("String"),
  uuid: leaf("String"),
  uri: leaf("String"),
  email: leaf("String"),
  datetime: leaf("DateTime"),
  date: leaf("DateTime"),
  time: leaf("String"),
  duration: leaf("Duration"),
  bytes: leaf("Uint8List"),
  null: leaf("Null"),
  void: leaf("void"),
  unknown: leaf("dynamic"),
  never: leaf("Never"),
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "array" }
    ctx.usesBuiltCollection = true
    return `BuiltList<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  stream: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Stream<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  page: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "page" }
    ctx.usesBuiltCollection = true
    return `BuiltList<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  tuple: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `(${s.elements.map((element, i) => dartType(element, ctx, `${hint}${i}`)).join(", ")})`
  },
  map: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "map" }
    ctx.usesBuiltCollection = true
    return `BuiltMap<${dartType(s.key, ctx, `${hint}Key`)}, ${dartType(s.value, ctx, `${hint}Value`)}>`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return "String"
    if (typeof s.value === "boolean") return "bool"
    if (s.value === null) return "Null"
    return Number.isInteger(s.value) ? "int" : "double"
  },
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  intersection: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "dynamic" : dartType(first, ctx, hint)
  },
  function: leaf("Function"),
  interface: leaf("dynamic"),
}

function dartTypeName(ref: TypeRef, ctx: Ctx, hint: string): string {
  const kind = ref.shape.kind
  if (kind === "object") return emitClass(hint, ref, ctx)
  if (kind === "enum") return emitEnum(hint, ref, ctx)
  if (kind === "union") return emitUnion(hint, ref, ctx)
  const converter = resolve(kind, scalarHandlers)
  return converter === undefined ? "dynamic" : converter(ref.shape, ctx, hint)
}

function dartType(ref: TypeRef, ctx: Ctx, hint: string): string {
  const base = dartTypeName(ref, ctx, hint)
  return isNullable(ref) ? `${base}?` : base
}

/**
 * One abstract-getter field declaration (doc comment + `Type get name;`) for
 * a single object field — built_value's own field-declaration shape
 * (https://github.com/google/built_value.dart/blob/master/built_value/README.md#value-types),
 * in place of dart-freezed.ts's constructor-parameter block.
 */
function fieldGetter(fieldName: string, fieldRef: TypeRef, ctx: Ctx, hintBase: string): string {
  const dartName = toLowerCamel(fieldName)
  const fieldHint = `${hintBase}${capitalize(dartName)}`
  const fieldType = dartType(fieldRef, ctx, fieldHint)
  return `${docComment(fieldRef.meta, "  ")}  ${fieldType} get ${dartName};\n`
}

/**
 * Emit a built_value abstract class:
 * `abstract class Foo implements Built<Foo, FooBuilder>` with one abstract
 * getter per field, the required `Foo._()` constructor, the
 * `static Serializer<Foo> get serializer` hook, and the public
 * `factory Foo([updates]) = _$Foo;` constructor a caller actually invokes.
 */
function emitClass(name: string, ref: TypeRef, ctx: Ctx): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.usesBuiltValue = true

  const shape = ref.shape as TypeShape & { kind: "object" }
  const getters = Object.entries(shape.fields)
    .map(([fieldName, fieldRef]) => fieldGetter(fieldName, fieldRef, ctx, capitalize(name)))
    .join("")

  const serializerName = `_$${toLowerCamel(name)}Serializer`

  const lines: string[] = []
  lines.push(`${docComment(ref.meta)}${deprecatedAnnotation(ref.meta)}abstract class ${name} implements Built<${name}, ${name}Builder> {`)
  if (getters.length > 0) {
    lines.push("")
    lines.push(getters.trimEnd())
  }
  lines.push("")
  lines.push(`  static Serializer<${name}> get serializer => ${serializerName};`)
  lines.push("")
  lines.push(`  ${name}._();`)
  lines.push(`  factory ${name}([void Function(${name}Builder) updates]) = _$${name};`)
  lines.push("}")

  ctx.declarations.push(lines.join("\n"))
  return name
}

// Dart enums (https://dart.dev/language/enums) with a `value` slot carrying
// the wire string, plus `fromJson`/`toJson` over that slot — identical to
// dart-freezed.ts's `emitEnum`. built_value can serialize a plain Dart enum
// directly via its `Serializers` registry (no `EnumClass`/`BuiltSet`
// ceremony needed for a simple string-backed enum), so nothing built_value-
// specific changes here.
function emitEnum(name: string, ref: TypeRef, ctx: Ctx): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)

  const shape = ref.shape as TypeShape & { kind: "enum" }
  const members = shape.members.map((member) => `  ${toLowerCamel(member)}(${quote(member)})`).join(",\n")

  const decl = `${docComment(ref.meta)}${deprecatedAnnotation(ref.meta)}enum ${name} {
${members};

  final String value;
  const ${name}(this.value);

  factory ${name}.fromJson(String json) => ${name}.values.firstWhere(
        (e) => e.value == json,
        orElse: () => throw ArgumentError('Unknown ${name} value: \$json'),
      );

  String toJson() => value;
}`
  ctx.declarations.push(decl)
  return name
}

function variantClassName(baseName: string, variant: TypeRef, index: number): string {
  if (typeof variant.meta.typeName === "string") return capitalize(variant.meta.typeName)
  return `${baseName}Variant${index}`
}

/**
 * Emit a built_value union approximation. built_value predates Dart 3's
 * `sealed class` pattern matching (the construct dart-freezed.ts's own union
 * mode leans on) and has no native sum-type/discriminated-union feature of
 * its own — the honest rendering is one independent built_value abstract
 * class per variant plus a plain Dart `Object` (or the shared discriminator
 * comment below) marking the union relationship, since there is no
 * built_value construct that actually enforces "exactly one of these" the
 * way freezed's sealed class does.
 */
function emitUnion(name: string, ref: TypeRef, ctx: Ctx): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)

  const shape = ref.shape as TypeShape & { kind: "union" }
  const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined

  const variantNames = shape.variants.map((variant, index) => {
    const className = variantClassName(name, variant, index)
    if (variant.shape.kind === "object") {
      return emitClass(className, variant, ctx)
    }
    return dartType(variant, ctx, className)
  })

  const comment =
    discriminator !== undefined
      ? ` // discriminated by ${quote(discriminator)} — built_value has no native sealed-union support;` +
        ` dispatch manually on this field across the variant classes below (or model as a single class with a nullable field per variant)`
      : " // built_value has no native union support; the variant classes below share no common supertype"

  const uniqueNames = [...new Set(variantNames)]
  const decl = `${docComment(ref.meta)}typedef ${name} = ${uniqueNames.length === 1 ? uniqueNames[0] : "Object"};${comment}`
  ctx.declarations.push(decl)
  return name
}

/**
 * Project a `TypeRef` to built_value-annotated Dart source. `name` names the
 * top-level declaration: an `abstract class implements Built<...>` for
 * `object`, a plain `enum` for `enum`, a best-effort `typedef` for `union`
 * (see `emitUnion`'s doc comment), and a `typedef` alias for everything else
 * (primitives, BuiltList/BuiltMap/tuple, refs) — the same top-level-
 * declaration shape as dart-freezed.ts's `toFreezed`. Imports for
 * `built_value`/`built_collection` and the `part 'x.g.dart'` directive are
 * only emitted when actually used.
 */
export function toBuiltValue(ref: TypeRef, name = "GeneratedType"): string {
  const ctx: Ctx = { declarations: [], declaredNames: new Set(), usesBuiltValue: false, usesBuiltCollection: false }

  const kind = ref.shape.kind
  if (kind === "object" || kind === "enum" || kind === "union") {
    dartTypeName(ref, ctx, name)
  } else {
    ctx.declarations.push(`typedef ${name} = ${dartType(ref, ctx, name)};`)
  }

  const body = ctx.declarations.join("\n\n")
  const fileBase = toSnakeCase(name)
  const imports = [
    ctx.usesBuiltValue ? "import 'package:built_value/built_value.dart';" : "",
    ctx.usesBuiltValue ? "import 'package:built_value/serializer.dart';" : "",
    ctx.usesBuiltCollection ? "import 'package:built_collection/built_collection.dart';" : "",
    body.includes("Uint8List") ? "import 'dart:typed_data';" : "",
    ctx.usesBuiltValue ? `part '${fileBase}.g.dart';` : "",
  ].filter((line) => line.length > 0)
  const header = imports.length > 0 ? `${imports.join("\n")}\n\n` : ""

  return `${header}${body}\n`
}
