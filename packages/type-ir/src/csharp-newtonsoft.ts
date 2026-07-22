// C# (9+) projector. Emits idiomatic C# record/enum declarations with
// Newtonsoft.Json (Json.NET) attributes for serialization — a sibling of
// csharp-systemtextjson.ts for the target still most widely deployed in
// production C# codebases (ASP.NET Core defaulted to STJ only from .NET
// Core 3.0 onward; a large body of existing services — and every consumer
// that needs Json.NET-only features like `TypeNameHandling`,
// `ContractResolver`, or `[JsonExtensionData]` — stays on Newtonsoft).
// Same three-layer architecture (handler record, context object, single
// entry point) as csharp-systemtextjson.ts; only the attribute vocabulary
// and the polymorphism strategy differ, since Newtonsoft has no built-in
// `[JsonPolymorphic]`/`[JsonDerivedType]` equivalent (see emitUnionType
// below for the custom-converter fallback this drives).
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

// Render a `meta.default` value (JSON-ish: string/number/boolean/null/array/
// object) as a C# literal, for `[DefaultValue(...)]`. Mirrors
// python-pydantic.ts's `pythonLiteral` but targets C# literal syntax.
function csharpLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return quote(value)
  if (Array.isArray(value)) return `new object[] { ${value.map(csharpLiteral).join(", ")} }`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    return `new Dictionary<string, object> { ${entries.map(([k, v]) => `{ ${quote(k)}, ${csharpLiteral(v)} }`).join(", ")} }`
  }
  return "null"
}

type Converter = (shape: TypeShape, suggestedName: string, ctx: Ctx) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

function emitObjectType(shape: TypeShape & { kind: "object" }, name: string, ctx: Ctx): string {
  const props = Object.entries(shape.fields).map(([fieldName, fieldRef]) =>
    renderProperty(fieldName, fieldRef, name, ctx),
  )
  ctx.decls.push(`public record ${name}\n{\n${props.join("\n\n")}\n}`)
  return name
}

/** Builds one property's `[JsonProperty(...)]` attribute + declaration.
 * Optional fields get `NullValueHandling = NullValueHandling.Ignore` (skip
 * the property entirely on serialize when absent/null, and don't require it
 * on deserialize); a `meta.default` additionally gets a `[DefaultValue]`
 * companion attribute plus `DefaultValueHandling = DefaultValueHandling.Populate`
 * (Newtonsoft substitutes the default when the incoming JSON omits the
 * property, mirroring STJ's implicit missing-property behavior explicitly). */
function renderProperty(fieldName: string, fieldRef: TypeRef, ownerName: string, ctx: Ctx): string {
  const propName = pascalCase(fieldName)
  const optional = fieldRef.meta.optional === true
  let type = typeExpr(fieldRef, `${ownerName}${propName}`, ctx)
  if (optional && !type.endsWith("?")) type += "?"

  const jsonPropertyArgs = [quote(fieldName)]
  const hasDefault = fieldRef.meta.default !== undefined
  if (hasDefault) {
    jsonPropertyArgs.push("DefaultValueHandling = DefaultValueHandling.Populate")
  } else if (optional) {
    jsonPropertyArgs.push("NullValueHandling = NullValueHandling.Ignore")
  }

  const attrs: string[] = []
  if (hasDefault) attrs.push(`    [DefaultValue(${csharpLiteral(fieldRef.meta.default)})]`)
  attrs.push(`    [JsonProperty(${jsonPropertyArgs.join(", ")})]`)

  return `${attrs.join("\n")}\n    public ${type} ${propName} { get; init; }`
}

