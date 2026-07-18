// packages/cli-api-projector/src/cli-validators.test.ts — @rhi-zone/fractal-cli-api-projector
//
// Node-level generated-validator wiring: `runCli`'s `opts.validators` wraps
// the tree via `wrapValidators` (@rhi-zone/fractal-api-tree/build) before
// dispatch — the leaf's generated `parse()` runs instead of (not alongside)
// `coerceInput`/`applyDefaults`/`validateRequired` for any leaf a generated
// validator covers; leaves it doesn't cover keep using the schema-derived
// fallback path exactly as before (see cli-coercion.test.ts).

import { describe, it, expect } from "bun:test"
import { runCli, CliError } from "./cli.ts"
import { api, op } from "@rhi-zone/fractal-api-tree/node"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
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

/** A synthetic GeneratedEntry: requires `qty` to be a numeric string,
 * coercing it to a number on success. */
function qtyEntry(): GeneratedEntry {
  return {
    parse: (value: unknown) => {
      if (typeof value !== "object" || value === null) {
        return { kind: "err", errors: [{ kind: "type", path: [], expected: "object", actual: value }] }
      }
      const v = value as Record<string, unknown>
      if (typeof v.qty !== "string" || !/^\d+$/.test(v.qty)) {
        return { kind: "err", errors: [{ kind: "type", path: ["qty"], expected: "numeric string", actual: v.qty }] }
      }
      return { kind: "ok", value: { ...v, qty: Number(v.qty) } }
    },
  }
}

describe("runCli — generated validators (opts.validators) wired via wrapValidators", () => {
  const tree = api({
    widgets: api({
      create: op((input: { name: string; qty: number }) => input),
    }),
  })

  it("routes input through the generated validator's parse() instead of coerceInput", async () => {
    const mock = makeMockIO()
    await runCli(
      tree,
      ["widgets", "create", "--name", "Widget", "--qty", "3"],
      mock.io,
      { validators: { "widgets/create": qtyEntry() } },
    )
    const result = JSON.parse(mock.out.join(""))
    expect(result).toEqual({ name: "Widget", qty: 3 })
  })

  it("a generated-validator rejection surfaces as a CliError and never calls the handler", async () => {
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
        { validators: { "widgets/create": qtyEntry() } },
      ),
    ).rejects.toThrow(CliError)
    expect(handlerCalled).toBe(false)
    expect(mock.err.join("")).toContain("Validation failed")
  })

  it("a leaf with no matching generated-validator entry keeps using coerceInput/validateRequired (fallback)", async () => {
    const schemas: SchemaMap = {
      widgets_create: {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, qty: { type: "number" } },
          required: ["name", "qty"],
        },
      },
    }
    const mock = makeMockIO()
    await runCli(
      tree,
      ["widgets", "create", "--name", "Widget", "--qty", "3"],
      mock.io,
      // `validators` provided, but keyed under a DIFFERENT path — this leaf
      // isn't covered, so it must fall back to schema-derived coercion.
      { schemas, validators: { "other/path": qtyEntry() } },
    )
    const result = JSON.parse(mock.out.join(""))
    expect(result).toEqual({ name: "Widget", qty: 3 })
  })

  it("without opts.validators at all, behavior is unchanged from the pre-existing coerceInput path", async () => {
    const schemas: SchemaMap = {
      widgets_create: {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, qty: { type: "number" } },
          required: ["name", "qty"],
        },
      },
    }
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "create", "--name", "Widget", "--qty", "3"], mock.io, { schemas })
    const result = JSON.parse(mock.out.join(""))
    expect(result).toEqual({ name: "Widget", qty: 3 })
  })
})
