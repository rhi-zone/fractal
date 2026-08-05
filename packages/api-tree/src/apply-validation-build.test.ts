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
  buildWireApplyValidationModuleCached,
  buildWireApplyValidationModuleSource,
  buildWireApplyValidationModuleSourceIncremental,
  extractApplyValidationTypeRefs,
  extractWireApplyValidationTypeRefs,
  findApplyValidationCallSites,
} from "./apply-validation-build.ts"
import { createApplyValidation } from "./apply-validation.ts"
import { createExtractorProgram, defaultShouldShare } from "./extract.ts"
import { jsonProfile } from "@rhi-zone/fractal-type-ir"

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

describe("wire-profile build path (3-arg applyValidation call sites)", () => {
  const WIRE_FIXTURE = `${import.meta.dir}/__fixtures__/wire-apply-validation.fixture.ts`

  it("finds the protocol argument on each 3-arg call site", () => {
    const byKey = new Map(callSitesOf(WIRE_FIXTURE).map((site) => [site.key, site.protocol]))
    expect(byKey.get("wire-http")).toBe("http")
    expect(byKey.get("wire-http-override")).toBe("http")
    expect(byKey.get("wire-cli")).toBe("cli")
    expect(byKey.get("wire-mcp")).toBe("mcp")
  })

  it("http (GET, no override): bookId defaults to path-segment encoding, page defaults to the GET->query encoding", () => {
    const { byKey } = extractWireApplyValidationTypeRefs(WIRE_FIXTURE)
    const leaf = byKey["wire-http"]!.leaves["byId/:bookId"]!
    if (!("fieldProfiles" in leaf.derivation)) throw new Error("expected a composite (per-field) derivation")
    expect(leaf.derivation.fieldProfiles["bookId"]?.name).toBe("query")
    expect(leaf.derivation.defaultProfile.name).toBe("query")
  })

  it("http: an explicit sourceMap override to \"body\" wins over the GET->query method default", () => {
    const { byKey } = extractWireApplyValidationTypeRefs(WIRE_FIXTURE)
    const leaf = byKey["wire-http-override"]!.leaves["byId/:bookId"]!
    if (!("fieldProfiles" in leaf.derivation)) throw new Error("expected a composite (per-field) derivation")
    expect(leaf.derivation.fieldProfiles["page"]?.name).toBe("json")
    expect(leaf.derivation.fieldProfiles["bookId"]?.name).toBe("query")
  })

  it("cli: bookId defaults to path-store encoding, still argv (CLI stores are uniform)", () => {
    const { byKey } = extractWireApplyValidationTypeRefs(WIRE_FIXTURE)
    const leaf = byKey["wire-cli"]!.leaves["byId/:bookId"]!
    if (!("fieldProfiles" in leaf.derivation)) throw new Error("expected a composite (per-field) derivation")
    expect(leaf.derivation.fieldProfiles["bookId"]?.name).toBe("argv")
    expect(leaf.derivation.defaultProfile.name).toBe("argv")
  })

  it("mcp: uniform jsonProfile, no per-field derivation at all", () => {
    const { byKey } = extractWireApplyValidationTypeRefs(WIRE_FIXTURE)
    const leaf = byKey["wire-mcp"]!.leaves["get"]!
    expect(leaf.derivation).toEqual({ profile: jsonProfile })
  })

  it("emits a syntactically valid module, grouping wireValidatorsByKey by (key, path, protocol)", () => {
    const source = buildWireApplyValidationModuleSource(WIRE_FIXTURE, { runtimeImport: "../apply-validation.ts" })
    expect(source).toContain('"wire-http": {')
    expect(source).toContain('"byId/:bookId": { "http": wireValidators[')
    expect(source).toContain("export const applyValidation = createApplyValidation({}, wireValidatorsByKey)")
    const parsed = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.ESNext, true)
    expect((parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).toHaveLength(0)
  })

  it("http/cli (query/argv-shaped) coerce a numeric-string \"page\"; mcp (json-shaped) rejects it", async () => {
    const source = buildWireApplyValidationModuleSource(WIRE_FIXTURE, { runtimeImport: "../apply-validation.ts" })
    const { applyValidation: wire } = evalModule(source)

    const httpOut = wire(
      "wire-http",
      { meta: {}, children: { byId: { meta: {}, fallback: { name: "bookId", subtree: { meta: {}, handler: (i: unknown) => i } } } } },
      "http",
    ) as { children: { byId: { fallback: { subtree: { handler: (i: unknown) => unknown } } } } }
    const httpResult = await httpOut.children.byId.fallback.subtree.handler({ bookId: "b1", page: "3" })
    expect(httpResult).toEqual({ bookId: "b1", page: 3 })

    const cliOut = wire(
      "wire-cli",
      { meta: {}, children: { byId: { meta: {}, fallback: { name: "bookId", subtree: { meta: {}, handler: (i: unknown) => i } } } } },
      "cli",
    ) as { children: { byId: { fallback: { subtree: { handler: (i: unknown) => unknown } } } } }
    const cliResult = await cliOut.children.byId.fallback.subtree.handler({ bookId: "b1", page: "3" })
    expect(cliResult).toEqual({ bookId: "b1", page: 3 })

    const mcpOut = wire("wire-mcp", { meta: {}, children: { get: { meta: {}, handler: (i: unknown) => i } } }, "mcp") as {
      children: { get: { handler: (i: unknown) => unknown } }
    }
    const mcpResult = (await mcpOut.children.get.handler({ count: "3" })) as unknown
    expect((mcpResult as { kind: string }).kind).toBe("err")
  })
})

