// packages/cli-api-projector/src/cli-input.test.ts — @rhi-zone/fractal-cli-api-projector
//
// Tests for the CLI's input assembly, now wired to the shared stores/
// sourceMap/assemble pipeline (packages/api-tree/src/input.ts) instead of a
// CLI-local flags+slugs merge. Covers:
//   - default behavior unchanged (flags + slugs, slugs win)
//   - the new "env" store, reachable via a leaf's `meta.cli.sourceMap`
//   - a sourceMap override taking precedence over the primary "flag" store
//   - coercion/defaults/validation still running on the assembled bag

import { describe, it, expect } from "bun:test"
import { runCli, CliError } from "./cli.ts"
import { api, op } from "@rhi-zone/fractal-api-tree/node"
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

describe("input assembly — backward compatibility", () => {
  it("flags + slugs merge exactly as before when no sourceMap is configured", async () => {
    const tree = api({
      books: api({
        add: op((input: { title: string; author: string }) => input),
      }),
    })
    const mock = makeMockIO()
    await runCli(tree, ["books", "add", "--title", "Dune", "--author", "Herbert"], mock.io)
    expect(JSON.parse(mock.out.join(""))).toEqual({ title: "Dune", author: "Herbert" })
  })

  it("a fallback-captured slug still overlays a same-named flag", async () => {
    const tree = api({
      books: api({}, {
        fallback: {
          name: "bookId",
          subtree: api({
            read: op((input: { bookId: string }) => input),
          }),
        },
      }),
    })
    const mock = makeMockIO()
    await runCli(tree, ["books", "b-1", "read", "--bookId", "should-be-overridden"], mock.io)
    expect(JSON.parse(mock.out.join(""))).toEqual({ bookId: "b-1" })
  })
})

describe("input assembly — env store via meta.cli.sourceMap", () => {
  const tree = api({
    widgets: api({
      create: op(
        (input: { name: string; apiKey: string }) => input,
        { cli: { sourceMap: { apiKey: { store: "env", key: "API_KEY" } } } },
      ),
    }),
  })

  it("a field declared in sourceMap is pulled from the named env var, not a flag", async () => {
    process.env.API_KEY = "secret-from-env"
    try {
      const mock = makeMockIO()
      await runCli(tree, ["widgets", "create", "--name", "Widget"], mock.io)
      expect(JSON.parse(mock.out.join(""))).toEqual({ name: "Widget", apiKey: "secret-from-env" })
    } finally {
      delete process.env.API_KEY
    }
  })

  it("an explicit --api-key flag does NOT satisfy a field whose sourceMap points at env", async () => {
    delete process.env.API_KEY
    const mock = makeMockIO()
    await runCli(tree, ["widgets", "create", "--name", "Widget", "--apiKey", "from-flag"], mock.io)
    // sourceMap wins: apiKey resolves from (empty) env, not the flag
    expect(JSON.parse(mock.out.join(""))).toEqual({ name: "Widget", apiKey: undefined })
  })
})

describe("input assembly — sourceMap override precedence over primary store", () => {
  it("sourceMap redirect wins even when the same-named flag is also present", async () => {
    const tree = api({
      report: api({
        run: op(
          (input: { format: string }) => input,
          { cli: { sourceMap: { format: { store: "env", key: "REPORT_FORMAT" } } } },
        ),
      }),
    })
    process.env.REPORT_FORMAT = "yaml"
    try {
      const mock = makeMockIO()
      await runCli(tree, ["report", "run", "--format", "json"], mock.io)
      expect(JSON.parse(mock.out.join(""))).toEqual({ format: "yaml" })
    } finally {
      delete process.env.REPORT_FORMAT
    }
  })
})

describe("input assembly — post-assembly coercion/defaults/validation still apply", () => {
  const schemas: SchemaMap = {
    orders_create: {
      inputSchema: {
        type: "object",
        properties: {
          qty: { type: "number" },
          apiKey: { type: "string" },
        },
        required: ["qty", "apiKey"],
      },
    },
  }

  const tree = api({
    orders: api({
      create: op(
        (input: { qty: number; apiKey: string }) => input,
        { cli: { sourceMap: { apiKey: { store: "env", key: "API_KEY" } } } },
      ),
    }),
  })

  it("a numeric flag assembled via the primary store is still coerced to a number", async () => {
    process.env.API_KEY = "k"
    try {
      const mock = makeMockIO()
      await runCli(tree, ["orders", "create", "--qty", "3"], mock.io, { schemas })
      expect(JSON.parse(mock.out.join(""))).toEqual({ qty: 3, apiKey: "k" })
    } finally {
      delete process.env.API_KEY
    }
  })

  it("required-field validation still fires when the sourceMap-declared env var is absent", async () => {
    delete process.env.API_KEY
    const mock = makeMockIO()
    await expect(
      runCli(tree, ["orders", "create", "--qty", "3"], mock.io, { schemas }),
    ).rejects.toBeInstanceOf(CliError)
    expect(mock.err.join("")).toContain("--apiKey")
  })
})
