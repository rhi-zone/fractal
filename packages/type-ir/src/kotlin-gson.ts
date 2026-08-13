// Kotlin data class / sealed class projector for Google's Gson
// (https://github.com/google/gson) — a sibling of kotlin-kotlinx.ts (same
// TypeRef -> Kotlin-source architecture) using Gson's annotation vocabulary
// (`com.google.gson.annotations.SerializedName`/`.Expose`) instead of
// kotlinx.serialization's `@Serializable`/`@SerialName`.
//
// Gson vs. kotlinx.serialization, structurally (see java-gson.ts for the
// same comparison against Jackson, one target language over):
//   - Field naming: `@SerializedName("wire-name")` (Gson) instead of
//     `@SerialName("wire-name")` (kotlinx) — same role, and (unlike kotlinx)
//     Gson reads Kotlin properties reflectively with no `@Serializable`
//     marker required on the class itself, so this projector omits one.
//   - Field inclusion: Gson serializes every non-transient property by
//     default; a project that calls `excludeFieldsWithoutExposeAnnotation()`
//     on its `GsonBuilder` needs `@Expose` on each property it still wants
//     included (https://github.com/google/gson/blob/main/UserGuide.md
//     #exposing-only-select-fields-of-a-class-for-json-serialization) — this
//     projector emits `@Expose` by default (`options.expose`) since it can't
//     know the caller's `GsonBuilder` configuration, and it's a strict
//     no-op when that builder option isn't used.
//   - Enum constants: Gson reads `@SerializedName` placed directly on the
//     enum constant's own backing field (its `FieldNamingStrategy` walks the
//     constant, not a separate metadata table) — same annotation, same
//     placement as a data class property, no backing-value indirection
//     needed the way Jackson's `@JsonValue`/`@JsonCreator` requires.
//   - Polymorphism/unions: Gson has no annotation-driven discriminated-union
//     support (see java-gson.ts's `renderSealedInterface`) — the documented
//     pattern is `RuntimeTypeAdapterFactory` (`gson-extras`), registered
//     imperatively against a `GsonBuilder`. This projector emits the same
//     `sealed class` + one `data class` per variant kotlin-kotlinx.ts does,
//     plus a comment documenting the `RuntimeTypeAdapterFactory`
//     registration the caller's `GsonBuilder` setup needs, since no
//     annotation on the type itself can express it.
import { resolve, type TypeRef, type TypeShape } from "./index.ts";
import { capitalize, isA, kotlinDocComment, quote, resolveOptions } from "./codegen-helpers.ts";

export interface KotlinGsonOptions {
  /** Also emit `@Expose` alongside `@SerializedName` on each field/enum
   * constant — required for a property to survive serialization once the
   * caller's `Gson` instance is built with
   * `excludeFieldsWithoutExposeAnnotation()`; a harmless no-op otherwise.
   * Default `true`. */
  expose?: boolean;
}

const defaultOptions: Required<KotlinGsonOptions> = { expose: true };

// Kotlin enum entries conventionally read SCREAMING_SNAKE_CASE
// (https://kotlinlang.org/docs/coding-conventions.html#property-names) —
// `@SerializedName` on each entry (see toEnumClass below) preserves the
// original wire value regardless of how the identifier itself is reshaped.
function toEnumEntryName(member: string): string {
  const snake = member
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
  const cleaned = snake.replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) return "UNKNOWN";
  // A Kotlin identifier can't start with a digit.
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string;

const leaf =
  (type: string): Converter =>
  () =>
    type;

