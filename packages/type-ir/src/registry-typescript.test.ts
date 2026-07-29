import { describe, expect, it } from "bun:test"

import { createExtractorProgram } from "./from-typescript.ts"
import { project, renderProjection } from "./registry.ts"
import {
  getTypeScriptImporter,
  importTypeScript,
  ingestTypeScript,
  typescriptImporterIds,
  typescriptImporters,
} from "./registry-typescript.ts"

const fixture = `${import.meta.dir}/__fixtures__/from-typescript.fixture.ts`

describe("typescript importer registry", () => {
  it("every id resolves and declares the typescript input shape", () => {
    for (const id of typescriptImporterIds) {
      const importer = getTypeScriptImporter(id)
      expect(importer.id).toBe(id)
      expect(importer.input).toBe("typescript")
    }
    expect(typescriptImporters.size).toBe(typescriptImporterIds.length)
  })

  it("rejects unknown ids", () => {
    expect(() => getTypeScriptImporter("nope")).toThrow(/unknown TypeScript input format/)
  })

  it("extracts an exported type alias, building its own program when none is given", () => {
    const doc = ingestTypeScript("typescript", { file: fixture, symbol: "Sample" })
    expect(doc.root.shape.kind).toBe("object")
  })

  it("reuses a caller-supplied program across extractions", () => {
    const program = createExtractorProgram(fixture)
    const a = importTypeScript({ file: fixture, symbol: "Sample", program })
    const b = importTypeScript({ file: fixture, symbol: "Sample", program })
    expect(a.shape.kind).toBe("object")
    expect(b.shape.kind).toBe("object")
  })

  it("reports a missing export rather than returning an empty type", () => {
    expect(() => importTypeScript({ file: fixture, symbol: "NotThere" })).toThrow(/does not export NotThere/)
  })

  it("reports a missing file", () => {
    expect(() => importTypeScript({ file: `${import.meta.dir}/__fixtures__/nope.ts`, symbol: "Sample" })).toThrow()
  })

  it("feeds the text-in projector registry — the two halves share TypeRefDocument", () => {
    const doc = ingestTypeScript("typescript", { file: fixture, symbol: "Sample" })
    const out = renderProjection(project("python-pydantic", doc, { name: "Sample" }))
    expect(out).toContain("class Sample")
  })
})
