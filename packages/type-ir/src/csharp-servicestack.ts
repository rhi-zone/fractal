// C# (9+) projector for ServiceStack.Text (https://docs.servicestack.net/text-serializers) —
// a sibling of csharp-systemtextjson.ts (same TypeRef -> C# record/enum
// architecture; `ctx.decls` accumulates every declaration discovered during
// the walk, in the order first encountered; `toCSharpServiceStack` joins
// them into one file) using ServiceStack.Text's own attribute vocabulary
// instead of System.Text.Json's.
//
// ServiceStack.Text vs. System.Text.Json, structurally:
//   - Field naming: ServiceStack.Text's JSON/JSV serializers read the
//     standard WCF `System.Runtime.Serialization` contract attributes —
//     `[DataContract]` on the type, `[DataMember(Name = "wire-name")]` on
//     each property (https://docs.servicestack.net/serialization-deserialization)
//     — rather than STJ's `[JsonPropertyName]`. `[DataContract]` additionally
//     switches ServiceStack's serializers into "opt in" mode (only
//     `[DataMember]`-annotated members are (de)serialized), which is why
//     every property gets one unconditionally, unlike STJ's projector which
//     only reaches for an attribute when the identifier itself needs
//     reshaping.
//   - Enums: ServiceStack.Text serializes an enum by its member NAME by
//     default (https://docs.servicestack.net/csharp-client) — no attribute
//     needed to opt into that behavior, so (unlike STJ's
//     `[JsonConverter(typeof(JsonStringEnumConverter))]`) this projector
//     emits a plain `enum` with no decoration.
//   - Polymorphism/unions: ServiceStack.Text has no declarative
//     `[JsonPolymorphic]`/`[JsonDerivedType]` equivalent — the documented
//     pattern (https://docs.servicestack.net/serialization-deserialization#inheritance)
//     is including a `__type` discriminator via `JsConfig.IncludeTypeInfo` or
//     a custom `ITypeSerializer`, configured imperatively rather than
//     declared on the type. This projector emits the same abstract base
//     record + one derived `[DataContract]` record per variant
//     csharp-systemtextjson.ts does, plus a comment documenting the
//     `JsConfig`/custom-serializer wiring the caller still needs — the same
//     honest-degrade convention java-gson.ts/kotlin-gson.ts use for their
//     own missing-polymorphism gap.
import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

interface Ctx {
  readonly decls: string[]
}

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/** camelCase/snake_case/kebab-case (or already-PascalCase) -> PascalCase —
 * used for both C# property names (from field keys) and type/member names
 * (from field keys used as a naming seed, and enum member strings). */
function pascalCase(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0)
  if (parts.length === 0) return raw
  return parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("")
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `    ${line}`))
    .join("\n")
}

type Converter = (shape: TypeShape, suggestedName: string, ctx: Ctx) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// XML doc-comment convention (https://learn.microsoft.com/dotnet/csharp/language-reference/xmldoc/)
// — `<summary>` from `meta.description`, rendered as a `///`-prefixed block
// immediately above the declaration it documents.
function xmlDocComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  if (description === undefined) return ""
  return `/// <summary>\n/// ${description}\n/// </summary>\n`
}

// [Obsolete] (https://learn.microsoft.com/dotnet/api/system.obsoleteattribute)
// is C#'s native deprecation marker, recognized by the compiler (a warning at
// every use site) — `meta.deprecated` may be `true` (no message) or a string
// (becomes the attribute's message argument).
function obsoleteAttr(meta: Readonly<Record<string, unknown>>): string {
  if (typeof meta.deprecated === "string") return `[Obsolete(${quote(meta.deprecated)})]\n`
  if (meta.deprecated === true) return "[Obsolete]\n"
  return ""
}

function emitObjectType(
  shape: TypeShape & { kind: "object" },
  name: string,
  ctx: Ctx,
  meta: Readonly<Record<string, unknown>> = {},
): string {
  const props = Object.entries(shape.fields).map(([fieldName, fieldRef]) =>
    renderProperty(fieldName, fieldRef, name, ctx),
  )
  const doc = `${xmlDocComment(meta)}${obsoleteAttr(meta)}`
  ctx.decls.push(`${doc}[DataContract]\npublic record ${name}\n{\n${props.join("\n\n")}\n}`)
  return name
}

