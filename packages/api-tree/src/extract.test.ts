// packages/api-tree/src/extract.test.ts — build-time extractor tests
//
// Covers the four contracts of the slice:
//   1. object type (primitive + optional + array + nested) → correct schema
//   2. leading JSDoc → description
//   3. derived schema flows into a real MCP tool's inputSchema (via toTools)
//   4. exotic type (union) punts to `unknown` with a TODO $comment

import { describe, expect, it } from "bun:test"
import { toTools } from "@rhi-zone/fractal-mcp-api-projector"
import { toJsonSchema } from "@rhi-zone/fractal-type-ir/json-schema"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import { extractToolSchemas, extractToolTypeRefs } from "./tree.ts"
import {
  createExtractorProgram,
  opFunctionNode,
  schemaFromFunctionNode,
  schemaFromReturnType,
  schemaFromType,
  typeRefFromFunctionNode,
  typeRefFromReturnType,
  typeRefFromType,
} from "./extract.ts"
import { tree } from "./__fixtures__/tree.fixture.ts"
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
        name: { type: "string", description: "The user's display name." },
        // optional → present but not required; JSDoc + @default both carried.
        age: { type: "number", description: "Age in years.", default: 18 },
        roles: { type: "array", items: { type: "string" } },
        address: {
          type: "object",
          properties: {
            street: { type: "string", description: "Street address line." },
            zip: { type: "string" }, // optional → not required
          },
          required: ["street"],
        },
      },
      required: ["name", "roles", "address"],
    })
  })

  it("follows a named-constant op referenced by identifier (not just inline op() calls)", () => {
    expect(schemas["widgets_list"]?.inputSchema).toEqual({
      type: "object",
      properties: { limit: { type: "number" } },
    })
    expect(schemas["widgets_list"]?.description).toBe("List all widgets in the catalog.")
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
// 1b. Per-field JSDoc → property `description` (+ `@default` → `default`)
// ============================================================================

describe("per-field description extraction (property JSDoc)", () => {
  it("populates description on a top-level property with a leading JSDoc comment", () => {
    const name = schemas["users_create"]?.inputSchema.properties?.name
    expect(name?.description).toBe("The user's display name.")
  })

  it("populates description + default from a JSDoc comment with an @default tag", () => {
    const age = schemas["users_create"]?.inputSchema.properties?.age
    expect(age?.description).toBe("Age in years.")
    expect(age?.default).toBe(18)
  })

  it("omits description for a property without JSDoc", () => {
    const roles = schemas["users_create"]?.inputSchema.properties?.roles
    expect(roles?.description).toBeUndefined()
    const userId = schemas["users_userId_get"]?.inputSchema.properties?.userId
    expect(userId?.description).toBeUndefined()
  })

  it("propagates description on nested object properties", () => {
    const address = schemas["users_create"]?.inputSchema.properties?.address
    expect(address?.properties?.street?.description).toBe("Street address line.")
    // sibling nested field with no JSDoc stays undefined
    expect(address?.properties?.zip?.description).toBeUndefined()
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
      description: "The user's display name.",
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
    expect(q?.$comment).toMatch(/TODO\(type-ir\)/)
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
  // It IS, however, a discriminated union on `kind` — it now extracts fully
  // rather than punting (discriminated-union detection, see extract.ts).
  it("a different 2-member union with a different discriminant does not unwrap as Result — extracts as its own discriminated union instead", () => {
    const output = schemas["differentUnion_ping"]?.outputSchema
    expect(output).toEqual({
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "a" }, x: { type: "number" } },
          required: ["kind", "x"],
        },
        {
          type: "object",
          properties: { kind: { const: "b" }, y: { type: "string" } },
          required: ["kind", "y"],
        },
      ],
      discriminator: { propertyName: "kind" },
    })
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
    expect(q.meta.$comment).toMatch(/TODO\(type-ir\)/)
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

  it("typeRefFromFunctionNode carries no typeName/declarationFile for an anonymous inline parameter type", () => {
    const inputRef = typeRefFromFunctionNode(fn, checker)
    expect(inputRef.meta.typeName).toBeUndefined()
    expect(inputRef.meta.declarationFile).toBeUndefined()
  })

  it("typeRefFromFunctionNode carries meta.typeName/meta.declarationFile for a NAMED (type alias) parameter type", () => {
    const namedFn = findExportedFn(source, "namedParamFn")
    const inputRef = typeRefFromFunctionNode(namedFn, checker)
    expect(inputRef.meta.typeName).toBe("BookQuery")
    expect(inputRef.meta.declarationFile).toBe(TYPEREF_FIXTURE)
    // Structural lowering still happens underneath the provenance metadata —
    // the shape itself is unaffected, only meta gains the two extra keys.
    expect(inputRef.shape.kind).toBe("object")
  })

  it("typeRefFromFunctionNode carries meta.typeName/meta.declarationFile for a NAMED (interface) parameter type", () => {
    const namedFn = findExportedFn(source, "namedInterfaceParamFn")
    const inputRef = typeRefFromFunctionNode(namedFn, checker)
    expect(inputRef.meta.typeName).toBe("BookIdParam")
    expect(inputRef.meta.declarationFile).toBe(TYPEREF_FIXTURE)
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
// AsyncIterable/AsyncGenerator return-type detection — types.stream
// ============================================================================

describe("typeRefFromReturnType detects AsyncIterable/AsyncGenerator return types", () => {
  const program = createExtractorProgram(TYPEREF_FIXTURE)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(TYPEREF_FIXTURE)!

  it("a function returning AsyncIterable<T> lowers to types.stream, T extracted fully", () => {
    const fn = findExportedFn(source, "streamFn")
    const ref = typeRefFromReturnType(fn, checker)
    expect(ref.shape.kind).toBe("stream")
    const element = (ref.shape as { kind: "stream"; element: TypeRef }).element
    expect(element.shape.kind).toBe("object")
    const fields = (element.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.id?.shape.kind).toBe("string")
    expect(toJsonSchema(ref)).toEqual({
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      "x-stream": true,
    })
  })

  it("an async function* (AsyncGenerator<T, void, unknown> inferred return) lowers to types.stream", () => {
    const fnDecl = source.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "asyncGenFn",
    )
    if (!fnDecl) throw new Error("asyncGenFn not found")
    const ref = typeRefFromReturnType(fnDecl, checker)
    expect(ref.shape.kind).toBe("stream")
    const element = (ref.shape as { kind: "stream"; element: TypeRef }).element
    expect(element.shape.kind).toBe("number")
  })

  it("Promise<AsyncIterable<T>> unwraps the Promise first, then detects the stream underneath", () => {
    const fn = findExportedFn(source, "promiseStreamFn")
    const ref = typeRefFromReturnType(fn, checker)
    expect(ref.shape.kind).toBe("stream")
    const element = (ref.shape as { kind: "stream"; element: TypeRef }).element
    expect(element.shape.kind).toBe("string")
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

  it("lowers a union of string literals (LiteralType) to types.enum", () => {
    const ref = typeRefFromType(typeOf("LiteralType"), checker, source)
    expect(ref.shape.kind).toBe("enum")
    expect((ref.shape as { kind: "enum"; members: readonly string[] }).members).toEqual([
      "active",
      "inactive",
    ])
  })

  it("lowers a class-typed field to a purely nominal types.instance (no fields)", () => {
    const ref = typeRefFromType(typeOf("ClassInstanceField"), checker, source)
    expect(ref.shape.kind).toBe("object")
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    const owner = fields.owner!
    expect(owner.shape.kind).toBe("instance")
    const ownerShape = owner.shape as { kind: "instance"; className: string; source: string }
    expect(ownerShape.className).toBe("SampleClass")
    expect(ownerShape.source).toContain("typeref.fixture.ts")
    expect(Object.keys(ownerShape)).toEqual(["kind", "className", "source"])
  })

  it("carries the class's method surface as an interface TypeRef in meta.interface, alongside the nominal instance", () => {
    const ref = typeRefFromType(typeOf("ClassInstanceField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    const owner = fields.owner!
    expect(owner.shape.kind).toBe("instance")

    const iface = owner.meta.interface as TypeRef
    expect(iface).toBeDefined()
    expect(iface.shape.kind).toBe("interface")
    const methods = (iface.shape as { kind: "interface"; methods: Record<string, TypeRef> }).methods
    expect(Object.keys(methods)).toEqual(["greet"])

    const greet = methods.greet!
    expect(greet.shape.kind).toBe("method")
    const greetShape = greet.shape as {
      kind: "method"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
      thisType?: TypeRef
    }
    expect(greetShape.params).toEqual([])
    expect(greetShape.returnType.shape.kind).toBe("string")
    expect(greetShape.thisType?.shape.kind).toBe("instance")
    expect((greetShape.thisType?.shape as { className: string }).className).toBe("SampleClass")
  })

  it("omits meta.interface entirely for a class with no methods", () => {
    const ref = typeRefFromType(typeOf("NoMethodClass"), checker, source)
    expect(ref.shape.kind).toBe("instance")
    expect(ref.meta.interface).toBeUndefined()
  })

  it("unwraps a nested Promise<T> field to T's TypeRef", () => {
    const ref = typeRefFromType(typeOf("PromiseField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.data?.shape.kind).toBe("string")
  })

  it("lowers an AsyncIterable<T> field to types.stream with T's element TypeRef", () => {
    const ref = typeRefFromType(typeOf("AsyncIterableField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.events?.shape.kind).toBe("stream")
    const element = (fields.events?.shape as { kind: "stream"; element: TypeRef }).element
    expect(element.shape.kind).toBe("string")
  })

  it("lowers an AsyncGenerator<T, TReturn, TNext> field to types.stream, dropping TReturn/TNext", () => {
    const ref = typeRefFromType(typeOf("AsyncGeneratorField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.events?.shape.kind).toBe("stream")
    const element = (fields.events?.shape as { kind: "stream"; element: TypeRef }).element
    expect(element.shape.kind).toBe("number")
  })

  it("lowers an AsyncIterableIterator<T> field to types.stream (an async function*'s explicit return type)", () => {
    const ref = typeRefFromType(typeOf("AsyncIterableIteratorField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.events?.shape.kind).toBe("stream")
    const element = (fields.events?.shape as { kind: "stream"; element: TypeRef }).element
    expect(element.shape.kind).toBe("boolean")
  })

  it("sets meta.readonly on a `readonly`-modified field, and leaves a plain field alone", () => {
    const ref = typeRefFromType(typeOf("ReadonlyField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.id?.meta.readonly).toBe(true)
    expect(fields.name?.meta.readonly).toBeUndefined()
  })

  it("sets both meta.optional and meta.readonly on a `readonly` optional field", () => {
    const ref = typeRefFromType(typeOf("ReadonlyOptionalField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.id?.meta.optional).toBe(true)
    expect(fields.id?.meta.readonly).toBe(true)
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

  // ── Branded/opaque types ──────────────────────────────────────────────────

  it("lowers a branded string to its base shape with meta.brand set", () => {
    const ref = typeRefFromType(typeOf("LocationId"), checker, source)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.brand).toBe("LocationId")
  })

  it("lowers a second branded string with its own distinct brand value", () => {
    const ref = typeRefFromType(typeOf("UserId"), checker, source)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.brand).toBe("UserId")
  })

  it("lowers a branded number (using the __tag spelling) with meta.brand set", () => {
    const ref = typeRefFromType(typeOf("PositiveInt"), checker, source)
    expect(ref.shape).toEqual({ kind: "number" })
    expect(ref.meta.brand).toBe("PositiveInt")
  })

  it("carries brand metadata through a branded field on an object", () => {
    const ref = typeRefFromType(typeOf("BrandedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.locationId?.shape).toEqual({ kind: "string" })
    expect(fields.locationId?.meta.brand).toBe("LocationId")
    expect(fields.name?.shape).toEqual({ kind: "string" })
    expect(fields.name?.meta.brand).toBeUndefined()
  })

  // ── Brand→kind promotion (known brand names → the matching IR kind) ──────

  it("promotes a brand matching a known kind name to that kind, not a plain string", () => {
    const ref = typeRefFromType(typeOf("UserIdUuid"), checker, source)
    expect(ref.shape).toEqual({ kind: "uuid" })
  })

  it("matches a known brand name case-insensitively (all-uppercase)", () => {
    const ref = typeRefFromType(typeOf("UppercaseUuidBrand"), checker, source)
    expect(ref.shape).toEqual({ kind: "uuid" })
  })

  it("matches a known brand name case-insensitively (mixed case)", () => {
    const ref = typeRefFromType(typeOf("MixedCaseUuidBrand"), checker, source)
    expect(ref.shape).toEqual({ kind: "uuid" })
  })

  it("promotes a uri-branded string to the uri kind", () => {
    const ref = typeRefFromType(typeOf("UriBrand"), checker, source)
    expect(ref.shape).toEqual({ kind: "uri" })
  })

  it("promotes an email-branded string to the email kind", () => {
    const ref = typeRefFromType(typeOf("EmailBrand"), checker, source)
    expect(ref.shape).toEqual({ kind: "email" })
  })

  it("promotes known-kind brands nested as object fields", () => {
    const ref = typeRefFromType(typeOf("PromotedBrandField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.id?.shape).toEqual({ kind: "uuid" })
    expect(fields.contact?.shape).toEqual({ kind: "email" })
  })

  it("does not promote a known brand name over a non-string base — falls through to meta.brand", () => {
    const ref = typeRefFromType(typeOf("NumberBrandedUuid"), checker, source)
    expect(ref.shape).toEqual({ kind: "number" })
    expect(ref.meta.brand).toBe("uuid")
  })

  // ── Symbol-branded types (`unique symbol` tag, not a string-literal tag) ──

  it("lowers a unique-symbol-branded string to its base shape, with brand name from the symbol declaration", () => {
    const ref = typeRefFromType(typeOf("SymbolBrandedId"), checker, source)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.brand).toBe("LocationId")
  })

  it("lowers a unique-symbol-branded number the same way", () => {
    const ref = typeRefFromType(typeOf("SymbolBrandedUserId"), checker, source)
    expect(ref.shape).toEqual({ kind: "number" })
    expect(ref.meta.brand).toBe("UserId")
  })

  it("carries unique-symbol brand metadata through a field on an object", () => {
    const ref = typeRefFromType(typeOf("SymbolBrandedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.id?.shape).toEqual({ kind: "string" })
    expect(fields.id?.meta.brand).toBe("LocationId")
    expect(fields.name?.shape).toEqual({ kind: "string" })
    expect(fields.name?.meta.brand).toBeUndefined()
  })

  // ── Shared-symbol branded types (one `unique symbol` key, literal values) ─

  it("reads the brand name from the literal value when a shared symbol key is tagged with a string literal", () => {
    const ref = typeRefFromType(typeOf("SharedSymbolLocationId"), checker, source)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.brand).toBe("LocationId")
  })

  it("distinguishes a second type sharing the same symbol key by its own literal value", () => {
    const ref = typeRefFromType(typeOf("SharedSymbolUserId"), checker, source)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.brand).toBe("UserId")
  })

  it("does not treat a plain (non-branded) intersection as a brand — lowers to types.intersection", () => {
    const ref = typeRefFromType(typeOf("PlainIntersection"), checker, source)
    expect(ref.shape.kind).toBe("intersection")
    const members = (ref.shape as { kind: "intersection"; members: TypeRef[] }).members
    expect(members).toHaveLength(2)
    expect(members[0]?.shape.kind).toBe("object")
    expect(members[1]?.shape.kind).toBe("object")
  })

  // ── Mixin intersections (structural, non-branded) ─────────────────────────

  it("extracts a two-way mixin intersection with each constituent lowered recursively", () => {
    const ref = typeRefFromType(typeOf("MixinType"), checker, source)
    expect(ref.shape.kind).toBe("intersection")
    const members = (ref.shape as { kind: "intersection"; members: TypeRef[] }).members
    expect(members).toHaveLength(2)
    const [hasId, hasTimestamps] = members
    expect(hasId?.shape.kind).toBe("object")
    const idFields = (hasId?.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(Object.keys(idFields)).toEqual(["id"])
    expect(hasTimestamps?.shape.kind).toBe("object")
    const tsFields = (hasTimestamps?.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(Object.keys(tsFields)).toEqual(["createdAt", "updatedAt"])
  })

  it("extracts a three-way intersection (two named mixins + an inline object) fully", () => {
    const ref = typeRefFromType(typeOf("TripleIntersection"), checker, source)
    expect(ref.shape.kind).toBe("intersection")
    const members = (ref.shape as { kind: "intersection"; members: TypeRef[] }).members
    expect(members).toHaveLength(3)
    expect(members.every((m) => m.shape.kind === "object")).toBe(true)
  })

  // ── Property JSDoc refinement tags (@minLength/@maxLength/@pattern/@format/
  //    @minimum/@maximum/@exclusiveMinimum/@exclusiveMaximum/@multipleOf) ────

  it("reads @minLength/@maxLength off a property's JSDoc into meta", () => {
    const ref = typeRefFromType(typeOf("RefinedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.name?.meta.minLength).toBe(2)
    expect(fields.name?.meta.maxLength).toBe(100)
  })

  it("reads @pattern off a property's JSDoc, stripping surrounding quotes", () => {
    const ref = typeRefFromType(typeOf("RefinedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.slug?.meta.pattern).toBe("^[a-z][a-z0-9-]*$")
  })

  it("reads @format off a property's JSDoc as a raw (unquoted) string", () => {
    const ref = typeRefFromType(typeOf("RefinedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.contact?.meta.format).toBe("email")
  })

  it("reads @minimum/@maximum off a property's JSDoc as numbers", () => {
    const ref = typeRefFromType(typeOf("RefinedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.percent?.meta.minimum).toBe(0)
    expect(fields.percent?.meta.maximum).toBe(100)
  })

  it("reads @exclusiveMinimum/@exclusiveMaximum off a property's JSDoc as numbers", () => {
    const ref = typeRefFromType(typeOf("RefinedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.strictRange?.meta.exclusiveMinimum).toBe(0)
    expect(fields.strictRange?.meta.exclusiveMaximum).toBe(1000)
  })

  it("reads @multipleOf off a property's JSDoc as a number", () => {
    const ref = typeRefFromType(typeOf("RefinedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.step?.meta.multipleOf).toBe(5)
  })

  it("carries no refinement meta for a property with no refinement JSDoc tags", () => {
    const ref = typeRefFromType(typeOf("RefinedField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.plain?.meta.minLength).toBeUndefined()
    expect(fields.plain?.meta.pattern).toBeUndefined()
    expect(fields.plain?.meta.minimum).toBeUndefined()
  })

  // ── Branded intersection refinement tags (MinLength<N>/MaxLength<N>/… from
  //    @rhi-zone/fractal-type-ir/kinds/refinements, shared `RefinementTag`
  //    symbol key) ────────────────────────────────────────────────────────

  it("extracts a single refinement tag intersected with a base type", () => {
    const ref = typeRefFromType(typeOf("ShortCode"), checker, source)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.minLength).toBe(2)
  })

  it("merges two refinement tags intersected onto the same base type", () => {
    const ref = typeRefFromType(typeOf("ValidName"), checker, source)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.minLength).toBe(2)
    expect(ref.meta.maxLength).toBe(100)
  })

  it("extracts numeric Minimum/Maximum refinement tags over a number base", () => {
    const ref = typeRefFromType(typeOf("Percent"), checker, source)
    expect(ref.shape).toEqual({ kind: "number" })
    expect(ref.meta.minimum).toBe(0)
    expect(ref.meta.maximum).toBe(100)
  })

  it("extracts a Pattern refinement tag's string-literal value", () => {
    const ref = typeRefFromType(typeOf("SlugPattern"), checker, source)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.pattern).toBe("^[a-z0-9-]+$")
  })

  it("carries refinement-tag meta through fields on an object", () => {
    const ref = typeRefFromType(typeOf("RefinedIntersectionField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.code?.shape).toEqual({ kind: "string" })
    expect(fields.code?.meta.minLength).toBe(2)
    expect(fields.name?.shape).toEqual({ kind: "string" })
    expect(fields.name?.meta.minLength).toBe(2)
    expect(fields.name?.meta.maxLength).toBe(100)
  })

  // ── Enums / literal unions ────────────────────────────────────────────────

  /** Resolve an exported function's single parameter type by name. */
  function paramTypeOf(name: string): ts.Type {
    const fn = findExportedFn(source, name)
    const fnType = checker.getTypeAtLocation(fn)
    const [sig] = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call)
    const [param] = sig!.getParameters()
    return checker.getTypeOfSymbolAtLocation(param!, fn)
  }

  it("lowers a string enum to types.enum with its member values", () => {
    const ref = typeRefFromType(paramTypeOf("statusFn"), checker, source)
    expect(ref.shape.kind).toBe("enum")
    expect((ref.shape as { kind: "enum"; members: readonly string[] }).members).toEqual([
      "active",
      "inactive",
    ])
  })

  it("lowers a string literal union type to types.enum", () => {
    const ref = typeRefFromType(paramTypeOf("stringUnionFn"), checker, source)
    expect(ref.shape.kind).toBe("enum")
    expect((ref.shape as { kind: "enum"; members: readonly string[] }).members).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("lowers a numeric enum to a union of literals", () => {
    const ref = typeRefFromType(paramTypeOf("priorityFn"), checker, source)
    expect(ref.shape.kind).toBe("union")
    const variants = (ref.shape as { kind: "union"; variants: TypeRef[] }).variants
    expect(variants.map((v) => v.shape)).toEqual([
      { kind: "literal", value: 0 },
      { kind: "literal", value: 1 },
      { kind: "literal", value: 2 },
    ])
  })

  it("lowers a boolean parameter to types.boolean, not an enum", () => {
    const ref = typeRefFromType(paramTypeOf("booleanParamFn"), checker, source)
    expect(ref.shape).toEqual({ kind: "boolean" })
  })

  it("still punts a mixed non-literal union (string | number)", () => {
    const ref = typeRefFromType(paramTypeOf("mixedUnionFn"), checker, source)
    expect(ref.shape.kind).toBe("unknown")
    expect(ref.meta.$comment).toMatch(/TODO\(type-ir\)/)
    expect(ref.meta.$comment).toMatch(/union/)
  })

  it("lowers a mixed-literal union to a union of literals", () => {
    const ref = typeRefFromType(paramTypeOf("literalMixedUnionFn"), checker, source)
    expect(ref.shape.kind).toBe("union")
    const variants = (ref.shape as { kind: "union"; variants: TypeRef[] }).variants
    // TS reorders union constituents internally, so compare as a set rather
    // than assuming declaration order is preserved.
    expect(variants.map((v) => v.shape)).toEqual(
      expect.arrayContaining([
        { kind: "literal", value: "a" },
        { kind: "literal", value: 1 },
        { kind: "literal", value: true },
      ]),
    )
    expect(variants).toHaveLength(3)
  })

  // ── Discriminated unions ──────────────────────────────────────────────────

  it("extracts a discriminated union (ShapeUnion) as types.union with meta.discriminator = 'type', variants as full objects", () => {
    const ref = typeRefFromType(paramTypeOf("shapeUnionFn"), checker, source)
    expect(ref.shape.kind).toBe("union")
    expect(ref.meta.discriminator).toBe("type")
    const variants = (ref.shape as { kind: "union"; variants: TypeRef[] }).variants
    expect(variants).toHaveLength(2)
    expect(variants.every((v) => v.shape.kind === "object")).toBe(true)
    const byDiscriminant = Object.fromEntries(
      variants.map((v) => {
        const fields = (v.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
        const typeField = fields.type!.shape as { kind: "literal"; value: unknown }
        return [typeField.value as string, fields]
      }),
    )
    expect(Object.keys(byDiscriminant).sort()).toEqual(["circle", "square"])
    expect(byDiscriminant.circle?.radius?.shape.kind).toBe("number")
    expect(byDiscriminant.square?.side?.shape.kind).toBe("number")
  })

  it("extracts a non-discriminated object union (NonDiscriminated) as types.union WITHOUT meta.discriminator", () => {
    const ref = typeRefFromType(paramTypeOf("nonDiscriminatedFn"), checker, source)
    expect(ref.shape.kind).toBe("union")
    expect(ref.meta.discriminator).toBeUndefined()
    const variants = (ref.shape as { kind: "union"; variants: TypeRef[] }).variants
    expect(variants).toHaveLength(2)
    expect(variants.every((v) => v.shape.kind === "object")).toBe(true)
  })

  // ── Callable/function types ────────────────────────────────────────────────

  it("lowers a callback field to types.function instead of punting or dropping it", () => {
    const ref = typeRefFromType(typeOf("CallbackField"), checker, source)
    expect(ref.shape.kind).toBe("object")
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(Object.keys(fields)).toEqual(["onChange"])
    const onChange = fields.onChange!
    expect(onChange.shape.kind).toBe("function")
    const fn = onChange.shape as {
      kind: "function"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
      thisType?: TypeRef
    }
    expect(fn.params).toHaveLength(1)
    expect(fn.params[0]?.name).toBe("value")
    expect(fn.params[0]?.type.shape.kind).toBe("number")
    expect(fn.returnType.shape.kind).toBe("void")
    expect(fn.thisType).toBeUndefined()
  })

  it("lowers a bare arrow-function type alias to types.function with all params in order", () => {
    const ref = typeRefFromType(typeOf("ArrowFnType"), checker, source)
    expect(ref.shape.kind).toBe("function")
    const fn = ref.shape as {
      kind: "function"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
    }
    expect(fn.params.map((p) => p.name)).toEqual(["x", "label"])
    expect(fn.params.map((p) => p.type.shape.kind)).toEqual(["number", "string"])
    expect(fn.returnType.shape.kind).toBe("boolean")
  })

  it("carries an explicit `this` parameter as thisType, resolved to the class's own instance", () => {
    const ref = typeRefFromType(typeOf("BoundMethodType"), checker, source)
    expect(ref.shape.kind).toBe("function")
    const fn = ref.shape as {
      kind: "function"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
      thisType?: TypeRef
    }
    expect(fn.params.map((p) => p.name)).toEqual(["amount"])
    expect(fn.thisType?.shape.kind).toBe("instance")
    const thisShape = fn.thisType?.shape as { kind: "instance"; className: string }
    expect(thisShape.className).toBe("MethodOwner")
  })

  // ── Overloaded functions/methods — intersection of call signatures ────────

  type FnShape = {
    kind: "function"
    params: readonly { name: string; type: TypeRef }[]
    returnType: TypeRef
  }
  type MethodShape = {
    kind: "method"
    params: readonly { name: string; type: TypeRef }[]
    returnType: TypeRef
    thisType?: TypeRef
  }
  type IntersectionShape = { kind: "intersection"; members: TypeRef[] }

  it("lowers an overloaded function to types.intersection of one types.function per overload", () => {
    const ref = typeRefFromType(typeOf("OverloadedFnField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    const handler = fields.handler!
    expect(handler.shape.kind).toBe("intersection")
    const members = (handler.shape as IntersectionShape).members
    expect(members).toHaveLength(2)
    expect(members.every((m) => m.shape.kind === "function")).toBe(true)

    const [first, second] = members.map((m) => m.shape as FnShape)
    expect(first!.params.map((p) => p.type.shape.kind)).toEqual(["string"])
    expect(first!.returnType.shape.kind).toBe("number")
    expect(second!.params.map((p) => p.type.shape.kind)).toEqual(["number"])
    expect(second!.returnType.shape.kind).toBe("string")
  })

  it("does not include the implementation signature in the extracted overload intersection", () => {
    // OverloadedFnField's declared type is `typeof overloadedFn`, whose two
    // *public* overloads are `(a: string) => number` and `(a: number) =>
    // string` — the wider implementation signature `(a: string | number) =>
    // number | string` backs the body but is never callable from outside and
    // must not appear as a third intersection member.
    const ref = typeRefFromType(typeOf("OverloadedFnField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    const members = (fields.handler!.shape as IntersectionShape).members
    expect(members).toHaveLength(2)
    const paramKinds = members.map((m) => (m.shape as FnShape).params[0]!.type.shape.kind).sort()
    expect(paramKinds).toEqual(["number", "string"])
    // The implementation signature's union param (`string | number`) would
    // show up as a third member with a `union`- or `unknown`-kind param —
    // confirm no such member exists.
    expect(members.some((m) => (m.shape as FnShape).params[0]!.type.shape.kind === "union")).toBe(
      false,
    )
  })

  it("lowers an overloaded class method to types.intersection of one types.method per overload, each carrying thisType", () => {
    const ref = typeRefFromType(typeOf("OverloadedMethodClass"), checker, source)
    expect(ref.shape.kind).toBe("instance")
    const iface = ref.meta.interface as TypeRef
    expect(iface).toBeDefined()
    const methods = (iface.shape as { kind: "interface"; methods: Record<string, TypeRef> }).methods
    const process = methods.process!
    expect(process.shape.kind).toBe("intersection")
    const members = (process.shape as IntersectionShape).members
    expect(members).toHaveLength(2)
    expect(members.every((m) => m.shape.kind === "method")).toBe(true)

    const [first, second] = members.map((m) => m.shape as MethodShape)
    expect(first!.params.map((p) => p.type.shape.kind)).toEqual(["string"])
    expect(first!.returnType.shape.kind).toBe("number")
    expect(second!.params.map((p) => p.type.shape.kind)).toEqual(["number"])
    expect(second!.returnType.shape.kind).toBe("string")

    for (const m of members) {
      const thisType = (m.shape as MethodShape).thisType
      expect(thisType?.shape.kind).toBe("instance")
      expect((thisType?.shape as { className: string }).className).toBe("OverloadedMethodClass")
    }
  })

  it("lowers each overload's independently-Result-shaped return type on its own — no cross-overload collapsing", () => {
    const ref = typeRefFromType(typeOf("OverloadedResultFnField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    const members = (fields.handler!.shape as IntersectionShape).members
    expect(members).toHaveLength(2)

    const byParamKind = Object.fromEntries(
      members.map((m) => {
        const fn = m.shape as FnShape
        return [fn.params[0]!.type.shape.kind, fn.returnType]
      }),
    )

    // Each overload's return type is the (unwrapped-at-the-op-level-only)
    // Result<T,E> alias, extracted structurally as its own discriminated
    // union — `T` differs per overload (`{ text: string }` vs `{ num:
    // number }`), proving each signature's return type was lowered
    // independently rather than sharing one memoized result.
    const stringOverloadReturn = byParamKind.string!
    const numberOverloadReturn = byParamKind.number!
    expect(stringOverloadReturn.shape.kind).toBe("union")
    expect(numberOverloadReturn.shape.kind).toBe("union")
    expect(stringOverloadReturn.meta.discriminator).toBe("kind")
    expect(numberOverloadReturn.meta.discriminator).toBe("kind")

    const okFieldsOf = (returnRef: TypeRef): string[] => {
      const variants = (returnRef.shape as { kind: "union"; variants: TypeRef[] }).variants
      const okVariant = variants.find((v) => {
        const f = (v.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
        return (f.kind?.shape as { kind: "literal"; value: unknown })?.value === "ok"
      })!
      const valueFields = (okVariant.shape as { kind: "object"; fields: Record<string, TypeRef> })
        .fields.value!.shape as { kind: "object"; fields: Record<string, TypeRef> }
      return Object.keys(valueFields.fields)
    }
    expect(okFieldsOf(stringOverloadReturn)).toEqual(["text"])
    expect(okFieldsOf(numberOverloadReturn)).toEqual(["num"])
  })

  // ── Generic type parameters — extract constraint bounds ───────────────────

  it("extracts an inline-object constraint (`T extends { name: string }`) as the object shape, tagged meta.generic", () => {
    const fn = findExportedFn(source, "inlineConstraintFn")
    const ref = typeRefFromFunctionNode(fn, checker)
    expect(ref.shape.kind).toBe("object")
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.name?.shape.kind).toBe("string")
    expect(ref.meta.generic).toBe(true)
  })

  it("extracts a primitive constraint (`T extends string`) as types.string, tagged meta.generic", () => {
    const fn = findExportedFn(source, "primitiveConstraintFn")
    const ref = typeRefFromFunctionNode(fn, checker)
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.generic).toBe(true)
  })

  it("extracts a named-interface constraint (`T extends Searchable`) as the interface's shape, tagged meta.generic", () => {
    const fn = findExportedFn(source, "interfaceConstraintFn")
    const ref = typeRefFromFunctionNode(fn, checker)
    expect(ref.shape.kind).toBe("object")
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    expect(fields.query?.shape.kind).toBe("string")
    expect(ref.meta.generic).toBe(true)
  })

  it("lowers an unconstrained type parameter to types.unknown with a descriptive comment, no meta.generic", () => {
    const fn = findExportedFn(source, "unconstrainedFn")
    const ref = typeRefFromFunctionNode(fn, checker)
    expect(ref.shape.kind).toBe("unknown")
    expect(ref.meta.generic).toBeUndefined()
    expect(ref.meta.$comment).toMatch(/unconstrained generic type parameter/)
  })

  it("regression: non-generic functions are unaffected by type-parameter handling", () => {
    const fn = findExportedFn(source, "sample")
    const ref = typeRefFromFunctionNode(fn, checker)
    expect(ref.shape.kind).toBe("object")
    expect(ref.meta.generic).toBeUndefined()
  })

  it("regression: a single-signature function still lowers to a bare types.function, no intersection wrapper", () => {
    const ref = typeRefFromType(typeOf("SingleSignatureFnField"), checker, source)
    const fields = (ref.shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
    const handler = fields.handler!
    expect(handler.shape.kind).toBe("function")
    const fn = handler.shape as FnShape
    expect(fn.params.map((p) => p.type.shape.kind)).toEqual(["string"])
    expect(fn.returnType.shape.kind).toBe("number")
  })
})

// ============================================================================
// 9. End-to-end: extracted per-field descriptions actually reach CLI --help
//    text (packages/cli-api-projector/src/cli.ts's buildLeafHelp already reads
//    `fieldSchema.description` — this proves the field is now populated, not
//    just that the reader is wired up).
// ============================================================================

describe("end-to-end: CLI --help renders JSDoc-derived field descriptions", () => {
  it("users create --help lists each field's description (top-level + nested)", async () => {
    const { runCli } = await import("@rhi-zone/fractal-cli-api-projector")
    const out: string[] = []
    const io = {
      stdout: { write: (s: string) => { out.push(s) } },
      stderr: { write: (_s: string) => {} },
      confirm: async () => true,
    }
    await runCli(tree, ["users", "create", "--help"], io, { schemas })
    const help = out.join("")
    expect(help).toContain("The user's display name.")
    expect(help).toContain("Age in years.")
  })
})
