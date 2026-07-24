// Cross-projector smoke tests: complex, realistic schemas fed through EVERY
// output projector this package ships, asserting each one ingests the shape
// and produces non-empty output without throwing. Individual projectors
// already have unit tests over the full kind vocabulary in isolation — this
// file instead exercises whole, non-trivial schemas (nested objects, arrays,
// enums, optionals, recursion, discriminated unions, constraints) across the
// entire projector matrix, so a regression that only shows up when several
// kinds compose (e.g. an array-of-arrays inside a union inside an optional
// field) has somewhere to surface.
import { describe, expect, test } from "bun:test"
import type { TypeRef } from "./index.ts"
import { fixtures } from "./test-fixtures.ts"

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
// Fixtures — see test-fixtures.ts (shared with compile-check.test.ts)
// ============================================================================
// Projector matrix
//
// Every entry normalizes its projector's real export(s) to a single
// `(ref, name) => string` shape so the same loop below can drive all of them.
// Projectors whose primitive output isn't a string (JTD/JSON Schema/OpenAPI
// return plain objects; standard-schema returns an object of closures) are
// wrapped to produce a string via JSON.stringify / a shape check, matching
// what those projectors' own unit tests assert about their output.
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
  // protobuf is NOT struct-only: toProtoMessage handles a union-rooted
  // TypeRef directly by synthesizing a wrapper message with a `oneof` (§
  // "Using Oneof") holding one field per variant — see toProtoUnionMessage
  // in protobuf.ts.
  { name: "protobuf", fn: (ref, name) => renderProto([toProtoMessage(name, ref)]) },
  // capnp is NOT struct-only: toCapnpStruct handles a union-rooted TypeRef
  // directly by synthesizing a wrapper struct with an anonymous union (§
  // "Unions") — see toCapnpUnionStruct in capnp.ts.
  { name: "capnp", fn: (ref, name) => renderCapnp([toCapnpStruct(name, ref)]) },
  {
    name: "flatbuffers",
    // toFlatBuffersTable only lowers `object`/`tuple` roots (a single table
    // declaration). A `union` root (e.g. the discriminated-union fixture) has
    // no table to build — it must go through toFlatBuffersDeclarations, which
    // dispatches per-kind (table/enum/union/service) over a registry, unlike
    // protobuf/capnp/sql which have no non-object-root entry point at all.
    fn: (ref, name) =>
      ref.shape.kind === "object" || ref.shape.kind === "tuple"
        ? toFlatBuffersTable(name, ref)
        : toFlatBuffersDeclarations({ [name]: ref }),
  },
  // toCreateTable now handles both `object` and `union` roots — a union root
  // lowers via `opts.unionLayout` (default: `singleTableInheritanceSqlLayout()`),
  // same as `toMssqlCreateTableFromRef` below. See sql.ts's `SqlUnionLayout`.
  { name: "sql", fn: (ref, name) => toCreateTable(name, ref) },
  // toMssqlCreateTableFromRef (unlike the older, still-exported
  // `toMssqlCreateTable`, which only ever took an already-extracted `fields`
  // record) accepts the TypeRef directly, so it can see and dispatch on a
  // union root the same way sql.ts's `toCreateTable` does.
  { name: "sql-mssql", fn: (ref, name) => toMssqlCreateTableFromRef(name, ref) },
]

// Struct-shaped projectors that require an `object` root and cannot represent
// a bare `union` root directly. Empty for now — every projector in the matrix
// above can now take a union root:
//
// protobuf's toProtoMessage synthesizes a `oneof` wrapper message for a union
// root (see the protobuf wrapper above); flatbuffers has a second entry point
// (toFlatBuffersDeclarations) that dispatches per-kind over a registry, so a
// `union` root lowers to a `union` declaration directly (see the flatbuffers
// wrapper above); capnp's toCapnpStruct synthesizes a wrapper struct with an
// anonymous union for a union-rooted TypeRef (see toCapnpUnionStruct in
// capnp.ts); sql's toCreateTable and sql-mssql's toMssqlCreateTableFromRef
// both dispatch a union root through a pluggable `SqlUnionLayout`/
// `MssqlUnionLayout` strategy (default: single-table-inheritance) — see
// `singleTableInheritanceSqlLayout`/`tablePerVariantSqlLayout` in sql.ts.
//
// Kept as a live mechanism (not deleted) so a future struct-only projector
// added to the matrix has somewhere to register itself as `.todo` rather than
// asserted to throw.
const structOnlyProjectorNames = new Set<string>([])

describe("cross-projector smoke tests", () => {
  for (const { name: fixtureName, ref } of fixtures) {
    const isStructIncompatible = ref.shape.kind !== "object"

    describe(fixtureName, () => {
      for (const { name, fn } of projectors) {
        if (isStructIncompatible && structOnlyProjectorNames.has(name)) {
          test.todo(
            `${fixtureName} -> ${name} (root kind "${ref.shape.kind}" isn't struct-shaped; ` +
              `needs union/oneof synthesis support before this can go through ${name})`,
            () => {
              const result = fn(ref, "Root")
              expect(typeof result).toBe("string")
              expect(result.length).toBeGreaterThan(0)
            },
          )
          continue
        }

        test(`${fixtureName} -> ${name}`, () => {
          const result = fn(ref, "Root")
          expect(typeof result).toBe("string")
          expect(result.length).toBeGreaterThan(0)
        })
      }
    })
  }
})
