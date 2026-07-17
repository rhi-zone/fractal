// packages/cli-api-projector/src/cli-gaps.test.ts — @rhi-zone/fractal-cli-api-projector
//
// Tests for the mechanical CLI DX gaps closed alongside the coercion/help
// machinery: --version, required-field validation, schema defaults,
// CliMeta.alias dispatch + help text, and Levenshtein "did you mean?"
// suggestions for unknown subcommands.

import { describe, it, expect } from "bun:test"
import {
  runCli,
  CliError,
  coerceInput,
  applyDefaults,
  validateRequired,
} from "./cli.ts"
import { api, op } from "@rhi-zone/fractal-api-tree/node"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"

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

// ============================================================================
// 1. --version
// ============================================================================

describe("--version / -V", () => {
  const tree = api({
    widgets: api({ list: op((_: unknown) => []) }),
  })

  it("--version prints the configured version and returns without dispatching", async () => {
    const mock = makeMockIO()
    await runCli(tree, ["--version"], mock.io, { version: "1.2.3" })
    expect(mock.out.join("").trim()).toBe("1.2.3")
  })

  it("-V is a synonym for --version", async () => {
    const mock = makeMockIO()
    await runCli(tree, ["-V"], mock.io, { version: "1.2.3" })
    expect(mock.out.join("").trim()).toBe("1.2.3")
  })

  it("--version alongside a subcommand path still just prints the version", async () => {
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "list", "--version"], mock.io, { version: "9.9.9" })
    expect(mock.out.join("").trim()).toBe("9.9.9")
  })

  it("--version with no configured version throws CliError", async () => {
    const mock = makeMockIO()
    await expect(runCli(tree, ["--version"], mock.io)).rejects.toBeInstanceOf(CliError)
  })
})

// ============================================================================
// 2. Missing required field validation
// ============================================================================

describe("required field validation", () => {
  const tree = api({
    widgets: api({
      create: op((input: { name: string; qty: number }) => input),
    }),
  })

  const schemas: SchemaMap = {
    widgets_create: {
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: { type: "number" },
        },
        required: ["name", "qty"],
      },
    },
  }

  it("validateRequired passes when all required fields are present", () => {
    expect(() => validateRequired({ name: "a", qty: 1 }, schemas["widgets_create"]!.inputSchema)).not.toThrow()
  })

  it("validateRequired throws CliError listing all missing fields", () => {
    expect(() => validateRequired({}, schemas["widgets_create"]!.inputSchema)).toThrow(CliError)
    expect(() => validateRequired({}, schemas["widgets_create"]!.inputSchema)).toThrow(/--name/)
    expect(() => validateRequired({}, schemas["widgets_create"]!.inputSchema)).toThrow(/--qty/)
  })

  it("validateRequired is a no-op when schema has no `required`", () => {
    expect(() => validateRequired({}, { type: "object" })).not.toThrow()
  })

  it("runCli rejects with CliError and never calls the handler when a required flag is missing", async () => {
    let handlerCalled = false
    const trackedTree = api({
      widgets: api({
        create: op((input: unknown) => { handlerCalled = true; return input }),
      }),
    })
    const mock = makeMockIO()
    await expect(
      runCli(trackedTree, ["widgets", "create", "--name", "Widget"], mock.io, { schemas }),
    ).rejects.toBeInstanceOf(CliError)
    expect(handlerCalled).toBe(false)
    expect(mock.err.join("")).toContain("--qty")
  })

  it("runCli succeeds when all required flags are supplied", async () => {
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "create", "--name", "Widget", "--qty", "3"], mock.io, { schemas })
    expect(JSON.parse(mock.out.join(""))).toEqual({ name: "Widget", qty: 3 })
  })
})

// ============================================================================
// 3. Defaults from schema
// ============================================================================

