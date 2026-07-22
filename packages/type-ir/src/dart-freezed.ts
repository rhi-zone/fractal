import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// freezed (https://pub.dev/packages/freezed) is Dart's code-generation
// package for immutable data classes and Dart 3 sealed-class unions. Unlike
// dart-json-serializable.ts — which hand-reproduces json_serializable's
// generated fromJson/toJson bodies inline, since it has no build_runner pass
// of its own to hook into — freezed's mixin (`with _$Foo`) supplies
// `copyWith`, deep equality, `toString`, and (when a `fromJson` factory is
// declared) JSON (de)serialization entirely through generated code that
// cannot be reasonably hand-rolled. This projector therefore emits the
// *annotated declaration* a real project would run `build_runner` over —
// `@freezed` classes with `const factory` constructors delegating to
// `_$FooFromJson`/`_$Foo` — not a standalone, already-working module the way
// dart-json-serializable.ts's output is.
//
// Class-modifier convention (freezed 3, https://github.com/rrousselGit/freezed/blob/master/packages/freezed/migration_guide.md):
// a single-constructor data class is `abstract class Foo with _$Foo`; a
// union with one named factory per variant is `sealed class Foo with _$Foo`
// so Dart 3's exhaustive pattern matching (https://dart.dev/language/class-modifiers#sealed)
// applies across the variants.
//
// Discriminated unions use freezed's own discriminator support rather than a
// hand-written switch: `@Freezed(unionKey: 'type')` on the class picks which
// JSON field carries the discriminant (default is the injected `runtimeType`
// key), and `@FreezedUnionValue('circle')` on a constructor overrides that
// variant's discriminant value when it doesn't match the constructor name
// verbatim (https://pub.dev/documentation/freezed_annotation/latest/freezed_annotation/FreezedUnionValue-class.html).
// The discriminator field itself is therefore excluded from the variant's own
// field list — freezed injects/reads it out-of-band via `unionKey`, so
// declaring it again as a constructor parameter would conflict.
//
// Nested object/union/enum field types round-trip through json_serializable's
// ordinary "does this type have fromJson/toJson" convention with no manual
// conversion expressions needed (contrast dart-json-serializable.ts's
// fromJsonExpr/toJsonExpr) — that machinery lives entirely in the generated
// code this projector does not need to reproduce.

interface Ctx {
  declarations: string[]
  declaredNames: Set<string>
  usesJsonKey: boolean
  usesFreezed: boolean
}

type Converter = (shape: TypeShape, ctx: Ctx, hint: string) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Dart string literals (https://dart.dev/language/built-in-types#strings) use
// single quotes by convention (Effective Dart: prefer_single_quotes); `$`
// additionally needs escaping since it's Dart's own string-interpolation
// marker and this quotes arbitrary content (JSON field names, enum member
// text, literal discriminant values) that may contain it.
function quote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$")
  return `'${escaped}'`
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// Dart style (https://dart.dev/effective-dart/style#identifiers): fields and
// variables are lowerCamelCase. Converts snake_case/kebab-case/SCREAMING_SNAKE
// source field/enum-member/variant names; leaves an already-camel/Pascal name
// alone apart from lowercasing its leading character.
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

// The `part 'x.freezed.dart'`/`part 'x.g.dart'` filenames freezed's
// build_runner step writes and reads are the snake_case spelling of the
// source file's own basename — by convention (not a hard requirement) that
// basename matches the top-level declaration's name, so this projector
// derives it from `name` the same way `dart_test`-adjacent tooling would.
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
// Dart's native deprecation annotation. `Deprecated`'s constructor requires a
// message argument, so a bare `meta.deprecated === true` (no reason given)
// falls back to a generic one.
function deprecatedAnnotation(meta: Readonly<Record<string, unknown>>, indent = ""): string {
  const deprecated = meta.deprecated
  if (deprecated === true) return `${indent}@Deprecated('deprecated')\n`
  if (typeof deprecated === "string") return `${indent}@Deprecated(${quote(deprecated)})\n`
  return ""
}

// Scalar/collection type name — https://dart.dev/language/built-in-types.
// Identical to dart-json-serializable.ts's table: freezed changes only how
// object/union/enum *declarations* and their (de)serialization plumbing are
// emitted, not how a field's static type is spelled.
const handlers: Record<string, Converter> = {
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
    return `List<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  stream: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Stream<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  page: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "page" }
    return `List<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  tuple: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `(${s.elements.map((element, i) => dartType(element, ctx, `${hint}${i}`)).join(", ")})`
  },
  map: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "map" }
    return `Map<${dartType(s.key, ctx, `${hint}Key`)}, ${dartType(s.value, ctx, `${hint}Value`)}>`
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
  const converter = resolve(kind, handlers)
  return converter === undefined ? "dynamic" : converter(ref.shape, ctx, hint)
}

