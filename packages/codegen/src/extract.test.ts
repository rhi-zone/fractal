// packages/codegen/src/extract.test.ts — build-time extractor tests
//
// Covers the four contracts of the slice:
//   1. object type (primitive + optional + array + nested) → correct schema
//   2. leading JSDoc → description
//   3. derived schema flows into a real MCP tool's inputSchema (via toTools)
//   4. exotic type (union) punts to `unknown` with a TODO $comment

import { describe, expect, it } from "bun:test"
import { toTools } from "@rhi-zone/fractal-mcp"
import { toJsonSchema } from "@rhi-zone/fractal-type-ir/json-schema"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import {
  extractToolSchemas,
  extractToolTypeRefs,
  schemaFromFunctionNode,
  schemaFromReturnType,
  schemaFromType,
  typeRefFromFunctionNode,
  typeRefFromReturnType,
  typeRefFromType,
} from "./index.ts"
import { tree } from "./__fixtures__/tree.fixture.ts"
import { createExtractorProgram, opFunctionNode } from "./extract.ts"
import ts from "typescript"

const FIXTURE = `${import.meta.dir}/__fixtures__/tree.fixture.ts`
const schemas = extractToolSchemas(FIXTURE)

const TYPEREF_FIXTURE = `${import.meta.dir}/__fixtures__/typeref.fixture.ts`

/** Locate an exported const's function-typed initializer node by name. */
function findExportedFn(source: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined
  const visit = (n: ts.Node): void => {
    if (
      !found &&
      ts.isVariableStatement(n) &&
      n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of n.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          found = opFunctionNode(decl.initializer)
        }
      }
    }
    if (!found) ts.forEachChild(n, visit)
  }
  visit(source)
  if (!found) throw new Error(`findExportedFn: ${name} not found`)
  return found
}

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
      | Record<string, { type?: string; $comment?: string }>
      | undefined)?.q
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
    expect(output?.$comment).toMatch(/TODO\(codegen\)/)
    expect(output?.$comment).toMatch(/union/)
  })
})

// ============================================================================
// 6. TypeRef extraction — TS type → TypeRef → JSON Schema
// ============================================================================

describe("TypeRef extraction", () => {
  const typeRefs = extractToolTypeRefs(FIXTURE)

  it("typeRefFromType produces correct shapes for primitives / optional / array / nested fields", () => {
    const input = typeRefs["users_create"]!.input
    expect(input.shape.kind).toBe("object")
    const fields = (input.shape as { kind: "object"; fields: Record<string, import("@rhi-zone/fractal-type-ir").TypeRef> }).fields
    expect(fields.name?.shape.kind).toBe("string")
    expect(fields.age?.shape.kind).toBe("number")
    expect(fields.age?.meta.optional).toBe(true)
    expect(fields.roles?.shape.kind).toBe("array")
    expect((fields.roles?.shape as { element: { shape: { kind: string } } }).element.shape.kind).toBe("string")
    expect(fields.address?.shape.kind).toBe("object")
  })

  it("typeRefFromFunctionNode produces the correct TypeRef for a function input", () => {
    const input = typeRefs["users_userId_get"]!.input
    expect(toJsonSchema(input)).toEqual(schemas["users_userId_get"]!.inputSchema)
  })

  it("typeRefFromReturnType unwraps Result<T,E> to T's TypeRef", () => {
    const output = typeRefs["fallible_compute"]!.output!
    expect(output.shape.kind).toBe("object")
    expect(toJsonSchema(output)).toEqual(schemas["fallible_compute"]!.outputSchema!)
  })

  it("extractToolTypeRefs carries the JSDoc description alongside the TypeRefs", () => {
    expect(typeRefs["users_create"]!.description).toBe("Create a new user account.")
    expect(typeRefs["users_userId_get"]!.description).toBeUndefined()
  })

  it("punted types produce t(types.unknown, { $comment }) — no `type` discriminant carried over", () => {
    const fields = (typeRefs["search_run"]!.input.shape as {
      kind: "object"
      fields: Record<string, import("@rhi-zone/fractal-type-ir").TypeRef>
    }).fields
    const q = fields.q!
    expect(q.shape.kind).toBe("unknown")
    expect(q.meta.$comment).toMatch(/TODO\(codegen\)/)
    expect(q.meta.$comment).toMatch(/union/)
  })

  it("round-trips: toJsonSchema(typeRefFromType(...)) matches schemaFromType(...) for non-punted tools", () => {
    const names = [
      "users_create",
      "users_userId_get",
      "async_fetch",
      "fallible_compute",
      "barrel_query",
      "generic_search",
      "promiseResult_load",
    ]
    for (const name of names) {
      expect(toJsonSchema(typeRefs[name]!.input)).toEqual(schemas[name]!.inputSchema)
      if (typeRefs[name]!.output !== undefined) {
        expect(toJsonSchema(typeRefs[name]!.output!)).toEqual(schemas[name]!.outputSchema!)
      }
    }
  })
})

// ============================================================================
// 7. TypeRef extraction functions called directly (not via the tree walker)
// ============================================================================

