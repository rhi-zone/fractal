import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// ============================================================================
// Java/Moshi projector — TypeRef -> idiomatic Java 16+ source using Square's
// Moshi (https://github.com/square/moshi) for JSON (de)serialization, instead
// of Jackson (java-jackson.ts) or Gson (java-gson.ts) — same architecture as
// both, different annotation vocabulary.
//
// Two renderers, same split java-jackson.ts/java-gson.ts (and TypeScript's
// projector) use: `moshiType` renders a TYPE EXPRESSION (usable inside a
// field, a generic argument, a method signature — "List<String>",
// "OrderStatus", "int") with no accompanying declaration; `toMoshiDeclaration`
// renders a full top-level declaration (a record/class/enum/sealed
// interface). `toMoshi` below is the single entry point the package exports:
// pass `name` to get a declaration, omit it to get a bare type expression.
//
// Moshi vs. Jackson/Gson, structurally:
//   - Field naming: `@Json(name = "wire-name")` (`com.squareup.moshi.Json`)
//     instead of `@JsonProperty` (Jackson) / `@SerializedName` (Gson) — same
//     role (map a Java identifier to a wire property name), different
//     annotation.
//   - Codegen marker: every generated data class/record is annotated
//     `@JsonClass(generateAdapter = true)` — the marker Moshi's annotation
//     processor (`moshi-kotlin-codegen`, also honored for reflective Java use
//     via `moshi-adapters`) looks for to generate/select an adapter at build
//     time rather than falling back to slower runtime reflection.
//   - Enum constants: Moshi reads `@Json(name = "value")` placed directly on
//     each enum CONSTANT — the same per-constant pattern Gson's
//     `@SerializedName` uses, and unlike Jackson's backing-`value`-field +
//     `@JsonValue`/`@JsonCreator` pattern.
//   - Records: Moshi 1.15+ (https://github.com/square/moshi/blob/master/CHANGELOG.md
//     #version-1150) deserializes Java records directly via their canonical
//     constructor — `@Json(name = ...)` on a record component is enough, no
//     extra creator annotation needed.
//   - POJOs: Moshi's reflective/codegen adapters read/write fields directly
//     (no getter/setter convention the way Jackson's POJO mode leans on) —
//     the plain-class rendering here still provides a canonical constructor +
//     getters for parity with the other two Java variants' shape, but nothing
//     about Moshi's (de)serialization depends on the getters existing.
//   - Polymorphism/unions: Moshi has no `@JsonTypeInfo` equivalent built in —
//     the documented pattern (https://github.com/square/moshi/tree/master/adapters
//     -> `PolymorphicJsonAdapterFactory`, in the `moshi-adapters` module) is
//     registered imperatively against a `Moshi.Builder` at call sites, not
//     declared via annotations on the type itself. This projector emits the
//     same sealed interface + one record per variant java-jackson.ts and
//     java-gson.ts do, plus a comment documenting the
//     `PolymorphicJsonAdapterFactory` registration the caller's
//     `Moshi.Builder` setup needs — annotations alone can't wire this up, so
//     leaving a precise comment is the honest degrade. (A Kotlin codebase
//     consuming these types reflectively, rather than through generated
//     Kotlin data classes, would additionally register
//     `com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory` as a
//     fallback — noted here rather than imported, since it has no role in
//     the Java source this projector emits.)
// ============================================================================

export interface JavaOptions {
  /** "record" (Java 16+ — https://openjdk.org/jeps/395 — an immutable data
   * carrier with auto-generated constructor/accessors/equals/hashCode/
   * toString; the default) or "pojo" (a classic class with private final
   * fields, a canonical constructor, and `getX()` accessors — for codebases
   * not yet on a Java baseline with records). */
  style?: "record" | "pojo"
  /** How an optional/nullable field's type is rendered: "nullable" (default)
   * keeps the plain boxed type and adds a `@Nullable` annotation — the
   * convention Moshi and most Java JSON libraries expect, since
   * `Optional<T>` is documented (Effective Java item 55) as intended for
   * return values, not field/parameter/record-component types. "optional"
   * wraps the type in `java.util.Optional<T>` for codebases that have chosen
   * to use it that way regardless. */
  optionalStyle?: "nullable" | "optional"
  /** `package` declaration line to emit above the type. Omitted if unset. */
  packageName?: string
}

