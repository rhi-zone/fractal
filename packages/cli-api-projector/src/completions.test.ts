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
import { escapeJoin } from "@rhi-zone/fractal-api-tree/path";
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree";
import { api as libraryApi } from "../../../examples/library-api/src/tree.ts";

// Mirrors completions.ts's own (unexported) `bashEscape` — the generated
// script embeds every STATICS/FLAGS/HAS_FALLBACK/ENUMS key inside a
// double-quoted bash string literal, so a key containing "\" (which
// `escapeJoin` produces whenever a segment contains the space delimiter or a
// literal backslash) is escaped AGAIN for that embedding, on top of
// `escapeJoin`'s own escaping. Assertions below that check generated source
// text for a raw `escapeJoin`-produced key need this same double-escape to
// match what's actually emitted.
function bashSourceEscape(s: string): string {
  return s.replace(/(["\\$`])/g, "\\$1");
}

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

  // Regression coverage for the escape-join port into the generated bash's
  // own `path="$path $word"` reconstruction (buildBashFunctionLines' `esc=`
  // lines) — see completions.ts's doc comment above that reconstruction for
  // the collision this closes and why the fix has two sides (TS-side
  // `escapeJoin` and a hand-ported bash equivalent) that must agree.
  describe("escape-joined level keys (space/backslash collision)", () => {
    it("STATICS/FLAGS keys differ for two trees that would collide under a plain (unescaped) space-join", () => {
      // Tree A: branch "a" -> leaf "b c" (one child segment containing a
      // literal space). Tree B: branch "a b" -> leaf "c" (the space sits in
      // the FIRST segment instead). A bare `[...path, childKey].join(" ")`
      // produces "a b c" for BOTH — the exact collision escapeJoin exists to
      // rule out (see path.ts's module doc comment). escapeJoin must keep
      // them distinct.
      const treeA = api({ a: api({ "b c": op((input: { x: string }) => input) }) });
      const treeB = api({ "a b": api({ c: op((input: { y: string }) => input) }) });
      const schemasA: SchemaMap = {
        [escapeJoin(["a", "b c"], "_").replace(/-/g, "_")]: {
          inputSchema: { type: "object", properties: { x: { type: "string" } } },
        },
      };
      const schemasB: SchemaMap = {
        [escapeJoin(["a b", "c"], "_").replace(/-/g, "_")]: {
          inputSchema: { type: "object", properties: { y: { type: "string" } } },
        },
      };
      const scriptA = generateBashCompletion(treeA, schemasA, "cli");
      const scriptB = generateBashCompletion(treeB, schemasB, "cli");

      const keyA = escapeJoin(["a", "b c"], " ");
      const keyB = escapeJoin(["a b", "c"], " ");
      expect(keyA).not.toBe(keyB); // the injectivity property itself
      expect(keyA).toBe("a b\\ c");
      expect(keyB).toBe("a\\ b c");
      expect(scriptA).toContain(`FLAGS["${bashSourceEscape(keyA)}"]="--x"`);
      expect(scriptB).toContain(`FLAGS["${bashSourceEscape(keyB)}"]="--y"`);
      // And each script's key for the OTHER tree's shape is absent — proves
      // the two positions really do land in different table slots, not just
      // that both keys happen to appear somewhere.
      expect(scriptA).not.toContain(`FLAGS["${bashSourceEscape(keyB)}"]`);
      expect(scriptB).not.toContain(`FLAGS["${bashSourceEscape(keyA)}"]`);
    });

    it("the generated bash's own word-escaping (the `esc=` lines) matches escapeJoin's escapeSegment byte-for-byte, for words containing spaces and backslashes", async () => {
      // The `for c in ${STATICS["$path"]}; do ... done` match loop that
      // precedes the `esc=` lines can only ever match a candidate word that
      // doesn't itself contain a space (bash word-splits STATICS' own
      // space-separated value first — a separate, pre-existing limitation
      // of this generator's `compgen -W`-based design, orthogonal to the
      // key-escaping fix here). So a full end-to-end
      // COMP_WORDS-drives-a-space-containing-ancestor-segment test isn't
      // possible against this generator's architecture. What IS directly
      // testable, and is exactly what the escaping fix's correctness rests
      // on: the two `esc=` lines, run under real bash on arbitrary input
      // words (including ones containing spaces/backslashes), reproduce
      // `escapeJoin([word], " ")` (a single-segment escapeJoin call is
      // exactly `escapeSegment(word, " ")` — see path.ts) byte-for-byte.
      const escSnippet = `
        esc=\${word//\\\\/\\\\\\\\}
        esc=\${esc// /\\\\ }
      `;
      const words = [
        "plain",
        "with space",
        "back\\slash",
        "both\\ combo",
        "trailing\\",
        " leading",
        "double\\\\slash",
        "  multi   space  ",
      ];
      for (const word of words) {
        const proc = Bun.spawn({
          cmd: ["bash", "-c", `word=$1\n${escSnippet}\nprintf '%s' "$esc"`, "--", word],
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        await proc.exited;
        expect(stderr).toBe("");
        expect(stdout).toBe(escapeJoin([word], " "));
      }
    });

    it("path reconstruction through a backslash-containing branch name resolves to the same key TS computed, end to end", async () => {
      // Unlike a space, a literal backslash inside a segment doesn't get
      // word-split by bash's default IFS, so THIS collision-prone case (a
      // subcommand segment containing "\") can be driven end to end through
      // real COMP_WORDS, exercising the full while-loop path reconstruction
      // (STATICS match -> esc= -> path="$path $esc") rather than just the
      // escaping snippet in isolation.
      const tree = api({
        "back\\slash": api({ leaf: op((input: { z: string }) => input) }),
      });
      const schemaKey = escapeJoin(["back\\slash", "leaf"], "_").replace(/-/g, "_");
      const schemas: SchemaMap = {
        [schemaKey]: {
          inputSchema: { type: "object", properties: { z: { type: "string" } } },
        },
      };
      const script = generateBashCompletion(tree, schemas, "cli");
      const expectedKey = escapeJoin(["back\\slash", "leaf"], " ");
      expect(script).toContain(`FLAGS["${bashSourceEscape(expectedKey)}"]="--z"`);

      const funcOnly = script
        .split("\n")
        .filter((l) => !l.startsWith("complete -F"))
        .join("\n");
      // `path` is `local` to `_cli_completions`, so it can't be inspected
      // directly after the function returns — instead, drive the function
      // to the point of completing "--z" and check COMPREPLY: that value is
      // read out of `FLAGS["$path"]`, so it comes back correct if and only
      // if the bash-reconstructed `$path` equals the same key
      // `escapeJoin`/`schemaKeyFor` used on the TS side to populate that
      // table slot in the first place. Same `compgen` stub as the
      // "syntactically well-formed" test above (the real builtin needs an
      // interactive/readline-enabled bash build, not guaranteed here).
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
          COMP_WORDS=(cli "back\\\\slash" leaf --z)
          COMP_CWORD=3
          COMPREPLY=()
          _cli_completions
          echo "\${COMPREPLY[*]}"
        `,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      expect(stderr).toBe("");
      // Sanity: `expectedKey` (what TS computed) is the same string
      // completions.ts's own doc comment claims the bash side reconstructs
      // — this equality holding, plus a correct COMPREPLY below, is exactly
      // the "both sides agree" property under test.
      expect(expectedKey).toBe("back\\\\slash leaf");
      expect(stdout.trim()).toBe("--z");
    });
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
