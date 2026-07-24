// packages/type-ir/src/corpora.test.ts — real-world schema corpora
// round-trip testing. Unlike test-fixtures.ts's hand-crafted TypeRefs (built
// directly with `t(types.X(...))`), this suite starts from schema TEXT that
// looks like what actually ships in the wild — a trimmed but structurally
// faithful package.json/tsconfig.json/GeoJSON JSON Schema, an OpenAPI 3.0
// Petstore-shaped components.schemas set, and a googleapis-styled .proto
// file — and drives it through this package's own ingesters
// (from-json-schema.ts / from-openapi.ts / from-protobuf.ts) before handing
// the resulting TypeRef(s) to the projector matrix.
//
// This is deliberately NOT snapshot testing: real-world schemas combine
// kinds in ways hand-written fixtures rarely think to try (deeply nested
// optional objects, oneOf-with-discriminator unions, additionalProperties
// dicts, $ref cycles, map<string,V> + oneof + well-known types in the same
// message) — the goal is to catch a projector crashing or emitting empty
// output on a shape it's never seen, not to pin exact output text.
//
// The schemas below are typed out by hand rather than fetched over the
// network at test time (SchemaStore/googleapis) so this suite stays
// offline, deterministic, and immune to upstream drift — but they mirror
// the real schemas' structure closely enough to exercise the same
// ingester/projector paths.
import { describe, expect, test } from "bun:test"
import type { TypeRef } from "./index.ts"
import { fromJsonSchema, type JsonSchema } from "./from-json-schema.ts"
import { fromOpenApi30, type OpenApiSchema } from "./from-openapi.ts"
import { fromProtoText } from "./from-protobuf.ts"

import { toZodDeclaration } from "./typescript-zod.ts"
import { toPydantic } from "./python-pydantic.ts"
import { toPython } from "./python-dataclass.ts"
import { toAttrs } from "./python-attrs.ts"
import { toGo } from "./go-encoding-json.ts"
import { toRust } from "./rust-serde.ts"
import { toJavaDeclaration } from "./java-jackson.ts"
import { toGsonDeclaration } from "./java-gson.ts"
import { toMoshi } from "./java-moshi.ts"
import { toCSharp } from "./csharp-systemtextjson.ts"
import { toCSharpNewtonsoft } from "./csharp-newtonsoft.ts"
import { toSwift } from "./swift-codable.ts"
import { toKotlin } from "./kotlin-kotlinx.ts"
import { toDart } from "./dart-json-serializable.ts"
import { toFreezed } from "./dart-freezed.ts"
import { toObjC } from "./objc-foundation.ts"
import { toCpp } from "./cpp-nlohmann.ts"
import { toCrystal } from "./crystal-json-serializable.ts"
import { toHaskell } from "./haskell-aeson.ts"
import { toElm } from "./elm-json.ts"
import { toFlow } from "./flow-native.ts"
import { toPhp } from "./php-native.ts"
import { toRuby } from "./ruby-sorbet.ts"
import { toTypeDeclaration } from "./typescript-native.ts"
import { toArkTypeDeclaration } from "./typescript-arktype.ts"
import { toEffectSchemaDeclaration } from "./typescript-effect-schema.ts"
import { toIoTsDeclaration } from "./typescript-io-ts.ts"
import { toRuntypesDeclaration } from "./typescript-runtypes.ts"
import { toSuperstructDeclaration } from "./typescript-superstruct.ts"
import { toTypeBoxDeclaration } from "./typescript-typebox.ts"
import { toValibotDeclaration } from "./typescript-valibot.ts"
import { toYupDeclaration } from "./typescript-yup.ts"
import { toJsonSchema } from "./json-schema.ts"
import { toJsonSchema04 } from "./json-schema-04.ts"
import { toJsonSchema07 } from "./json-schema-07.ts"
import { toOpenApi30 } from "./openapi30.ts"
import { toOpenApi20 } from "./openapi20.ts"
import { toGraphQLType } from "./graphql.ts"
import { toProtoMessage, renderProto } from "./protobuf.ts"
import { toCapnpStruct, renderCapnp } from "./capnp.ts"
import { toFlatBuffersTable, toFlatBuffersDeclarations } from "./flatbuffers.ts"
import { toCreateTable } from "./sql.ts"
import { toMssqlCreateTableFromRef } from "./sql-mssql.ts"
import { toJtd } from "./jtd.ts"
import { toStandardSchema } from "./standard-schema.ts"
import { compileValidator } from "./compile.ts"

