// packages/cli-api-projector/src/cli-gaps.test.ts — @rhi-zone/fractal-cli-api-projector
//
// Tests for the mechanical CLI DX gaps closed alongside the help machinery:
// --version, CliMeta.alias dispatch + help text, and Levenshtein "did you
// mean?" suggestions for unknown subcommands. Required-field validation and
// schema-default filling used to be a projector-local fallback
// (`validateRequired`/`applyDefaults`, tested directly here) — both were
// deleted (see docs/design/wire-profiles-and-staged-validation.md, "What
// goes away"): that behavior now lives entirely in the generated wire
// validator, wired via `applyValidation(key, tree, "cli")` (see
// cli-validators.test.ts), and a leaf with no such call site gets raw wire
// values with no required-field/defaults handling at all.

import { describe, it, expect } from "bun:test";
import { runCli, CliError } from "./cli.ts";
import { api, op } from "@rhi-zone/fractal-api-tree/node";
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree";

function makeMockIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: {
        write: (s: string) => {
          out.push(s);
        },
      },
      stderr: {
        write: (s: string) => {
          err.push(s);
        },
      },
      confirm: async () => true,
    },
  };
}

// ============================================================================
// 1. --version
// ============================================================================

describe("--version / -V", () => {
  const tree = api({
    widgets: api({ list: op((_: unknown) => []) }),
  });

  it("--version prints the configured version and returns without dispatching", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["--version"], mock.io, { version: "1.2.3" });
    expect(mock.out.join("").trim()).toBe("1.2.3");
  });

  it("-V is a synonym for --version", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["-V"], mock.io, { version: "1.2.3" });
    expect(mock.out.join("").trim()).toBe("1.2.3");
  });

  it("--version alongside a subcommand path still just prints the version", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["widgets", "list", "--version"], mock.io, { version: "9.9.9" });
    expect(mock.out.join("").trim()).toBe("9.9.9");
  });

  it("--version with no configured version throws CliError", async () => {
    const mock = makeMockIO();
    await expect(runCli(tree, ["--version"], mock.io)).rejects.toBeInstanceOf(CliError);
  });
});

// ============================================================================
// 2. No local required-field/defaults handling — `opts.schemas` only drives
// help text now; a leaf with no `applyValidation(key, tree, "cli")` rewriter
// gets raw wire values with no required-field check and no defaults-fill,
// even when a `schemas` map IS supplied (help text and dispatch are
// independent — see `CliOpts.schemas`'s doc comment).
// ============================================================================

describe("no local required-field/defaults fallback", () => {
  const tree = api({
    widgets: api({
      create: op((input: { name: string; qty: number }) => input),
    }),
  });

  const schemas: SchemaMap = {
    widgets_create: {
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: { type: "number", default: 1 },
        },
        required: ["name", "qty"],
      },
    },
  };

  it("runCli does NOT reject when a required flag is missing — supplying `schemas` doesn't gate dispatch", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["widgets", "create", "--name", "Widget"], mock.io, { schemas });
    // No --qty supplied, no defaults-fill: qty is simply absent from input.
    expect(JSON.parse(mock.out.join(""))).toEqual({ name: "Widget" });
  });

  it("runCli does NOT fill in a schema default for an omitted flag", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["widgets", "create", "--name", "Widget"], mock.io, { schemas });
    const result = JSON.parse(mock.out.join(""));
    expect(result.qty).toBeUndefined();
  });

  it("an explicit --qty flag reaches the handler as the raw string, not a number", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["widgets", "create", "--name", "Widget", "--qty", "9"], mock.io, {
      schemas,
    });
    expect(JSON.parse(mock.out.join(""))).toEqual({ name: "Widget", qty: "9" });
  });
});

// ============================================================================
// 4. CliMeta.alias
// ============================================================================

describe("CliMeta.alias", () => {
  const tree = api({
    widgets: api({
      list: op((_: unknown) => ["a", "b"], { cli: { alias: "ls" } }),
      remove: op((input: { id: string }) => ({ removed: input.id })),
    }),
  });

  it("invoking the leaf by its canonical name still works", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["widgets", "list"], mock.io);
    expect(JSON.parse(mock.out.join(""))).toEqual(["a", "b"]);
  });

  it("invoking the leaf by its alias dispatches to the same handler", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["widgets", "ls"], mock.io);
    expect(JSON.parse(mock.out.join(""))).toEqual(["a", "b"]);
  });

  it("a leaf with no alias is not reachable by an arbitrary name", async () => {
    const mock = makeMockIO();
    await expect(runCli(tree, ["widgets", "rm"], mock.io)).rejects.toBeInstanceOf(CliError);
  });

  it("help text for the containing group shows the alias next to the canonical name", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["widgets", "--help"], mock.io);
    const out = mock.out.join("");
    expect(out).toContain("list");
    expect(out).toContain("(alias: ls)");
  });
});

// ============================================================================
// 5. Unknown subcommand fuzzy suggestions
// ============================================================================

describe("unknown subcommand suggestions", () => {
  const tree = api({
    books: api({
      list: op((_: unknown) => []),
      add: op((input: { title: string }) => input),
    }),
  });

  it("a near-miss subcommand gets a 'Did you mean' suggestion in stderr", async () => {
    const mock = makeMockIO();
    await expect(runCli(tree, ["books", "lst"], mock.io)).rejects.toBeInstanceOf(CliError);
    expect(mock.err.join("")).toContain('Did you mean "books list"?');
  });

  it("the CliError message itself carries the suggestion", async () => {
    const mock = makeMockIO();
    await expect(runCli(tree, ["books", "lst"], mock.io)).rejects.toThrow(
      /Did you mean "books list"/,
    );
  });

  it("an unknown top-level command still reports 'Unknown command' with the typed path quoted", async () => {
    const mock = makeMockIO();
    await expect(runCli(tree, ["nonexistent"], mock.io)).rejects.toBeInstanceOf(CliError);
    expect(mock.err.join("")).toContain('Unknown command: "nonexistent"');
  });
});
