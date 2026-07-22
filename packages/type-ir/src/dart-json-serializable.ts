import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// Dart language tour: https://dart.dev/language — this projector emits
// idiomatic null-safe Dart 3 source: data classes with hand-written
// `fromJson`/`toJson` (the json_serializable convention —
// https://pub.dev/packages/json_serializable — reproduced without the
// build_runner codegen step, since this projector has no code-gen pass of its
// own to hook into), `enum` declarations with a JSON `value` slot, and Dart 3
// `sealed class` hierarchies (https://dart.dev/language/class-modifiers#sealed)
// for unions. Unlike capnp.ts/protobuf.ts, nested structures can't be
// lexically nested (Dart has no nested-class construct) — every named type
// this projector produces (the top-level type plus every object/enum/union
// reachable under it) is emitted as its own top-level sibling declaration,
// tracked in `Ctx.declarations`.

interface Ctx {
  declarations: string[]
  declaredNames: Set<string>
  usesJsonKey: boolean
}

type Converter = (shape: TypeShape, ctx: Ctx, hint: string) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Dart string literals (https://dart.dev/language/built-in-types#strings) use
// single quotes by convention (Effective Dart: prefer_single_quotes); `$`
// additionally needs escaping since it's Dart's own string-interpolation
// marker (`'$foo'`/`'${expr}'`) and this quotes arbitrary content (JSON field
// names, enum member text, literal values) that may contain it.
function quote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$")
  return `'${escaped}'`
}

