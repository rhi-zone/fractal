// The base importer/projector registry — entries as data, over the generic
// mechanism in `./registry-core`.
//
// Every ingester and every projection target in this package is reachable
// through one table here, keyed by a stable string id. Nothing in this module
// touches the DOM, the filesystem, or `typescript` — callers hand in source
// text and get back a `TypeRefDocument`, then hand that to a projector and get
// back a `Projection`. That makes the same registry usable from a browser
// playground, a CLI, or a test.
//
// The `typescript`-backed importers (`from-typescript`,
// `from-standard-schema-type`) are NOT registered here, because they need a
// `ts.Program` plus a symbol name rather than text, and because `typescript`
// is an OPTIONAL peer dependency that must not be forced on consumers who
// never ask for it. They ship as their own `Registry` in
// `./registry-typescript`, built with the same `defineRegistry`, and a caller
// who wants both merges them:
//
//     const importers = mergeRegistries<Importer | TypeScriptImporter>(
//       importerRegistry,
//       typescriptImporterRegistry,
//     )
//
// After that there is one id space, one lookup, and one error path. The
// entries' `input` tag is a discriminated-union discriminator, so narrowing on
// it recovers each entry's real `run` signature statically — unification costs
// no type safety, and the isolation holds because the union type only exists
// in code that imported both halves.
//
// Two irregularities in the projector surface are absorbed by the adapters
// below rather than papered over:
//   - Argument order is NOT uniform. Most `toX(ref, name?)` put `ref` first,
//     but the "build a named declaration" family — `toGraphQLType`,
//     `toCapnpStruct`, `toProtoMessage`, `toFlatBuffersTable`,
//     `toCreateTable`, `toMssqlCreateTableFromRef`, every `toXDeclaration` —
//     puts `name` first. Wiring one as the other silently produces garbage,
//     so each entry names its adapter explicitly.
//   - Output cardinality is not uniform either. Most projectors render a
//     string, the schema family returns a plain JSON value, the reference-doc
//     family returns a path -> content map, and Objective-C returns a
//     header/implementation pair. `Projection` is a discriminated union over
//     exactly those cases instead of forcing everything through `string`.
import type { TypeRef, TypeRefDocument } from "./index.ts"
import { typeRefDocument } from "./index.ts"
import type { Registry, RegistryEntry } from "./registry-core.ts"
import { defineRegistry, lookup } from "./registry-core.ts"

import { fromJsonSchema } from "./from-json-schema.ts"
import { fromJsonCorpus } from "./from-json-corpus.ts"
import { fromJtdDocument } from "./from-jtd.ts"
import { fromGraphql } from "./from-graphql.ts"
import { fromSql } from "./from-sql.ts"
import { fromCql } from "./from-cql.ts"
import { fromElasticsearch } from "./from-elasticsearch.ts"
import { fromOpenApi30, fromOpenApi20 } from "./from-openapi.ts"
import { fromCapnp } from "./from-capnp.ts"
import { fromFlatbuffers } from "./from-flatbuffers.ts"
import { fromFlow } from "./from-flow.ts"
import { fromProtoText } from "./from-protobuf.ts"
import { fromStandardSchema } from "./from-standard-schema.ts"

import { toTypeDeclaration, toTypeDeclarations } from "./typescript-native.ts"
import { toZodDeclaration, toZodDeclarations } from "./typescript-zod.ts"
import { toTypeBoxDeclaration, toTypeBoxDeclarations } from "./typescript-typebox.ts"
import { toIoTsDeclaration, toIoTsDeclarations } from "./typescript-io-ts.ts"
import { toYupDeclaration, toYupDeclarations } from "./typescript-yup.ts"
import { toEffectSchemaDeclaration, toEffectSchemaDeclarations } from "./typescript-effect-schema.ts"
import { toValibotDeclaration, toValibotDeclarations } from "./typescript-valibot.ts"
import { toRuntypesDeclaration, toRuntypesDeclarations } from "./typescript-runtypes.ts"
import { toSuperstructDeclaration, toSuperstructDeclarations } from "./typescript-superstruct.ts"
import { toArkTypeDeclaration, toArkTypeDeclarations } from "./typescript-arktype.ts"
import { toJsDocTypedef, toJsDocTypedefs } from "./jsdoc.ts"

