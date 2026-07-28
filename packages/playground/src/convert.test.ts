// packages/playground/src/convert.test.ts — ingest/project/convert bridge tests
//
// Exercises convert.ts's own logic (format-id dispatch, JSON.parse wrapping,
// fromRegistry's root selection, the viaRefFirst/viaNameFirst/viaNameFirstOnly
// multi-def branching, and error propagation) using the exact sample text
// shown in the playground UI (formats.ts) as real input, rather than
// re-testing the underlying type-ir ingestors/projectors themselves (already
// covered in packages/type-ir).

import { describe, expect, test } from "bun:test"
import { convert, ingest, project } from "./convert.ts"
import { inputFormatById, inputFormats, outputFormats } from "./formats.ts"

function sampleFor(id: string): string {
  const sample = inputFormatById(id)?.sample
  if (sample === undefined) throw new Error(`no sample for input format ${id}`)
  return sample
}

describe("ingest", () => {
  for (const format of inputFormats) {
    test(`${format.id}: ingests its own sample into a TypeRefDocument`, () => {
      const doc = ingest(format.id, sampleFor(format.id))
      expect(doc.root).toBeDefined()
      expect(doc.defs).toBeDefined()
    })
  }

  test("unknown input format throws", () => {
    expect(() => ingest("not-a-real-format", "{}")).toThrow(/unknown input format/)
  })

  test("json-schema: malformed JSON surfaces a parse error, not a silent empty doc", () => {
    expect(() => ingest("json-schema", "{ not valid json")).toThrow()
  })

  test("graphql: registry-based ingestor picks the first declared name as root", () => {
    const doc = ingest(
      "graphql",
      `type Alpha { id: ID! }\ntype Beta { name: String! }`,
    )
    expect(doc.defs["Alpha"]).toBeDefined()
    expect(doc.defs["Beta"]).toBeDefined()
    expect(doc.root).toEqual(doc.defs["Alpha"]!)
  })

  test("graphql: malformed SDL surfaces a parse error", () => {
    expect(() => ingest("graphql", "type Broken {")).toThrow()
  })

  test("standard-schema: JSON-Schema-export envelope path", () => {
    const doc = ingest(
      "standard-schema",
      JSON.stringify({ vendor: "zod", jsonSchema: { type: "object", properties: { id: { type: "string" } } } }),
    )
    expect(doc.root).toBeDefined()
  })

  test("standard-schema: runtime-sample fallback path (no jsonSchema key)", () => {
    const doc = ingest("standard-schema", JSON.stringify({ vendor: "valibot", sample: { id: "abc" } }))
    expect(doc.root).toBeDefined()
  })
})

describe("project", () => {
  const doc = ingest("json-schema", sampleFor("json-schema"))

  for (const format of outputFormats) {
    test(`${format.id}: renders the sample document without throwing`, () => {
      const rendered = project(format.id, doc)
      expect(typeof rendered).toBe("string")
      expect(rendered.length).toBeGreaterThan(0)
    })
  }

  test("unknown output format throws", () => {
    expect(() => project("not-a-real-format", doc)).toThrow(/unknown output format/)
  })

  test("multi-def document renders one declaration per registry entry (viaRefFirst family)", () => {
    const multiDoc = ingest("graphql", `type Alpha { id: ID! }\ntype Beta { name: String! }`)
    const rendered = project("python-dataclass", multiDoc)
    expect(rendered).toContain("Alpha")
    expect(rendered).toContain("Beta")
  })

  test("multi-def document uses the plural declarations form (viaNameFirst family)", () => {
    const multiDoc = ingest("graphql", `type Alpha { id: ID! }\ntype Beta { name: String! }`)
    const rendered = project("typescript", multiDoc)
    expect(rendered).toContain("Alpha")
    expect(rendered).toContain("Beta")
  })

  test("sql: table name is snake_cased from the type name", () => {
    const multiDoc = ingest("graphql", `type PersonAccount { id: ID! }`)
    const rendered = project("sql", multiDoc)
    expect(rendered.toLowerCase()).toContain("person_account")
  })

  test("json-schema/openapi projectors return valid JSON text", () => {
    for (const id of ["jtd", "json-schema", "json-schema-07", "json-schema-04", "openapi30", "openapi20"]) {
      expect(() => JSON.parse(project(id, doc))).not.toThrow()
    }
  })
})

describe("convert", () => {
  test("round trips json-schema -> typescript", () => {
    const out = convert("json-schema", "typescript", sampleFor("json-schema"))
    expect(out).toContain("string")
  })

  test("propagates ingest errors (bad input format)", () => {
    expect(() => convert("not-a-real-format", "typescript", "{}")).toThrow(/unknown input format/)
  })

  test("propagates project errors (bad output format)", () => {
    expect(() => convert("json-schema", "not-a-real-format", sampleFor("json-schema"))).toThrow(
      /unknown output format/,
    )
  })

  test("every input sample converts cleanly to every output format", () => {
    for (const input of inputFormats) {
      for (const output of outputFormats) {
        expect(() => convert(input.id, output.id, sampleFor(input.id))).not.toThrow()
      }
    }
  })
})