// ============================================================================
// Projector matrix — same normalization + membership as cross-projector.test.ts
// (every projector reduced to a single `(ref, name) => string` shape), kept
// in sync deliberately rather than imported: cross-projector.test.ts's matrix
// is a private `const`, and duplicating the ~40-entry list here is cheaper
// than exporting internal test wiring across files.
// ============================================================================

const projectors: { name: string; fn: (ref: TypeRef, name: string) => string }[] = [
  { name: "typescript-zod", fn: (ref, name) => toZodDeclaration(name, ref) },
  { name: "typescript-native", fn: (ref, name) => toTypeDeclaration(name, ref) },
  { name: "typescript-arktype", fn: (ref, name) => toArkTypeDeclaration(name, ref) },
  { name: "typescript-effect-schema", fn: (ref, name) => toEffectSchemaDeclaration(name, ref) },
  { name: "typescript-io-ts", fn: (ref, name) => toIoTsDeclaration(name, ref) },
  { name: "typescript-runtypes", fn: (ref, name) => toRuntypesDeclaration(name, ref) },
  { name: "typescript-superstruct", fn: (ref, name) => toSuperstructDeclaration(name, ref) },
  { name: "typescript-typebox", fn: (ref, name) => toTypeBoxDeclaration(name, ref) },
  { name: "typescript-valibot", fn: (ref, name) => toValibotDeclaration(name, ref) },
  { name: "typescript-yup", fn: (ref, name) => toYupDeclaration(name, ref) },
  { name: "flow-native", fn: (ref, name) => toFlow(ref, name) },
  { name: "python-pydantic", fn: (ref, name) => toPydantic(ref, name) },
  { name: "python-dataclass", fn: (ref, name) => toPython(ref, name) },
  { name: "python-attrs", fn: (ref, name) => toAttrs(ref, name) },
  { name: "go-encoding-json", fn: (ref, name) => toGo(ref, name) },
  { name: "rust-serde", fn: (ref, name) => toRust(ref, name) },
  { name: "java-jackson", fn: (ref, name) => toJavaDeclaration(name, ref) },
  { name: "java-gson", fn: (ref, name) => toGsonDeclaration(name, ref) },
  { name: "java-moshi", fn: (ref, name) => toMoshi(ref, name) },
  { name: "csharp-systemtextjson", fn: (ref, name) => toCSharp(ref, name) },
  { name: "csharp-newtonsoft", fn: (ref, name) => toCSharpNewtonsoft(ref, name) },
  { name: "swift-codable", fn: (ref, name) => toSwift(ref, name) },
  { name: "kotlin-kotlinx", fn: (ref, name) => toKotlin(ref, name) },
  { name: "dart-json-serializable", fn: (ref, name) => toDart(ref, name) },
  { name: "dart-freezed", fn: (ref, name) => toFreezed(ref, name) },
  { name: "objc-foundation", fn: (ref, name) => JSON.stringify(toObjC(ref, name)) },
  { name: "cpp-nlohmann", fn: (ref, name) => toCpp(ref, name) },
  { name: "crystal-json-serializable", fn: (ref, name) => toCrystal(ref, name) },
  { name: "haskell-aeson", fn: (ref, name) => toHaskell(ref, name) },
  { name: "elm-json", fn: (ref, name) => toElm(ref, name) },
  { name: "php-native", fn: (ref, name) => toPhp(ref, name) },
  { name: "ruby-sorbet", fn: (ref, name) => toRuby(ref, name) },
  { name: "json-schema", fn: (ref) => JSON.stringify(toJsonSchema(ref)) },
  { name: "json-schema-04", fn: (ref) => JSON.stringify(toJsonSchema04(ref)) },
  { name: "json-schema-07", fn: (ref) => JSON.stringify(toJsonSchema07(ref)) },
  { name: "openapi30", fn: (ref) => JSON.stringify(toOpenApi30(ref)) },
  { name: "openapi20", fn: (ref) => JSON.stringify(toOpenApi20(ref)) },
  { name: "graphql", fn: (ref, name) => toGraphQLType(name, ref) },
  { name: "jtd", fn: (ref) => JSON.stringify(toJtd(ref)) },
  {
    name: "standard-schema",
    fn: (ref) => {
      const schema = toStandardSchema(ref)
      if (schema["~standard"].version !== 1) throw new Error("unexpected standard-schema version")
      return `standard-schema:${schema["~standard"].vendor}`
    },
  },
  { name: "compile (AOT validator)", fn: (ref, name) => compileValidator(ref) + name },
  { name: "protobuf", fn: (ref, name) => renderProto([toProtoMessage(name, ref)]) },
  { name: "capnp", fn: (ref, name) => renderCapnp([toCapnpStruct(name, ref)]) },
  {
    name: "flatbuffers",
    fn: (ref, name) =>
      ref.shape.kind === "object" || ref.shape.kind === "tuple"
        ? toFlatBuffersTable(name, ref)
        : toFlatBuffersDeclarations({ [name]: ref }),
  },
  { name: "sql", fn: (ref, name) => toCreateTable(name, ref) },
  { name: "sql-mssql", fn: (ref, name) => toMssqlCreateTableFromRef(name, ref) },
]