import { toPython } from "./python-dataclass.ts"
import { toPydantic } from "./python-pydantic.ts"
import { toAttrs } from "./python-attrs.ts"
import { toMsgspec } from "./python-msgspec.ts"
import { toCattrs } from "./python-cattrs.ts"

import { toGo } from "./go-encoding-json.ts"
import { toEasyjson } from "./go-easyjson.ts"
import { toJsoniter } from "./go-jsoniter.ts"
import { toSonic } from "./go-sonic.ts"

import { toJavaDeclaration } from "./java-jackson.ts"
import { toGsonDeclaration } from "./java-gson.ts"
import { toMoshiDeclaration } from "./java-moshi.ts"
import { toJsonbDeclaration } from "./java-jsonb.ts"

import { toKotlin, toKotlinDeclarations } from "./kotlin-kotlinx.ts"
import { toKotlin as toKotlinJackson, toKotlinDeclarations as toKotlinJacksonDeclarations } from "./kotlin-jackson.ts"
import { toKotlinGson, toKotlinGsonDeclarations } from "./kotlin-gson.ts"

import { toRust } from "./rust-serde.ts"
import { toSwift } from "./swift-codable.ts"
import { toSwiftyJSON } from "./swift-swiftyjson.ts"
import { toObjectMapper } from "./swift-objectmapper.ts"

import { toCSharp } from "./csharp-systemtextjson.ts"
import { toCSharpNewtonsoft } from "./csharp-newtonsoft.ts"
import { toCSharpServiceStack } from "./csharp-servicestack.ts"

import { toDart } from "./dart-json-serializable.ts"
import { toFreezed } from "./dart-freezed.ts"
import { toBuiltValue } from "./dart-built-value.ts"

import { toCpp } from "./cpp-nlohmann.ts"
import { toRapidjson } from "./cpp-rapidjson.ts"
import { toSimdjson } from "./cpp-simdjson.ts"
import { toBoostJson } from "./cpp-boost-json.ts"
import { toGlaze } from "./cpp-glaze.ts"

import { toCrystal, toCrystalDeclarations } from "./crystal-json-serializable.ts"
import { toElixir } from "./elixir-jason.ts"
import { toElm } from "./elm-json.ts"
import { toFlow } from "./flow-native.ts"
import { toHaskell, toHaskellModule } from "./haskell-aeson.ts"
import { toObjC } from "./objc-foundation.ts"

import { toPhp } from "./php-native.ts"
import { toSymfony } from "./php-symfony.ts"
import { toJms } from "./php-jms.ts"
import { toRuby } from "./ruby-sorbet.ts"
import { toDry } from "./ruby-dry-types.ts"
import { toRbsFile } from "./ruby-rbs.ts"

import { toGraphQLType, toGraphQLTypes } from "./graphql.ts"
import { toCreateTable } from "./sql.ts"
import { toMssqlCreateTableFromRef } from "./sql-mssql.ts"
import { toProtoMessage, renderProto } from "./protobuf.ts"
import { toCapnpStruct, renderCapnp } from "./capnp.ts"
import { toFlatBuffersTable, toFlatBuffersDeclarations } from "./flatbuffers.ts"

import { toJtd } from "./jtd.ts"
import { toJsonSchemaDocument } from "./json-schema.ts"
import { toJsonSchema07 } from "./json-schema-07.ts"
import { toJsonSchema04Document } from "./json-schema-04.ts"
import { toOpenApi30Document } from "./openapi30.ts"
import { toOpenApi20, toOpenApi20Definitions } from "./openapi20.ts"
import { toStandardSchema } from "./standard-schema.ts"
import { toJsonRpcMethods } from "./json-rpc.ts"

import { toDocusaurusReference } from "./docusaurus-reference.ts"
import { toStarlightReference } from "./starlight-reference.ts"
import { toMkdocsReference } from "./mkdocs-reference.ts"
import { toMkdocsVanillaReference } from "./mkdocs-vanilla-reference.ts"
import { toSphinxReference } from "./sphinx-reference.ts"

/** Name given to the root type when a document has no named definitions and
 * the caller did not supply one. */
export const DEFAULT_ROOT_NAME = "Root"

// ---------------------------------------------------------------------------
// Importers — input shape varies, so the registry is a discriminated union
// ---------------------------------------------------------------------------