// Kotlin built-in types: https://kotlinlang.org/docs/basic-types.html. Named
// (object/enum/union) kinds have no anonymous Kotlin equivalent — a data
// class, enum class, and sealed class all require a declaration site. In
// bare type-expression position (a field referencing a shape that isn't
// being separately declared here), these read `meta.typeName` when the
// caller supplied it, and otherwise fall back to a structural type:
// `object` -> `Map<String, Any?>`, `union`/`enum` -> `Any`. Both fallbacks
// are lossy; `Any` for an enum drops the closed-set constraint rather than
// misrepresenting it as `String`.
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
  // Gson has no built-in temporal type support out of the box (users
  // typically register their own TypeAdapter for java.time types) — degrades
  // to the same kotlinx-datetime-flavored types kotlin-kotlinx.ts uses, the
  // closest idiomatic Kotlin spelling regardless of which serializer wires
  // the actual (de)serialization.
  datetime: leaf("kotlinx.datetime.Instant"),
  date: leaf("kotlinx.datetime.LocalDate"),
  time: leaf("String"),
  duration: leaf("kotlin.time.Duration"),
  bytes: leaf("ByteArray"),
  null: leaf("Nothing?"),
  void: leaf("Unit"),
  unknown: leaf("Any"),
  never: leaf("Nothing"),
  object: (_shape, meta) =>
    typeof meta.typeName === "string" ? meta.typeName : "Map<String, Any?>",
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — the caller
  // (whatever assembles this emitted source into a Kotlin file) is
  // responsible for having `className` in scope/imported from `source`.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => `List<${toKotlinType((shape as TypeShape & { kind: "array" }).element)}>`,
  // Kotlin has no native async-sequence value type analogous to
  // AsyncIterable<T> in field/property position — degrades to `List<T>`,
  // same convention every other data-only projector's `stream` fallback
  // uses.
  stream: (shape) => `List<${toKotlinType((shape as TypeShape & { kind: "stream" }).element)}>`,
  // No native pagination construct — degrades to `List<T>` of the page's
  // element type, same fallback convention `stream` uses above.
  page: (shape) => `List<${toKotlinType((shape as TypeShape & { kind: "page" }).element)}>`,
  // https://kotlinlang.org/api/core/kotlin-stdlib/kotlin/-pair/ and -triple/ —
  // Kotlin's stdlib only ships 2- and 3-element product types; 4+ elements
  // have no stdlib equivalent and degrade to `List<Any?>` (lossy — drops
  // per-position typing, same tradeoff kotlin-kotlinx.ts's peers take
  // elsewhere).
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" };
    if (s.elements.length === 2) {
      return `Pair<${toKotlinType(s.elements[0]!)}, ${toKotlinType(s.elements[1]!)}>`;
    }
    if (s.elements.length === 3) {
      return `Triple<${toKotlinType(s.elements[0]!)}, ${toKotlinType(s.elements[1]!)}, ${toKotlinType(s.elements[2]!)}>`;
    }
    return "List<Any?>";
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" };
    return `Map<${toKotlinType(s.key)}, ${toKotlinType(s.value)}>`;
  },
  union: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "Any"),
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" };
    if (s.value === null) return "Nothing?";
    if (typeof s.value === "string") return "String";
    if (typeof s.value === "boolean") return "Boolean";
    return Number.isInteger(s.value) ? "Int" : "Double";
  },
  enum: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "Any"),
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No intersection/mixin construct outside experimental context receivers —
  // lossy: falls back to the first member's type, dropping the rest (same
  // convention kotlin-kotlinx.ts uses for its own missing intersection).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" };
    const [first] = s.members;
    return first === undefined ? "Any" : toKotlinType(first);
  },
  // https://kotlinlang.org/docs/lambdas.html#function-types — `(A, B) -> R`.
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" };
    const params = s.params.map((p) => toKotlinType(p.type)).join(", ");
    const receiver = s.thisType === undefined ? "" : `${toKotlinType(s.thisType)}.`;
    return `${receiver}(${params}) -> ${toKotlinType(s.returnType)}`;
  },
  // `method` has no explicit entry — `registerParent("method", "function")`
  // falls back to the `function` handler above for the bare-type-expression
  // case (a method embedded in ordinary field position).
  //
  // A service surface has no Kotlin field-position construct of its own —
  // degrades to `Any`, same as `object`'s fallback above.
  interface: leaf("Any"),
};