// Struct-only projectors that need an `object`/`tuple` root and have no
// union/enum/map synthesis path today. Populated per-corpus below as actual
// `fn(ref, name)` calls throw — kept as `test.todo`, matching
// compile-check.test.ts's convention of recording a known gap with the real
// error rather than silently skipping it.
function projectAll(
  describeName: string,
  ref: TypeRef,
  rootName: string,
  todoProjectors: ReadonlySet<string> = new Set(),
): void {
  describe(describeName, () => {
    for (const { name, fn } of projectors) {
      const runner = todoProjectors.has(name) ? test.todo : test
      runner(`-> ${name}`, () => {
        const result = fn(ref, rootName)
        expect(typeof result).toBe("string")
        expect(result.length).toBeGreaterThan(0)
      })
    }
  })
}

// ============================================================================
// Corpus A — JSON Schema (draft 2020-12-ish subset), modeled on real-world
// SchemaStore schemas: package.json, tsconfig.json, and GeoJSON.
// ============================================================================

const packageJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", pattern: "^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$" },
    version: { type: "string" },
    description: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
    homepage: { type: "string", format: "uri" },
    license: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    author: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string", format: "email" },
            url: { type: "string", format: "uri" },
          },
          required: ["name"],
        },
      ],
    },
    contributors: {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "object", properties: { name: { type: "string" } }, required: ["name"] }] },
    },
    files: { type: "array", items: { type: "string" } },
    main: { type: "string" },
    bin: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }] },
    type: { enum: ["commonjs", "module"] },
    repository: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: { type: { type: "string" }, url: { type: "string" }, directory: { type: "string" } },
          required: ["type", "url"],
        },
      ],
    },
    scripts: { type: "object", additionalProperties: { type: "string" } },
    dependencies: { type: "object", additionalProperties: { type: "string" } },
    devDependencies: { type: "object", additionalProperties: { type: "string" } },
    peerDependencies: { type: "object", additionalProperties: { type: "string" } },
    optionalDependencies: { type: "object", additionalProperties: { type: "string" } },
    engines: { type: "object", additionalProperties: { type: "string" } },
    os: { type: "array", items: { type: "string" } },
    cpu: { type: "array", items: { type: "string" } },
    private: { type: "boolean" },
    publishConfig: { type: "object", additionalProperties: { type: "string" } },
    workspaces: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "object", properties: { packages: { type: "array", items: { type: "string" } } } }] },
  },
  required: ["name", "version"],
}