/** What an importer needs in order to run — metadata, not dispatch.
 *
 * Every importer in *this* registry consumes one string, so `run` is uniform
 * and nothing switches on this tag to decide how to call it. The tag exists
 * because callers still need to know what that string should contain: `text`
 * is raw source (GraphQL SDL, SQL DDL, a `.proto` file), `json` is one JSON
 * document, and `json-corpus` is an array of them — and a corpus importer
 * additionally accepts N documents that arrived separately, via `runMany`,
 * which is the shape a CLI sees when handed a glob.
 *
 * The `typescript` extension registry adds a fourth tag from its own module.
 * That one *does* change the shape of `run`, which is exactly why the tag is
 * a discriminated-union discriminator: narrowing on it recovers the right
 * signature statically. */
export type ImporterInputKind = "text" | "json" | "json-corpus"

interface ImporterBase extends RegistryEntry {
  /** Package subpath this importer's implementation is exported from. */
  readonly subpath: string
  /** Conventional file extensions, for CLI format sniffing. */
  readonly extensions: readonly string[]
  run(source: string): TypeRefDocument
}

export interface TextImporter extends ImporterBase {
  readonly input: "text"
}

export interface JsonImporter extends ImporterBase {
  readonly input: "json"
}

export interface JsonCorpusImporter extends ImporterBase {
  readonly input: "json-corpus"
  /** Infer from documents that arrived as separate sources rather than as one
   * JSON array. */
  runMany(sources: readonly string[]): TypeRefDocument
}

export type Importer = TextImporter | JsonImporter | JsonCorpusImporter

/** Normalize a bare registry (GraphQL SDL, SQL DDL, CQL, Cap'n Proto,
 * FlatBuffers — each can declare several sibling top-level types with no
 * distinguished root) into a document by promoting the first declared name to
 * `root` while keeping the full registry in `defs`. */
function fromRegistry(registry: Record<string, TypeRef>): TypeRefDocument {
  const names = Object.keys(registry)
  if (names.length === 0) throw new Error("no types declared in source")
  return typeRefDocument(registry[names[0]!]!, registry)
}

const text = (
  id: string,
  subpath: string,
  extensions: readonly string[],
  run: (source: string) => TypeRefDocument,
): TextImporter => ({ id, subpath, extensions, input: "text", run })

/** JSON importers parse their own source. Hoisting the parse into a dispatch
 * switch was what forced the caller-visible input shapes apart in the first
 * place; doing it here makes every entry in this registry `string -> document`
 * and leaves the tag as pure metadata. */
const json = (
  id: string,
  subpath: string,
  extensions: readonly string[],
  run: (value: unknown) => TypeRefDocument,
): JsonImporter => ({ id, subpath, extensions, input: "json", run: (source) => run(JSON.parse(source)) })

/** The `~standard` envelope the playground and CLI accept in place of live
 * vendor schema code. Arbitrary vendor modules can't be evaluated safely from
 * text, so the input names the vendor plus either a JSON Schema export (the
 * `StandardJSONSchemaV1` fast path) or a runtime sample value (the
 * runtime-sample fallback), and this reconstructs the shape
 * `fromStandardSchema` expects. */
export interface StandardSchemaEnvelope {
  readonly vendor?: string
  readonly jsonSchema?: Record<string, unknown>
  readonly sample?: unknown
}

