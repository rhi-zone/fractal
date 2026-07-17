// packages/cli-api-projector/src/cli-coercion.test.ts — @rhi-zone/fractal-cli-api-projector
//
// Type coercion from JSON Schema: unit tests against `coerceInput` directly
// (fast, no tree/handler machinery), plus a handful of `runCli` integration
// tests confirming coercion actually runs before the handler is invoked and
// that a coercion failure short-circuits the call (handler never runs).

import { describe, it, expect } from "bun:test"
import { coerceInput, runCli, CliError } from "./cli.ts"
import { api, op } from "@rhi-zone/fractal-api-tree/node"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"

// ============================================================================
// coerceInput — unit tests
// ============================================================================

describe("coerceInput", () => {
  it("passes input through unchanged when schema is undefined", () => {
    const input = { a: "1", b: "true" }
    expect(coerceInput(input, undefined)).toEqual(input)
  })

  it("passes input through unchanged when schema has no properties", () => {
    const input = { a: "1" }
    expect(coerceInput(input, { type: "object" })).toEqual(input)
  })

  it("leaves a field not present in schema.properties untouched (backward compat)", () => {
    const schema: JsonSchema = { type: "object", properties: { known: { type: "number" } } }
    const out = coerceInput({ known: "1", unknown: "raw" }, schema)
    expect(out["known"]).toBe(1)
    expect(out["unknown"]).toBe("raw")
  })

  it("leaves string-typed fields as-is", () => {
    const schema: JsonSchema = { type: "object", properties: { title: { type: "string" } } }
    const out = coerceInput({ title: "Dune" }, schema)
    expect(out["title"]).toBe("Dune")
  })

  describe("number / integer", () => {
    const numberSchema: JsonSchema = { type: "object", properties: { count: { type: "number" } } }
    // "integer" isn't in JsonSchema's typed `type` union, but the extractor's
    // underlying type-ir projection legitimately emits it (see cli.ts's
    // coerceScalar doc comment) — same `as` cast at the same boundary.
    const integerSchema = {
      type: "object",
      properties: { qty: { type: "integer" } },
    } as unknown as JsonSchema

    it("coerces a numeric string to a number", () => {
      expect(coerceInput({ count: "42" }, numberSchema)).toEqual({ count: 42 })
    })

    it("coerces a float string for type: number", () => {
      expect(coerceInput({ count: "3.5" }, numberSchema)).toEqual({ count: 3.5 })
    })

    it("rejects a non-numeric string with a CliError (NaN)", () => {
      expect(() => coerceInput({ count: "abc" }, numberSchema)).toThrow(CliError)
      expect(() => coerceInput({ count: "abc" }, numberSchema)).toThrow(/expected a number/)
    })

    it("coerces a valid integer string for type: integer", () => {
      expect(coerceInput({ qty: "3" }, integerSchema)).toEqual({ qty: 3 })
    })

    it("rejects a non-integer numeric string for type: integer", () => {
      expect(() => coerceInput({ qty: "3.5" }, integerSchema)).toThrow(/expected an integer/)
    })

    it("rejects a boolean flag (no value) for a number field", () => {
      expect(() => coerceInput({ count: true }, numberSchema)).toThrow(/expected a number/)
    })
  })

  describe("boolean", () => {
    const schema: JsonSchema = { type: "object", properties: { verbose: { type: "boolean" } } }

    it.each([
      ["true", true],
      ["1", true],
      ["yes", true],
      ["false", false],
      ["0", false],
      ["no", false],
    ])("coerces %p to %p", (raw, expected) => {
      expect(coerceInput({ verbose: raw }, schema)).toEqual({ verbose: expected })
    })

    it("passes an already-boolean value (bare flag) through unchanged", () => {
      expect(coerceInput({ verbose: true }, schema)).toEqual({ verbose: true })
    })

    it("rejects an unparseable boolean string", () => {
      expect(() => coerceInput({ verbose: "maybe" }, schema)).toThrow(CliError)
      expect(() => coerceInput({ verbose: "maybe" }, schema)).toThrow(/expected a boolean/)
    })
  })

  describe("array", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "number" } } },
    }

    it("coerces each element of a repeated flag against items", () => {
      expect(coerceInput({ tags: ["1", "2", "3"] }, schema)).toEqual({ tags: [1, 2, 3] })
    })

    it("wraps a single scalar value into a one-element array", () => {
      expect(coerceInput({ tags: "5" }, schema)).toEqual({ tags: [5] })
    })

    it("rejects a non-numeric element", () => {
      expect(() => coerceInput({ tags: ["1", "x"] }, schema)).toThrow(/expected a number/)
    })

    it("leaves array values as-is when items has no coercible type", () => {
      const stringArraySchema: JsonSchema = {
        type: "object",
        properties: { names: { type: "array", items: { type: "string" } } },
      }
      expect(coerceInput({ names: ["a", "b"] }, stringArraySchema)).toEqual({ names: ["a", "b"] })
    })
  })

  describe("enum", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { genre: { type: "string", enum: ["Sci-Fi", "Fantasy", "Horror"] } },
    }

    it("passes a valid enum member through", () => {
      expect(coerceInput({ genre: "Fantasy" }, schema)).toEqual({ genre: "Fantasy" })
    })

    it("rejects a value not in the enum, listing the valid options", () => {
      expect(() => coerceInput({ genre: "Romance" }, schema)).toThrow(CliError)
      expect(() => coerceInput({ genre: "Romance" }, schema)).toThrow(/Sci-Fi, Fantasy, Horror/)
    })

    it("suggests the closest enum match on a near-miss", () => {
      expect(() => coerceInput({ genre: "Sci-fi" }, schema)).toThrow(/Did you mean "Sci-Fi"/)
    })
  })
})

