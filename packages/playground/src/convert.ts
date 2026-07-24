// Conversion bridge — parses input text with the selected ingestor, produces
// a canonical `TypeRefDocument`, and renders it with the selected projector.
//
// Canonical intermediate: every ingestor's output is normalized to
// `{ root: TypeRef; defs: Record<string, TypeRef> }` (see
// `@rhi-zone/fractal-type-ir`'s `TypeRefDocument`). Ingestors that produce a
// single `TypeRef` (JSON Schema, JSON instance, OpenAPI, …) become a
// `defs`-less document. Ingestors that produce a *named registry* with no
// distinguished root (GraphQL SDL, SQL DDL, CQL, Cap'n Proto, FlatBuffers —
// each can declare several sibling top-level types) are normalized by
// picking the first declared name as `root` and keeping the full registry in
// `defs`, matching every projector below that accepts a `TypeRefDocument` or
// a registry directly.
//
// Every projector call below reads the *actual* exported function signature
// from packages/type-ir/src/*.ts — see the read-through in the session that
// produced this file. Two irregularities to note:
//   - Argument order is NOT uniform: most `toX(ref, name?)` put `ref` first,
//     but a handful of "build a named declaration" functions — `toGraphQLType`,
//     `toCapnpStruct`, `toProtoMessage`, `toFlatBuffersTable`,
//     `toCreateTable`, `toMssqlCreateTableFromRef`, every `toXDeclaration`
//     (zod/typebox/io-ts/yup/effect-schema/valibot/runtypes/superstruct/
//     arktype/typescript-native/jsdoc) — put `name` first.
//   - Some projectors return a plain object, not a string (JTD, every JSON
//     Schema variant, OpenAPI 3.0/2.0) — those are JSON.stringify'd for
//     display.
import type { TypeRef, TypeRefDocument } from "@rhi-zone/fractal-type-ir"
import { typeRefDocument } from "@rhi-zone/fractal-type-ir"

import { fromJsonSchema } from "@rhi-zone/fractal-type-ir/from-json-schema"
import { fromJson } from "@rhi-zone/fractal-type-ir/from-json"
import { fromJsonCorpus } from "@rhi-zone/fractal-type-ir/from-json-corpus"
import { fromJtdDocument } from "@rhi-zone/fractal-type-ir/from-jtd"
import { fromGraphql } from "@rhi-zone/fractal-type-ir/from-graphql"
import { fromSql } from "@rhi-zone/fractal-type-ir/from-sql"
import { fromCql } from "@rhi-zone/fractal-type-ir/from-cql"
import { fromElasticsearch } from "@rhi-zone/fractal-type-ir/from-elasticsearch"
import { fromOpenApi30, fromOpenApi20 } from "@rhi-zone/fractal-type-ir/from-openapi"
import { fromStandardSchema } from "@rhi-zone/fractal-type-ir/from-standard-schema"
import { fromCapnp } from "@rhi-zone/fractal-type-ir/from-capnp"
import { fromFlatbuffers } from "@rhi-zone/fractal-type-ir/from-flatbuffers"

import { toTypeDeclaration, toTypeDeclarations } from "@rhi-zone/fractal-type-ir/typescript-native"
import { toZodDeclaration, toZodDeclarations } from "@rhi-zone/fractal-type-ir/typescript-zod"
import { toTypeBoxDeclaration, toTypeBoxDeclarations } from "@rhi-zone/fractal-type-ir/typescript-typebox"
import { toIoTsDeclaration, toIoTsDeclarations } from "@rhi-zone/fractal-type-ir/typescript-io-ts"
import { toYupDeclaration, toYupDeclarations } from "@rhi-zone/fractal-type-ir/typescript-yup"
import { toEffectSchemaDeclaration, toEffectSchemaDeclarations } from "@rhi-zone/fractal-type-ir/typescript-effect-schema"
import { toValibotDeclaration, toValibotDeclarations } from "@rhi-zone/fractal-type-ir/typescript-valibot"
import { toRuntypesDeclaration, toRuntypesDeclarations } from "@rhi-zone/fractal-type-ir/typescript-runtypes"
import { toSuperstructDeclaration, toSuperstructDeclarations } from "@rhi-zone/fractal-type-ir/typescript-superstruct"
import { toArkTypeDeclaration, toArkTypeDeclarations } from "@rhi-zone/fractal-type-ir/typescript-arktype"
import { toJsDocTypedef, toJsDocTypedefs } from "@rhi-zone/fractal-type-ir/jsdoc"

