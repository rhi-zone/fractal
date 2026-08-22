import { resolve, type TypeRef, type TypeShape } from "./index.ts";
import { capitalize, javaDocComment, quote, resolveOptions } from "./codegen-helpers.ts";

// ============================================================================
// Java projector — TypeRef -> idiomatic Java 16+ source (records by default,
// classic POJOs as an opt-in style; see JavaOptions.style).
//
// Two renderers, same split TypeScript's projector uses (toTypeScript vs
// toTypeDeclaration): `toJavaType` renders a type expression (usable inside a
// field, a generic argument, a method signature — "List<String>",
// "OrderStatus", "int") with no accompanying declaration; `toJavaDeclaration`
// renders a full top-level declaration (a record/class/enum/sealed
// interface). `toJava` below is the single entry point the package exports:
// pass `name` to get a declaration, omit it to get a bare type expression.
// ============================================================================

export interface JavaOptions {
  /** "record" (Java 16+ — https://openjdk.org/jeps/395 — an immutable data
   * carrier with auto-generated constructor/accessors/equals/hashCode/
   * toString; the default) or "pojo" (a classic class with private final
   * fields, a `@JsonCreator` constructor, and `getX()` accessors — for
   * codebases not yet on a Java baseline with records). */
  style?: "record" | "pojo";
  /** How an optional/nullable field's type is rendered: "nullable" (default)
   * keeps the plain boxed type and adds a `@Nullable` annotation — the
   * convention Jackson and most Java JSON libraries expect, since
   * `Optional<T>` is documented (Effective Java item 55) as intended for
   * return values, not field/parameter/record-component types. "optional"
   * wraps the type in `java.util.Optional<T>` for codebases that have chosen
   * to use it that way regardless. */
  optionalStyle?: "nullable" | "optional";
  /** Emit Jackson (`@JsonProperty`/`@JsonTypeInfo`/`@JsonSubTypes`)
   * annotations for JSON (de)serialization. Default `true`. */
  jackson?: boolean;
  /** `package` declaration line to emit above the type. Omitted if unset. */
  packageName?: string;
}

const defaultOptions: Required<JavaOptions> = {
  style: "record",
  optionalStyle: "nullable",
  jackson: true,
  packageName: "",
};

// JSpecify (https://jspecify.dev/) is the JSR-305 successor endorsed by
// Google/JetBrains/Spring as the common `@Nullable` all tooling is
// converging on — used here rather than `javax.annotation.Nullable` (JSR-305,
// unmaintained) or a framework-specific one (`org.springframework.lang.
// Nullable`), since this projector has no framework to anchor a choice to.
const NULLABLE_ANNOTATION = "org.jspecify.annotations.Nullable";

// A leaf scalar's Java rendering: `primitive` (when one exists — Java's 8
// primitive types have no null value, so a leaf with a primitive form only
// gets rendered as that primitive in a non-nullable, non-generic position;
// nullable fields and generic type arguments always fall back to `boxed`,
// since Java generics cannot be parameterized by a primitive) and `boxed`
// (the reference-type equivalent, always defined). `imports` is the set of
// `java.*`/`javax.*` types the boxed/primitive spelling itself requires
// (empty for unqualified names like `String`/`int` that live in
// `java.lang`, which needs no import).
type Rendering = {
  readonly primitive?: string;
  readonly boxed: string;
  readonly imports: readonly string[];
};

// `decls` accumulates every declaration discovered while walking nested
// object/enum/union TypeRefs that have no `meta.typeName` of their own (see
// the `object`/`enum`/`union` handlers below and `renderRecordOrClass`/
// `renderEnum`/`renderSealedInterface`'s `isPublic` parameter) — the same
// "ctx.decls accumulates every nested declaration, named via meta.typeName
// or a suggested name threaded down from the caller" convention
// csharp-systemtextjson.ts's `Ctx`/`emitObjectType`/`emitEnumType`/
// `emitUnionType` use, adapted for Java's added constraint that only one
// top-level type per file may be `public` (and it must match the file name)
// — so unlike C#, every declaration this walk pushes onto `decls` is
// rendered *non*-public; only the root declaration `toJavaDeclaration`
// builds directly keeps `public`.
type Ctx = {
  readonly options: Required<JavaOptions>;
  readonly imports: Set<string>;
  readonly decls: string[];
};