export function fromStandardSchemaEnvelope(envelope: StandardSchemaEnvelope): TypeRefDocument {
  const vendor = envelope.vendor ?? "unknown"
  const jsonSchema = envelope.jsonSchema
  if (jsonSchema !== undefined) {
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

const importerList: readonly Importer[] = [
  json("json-schema", "./from-json-schema", [".schema.json"], (v) =>
    typeRefDocument(fromJsonSchema(v as Parameters<typeof fromJsonSchema>[0])),
  ),
  // A single value is the N=1 case of corpus inference — there is no separate
  // single-value entry point.
  json("json", "./from-json-corpus", [".json"], (v) => typeRefDocument(fromJsonCorpus([v]))),
  {
    id: "json-corpus",
    subpath: "./from-json-corpus",
    extensions: [".json"],
    input: "json-corpus",
    run: (source) => typeRefDocument(fromJsonCorpus(JSON.parse(source) as unknown[])),
    runMany: (sources) => typeRefDocument(fromJsonCorpus(sources.map((s) => JSON.parse(s)))),
  },
  json("jtd", "./from-jtd", [".jtd.json"], (v) => fromJtdDocument(v as Parameters<typeof fromJtdDocument>[0])),
  json("elasticsearch", "./from-elasticsearch", [".json"], (v) =>
    typeRefDocument(fromElasticsearch(v as Parameters<typeof fromElasticsearch>[0])),
  ),
  json("openapi30", "./from-openapi", [".json"], (v) =>
    typeRefDocument(fromOpenApi30(v as Parameters<typeof fromOpenApi30>[0])),
  ),
  json("openapi20", "./from-openapi", [".json"], (v) =>
    typeRefDocument(fromOpenApi20(v as Parameters<typeof fromOpenApi20>[0])),
  ),
  json("standard-schema", "./from-standard-schema", [".json"], (v) =>
    fromStandardSchemaEnvelope(v as StandardSchemaEnvelope),
  ),

  text("graphql", "./from-graphql", [".graphql", ".gql"], (s) => fromRegistry(fromGraphql(s))),
  text("sql", "./from-sql", [".sql"], (s) => fromRegistry(fromSql(s))),
  text("cql", "./from-cql", [".cql"], (s) => fromRegistry(fromCql(s))),
  text("capnp", "./from-capnp", [".capnp"], (s) => fromRegistry(fromCapnp(s))),
  text("flatbuffers", "./from-flatbuffers", [".fbs"], (s) => fromRegistry(fromFlatbuffers(s))),
  text("flow", "./from-flow", [".js.flow"], (s) => fromFlow(s)),
  text("protobuf", "./from-protobuf", [".proto"], (s) => fromProtoText(s)),
]

/** The text-based importers. Merge `typescriptImporterRegistry` from
 * `./registry-typescript` into this to also reach the checker-backed ones. */
export const importerRegistry: Registry<Importer> = defineRegistry(importerList)

/** Every importer id, in registration order. */
export const importerIds: readonly string[] = importerRegistry.ids

export function getImporter(id: string): Importer {
  return lookup(importerRegistry, "input format", id)
}

/** Run an importer from this registry against raw source text.
 *
 * Deliberately typed to `Importer`, not to the merged union: a checker-backed
 * importer cannot be driven from a string, and accepting one here would only
 * let the mistake through to a runtime failure. Callers holding a merged
 * registry narrow on `entry.input` and call `entry.run` directly — see
 * `ingestFrom` in `./registry-typescript`. */
export function ingest(id: string, source: string): TypeRefDocument {
  return getImporter(id).run(source)
}

/** Run a `json-corpus` importer over documents that arrived as separate
 * sources — one file per sample, the shape a CLI sees when handed a glob. */
export function ingestCorpus(id: string, sources: readonly string[]): TypeRefDocument {
  const importer = getImporter(id)
  if (importer.input !== "json-corpus") {
    throw new Error(`input format ${id} is not a corpus importer`)
  }
  return importer.runMany(sources)
}

// ---------------------------------------------------------------------------
// Projectors — output shape varies too
// ---------------------------------------------------------------------------

/** What a projector produced. Not every target renders a single string: the
 * JSON Schema / JTD / OpenAPI family builds a JSON value, the reference-site
 * generators emit a path -> content map, and Objective-C emits a header and
 * an implementation. Collapsing these to `string` at the registry boundary
 * would throw away structure that callers writing files actually need, so the
 * union is preserved and `renderProjection` does the collapse only when a
 * caller explicitly wants display text. */
export type Projection =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "files"; readonly files: ReadonlyMap<string, string> }

export interface ProjectionOptions {
  /** Name for the root type when the document carries no named definitions. */
  readonly name?: string
}

/** Precondition a projector places on its input document.
 *
 * `any` — works on any document; the overwhelming majority.
 * `interface-root` — the root must be an `interface` shape (a service method
 * surface). `json-rpc` lowers `shape.methods` to a method list, which a plain
 * object type simply does not have; there is no normalization that would make
 * one applicable, so this is reported rather than papered over. */
export type ProjectorRequires = "any" | "interface-root"

export interface Projector {
  readonly id: string
  /** Package subpath this projector's implementation is exported from. */
  readonly subpath: string
  /** Conventional output file extension, for CLIs choosing a filename. */
  readonly extension: string
  /** Input precondition — see `ProjectorRequires`. */
  readonly requires: ProjectorRequires
  run(doc: TypeRefDocument, options?: ProjectionOptions): Projection
}

/** Whether `projector` can run against `doc`. Lets a CLI or UI hide targets
 * that cannot apply instead of surfacing an error after the user picks one. */
export function appliesTo(projector: Projector, doc: TypeRefDocument): boolean {
  return projector.requires === "any" || doc.root.shape.kind === "interface"
}

/** Collapse a `Projection` to a single string for display. JSON values are
 * pretty-printed; multi-file output is concatenated with path banners. */
export function renderProjection(projection: Projection): string {
  switch (projection.kind) {
    case "text":
      return projection.text
    case "json":
      return JSON.stringify(projection.value, null, 2)
    case "files":
      return [...projection.files].map(([path, content]) => `/* ===== ${path} ===== */\n${content}`).join("\n\n")
  }
}

/** True when the document actually carries named types — the discriminator
 * for whether a projector renders a single declaration (root only) or a full
 * multi-declaration module. */
function isMulti(doc: TypeRefDocument): boolean {
  return Object.keys(doc.defs).length > 0
}

const rootName = (options?: ProjectionOptions): string => options?.name ?? DEFAULT_ROOT_NAME

type Render = (doc: TypeRefDocument, options?: ProjectionOptions) => string

/** `toX(ref, name?)` family — ref first, one declaration per call. Multi-def
 * documents render one declaration per registry entry under a banner. */
export function viaRefFirst(fn: (ref: TypeRef, name?: string) => string): Render {
  return (doc, options) => {
    if (!isMulti(doc)) return fn(doc.root, rootName(options))
    return Object.entries(doc.defs)
      .map(([name, ref]) => `/* ===== ${name} ===== */\n${fn(ref, name)}`)
      .join("\n\n")
  }
}

/** `toXDeclaration(name, ref)` + `toXDeclarations(registry)` family — name
 * first for the single form, registry directly for the plural form. */
export function viaNameFirst(
  single: (name: string, ref: TypeRef) => string,
  plural: (registry: Record<string, TypeRef>) => string,
): Render {
  return (doc, options) => (isMulti(doc) ? plural(doc.defs) : single(rootName(options), doc.root))
}

/** Like `viaNameFirst`, but the projector has no registry form — the
 * multi-def case falls back to one declaration per entry. */
export function viaNameFirstOnly(single: (name: string, ref: TypeRef) => string): Render {
  return (doc, options) => {
    if (!isMulti(doc)) return single(rootName(options), doc.root)
    return Object.entries(doc.defs)
      .map(([name, ref]) => single(name, ref))
      .join("\n\n")
  }
}

/** Two-stage builders (`protobuf`, `capnp`): build one declaration object per
 * type, then render the whole file at once. */
function viaTwoStage<D>(build: (name: string, ref: TypeRef) => D, render: (decls: D[]) => string): Render {
  return (doc, options) => {
    if (!isMulti(doc)) return render([build(rootName(options), doc.root)])
    return render(Object.entries(doc.defs).map(([name, ref]) => build(name, ref)))
  }
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase()
}

const src = (id: string, subpath: string, extension: string, render: Render): Projector => ({
  id,
  subpath,
  extension,
  requires: "any",
  run: (doc, options) => ({ kind: "text", text: render(doc, options) }),
})

const data = (
  id: string,
  subpath: string,
  extension: string,
  build: (doc: TypeRefDocument, options?: ProjectionOptions) => unknown,
  requires: ProjectorRequires = "any",
): Projector => ({
  id,
  subpath,
  extension,
  requires,
  run: (doc, options) => ({ kind: "json", value: build(doc, options) }),
})

/** Reference-site generators emit one page per `doc.defs` entry, so a
 * defs-less document would otherwise yield nothing at all. Every other
 * projector treats such a document as "one type, named `rootName(options)`";
 * filing the root under that name applies the same normalization here rather
 * than leaving three targets silently empty. */
const files = (
  id: string,
  subpath: string,
  build: (doc: TypeRefDocument) => Map<string, string>,
): Projector => ({
  id,
  subpath,
  extension: ".md",
  requires: "any",
  run: (doc, options) => ({
    kind: "files",
    files: build(isMulti(doc) ? doc : typeRefDocument(doc.root, { [rootName(options)]: doc.root })),
  }),
})

const projectorList: readonly Projector[] = [
  // --- TypeScript type-level and validator libraries -----------------------
  src("typescript-native", "./typescript-native", ".ts", viaNameFirst(toTypeDeclaration, toTypeDeclarations)),
  src("typescript-zod", "./typescript-zod", ".ts", viaNameFirst(toZodDeclaration, toZodDeclarations)),
  src("typescript-typebox", "./typescript-typebox", ".ts", viaNameFirst(toTypeBoxDeclaration, toTypeBoxDeclarations)),
  src("typescript-io-ts", "./typescript-io-ts", ".ts", viaNameFirst(toIoTsDeclaration, toIoTsDeclarations)),
  src("typescript-yup", "./typescript-yup", ".ts", viaNameFirst(toYupDeclaration, toYupDeclarations)),
  src(
    "typescript-effect-schema",
    "./typescript-effect-schema",
    ".ts",
    viaNameFirst(toEffectSchemaDeclaration, toEffectSchemaDeclarations),
  ),
  src("typescript-valibot", "./typescript-valibot", ".ts", viaNameFirst(toValibotDeclaration, toValibotDeclarations)),
  src("typescript-runtypes", "./typescript-runtypes", ".ts", viaNameFirst(toRuntypesDeclaration, toRuntypesDeclarations)),
  src(
    "typescript-superstruct",
    "./typescript-superstruct",
    ".ts",
    viaNameFirst(toSuperstructDeclaration, toSuperstructDeclarations),
  ),
  src("typescript-arktype", "./typescript-arktype", ".ts", viaNameFirst(toArkTypeDeclaration, toArkTypeDeclarations)),
  src(
    "jsdoc",
    "./jsdoc",
    ".js",
    viaNameFirst(
      (name, ref) => toJsDocTypedef(name, ref),
      (registry) => toJsDocTypedefs(registry),
    ),
  ),

  // --- Python --------------------------------------------------------------
  src("python-dataclass", "./python-dataclass", ".py", viaRefFirst(toPython)),
  src("python-pydantic", "./python-pydantic", ".py", viaRefFirst(toPydantic)),
  src("python-attrs", "./python-attrs", ".py", viaRefFirst(toAttrs)),
  src("python-msgspec", "./python-msgspec", ".py", viaRefFirst(toMsgspec)),
  src("python-cattrs", "./python-cattrs", ".py", viaRefFirst(toCattrs)),

  // --- Go ------------------------------------------------------------------
  src("go-encoding-json", "./go-encoding-json", ".go", viaRefFirst(toGo)),
  src("go-easyjson", "./go-easyjson", ".go", viaRefFirst(toEasyjson)),
  src("go-jsoniter", "./go-jsoniter", ".go", viaRefFirst(toJsoniter)),
  src("go-sonic", "./go-sonic", ".go", viaRefFirst(toSonic)),

  // --- JVM -----------------------------------------------------------------
  // The Java family exports both orders (`toXDeclaration(name, ref)` and
  // `toX(ref, name?)`); the declaration form is the one that emits a named,
  // compilable class, so that is what the registry wires.
  src("java-jackson", "./java-jackson", ".java", viaNameFirstOnly((name, ref) => toJavaDeclaration(name, ref))),
  src("java-gson", "./java-gson", ".java", viaNameFirstOnly((name, ref) => toGsonDeclaration(name, ref))),
  src("java-moshi", "./java-moshi", ".java", viaNameFirstOnly((name, ref) => toMoshiDeclaration(name, ref))),
  src("java-jsonb", "./java-jsonb", ".java", viaNameFirstOnly((name, ref) => toJsonbDeclaration(name, ref))),
  src(
    "kotlin-kotlinx",
    "./kotlin-kotlinx",
    ".kt",
    viaNameFirst((name, ref) => toKotlin(ref, name), toKotlinDeclarations),
  ),
  src(
    "kotlin-jackson",
    "./kotlin-jackson",
    ".kt",
    viaNameFirst((name, ref) => toKotlinJackson(ref, name), toKotlinJacksonDeclarations),
  ),
  src(
    "kotlin-gson",
    "./kotlin-gson",
    ".kt",
    viaNameFirst((name, ref) => toKotlinGson(ref, name), (registry) => toKotlinGsonDeclarations(registry)),
  ),

  // --- Systems languages ---------------------------------------------------
  src("rust-serde", "./rust-serde", ".rs", viaRefFirst(toRust)),
  src("swift-codable", "./swift-codable", ".swift", viaRefFirst(toSwift)),
  src("swift-swiftyjson", "./swift-swiftyjson", ".swift", viaRefFirst(toSwiftyJSON)),
  src("swift-objectmapper", "./swift-objectmapper", ".swift", viaRefFirst(toObjectMapper)),
  src("csharp-systemtextjson", "./csharp-systemtextjson", ".cs", viaRefFirst(toCSharp)),
  src("csharp-newtonsoft", "./csharp-newtonsoft", ".cs", viaRefFirst(toCSharpNewtonsoft)),
  src("csharp-servicestack", "./csharp-servicestack", ".cs", viaRefFirst(toCSharpServiceStack)),
  src("cpp-nlohmann", "./cpp-nlohmann", ".hpp", viaRefFirst(toCpp)),
  src("cpp-rapidjson", "./cpp-rapidjson", ".hpp", viaRefFirst(toRapidjson)),
  src("cpp-simdjson", "./cpp-simdjson", ".hpp", viaRefFirst(toSimdjson)),
  src("cpp-boost-json", "./cpp-boost-json", ".hpp", viaRefFirst(toBoostJson)),
  src("cpp-glaze", "./cpp-glaze", ".hpp", viaRefFirst(toGlaze)),
  // Objective-C is the one source projector that returns a structured pair
  // rather than a string; header and implementation are joined for display,
  // and the implementation is omitted when empty (pure-interface output).
  src("objc-foundation", "./objc-foundation", ".h", (doc, options) => {
    const render = (name: string, ref: TypeRef): string => {
      const { header, implementation } = toObjC(ref, name)
      return implementation.trim().length === 0 ? header : `${header}\n\n${implementation}`
    }
    if (!isMulti(doc)) return render(rootName(options), doc.root)
    return Object.entries(doc.defs)
      .map(([name, ref]) => render(name, ref))
      .join("\n\n")
  }),

  // --- Dart / Crystal / Elixir / Elm / Flow / Haskell ----------------------
  src("dart-json-serializable", "./dart-json-serializable", ".dart", viaRefFirst(toDart)),
  src("dart-freezed", "./dart-freezed", ".dart", viaRefFirst(toFreezed)),
  src("dart-built-value", "./dart-built-value", ".dart", viaRefFirst(toBuiltValue)),
  src(
    "crystal-json-serializable",
    "./crystal-json-serializable",
    ".cr",
    viaNameFirst((name, ref) => toCrystal(ref, name), toCrystalDeclarations),
  ),
  src("elixir-jason", "./elixir-jason", ".ex", viaRefFirst(toElixir)),
  src("elm-json", "./elm-json", ".elm", viaRefFirst(toElm)),
  src("flow-native", "./flow-native", ".js.flow", viaRefFirst(toFlow)),
  src(
    "haskell-aeson",
    "./haskell-aeson",
    ".hs",
    viaNameFirst(
      (name, ref) => toHaskell(ref, name),
      (registry) => toHaskellModule("Generated", registry),
    ),
  ),

  // --- Dynamic languages ---------------------------------------------------
  src("php-native", "./php-native", ".php", viaRefFirst(toPhp)),
  src("php-symfony", "./php-symfony", ".php", viaRefFirst(toSymfony)),
  src("php-jms", "./php-jms", ".php", viaRefFirst(toJms)),
  src("ruby-sorbet", "./ruby-sorbet", ".rb", viaRefFirst(toRuby)),
  src("ruby-dry-types", "./ruby-dry-types", ".rb", viaRefFirst(toDry)),
  src("ruby-rbs", "./ruby-rbs", ".rbs", viaRefFirst((ref, name) => toRbsFile(ref, name ?? DEFAULT_ROOT_NAME))),

  // --- Schema / IDL languages ---------------------------------------------
  src("graphql", "./graphql", ".graphql", viaNameFirst(toGraphQLType, toGraphQLTypes)),
  src("sql", "./sql", ".sql", viaNameFirstOnly((name, ref) => toCreateTable(toSnakeCase(name), ref))),
  src("sql-mssql", "./sql-mssql", ".sql", viaNameFirstOnly((name, ref) => toMssqlCreateTableFromRef(toSnakeCase(name), ref))),
  src("protobuf", "./protobuf", ".proto", viaTwoStage(toProtoMessage, (msgs) => renderProto(msgs))),
  src("capnp", "./capnp", ".capnp", viaTwoStage(toCapnpStruct, (structs) => renderCapnp(structs))),
  src("flatbuffers", "./flatbuffers", ".fbs", viaNameFirst(toFlatBuffersTable, toFlatBuffersDeclarations)),

  // --- JSON-value outputs --------------------------------------------------
  data("jtd", "./jtd", ".json", (doc) => toJtd(doc.root)),
  data("json-schema", "./json-schema", ".json", (doc) => toJsonSchemaDocument(doc)),
  data("json-schema-07", "./json-schema-07", ".json", (doc) => toJsonSchema07(doc.root)),
  data("json-schema-04", "./json-schema-04", ".json", (doc) =>
    toJsonSchema04Document(doc.root, isMulti(doc) ? { definitions: doc.defs } : {}),
  ),
  data("openapi30", "./openapi30", ".json", (doc) => toOpenApi30Document(doc)),
  data("openapi20", "./openapi20", ".json", (doc) =>
    isMulti(doc) ? toOpenApi20Definitions(doc.defs) : toOpenApi20(doc.root),
  ),
  // `toStandardSchema` returns a live validator object; only its JSON Schema
  // face survives serialization, which is what a registry consumer can use.
  data("standard-schema", "./standard-schema", ".json", (doc) => toStandardSchema(doc.root)),
  // `toJsonRpcMethods` is plural in name but enumerates the methods *within*
  // one type, so it takes the root ref rather than the registry — and that
  // type must be an `interface`, hence the precondition.
  data("json-rpc", "./json-rpc", ".json", (doc) => toJsonRpcMethods(doc.root), "interface-root"),

  // --- Reference-site generators (path -> content) -------------------------
  files("docusaurus-reference", "./docusaurus-reference", (doc) => toDocusaurusReference(doc)),
  files("starlight-reference", "./starlight-reference", (doc) => toStarlightReference(doc)),
  files("mkdocs-reference", "./mkdocs-reference", (doc) => toMkdocsReference(doc)),
  files("mkdocs-vanilla-reference", "./mkdocs-vanilla-reference", (doc) => toMkdocsVanillaReference(doc)),
  files("sphinx-reference", "./sphinx-reference", (doc) => toSphinxReference(doc)),
]

/** Short ids kept as aliases so existing callers keep resolving. Most are
 * also real package subpaths; the handful that are not (`go`, `swift`, `cpp`,
 * `kotlin`, `php`, `objc`) were the playground's own shorthand. */
const projectorAliases: Readonly<Record<string, string>> = {
  typescript: "typescript-native",
  zod: "typescript-zod",
  typebox: "typescript-typebox",
  "io-ts": "typescript-io-ts",
  yup: "typescript-yup",
  "effect-schema": "typescript-effect-schema",
  valibot: "typescript-valibot",
  runtypes: "typescript-runtypes",
  superstruct: "typescript-superstruct",
  arktype: "typescript-arktype",
  rust: "rust-serde",
  swift: "swift-codable",
  go: "go-encoding-json",
  cpp: "cpp-nlohmann",
  kotlin: "kotlin-kotlinx",
  php: "php-native",
  objc: "objc-foundation",
  crystal: "crystal-json-serializable",
  elixir: "elixir-jason",
  elm: "elm-json",
  flow: "flow-native",
  haskell: "haskell-aeson",
}

export const projectorRegistry: Registry<Projector> = defineRegistry(projectorList, projectorAliases)

/** Canonical projector ids, in registration order — aliases excluded. */
export const projectorIds: readonly string[] = projectorRegistry.ids

export function getProjector(id: string): Projector {
  return lookup(projectorRegistry, "output format", id)
}

export function project(id: string, doc: TypeRefDocument, options?: ProjectionOptions): Projection {
  const projector = getProjector(id)
  if (!appliesTo(projector, doc)) {
    throw new Error(
      `output format ${id} requires an interface root (a service method surface), got ${doc.root.shape.kind}`,
    )
  }
  return projector.run(doc, options)
}

/** Ingest `source` with `inputId`, project the result with `outputId`, and
 * collapse to display text. Throws on any failure — callers surface the
 * message rather than treating a bad conversion as a silent no-op. */
export function convert(inputId: string, outputId: string, source: string, options?: ProjectionOptions): string {
  return renderProjection(project(outputId, ingest(inputId, source), options))
}