const defaultOptions: Required<JavaOptions> = {
  style: "record",
  optionalStyle: "nullable",
  packageName: "",
}

function resolveOptions(options?: JavaOptions): Required<JavaOptions> {
  return { ...defaultOptions, ...options }
}

// JSpecify (https://jspecify.dev/) is the JSR-305 successor endorsed by
// Google/JetBrains/Spring as the common `@Nullable` all tooling is
// converging on — used here rather than `javax.annotation.Nullable` (JSR-305,
// unmaintained) or a framework-specific one (`org.springframework.lang.
// Nullable`), since this projector has no framework to anchor a choice to.
const NULLABLE_ANNOTATION = "org.jspecify.annotations.Nullable"

// A leaf scalar's Java rendering: `primitive` (when one exists — Java's 8
// primitive types have no null value, so a leaf with a primitive form only
// gets rendered as that primitive in a NON-nullable, non-generic position;
// nullable fields and generic type arguments always fall back to `boxed`,
// since Java generics cannot be parameterized by a primitive) and `boxed`
// (the reference-type equivalent, always defined). `imports` is the set of
// `java.*`/`javax.*` types the boxed/primitive spelling itself requires
// (empty for unqualified names like `String`/`int` that live in
// `java.lang`, which needs no import).
type Rendering = { readonly primitive?: string; readonly boxed: string; readonly imports: readonly string[] }

type Ctx = { readonly options: Required<JavaOptions>; readonly imports: Set<string> }

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>, ctx: Ctx) => Rendering