/** Inline type expression — used for field types, list/map element types,
 * etc. Named (object/enum/union) kinds without `meta.typeName` fall back to
 * a structural type rather than a declaration site; see the `handlers` doc
 * comment above for the exact per-kind fallback. */
export function toKotlinType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers);
  const type = converter === undefined ? "Any" : converter(ref.shape, ref.meta);
  const nullable = ref.meta.nullable === true || ref.meta.optional === true;
  return nullable && !type.endsWith("?") ? `${type}?` : type;
}

type FieldResult = { type: string; nested: string[] };

/**
 * A field's Kotlin type plus any nested declarations it needed to synthesize.
 * Nested object/enum/union fields have no anonymous Kotlin form, so — same
 * convention kotlin-kotlinx.ts's `declareField` uses — a nested declaration
 * is synthesized here, named by capitalizing the field name, and returned
 * alongside the field's type reference to that name.
 */
function declareField(
  fieldName: string,
  fieldRef: TypeRef,
  options: Required<KotlinGsonOptions>,
): FieldResult {
  const nested: string[] = [];
  let type: string;

  if (isA(fieldRef.shape.kind, "object")) {
    const nestedName = capitalize(fieldName);
    nested.push(toKotlinGson(fieldRef, nestedName, options));
    type = nestedName;
  } else if (
    fieldRef.shape.kind === "array" &&
    isA((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind, "object")
  ) {
    const nestedName = capitalize(fieldName);
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element;
    nested.push(toKotlinGson(element, nestedName, options));
    type = `List<${nestedName}>`;
  } else if (fieldRef.shape.kind === "enum") {
    const nestedName = capitalize(fieldName);
    nested.push(toKotlinGson(fieldRef, nestedName, options));
    type = nestedName;
  } else if (fieldRef.shape.kind === "union") {
    const nestedName = capitalize(fieldName);
    nested.push(toKotlinGson(fieldRef, nestedName, options));
    type = nestedName;
  } else {
    type = toKotlinType(fieldRef);
  }

  const nullable = fieldRef.meta.optional === true || fieldRef.meta.nullable === true;
  if (nullable && !type.endsWith("?")) type += "?";
  return { type, nested };
}

// https://kotlinlang.org/docs/data-classes.html + Gson's `@SerializedName`/
// `@Expose` — every declared field becomes a primary-constructor `val`; an
// optional field gets a `= null` default so callers can omit it, matching
// how `optional` is understood everywhere else in type-ir (a field that MAY
// be absent, not one that's merely nullable). Unlike kotlin-kotlinx.ts, the
// class itself needs no `@Serializable` marker — Gson reads Kotlin
// properties reflectively.
function toDataClass(name: string, ref: TypeRef, options: Required<KotlinGsonOptions>): string {
  const shape = ref.shape as TypeShape & { kind: "object" };
  const nestedDecls: string[] = [];
  const params = Object.entries(shape.fields).map(([fieldName, fieldRef]) => {
    const { type, nested } = declareField(fieldName, fieldRef, options);
    nestedDecls.push(...nested);
    const readonly = fieldRef.meta.readonly === true;
    const optional = fieldRef.meta.optional === true;
    const fieldDoc = kotlinDocComment(fieldRef.meta, "    ");
    const keyword = readonly ? "val" : "var";
    const suffix = optional ? " = null" : "";
    const exposeAnnotation = options.expose ? " @Expose" : "";
    return `${fieldDoc}    @SerializedName(${quote(fieldName)})${exposeAnnotation} ${keyword} ${fieldName}: ${type}${suffix}`;
  });

  const lines = [kotlinDocComment(ref.meta, ""), `data class ${name}(`, params.join(",\n"), ")"];
  const decl = lines.filter((l) => l !== "").join("\n");
  return [decl, ...nestedDecls].join("\n\n");
}

// https://kotlinlang.org/docs/enum-classes.html + Gson's `@SerializedName`
// placed directly on each enum constant (Gson's default `FieldNamingPolicy`
// reads the constant's own backing field, unlike Jackson which needs a
// backing `value` field + `@JsonValue`/`@JsonCreator` to diverge from the
// constant name) — preserves the exact wire string regardless of how
// `toEnumEntryName` reshapes the Kotlin identifier.
function toEnumClass(name: string, ref: TypeRef, options: Required<KotlinGsonOptions>): string {
  const shape = ref.shape as TypeShape & { kind: "enum" };
  const exposeAnnotation = options.expose ? " @Expose" : "";
  const entries = shape.members.map(
    (member) =>
      `    @SerializedName(${quote(member)})${exposeAnnotation} ${toEnumEntryName(member)}`,
  );
  const lines = [kotlinDocComment(ref.meta, ""), `enum class ${name} {`, entries.join(",\n"), "}"];
  return lines.filter((l) => l !== "").join("\n");
}

/** True when every union variant is (or descends from) `object` and they all
 * carry the same literal-valued discriminant field named `discriminator` —
 * the shape `meta.discriminator` asserts. Used only to name each subclass
 * and to drop the discriminant field from its generated properties; Gson
 * itself has no annotation that reads this value (see module doc comment) —
 * a `RuntimeTypeAdapterFactory` registered against the caller's
 * `GsonBuilder` is what actually dispatches on it at runtime. */
function discriminantValue(variant: TypeRef, discriminator: string): string | undefined {
  if (!isA(variant.shape.kind, "object")) return undefined;
  const field = (variant.shape as TypeShape & { kind: "object" }).fields[discriminator];
  if (field === undefined || field.shape.kind !== "literal") return undefined;
  const value = (field.shape as TypeShape & { kind: "literal" }).value;
  return typeof value === "string" ? value : undefined;
}

// https://kotlinlang.org/docs/sealed-classes.html — Gson has no
// annotation-driven polymorphism support (see module doc comment); this
// projector emits the same `sealed class` + one `data class` per variant
// kotlin-kotlinx.ts's `toSealedClass` does, minus the `@SerialName` tag
// (there's nothing for Gson to read it from), plus a comment spelling out
// the `RuntimeTypeAdapterFactory` registration the caller's `GsonBuilder`
// setup still needs — the same fallback convention java-gson.ts's
// `renderSealedInterface` uses for the identical gap, one target language
// over.
function toSealedClass(name: string, ref: TypeRef, options: Required<KotlinGsonOptions>): string {
  const shape = ref.shape as TypeShape & { kind: "union" };
  const discriminator =
    typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined;
  const nestedDecls: string[] = [];

  const variantDecls = shape.variants.map((variant, i) => {
    const tag = discriminator === undefined ? undefined : discriminantValue(variant, discriminator);
    const variantName = tag !== undefined ? capitalize(tag) : `Variant${i + 1}`;

    if (isA(variant.shape.kind, "object")) {
      // The discriminant field itself is structural noise once it's encoded
      // as the sealed subclass's own type identity — drop it from the
      // generated data class's fields, same as kotlin-kotlinx.ts's
      // `toSealedClass`.
      const objShape = variant.shape as TypeShape & { kind: "object" };
      const fields =
        tag === undefined
          ? objShape.fields
          : Object.fromEntries(
              Object.entries(objShape.fields).filter(([fieldName]) => fieldName !== discriminator),
            );
      const variantRef = { shape: { ...objShape, fields }, meta: variant.meta };
      const classDecl = toDataClass(variantName, variantRef, options);
      // `toDataClass` always emits "data class ..." as its first line (once
      // any KDoc comment precedes it) — splice `: Name()` onto the
      // constructor's closing paren so the variant extends the sealed
      // parent. `toDataClass` always ends a declaration's own class body
      // with a bare ")" line, so this only ever matches that line, never a
      // nested declaration's closing paren (those are joined in afterwards,
      // with a blank-line separator, by `toDataClass`'s own return).
      const [ownDecl, ...rest] = classDecl.split("\n\n");
      return [`${ownDecl!.replace(/\)$/, `) : ${name}()`)}`, ...rest].join("\n\n");
    }

    // A non-object variant (e.g. a bare string/number in the union) has no
    // fields to lift into a data class — wrap it as a single-value carrier,
    // the idiomatic Kotlin pattern for a sealed subtype over a scalar.
    const { type, nested } = declareField(`${variantName}Value`, variant, options);
    nestedDecls.push(...nested);
    return `data class ${variantName}(val value: ${type}) : ${name}()`;
  });

  const names = variantDecls.map((_, i) => {
    const tag =
      discriminator === undefined
        ? undefined
        : discriminantValue(shape.variants[i]!, discriminator);
    return tag !== undefined ? capitalize(tag) : `Variant${i + 1}`;
  });

  const commentLines = ["// Gson has no annotation-based polymorphism support. Register a"];
  commentLines.push("// RuntimeTypeAdapterFactory (com.google.gson.gson-extras) against your");
  commentLines.push("// GsonBuilder to (de)serialize this hierarchy, e.g.:");
  commentLines.push("//");
  if (discriminator !== undefined) {
    commentLines.push(
      `//   RuntimeTypeAdapterFactory<${name}> typeFactory = RuntimeTypeAdapterFactory`,
    );
    commentLines.push(`//       .of(${name}::class.java, ${quote(discriminator)})`);
  } else {
    commentLines.push(
      `//   RuntimeTypeAdapterFactory<${name}> typeFactory = RuntimeTypeAdapterFactory`,
    );
    commentLines.push(`//       .of(${name}::class.java)`);
  }
  for (const n of names)
    commentLines.push(`//       .registerSubtype(${n}::class.java, ${quote(n)})`);
  commentLines.push(
    "//   val gson = GsonBuilder().registerTypeAdapterFactory(typeFactory).create()",
  );

  const header = [kotlinDocComment(ref.meta, ""), commentLines.join("\n"), `sealed class ${name}`];
  const decl = header.filter((l) => l !== "").join("\n");
  return [decl, ...variantDecls, ...nestedDecls].join("\n\n");
}