/** Builds one property's `[DataMember(Name = "...")]` attribute + declaration.
 * Always attached (not only when the identifier needs reshaping) — once a
 * type carries `[DataContract]`, WCF-attribute-driven serializers (including
 * ServiceStack.Text) only (de)serialize members explicitly opted in via
 * `[DataMember]`, so omitting it on a clean-named property would silently
 * drop that property from the wire format. */
function renderProperty(fieldName: string, fieldRef: TypeRef, ownerName: string, ctx: Ctx): string {
  const propName = pascalCase(fieldName)
  const optional = fieldRef.meta.optional === true
  let type = typeExpr(fieldRef, `${ownerName}${propName}`, ctx)
  if (optional && !type.endsWith("?")) type += "?"
  const dataMemberArgs = [`Name = ${quote(fieldName)}`]
  if (!optional) dataMemberArgs.push("IsRequired = true")
  return `    [DataMember(${dataMemberArgs.join(", ")})]\n    public ${type} ${propName} { get; init; }`
}

function emitEnumType(
  shape: TypeShape & { kind: "enum" },
  name: string,
  ctx: Ctx,
  meta: Readonly<Record<string, unknown>> = {},
): string {
  const members = shape.members.map((m) => `    ${pascalCase(m)}`)
  const doc = `${xmlDocComment(meta)}${obsoleteAttr(meta)}`
  // ServiceStack.Text serializes an enum by its member name by default — no
  // converter attribute needed the way System.Text.Json's
  // JsonStringEnumConverter is (see module doc comment).
  ctx.decls.push(`${doc}public enum ${name}\n{\n${members.join(",\n")}\n}`)
  return name
}

/** Name a union variant — prefers the variant's own `meta.typeName` (a named
 * alias the extractor recorded), then the discriminator field's own literal
 * value (the natural "tag" name for a discriminated variant), falling back
 * to a positional `{Base}Variant{N}` when neither is available. */
function variantName(variant: TypeRef, discriminator: string | undefined, base: string, index: number): string {
  if (typeof variant.meta.typeName === "string") return variant.meta.typeName
  if (discriminator !== undefined && variant.shape.kind === "object") {
    const fields = (variant.shape as TypeShape & { kind: "object" }).fields
    const tag = fields[discriminator]
    if (tag !== undefined && tag.shape.kind === "literal") {
      const value = (tag.shape as TypeShape & { kind: "literal" }).value
      if (typeof value === "string") return pascalCase(value)
    }
  }
  return `${base}Variant${index + 1}`
}

/** Discriminated (`meta.discriminator`) or plain union -> an abstract
 * `[DataContract]` base record plus one derived `[DataContract]` record per
 * variant. ServiceStack.Text has no declarative polymorphism attribute (see
 * module doc comment) — a comment documents the `JsConfig.IncludeTypeInfo`/
 * custom-`ITypeSerializer` wiring the caller's `JsConfig` setup still needs.
 * A variant that isn't itself an `object` shape (so has no fields to become
 * record properties) degrades to a single-property wrapper record around its
 * own rendered type, same as csharp-systemtextjson.ts. */