describe("wire-profile build path — caching (fingerprint incorporates protocol)", () => {
  const WIRE_FIXTURE = `${import.meta.dir}/__fixtures__/wire-apply-validation.fixture.ts`

  it("Tier 1: a second build for the same entry/output is a cache hit", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fractal-wire-apply-validation-"))
    try {
      const outFile = path.join(tmpDir, "generated.ts")
      const first = buildWireApplyValidationModuleCached(WIRE_FIXTURE, outFile)
      expect(first.status).toBe("built")
      if (first.status === "built") fs.writeFileSync(outFile, first.result)
      expect(buildWireApplyValidationModuleCached(WIRE_FIXTURE, outFile).status).toBe("hit")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("Tier 2: carried-forward leaves aren't recompiled on an unchanged rebuild", () => {
    const program = createExtractorProgram(WIRE_FIXTURE)
    const first = buildWireApplyValidationModuleSourceIncremental(WIRE_FIXTURE, { program })
    expect(first.changedLeaves.length).toBeGreaterThan(0)
    const second = buildWireApplyValidationModuleSourceIncremental(WIRE_FIXTURE, { program, prior: first })
    expect(second.changedLeaves).toEqual([])
    expect(second.source).toBe(first.source)
  })

  it("the SAME leaf under two different protocols fingerprints differently (protocol folded into the leaf key)", () => {
    const program = createExtractorProgram(WIRE_FIXTURE)
    const built = buildWireApplyValidationModuleSourceIncremental(WIRE_FIXTURE, { program })
    // "wire-http"'s and "wire-cli"'s "byId/:bookId" leaves are structurally the
    // SAME TypeRef ({ bookId: string; page: number }) but different protocols —
    // their fingerprints (and compiled artifacts) must differ.
    const httpKey = Object.keys(built.leafFingerprints).find((k) => k.startsWith("wire-http\u0000") && k.endsWith("http"))
    const cliKey = Object.keys(built.leafFingerprints).find((k) => k.startsWith("wire-cli\u0000") && k.endsWith("cli"))
    expect(httpKey).toBeDefined()
    expect(cliKey).toBeDefined()
    expect(built.leafFingerprints[httpKey!]).not.toBe(built.leafFingerprints[cliKey!])
    expect(built.leafArtifacts[httpKey!]!.code).not.toBe(built.leafArtifacts[cliKey!]!.code)
  })
})

// ============================================================================
// Extraction/compile edge-case regressions — ported from build.test.ts's
// "build orchestrator" describe block (deleted phase 3 along with
// `buildValidatorModuleSource`, which this same plumbing — extraction via
// `walkNodeType`/`typeRefFromFunctionNode`, compilation via type-ir's
// `compileValidatorModule`/`compileEntryFragment` — is equally exposed to).
// Fixtures wrap the SAME rich tree.fixture.ts/sharing-input.fixture.ts
// build.test.ts used, in a single `applyValidation` call site
// (__fixtures__/apply-validation-tree.fixture.ts,
// __fixtures__/apply-validation-sharing-input.fixture.ts) — keys are now
// tree-relative under the call site's own key ("tree"), not treeId-prefixed.
// ============================================================================

describe("generated module — extraction/compile edge cases (ported from build.test.ts)", () => {
  const TREE_FIXTURE = `${import.meta.dir}/__fixtures__/apply-validation-tree.fixture.ts`
  const SHARING_FIXTURE = `${import.meta.dir}/__fixtures__/apply-validation-sharing-input.fixture.ts`

  it("keys leaves tree-relatively under the call site's key, matching the rich fixture's shape", () => {
    const { byKey } = extractApplyValidationTypeRefs(TREE_FIXTURE)
    const paths = Object.keys(byKey["tree"]!)
    expect(paths).toContain("users/create")
    expect(paths).toContain("users/:userId/get")
  })

  it("without an outFile, a NAMED parameter type inlines its structure (no import)", () => {
    const source = buildApplyValidationModuleSource(TREE_FIXTURE, { runtimeImport: "../apply-validation.ts" })
    expect(source.split("\n").filter((line) => line.startsWith("import type"))).toEqual([
      'import type { ValidationError } from "@rhi-zone/fractal-type-ir"',
    ])
    expect(source).toContain("value is { q?: string }")
  })

  it("given an outFile, a NAMED parameter type (BookQuery, tree.fixture.ts) is imported relative to outFile, not inlined", () => {
    const outFile = `${import.meta.dir}/generated/apply-validation.ts`
    const source = buildApplyValidationModuleSource(TREE_FIXTURE, { outFile, runtimeImport: "../apply-validation.ts" })
    expect(source).toContain('import type { BookQuery } from "../__fixtures__/tree.fixture.ts"')
    expect(source).toContain("value is BookQuery")
    expect(source).not.toContain("value is { q?: string }")
  })

  it("given an outFile, a builtin/global TS utility type (Record) inlines structurally — no import to a TS lib .d.ts file", () => {
    const outFile = `${import.meta.dir}/generated/apply-validation.ts`
    const source = buildApplyValidationModuleSource(TREE_FIXTURE, { outFile, runtimeImport: "../apply-validation.ts" })
    expect(source).not.toContain("import type { Record }")
    expect(source).not.toMatch(/import type \{[^}]*\} from "[^"]*lib\.[a-z0-9.]*\.d\.ts"/i)
    expect(source).toContain("value is Record<string, string>")
  })

  it("a leaf reaching into a TS/DOM builtin's structure (Response, via its return type) compiles to syntactically valid TS", () => {
    const source = buildApplyValidationModuleSource(TREE_FIXTURE, { runtimeImport: "../apply-validation.ts" })
    expect(source).not.toContain("__@")
    const withoutImports = source.split("\n").filter((line) => !line.startsWith("import ")).join("\n")
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(withoutImports)).not.toThrow()
  })

  it("without shouldShare, no defs are emitted — every route's input inlines its full structure", () => {
    const source = buildApplyValidationModuleSource(SHARING_FIXTURE, { runtimeImport: "../apply-validation.ts" })
    expect(source).not.toContain("__def_Address_check")
  })

  it("with shouldShare, a type reused across routes' inputs compiles to ONE shared def, called from every ref site", async () => {
    const source = buildApplyValidationModuleSource(SHARING_FIXTURE, {
      shouldShare: defaultShouldShare,
      runtimeImport: "../apply-validation.ts",
    })
    expect(source.match(/function __def_Address_check\(/g) ?? []).toHaveLength(1)

    const { applyValidation } = evalModule(source)
    const tree = {
      meta: {},
      children: {
        setBilling: { meta: {}, handler: (input: unknown) => ({ echoed: input }) },
        setShipping: { meta: {}, handler: (input: unknown) => ({ echoed: input }) },
      },
    }
    const wired = applyValidation("tree", tree) as typeof tree
    const validAddress = { street: "Main", city: "X", zip: "1", country: "Y", region: "Z", landmark: "L" }
    await expect(
      wired.children.setBilling.handler({ userId: "u1", billing: validAddress }),
    ).resolves.toEqual({ echoed: { userId: "u1", billing: validAddress } })
    const rejected = (await wired.children.setBilling.handler({ userId: "u1", billing: {} })) as unknown
    expect((rejected as { kind: string }).kind).toBe("err")
  })

  it("passing a pre-built program (createExtractorProgram) produces byte-identical output to the default per-call program", () => {
    const withoutProgram = buildApplyValidationModuleSource(TREE_FIXTURE)
    const program = createExtractorProgram(TREE_FIXTURE)
    const withProgram = buildApplyValidationModuleSource(TREE_FIXTURE, { program })
    expect(withProgram).toEqual(withoutProgram)
  })

  it("a program shared across TWO different entry files (multi-root) extracts each correctly", () => {
    const program = createExtractorProgram([TREE_FIXTURE, SHARING_FIXTURE])
    const treeSource = buildApplyValidationModuleSource(TREE_FIXTURE, { program })
    const sharingSource = buildApplyValidationModuleSource(SHARING_FIXTURE, { shouldShare: defaultShouldShare, program })

    expect(treeSource).toEqual(buildApplyValidationModuleSource(TREE_FIXTURE))
    expect(sharingSource).toEqual(buildApplyValidationModuleSource(SHARING_FIXTURE, { shouldShare: defaultShouldShare }))
  })
})