describe("schema default values", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      qty: { type: "number", default: 1 },
      ready: { type: "boolean", default: false },
    },
  }

  it("applyDefaults fills in an absent field from schema.properties[field].default", () => {
    expect(applyDefaults({ name: "Widget" }, schema)).toEqual({ name: "Widget", qty: 1, ready: false })
  })

  it("applyDefaults does not override a field already present, even if falsy", () => {
    expect(applyDefaults({ name: "Widget", qty: 5, ready: true }, schema)).toEqual({
      name: "Widget",
      qty: 5,
      ready: true,
    })
  })

  it("applyDefaults is a no-op when schema is undefined", () => {
    expect(applyDefaults({ a: 1 }, undefined)).toEqual({ a: 1 })
  })

  it("runCli applies the default for an omitted flag before the handler runs", async () => {
    const tree = api({
      widgets: api({
        create: op((input: { name: string; qty: number }) => input),
      }),
    })
    const schemas: SchemaMap = {
      widgets_create: { inputSchema: schema },
    }
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "create", "--name", "Widget"], mock.io, { schemas })
    expect(JSON.parse(mock.out.join(""))).toEqual({ name: "Widget", qty: 1, ready: false })
  })

  it("an explicit --qty flag overrides the schema default", async () => {
    const tree = api({
      widgets: api({
        create: op((input: { name: string; qty: number }) => input),
      }),
    })
    const schemas: SchemaMap = { widgets_create: { inputSchema: schema } }
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "create", "--name", "Widget", "--qty", "9"], mock.io, { schemas })
    expect(JSON.parse(mock.out.join(""))).toEqual({ name: "Widget", qty: 9, ready: false })
  })

  it("coerceInput + applyDefaults compose: a default fills in, then required validation passes", () => {
    const s: JsonSchema = {
      type: "object",
      properties: { qty: { type: "number", default: 2 } },
      required: ["qty"],
    }
    const coerced = coerceInput({}, s)
    const withDefaults = applyDefaults(coerced, s)
    expect(() => validateRequired(withDefaults, s)).not.toThrow()
    expect(withDefaults).toEqual({ qty: 2 })
  })
})

// ============================================================================
// 4. CliMeta.alias
// ============================================================================

describe("CliMeta.alias", () => {
  const tree = api({
    widgets: api({
      list: op((_: unknown) => ["a", "b"], { cli: { alias: "ls" } }),
      remove: op((input: { id: string }) => ({ removed: input.id })),
    }),
  })

  it("invoking the leaf by its canonical name still works", async () => {
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "list"], mock.io)
    expect(JSON.parse(mock.out.join(""))).toEqual(["a", "b"])
  })

  it("invoking the leaf by its alias dispatches to the same handler", async () => {
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "ls"], mock.io)
    expect(JSON.parse(mock.out.join(""))).toEqual(["a", "b"])
  })

  it("a leaf with no alias is not reachable by an arbitrary name", async () => {
    const mock = makeMockIO()
    await expect(runCli(tree, ["widgets", "rm"], mock.io)).rejects.toBeInstanceOf(CliError)
  })

  it("help text for the containing group shows the alias next to the canonical name", async () => {
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "--help"], mock.io)
    const out = mock.out.join("")
    expect(out).toContain("list")
    expect(out).toContain("(alias: ls)")
  })
})

// ============================================================================
// 5. Unknown subcommand fuzzy suggestions
// ============================================================================

describe("unknown subcommand suggestions", () => {
  const tree = api({
    books: api({
      list: op((_: unknown) => []),
      add: op((input: { title: string }) => input),
    }),
  })

  it("a near-miss subcommand gets a 'Did you mean' suggestion in stderr", async () => {
    const mock = makeMockIO()
    await expect(runCli(tree, ["books", "lst"], mock.io)).rejects.toBeInstanceOf(CliError)
    expect(mock.err.join("")).toContain('Did you mean "books list"?')
  })

  it("the CliError message itself carries the suggestion", async () => {
    const mock = makeMockIO()
    await expect(runCli(tree, ["books", "lst"], mock.io)).rejects.toThrow(/Did you mean "books list"/)
  })

  it("an unknown top-level command still reports 'Unknown command' with the typed path quoted", async () => {
    const mock = makeMockIO()
    await expect(runCli(tree, ["nonexistent"], mock.io)).rejects.toBeInstanceOf(CliError)
    expect(mock.err.join("")).toContain('Unknown command: "nonexistent"')
  })
})
