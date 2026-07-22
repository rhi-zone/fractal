// Round-trip fidelity tests: ingest a schema authored as a *raw JSON
// document* (not built via `t()`/`types` — that's the ingester's own unit
// tests' job, see from-json-schema.test.ts's "round-trip:
// fromJsonSchema(toJsonSchema(ref))" describe block, which starts from a
// TypeRef and checks TypeRef -> schema -> TypeRef). This file starts one
// level further out: schema -> TypeRef -> schema -> TypeRef, comparing the
// two TypeRef trees structurally. That's the direction that actually
// exercises "does a real external schema survive a round trip," since a
// TypeRef built by hand is already in the ingester's own preferred shape.
//
// Per the task's guidance: never compare the two JSON Schema/OpenAPI
// documents literally (key order, `$ref` spelling, spurious annotations a
// projector adds are all expected to differ) — only the ingested TypeRef
// trees are compared, via `toEqual` (structural deep equality).
import { describe, expect, test } from "bun:test"
import { t, types, typeRefDocument, type TypeRef, type TypeRefDocument } from "./index.ts"
import { fromJsonSchema, type JsonSchema } from "./from-json-schema.ts"
import { toJsonSchema, toJsonSchemaDocument } from "./json-schema.ts"
import { fromOpenApi30 } from "./from-openapi.ts"
import { toOpenApi30, toOpenApi30Document, type OpenApi30Schema } from "./openapi30.ts"

// ============================================================================
// Helpers
// ============================================================================

/** `fromJsonSchema(original)` vs `fromJsonSchema(toJsonSchema(fromJsonSchema(original)))`. */
function roundTrip(schema: JsonSchema): TypeRef {
  const original = fromJsonSchema(schema)
  const reingested = fromJsonSchema(toJsonSchema(original))
  expect(reingested).toEqual(original)
  return original
}

/** Neither `fromJsonSchema` nor `toJsonSchema` knows about a top-level
 * `$defs` map (see index.ts's `TypeRefDocument`/`resolveRef` — resolving a
 * `ref` against a document's `defs` is a caller concern, not the
 * per-schema ingester's). This assembles/disassembles the document layer by
 * hand, exactly the way a caller wiring the two together would. */
function fromJsonSchemaDocument(schema: JsonSchema): TypeRefDocument {
  const { $defs, ...rest } = schema as JsonSchema & { $defs?: Record<string, JsonSchema> }
  const defs: Record<string, TypeRef> = {}
  if ($defs !== undefined) {
    for (const [name, defSchema] of Object.entries($defs)) defs[name] = fromJsonSchema(defSchema)
  }
  return typeRefDocument(fromJsonSchema(rest), defs)
}

function roundTripDocument(schema: JsonSchema): TypeRefDocument {
  const original = fromJsonSchemaDocument(schema)
  const projected = toJsonSchemaDocument(original)
  const reingested = fromJsonSchemaDocument(projected)
  expect(reingested).toEqual(original)
  return original
}

function roundTripOpenApi(schema: OpenApi30Schema): TypeRef {
  const original = fromOpenApi30(schema)
  const reingested = fromOpenApi30(toOpenApi30(original))
  expect(reingested).toEqual(original)
  return original
}

/** Same caller-assembles-the-document-layer approach as
 * `fromJsonSchemaDocument`, but for OAS 3.0's `components.schemas` map
 * (see openapi30.ts's `toOpenApi30Document` doc comment — it explicitly
 * says merging into a full document is "the caller's" job). */
function roundTripOpenApiDocument(rootSchema: OpenApi30Schema, componentSchemas: Record<string, OpenApi30Schema>): TypeRefDocument {
  const defs: Record<string, TypeRef> = {}
  for (const [name, s] of Object.entries(componentSchemas)) defs[name] = fromOpenApi30(s)
  const original = typeRefDocument(fromOpenApi30(rootSchema), defs)

  const projected = toOpenApi30Document(original)

  const reDefs: Record<string, TypeRef> = {}
  for (const [name, s] of Object.entries(projected.components.schemas)) reDefs[name] = fromOpenApi30(s)
  const reingested = typeRefDocument(fromOpenApi30(projected.schema), reDefs)

  expect(reingested).toEqual(original)
  return original
}

// ============================================================================
// JSON Schema round-trips
// ============================================================================

