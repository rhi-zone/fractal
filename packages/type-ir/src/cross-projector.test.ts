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
import { t, types, type TypeRef } from "./index.ts"
import { bytes, datetime, email, int32 } from "./kinds/common.ts"

import { toZodDeclaration } from "./typescript-zod.ts"
import { toPydantic } from "./python-pydantic.ts"
import { toPython } from "./python-dataclass.ts"
import { toAttrs } from "./python-attrs.ts"
import { toGo } from "./go-encoding-json.ts"
import { toRust } from "./rust-serde.ts"
import { toJavaDeclaration } from "./java-jackson.ts"
import { toGsonDeclaration } from "./java-gson.ts"
import { toCSharp } from "./csharp-systemtextjson.ts"
import { toCSharpNewtonsoft } from "./csharp-newtonsoft.ts"
import { toSwift } from "./swift-codable.ts"
import { toKotlin } from "./kotlin-kotlinx.ts"
import { toDart } from "./dart-json-serializable.ts"
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
import { toFlatBuffersTable } from "./flatbuffers.ts"
import { toCreateTable } from "./sql.ts"
import { toMssqlCreateTable } from "./sql-mssql.ts"
import { toJtd } from "./jtd.ts"
import { toStandardSchema } from "./standard-schema.ts"
import { compileValidator } from "./compile.ts"

// ============================================================================
// Fixtures
// ============================================================================

function obj(fields: Record<string, TypeRef>): TypeRef {
  return t(types.object(fields))
}

function opt(ref: TypeRef): TypeRef {
  return { shape: ref.shape, meta: { ...ref.meta, optional: true } }
}

// (a) E-commerce Order — realistic nested API schema.
const address = obj({
  street: t(types.string),
  city: t(types.string),
  state: t(types.string),
  zip: t(types.string),
  country: t(types.string),
})

const orderItem = obj({
  productId: t(types.string),
  quantity: t(types.integer),
  price: t(types.number),
  variant: opt(t(types.enum(["small", "medium", "large"]))),
})

const customer = obj({
  name: t(types.string),
  email: email(),
  address,
})

const ecommerceOrder = obj({
  id: t(types.integer),
  status: t(types.enum(["pending", "shipped", "delivered", "cancelled"])),
  items: t(types.array(orderItem)),
  customer,
  total: t(types.number),
  createdAt: datetime(),
  notes: opt(t(types.string)),
})

// (b) Recursive Tree — self-referential via `ref`. Each projector renders a
// standalone TypeRef, so the inner `ref` just needs to render as the type's
// own name (verified against typescript-zod.ts / json-schema.ts / etc. — none
// of them require a resolvable registry for a bare `toX(ref)` call).
const treeNode = obj({
  value: t(types.string),
  children: t(types.array(t(types.ref("TreeNode")))),
})

// (c) Discriminated Union API Response — polymorphism via a union of tagged
// objects. Root kind is `union`, not `object` — struct-shaped projectors
// (protobuf/capnp/flatbuffers/sql) require an `object` root and are expected
// to throw on this fixture; see the `.todo` block below.
const successResponse = obj({
  type: t(types.literal("success")),
  data: obj({ result: t(types.string) }),
})
const errorResponse = obj({
  type: t(types.literal("error")),
  code: t(types.integer),
  message: t(types.string),
})
const paginatedResponse = obj({
  type: t(types.literal("paginated")),
  items: t(types.array(t(types.string))),
  cursor: t(types.string),
  hasMore: t(types.boolean),
})
const apiResponse = t(types.union([successResponse, errorResponse, paginatedResponse]))