type Converter = (
  shape: TypeShape,
  meta: Readonly<Record<string, unknown>>,
  ctx: Ctx,
  suggestedName: string,
) => Rendering;

const leaf =
  (boxed: string, primitive?: string, imports: readonly string[] = []): Converter =>
  () =>
    primitive === undefined ? { boxed, imports } : { boxed, primitive, imports };

// Turns an arbitrary field/property name into a valid, idiomatic Java
// identifier (camelCase, alphanumeric) — used both for record
// components/POJO fields (so a JSON property like "user-id" or "2fa_code"
// still compiles) and enum constants (see `javaEnumConstant` below, which
// additionally upper-snake-cases the result).
function toJavaIdentifier(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "value";
  const [first, ...rest] = parts;
  const camel = [first!.toLowerCase(), ...rest.map(capitalize)].join("");
  return /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`;
}

function javaEnumConstant(member: string): string {
  const snake = member
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "");
  return snake.length === 0 || !/^[A-Za-z_]/.test(snake) ? `VALUE_${snake}` : snake;
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
  object: (shape, meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "object" };
    // An inline (unnamed) object has no Java equivalent expressible as a type
    // reference — Java has no anonymous record/struct type. Named via
    // `meta.typeName` when the extractor recorded one, else the
    // `suggestedName` threaded down from the enclosing field/element/variant
    // (see `javaFieldType`/`javaType`'s call sites) — either way a full
    // record/class declaration is synthesized as a package-private sibling
    // declaration (`isPublic: false` — see the `Ctx.decls` doc comment) and
    // pushed onto `ctx.decls`, so distinct anonymous objects never collide on
    // a single unresolvable name.
    const name = typeof meta.typeName === "string" ? meta.typeName : suggestedName;
    const ref: TypeRef = { shape: s, meta };
    ctx.decls.push(renderRecordOrClass(name, ref, ctx, [], false));
    return { boxed: name, imports: [] };
  },
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — rendered as a
  // bare reference to that class name; the caller assembling the emitted
  // source is responsible for importing `className` from `source`.
  instance: (shape) => ({
    boxed: (shape as TypeShape & { kind: "instance" }).className,
    imports: [],
  }),
  array: (shape, _meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "array" };
    const element = javaType(s.element, ctx, `${suggestedName}Item`);
    return { boxed: `List<${element}>`, imports: ["java.util.List"] };
  },
  tuple: (shape, _meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "tuple" };
    const elements = s.elements.map((e, i) => javaType(e, ctx, `${suggestedName}Item${i + 1}`));
    // Java has no structural tuple type. Rendered as a reference to a
    // conventional `TupleN<T1, ..., TN>` record — this projector does not
    // define that support type itself (out of scope for a single TypeRef ->
    // type-expression call), so the caller assembling the emitted module is
    // responsible for providing (or importing) `Tuple2`/`Tuple3`/... records
    // with components named `first`/`second`/... — the same "caller wires
    // the import" convention `instance`/`ref` rely on above.
    return { boxed: `Tuple${elements.length}<${elements.join(", ")}>`, imports: [] };
  },
  // No native async-sequence type in Java's standard type system — degrades
  // to `List<T>` of the element type, the same degrade convention every
  // other data-only projector (Zod, protobuf, ...) applies to `stream`.
  stream: (shape, _meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "stream" };
    const element = javaType(s.element, ctx, `${suggestedName}Item`);
    return { boxed: `List<${element}>`, imports: ["java.util.List"] };
  },
  // Same degrade as `stream` — a page is one window over a larger collection
  // (see TypeKinds.page's doc comment), and Java has no pagination-window
  // type of its own to target.
  page: (shape, _meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "page" };
    const element = javaType(s.element, ctx, `${suggestedName}Item`);
    return { boxed: `List<${element}>`, imports: ["java.util.List"] };
  },
  map: (shape, _meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "map" };
    const key = javaType(s.key, ctx, `${suggestedName}Key`);
    const value = javaType(s.value, ctx, `${suggestedName}Value`);
    return { boxed: `Map<${key}, ${value}>`, imports: ["java.util.Map"] };
  },
  union: (shape, meta, ctx, suggestedName) => {
    // A union's idiomatic Java rendering is a top-level sealed interface
    // (see `renderSealedInterface` below) — as a bare type expression (this
    // path, used when a union appears nested inside a field/generic
    // position) it's rendered as a reference to that interface's name, named
    // via `meta.typeName` when present else the `suggestedName` threaded
    // down (same convention as the `object`/`enum` handlers), with the full
    // sealed-interface-plus-variants declaration synthesized as a
    // package-private sibling and pushed onto `ctx.decls`.
    const s = shape as TypeShape & { kind: "union" };
    const name = typeof meta.typeName === "string" ? meta.typeName : suggestedName;
    const ref: TypeRef = { shape: s, meta };
    ctx.decls.push(renderSealedInterface(name, ref, ctx, false));
    return { boxed: name, imports: [] };
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" };
    // Java has no literal type — degrades to the literal value's own runtime
    // type (String/Boolean/Integer/Double), the closest available type
    // still capable of holding that one value.
    if (s.value === null) return { boxed: "Void", imports: [] };
    if (typeof s.value === "string") return { boxed: "String", imports: [] };
    if (typeof s.value === "boolean")
      return { boxed: "Boolean", primitive: "boolean", imports: [] };
    return Number.isInteger(s.value)
      ? { boxed: "Integer", primitive: "int", imports: [] }
      : { boxed: "Double", primitive: "double", imports: [] };
  },
  enum: (shape, meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "enum" };
    const name = typeof meta.typeName === "string" ? meta.typeName : suggestedName;
    const ref: TypeRef = { shape: s, meta };
    ctx.decls.push(renderEnum(name, ref, ctx, false));
    return { boxed: name, imports: [] };
  },
  ref: (shape) => ({ boxed: (shape as TypeShape & { kind: "ref" }).target, imports: [] }),
  // Java has no intersection/mixin type — lossy: falls back to the first
  // member's type, dropping the rest (same fallback protobuf.ts uses for the
  // same reason).
  intersection: (shape, _meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "intersection" };
    const [first] = s.members;
    return first === undefined
      ? { boxed: "Object", imports: [] }
      : { boxed: javaType(first, ctx, suggestedName), imports: [] };
  },
  // `java.util.function` has fixed-arity functional interfaces for 0-2
  // params (Supplier/Function/BiFunction); arities above that have no
  // standard-library equivalent (Java, unlike some ecosystems, doesn't
  // define TriFunction+) and degrade to Object, the same degrade convention
  // protobuf.ts applies to its own uncoverable cases.
  function: (shape, _meta, ctx, suggestedName) => {
    const s = shape as TypeShape & { kind: "function" };
    const returnType = javaType(s.returnType, ctx, `${suggestedName}Return`);
    const isVoid = s.returnType.shape.kind === "void";
    const params = s.params.map((p, i) => javaType(p.type, ctx, `${suggestedName}Param${i + 1}`));
    if (params.length === 0) {
      return isVoid
        ? { boxed: "Runnable", imports: [] }
        : { boxed: `java.util.function.Supplier<${returnType}>`, imports: [] };
    }
    if (params.length === 1) {
      return isVoid
        ? { boxed: `java.util.function.Consumer<${params[0]}>`, imports: [] }
        : { boxed: `java.util.function.Function<${params[0]}, ${returnType}>`, imports: [] };
    }
    if (params.length === 2) {
      return isVoid
        ? { boxed: `java.util.function.BiConsumer<${params[0]}, ${params[1]}>`, imports: [] }
        : {
            boxed: `java.util.function.BiFunction<${params[0]}, ${params[1]}, ${returnType}>`,
            imports: [],
          };
    }
    return { boxed: "Object", imports: [] };
  },
  // An interface's method surface has no Java field-position equivalent
  // (unlike TypeScript, which can spell an inline callable-object type) —
  // degrades to Object, same as protobuf.ts's handling of the same kind.
  interface: () => ({ boxed: "Object", imports: [] }),
};

/** Bare type expression for `ref` — the reference (boxed) spelling, suitable
 * as a generic type argument, a `List<...>`/`Map<...>` element, or any
 * position that isn't itself a top-level field (see `javaFieldType`, which
 * additionally applies primitive-unboxing and nullable rendering). Collects
 * required imports into `ctx.imports` as a side effect. */
export function javaType(ref: TypeRef, ctx: Ctx, suggestedName: string): string {
  const converter = resolve(ref.shape.kind, handlers);
  const rendering =
    converter === undefined
      ? { boxed: "Object", imports: [] }
      : converter(ref.shape, ref.meta, ctx, suggestedName);
  for (const imp of rendering.imports) ctx.imports.add(imp);
  return rendering.boxed;
}

type FieldRendering = {
  readonly type: string;
  readonly annotations: readonly string[];
};

/** A field/record-component/parameter's rendering: primitive type when the
 * field is required (Java primitives can't express null, so a required
 * field gets the tightest representation available) and not nested in a
 * generic; boxed type — optionally wrapped in `Optional<T>` or annotated
 * `@Nullable`, per `options.optionalStyle` — when the field is optional/
 * nullable. */
function javaFieldType(ref: TypeRef, ctx: Ctx, suggestedName: string): FieldRendering {
  const converter = resolve(ref.shape.kind, handlers);
  const rendering =
    converter === undefined
      ? { boxed: "Object", imports: [] }
      : converter(ref.shape, ref.meta, ctx, suggestedName);
  for (const imp of rendering.imports) ctx.imports.add(imp);
  const optional = ref.meta.optional === true || ref.meta.nullable === true;
  if (!optional) {
    return { type: rendering.primitive ?? rendering.boxed, annotations: [] };
  }
  if (ctx.options.optionalStyle === "optional") {
    ctx.imports.add("java.util.Optional");
    return { type: `Optional<${rendering.boxed}>`, annotations: [] };
  }
  ctx.imports.add(NULLABLE_ANNOTATION);
  return { type: rendering.boxed, annotations: ["@Nullable"] };
}

/** Detects a discriminated union's shared discriminant field name, following
 * the same open-metadata-bag convention `zod.ts`'s `union` handler reads
 * (`meta.discriminator: string` on the union TypeRef itself) rather than
 * re-deriving it structurally — the extractor that built the TypeRef is the
 * one place that actually knows which field was matched as a discriminant. */
function discriminatorOf(meta: Readonly<Record<string, unknown>>): string | undefined {
  return typeof meta.discriminator === "string" ? meta.discriminator : undefined;
}

function variantName(variant: TypeRef, unionName: string, index: number): string {
  if (typeof variant.meta.typeName === "string") return variant.meta.typeName;
  return `${unionName}Variant${index + 1}`;
}

/** Renders one `object`-shaped variant of a discriminated/plain union as a
 * Java record implementing the union's sealed interface — always
 * package-private (`isPublic: false`): a variant record's name never matches
 * the enclosing file's name (see `variantName`), so it can never be the
 * file's sole `public` type (see the `Ctx.decls` doc comment above). */
function renderVariantRecord(name: string, interfaceName: string, ref: TypeRef, ctx: Ctx): string {
  const body = renderRecordOrClass(name, ref, ctx, [interfaceName], false);
  return body;
}

/**
 * `isPublic` (default `true`) controls whether the declaration carries the
 * `public` modifier — a single Java file may have at most one `public`
 * top-level type, and it must match the file name, so every declaration this
 * projector synthesizes for a nested (non-root) type — see the `object`
 * handler above — is rendered with `isPublic: false`.
 */
function renderRecordOrClass(
  name: string,
  ref: TypeRef,
  ctx: Ctx,
  implementsList: readonly string[] = [],
  isPublic = true,
): string {
  const shape = ref.shape as TypeShape & { kind: "object" };
  const fields = Object.entries(shape.fields);
  const implementsClause =
    implementsList.length === 0 ? "" : ` implements ${implementsList.join(", ")}`;
  const doc = javaDocComment(ref.meta, "");
  const modifier = isPublic ? "public " : "";

  if (ctx.options.style === "record") {
    const components = fields.map(([fieldName, fieldRef]) => {
      const javaName = toJavaIdentifier(fieldName);
      const { type, annotations } = javaFieldType(fieldRef, ctx, `${name}${capitalize(javaName)}`);
      const jsonAnnotation =
        ctx.options.jackson && javaName !== fieldName
          ? [`@JsonProperty(${quote(fieldName)}) `]
          : [];
      const annotationPrefix = [...annotations.map((a) => `${a} `), ...jsonAnnotation].join("");
      return `${annotationPrefix}${type} ${javaName}`;
    });
    return `${doc}${modifier}record ${name}(${components.join(", ")})${implementsClause} {}`;
  }

  // Classic POJO: private final fields + an `@JsonCreator`-annotated
  // canonical constructor (Jackson's documented pattern for deserializing
  // immutable objects: https://github.com/FasterXML/jackson-databind/wiki/Deserialization-Features
  // -> "Creator properties") + `getX()` accessors.
  const lines: string[] = [];
  lines.push(`${doc}${modifier}final class ${name}${implementsClause} {`);
  const rendered = fields.map(([fieldName, fieldRef]) => {
    const javaName = toJavaIdentifier(fieldName);
    const { type, annotations } = javaFieldType(fieldRef, ctx, `${name}${capitalize(javaName)}`);
    return { fieldName, javaName, type, annotations };
  });
  for (const f of rendered) {
    for (const a of f.annotations) lines.push(`  ${a}`);
    lines.push(`  private final ${f.type} ${f.javaName};`);
  }
  lines.push("");
  const ctorParams = rendered
    .map((f) => {
      const jsonAnnotation = ctx.options.jackson ? `@JsonProperty(${quote(f.fieldName)}) ` : "";
      const nullableAnnotation = f.annotations.includes("@Nullable") ? "@Nullable " : "";
      return `${jsonAnnotation}${nullableAnnotation}${f.type} ${f.javaName}`;
    })
    .join(", ");
  if (ctx.options.jackson) lines.push("  @JsonCreator");
  lines.push(`  public ${name}(${ctorParams}) {`);
  for (const f of rendered) lines.push(`    this.${f.javaName} = ${f.javaName};`);
  lines.push("  }");
  for (const f of rendered) {
    lines.push("");
    lines.push(`  public ${f.type} get${capitalize(f.javaName)}() {`);
    lines.push(`    return this.${f.javaName};`);
    lines.push("  }");
  }
  lines.push("}");
  return lines.join("\n");
}

/** Renders a union as a Java 17+ sealed interface (https://openjdk.org/jeps/409)
 * whose `permits` clause lists one record per variant — the idiomatic
 * closed-hierarchy encoding of a sum type in modern Java (pattern-matching
 * `switch` over the sealed interface then covers all cases exhaustively).
 * When the union carries `meta.discriminator` (see `discriminatorOf`),
 * Jackson annotations are added so the interface deserializes correctly by
 * reading that field: `@JsonTypeInfo` (property-based, matching the existing
 * discriminant field rather than introducing a synthetic wrapper) +
 * `@JsonSubTypes` naming each variant. A plain (non-discriminated) union gets
 * no `@JsonTypeInfo` — Jackson has no default way to pick among structurally
 * arbitrary variants, so deserialization of that case is left to the caller
 * (e.g. a custom deserializer), same as the degrade convention used
 * elsewhere in this projector for constructs Java/Jackson can't express.
 *
 * `isPublic` (default `true`, see `renderRecordOrClass`'s doc comment for
 * why) controls only the interface's own modifier — the per-variant records
 * `variantDecls` builds are always package-private (`renderVariantRecord`
 * always passes `isPublic: false`; the inline non-object-variant wrapper
 * record below carries no `public` either), since a variant's name is never
 * the file's root name.
 */
function renderSealedInterface(name: string, ref: TypeRef, ctx: Ctx, isPublic = true): string {
  const shape = ref.shape as TypeShape & { kind: "union" };
  const discriminator = discriminatorOf(ref.meta);
  const names = shape.variants.map((v, i) => variantName(v, name, i));

  const lines: string[] = [];
  const doc = javaDocComment(ref.meta, "");
  if (doc) lines.push(doc.trimEnd());
  if (ctx.options.jackson && discriminator !== undefined) {
    lines.push(
      "@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.EXISTING_PROPERTY,",
    );
    lines.push(`    property = ${quote(discriminator)})`);
    lines.push("@JsonSubTypes({");
    lines.push(
      names.map((n) => `  @JsonSubTypes.Type(value = ${n}.class, name = ${quote(n)})`).join(",\n"),
    );
    lines.push("})");
  }
  const modifier = isPublic ? "public " : "";
  lines.push(`${modifier}sealed interface ${name} permits ${names.join(", ")} {}`);

  const variantDecls = shape.variants.map((variant, i) => {
    const variantRef = variant;
    if (variantRef.shape.kind !== "object") {
      // A non-object union variant (e.g. a bare string/number literal) has
      // no fields to carry as record components — wrapped in a single-field
      // "value" record, the degrade a discriminated union with a scalar
      // variant needs to stay a valid `implements` target.
      const inner = javaFieldType(variantRef, ctx, `${names[i]}Value`);
      const annotationPrefix =
        inner.annotations.length > 0 ? `${inner.annotations.join(" ")} ` : "";
      return `${javaDocComment(variantRef.meta, "")}record ${names[i]}(${annotationPrefix}${inner.type} value) implements ${name} {}`;
    }
    return renderVariantRecord(names[i]!, name, variantRef, ctx);
  });

  return [lines.join("\n"), ...variantDecls].join("\n\n");
}

function renderEnum(name: string, ref: TypeRef, ctx: Ctx, isPublic = true): string {
  const shape = ref.shape as TypeShape & { kind: "enum" };
  const doc = javaDocComment(ref.meta, "");
  const modifier = isPublic ? "public " : "";
  const constants = shape.members.map((member) => ({ member, constant: javaEnumConstant(member) }));
  const needsBackingValue = constants.some(({ member, constant }) => member !== constant);
  // Even when constant names round-trip cleanly to the original string,
  // Jackson serializes an enum by its constant name by default — a backing
  // `value` field + `@JsonValue`/`@JsonCreator` is the only way to guarantee
  // the wire format matches `shape.members` exactly, so it's always added
  // when Jackson support is requested.
  if (ctx.options.jackson || needsBackingValue) {
    const lines: string[] = [];
    lines.push(`${doc}${modifier}enum ${name} {`);
    lines.push(
      `  ${constants.map(({ member, constant }) => `${constant}(${quote(member)})`).join(", ")};`,
    );
    lines.push("");
    lines.push("  private final String value;");
    lines.push("");
    lines.push(`  ${name}(String value) {`);
    lines.push("    this.value = value;");
    lines.push("  }");
    lines.push("");
    if (ctx.options.jackson) lines.push("  @JsonValue");
    lines.push("  public String getValue() {");
    lines.push("    return this.value;");
    lines.push("  }");
    if (ctx.options.jackson) {
      lines.push("");
      lines.push("  @JsonCreator");
      lines.push(`  public static ${name} fromValue(String value) {`);
      lines.push("    for (var candidate : values()) {");
      lines.push("      if (candidate.value.equals(value)) return candidate;");
      lines.push("    }");
      lines.push(`    throw new IllegalArgumentException("Unknown ${name}: " + value);`);
      lines.push("  }");
    }
    lines.push("}");
    return lines.join("\n");
  }
  return `${doc}${modifier}enum ${name} {\n  ${constants.map((c) => c.constant).join(", ")}\n}`;
}

const JACKSON_IMPORTS = [
  "com.fasterxml.jackson.annotation.JsonProperty",
  "com.fasterxml.jackson.annotation.JsonCreator",
  "com.fasterxml.jackson.annotation.JsonValue",
  "com.fasterxml.jackson.annotation.JsonTypeInfo",
  "com.fasterxml.jackson.annotation.JsonSubTypes",
];

function assembleSource(body: string, ctx: Ctx, options: Required<JavaOptions>): string {
  const lines: string[] = [];
  if (options.packageName !== "") lines.push(`package ${options.packageName};`, "");
  const imports = [...ctx.imports].sort();
  if (imports.length > 0) {
    lines.push(...imports.map((i) => `import ${i};`), "");
  }
  // `ctx.decls` holds every package-private declaration synthesized for a
  // nested object/enum/union that had no `meta.typeName` of its own (see the
  // `object`/`enum`/`union` handlers) — appended after the root declaration
  // so the emitted file compiles as a single translation unit.
  lines.push([body, ...ctx.decls].join("\n\n"));
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Top-level declaration for a named type — a record/class for `object`, a
 * `public enum` for `enum`, a sealed interface + one record per variant for
 * `union`, or (for any other kind) a single `public final class` wrapping a
 * `value` field of that type, since Java has no top-level type-alias
 * construct the way TypeScript's `type X = ...` does.
 */
export function toJavaDeclaration(name: string, ref: TypeRef, options?: JavaOptions): string {
  const resolved = resolveOptions(defaultOptions, options);
  const ctx: Ctx = {
    options: resolved,
    imports: new Set(resolved.jackson ? JACKSON_IMPORTS : []),
    decls: [],
  };

  let body: string;
  if (ref.shape.kind === "object") {
    body = renderRecordOrClass(name, ref, ctx);
  } else if (ref.shape.kind === "enum") {
    body = renderEnum(name, ref, ctx);
  } else if (ref.shape.kind === "union") {
    body = renderSealedInterface(name, ref, ctx);
  } else if (ref.shape.kind === "tuple") {
    const shape = ref.shape as TypeShape & { kind: "tuple" };
    const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
    const components = shape.elements.map((element, i) => {
      const { type } = javaFieldType(element, ctx, `${name}Item${i + 1}`);
      return `${type} ${ordinals[i] ?? `field${i + 1}`}`;
    });
    body = `${javaDocComment(ref.meta, "")}public record ${name}(${components.join(", ")}) {}`;
  } else {
    // A wrapper class is the closest Java equivalent to a bare type alias
    // over a scalar/collection type (Java has no `type X = ...` construct).
    const { type, annotations } = javaFieldType(ref, ctx, name);
    const annotationLine = annotations.length > 0 ? `${annotations.join(" ")} ` : "";
    const doc = javaDocComment(ref.meta, "");
    body =
      resolved.style === "record"
        ? `${doc}public record ${name}(${annotationLine}${type} value) {}`
        : [
            `${doc}public final class ${name} {`,
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
          ].join("\n");
  }

  return assembleSource(body, ctx, resolved);
}

/**
 * Entry point: pass `name` for a full top-level declaration
 * (record/class/enum/sealed interface, imports included); omit it for a bare
 * type expression usable inline (`"List<String>"`, `"OrderStatus"`, `"int"`)
 * — the same declaration/expression split `toTypeDeclaration`/`toTypeScript`
 * use in `typescript.ts`.
 */
export function toJava(ref: TypeRef, name?: string, options?: JavaOptions): string {
  if (name !== undefined) return toJavaDeclaration(name, ref, options);
  const resolved = resolveOptions(defaultOptions, options);
  // No name context to seed nested declarations with, and (unlike
  // `toJavaDeclaration`) nothing below reads `ctx.decls` back out — this bare
  // expression mode is documented as inline-only (see the doc comment
  // above), same scope boundary it had before nested declarations existed.
  const ctx: Ctx = { options: resolved, imports: new Set(), decls: [] };
  const { type } = javaFieldType(ref, ctx, "Value");
  return type;
}