/**
 * Top-level declaration entry point — `toKotlinGson(ref, name)` emits a
 * `data class`/`enum class`/`sealed class` declaration (plus any nested
 * declarations synthesized along the way) for named kinds, or a `typealias`
 * for everything else. Without a `name`, only kinds that already have a bare
 * type expression (primitives, arrays, maps, tuples, refs, …) make sense — a
 * named kind with no name falls back to `"Anonymous"` rather than silently
 * producing unnamed Kotlin, since every named Kotlin declaration needs an
 * identifier.
 */
export function toKotlinGson(ref: TypeRef, name?: string, options?: KotlinGsonOptions): string {
  const resolved = resolveOptions(defaultOptions, options);
  if (ref.shape.kind === "object" || ref.shape.kind === "union" || ref.shape.kind === "enum") {
    const declName = name ?? "Anonymous";
    if (ref.shape.kind === "object") return toDataClass(declName, ref, resolved);
    if (ref.shape.kind === "enum") return toEnumClass(declName, ref, resolved);
    return toSealedClass(declName, ref, resolved);
  }
  if (name === undefined) return toKotlinType(ref);
  return `typealias ${name} = ${toKotlinType(ref)}`;
}

export function toKotlinGsonDeclarations(
  registry: Record<string, TypeRef>,
  options?: KotlinGsonOptions,
): string {
  return Object.entries(registry)
    .map(([name, ref]) => toKotlinGson(ref, name, options))
    .join("\n\n");
}
