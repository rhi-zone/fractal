// packages/codegen/src/extract.test.ts — build-time extractor tests
//
// Covers the four contracts of the slice:
//   1. object type (primitive + optional + array + nested) → correct schema
//   2. leading JSDoc → description
//   3. derived schema flows into a real MCP tool's inputSchema (via toTools)
//   4. exotic type (union) punts to { type: "object" } with a TODO $comment

import { describe, expect, it } from "bun:test"
import { toTools } from "@rhi-zone/fractal-mcp"
import { extractToolSchemas } from "./index.ts"
import { tree } from "./__fixtures__/tree.fixture.ts"

const FIXTURE = `${import.meta.dir}/__fixtures__/tree.fixture.ts`
const schemas = extractToolSchemas(FIXTURE)

// ============================================================================
// 1. Object type → JSON-Schema (primitive + optional + array + nested)
// ============================================================================

describe("schema derivation from op input type", () => {
  it("lowers primitive / optional / array / nested fields correctly", () => {
    expect(schemas["users_create"]?.inputSchema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" }, // optional → present but not required
        roles: { type: "array", items: { type: "string" } },
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            zip: { type: "string" }, // optional → not required
          },
          required: ["street"],
        },
      },
      required: ["name", "roles", "address"],
    })
  })

  it("threads a param-node op's input type into its namespaced tool name", () => {
    expect(schemas["users_userId_get"]?.inputSchema).toEqual({
      type: "object",
      properties: { userId: { type: "string" } },
      required: ["userId"],
    })
  })
})

// ============================================================================
// 2. JSDoc → description
// ============================================================================

describe("JSDoc extraction", () => {
  it("extracts the leading doc comment as the description", () => {
    expect(schemas["users_create"]?.description).toBe("Create a new user account.")
  })

  it("omits description when the op has no JSDoc", () => {
    expect(schemas["users_userId_get"]?.description).toBeUndefined()
  })
})

// ============================================================================
// 3. Derived schema flows into the MCP tool (end-to-end)
// ============================================================================

describe("MCP tool carries the derived inputSchema + description", () => {
  const tools = toTools(tree, { schemas })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

  it("replaces the { type: 'object' } placeholder with the real schema", () => {
    const t = byName["users_create"]!
    expect(t.inputSchema).toEqual(schemas["users_create"]!.inputSchema)
    expect(t.inputSchema).not.toEqual({ type: "object" })
    expect((t.inputSchema.properties as Record<string, unknown>).name).toEqual({
      type: "string",
    })
  })

  it("uses the JSDoc-derived description as the fallback", () => {
    expect(byName["users_create"]!.description).toBe("Create a new user account.")
  })

  it("without a schema map, inputSchema stays the spec-minimum placeholder", () => {
    const t = toTools(tree).find((x) => x.name === "users_create")!
    expect(t.inputSchema).toEqual({ type: "object" })
  })
})

// ============================================================================
// 4. Fallback fires for an unhandled (union) type — TODO-tagged
// ============================================================================

describe("fallback for exotic types", () => {
  it("punts a union field to { type: 'object' } with a TODO $comment", () => {
    const q = (schemas["search_run"]?.inputSchema.properties as
      | Record<string, { type: string; $comment?: string }>
      | undefined)?.q
    expect(q?.type).toBe("object")
    expect(q?.$comment).toMatch(/TODO\(codegen\)/)
    expect(q?.$comment).toMatch(/union/)
  })
})

// ============================================================================
// 5. outputSchema extraction from op return types — Result<T,E> unwrapping
// ============================================================================

describe("outputSchema derivation", () => {
  it("extracts outputSchema for a plain object return", () => {
    expect(schemas["users_create"]?.outputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    })
  })

  it("unwraps Promise<T> return type to T's schema", () => {
    expect(schemas["async_fetch"]?.outputSchema).toEqual({
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    })
  })

  // ── Result unwrapping — 5 cases ────────────────────────────────────────────

  // (a) Direct import: Result<T,E> annotated return → syntax path extracts T
  it("(a) direct Result<T,E> return unwraps to T's schema via syntax path", () => {
    expect(schemas["fallible_compute"]?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
    })
  })

  // (b) Barrel re-export: `import type { Result as ResultFromBarrel } from "./barrel"`
  //     The syntax path checks the TypeReference identifier name ("Result" after
  //     the barrel re-exports it) — extracts T from the first type argument.
  it("(b) barrel-re-exported Result<T,E> unwraps to T's schema via syntax path", () => {
    expect(schemas["barrel_query"]?.outputSchema).toEqual({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    })
  })

  // (c) Further-generic alias: `type ApiResult<T> = Result<T, string>`.
  //     The syntax path walks the local TypeAliasDeclaration — its body is
  //     Result<T,...> — and extracts the call site's first type argument as T.
  it("(c) further-generic alias ApiResult<T> unwraps to T's schema via syntax path", () => {
    expect(schemas["generic_search"]?.outputSchema).toEqual({
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
    })
  })

  // Promise<Result<T,E>>: syntax path strips Promise first, then unwraps Result
  it("Promise<Result<T,E>> unwraps both layers to T's schema", () => {
    expect(schemas["promiseResult_load"]?.outputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    })
  })

  // Genuine 2-member union that is NOT a Result — must NOT be false-positived.
  // No "Result" identifier in the annotation → syntax path skips it.
  // The union has no ok/value/error DU shape → structural path also skips it.
  it("a different 2-member union with different discriminant does not unwrap (punts)", () => {
    const output = schemas["differentUnion_ping"]?.outputSchema
    expect(output?.type).toBe("object")
    expect(output?.$comment).toMatch(/TODO\(codegen\)/)
    expect(output?.$comment).toMatch(/union/)
  })
})
