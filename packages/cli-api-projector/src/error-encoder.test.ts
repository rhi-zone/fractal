// packages/cli-api-projector/src/error-encoder.test.ts — structured error
// types: composable error-to-transport mapping (CliErrorEncoder/cliErrors).
//
// Covers: a handler returns `err({ kind, ... })`; `cliErrors` maps `kind` to
// an exit code + message. Unmatched kinds and an absent `errorEncoder` fall
// back to the existing default (exit 1, `Error: ${JSON.stringify(error)}`).
// See docs/design/middleware-and-caller-context.md.

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { err, ok } from "@rhi-zone/fractal-api-tree"
import { cliErrors, CliError, runCli } from "./cli.ts"

function makeIO() {
  const writes: Array<{ stream: "out" | "err"; text: string }> = []
  return {
    writes,
    out: () => writes.filter((w) => w.stream === "out").map((w) => w.text).join(""),
    err: () => writes.filter((w) => w.stream === "err").map((w) => w.text).join(""),
    io: {
      stdout: { write: (s: string) => { writes.push({ stream: "out", text: s }) } },
      stderr: { write: (s: string) => { writes.push({ stream: "err", text: s }) } },
      confirm: async () => true,
    },
  }
}

function tree() {
  return api_({
    getBook: op((input: { id: string }) => {
      if (input.id === "missing") return err({ kind: "notFound", message: "Book not found" })
      if (input.id === "dupe") return err({ kind: "conflict", message: "already exists" })
      if (input.id === "weird") return err({ kind: "somethingElse", message: "???" })
      return ok({ id: input.id, title: "Dune" })
    }, {}),
  })
}

describe("cliErrors", () => {
  it("maps a matched error kind to its configured exit code + message", async () => {
    const { io, err: errOut } = makeIO()
    const encoder = cliErrors({ notFound: { exit: 2, message: "book not found" } })
    let caught: CliError | undefined
    try {
      await runCli(tree(), ["getBook", "--id", "missing"], io, { errorEncoder: encoder })
    } catch (e) {
      caught = e as CliError
    }
    expect(caught).toBeInstanceOf(CliError)
    expect(caught?.exitCode).toBe(2)
    expect(errOut()).toBe("book not found\n")
  })

  it("a mapping entry with only `exit` keeps the default message", async () => {
    const { io } = makeIO()
    const encoder = cliErrors({ conflict: { exit: 3 } })
    let caught: CliError | undefined
    try {
      await runCli(tree(), ["getBook", "--id", "dupe"], io, { errorEncoder: encoder })
    } catch (e) {
      caught = e as CliError
    }
    expect(caught?.exitCode).toBe(3)
    expect(caught?.message).toBe(`Error: ${JSON.stringify({ kind: "conflict", message: "already exists" })}`)
  })

  it("unknown error kind (no match) falls back to the default exit 1", async () => {
    const { io } = makeIO()
    const encoder = cliErrors({ notFound: { exit: 2 } })
    let caught: CliError | undefined
    try {
      await runCli(tree(), ["getBook", "--id", "weird"], io, { errorEncoder: encoder })
    } catch (e) {
      caught = e as CliError
    }
    expect(caught?.exitCode).toBe(1)
  })

  it("no errorEncoder configured — current exit-1 default behavior unchanged", async () => {
    const { io } = makeIO()
    let caught: CliError | undefined
    try {
      await runCli(tree(), ["getBook", "--id", "missing"], io)
    } catch (e) {
      caught = e as CliError
    }
    expect(caught?.exitCode).toBe(1)
    expect(caught?.message).toBe(`Error: ${JSON.stringify({ kind: "notFound", message: "Book not found" })}`)
  })

  it("a successful Result still prints its value, unaffected by errorEncoder", async () => {
    const { io, out } = makeIO()
    const encoder = cliErrors({ notFound: { exit: 2 } })
    await runCli(tree(), ["getBook", "--id", "1"], io, { errorEncoder: encoder })
    expect(JSON.parse(out())).toEqual({ id: "1", title: "Dune" })
  })
})