function dartType(ref: TypeRef, ctx: Ctx, hint: string): string {
  const base = dartTypeName(ref, ctx, hint)
  return isNullable(ref) ? `${base}?` : base
}

/**
 * One constructor-parameter block (doc comment + optional `@JsonKey` +
 * `required Type name,`/`Type? name,`) for a single object field, indented to
 * sit inside a `const factory`'s `({ ... })` parameter list.
 */
function fieldParam(fieldName: string, fieldRef: TypeRef, ctx: Ctx, hintBase: string, indent: string): string {
  const dartName = toLowerCamel(fieldName)
  const nullable = isNullable(fieldRef)
  const fieldHint = `${hintBase}${capitalize(dartName)}`
  const fieldType = dartType(fieldRef, ctx, fieldHint)

  const lines: string[] = []
  lines.push(docComment(fieldRef.meta, indent))
  if (dartName !== fieldName) {
    ctx.usesJsonKey = true
    lines.push(`${indent}@JsonKey(name: ${quote(fieldName)})\n`)
  }
  lines.push(`${indent}${nullable ? "" : "required "}${fieldType} ${dartName},\n`)
  return lines.filter((l) => l.length > 0).join("")
}

/**
 * Emit a `const factory` block for a set of fields — shared by a plain
 * object's single constructor and each named variant constructor of a union.
 * `excludeField` drops the union discriminator field (freezed's `unionKey`
 * carries it out-of-band; declaring it again as a parameter would conflict —
 * see the module doc comment).
 */
function factoryParams(shape: TypeShape & { kind: "object" }, ctx: Ctx, hintBase: string, excludeField?: string): string {
  const entries = Object.entries(shape.fields).filter(([fieldName]) => fieldName !== excludeField)
  if (entries.length === 0) return "()"
  const params = entries.map(([fieldName, fieldRef]) => fieldParam(fieldName, fieldRef, ctx, hintBase, "    ")).join("")
  return `({\n${params}  })`
}

/**
 * Emit a freezed data class: `@freezed abstract class Foo with _$Foo` with a
 * single `const factory` constructor and a `fromJson` factory delegating to
 * the generated `_$FooFromJson`. No manual field declarations or
 * (de)serialization bodies — freezed's generated mixin supplies both from the
 * constructor's parameter list.
 */
function emitClass(name: string, ref: TypeRef, ctx: Ctx): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.usesFreezed = true

  const shape = ref.shape as TypeShape & { kind: "object" }
  const params = factoryParams(shape, ctx, capitalize(name))

  const lines: string[] = []
  lines.push(`${docComment(ref.meta)}${deprecatedAnnotation(ref.meta)}@freezed`)
  lines.push(`abstract class ${name} with _$${name} {`)
  lines.push(`  const factory ${name}${params} = _${name};`)
  lines.push("")
  lines.push(`  factory ${name}.fromJson(Map<String, dynamic> json) => _$${name}FromJson(json);`)
  lines.push("}")

  ctx.declarations.push(lines.join("\n"))
  return name
}

// Dart enums (https://dart.dev/language/enums) with a `value` slot carrying
// the wire string, plus `fromJson`/`toJson` over that slot — identical to
// dart-json-serializable.ts's emitEnum. An enum is plain hand-written Dart
// (no `part`/build_runner involvement of its own), so freezed changes nothing
// about how it's emitted.
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

function variantName(baseName: string, variant: TypeRef, index: number, discriminator: string | undefined): string {
  if (typeof variant.meta.typeName === "string") return capitalize(variant.meta.typeName)
  if (discriminator !== undefined && variant.shape.kind === "object") {
    const discRef = (variant.shape as TypeShape & { kind: "object" }).fields[discriminator]
    if (discRef !== undefined && discRef.shape.kind === "literal") {
      const value = (discRef.shape as TypeShape & { kind: "literal" }).value
      if (typeof value === "string") return capitalize(toLowerCamel(value))
    }
  }
  return `${baseName}Variant${index}`
}

