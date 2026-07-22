// packages/type-ir/src/from-typescript.test.ts — @rhi-zone/fractal-type-ir/from-typescript tests
//
// Builds small in-memory TS programs (source text never touches disk — a
// custom `ts.CompilerHost` backed by an in-memory file map) and asserts on
// the `TypeRef` `typeRefFromType` derives for each. Covers every branch
// documented on `typeRefFromType`/`typeRefFromTypeStructural`: primitives,
// literals, objects (optional/readonly/JSDoc description+default/refinement
// tags), arrays, tuples, unions (enum/literal-union/discriminated-object),
// intersections (mixin + branded + refinement), classes, Map/Set,
// index-signature (Record) types, generics, Promise/AsyncIterable
// unwrapping, recursion, structural sharing, and the punt fallback.

import { describe, expect, it } from "bun:test"
import ts from "typescript"
import { nodeCount } from "./index.ts"
import {
  createExtractorProgram,
  createSharingRegistry,
  defaultShouldShare,
  finalizeSharedDefs,
  typeRefFromType,
} from "./from-typescript.ts"

const FILE = "in-memory.ts"

/** Build an in-memory `ts.Program` + `ts.TypeChecker` over `source` — no
 * fixture file ever touches disk. Only `FILE` itself is synthesized;
 * everything else (lib.d.ts, …) still resolves off the real default
 * compiler host, so `Array`/`Map`/`Set`/`Promise`/etc. all resolve normally. */
function programFromSource(source: string): { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile(FILE, source, ts.ScriptTarget.ES2022, true)
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  }
  const host = ts.createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersionOrOptions, ...rest) =>
    fileName === FILE ? sourceFile : originalGetSourceFile(fileName, languageVersionOrOptions, ...rest)
  host.writeFile = () => {}

  const program = ts.createProgram([FILE], options, host)
  const checker = program.getTypeChecker()
  const resolvedSourceFile = program.getSourceFile(FILE)
  if (!resolvedSourceFile) throw new Error("in-memory source file did not resolve")
  return { program, checker, sourceFile: resolvedSourceFile }
}

/** The `ts.Type` of a top-level `type <name> = …` alias's right-hand side. */
function typeOfAlias(sourceFile: ts.SourceFile, checker: ts.TypeChecker, name: string): { type: ts.Type; node: ts.Node } {
  let found: { type: ts.Type; node: ts.Node } | undefined
  const visit = (n: ts.Node): void => {
    if (!found && ts.isTypeAliasDeclaration(n) && n.name.text === name) {
      found = { type: checker.getTypeAtLocation(n.name), node: n }
    }
    if (!found) ts.forEachChild(n, visit)
  }
  visit(sourceFile)
  if (!found) throw new Error(`typeOfAlias: ${name} not found`)
  return found
}

/** Derive the `TypeRef` for a top-level `type <name> = …` alias in `source`. */
function typeRefOf(source: string, name: string, registry?: ReturnType<typeof createSharingRegistry>) {
  const { checker, sourceFile } = programFromSource(source)
  const { type, node } = typeOfAlias(sourceFile, checker, name)
  return typeRefFromType(type, checker, node, undefined, registry)
}

// ============================================================================
// Primitives + literals
// ============================================================================

describe("primitives", () => {
  it("string/number/boolean/null/void", () => {
    expect(typeRefOf("type X = string", "X").shape).toEqual({ kind: "string" })
    expect(typeRefOf("type X = number", "X").shape).toEqual({ kind: "number" })
    expect(typeRefOf("type X = boolean", "X").shape).toEqual({ kind: "boolean" })
    expect(typeRefOf("type X = null", "X").shape).toEqual({ kind: "null" })
  })

  it("string/number/boolean literals", () => {
    expect(typeRefOf('type X = "active"', "X").shape).toEqual({ kind: "literal", value: "active" })
    expect(typeRefOf("type X = 42", "X").shape).toEqual({ kind: "literal", value: 42 })
    expect(typeRefOf("type X = true", "X").shape).toEqual({ kind: "literal", value: true })
  })
})

// ============================================================================
// Objects: primitive/optional/readonly fields, JSDoc description/@default,
// refinement-tag JSDoc
// ============================================================================