const tsconfigSchema: JsonSchema = {
  type: "object",
  properties: {
    extends: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    include: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
    files: { type: "array", items: { type: "string" } },
    references: {
      type: "array",
      items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    compilerOptions: {
      type: "object",
      properties: {
        target: { enum: ["ES3", "ES5", "ES2015", "ES2020", "ES2022", "ESNext"] },
        module: { enum: ["commonjs", "esnext", "es2020", "node16", "nodenext"] },
        moduleResolution: { enum: ["node", "node16", "nodenext", "bundler"] },
        lib: { type: "array", items: { type: "string" } },
        strict: { type: "boolean" },
        strictNullChecks: { type: "boolean" },
        noImplicitAny: { type: "boolean" },
        esModuleInterop: { type: "boolean" },
        skipLibCheck: { type: "boolean" },
        declaration: { type: "boolean" },
        declarationMap: { type: "boolean" },
        sourceMap: { type: "boolean" },
        outDir: { type: "string" },
        rootDir: { type: "string" },
        baseUrl: { type: "string" },
        paths: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        types: { type: "array", items: { type: "string" } },
        jsx: { enum: ["preserve", "react", "react-jsx", "react-native"] },
        incremental: { type: "boolean" },
        composite: { type: "boolean" },
      },
    },
  },
}

// GeoJSON (RFC 7946) — a discriminated union over `type`, several geometry
// kinds plus Feature/FeatureCollection wrapping the geometry union
// recursively (arrays-of-arrays-of-numbers for coordinates at every depth).
const position: JsonSchema = { type: "array", items: { type: "number" }, minItems: 2 }
const point: JsonSchema = {
  type: "object",
  properties: { type: { const: "Point" }, coordinates: position },
  required: ["type", "coordinates"],
}
const lineString: JsonSchema = {
  type: "object",
  properties: { type: { const: "LineString" }, coordinates: { type: "array", items: position } },
  required: ["type", "coordinates"],
}
const polygon: JsonSchema = {
  type: "object",
  properties: { type: { const: "Polygon" }, coordinates: { type: "array", items: { type: "array", items: position } } },
  required: ["type", "coordinates"],
}
const geometry: JsonSchema = { oneOf: [point, lineString, polygon], discriminator: { propertyName: "type" } }
const feature: JsonSchema = {
  type: "object",
  properties: {
    type: { const: "Feature" },
    geometry,
    properties: { type: "object", additionalProperties: { type: "string" } },
    id: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  required: ["type", "geometry", "properties"],
}
const featureCollection: JsonSchema = {
  type: "object",
  properties: { type: { const: "FeatureCollection" }, features: { type: "array", items: feature } },
  required: ["type", "features"],
}
const geoJsonSchema: JsonSchema = {
  oneOf: [point, lineString, polygon, feature, featureCollection],
  discriminator: { propertyName: "type" },
}

describe("corpus: JSON Schema (SchemaStore-shaped)", () => {
  const packageJsonRef = fromJsonSchema(packageJsonSchema)
  const tsconfigRef = fromJsonSchema(tsconfigSchema)
  const geoJsonRef = fromJsonSchema(geoJsonSchema)

  test("package.json schema ingests to an object TypeRef", () => {
    expect(packageJsonRef.shape.kind).toBe("object")
  })
  test("tsconfig.json schema ingests to an object TypeRef with a nested compilerOptions object", () => {
    expect(tsconfigRef.shape.kind).toBe("object")
    const fields = (tsconfigRef.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.compilerOptions?.shape.kind).toBe("object")
  })
  test("GeoJSON schema ingests to a discriminated union TypeRef", () => {
    expect(geoJsonRef.shape.kind).toBe("union")
    expect(geoJsonRef.meta.discriminator).toBe("type")
  })

  projectAll("package.json -> projectors", packageJsonRef, "PackageJson")
  projectAll("tsconfig.json -> projectors", tsconfigRef, "TsConfig")
  projectAll("GeoJSON (discriminated union) -> projectors", geoJsonRef, "GeoJson")
})

// ============================================================================
// Corpus B — OpenAPI 3.0 components.schemas, Petstore-shaped. fromOpenApi30
// takes a single Schema Object (not a whole document), so each
// components.schemas entry below is ingested independently — same shape a
// real ingestion pipeline walking `components.schemas` would produce.
// ============================================================================

const petSchema: OpenApiSchema = {
  type: "object",
  properties: {
    id: { type: "integer", format: "int64" },
    name: { type: "string" },
    tag: { type: "string" },
    status: { type: "string", enum: ["available", "pending", "sold"] },
    photoUrls: { type: "array", items: { type: "string", format: "uri" } },
    category: {
      type: "object",
      properties: { id: { type: "integer", format: "int64" }, name: { type: "string" } },
    },
    tags: {
      type: "array",
      items: { type: "object", properties: { id: { type: "integer", format: "int64" }, name: { type: "string" } } },
    },
  },
  required: ["id", "name"],
}

const newPetSchema: OpenApiSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    tag: { type: "string" },
  },
  required: ["name"],
}

const apiErrorSchema: OpenApiSchema = {
  type: "object",
  properties: {
    code: { type: "integer", format: "int32" },
    message: { type: "string" },
    details: { type: "array", items: { type: "string" }, nullable: true },
  },
  required: ["code", "message"],
}

const petOrErrorSchema: OpenApiSchema = {
  oneOf: [petSchema, apiErrorSchema],
  discriminator: { propertyName: "status" },
}

const petsPageSchema: OpenApiSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: petSchema },
    nextCursor: { type: "string", nullable: true },
    totalCount: { type: "integer", format: "int32" },
  },
  required: ["items"],
}