// ============================================================================
// runCli integration — coercion runs before the handler, and blocks it on failure
// ============================================================================

describe("runCli — type coercion wired into dispatch", () => {
  function makeMockIO() {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      io: {
        stdout: { write: (s: string) => { out.push(s) } },
        stderr: { write: (s: string) => { err.push(s) } },
        confirm: async () => true,
      },
    }
  }

  const tree = api({
    widgets: api({
      create: op((input: { name: string; qty: number; ready: boolean }) => input),
    }),
  })

  const schemas: SchemaMap = {
    widgets_create: {
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: { type: "number" },
          ready: { type: "boolean" },
        },
        required: ["name", "qty"],
      },
    },
  }

  it("coerces --qty and --ready to real number/boolean before the handler sees them", async () => {
    const mock = makeMockIO()
    await runCli(
      tree,
      ["widgets", "create", "--name", "Widget", "--qty", "3", "--ready", "true"],
      mock.io,
      { schemas },
    )
    const result = JSON.parse(mock.out.join(""))
    expect(result).toEqual({ name: "Widget", qty: 3, ready: true })
  })

  it("without a schemas map, flag values stay strings (unchanged, backward-compatible)", async () => {
    const mock = makeMockIO()
    await runCli(
      tree,
      ["widgets", "create", "--name", "Widget", "--qty", "3", "--ready", "true"],
      mock.io,
      // no `schemas` option
    )
    const result = JSON.parse(mock.out.join(""))
    expect(result).toEqual({ name: "Widget", qty: "3", ready: "true" })
  })

  it("a coercion failure throws CliError and never calls the handler", async () => {
    let handlerCalled = false
    const trackedTree = api({
      widgets: api({
        create: op((input: unknown) => {
          handlerCalled = true
          return input
        }),
      }),
    })
    const mock = makeMockIO()
    await expect(
      runCli(
        trackedTree,
        ["widgets", "create", "--name", "Widget", "--qty", "not-a-number"],
        mock.io,
        { schemas },
      ),
    ).rejects.toBeInstanceOf(CliError)
    expect(handlerCalled).toBe(false)
    expect(mock.err.join("")).toContain("expected a number")
  })
})
