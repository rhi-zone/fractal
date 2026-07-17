// packages/api-tree/src/build.test.ts — build orchestrator tests
//
// Covers: the build orchestrator wires extraction (extract.ts/tree.ts) ->
// @rhi-zone/fractal-type-ir's compileValidatorModule end-to-end, entryFile ->
// compiled module.

import { describe, expect, it } from "bun:test"
import { buildValidatorModuleSource, stubValidatorModuleSource } from "./build.ts"

/** Evaluate a `compileValidatorModule(...)`-produced module source into its `validators` map. */
function evalModule(source: string): Record<string, (bag: Record<string, unknown>) => { kind: "ok" | "err"; value?: unknown; error?: unknown }> {
  const commonJs = source.replace("export const validators", "const validators") + "\nreturn validators;"
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
})