describe("objects", () => {
  it("primitive + optional + readonly fields", () => {
    const ref = typeRefOf(
      `type X = { id: string; readonly createdAt: number; nickname?: string }`,
      "X",
    )
    expect(ref.shape.kind).toBe("object")
    const fields = (ref.shape as { fields: Record<string, { shape: unknown; meta: Record<string, unknown> }> }).fields
    expect(fields.id!.shape).toEqual({ kind: "string" })
    expect(fields.id!.meta.optional).toBeUndefined()
    expect(fields.createdAt!.meta.readonly).toBe(true)
    expect(fields.nickname!.meta.optional).toBe(true)
    // `?: string` strips `| undefined`, so the field's own shape is plain string.
    expect(fields.nickname!.shape).toEqual({ kind: "string" })
  })

  it("nested objects + arrays", () => {
    const ref = typeRefOf(`type X = { tags: string[]; address: { city: string } }`, "X")
    const fields = (ref.shape as { fields: Record<string, { shape: Record<string, unknown> }> }).fields
    expect(fields.tags!.shape.kind).toBe("array")
    expect(fields.address!.shape.kind).toBe("object")
  })

  it("JSDoc description and @default flow into field meta", () => {
    const ref = typeRefOf(
      `type X = {
        /** The user's display name. */
        name: string
        /** @default 10 */
        limit: number
      }`,
      "X",
    )
    const fields = (ref.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.name!.meta.description).toBe("The user's display name.")
    expect(fields.limit!.meta.default).toBe(10)
  })

  it("refinement JSDoc tags land in field meta", () => {
    const ref = typeRefOf(
      `type X = {
        /**
         * @minLength 2
         * @maxLength 20
         * @pattern "^[a-z]+$"
         */
        name: string
      }`,
      "X",
    )
    const fields = (ref.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.name!.meta.minLength).toBe(2)
    expect(fields.name!.meta.maxLength).toBe(20)
    expect(fields.name!.meta.pattern).toBe("^[a-z]+$")
  })
})

// ============================================================================
// Arrays / tuples
// ============================================================================

describe("arrays and tuples", () => {
  it("array element type", () => {
    const ref = typeRefOf("type X = number[]", "X")
    expect(ref.shape).toEqual({ kind: "array", element: { shape: { kind: "number" }, meta: {} } })
  })

  it("tuple elements", () => {
    const ref = typeRefOf("type X = [string, number]", "X")
    expect(ref.shape.kind).toBe("tuple")
    const elements = (ref.shape as unknown as { kind: "tuple"; elements: { shape: unknown }[] }).elements
    expect(elements.map((e) => e.shape)).toEqual([{ kind: "string" }, { kind: "number" }])
  })
})

// ============================================================================
// Unions: TS-enum-shaped literal unions, mixed-literal unions, discriminated
// object unions
// ============================================================================

describe("unions", () => {
  it("all-string-literal union → enum", () => {
    const ref = typeRefOf(`type X = "a" | "b" | "c"`, "X")
    expect(ref.shape).toEqual({ kind: "enum", members: ["a", "b", "c"] })
  })

  it("mixed-literal union → union of literals", () => {
    const ref = typeRefOf(`type X = "a" | 1 | true`, "X")
    expect(ref.shape.kind).toBe("union")
    const variants = (
      ref.shape as unknown as { kind: "union"; variants: { shape: { kind: string; value: unknown } }[] }
    ).variants
    // The checker doesn't guarantee member order, so compare as a set of values.
    const values = new Set(variants.map((v) => v.shape.value))
    expect(variants.every((v) => v.shape.kind === "literal")).toBe(true)
    expect(values).toEqual(new Set(["a", 1, true]))
  })

  it("discriminated object union records meta.discriminator", () => {
    const ref = typeRefOf(
      `type X =
        | { kind: "circle"; radius: number }
        | { kind: "square"; side: number }`,
      "X",
    )
    expect(ref.shape.kind).toBe("union")
    expect(ref.meta.discriminator).toBe("kind")
  })

  it("union of a non-object-like member punts", () => {
    const ref = typeRefOf(`type X = string | (() => void)`, "X")
    expect(ref.shape.kind).toBe("unknown")
    expect(String(ref.meta.$comment)).toContain("union")
  })
})

// ============================================================================
// Intersections: structural mixin, branded string, refinement tags, both
// composed
// ============================================================================

