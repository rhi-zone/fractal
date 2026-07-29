import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { fromStandardSchemaType } from "./from-standard-schema-type.ts"

const FILE = "in-memory.ts"

/** Same in-memory-program harness `from-typescript.test.ts` uses: only `FILE`
 * is synthesized, so lib.d.ts and friends still resolve normally. */
function programFromSource(source: string): { checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
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
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, v, ...rest) => (fileName === FILE ? sourceFile : original(fileName, v, ...rest))
  host.writeFile = () => {}
  const program = ts.createProgram([FILE], options, host)
  const resolved = program.getSourceFile(FILE)
  if (!resolved) throw new Error("in-memory source file did not resolve")
  return { checker: program.getTypeChecker(), sourceFile: resolved }
}

/** The declared `ts.Type` of a top-level `const <name>`. */
function typeOfConst(src: string, name: string): { type: ts.Type; checker: ts.TypeChecker; loc: ts.Node } {
  const { checker, sourceFile } = programFromSource(src)
  let found: { type: ts.Type; loc: ts.Node } | undefined
  const visit = (n: ts.Node): void => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = { type: checker.getTypeAtLocation(n.name), loc: n.name }
    }
    if (!found) ts.forEachChild(n, visit)
  }
  visit(sourceFile)
  if (!found) throw new Error(`const ${name} not found`)
  return { ...found, checker }
}

// A Standard-Schema-shaped declaration whose `~standard.types` is TYPE-ONLY —
// never present at runtime, exactly as the spec describes it. That is the whole
// point: the runtime module cannot see any of this.
const PRELUDE = `
interface StandardTypes<I, O> { readonly input: I; readonly output: O }
interface SS<I, O, V extends string = string> {
  readonly "~standard": { version: 1; vendor: V; types?: StandardTypes<I, O> }
}
declare const decl: unique symbol
`

function refFor(body: string, name = "schema", options?: Parameters<typeof fromStandardSchemaType>[3]) {
  const { type, checker, loc } = typeOfConst(PRELUDE + body, name)
  return fromStandardSchemaType(type, checker, loc, options)
}

describe("fromStandardSchemaType", () => {
  test("recovers optionality — the thing no runtime sample can supply", () => {
    // A sample that happens to omit `note` is indistinguishable from a schema
    // where `note` does not exist. The checker knows the difference.
    const ref = refFor(`
      interface User { id: string; age: number; note?: string }
      declare const schema: SS<unknown, User>
    `)
    const fields = (ref.shape as { fields: Record<string, { shape: { kind: string }; meta?: Record<string, unknown> }> }).fields
    expect(ref.shape.kind).toBe("object")
    expect(fields.id!.meta?.optional).toBeUndefined()
    expect(fields.note!.meta?.optional).toBe(true)
    expect(fields.note!.shape.kind).toBe("string")
  })

  test("recovers union branches and enum members no single sample shows", () => {
    const ref = refFor(`
      declare const schema: SS<unknown, "draft" | "published" | "archived">
    `)
    // the extractor recognises a closed string-literal union as an `enum`,
    // which is the stronger reading — and all three members survive even
    // though no runtime sample could ever exhibit more than one of them
    expect(ref.shape.kind).toBe("enum")
    expect([...(ref.shape as { members: readonly string[] }).members].sort())
      .toEqual(["archived", "draft", "published"])
  })

  test("recovers nominal class identity without any x-class-name extension", () => {
    const ref = refFor(`
      class Money { constructor(public cents: number) {} }
      declare const schema: SS<unknown, Money>
    `)
    expect(ref.shape.kind).toBe("instance")
    expect((ref.shape as { className: string }).className).toBe("Money")
  })

  test("recovers a branded/opaque type", () => {
    const ref = refFor(`
      type UserId = string & { readonly [decl]: "UserId" }
      declare const schema: SS<unknown, UserId>
    `)
    // the branded convention resolves to a string-ish shape rather than
    // collapsing to a bare object — the brand survives the trip
    expect(JSON.stringify(ref)).toContain("string")
    expect(ref.shape.kind).not.toBe("object")
  })

  test("input and output differ when the schema transforms", () => {
    const src = `
      declare const schema: SS<string, number>
    `
    expect(refFor(src).shape.kind).toBe("number")
    expect(refFor(src, "schema", { direction: "input" }).shape.kind).toBe("string")
  })

  test("preserves a statically-known vendor", () => {
    const ref = refFor(`
      declare const schema: SS<unknown, string, "zod">
    `)
    expect(ref.meta?.vendor).toBe("zod")
  })

  test("nested structure resolves through the existing extractor", () => {
    const ref = refFor(`
      interface Item { sku: string; qty: number }
      interface Order { id: string; items: Item[]; note?: string }
      declare const schema: SS<unknown, Order>
    `)
    const fields = (ref.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.items!.shape.kind).toBe("array")
    expect(JSON.stringify(ref)).toContain("sku")
  })

  describe("degradation", () => {
    test("a non-Standard-Schema type degrades with an explanatory comment", () => {
      const ref = refFor(`declare const schema: { notASchema: true }`)
      expect(ref.shape.kind).toBe("unknown")
      expect(String(ref.meta?.$comment)).toContain("`~standard`")
    })

    test("a vendor that omits the phantom types property degrades but keeps vendor", () => {
      const ref = refFor(`
        declare const schema: { readonly "~standard": { version: 1; vendor: "arktype" } }
      `)
      expect(ref.shape.kind).toBe("unknown")
      expect(ref.meta?.vendor).toBe("arktype")
      expect(String(ref.meta?.$comment)).toContain("types")
    })

    test("degrades rather than throwing on a missing direction", () => {
      const ref = refFor(`
        declare const schema: { readonly "~standard": { version: 1; vendor: "x"; types?: { input: string } } }
      `, "schema", { direction: "output" })
      expect(ref.shape.kind).toBe("unknown")
    })
  })
})