function emitEnumType(shape: TypeShape & { kind: "enum" }, name: string, ctx: Ctx): string {
  const members = shape.members.map((m) => `    ${pascalCase(m)}`)
  ctx.decls.push(`[JsonConverter(typeof(StringEnumConverter))]\npublic enum ${name}\n{\n${members.join(",\n")}\n}`)
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

/** Discriminated (`meta.discriminator`) or plain union -> an abstract base
 * record plus one derived record per variant. Newtonsoft has no built-in
 * polymorphism attribute equivalent to STJ's `[JsonPolymorphic]`/
 * `[JsonDerivedType]` — the practical Json.NET idiom (see e.g.
 * https://www.newtonsoft.com/json/help/html/SerializeTypeNameHandling.htm
 * for the built-in `$type`-based alternative, which leaks .NET assembly
 * identity into the wire format and is avoided here) is a custom
 * `JsonConverter<T>` that reads/writes through a `JObject`, switching on the
 * discriminator's literal value when one is known, or otherwise trying each
 * variant's shape in declaration order. `[JsonConverter(typeof(...))]` wires
 * the converter onto the base record so callers don't have to register it
 * themselves. A variant that isn't itself an `object` shape (so has no
 * fields to become record properties) degrades to a single-property wrapper
 * record around its own rendered type, same as csharp-systemtextjson.ts. */
function emitUnionType(
  shape: TypeShape & { kind: "union" },
  meta: Readonly<Record<string, unknown>>,
  name: string,
  ctx: Ctx,
): string {
  const discriminator = typeof meta.discriminator === "string" ? meta.discriminator : undefined
  const names = shape.variants.map((variant, i) => variantName(variant, discriminator, name, i))
  const converterName = `${name}JsonConverter`

  ctx.decls.push(`[JsonConverter(typeof(${converterName}))]\npublic abstract record ${name};`)

  shape.variants.forEach((variant, i) => {
    const vName = names[i]!
    if (variant.shape.kind === "object") {
      const fields = { ...(variant.shape as TypeShape & { kind: "object" }).fields }
      if (discriminator !== undefined) delete fields[discriminator]
      const props = Object.entries(fields).map(([fieldName, fieldRef]) => renderProperty(fieldName, fieldRef, vName, ctx))
      ctx.decls.push(`public record ${vName} : ${name}\n{\n${props.join("\n\n")}\n}`)
    } else {
      const inner = typeExpr(variant, `${vName}Value`, ctx)
      ctx.decls.push(`public record ${vName}(${inner} Value) : ${name};`)
    }
  })

  const readBody =
    discriminator !== undefined
      ? [
          `        var discriminator = jObject[${quote(discriminator)}]?.Value<string>();`,
          "        return discriminator switch",
          "        {",
          ...shape.variants.map((variant, i) => {
            const vName = names[i]!
            const tagValue =
              variant.shape.kind === "object"
                ? (variant.shape as TypeShape & { kind: "object" }).fields[discriminator]
                : undefined
            const literalValue =
              tagValue !== undefined && tagValue.shape.kind === "literal"
                ? (tagValue.shape as TypeShape & { kind: "literal" }).value
                : undefined
            const tag = typeof literalValue === "string" ? quote(literalValue) : quote(vName)
            return `            ${tag} => jObject.ToObject<${vName}>(serializer),`
          }),
          `            _ => throw new JsonSerializationException($"Unknown ${quote(discriminator)} discriminator: {discriminator}"),`,
          "        };",
        ].join("\n")
      : [
          // No discriminator field — attempt each variant in declaration
          // order, trusting the first one whose shape deserializes cleanly.
          ...names.map(
            (vName) =>
              `        try { return jObject.ToObject<${vName}>(serializer); } catch (JsonException) { }`,
          ),
          `        throw new JsonSerializationException("No ${name} variant matched the given JSON");`,
        ].join("\n")

  ctx.decls.push(
    [
      `public class ${converterName} : JsonConverter<${name}>`,
      "{",
      `    public override void WriteJson(JsonWriter writer, ${name}? value, JsonSerializer serializer)`,
      "    {",
      "        serializer.Serialize(writer, value, value?.GetType());",
      "    }",
      "",
      `    public override ${name}? ReadJson(JsonReader reader, Type objectType, ${name}? existingValue, bool hasExistingValue, JsonSerializer serializer)`,
      "    {",
      "        var jObject = JObject.Load(reader);",
      readBody,
      "    }",
      "}",
    ].join("\n"),
  )

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
  // (stripped by `toCSharpNewtonsoft`'s alias fallback if `never` ever
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
    type = emitObjectType(shape as TypeShape & { kind: "object" }, suggestedName, ctx)
  } else if (isA(kind, "enum")) {
    type = emitEnumType(shape as TypeShape & { kind: "enum" }, suggestedName, ctx)
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
 * falls back to a C# `using` alias directive (see `toCSharpNewtonsoft`). */
function isDeclarationKind(kind: string): boolean {
  return isA(kind, "object") || isA(kind, "enum") || isA(kind, "union") || kind === "intersection"
}

export interface CSharpOptions {
  /** Wraps every declaration in `namespace {namespace} { ... }`. */
  readonly namespace?: string
}

/**
 * Render a TypeRef as a standalone C# source file: a `using`-alias for a
 * primitive/collection root, or a full record/enum/custom-converter
 * hierarchy declaration for an object/enum/union root — plus every nested
 * type discovered along the way (nested object fields, union variants, …),
 * each becoming its own named declaration since C# has no anonymous
 * structural object type to inline them into. Uses Newtonsoft.Json
 * (`[JsonProperty]`, `StringEnumConverter`, a hand-rolled `JsonConverter<T>`
 * for polymorphism) rather than System.Text.Json — see
 * csharp-systemtextjson.ts's `toCSharp` for the STJ sibling.
 */
export function toCSharpNewtonsoft(ref: TypeRef, name = "Root", options?: CSharpOptions): string {
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
  if (/\bGuid\b|\bUri\b|\bDateTimeOffset\b|\bDateOnly\b|\bTimeOnly\b|\bTimeSpan\b|\bType\b/.test(body)) {
    usings.push("using System;")
  }
  if (/\[DefaultValue\(/.test(body)) usings.push("using System.ComponentModel;")
  if (/\bJson[A-Za-z]*\(|\[JsonConverter|JsonSerializationException|JsonException/.test(body)) {
    usings.push("using Newtonsoft.Json;")
  }
  if (/StringEnumConverter/.test(body)) usings.push("using Newtonsoft.Json.Converters;")
  if (/\bJObject\b/.test(body)) usings.push("using Newtonsoft.Json.Linq;")

  const withNamespace =
    options?.namespace === undefined ? body : `namespace ${options.namespace}\n{\n${indent(body)}\n}`

  return usings.length === 0 ? `${withNamespace}\n` : `${usings.join("\n")}\n\n${withNamespace}\n`
}
