// packages/api-tree/src/apply-validation-build.test.ts — call-site-anchored
// codegen tests.
//
// Covers: the call-site scan (brand-based callee resolution, tree tracing
// through a projection call, duplicate-key and cross-file errors), the
// emitted module (flat compiled validators + nested regrouping + the
// `createApplyValidation` composition, evaluated end-to-end), the pre-codegen
// stub, and the two cache tiers.

import { afterAll, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import ts from "typescript"
import {
  applyValidationStubSource,
  buildApplyValidationModuleCached,
  buildApplyValidationModuleSource,
  buildApplyValidationModuleSourceIncremental,
  extractApplyValidationTypeRefs,
  findApplyValidationCallSites,
} from "./apply-validation-build.ts"
import { createApplyValidation } from "./apply-validation.ts"
import { createExtractorProgram, defaultShouldShare } from "./extract.ts"

const FIXTURE = `${import.meta.dir}/__fixtures__/apply-validation.fixture.ts`
const DUPLICATE_FIXTURE = `${import.meta.dir}/__fixtures__/apply-validation-duplicate-key.fixture.ts`
const CROSS_FILE_FIXTURE = `${import.meta.dir}/__fixtures__/apply-validation-cross-file.fixture.ts`

const tsTranspiler = new Bun.Transpiler({ loader: "ts" })

/** Evaluate a generated module, standing in for its one runtime import
 * (`createApplyValidation`) with the real function — the same
 * transpile-then-`new Function` trick build.test.ts uses on
 * `compileValidatorModule` output, extended to a module that has a value
 * import. */
function evalModule(source: string): { applyValidation: ReturnType<typeof createApplyValidation> } {
  const withoutImports = source
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n")
  const commonJs =
    tsTranspiler.transformSync(withoutImports).replaceAll("export const ", "const ") +
    "\nreturn { applyValidation };"
  return new Function("createApplyValidation", commonJs)(createApplyValidation)
}

function callSitesOf(entryFile: string) {
  const program = createExtractorProgram(entryFile)
  const source = program.getSourceFile(entryFile)
  if (!source) throw new Error(`source not found: ${entryFile}`)
  return findApplyValidationCallSites(source, program.getTypeChecker())
}

describe("call-site scan", () => {
  it("finds one call site per applyValidation invocation, keyed by its literal", () => {
    expect(callSitesOf(FIXTURE).map((site) => site.key)).toEqual(["books", "widgets"])
  })

  it("matches an ALIASED import and ignores an unrelated local function of the same name", () => {
    // The fixture imports the real one as `validate` and declares a decoy
    // literally named `applyValidation` — resolution is by the brand on the
    // callee's TYPE, not by name, so exactly the first two are found and the
    // decoy's key never appears.
    expect(callSitesOf(FIXTURE).map((site) => site.key)).not.toContain("decoy")
  })

  it("traces a tree through a wrapping projection call", () => {
    const widgets = callSitesOf(FIXTURE).find((site) => site.key === "widgets")
    expect(widgets).toBeDefined()
    // The traced type is the Node tree, not the projected route — a projected
    // tree carries `methods`, a Node never does.
    expect(widgets!.nodeType.getProperty("children")).toBeDefined()
    expect(widgets!.nodeType.getProperty("methods")).toBeUndefined()
  })

  it("throws on a duplicate key across two call sites in one entry file", () => {
    expect(() => callSitesOf(DUPLICATE_FIXTURE)).toThrow(/duplicate key "shared"/)
  })

  it("throws loudly when the tree argument is declared in another file", () => {
    expect(() => callSitesOf(CROSS_FILE_FIXTURE)).toThrow(/declared in another file/)
  })
})

describe("extractApplyValidationTypeRefs", () => {
  it("keys leaves by TREE-RELATIVE path, grouped under each call site's key", () => {
    const { byKey } = extractApplyValidationTypeRefs(FIXTURE)
    expect(Object.keys(byKey).sort()).toEqual(["books", "widgets"])
    expect(Object.keys(byKey["books"]!).sort()).toEqual(["byId/:bookId", "list"])
    expect(Object.keys(byKey["widgets"]!)).toEqual(["create"])
  })

  it("carries each leaf's real input TypeRef and JSDoc description", () => {
    const { byKey } = extractApplyValidationTypeRefs(FIXTURE)
    expect(byKey["books"]!["list"]!.description).toBe("List every book in the catalog.")
    expect(byKey["widgets"]!["create"]!.input.shape.kind).toBe("object")
  })

  it("supports the structural-sharing opt-in (defs surface, same as build.ts's)", () => {
    const shared = extractApplyValidationTypeRefs(FIXTURE, { shouldShare: defaultShouldShare })
    expect(Object.keys(shared.byKey).sort()).toEqual(["books", "widgets"])
    expect(typeof shared.defs).toBe("object")
  })
})

describe("generated module", () => {
  const source = buildApplyValidationModuleSource(FIXTURE, { runtimeImport: "../apply-validation.ts" })

  it("imports createApplyValidation and re-exports a composed applyValidation", () => {
    expect(source).toContain('import { createApplyValidation } from "../apply-validation.ts"')
    expect(source).toContain("export const applyValidation = createApplyValidation(validatorsByKey)")
  })

  it("regroups the flat compiled validators into Record<key, Record<path, entry>>", () => {
    expect(source).toContain('"books": {')
    expect(source).toContain('"byId/:bookId": validators[')
    expect(source).toContain('"widgets": {')
  })

  it("is syntactically valid TypeScript", () => {
    const parsed = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.ESNext, true)
    expect((parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).toHaveLength(0)
  })

  it("validates for real, end-to-end, at both call sites' keys", async () => {
    const { applyValidation } = evalModule(source)
    const tree = {
      meta: {},
      children: { create: { meta: {}, handler: (input: unknown) => ({ echoed: input }) } },
    }
    const wired = applyValidation("widgets", tree) as typeof tree
    await expect(wired.children.create.handler({ name: "w", count: 2 })).resolves.toEqual({
      echoed: { name: "w", count: 2 },
    })
    const rejected = (await wired.children.create.handler({ name: "w" })) as unknown
    expect((rejected as { kind: string }).kind).toBe("err")
  })

  it("applies to an HttpRoute-shaped projected tree with the same generated map", async () => {
    const { applyValidation } = evalModule(source)
    const routes = {
      meta: {},
      children: {
        create: { meta: {}, methods: { POST: { handler: (input: unknown) => ({ echoed: input }), meta: {} } } },
      },
    }
    const wired = applyValidation("widgets", routes) as typeof routes
    await expect(wired.children.create.methods.POST.handler({ name: "w", count: 2 })).resolves.toEqual({
      echoed: { name: "w", count: 2 },
    })
  })
})

describe("pre-codegen stub", () => {
  it("is a pass-through applyValidation over an empty map", () => {
    const stub = applyValidationStubSource({ runtimeImport: "../apply-validation.ts" })
    expect(stub).toContain("export const validatorsByKey = {}")
    expect(stub).toContain("export const applyValidation = createApplyValidation(validatorsByKey)")
    const { applyValidation } = evalModule(stub)
    const tree = { meta: {}, children: {} }
    expect(applyValidation("anything", tree)).toBe(tree)
  })

  it("defaults its runtime import to the published subpath", () => {
    expect(applyValidationStubSource()).toContain('from "@rhi-zone/fractal-api-tree/apply-validation"')
  })

  it("is what an entry file with no call sites builds to", () => {
    const noCallSites = `${import.meta.dir}/__fixtures__/tree.fixture.ts`
    expect(buildApplyValidationModuleSource(noCallSites)).toBe(applyValidationStubSource())
  })
})

describe("caching", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fractal-apply-validation-"))
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it("Tier 1: a second build for the same entry/output is a cache hit", () => {
    const outFile = path.join(tmpDir, "generated.ts")
    const first = buildApplyValidationModuleCached(FIXTURE, outFile)
    expect(first.status).toBe("built")
    if (first.status === "built") fs.writeFileSync(outFile, first.result)
    expect(buildApplyValidationModuleCached(FIXTURE, outFile).status).toBe("hit")
  })

  it("Tier 2: carried-forward leaves aren't recompiled, and the source is unchanged", () => {
    const program = createExtractorProgram(FIXTURE)
    const first = buildApplyValidationModuleSourceIncremental(FIXTURE, { program })
    expect(first.changedLeaves.length).toBe(3)
    const second = buildApplyValidationModuleSourceIncremental(FIXTURE, { program, prior: first })
    expect(second.changedLeaves).toEqual([])
    expect(second.source).toBe(first.source)
  })

  it("the incremental path emits the same module the one-shot path does", () => {
    const program = createExtractorProgram(FIXTURE)
    const incremental = buildApplyValidationModuleSourceIncremental(FIXTURE, { program })
    const oneShot = buildApplyValidationModuleSource(FIXTURE, { program })
    expect(incremental.source).toBe(oneShot)
  })
})