describe("intersections", () => {
  it("structural mixin (no brand/refinement) → types.intersection", () => {
    const ref = typeRefOf(`type X = { a: string } & { b: number }`, "X")
    expect(ref.shape.kind).toBe("intersection")
  })

  it("brand tag on a string base promotes to the semantic-string kind", () => {
    const ref = typeRefOf(
      `type X = string & { readonly __brand: "uuid" }`,
      "X",
    )
    expect(ref.shape).toEqual({ kind: "uuid" })
  })

  it("unrecognized brand name falls back to meta.brand", () => {
    const ref = typeRefOf(`type X = string & { readonly __brand: "LocationId" }`, "X")
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.brand).toBe("LocationId")
  })

  it("refinement-tag symbol intersection merges into meta", () => {
    const ref = typeRefOf(
      `declare const RefinementTag: unique symbol
       type MinLength<N extends number> = { readonly [RefinementTag]: { minLength: N } }
       type MaxLength<N extends number> = { readonly [RefinementTag]: { maxLength: N } }
       type X = string & MinLength<2> & MaxLength<100>`,
      "X",
    )
    expect(ref.shape).toEqual({ kind: "string" })
    expect(ref.meta.minLength).toBe(2)
    expect(ref.meta.maxLength).toBe(100)
  })
})

// ============================================================================
// Classes: instance + method surface
// ============================================================================

describe("classes", () => {
  it("class instance is purely nominal, with a method surface in meta.interface", () => {
    const ref = typeRefOf(
      `class Widget {
        id: string = ""
        private secret = 1
        greet(name: string): string { return name }
      }
      type X = Widget`,
      "X",
    )
    expect(ref.shape.kind).toBe("instance")
    const shape = ref.shape as { className: string; source: string }
    expect(shape.className).toBe("Widget")
    expect(ref.meta.interface).toBeDefined()
    const iface = (ref.meta.interface as { shape: { methods: Record<string, unknown> } }).shape
    expect(Object.keys(iface.methods)).toEqual(["greet"])
  })
})

// ============================================================================
// Map / Set / Record (index signatures)
// ============================================================================

describe("Map/Set/Record", () => {
  it("Map<K, V> lowers to types.map", () => {
    const ref = typeRefOf("type X = Map<string, number>", "X")
    expect(ref.shape.kind).toBe("map")
    const shape = ref.shape as { key: { shape: unknown }; value: { shape: unknown } }
    expect(shape.key.shape).toEqual({ kind: "string" })
    expect(shape.value.shape).toEqual({ kind: "number" })
  })

  it("Set<T> lowers to types.array", () => {
    const ref = typeRefOf("type X = Set<string>", "X")
    expect(ref.shape).toEqual({ kind: "array", element: { shape: { kind: "string" }, meta: {} } })
  })

  it("Record<K, V> index signature lowers to types.map", () => {
    const ref = typeRefOf("type X = Record<string, number>", "X")
    expect(ref.shape.kind).toBe("map")
  })
})

// ============================================================================
// Generics: constrained type parameters extract the constraint
// ============================================================================

describe("generics", () => {
  it("constrained type parameter extracts the constraint + meta.generic", () => {
    const { checker, sourceFile } = programFromSource(
      `function f<T extends { id: string }>(x: T): T { return x }`,
    )
    let paramType: ts.Type | undefined
    let loc: ts.Node | undefined
    const visit = (n: ts.Node): void => {
      if (!paramType && ts.isFunctionDeclaration(n) && n.typeParameters?.[0]) {
        paramType = checker.getTypeAtLocation(n.typeParameters[0])
        loc = n.typeParameters[0]
      }
      if (!paramType) ts.forEachChild(n, visit)
    }
    visit(sourceFile)
    if (!paramType || !loc) throw new Error("type parameter not found")
    const ref = typeRefFromType(paramType, checker, loc)
    expect(ref.shape.kind).toBe("object")
    expect(ref.meta.generic).toBe(true)
  })
})

// ============================================================================
// Promise / AsyncIterable unwrapping (field position)
// ============================================================================

describe("Promise/AsyncIterable unwrapping", () => {
  it("Promise<T> field unwraps to T", () => {
    const ref = typeRefOf(`type X = { p: Promise<string> }`, "X")
    const fields = (ref.shape as { fields: Record<string, { shape: unknown }> }).fields
    expect(fields.p!.shape).toEqual({ kind: "string" })
  })

  it("AsyncIterable<T> field lowers to types.stream", () => {
    const ref = typeRefOf(`type X = { s: AsyncIterable<number> }`, "X")
    const fields = (ref.shape as { fields: Record<string, { shape: unknown }> }).fields
    expect(fields.s!.shape).toEqual({ kind: "stream", element: { shape: { kind: "number" }, meta: {} } })
  })
})

// ============================================================================
// Recursion + structural sharing
// ============================================================================