function emitUnionType(
  shape: TypeShape & { kind: "union" },
  meta: Readonly<Record<string, unknown>>,
  name: string,
  ctx: Ctx,
): string {
  const discriminator = typeof meta.discriminator === "string" ? meta.discriminator : undefined
  const names = shape.variants.map((variant, i) => variantName(variant, discriminator, name, i))

  const doc = `${xmlDocComment(meta)}${obsoleteAttr(meta)}`
  const commentLines = [
    "// ServiceStack.Text has no declarative polymorphism attribute. Enable",
    "// type info on the wire and register each subtype, e.g.:",
    "//",
    "//   JsConfig.IncludeTypeInfo = true;",
  ]
  if (discriminator !== undefined) {
    commentLines.push(`//   JsConfig.TypeAttr = ${quote(discriminator)};`)
  }
  for (const n of names) commentLines.push(`//   JsConfig<${n}>.ExcludeTypeInfo = false;`)
  ctx.decls.push(`${doc}${commentLines.join("\n")}\n[DataContract]\npublic abstract record ${name};`)

  shape.variants.forEach((variant, i) => {
    const vName = names[i]!
    if (variant.shape.kind === "object") {
      const fields = { ...(variant.shape as TypeShape & { kind: "object" }).fields }
      if (discriminator !== undefined) delete fields[discriminator]
      const props = Object.entries(fields).map(([fieldName, fieldRef]) => renderProperty(fieldName, fieldRef, vName, ctx))
      ctx.decls.push(`[DataContract]\npublic record ${vName} : ${name}\n{\n${props.join("\n\n")}\n}`)
    } else {
      const inner = typeExpr(variant, `${vName}Value`, ctx)
      ctx.decls.push(`[DataContract]\npublic record ${vName}([property: DataMember(Name = "value")] ${inner} Value) : ${name};`)
    }
  })

  return name
}

const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("double"),
  integer: leaf("int"),
  int8: leaf("sbyte"),
  int16: leaf("short"),
  int32: leaf("int"),
  int64: leaf("long"),
  uint8: leaf("byte"),
  uint16: leaf("ushort"),
  uint32: leaf("uint"),
  uint64: leaf("ulong"),
  float32: leaf("float"),
  float64: leaf("double"),
  string: leaf("string"),
  uuid: leaf("Guid"),
  uri: leaf("Uri"),
  email: leaf("string"),
  datetime: leaf("DateTimeOffset"),
  date: leaf("DateOnly"),
  time: leaf("TimeOnly"),
  duration: leaf("TimeSpan"),
  bytes: leaf("byte[]"),
  null: leaf("object?"),
  void: leaf("void"),
  unknown: leaf("object"),
  // No C# equivalent to `never` — degrades to `object`, flagged via comment
  // (stripped by `toCSharpServiceStack`'s alias fallback if `never` ever
  // surfaces at the document root, since `using X = object /* never */;`
  // isn't valid C#).
  never: leaf("object /* never */"),
  // Purely nominal (see type-ir's TypeKinds.instance doc comment) — the
  // caller assembling the generated file is responsible for the `using`
  // that brings `className` into scope.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, suggestedName, ctx) => {
    const s = shape as TypeShape & { kind: "array" }
    return `List<${typeExpr(s.element, `${suggestedName}Item`, ctx)}>`
  },
  tuple: (shape, suggestedName, ctx) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const elements = s.elements.map((e, i) => typeExpr(e, `${suggestedName}Item${i + 1}`, ctx))
    return `(${elements.join(", ")})`
  },
  // IAsyncEnumerable<T> (System.Collections.Generic) is C#'s native
  // asynchronously-produced sequence — the direct analogue of TS's
  // AsyncIterable<T> (see typescript.ts's `stream` handler).
  stream: (shape, suggestedName, ctx) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `IAsyncEnumerable<${typeExpr(s.element, `${suggestedName}Item`, ctx)}>`
  },
  // No native pagination vocabulary — degrades to List<T> of the page's
  // element type, same honest-degrade convention as other data-only
  // projectors (openapi30.ts, zod.ts, …).
  page: (shape, suggestedName, ctx) => {
    const s = shape as TypeShape & { kind: "page" }
    return `List<${typeExpr(s.element, `${suggestedName}Item`, ctx)}>`
  },
  map: (shape, suggestedName, ctx) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = typeExpr(s.key, `${suggestedName}Key`, ctx)
    const value = typeExpr(s.value, `${suggestedName}Value`, ctx)
    return `Dictionary<${key}, ${value}>`
  },
  // C# has no literal types outside `enum`/`const` — degrades to the
  // underlying primitive (same "closest structural analogue" convention as
  // stream/page's array degrade above).
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return "string"
    if (typeof s.value === "boolean") return "bool"
    if (typeof s.value === "number") return Number.isInteger(s.value) ? "int" : "double"
    return "object?"
  },
  // Assumes the target is declared elsewhere in the emitted file/assembly —
  // same convention as typescript.ts's `ref` handler.
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // C# has no structural intersection type — merges every `object` member's
  // fields into a single record (non-object members contribute nothing,
  // since there's no field surface to merge).
  intersection: (shape, suggestedName, ctx) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const fields: Record<string, TypeRef> = {}
    for (const member of s.members) {
      if (member.shape.kind === "object") {
        Object.assign(fields, (member.shape as TypeShape & { kind: "object" }).fields)
      }
    }
    return emitObjectType({ kind: "object", fields }, suggestedName, ctx)
  },
  // Callables have no data-record equivalent — degrade honestly (see `never`
  // above for the same comment-then-strip convention).
  function: leaf("object /* function */"),
  method: leaf("object /* method */"),
  interface: leaf("object /* interface */"),
}