describe("JSON Schema round-trips", () => {
  test("primitives", () => {
    expect(roundTrip({ type: "boolean" })).toEqual(t(types.boolean))
    expect(roundTrip({ type: "number" })).toEqual(t(types.number))
    expect(roundTrip({ type: "integer" })).toEqual(t(types.integer))
    expect(roundTrip({ type: "string" })).toEqual(t(types.string))
  })

  test("object with required and optional fields", () => {
    const ref = roundTrip({
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["id", "name"],
    })
    expect(ref).toEqual(
      t(
        types.object({
          id: t(types.string),
          name: t(types.string),
          nickname: t(types.string, { optional: true }),
        }),
      ),
    )
  })

  test("nested objects", () => {
    roundTrip({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
          required: ["street", "city"],
        },
      },
      required: ["address"],
    })
  })

  test("arrays with typed items", () => {
    roundTrip({ type: "array", items: { type: "integer" } })
    roundTrip({
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    })
  })

  test("string enum", () => {
    roundTrip({ enum: ["active", "inactive", "pending"] })
  })

  test("integer enum", () => {
    // json-schema.ts's `enum` handler always re-emits `{ type: "string", ... }`
    // (see its handlers.enum) — a JSON-literal-level lossy quirk (the
    // projected schema no longer says "these are integers"), but the
    // TypeRef tree itself round-trips: `fromJsonSchema` dispatches on
    // `Array.isArray(schema.enum)` before ever looking at `type`, so the
    // reingested members are unchanged.
    roundTrip({ type: "integer", enum: [1, 2, 3] })
  })

  test("allOf composition (intersection)", () => {
    roundTrip({
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { createdAt: { type: "string", format: "date-time" } }, required: ["createdAt"] },
      ],
    })
  })

  test("oneOf union", () => {
    roundTrip({
      oneOf: [{ type: "string" }, { type: "integer" }, { type: "boolean" }],
    })
  })

  test("anyOf union", () => {
    roundTrip({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "integer" } }, required: ["b"] },
      ],
    })
  })

  test("discriminated union (oneOf + discriminator)", () => {
    const ref = roundTrip({
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "circle" }, radius: { type: "number" } },
          required: ["kind", "radius"],
        },
        {
          type: "object",
          properties: { kind: { const: "square" }, side: { type: "number" } },
          required: ["kind", "side"],
        },
      ],
      discriminator: { propertyName: "kind" },
    })
    expect(ref.meta.discriminator).toBe("kind")
  })

  test("nullable via type array form", () => {
    roundTrip({ type: ["string", "null"] })
  })

  test("nullable via anyOf-with-null form (complex type)", () => {
    roundTrip({ anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] })
  })

  test("$ref resolution through $defs", () => {
    const doc = roundTripDocument({
      $ref: "#/$defs/User",
      $defs: {
        User: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id", "name"],
        },
      },
    })
    expect(doc.root).toEqual(t(types.ref("User")))
    expect(doc.defs.User).toEqual(
      t(types.object({ id: t(types.string), name: t(types.string) })),
    )
  })

  test("recursive type (tree node $refs itself)", () => {
    const doc = roundTripDocument({
      $ref: "#/$defs/TreeNode",
      $defs: {
        TreeNode: {
          type: "object",
          properties: {
            value: { type: "integer" },
            children: { type: "array", items: { $ref: "#/$defs/TreeNode" } },
          },
          required: ["value", "children"],
        },
      },
    })
    expect(doc.defs.TreeNode).toEqual(
      t(
        types.object({
          value: t(types.integer),
          children: t(types.array(t(types.ref("TreeNode")))),
        }),
      ),
    )
  })

  test("string formats", () => {
    roundTrip({ type: "string", format: "date-time" })
    roundTrip({ type: "string", format: "email" })
    roundTrip({ type: "string", format: "uuid" })
    roundTrip({ type: "string", format: "uri" })
  })

  test("numeric constraints", () => {
    roundTrip({ type: "integer", minimum: 0, maximum: 100, multipleOf: 5 })
  })

  test("string constraints", () => {
    roundTrip({ type: "string", minLength: 1, maxLength: 20, pattern: "^[a-z]+$" })
  })

  test("default values", () => {
    const ref = roundTrip({ type: "integer", default: 0 })
    expect(ref.meta.default).toBe(0)
  })

  test("description metadata", () => {
    const ref = roundTrip({ type: "string", description: "a human name" })
    expect(ref.meta.description).toBe("a human name")
  })

  // `title` (JSON Schema draft 2020-12 §9.1) has no handler on either side:
  // from-json-schema.ts's `extractMeta` doesn't read it, and json-schema.ts's
  // `withMeta` doesn't write it — it isn't merely lossy on the round trip,
  // it's dropped on first ingestion, before a round trip even enters the
  // picture. Not a round-trip bug per se (there's no regression to catch),
  // but flagged here since the task calls it out explicitly as a category to
  // verify.
  test.todo("title metadata (currently dropped entirely — no extractMeta/withMeta handler for `title`)")
})

// ============================================================================
// OpenAPI 3.0 round-trips
// ============================================================================

describe("OpenAPI 3.0 round-trips", () => {
  test("component schema with $ref", () => {
    const doc = roundTripOpenApiDocument(
      { $ref: "#/components/schemas/User" },
      {
        User: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" }, name: { type: "string" } },
          required: ["id", "name"],
        },
      },
    )
    expect(doc.root).toEqual(t(types.ref("User")))
  })

  test("discriminated union via discriminator object", () => {
    const ref = roundTripOpenApi({
      oneOf: [
        { type: "object", properties: { kind: { enum: ["cat"] }, meow: { type: "boolean" } }, required: ["kind"] },
        { type: "object", properties: { kind: { enum: ["dog"] }, bark: { type: "boolean" } }, required: ["kind"] },
      ],
      discriminator: { propertyName: "kind" },
    })
    expect(ref.meta.discriminator).toBe("kind")
  })

  test("nested object with nullable field and numeric constraints", () => {
    roundTripOpenApi({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        score: { type: "integer", minimum: 0, maximum: 100 },
        note: { type: "string", nullable: true },
      },
      required: ["id", "score"],
    })
  })

  // Request/response body schemas and full path/operation documents are
  // outside fromOpenApi30/toOpenApi30's scope — both operate purely at the
  // Schema Object level (see from-openapi.ts's doc comment: "$refs are left
  // unresolved... resolution against a document's defs is a caller
  // concern"). The document-assembly layer that would wrap a Schema Object
  // into a requestBody/response lives one level up, per json-schema.ts's
  // own note pointing at "http-api-projector's openapi.ts" — not present in
  // this package, so there is nothing here to round-trip beyond the
  // component-schema case above.
})