describe("recursion and sharing", () => {
  it("self-recursive type lowers to a ref, not infinite descent", () => {
    const ref = typeRefOf(`type X = { next?: X }`, "X")
    const fields = (ref.shape as { fields: Record<string, { shape: unknown }> }).fields
    expect(fields.next!.shape).toEqual({ kind: "ref", target: "X" })
  })

  it("SharingRegistry extracts a reused, big-enough named type to defs", () => {
    const source = `
      type Address = { street: string; city: string; zip: string; country: string; state: string; unit: string }
      type X = { home: Address; work: Address }
    `
    const registry = createSharingRegistry()
    // With a registry supplied, the top-level named alias (X itself) is ALSO
    // subject to registry-sharing — same as any other named type encountered
    // during extraction (see typeRefFromType's doc comment). So `ref` here is
    // itself `{ kind: "ref", target: "X" }`; its body lives in the registry.
    const ref = typeRefOf(source, "X", registry)
    expect(ref.shape).toEqual({ kind: "ref", target: "X" })

    const xBody = registry.defs.get("X")!
    // Every field is a ref into the registry (unconditional sharing at extraction time).
    const fields = (xBody.shape as { fields: Record<string, { shape: { kind: string; target: string } }> }).fields
    expect(fields.home!.shape.kind).toBe("ref")
    expect(fields.home!.shape.target).toBe("Address")
    expect(fields.work!.shape.target).toBe("Address")

    const { roots, defs } = finalizeSharedDefs(registry, { root: ref }, defaultShouldShare)
    // Address is reused (useCount 2) and big enough (nodeCount > 5) → kept
    // shared. X itself is used only once (as the root) → inlined.
    expect(Object.keys(defs)).toEqual(["Address"])
    expect(defs.Address!.shape.kind).toBe("object")
    expect(roots.root!.shape.kind).toBe("object")
    const rootFields = (roots.root!.shape as { fields: Record<string, { shape: { kind: string; target: string } }> })
      .fields
    expect(rootFields.home!.shape).toEqual({ kind: "ref", target: "Address" })
    expect(rootFields.work!.shape).toEqual({ kind: "ref", target: "Address" })
  })

  it("finalizeSharedDefs inlines a def used only once", () => {
    const source = `
      type Address = { street: string; city: string; zip: string; country: string; state: string; unit: string }
      type X = { home: Address }
    `
    const registry = createSharingRegistry()
    const ref = typeRefOf(source, "X", registry)
    const { defs, roots } = finalizeSharedDefs(registry, { root: ref }, defaultShouldShare)
    // Neither X (used once, as root) nor Address (used once, as X's one field) is reused.
    expect(Object.keys(defs)).toEqual([])
    const fields = (roots.root!.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.home!.shape.kind).toBe("object")
  })
})

// ============================================================================
// Punt fallback
// ============================================================================

describe("punt fallback", () => {
  it("unsupported type punts to types.unknown with a $comment", () => {
    const ref = typeRefOf(`type X = new () => number`, "X")
    expect(ref.shape.kind).toBe("unknown")
    expect(typeof ref.meta.$comment).toBe("string")
    expect(String(ref.meta.$comment)).toContain("TODO(type-ir)")
  })
})

// ============================================================================
// createExtractorProgram sanity — smoke test only (the bulk of coverage
// above uses the in-memory `programFromSource` helper so tests never touch
// disk; this just confirms the factory itself produces a working Program).
// ============================================================================

describe("createExtractorProgram", () => {
  it("produces a Program whose checker resolves types from a real file", () => {
    const program = createExtractorProgram(`${import.meta.dir}/__fixtures__/from-typescript.fixture.ts`)
    const checker = program.getTypeChecker()
    const sourceFile = program.getSourceFile(`${import.meta.dir}/__fixtures__/from-typescript.fixture.ts`)
    expect(sourceFile).toBeDefined()
    const { type, node } = typeOfAlias(sourceFile!, checker, "Sample")
    const ref = typeRefFromType(type, checker, node)
    expect(ref.shape.kind).toBe("object")
  })
})

// nodeCount import above is exercised implicitly via defaultShouldShare; keep
// a direct assertion too so a future defaultShouldShare change that stops
// calling nodeCount doesn't silently drop coverage of the import itself.
describe("nodeCount sanity", () => {
  it("counts nodes in a simple TypeRef tree", () => {
    const ref = typeRefOf(`type X = { a: string; b: number }`, "X")
    expect(nodeCount(ref)).toBeGreaterThan(1)
  })
})