// (d) Kitchen Sink — as many kind/constraint combinations as reasonably fit
// in one object.
const kitchenSinkLevel3 = obj({
  deepValue: t(types.string, { minLength: 1, maxLength: 50 }),
})
const kitchenSinkLevel2 = obj({
  level3: kitchenSinkLevel3,
  tags: t(types.array(t(types.string))),
})
const kitchenSink = obj({
  aBoolean: t(types.boolean),
  aNumber: t(types.number, { minimum: 0, maximum: 100 }),
  anInteger: t(types.integer, { minimum: 0 }),
  aString: t(types.string, { pattern: "^[a-z]+$" }),
  aNull: t(types.null),
  anUnknown: t(types.unknown),
  optionalField: opt(t(types.string)),
  nullableField: { shape: types.string, meta: { nullable: true } },
  anEnum: t(types.enum(["red", "green", "blue"]), { description: "primary colors" }),
  nested: kitchenSinkLevel2,
  arrayOfArrays: t(types.array(t(types.array(t(types.integer))))),
  aMap: t(types.map(t(types.string), t(types.number))),
  aTuple: t(types.tuple([t(types.string), t(types.integer), t(types.boolean)])),
  aUnion: t(types.union([t(types.string), t(types.integer)])),
  aLiteral: t(types.literal("fixed-value")),
  int32Field: int32(),
  bytesField: bytes(),
  datetimeField: datetime(),
})

const fixtures: { name: string; ref: TypeRef }[] = [
  { name: "E-commerce Order", ref: ecommerceOrder },
  { name: "Recursive Tree", ref: treeNode },
  { name: "Discriminated Union API Response", ref: apiResponse },
  { name: "Kitchen Sink", ref: kitchenSink },
]

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
  { name: "csharp-systemtextjson", fn: (ref, name) => toCSharp(ref, name) },
  { name: "csharp-newtonsoft", fn: (ref, name) => toCSharpNewtonsoft(ref, name) },
  { name: "swift-codable", fn: (ref, name) => toSwift(ref, name) },
  { name: "kotlin-kotlinx", fn: (ref, name) => toKotlin(ref, name) },
  { name: "dart-json-serializable", fn: (ref, name) => toDart(ref, name) },
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
  // Struct-shaped projectors: `object`-root only (each casts `ref.shape` to
  // the `object` variant internally — see toProtoMessage/toCapnpStruct in
  // protobuf.ts/capnp.ts). Non-object roots (the discriminated union fixture)
  // are expected to throw here; see the `.todo` block below instead of this
  // list for that combination.
  { name: "protobuf", fn: (ref, name) => renderProto([toProtoMessage(name, ref)]) },
  { name: "capnp", fn: (ref, name) => renderCapnp([toCapnpStruct(name, ref)]) },
  { name: "flatbuffers", fn: (ref, name) => toFlatBuffersTable(name, ref) },
  { name: "sql", fn: (ref, name) => toCreateTable(name, ref) },
  {
    name: "sql-mssql",
    fn: (ref, name) => {
      if (ref.shape.kind !== "object") throw new Error("sql-mssql requires an object-root TypeRef")
      return toMssqlCreateTable(name, ref.shape.fields)
    },
  },
]

// Struct-shaped projectors that require an `object` (or, for flatbuffers,
// `object`/`tuple`) root and cannot represent a bare `union` root directly.
// The discriminated-union fixture legitimately can't go through these without
// the caller pre-flattening the union into a oneof/service construct that
// isn't this package's concern at the TypeRef level — tracked as `.todo`
// rather than asserted to throw, since a future projector enhancement (e.g.
// protobuf `oneof` synthesis from a tagged union) could close this gap.
const structOnlyProjectorNames = new Set(["protobuf", "capnp", "flatbuffers", "sql", "sql-mssql"])

describe("cross-projector smoke tests", () => {
  for (const { name: fixtureName, ref } of fixtures) {
    const isStructIncompatible = ref.shape.kind !== "object"

    describe(fixtureName, () => {
      for (const { name, fn } of projectors) {
        if (isStructIncompatible && structOnlyProjectorNames.has(name)) {
          test.todo(
            `${fixtureName} -> ${name} (root kind "${ref.shape.kind}" isn't struct-shaped; ` +
              `needs union/oneof synthesis support before this can go through ${name})`,
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