import { toPython } from "@rhi-zone/fractal-type-ir/python"
import { toPydantic } from "@rhi-zone/fractal-type-ir/python-pydantic"
import { toAttrs } from "@rhi-zone/fractal-type-ir/python-attrs"
import { toGo } from "@rhi-zone/fractal-type-ir/go"
import { toJavaDeclaration as toJavaJacksonDeclaration } from "@rhi-zone/fractal-type-ir/java"
import { toGsonDeclaration } from "@rhi-zone/fractal-type-ir/java-gson"
import { toMoshiDeclaration } from "@rhi-zone/fractal-type-ir/java-moshi"
import { toRust } from "@rhi-zone/fractal-type-ir/rust"
import { toSwift } from "@rhi-zone/fractal-type-ir/swift"
import { toCSharp } from "@rhi-zone/fractal-type-ir/csharp"
import { toCSharpNewtonsoft } from "@rhi-zone/fractal-type-ir/csharp-newtonsoft"
import { toKotlin, toKotlinDeclarations } from "@rhi-zone/fractal-type-ir/kotlin"
import { toDart } from "@rhi-zone/fractal-type-ir/dart"
import { toFreezed } from "@rhi-zone/fractal-type-ir/dart-freezed"
import { toObjC } from "@rhi-zone/fractal-type-ir/objc"
import { toCpp } from "@rhi-zone/fractal-type-ir/cpp"
import { toCrystal, toCrystalDeclarations } from "@rhi-zone/fractal-type-ir/crystal"
import { toPhp } from "@rhi-zone/fractal-type-ir/php"
import { toRuby } from "@rhi-zone/fractal-type-ir/ruby"
import { toFlow } from "@rhi-zone/fractal-type-ir/flow"
import { toElm } from "@rhi-zone/fractal-type-ir/elm"
import { toHaskell, toHaskellModule } from "@rhi-zone/fractal-type-ir/haskell"

import { toGraphQLType, toGraphQLTypes } from "@rhi-zone/fractal-type-ir/graphql"
import { toCreateTable } from "@rhi-zone/fractal-type-ir/sql"
import { toMssqlCreateTableFromRef } from "@rhi-zone/fractal-type-ir/sql-mssql"
import { toProtoMessage, renderProto } from "@rhi-zone/fractal-type-ir/protobuf"
import { toCapnpStruct, renderCapnp } from "@rhi-zone/fractal-type-ir/capnp"
import { toFlatBuffersTable, toFlatBuffersDeclarations } from "@rhi-zone/fractal-type-ir/flatbuffers"
import { toJtd } from "@rhi-zone/fractal-type-ir/jtd"
import { toJsonSchemaDocument } from "@rhi-zone/fractal-type-ir/json-schema"
import { toJsonSchema07 } from "@rhi-zone/fractal-type-ir/json-schema-07"
import { toJsonSchema04Document } from "@rhi-zone/fractal-type-ir/json-schema-04"
import { toOpenApi30Document } from "@rhi-zone/fractal-type-ir/openapi30"
import { toOpenApi20, toOpenApi20Definitions } from "@rhi-zone/fractal-type-ir/openapi20"

const DEFAULT_NAME = "GeneratedType"

// ---------------------------------------------------------------------------
// Ingest: input format id + raw text -> TypeRefDocument
// ---------------------------------------------------------------------------

function fromRegistry(registry: Record<string, TypeRef>): TypeRefDocument {
  const names = Object.keys(registry)
  if (names.length === 0) {
    throw new Error("ingestor produced no named types")
  }
  return typeRefDocument(registry[names[0]!]!, registry)
}

