// packages/api-tree/src/build.test.ts — build orchestrator tests
//
// Covers: the build orchestrator wires extraction (extract.ts/tree.ts) ->
// @rhi-zone/fractal-type-ir's compileValidatorModule end-to-end, entryFile ->
// compiled module.

import { describe, expect, it } from "bun:test"
import { buildValidatorModuleSource, stubValidatorModuleSource } from "./build.ts"

/** Strip TypeScript syntax (type annotations, `as` casts, `import type`) via
 * Bun's transpiler — `buildValidatorModuleSource` now emits typed guards, so
 * the raw source is no longer plain JS `new Function` can parse directly;
 * this mirrors what the consuming toolchain (Bun/tsc) does to the generated
 * file before running it. */
const tsTranspiler = new Bun.Transpiler({ loader: "ts" })

/** Evaluate a `compileValidatorModule(...)`-produced module source into its `validators` map. */
function evalModule(source: string): Record<string, (bag: Record<string, unknown>) => { kind: "ok" | "err"; value?: unknown; error?: unknown }> {
  const commonJs = tsTranspiler.transformSync(source).replace("export const validators", "const validators") + "\nreturn validators;"
  return new Function(commonJs)()
}

describe("build orchestrator — entryFile -> compiled module, end-to-end", () => {
  const FIXTURE = `${import.meta.dir}/__fixtures__/tree.fixture.ts`

  it("builds a validator module from the tree fixture, keyed by route path", () => {
    const source = buildValidatorModuleSource(FIXTURE)
    expect(source).toContain('"users/create"')
    expect(source).toContain('"users/:userId/get"')

    const validators = evalModule(source)
    expect(
      validators["users/create"]!({
        name: "Alice",
        roles: ["admin"],
        address: { street: "Main" },
      }).kind,
    ).toBe("ok")
    expect(validators["users/create"]!({}).kind).toBe("err")
    expect(validators["users/:userId/get"]!({ userId: "u1" }).kind).toBe("ok")
  })

  it("stubValidatorModuleSource emits an empty validators map", () => {
    expect(evalModule(stubValidatorModuleSource())).toEqual({})
  })

  it("without an outFile, a NAMED parameter type inlines its structure (no import, since there's no output location to resolve one against)", () => {
    const source = buildValidatorModuleSource(FIXTURE)
    expect(source).not.toContain("import type")
    expect(source).toContain("value is { q?: string }")
  })

  it("given an outFile, a NAMED parameter type (BookQuery, __fixtures__/tree.fixture.ts) is imported by a path relative to outFile, not inlined", () => {
    const outFile = `${import.meta.dir}/generated/validators.ts`
    const source = buildValidatorModuleSource(FIXTURE, outFile)
    expect(source).toContain('import type { BookQuery } from "../__fixtures__/tree.fixture.ts"')
    expect(source).toContain("value is BookQuery")
    expect(source).not.toContain("value is { q?: string }")

    const validators = evalModule(source)
    expect(validators["namedType/search"]!({ q: "x" }).kind).toBe("ok")
    expect(validators["namedType/search"]!({}).kind).toBe("ok")
  })
})