describe("typeRefFromType / typeRefFromFunctionNode / typeRefFromReturnType, called directly", () => {
  const program = createExtractorProgram(TYPEREF_FIXTURE)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(TYPEREF_FIXTURE)!
  const fn = findExportedFn(source, "sample")

  it("typeRefFromFunctionNode lowers the input parameter to a TypeRef matching schemaFromFunctionNode", () => {
    const inputRef = typeRefFromFunctionNode(fn, checker)
    expect(inputRef.shape.kind).toBe("object")
    expect(toJsonSchema(inputRef)).toEqual(schemaFromFunctionNode(fn, checker))
  })

  it("typeRefFromType matches schemaFromType for the same resolved parameter type", () => {
    const fnType = checker.getTypeAtLocation(fn)
    const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
    const [param] = sig!.getParameters()
    const paramType = checker.getTypeOfSymbolAtLocation(param!, fn)
    const ref = typeRefFromType(paramType, checker, fn)
    expect(toJsonSchema(ref)).toEqual(schemaFromType(paramType, checker, fn))
  })

  it("typeRefFromReturnType unwraps Result<T,E> to T's TypeRef matching schemaFromReturnType", () => {
    const outputRef = typeRefFromReturnType(fn, checker)
    expect(outputRef.shape.kind).toBe("object")
    expect(toJsonSchema(outputRef)).toEqual(schemaFromReturnType(fn, checker))
    expect(toJsonSchema(outputRef)).toEqual({
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
    })
  })
})

// ============================================================================
// 8. Gap fixes — tuples, index signatures, class filtering, nested Promise,
//    single literals, recursive types
// ============================================================================

describe("typeRefFromType gap fixes", () => {
  const program = createExtractorProgram(TYPEREF_FIXTURE)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(TYPEREF_FIXTURE)!

  /** Resolve a top-level `type X = …` alias or `class X …` to its ts.Type. */
  function typeOf(name: string): ts.Type {
    let found: ts.Node | undefined
    const visit = (n: ts.Node): void => {
      if (!found && ts.isTypeAliasDeclaration(n) && n.name.text === name) found = n.name
      if (!found && ts.isClassDeclaration(n) && n.name?.text === name) found = n.name
      if (!found) ts.forEachChild(n, visit)
    }
    visit(source)
    if (!found) throw new Error(`typeOf: ${name} not found`)
    return checker.getTypeAtLocation(found)
  }

  it("lowers a tuple to types.tuple, not an indexed object", () => {
    const ref = typeRefFromType(typeOf("TupleType"), checker, source)
    expect(ref.shape.kind).toBe("tuple")
    const elements = (ref.shape as { kind: "tuple"; elements: TypeRef[] }).elements
    expect(elements.map((e) => e.shape.kind)).toEqual(["string", "number", "boolean"])
    expect(toJsonSchema(ref)).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      items: false,
    })
  })

  it("lowers Record<string, number> to types.map", () => {
    const ref = typeRefFromType(typeOf("RecordType"), checker, source)
    expect(ref.shape.kind).toBe("map")
    const map = ref.shape as { kind: "map"; key: TypeRef; value: TypeRef }
    expect(map.key.shape.kind).toBe("string")
    expect(map.value.shape.kind).toBe("number")
    expect(toJsonSchema(ref)).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    })
  })

  it("lowers an explicit string index signature to types.map", () => {
    const ref = typeRefFromType(typeOf("IndexSigType"), checker, source)
    expect(ref.shape.kind).toBe("map")
    const map = ref.shape as { kind: "map"; key: TypeRef; value: TypeRef }
    expect(map.key.shape.kind).toBe("string")
    expect(map.value.shape.kind).toBe("boolean")
  })

  it("keeps a single string literal as types.literal, not widened to string", () => {
    const ref = typeRefFromType(typeOf("SingleLiteral"), checker, source)
    expect(ref.shape.kind).toBe("literal")
    expect((ref.shape as { kind: "literal"; value: unknown }).value).toBe("active")
  })

  it("keeps a single numeric literal as types.literal", () => {
    const ref = typeRefFromType(typeOf("NumericLiteral"), checker, source)
    expect(ref.shape.kind).toBe("literal")
    expect((ref.shape as { kind: "literal"; value: unknown }).value).toBe(42)
  })

  it("keeps a single boolean literal as types.literal", () => {
    const ref = typeRefFromType(typeOf("BooleanLiteral"), checker, source)
    expect(ref.shape.kind).toBe("literal")
    expect((ref.shape as { kind: "literal"; value: unknown }).value).toBe(true)
  })

  it("still punts a union of literals (LiteralType) — union punt takes precedence", () => {
    const ref = typeRefFromType(typeOf("LiteralType"), checker, source)
    expect(ref.shape.kind).toBe("unknown")
    expect(ref.meta.$comment).toMatch(/union/)
  })

  it("filters private/protected fields and methods off a class instance", () => {
    const ref = typeRefFromType(typeOf("ClassInstanceField"), checker, source)
    expect(ref.shape.kind).toBe("object")
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    const owner = fields.owner!
    expect(owner.shape.kind).toBe("object")
    const ownerFields = (owner.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(Object.keys(ownerFields)).toEqual(["name"])
    expect(ownerFields.name?.shape.kind).toBe("string")
  })

  it("unwraps a nested Promise<T> field to T's TypeRef", () => {
    const ref = typeRefFromType(typeOf("PromiseField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.data?.shape.kind).toBe("string")
  })

  it("does not stack-overflow on an array-mediated recursive type, and refs itself", () => {
    const ref = typeRefFromType(typeOf("RecursiveType"), checker, source)
    expect(ref.shape.kind).toBe("object")
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.name?.shape.kind).toBe("string")
    const children = fields.children!
    expect(children.shape.kind).toBe("array")
    const elemRef = (children.shape as { kind: "array"; element: TypeRef }).element
    expect(elemRef.shape.kind).toBe("ref")
    expect((elemRef.shape as { kind: "ref"; target: string }).target).toBe("RecursiveType")
  })

  it("does not stack-overflow on a directly self-referential type, and refs itself", () => {
    const ref = typeRefFromType(typeOf("DirectRecursive"), checker, source)
    expect(ref.shape.kind).toBe("object")
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    const self = fields.self!
    expect(self.shape.kind).toBe("ref")
    expect((self.shape as { kind: "ref"; target: string }).target).toBe("DirectRecursive")
  })
})