export function ingest(formatId: string, source: string): TypeRefDocument {
  switch (formatId) {
    case "json-schema":
      return typeRefDocument(fromJsonSchema(JSON.parse(source)))
    case "json":
      return typeRefDocument(fromJson(JSON.parse(source)))
    case "json-corpus":
      return typeRefDocument(fromJsonCorpus(JSON.parse(source)))
    case "jtd":
      return fromJtdDocument(JSON.parse(source))
    case "graphql":
      return fromRegistry(fromGraphql(source))
    case "sql":
      return fromRegistry(fromSql(source))
    case "cql":
      return fromRegistry(fromCql(source))
    case "elasticsearch":
      return typeRefDocument(fromElasticsearch(JSON.parse(source)))
    case "openapi30":
      return typeRefDocument(fromOpenApi30(JSON.parse(source)))
    case "openapi20":
      return typeRefDocument(fromOpenApi20(JSON.parse(source)))
    case "standard-schema": {
      // See formats.ts's standardSchemaSample comment: the playground can't
      // safely eval arbitrary vendor schema code, so the input is a small
      // JSON envelope naming the vendor plus either a JSON Schema export (the
      // StandardJSONSchemaV1 fast path) or a runtime sample value (the
      // fromJson fallback path) — this mock reconstructs exactly the
      // `~standard` shape fromStandardSchema expects.
      const envelope = JSON.parse(source) as {
        vendor?: string
        jsonSchema?: Record<string, unknown>
        sample?: unknown
      }
      const vendor = envelope.vendor ?? "unknown"
      if (envelope.jsonSchema !== undefined) {
        const jsonSchema = envelope.jsonSchema
        return typeRefDocument(
          fromStandardSchema({
            "~standard": {
              version: 1,
              vendor,
              validate: (value: unknown) => ({ value }),
              jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
            },
          } as Parameters<typeof fromStandardSchema>[0]),
        )
      }
      return typeRefDocument(
        fromStandardSchema({
          "~standard": {
            version: 1,
            vendor,
            validate: (value: unknown) => ({ value }),
            types: envelope.sample === undefined ? undefined : { input: envelope.sample, output: envelope.sample },
          },
        } as Parameters<typeof fromStandardSchema>[0]),
      )
    }
    case "capnp":
      return fromRegistry(fromCapnp(source))
    case "flatbuffers":
      return fromRegistry(fromFlatbuffers(source))
    default:
      throw new Error(`unknown input format: ${formatId}`)
  }
}

// ---------------------------------------------------------------------------
// Project: output format id + TypeRefDocument -> rendered text
// ---------------------------------------------------------------------------

const jsonOut = (value: unknown): string => JSON.stringify(value, null, 2)

/** True when the document actually carries more than one named type — the
 * discriminator for whether an output projector should render a single
 * declaration (root only) or a full multi-declaration module/registry. */
function isMulti(doc: TypeRefDocument): boolean {
  return Object.keys(doc.defs).length > 0
}

/** `toX(ref, name?)` family — ref first, optional name, single declaration
 * per call. Multi-def documents render one declaration per registry entry,
 * separated by a header comment naming each type. */
function viaRefFirst(fn: (ref: TypeRef, name?: string) => string): (doc: TypeRefDocument) => string {
  return (doc) => {
    if (!isMulti(doc)) return fn(doc.root, DEFAULT_NAME)
    return Object.entries(doc.defs)
      .map(([name, ref]) => `/* ===== ${name} ===== */\n${fn(ref, name)}`)
      .join("\n\n")
  }
}

/** `toXDeclaration(name, ref)` / `toXDeclarations(registry)` family — name
 * first for the single form; the plural form takes the registry directly. */
function viaNameFirst(
  single: (name: string, ref: TypeRef) => string,
  plural: (registry: Record<string, TypeRef>) => string,
): (doc: TypeRefDocument) => string {
  return (doc) => (isMulti(doc) ? plural(doc.defs) : single(DEFAULT_NAME, doc.root))
}

/** Like `viaNameFirst`, but the projector has no plural/registry form — the
 * multi-def case falls back to one declaration per entry, same as
 * `viaRefFirst`. */
function viaNameFirstOnly(single: (name: string, ref: TypeRef) => string): (doc: TypeRefDocument) => string {
  return (doc) => {
    if (!isMulti(doc)) return single(DEFAULT_NAME, doc.root)
    return Object.entries(doc.defs)
      .map(([name, ref]) => single(name, ref))
      .join("\n\n")
  }
}