// A discriminant literal used as a Dart `switch`/`case` label: strings get
// `quote`d, everything else (number/boolean/null) renders as its Dart literal
// spelling directly.
function quoteLiteral(value: string | number | boolean | null): string {
  if (typeof value === "string") return quote(value)
  return String(value)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// Dart style (https://dart.dev/effective-dart/style#identifiers): fields and
// variables are lowerCamelCase. Converts snake_case/kebab-case/SCREAMING_SNAKE
// source field/enum-member names; leaves an already-camel/Pascal name alone
// apart from lowercasing its leading character.
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
  // No separator to split on: a name with no lowercase letters at all (e.g. a
  // SCREAMING_SNAKE enum member with no underscores, "ACTIVE") is a single
  // shouty word, not multi-word camelCase — lowercase it outright rather than
  // just its leading character (which would otherwise leave "aCTIVE").
  if (name.length > 0 && name === name.toUpperCase() && name !== name.toLowerCase()) {
    return name.toLowerCase()
  }
  return name.length === 0 ? name : name[0]!.toLowerCase() + name.slice(1)
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
// Dart's native deprecation annotation, analyzer-recognized (unlike a doc
// comment's own free text). Dart's `Deprecated` constructor requires a
// message argument, so a bare `meta.deprecated === true` (no reason given)
// falls back to a generic one.
function deprecatedAnnotation(meta: Readonly<Record<string, unknown>>, indent = ""): string {
  const deprecated = meta.deprecated
  if (deprecated === true) return `${indent}@Deprecated('deprecated')\n`
  if (typeof deprecated === "string") return `${indent}@Deprecated(${quote(deprecated)})\n`
  return ""
}

// A type "needs custom (de)serialization" when its own or an element/value's
// kind is one this projector generates a `fromJson`/`toJson` pair for
// (object/enum/union) — everything else round-trips through `Map<String,
// dynamic>` as-is (bool/String/num/List<num>/etc. are already JSON-native).
function needsCustom(ref: TypeRef): boolean {
  const kind = ref.shape.kind
  if (kind === "object" || kind === "enum" || kind === "union") return true
  if (kind === "array" || kind === "stream" || kind === "page") {
    return needsCustom((ref.shape as TypeShape & { element: TypeRef }).element)
  }
  if (kind === "map") return needsCustom((ref.shape as TypeShape & { value: TypeRef }).value)
  return false
}

// Scalar/collection type name — https://dart.dev/language/built-in-types.
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
  // A class instance carries only nominal identity (see type-ir's
  // TypeKinds.instance doc comment) — rendered as a bare reference to that
  // class name; the caller assembling the emitted source is responsible for
  // importing it, same convention typescript.ts's `instance` handler uses.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "array" }
    return `List<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  // Dart's native async-sequence construct (https://dart.dev/language/streams)
  // is the direct analogue of TypeKinds.stream.
  stream: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Stream<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  // No native paginated-collection type — degrades to its element's List
  // form, same honest-degrade convention capnp.ts/protobuf.ts use.
  page: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "page" }
    return `List<${dartType(s.element, ctx, `${hint}Item`)}>`
  },
  // Dart 3 records (https://dart.dev/language/records) are positional-field
  // tuples — the direct analogue of TypeKinds.tuple.
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
  // No intersection/mixin-of-two-arbitrary-types construct as a value type —
  // lossy: falls back to the first member's type, dropping the rest, same as
  // capnp.ts/protobuf.ts.
  intersection: (shape, ctx, hint) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "dynamic" : dartType(first, ctx, hint)
  },
  // No first-class function-type syntax carrying a signature in a field
  // position beyond the generic `Function` supertype.
  function: leaf("Function"),
  // Dart has no service/interface-surface construct to target from a bare
  // field type — degrades to `dynamic`, same as capnp.ts/protobuf.ts's
  // `interface` handler.
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

// `fromJson` deserialization expression for one value read out of a
// `Map<String, dynamic>` (or one of its List/Map elements) at `jsonExpr`.
function fromJsonExpr(ref: TypeRef, jsonExpr: string, ctx: Ctx, hint: string): string {
  const nullable = isNullable(ref)
  const kind = ref.shape.kind

  const build = (expr: string): string => {
    if (kind === "object" || kind === "union") {
      return `${dartTypeName(ref, ctx, hint)}.fromJson(${expr} as Map<String, dynamic>)`
    }
    if (kind === "enum") {
      return `${dartTypeName(ref, ctx, hint)}.fromJson(${expr} as String)`
    }
    if (kind === "array" || kind === "stream" || kind === "page") {
      const s = ref.shape as TypeShape & { element: TypeRef }
      if (needsCustom(s.element)) {
        const elemExpr = fromJsonExpr(s.element, "e", ctx, `${hint}Item`)
        return `(${expr} as List).map((e) => ${elemExpr}).toList()`
      }
      return `(${expr} as List).cast<${dartTypeName(s.element, ctx, `${hint}Item`)}>()`
    }
    if (kind === "map") {
      const s = ref.shape as TypeShape & { kind: "map" }
      if (needsCustom(s.value)) {
        const valExpr = fromJsonExpr(s.value, "v", ctx, `${hint}Value`)
        return `(${expr} as Map<String, dynamic>).map((k, v) => MapEntry(k, ${valExpr}))`
      }
      return `Map<${dartTypeName(s.key, ctx, `${hint}Key`)}, ${dartTypeName(s.value, ctx, `${hint}Value`)}>.from(${expr} as Map)`
    }
    return `${expr} as ${dartTypeName(ref, ctx, hint)}`
  }

  return nullable ? `${jsonExpr} == null ? null : ${build(jsonExpr)}` : build(jsonExpr)
}

// `toJson` serialization expression for a Dart field's value at `fieldExpr`.
function toJsonExpr(ref: TypeRef, fieldExpr: string, ctx: Ctx, hint: string): string {
  const nullable = isNullable(ref)
  const kind = ref.shape.kind

  if (kind === "object" || kind === "enum" || kind === "union") {
    return nullable ? `${fieldExpr}?.toJson()` : `${fieldExpr}.toJson()`
  }
  if (kind === "array" || kind === "stream" || kind === "page") {
    const s = ref.shape as TypeShape & { element: TypeRef }
    if (needsCustom(s.element)) {
      const elemExpr = toJsonExpr(s.element, "e", ctx, `${hint}Item`)
      return nullable ? `${fieldExpr}?.map((e) => ${elemExpr}).toList()` : `${fieldExpr}.map((e) => ${elemExpr}).toList()`
    }
    return fieldExpr
  }
  if (kind === "map") {
    const s = ref.shape as TypeShape & { kind: "map" }
    if (needsCustom(s.value)) {
      const valExpr = toJsonExpr(s.value, "v", ctx, `${hint}Value`)
      return nullable
        ? `${fieldExpr}?.map((k, v) => MapEntry(k, ${valExpr}))`
        : `${fieldExpr}.map((k, v) => MapEntry(k, ${valExpr}))`
    }
    return fieldExpr
  }
  return fieldExpr
}

/**
 * Emit a data class: `final` fields, a `const`-free constructor with named
 * parameters (`required` for non-optional/non-nullable fields), and
 * json_serializable-style `fromJson`/`toJson`. When `extendsName` is given
 * (a sealed-union variant — see `emitUnion`) the constructor becomes `const`
 * and calls `super()`, and `toJson` carries `@override`.
 *
 * A field name that isn't already lowerCamelCase gets an `@JsonKey(name:
 * '...')` annotation (https://pub.dev/documentation/json_annotation/latest/)
 * pinning the original JSON key, while the Dart-side field itself uses the
 * idiomatic lowerCamelCase spelling.
 */
function emitClass(name: string, ref: TypeRef, ctx: Ctx, extendsName?: string): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)

  const shape = ref.shape as TypeShape & { kind: "object" }
  const fieldLines: string[] = []
  const ctorParams: string[] = []
  const fromJsonFields: string[] = []
  const toJsonFields: string[] = []

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const dartName = toLowerCamel(fieldName)
    const nullable = isNullable(fieldRef)
    const fieldHint = `${capitalize(name)}${capitalize(dartName)}`
    const fieldType = dartType(fieldRef, ctx, fieldHint)

    fieldLines.push(docComment(fieldRef.meta, "  "))
    if (dartName !== fieldName) {
      ctx.usesJsonKey = true
      fieldLines.push(`  @JsonKey(name: ${quote(fieldName)})\n`)
    }
    fieldLines.push(`  final ${fieldType} ${dartName};\n`)

    ctorParams.push(nullable ? `this.${dartName}` : `required this.${dartName}`)

    const jsonExpr = `json[${quote(fieldName)}]`
    fromJsonFields.push(`    ${dartName}: ${fromJsonExpr(fieldRef, jsonExpr, ctx, fieldHint)},`)

    const toExpr = toJsonExpr(fieldRef, dartName, ctx, fieldHint)
    toJsonFields.push(nullable ? `    if (${dartName} != null) ${quote(fieldName)}: ${toExpr},` : `    ${quote(fieldName)}: ${toExpr},`)
  }

  const isVariant = extendsName !== undefined
  const extendsClause = isVariant ? ` extends ${extendsName}` : ""
  const ctorArgs = ctorParams.length > 0 ? `{${ctorParams.join(", ")}}` : ""
  const ctorLine = `  ${isVariant ? "const " : ""}${name}(${ctorArgs})${isVariant ? " : super()" : ""};`

  const lines: string[] = []
  lines.push(`${docComment(ref.meta)}${deprecatedAnnotation(ref.meta)}class ${name}${extendsClause} {`)
  lines.push(...fieldLines.filter((l) => l.length > 0))
  lines.push("")
  lines.push(ctorLine)
  lines.push("")
  lines.push(`  factory ${name}.fromJson(Map<String, dynamic> json) => ${name}(`)
  lines.push(...fromJsonFields)
  lines.push("  );")
  lines.push("")
  lines.push(`  ${isVariant ? "@override\n  " : ""}Map<String, dynamic> toJson() => {`)
  lines.push(...toJsonFields)
  lines.push("  };")
  lines.push("}")

  ctx.declarations.push(lines.join("\n"))
  return name
}

// Dart enums (https://dart.dev/language/enums) with a `value` slot carrying
// the wire string, plus `fromJson`/`toJson` over that slot — the idiomatic
// pattern for a JSON-backed enum before json_serializable's `@JsonEnum` runs.
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

function variantClassName(baseName: string, variant: TypeRef, index: number, discriminator: string | undefined): string {
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
 * Emit a Dart 3 `sealed class` hierarchy
 * (https://dart.dev/language/class-modifiers#sealed) for a union: an abstract
 * base with a `fromJson` factory, and one concrete subtype per variant. A
 * variant that isn't itself an object (e.g. a bare string/number union
 * member) is wrapped in a synthetic single-field `value` class so it still
 * gets a named Dart type.
 *
 * `meta.discriminator` (the `propertyName` convention from-openapi.ts/
 * from-json-schema.ts populate for a JSON-Schema/OpenAPI `discriminator`) lets
 * `fromJson` dispatch by a single field read, matching TypeScript's
 * discriminated-union idiom. Without it, dispatch degrades to trying each
 * variant's `fromJson` in turn and keeping the first that doesn't throw —
 * lossy (ambiguous/overlapping shapes silently prefer declaration order) but
 * the only generic fallback available from a bare TypeRef union.
 */
function emitUnion(name: string, ref: TypeRef, ctx: Ctx): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)

  const shape = ref.shape as TypeShape & { kind: "union" }
  const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined

  const variantInfo = shape.variants.map((variant, index) => ({
    variant,
    variantName: variantClassName(name, variant, index, discriminator),
  }))

  for (const { variant, variantName } of variantInfo) {
    const objectRef: TypeRef =
      variant.shape.kind === "object" ? variant : { shape: { kind: "object", fields: { value: variant } }, meta: {} }
    emitClass(variantName, objectRef, ctx, name)
  }

  let fromJsonBody: string
  if (discriminator !== undefined) {
    const cases = variantInfo
      .map(({ variant, variantName }) => {
        let discValue: string | number | boolean | null = variantName
        if (variant.shape.kind === "object") {
          const discRef = (variant.shape as TypeShape & { kind: "object" }).fields[discriminator]
          if (discRef !== undefined && discRef.shape.kind === "literal") {
            discValue = (discRef.shape as TypeShape & { kind: "literal" }).value
          }
        }
        return `      case ${quoteLiteral(discValue)}: return ${variantName}.fromJson(json);`
      })
      .join("\n")
    fromJsonBody = `    switch (json[${quote(discriminator)}]) {
${cases}
      default: throw ArgumentError('Unknown ${name} variant: \${json[${quote(discriminator)}]}');
    }`
  } else {
    const attempts = variantInfo
      .map(({ variantName }) => `      try {
        return ${variantName}.fromJson(json);
      } catch (_) {}`)
      .join("\n")
    fromJsonBody = `${attempts}
    throw ArgumentError('No variant of ${name} matched the given JSON');`
  }

  const decl = `${docComment(ref.meta)}${deprecatedAnnotation(ref.meta)}sealed class ${name} {
  const ${name}();

  factory ${name}.fromJson(Map<String, dynamic> json) {
${fromJsonBody}
  }

  Map<String, dynamic> toJson();
}`
  ctx.declarations.push(decl)
  return name
}

/**
 * Project a `TypeRef` to idiomatic Dart source. `name` names the top-level
 * declaration: a class for `object`, an enum for `enum`, a sealed hierarchy
 * for `union`, and a `typedef` alias for everything else (primitives,
 * List/Map/tuple, refs). Every object/enum/union reachable underneath — field
 * types, array/map elements, union variants — is emitted alongside it as its
 * own top-level declaration (Dart has no nested-class construct to lean on,
 * unlike capnp.ts's/protobuf.ts's nested struct/message).
 */
export function toDart(ref: TypeRef, name = "GeneratedType"): string {
  const ctx: Ctx = { declarations: [], declaredNames: new Set(), usesJsonKey: false }

  const kind = ref.shape.kind
  if (kind === "object" || kind === "enum" || kind === "union") {
    dartTypeName(ref, ctx, name)
  } else {
    ctx.declarations.push(`typedef ${name} = ${dartType(ref, ctx, name)};`)
  }

  const body = ctx.declarations.join("\n\n")
  const imports = [
    ctx.usesJsonKey ? "import 'package:json_annotation/json_annotation.dart';" : "",
    body.includes("Uint8List") ? "import 'dart:typed_data';" : "",
  ].filter((line) => line.length > 0)
  const header = imports.length > 0 ? `${imports.join("\n")}\n\n` : ""

  return `${header}${body}\n`
}
