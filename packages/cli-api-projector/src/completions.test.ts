// Shell completion generation. Uses examples/library-api/src/tree.ts (the
// same fixture cli.test.ts uses) plus small synthetic trees for
// schema/enum-specific assertions.

import { describe, it, expect } from "bun:test";
import {
  generateBashCompletion,
  generateZshCompletion,
  generateFishCompletion,
  generateCompletions,
  isShellName,
} from "./completions.ts";
import { runCli, CliError } from "./cli.ts";
import { api, op } from "@rhi-zone/fractal-api-tree/node";
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree";
import { api as libraryApi } from "../../../examples/library-api/src/tree.ts";

// ============================================================================
// isShellName
// ============================================================================

describe("isShellName", () => {
  it("accepts bash/zsh/fish", () => {
    expect(isShellName("bash")).toBe(true);
    expect(isShellName("zsh")).toBe(true);
    expect(isShellName("fish")).toBe(true);
  });

  it("rejects anything else, including undefined", () => {
    expect(isShellName("powershell")).toBe(false);
    expect(isShellName(undefined)).toBe(false);
    expect(isShellName("")).toBe(false);
  });
});

// ============================================================================
// generateBashCompletion — the reference generator (fallback-aware)
// ============================================================================

describe("generateBashCompletion", () => {
  it("lists top-level static subcommands, including the reserved 'completions' command", () => {
    const script = generateBashCompletion(libraryApi, {}, "cli");
    expect(script).toContain('STATICS["__root__"]="books catalog completions"');
  });

  it("lists a branch's own children", () => {
    const script = generateBashCompletion(libraryApi, {}, "cli");
    expect(script).toContain('STATICS["books"]="list add"');
    expect(script).toContain('STATICS["catalog"]="search genres"');
  });

  it("marks a fallback-bearing node and threads completion past the wildcard segment", () => {
    const script = generateBashCompletion(libraryApi, {}, "cli");
    expect(script).toContain('HAS_FALLBACK["books"]=1');
    // "books * " is the position right after the (unknowable) bookId slug —
    // read/replace/remove/checkout must still be completable there.
    expect(script).toContain('STATICS["books *"]="read replace remove checkout"');
    expect(script).toContain('STATICS["books * checkout"]="start reserve"');
  });

  it("emits a complete -F registration for the program name", () => {
    const script = generateBashCompletion(libraryApi, {}, "mylib");
    expect(script).toContain("complete -F _mylib_completions mylib");
  });

  it("derives --flag names from the schema map for a leaf command", () => {
    const tree = api({
      widgets: api({ create: op((input: { name: string; qty: number }) => input) }),
    });
    const schemas: SchemaMap = {
      widgets_create: {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, qty: { type: "number" } },
        },
      },
    };
    const script = generateBashCompletion(tree, schemas, "cli");
    expect(script).toContain('FLAGS["widgets create"]="--name --qty"');
  });

  // A leaf key that itself contains "_" (the schemaKeyFor join delimiter) no
  // longer derives the same SchemaMap lookup key as a genuinely different,
  // deeper tree position — regression coverage for `escapeJoin`
  // (@rhi-zone/fractal-api-tree/path), which `schemaKeyFor` now calls.
  // Before escapeJoin, both "widgets_create" (the flat leaf key) and branch
  // "widgets" -> leaf "create" would look up the identical "widgets_create"
  // schema key; now the flat leaf's own key is escaped and each leaf gets
  // its own flags from its own schema entry.
  it("a leaf key containing '_' derives a distinct (escaped) schema lookup key from a deeper same-named position", () => {
    const tree = api({
      widgets_create: op((input: { flat: boolean }) => input),
      widgets: api({ create: op((input: { name: string; qty: number }) => input) }),
    });
    const schemas: SchemaMap = {
      "widgets\\_create": {
        inputSchema: { type: "object", properties: { flat: { type: "boolean" } } },
      },
      widgets_create: {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, qty: { type: "number" } },
        },
      },
    };
    const script = generateBashCompletion(tree, schemas, "cli");
    expect(script).toContain('FLAGS["widgets_create"]="--flat"');
    expect(script).toContain('FLAGS["widgets create"]="--name --qty"');
  });

  // A `fallback.subtree` that is itself a bare op() leaf (not wrapped in
  // api({...})) — the Node model allows this (api-tree/node.ts's
  // `fallback: { name, subtree: Node }`). A bare leaf has no `children` to
  // enumerate, so `buildLevels` must push it as its own `isLeaf: true` level
  // rather than an empty branch level; otherwise completion at "widgets *"
  // would propose nothing instead of the leaf's flags.
  it("a bare op() fallback.subtree is completed as a leaf (its own flags), not a dead-end branch", () => {
    const tree = api({
      widgets: api(
        {},
        {
          fallback: {
            name: "widgetId",
            subtree: op((input: { widgetId: string; qty: number }) => input),
          },
        },
      ),
    });
    const schemas: SchemaMap = {
      widgets_widgetId: {
        inputSchema: {
          type: "object",
          properties: { widgetId: { type: "string" }, qty: { type: "number" } },
        },
      },
    };
    const script = generateBashCompletion(tree, schemas, "cli");
    expect(script).toContain('HAS_FALLBACK["widgets"]=1');
    expect(script).toContain('FLAGS["widgets *"]="--widgetId --qty"');
    // No spurious branch-level entries for "widgets *" (empty statics/no
    // fallback marker — a leaf level, not a dead-end group).
    expect(script).not.toContain('HAS_FALLBACK["widgets *"]');
  });

  it("derives enum-value completion for a flag with an enum schema", () => {
    const tree = api({
      widgets: api({ create: op((input: { color: string }) => input) }),
    });
    const schemas: SchemaMap = {
      widgets_create: {
        inputSchema: {
          type: "object",
          properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
        },
      },
    };
    const script = generateBashCompletion(tree, schemas, "cli");
    expect(script).toContain('ENUMS["widgets create|--color"]="red green blue"');
  });

  it("is syntactically well-formed enough to source and drive with fake COMP_WORDS", async () => {
    // Exercises the generated function directly under a real bash by
    // sourcing it and driving it with fake COMP_WORDS — verifies the
    // generated script behaves as a working bash completion function.
    const tree = api({
      widgets: api({ create: op((input: { color: string }) => input) }),
    });
    const schemas: SchemaMap = {
      widgets_create: {
        inputSchema: {
          type: "object",
          properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
        },
      },
    };
    const script = generateBashCompletion(tree, schemas, "cli");
    // Strip the trailing `complete -F ...` registration line — the `complete`
    // builtin requires an interactive/readline-enabled bash build, not
    // guaranteed in a test sandbox, and the function body is what's under
    // test here. `compgen` has the same requirement, so it's stubbed below
    // with just enough behavior to cover the `-W wordlist -- prefix` form
    // the generated script uses.
    const funcOnly = script
      .split("\n")
      .filter((l) => !l.startsWith("complete -F"))
      .join("\n");
    const compgenStub = `
      compgen() {
        local words="" cur=""
        while [ $# -gt 0 ]; do
          case "$1" in
            -W) words="$2"; shift 2 ;;
            --) cur="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        for w in $words; do
          case "$w" in
            "$cur"*) echo "$w" ;;
          esac
        done
      }
    `;

    const proc = Bun.spawn({
      cmd: [
        "bash",
        "-c",
        `
        ${compgenStub}
        ${funcOnly}
        COMP_WORDS=(cli widgets create --color g)
        COMP_CWORD=4
        COMPREPLY=()
        _cli_completions
        echo "\${COMPREPLY[*]}"
      `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toBe("green");
  });
});

// ============================================================================
// generateZshCompletion
// ============================================================================

describe("generateZshCompletion", () => {
  it("declares #compdef and loads bashcompinit before reusing the bash function body", () => {
    const script = generateZshCompletion(libraryApi, {}, "cli");
    expect(script.startsWith("#compdef cli")).toBe(true);
    expect(script).toContain("autoload -U +X bashcompinit && bashcompinit");
    expect(script).toContain('STATICS["books"]="list add"');
    expect(script).toContain("complete -F _cli_completions cli");
  });
});

// ============================================================================
// generateFishCompletion
// ============================================================================

describe("generateFishCompletion", () => {
  it("uses __fish_use_subcommand for root-level completions", () => {
    const script = generateFishCompletion(libraryApi, {}, "cli");
    expect(script).toContain("complete -c cli -n \"__fish_use_subcommand\" -a 'books'");
    expect(script).toContain("complete -c cli -n \"__fish_use_subcommand\" -a 'catalog'");
  });

  it("uses __fish_seen_subcommand_from for a nested static branch", () => {
    const script = generateFishCompletion(libraryApi, {}, "cli");
    expect(script).toContain(
      "complete -c cli -n \"__fish_seen_subcommand_from 'books'\" -a 'list'",
    );
    expect(script).toContain(
      "complete -c cli -n \"__fish_seen_subcommand_from 'catalog'\" -a 'search'",
    );
  });

  it("skips fallback (wildcard-capture) subtrees entirely — documented limitation", () => {
    const script = generateFishCompletion(libraryApi, {}, "cli");
    // "read"/"replace"/"remove"/"checkout" live under the books/{bookId}
    // fallback subtree and must not appear as completions under fish.
    expect(script).not.toContain("-a 'read'");
    expect(script).not.toContain("-a 'replace'");
  });

  it("emits -a with enum values for an enum-typed flag", () => {
    const tree = api({
      widgets: api({ create: op((input: { color: string }) => input) }),
    });
    const schemas: SchemaMap = {
      widgets_create: {
        inputSchema: {
          type: "object",
          properties: { color: { type: "string", enum: ["red", "green"] } },
        },
      },
    };
    const script = generateFishCompletion(tree, schemas, "cli");
    expect(script).toContain("-l 'color' -a 'red green'");
  });
});

// ============================================================================
// generateCompletions — dispatch
// ============================================================================

describe("generateCompletions", () => {
  it("dispatches to the matching per-shell generator", () => {
    expect(generateCompletions("bash", libraryApi, {}, "cli")).toBe(
      generateBashCompletion(libraryApi, {}, "cli"),
    );
    expect(generateCompletions("zsh", libraryApi, {}, "cli")).toBe(
      generateZshCompletion(libraryApi, {}, "cli"),
    );
    expect(generateCompletions("fish", libraryApi, {}, "cli")).toBe(
      generateFishCompletion(libraryApi, {}, "cli"),
    );
  });
});

// ============================================================================
// runCli — `completions <shell>` wiring
// ============================================================================

describe("runCli — completions subcommand", () => {
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

  it("prints a bash completion script to stdout", async () => {
    const mock = makeMockIO();
    await runCli(libraryApi, ["completions", "bash"], mock.io);
    expect(mock.out.join("")).toContain("complete -F _cli_completions cli");
  });

  it("respects opts.programName in the generated script", async () => {
    const mock = makeMockIO();
    await runCli(libraryApi, ["completions", "bash"], mock.io, { programName: "mylib" });
    expect(mock.out.join("")).toContain("complete -F _mylib_completions mylib");
  });

  it("throws CliError for a missing shell argument", async () => {
    const mock = makeMockIO();
    await expect(runCli(libraryApi, ["completions"], mock.io)).rejects.toBeInstanceOf(CliError);
  });

  it("throws CliError for an unrecognized shell", async () => {
    const mock = makeMockIO();
    await expect(runCli(libraryApi, ["completions", "powershell"], mock.io)).rejects.toBeInstanceOf(
      CliError,
    );
  });
});