const projectors: Record<string, (doc: TypeRefDocument) => string> = {
  typescript: viaNameFirst(toTypeDeclaration, toTypeDeclarations),
  zod: viaNameFirst(toZodDeclaration, toZodDeclarations),
  typebox: viaNameFirst(toTypeBoxDeclaration, toTypeBoxDeclarations),
  "io-ts": viaNameFirst(toIoTsDeclaration, toIoTsDeclarations),
  yup: viaNameFirst(toYupDeclaration, toYupDeclarations),
  "effect-schema": viaNameFirst(toEffectSchemaDeclaration, toEffectSchemaDeclarations),
  valibot: viaNameFirst(toValibotDeclaration, toValibotDeclarations),
  runtypes: viaNameFirst(toRuntypesDeclaration, toRuntypesDeclarations),
  superstruct: viaNameFirst(toSuperstructDeclaration, toSuperstructDeclarations),
  arktype: viaNameFirst(toArkTypeDeclaration, toArkTypeDeclarations),
  jsdoc: viaNameFirst(
    (name, ref) => toJsDocTypedef(name, ref),
    (registry) => toJsDocTypedefs(registry),
  ),

  "python-dataclass": viaRefFirst(toPython),
  "python-pydantic": viaRefFirst(toPydantic),
  "python-attrs": viaRefFirst(toAttrs),
  go: viaRefFirst(toGo),
  "java-jackson": viaNameFirstOnly((name, ref) => toJavaJacksonDeclaration(name, ref)),
  "java-gson": viaNameFirstOnly((name, ref) => toGsonDeclaration(name, ref)),
  "java-moshi": viaNameFirstOnly((name, ref) => toMoshiDeclaration(name, ref)),
  rust: viaRefFirst(toRust),
  swift: viaRefFirst(toSwift),
  "csharp-systemtextjson": viaRefFirst(toCSharp),
  "csharp-newtonsoft": viaRefFirst(toCSharpNewtonsoft),
  kotlin: viaNameFirst(
    (name, ref) => toKotlin(ref, name),
    toKotlinDeclarations,
  ),
  "dart-json-serializable": viaRefFirst(toDart),
  "dart-freezed": viaRefFirst(toFreezed),
  objc: (doc) => {
    const render = (name: string, ref: TypeRef): string => {
      const { header, implementation } = toObjC(ref, name)
      return implementation.trim().length === 0 ? header : `${header}\n\n${implementation}`
    }
    if (!isMulti(doc)) return render(DEFAULT_NAME, doc.root)
    return Object.entries(doc.defs)
      .map(([name, ref]) => render(name, ref))
      .join("\n\n")
  },
  cpp: viaRefFirst(toCpp),
  crystal: viaNameFirst(
    (name, ref) => toCrystal(ref, name),
    toCrystalDeclarations,
  ),
  php: viaRefFirst(toPhp),
  "ruby-sorbet": viaRefFirst(toRuby),
  flow: viaRefFirst(toFlow),
  elm: viaRefFirst(toElm),
  haskell: viaNameFirst(
    (name, ref) => toHaskell(ref, name),
    (registry) => toHaskellModule("Generated", registry),
  ),

  graphql: viaNameFirst(toGraphQLType, toGraphQLTypes),
  sql: viaNameFirstOnly((name, ref) => toCreateTable(toSnakeCase(name), ref)),
  "sql-mssql": viaNameFirstOnly((name, ref) => toMssqlCreateTableFromRef(toSnakeCase(name), ref)),
  protobuf: (doc) => {
    if (!isMulti(doc)) return renderProto([toProtoMessage(DEFAULT_NAME, doc.root)])
    return renderProto(Object.entries(doc.defs).map(([name, ref]) => toProtoMessage(name, ref)))
  },
  capnp: (doc) => {
    if (!isMulti(doc)) return renderCapnp([toCapnpStruct(DEFAULT_NAME, doc.root)])
    return renderCapnp(Object.entries(doc.defs).map(([name, ref]) => toCapnpStruct(name, ref)))
  },
  flatbuffers: viaNameFirst(toFlatBuffersTable, toFlatBuffersDeclarations),

  jtd: (doc) => jsonOut(toJtd(doc.root)),
  "json-schema": (doc) => jsonOut(toJsonSchemaDocument(doc)),
  "json-schema-07": (doc) => jsonOut(toJsonSchema07(doc.root)),
  "json-schema-04": (doc) => jsonOut(toJsonSchema04Document(doc.root, isMulti(doc) ? { definitions: doc.defs } : {})),
  openapi30: (doc) => jsonOut(toOpenApi30Document(doc)),
  openapi20: (doc) => jsonOut(isMulti(doc) ? toOpenApi20Definitions(doc.defs) : toOpenApi20(doc.root)),
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase()
}

export function project(formatId: string, doc: TypeRefDocument): string {
  const projector = projectors[formatId]
  if (projector === undefined) throw new Error(`unknown output format: ${formatId}`)
  return projector(doc)
}

/** Ingest `source` with `inputFormatId`, then project the result with
 * `outputFormatId`. Throws on any failure — callers display the message
 * inline rather than treating a bad conversion as a silent no-op. */
export function convert(inputFormatId: string, outputFormatId: string, source: string): string {
  const doc = ingest(inputFormatId, source)
  return project(outputFormatId, doc)
}