const leaf =
  (boxed: string, primitive?: string, imports: readonly string[] = []): Converter =>
  () =>
    primitive === undefined ? { boxed, imports } : { boxed, primitive, imports }

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// Turns an arbitrary field/property name into a valid, idiomatic Java
// identifier (camelCase, alphanumeric) — used both for record
// components/POJO fields (so a JSON property like "user-id" or "2fa_code"
// still compiles) and enum constants (see `javaEnumConstant` below, which
// additionally upper-snake-cases the result).
function toJavaIdentifier(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0)
  if (parts.length === 0) return "value"
  const [first, ...rest] = parts
  const camel = [first!.toLowerCase(), ...rest.map(capitalize)].join("")
  return /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`
}

function javaEnumConstant(member: string): string {
  const snake = member
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "")
  return snake.length === 0 || !/^[A-Za-z_]/.test(snake) ? `VALUE_${snake}` : snake
}

const handlers: Record<string, Converter> = {
  boolean: leaf("Boolean", "boolean"),
  number: leaf("Double", "double"),
  integer: leaf("Integer", "int"),
  int32: leaf("Integer", "int"),
  int64: leaf("Long", "long"),
  uint32: leaf("Integer", "int"), // Java has no unsigned int — degrades to signed.
  uint64: leaf("Long", "long"), // Java has no unsigned long — degrades to signed.
  float32: leaf("Float", "float"),
  float64: leaf("Double", "double"),
  string: leaf("String"),
  uuid: leaf("java.util.UUID"),
  uri: leaf("java.net.URI"),
  email: leaf("String"),
  datetime: leaf("java.time.Instant"),
  date: leaf("java.time.LocalDate"),
  time: leaf("java.time.LocalTime"),
  duration: leaf("java.time.Duration"),
  bytes: leaf("byte[]"), // already a reference type — no separate boxed form needed.
  null: leaf("Void"),
  void: leaf("Void"),
  unknown: leaf("Object"),
  never: leaf("Void"),
  object: (shape, meta, _ctx) => {
    const s = shape as TypeShape & { kind: "object" }
    const name = typeof meta.typeName === "string" ? meta.typeName : "Anonymous"
    // An inline (unnamed) object has no Java equivalent expressible as a type
    // reference — Java has no anonymous record/struct type. Honest degrade:
    // callers that need a real declaration for an inline object should route
    // through `toMoshiDeclaration` with an explicit name instead of nesting
    // it.
    void s
    return { boxed: name, imports: [] }
  },
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — rendered as a
  // bare reference to that class name; the caller assembling the emitted
  // source is responsible for importing `className` from `source`.
  instance: (shape) => ({ boxed: (shape as TypeShape & { kind: "instance" }).className, imports: [] }),
  array: (shape, _meta, ctx) => {
    const s = shape as TypeShape & { kind: "array" }
    const element = javaType(s.element, ctx)
    return { boxed: `List<${element}>`, imports: ["java.util.List"] }
  },
  tuple: (shape, _meta, ctx) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const elements = s.elements.map((e) => javaType(e, ctx))
    // Java has no structural tuple type. Rendered as a reference to a
    // conventional `TupleN<T1, ..., TN>` record — this projector does not
    // define that support type itself (out of scope for a single TypeRef ->
    // type-expression call), so the caller assembling the emitted module is
    // responsible for providing (or importing) `Tuple2`/`Tuple3`/... records
    // with components named `first`/`second`/... — the same "caller wires
    // the import" convention `instance`/`ref` rely on above.
    return { boxed: `Tuple${elements.length}<${elements.join(", ")}>`, imports: [] }
  },
  // No native async-sequence type in Java's standard type system — degrades
  // to `List<T>` of the element type, the same honest-degrade convention
  // every other data-only projector (Zod, protobuf, ...) applies to `stream`.
  stream: (shape, _meta, ctx) => {
    const s = shape as TypeShape & { kind: "stream" }
    const element = javaType(s.element, ctx)
    return { boxed: `List<${element}>`, imports: ["java.util.List"] }
  },
  // Same degrade as `stream` — a page is one window over a larger collection
  // (see TypeKinds.page's doc comment), and Java has no pagination-window
  // type of its own to target.
  page: (shape, _meta, ctx) => {
    const s = shape as TypeShape & { kind: "page" }
    const element = javaType(s.element, ctx)
    return { boxed: `List<${element}>`, imports: ["java.util.List"] }
  },
  map: (shape, _meta, ctx) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = javaType(s.key, ctx)
    const value = javaType(s.value, ctx)
    return { boxed: `Map<${key}, ${value}>`, imports: ["java.util.Map"] }
  },
  union: (_shape, meta) => {
    // A union's idiomatic Java rendering is a top-level sealed interface
    // (see `renderSealedInterface` below) — as a bare type EXPRESSION (this
    // path, used when a union appears nested inside a field/generic
    // position) it's rendered as a reference to that interface's name, which
    // must come from `meta.typeName` (there is no other name to reach for:
    // unlike `object`, which at least has "Anonymous" as a last resort, an
    // inline anonymous sealed interface can't be expressed as a type
    // reference at all).
    if (typeof meta.typeName === "string") return { boxed: meta.typeName, imports: [] }
    return { boxed: "Object", imports: [] }
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    // Java has no literal type — degrades to the literal value's own runtime
    // type (String/Boolean/Integer/Double), the closest available type
    // still capable of holding that one value.
    if (s.value === null) return { boxed: "Void", imports: [] }
    if (typeof s.value === "string") return { boxed: "String", imports: [] }
    if (typeof s.value === "boolean") return { boxed: "Boolean", primitive: "boolean", imports: [] }
    return Number.isInteger(s.value)
      ? { boxed: "Integer", primitive: "int", imports: [] }
      : { boxed: "Double", primitive: "double", imports: [] }
  },
  enum: (shape, meta) => {
    const name = typeof meta.typeName === "string" ? meta.typeName : "Anonymous"
    void shape
    return { boxed: name, imports: [] }
  },
  ref: (shape) => ({ boxed: (shape as TypeShape & { kind: "ref" }).target, imports: [] }),
  // Java has no intersection/mixin type — lossy: falls back to the first
  // member's type, dropping the rest (same fallback protobuf.ts uses for the
  // same reason).
  intersection: (shape, _meta, ctx) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? { boxed: "Object", imports: [] } : { boxed: javaType(first, ctx), imports: [] }
  },
  // `java.util.function` has fixed-arity functional interfaces for 0-2
  // params (Supplier/Function/BiFunction); arities above that have no
  // standard-library equivalent (Java, unlike some ecosystems, doesn't
  // define TriFunction+) and degrade to Object, the same honest-degrade
  // protobuf.ts applies to its own uncoverable cases.
  function: (shape, _meta, ctx) => {
    const s = shape as TypeShape & { kind: "function" }
    const returnType = javaType(s.returnType, ctx)
    const isVoid = s.returnType.shape.kind === "void"
    const params = s.params.map((p) => javaType(p.type, ctx))
    if (params.length === 0) {
      return isVoid
        ? { boxed: "Runnable", imports: [] }
        : { boxed: `java.util.function.Supplier<${returnType}>`, imports: [] }
    }
    if (params.length === 1) {
      return isVoid
        ? { boxed: `java.util.function.Consumer<${params[0]}>`, imports: [] }
        : { boxed: `java.util.function.Function<${params[0]}, ${returnType}>`, imports: [] }
    }
    if (params.length === 2) {
      return isVoid
        ? { boxed: `java.util.function.BiConsumer<${params[0]}, ${params[1]}>`, imports: [] }
        : { boxed: `java.util.function.BiFunction<${params[0]}, ${params[1]}, ${returnType}>`, imports: [] }
    }
    return { boxed: "Object", imports: [] }
  },
  // An interface's method surface has no Java FIELD-position equivalent
  // (unlike TypeScript, which can spell an inline callable-object type) —
  // degrades to Object, same as protobuf.ts's handling of the same kind.
  interface: () => ({ boxed: "Object", imports: [] }),
}

/** Bare type expression for `ref` — the reference (boxed) spelling, suitable
 * as a generic type argument, a `List<...>`/`Map<...>` element, or any
 * position that isn't itself a top-level field (see `moshiFieldType`, which
 * additionally applies primitive-unboxing and nullable rendering). Collects
 * required imports into `ctx.imports` as a side effect. */
export function javaType(ref: TypeRef, ctx: Ctx): string {
  const converter = resolve(ref.shape.kind, handlers)
  const rendering = converter === undefined ? { boxed: "Object", imports: [] } : converter(ref.shape, ref.meta, ctx)
  for (const imp of rendering.imports) ctx.imports.add(imp)
  return rendering.boxed
}

type FieldRendering = {
  readonly type: string
  readonly annotations: readonly string[]
}

/** A field/record-component/parameter's rendering: primitive type when the
 * field is required (Java primitives can't express null, so a required
 * field gets the tightest representation available) and not nested in a
 * generic; boxed type — optionally wrapped in `Optional<T>` or annotated
 * `@Nullable`, per `options.optionalStyle` — when the field is optional/
 * nullable. */
function moshiFieldType(ref: TypeRef, ctx: Ctx): FieldRendering {
  const converter = resolve(ref.shape.kind, handlers)
  const rendering = converter === undefined ? { boxed: "Object", imports: [] } : converter(ref.shape, ref.meta, ctx)
  for (const imp of rendering.imports) ctx.imports.add(imp)
  const optional = ref.meta.optional === true || ref.meta.nullable === true
  if (!optional) {
    return { type: rendering.primitive ?? rendering.boxed, annotations: [] }
  }
  if (ctx.options.optionalStyle === "optional") {
    ctx.imports.add("java.util.Optional")
    return { type: `Optional<${rendering.boxed}>`, annotations: [] }
  }
  ctx.imports.add(NULLABLE_ANNOTATION)
  return { type: rendering.boxed, annotations: ["@Nullable"] }
}

function docComment(meta: Readonly<Record<string, unknown>>, indent: string): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecated = meta.deprecated === true
  if (description === undefined && !deprecated) return ""
  const lines = ["/**"]
  if (description !== undefined) lines.push(`${indent} * ${description}`)
  if (deprecated) lines.push(`${indent} * @deprecated`)
  lines.push(`${indent} */`)
  return `${lines.join("\n")}\n${indent}`
}

/** Detects a discriminated union's shared discriminant field name, following
 * the same open-metadata-bag convention `zod.ts`'s `union` handler reads
 * (`meta.discriminator: string` on the union TypeRef itself) rather than
 * re-deriving it structurally — the extractor that built the TypeRef is the
 * one place that actually knows which field was matched as a discriminant.
 * Moshi has no annotation-driven way to act on this (see module doc comment)
 * — it's surfaced only in the `PolymorphicJsonAdapterFactory` registration
 * comment `renderSealedInterface` emits. */
function discriminatorOf(meta: Readonly<Record<string, unknown>>): string | undefined {
  return typeof meta.discriminator === "string" ? meta.discriminator : undefined
}

function variantName(variant: TypeRef, unionName: string, index: number): string {
  if (typeof variant.meta.typeName === "string") return variant.meta.typeName
  return `${unionName}Variant${index + 1}`
}

/** Renders one `object`-shaped variant of a discriminated/plain union as a
 * Java record implementing the union's sealed interface. */
function renderVariantRecord(name: string, interfaceName: string, ref: TypeRef, ctx: Ctx): string {
  const body = renderRecordOrClass(name, ref, ctx, [interfaceName])
  return body
}

// Moshi's codegen marker (`moshi-kotlin-codegen`, also honored by
// `moshi-adapters`' reflective/codegen split for Java use) — placed on every
// generated data class/record so Moshi's `Moshi.Builder` can select a
// generated adapter for the type instead of falling back to runtime
// reflection.
const JSON_CLASS_ANNOTATION = "@JsonClass(generateAdapter = true)"

function renderRecordOrClass(name: string, ref: TypeRef, ctx: Ctx, implementsList: readonly string[] = []): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const fields = Object.entries(shape.fields)
  const implementsClause = implementsList.length === 0 ? "" : ` implements ${implementsList.join(", ")}`
  const doc = docComment(ref.meta, "")

  if (ctx.options.style === "record") {
    // Moshi 1.15+ deserializes records via their canonical constructor
    // directly (https://github.com/square/moshi/blob/master/CHANGELOG.md
    // #version-1150) — `@Json(name = ...)` on a component is read the same
    // way it is on a classic field, no extra creator annotation needed.
    const components = fields.map(([fieldName, fieldRef]) => {
      const { type, annotations } = moshiFieldType(fieldRef, ctx)
      const javaName = toJavaIdentifier(fieldName)
      const jsonAnnotation = javaName !== fieldName ? [`@Json(name = ${quote(fieldName)}) `] : []
      const annotationPrefix = [...annotations.map((a) => `${a} `), ...jsonAnnotation].join("")
      return `${annotationPrefix}${type} ${javaName}`
    })
    return `${doc}${JSON_CLASS_ANNOTATION}\npublic record ${name}(${components.join(", ")})${implementsClause} {}`
  }

  // Classic POJO: private final fields (annotated `@Json(name = ...)` where
  // the Java identifier diverges from the wire name — Moshi reads fields
  // directly, no constructor annotation needed the way Jackson's
  // `@JsonCreator` requires) + a canonical constructor + `getX()` accessors
  // (the accessors are for parity with the Jackson/Gson variants' shape;
  // Moshi itself never calls them).
  const lines: string[] = []
  lines.push(`${doc}${JSON_CLASS_ANNOTATION}`)
  lines.push(`public final class ${name}${implementsClause} {`)
  const rendered = fields.map(([fieldName, fieldRef]) => {
    const { type, annotations } = moshiFieldType(fieldRef, ctx)
    const javaName = toJavaIdentifier(fieldName)
    return { fieldName, javaName, type, annotations }
  })
  for (const f of rendered) {
    if (f.javaName !== f.fieldName) lines.push(`  @Json(name = ${quote(f.fieldName)})`)
    for (const a of f.annotations) lines.push(`  ${a}`)
    lines.push(`  private final ${f.type} ${f.javaName};`)
  }
  lines.push("")
  const ctorParams = rendered
    .map((f) => {
      const nullableAnnotation = f.annotations.includes("@Nullable") ? "@Nullable " : ""
      return `${nullableAnnotation}${f.type} ${f.javaName}`
    })
    .join(", ")
  lines.push(`  public ${name}(${ctorParams}) {`)
  for (const f of rendered) lines.push(`    this.${f.javaName} = ${f.javaName};`)
  lines.push("  }")
  for (const f of rendered) {
    lines.push("")
    lines.push(`  public ${f.type} get${capitalize(f.javaName)}() {`)
    lines.push(`    return this.${f.javaName};`)
    lines.push("  }")
  }
  lines.push("}")
  return lines.join("\n")
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/** Renders a union as a Java 17+ sealed interface (https://openjdk.org/jeps/409)
 * whose `permits` clause lists one record per variant — the idiomatic
 * closed-hierarchy encoding of a sum type in modern Java (pattern-matching
 * `switch` over the sealed interface then covers all cases exhaustively).
 * Moshi has no annotation-driven polymorphism support (unlike Jackson's
 * `@JsonTypeInfo`/`@JsonSubTypes`) — the documented approach is
 * `PolymorphicJsonAdapterFactory` (`moshi-adapters`), registered
 * imperatively against a `Moshi.Builder` at the point a `Moshi` instance is
 * built, which no annotation on the type itself can express. This projector
 * emits a comment spelling out that registration (naming the discriminant
 * field, when `meta.discriminator` is present, and every variant + its wire
 * label) so a reader knows exactly what wiring the generated types still
 * need. */
function renderSealedInterface(name: string, ref: TypeRef, ctx: Ctx): string {
  const shape = ref.shape as TypeShape & { kind: "union" }
  const discriminator = discriminatorOf(ref.meta)
  const names = shape.variants.map((v, i) => variantName(v, name, i))

  const lines: string[] = []
  const doc = docComment(ref.meta, "")
  if (doc) lines.push(doc.trimEnd())
  lines.push("// Moshi has no annotation-based polymorphism support. Register a")
  lines.push("// PolymorphicJsonAdapterFactory (com.squareup.moshi:moshi-adapters) against")
  lines.push("// your Moshi.Builder to (de)serialize this hierarchy, e.g.:")
  lines.push("//")
  if (discriminator !== undefined) {
    lines.push(`//   PolymorphicJsonAdapterFactory<${name}> typeFactory = PolymorphicJsonAdapterFactory`)
    lines.push(`//       .of(${name}.class, ${quote(discriminator)})`)
  } else {
    lines.push(`//   PolymorphicJsonAdapterFactory<${name}> typeFactory = PolymorphicJsonAdapterFactory`)
    lines.push(`//       .of(${name}.class, /* discriminant field */ ${quote("type")})`)
  }
  for (const n of names) {
    lines.push(`//       .withSubtype(${n}.class, ${quote(n)})`)
  }
  lines.push("//   Moshi moshi = new Moshi.Builder().add(typeFactory).build();")
  lines.push(`public sealed interface ${name} permits ${names.join(", ")} {}`)

  const variantDecls = shape.variants.map((variant, i) => {
    const variantRef = variant
    if (variantRef.shape.kind !== "object") {
      // A non-object union variant (e.g. a bare string/number literal) has
      // no fields to carry as record components — wrapped in a single-field
      // "value" record, the same honest degrade a discriminated union with
      // a scalar variant needs to stay a valid `implements` target.
      const inner = moshiFieldType(variantRef, ctx)
      const annotationPrefix = inner.annotations.length > 0 ? `${inner.annotations.join(" ")} ` : ""
      return `${docComment(variantRef.meta, "")}${JSON_CLASS_ANNOTATION}\npublic record ${names[i]}(${annotationPrefix}${inner.type} value) implements ${name} {}`
    }
    return renderVariantRecord(names[i]!, name, variantRef, ctx)
  })

  return [lines.join("\n"), ...variantDecls].join("\n\n")
}

function renderEnum(name: string, ref: TypeRef, ctx: Ctx): string {
  const shape = ref.shape as TypeShape & { kind: "enum" }
  const doc = docComment(ref.meta, "")
  const constants = shape.members.map((member) => ({ member, constant: javaEnumConstant(member) }))
  const needsJsonName = constants.some(({ member, constant }) => member !== constant)
  // Moshi serializes/deserializes an enum by its constant NAME by default —
  // unlike Jackson (which needs a backing `value` field + `@JsonValue`/
  // `@JsonCreator` to diverge from the constant name), Moshi's convention is
  // to place `@Json(name = "wire-value")` directly on each constant whose
  // wire form differs from the sanitized Java constant name (the same
  // per-constant pattern Gson's `@SerializedName` uses). When every member
  // already round-trips cleanly, no annotations are needed at all.
  void ctx
  if (needsJsonName) {
    const lines: string[] = []
    lines.push(`${doc}public enum ${name} {`)
    const rendered = constants.map(
      ({ member, constant }, i) =>
        `  @Json(name = ${quote(member)})\n  ${constant}${i === constants.length - 1 ? ";" : ","}`,
    )
    lines.push(rendered.join("\n"))
    lines.push("}")
    return lines.join("\n")
  }
  return `${doc}public enum ${name} {\n  ${constants.map((c) => c.constant).join(", ")}\n}`
}

const MOSHI_IMPORTS = ["com.squareup.moshi.Json", "com.squareup.moshi.JsonClass"]

function assembleSource(body: string, ctx: Ctx, options: Required<JavaOptions>): string {
  const lines: string[] = []
  if (options.packageName !== "") lines.push(`package ${options.packageName};`, "")
  const imports = [...ctx.imports].sort()
  if (imports.length > 0) {
    lines.push(...imports.map((i) => `import ${i};`), "")
  }
  lines.push(body)
  return `${lines.join("\n").trimEnd()}\n`
}

/**
 * Top-level declaration for a named type — a record/class for `object`, a
 * `public enum` for `enum`, a sealed interface + one record per variant for
 * `union`, or (for any other kind) a single `public final class` wrapping a
 * `value` field of that type, since Java has no top-level type-alias
 * construct the way TypeScript's `type X = ...` does.
 */
export function toMoshiDeclaration(name: string, ref: TypeRef, options?: JavaOptions): string {
  const resolved = resolveOptions(options)
  const ctx: Ctx = { options: resolved, imports: new Set(MOSHI_IMPORTS) }

  let body: string
  if (ref.shape.kind === "object") {
    body = renderRecordOrClass(name, ref, ctx)
  } else if (ref.shape.kind === "enum") {
    body = renderEnum(name, ref, ctx)
  } else if (ref.shape.kind === "union") {
    body = renderSealedInterface(name, ref, ctx)
  } else if (ref.shape.kind === "tuple") {
    const shape = ref.shape as TypeShape & { kind: "tuple" }
    const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"]
    const components = shape.elements.map((element, i) => {
      const { type } = moshiFieldType(element, ctx)
      return `${type} ${ordinals[i] ?? `field${i + 1}`}`
    })
    body = `${docComment(ref.meta, "")}${JSON_CLASS_ANNOTATION}\npublic record ${name}(${components.join(", ")}) {}`
  } else {
    // A wrapper class is the closest Java equivalent to a bare type alias
    // over a scalar/collection type (Java has no `type X = ...` construct).
    const { type, annotations } = moshiFieldType(ref, ctx)
    const annotationLine = annotations.length > 0 ? `${annotations.join(" ")} ` : ""
    const doc = docComment(ref.meta, "")
    body =
      resolved.style === "record"
        ? `${doc}${JSON_CLASS_ANNOTATION}\npublic record ${name}(${annotationLine}${type} value) {}`
        : [
            `${doc}${JSON_CLASS_ANNOTATION}`,
            `public final class ${name} {`,
            `  ${annotationLine}private final ${type} value;`,
            "",
            `  public ${name}(${annotationLine}${type} value) {`,
            "    this.value = value;",
            "  }",
            "",
            `  public ${type} getValue() {`,
            "    return this.value;",
            "  }",
            "}",
          ].join("\n")
  }

  return assembleSource(body, ctx, resolved)
}

/**
 * Entry point: pass `name` for a full top-level declaration
 * (record/class/enum/sealed interface, imports included); omit it for a bare
 * type expression usable inline (`"List<String>"`, `"OrderStatus"`, `"int"`)
 * — the same declaration/expression split `toTypeDeclaration`/`toTypeScript`
 * use in `typescript.ts`, and `toJavaDeclaration`/`toJava` (java-jackson.ts) /
 * `toGsonDeclaration`/`toGson` (java-gson.ts) use in their variants.
 */
export function toMoshi(ref: TypeRef, name?: string, options?: JavaOptions): string {
  if (name !== undefined) return toMoshiDeclaration(name, ref, options)
  const resolved = resolveOptions(options)
  const ctx: Ctx = { options: resolved, imports: new Set() }
  const { type } = moshiFieldType(ref, ctx)
  return type
}