describe("corpus: OpenAPI 3.0 (Petstore-shaped components.schemas)", () => {
  const petRef = fromOpenApi30(petSchema)
  const newPetRef = fromOpenApi30(newPetSchema)
  const apiErrorRef = fromOpenApi30(apiErrorSchema)
  const petOrErrorRef = fromOpenApi30(petOrErrorSchema)
  const petsPageRef = fromOpenApi30(petsPageSchema)

  test("Pet ingests to an object TypeRef with a nested enum field", () => {
    expect(petRef.shape.kind).toBe("object")
    const fields = (petRef.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.status?.shape.kind).toBe("enum")
  })

  projectAll("Pet -> projectors", petRef, "Pet")
  projectAll("NewPet -> projectors", newPetRef, "NewPet")
  projectAll("ApiError -> projectors", apiErrorRef, "ApiError")
  projectAll("PetOrError (oneOf + discriminator) -> projectors", petOrErrorRef, "PetOrError")
  projectAll("PetsPage (nested array-of-objects) -> projectors", petsPageRef, "PetsPage")
})

// ============================================================================
// Corpus C — Protocol Buffers, googleapis-styled: nested messages, an enum,
// a oneof, a map field, a repeated field, and a well-known Timestamp type,
// all in one file the way a real service definition would combine them.
// ============================================================================

const orderProto = `
syntax = "proto3";

package shop.v1;

// An order placed by a customer.
message Order {
  string id = 1;
  Status status = 2;
  repeated OrderItem items = 3;
  map<string, string> metadata = 4;
  google.protobuf.Timestamp createdAt = 5;

  message Address {
    string street = 1;
    string city = 2;
    string country = 3;
  }
  Address shippingAddress = 6;

  oneof payment {
    CreditCard creditCard = 7;
    string giftCardCode = 8;
  }
}

message OrderItem {
  string productId = 1;
  int32 quantity = 2;
  double unitPrice = 3;
}

message CreditCard {
  string last4 = 1;
  int32 expiryMonth = 2;
  int32 expiryYear = 3;
}

enum Status {
  STATUS_UNSPECIFIED = 0;
  STATUS_PENDING = 1;
  STATUS_SHIPPED = 2;
  STATUS_DELIVERED = 3;
  STATUS_CANCELLED = 4;
}
`

describe("corpus: Protocol Buffers (googleapis-styled service schema)", () => {
  const doc = fromProtoText(orderProto)

  test("every top-level and nested message/enum lands in defs", () => {
    expect(Object.keys(doc.defs).sort()).toEqual(
      ["CreditCard", "Order", "Order.Address", "OrderItem", "Status"].sort(),
    )
  })

  test("Order.createdAt (well-known Timestamp) ingests as datetime", () => {
    const fields = (doc.defs.Order!.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.createdAt?.shape.kind).toBe("datetime")
  })

  test("Order.metadata (map<string,string>) ingests as a map TypeRef", () => {
    const fields = (doc.defs.Order!.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.metadata?.shape.kind).toBe("map")
  })

  test("Order.payment (oneof) ingests as a union TypeRef", () => {
    const fields = (doc.defs.Order!.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.payment?.shape.kind).toBe("union")
  })

  // Every message def (object-kind) goes through the full projector matrix.
  for (const [name, ref] of Object.entries(doc.defs)) {
    if (ref.shape.kind === "object") {
      projectAll(`${name} (message) -> projectors`, ref, name)
    }
  }

  // Enum-kind defs (Status) are struct-incompatible for the SQL/FlatBuffers/
  // Cap'n Proto table-oriented projectors, which expect an object/tuple root
  // to build a row/table around — those projectors are exercised elsewhere
  // (json-schema.test.ts, protobuf.test.ts, etc.) against enum roots
  // directly. Here, only the projectors that structurally accept a bare
  // enum root are run, to confirm the ingester's enum output composes with
  // them same as a hand-written enum fixture would.
  describe("Status (enum) -> projectors accepting a bare enum root", () => {
    const enumCompatible = projectors.filter((p) =>
      !["sql", "sql-mssql", "capnp", "flatbuffers", "protobuf"].includes(p.name),
    )
    for (const { name, fn } of enumCompatible) {
      test(`-> ${name}`, () => {
        const result = fn(doc.defs.Status!, "Status")
        expect(typeof result).toBe("string")
        expect(result.length).toBeGreaterThan(0)
      })
    }
  })
})