function typeExpr(ref: TypeRef, suggestedName: string, ctx: Ctx): string {
  const { shape, meta } = ref
  const kind = shape.kind

  let type: string
  if (isA(kind, "object")) {
    type = emitObjectType(shape as TypeShape & { kind: "object" }, suggestedName, ctx, meta)
  } else if (isA(kind, "enum")) {
    type = emitEnumType(shape as TypeShape & { kind: "enum" }, suggestedName, ctx, meta)
  } else if (isA(kind, "union")) {
    type = emitUnionType(shape as TypeShape & { kind: "union" }, meta, suggestedName, ctx)
  } else {
    const converter = resolve(kind, handlers)
    type = converter === undefined ? "object" : converter(shape, suggestedName, ctx)
  }

  if (meta.nullable === true && !type.endsWith("?")) type += "?"
  return type
}

/** Kinds that produce their own named declaration (record/enum/abstract
 * record hierarchy) when they appear at the document root — everything else
 * falls back to a C# `using` alias directive (see `toCSharpServiceStack`). */
function isDeclarationKind(kind: string): boolean {
  return isA(kind, "object") || isA(kind, "enum") || isA(kind, "union") || kind === "intersection"
}

export interface CSharpServiceStackOptions {
  /** Wraps every declaration in `namespace {namespace} { ... }`. */
  readonly namespace?: string
}

/**
 * Render a TypeRef as a standalone C# source file: a `using`-alias for a
 * primitive/collection root, or a full `[DataContract]` record/enum/abstract
 * record hierarchy declaration for an object/enum/union root — plus every
 * nested type discovered along the way (nested object fields, union
 * variants, …), each becoming its own named declaration since C# has no
 * anonymous structural object type to inline them into. Uses
 * ServiceStack.Text's `[DataContract]`/`[DataMember]` attributes rather than
 * System.Text.Json — see csharp-systemtextjson.ts for the STJ sibling.
 */
export function toCSharpServiceStack(ref: TypeRef, name = "Root", options?: CSharpServiceStackOptions): string {
  const ctx: Ctx = { decls: [] }

  if (isDeclarationKind(ref.shape.kind)) {
    typeExpr(ref, name, ctx)
  } else {
    const type = typeExpr(ref, name, ctx)
    // Strip any degrade comment (`/* never */`, `/* interface */`, …) — valid
    // inside a property/field type position, not inside a `using` alias.
    const clean = type.replace(/\s*\/\*.*?\*\/\s*/g, " ").trim()
    ctx.decls.push(`using ${name} = ${clean};`)
  }

  const body = ctx.decls.join("\n\n")
  const usings: string[] = []
  if (/\bList<|\bDictionary<|IAsyncEnumerable</.test(body)) usings.push("using System.Collections.Generic;")
  if (/\bGuid\b|\bUri\b|\bDateTimeOffset\b|\bDateOnly\b|\bTimeOnly\b|\bTimeSpan\b/.test(body)) {
    usings.push("using System;")
  }
  if (/\[DataContract\]|\[DataMember\(|\[property: DataMember/.test(body)) {
    usings.push("using System.Runtime.Serialization;")
  }

  const withNamespace =
    options?.namespace === undefined ? body : `namespace ${options.namespace}\n{\n${indent(body)}\n}`

  return usings.length === 0 ? `${withNamespace}\n` : `${usings.join("\n")}\n\n${withNamespace}\n`
}