/**
 * Emit a freezed sealed-class union
 * (https://pub.dev/documentation/freezed_annotation/latest/freezed_annotation/Freezed-class.html):
 * one `sealed class Foo with _$Foo` carrying a named `const factory`
 * constructor per variant (`Foo.circle(...) = Circle`), rather than
 * dart-json-serializable.ts's separate `extends`-based subtype classes — this
 * is freezed's own union idiom, and it's also what lets Dart 3 pattern
 * matching (`switch`/`case Circle(...)`) work over the result.
 *
 * `meta.discriminator` (the `propertyName` convention from-openapi.ts/
 * from-json-schema.ts populate) becomes `@Freezed(unionKey: '<discriminator>')`
 * on the class; a variant whose discriminant literal doesn't match its
 * constructor name verbatim gets `@FreezedUnionValue('<value>')`. Without a
 * discriminator, the class stays a bare `@freezed` and dispatch falls back to
 * freezed's default `runtimeType`-keyed JSON encoding.
 */
function emitUnion(name: string, ref: TypeRef, ctx: Ctx): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.usesFreezed = true

  const shape = ref.shape as TypeShape & { kind: "union" }
  const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined

  const variantLines = shape.variants.map((variant, index) => {
    const className = variantName(name, variant, index, discriminator)
    const ctorName = toLowerCamel(className)
    const objectShape: TypeShape & { kind: "object" } =
      variant.shape.kind === "object" ? (variant.shape as TypeShape & { kind: "object" }) : { kind: "object", fields: { value: variant } }

    let discValue: string | number | boolean | null | undefined
    if (discriminator !== undefined && variant.shape.kind === "object") {
      const discRef = objectShape.fields[discriminator]
      if (discRef !== undefined && discRef.shape.kind === "literal") {
        discValue = (discRef.shape as TypeShape & { kind: "literal" }).value
      }
    }

    const excludeField = discriminator !== undefined && variant.shape.kind === "object" ? discriminator : undefined
    const params = factoryParams(objectShape, ctx, `${capitalize(name)}${className}`, excludeField)

    const overrideAnnotation =
      discValue !== undefined && discValue !== ctorName ? `  @FreezedUnionValue(${quote(String(discValue))})\n` : ""

    return `${overrideAnnotation}  const factory ${name}.${ctorName}${params} = ${className};`
  })

  const classAnnotation = discriminator !== undefined ? `@Freezed(unionKey: ${quote(discriminator)})` : "@freezed"

  const lines: string[] = []
  lines.push(`${docComment(ref.meta)}${deprecatedAnnotation(ref.meta)}${classAnnotation}`)
  lines.push(`sealed class ${name} with _$${name} {`)
  lines.push(...variantLines)
  lines.push("")
  lines.push(`  factory ${name}.fromJson(Map<String, dynamic> json) => _$${name}FromJson(json);`)
  lines.push("}")

  ctx.declarations.push(lines.join("\n"))
  return name
}

/**
 * Project a `TypeRef` to freezed-annotated Dart source. `name` names the
 * top-level declaration: an `abstract class` for `object`, a `sealed class`
 * for `union`, a plain `enum` for `enum`, and a `typedef` alias for everything
 * else (primitives, List/Map/tuple, refs) — the same top-level-declaration
 * shape as dart-json-serializable.ts's `toDart`, since Dart still has no
 * nested-class construct to lean on. `import 'package:freezed_annotation/…'`
 * and the `part 'x.freezed.dart'`/`part 'x.g.dart'` directives are only
 * emitted when at least one `@freezed` class/union was generated — a
 * bare-enum or bare-primitive `TypeRef` needs neither.
 */
export function toFreezed(ref: TypeRef, name = "GeneratedType"): string {
  const ctx: Ctx = { declarations: [], declaredNames: new Set(), usesJsonKey: false, usesFreezed: false }

  const kind = ref.shape.kind
  if (kind === "object" || kind === "enum" || kind === "union") {
    dartTypeName(ref, ctx, name)
  } else {
    ctx.declarations.push(`typedef ${name} = ${dartType(ref, ctx, name)};`)
  }

  const body = ctx.declarations.join("\n\n")
  const fileBase = toSnakeCase(name)
  const imports = [
    ctx.usesFreezed ? "import 'package:freezed_annotation/freezed_annotation.dart';" : "",
    ctx.usesJsonKey && !ctx.usesFreezed ? "import 'package:json_annotation/json_annotation.dart';" : "",
    body.includes("Uint8List") ? "import 'dart:typed_data';" : "",
    ctx.usesFreezed ? `part '${fileBase}.freezed.dart';` : "",
    ctx.usesFreezed ? `part '${fileBase}.g.dart';` : "",
  ].filter((line) => line.length > 0)
  const header = imports.length > 0 ? `${imports.join("\n")}\n\n` : ""

  return `${header}${body}\n`
}
