# CLI

`@rhi-zone/fractal-cli-api-projector` projects a `Node` tree into a CLI — each branch becomes a subcommand namespace, each leaf a subcommand, dispatch driven by the same tree the HTTP/MCP projections walk.

## What it does

`runCli` walks the tree following `argv` segments as subcommand names until it reaches a leaf, assembles the leaf's input from parsed flags/slugs/env (raw wire values — `string | string[] | true` per flag), then invokes the handler. A leaf tagged `destructive` (or explicitly not `readOnly`) triggers an interactive confirm prompt before running, via the same tag lattice the MCP annotation hints read.

Decode and validation are no longer a projector-local fallback — wire `applyValidation(key, tree, "cli")` (`@rhi-zone/fractal-api-tree/apply-validation`) into `opts.rewriters` in your own entry file (codegen anchors on that call site). CLI's default wire profile is **strict**: only the literal strings `"true"`/`"false"` decode to a boolean (no `"1"`/`"yes"`/`"0"`/`"no"`); numeric strings, arrays, enums, defaults, and required-field checks all come from the generated validator too. A leaf with no matching `applyValidation` call (or before codegen has run) gets the raw wire values passed straight to its handler — no decode, no validation, no defaults.

## Basic usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree";
import { runCli } from "@rhi-zone/fractal-cli-api-projector";

const tree = api({
  books: api({
    list: op(() => [{ id: "1", title: "Dune" }], { tags: { readOnly: true } }),
    add: op((input: { title: string; author: string }) => ({ id: "2", ...input })),
    remove: op((input: { id: string }) => ({ ok: true }), { tags: { destructive: true } }),
  }),
});

await runCli(tree, ["books", "list"]);
await runCli(tree, ["books", "add", "--title", "Dune", "--author", "Herbert"]);
await runCli(tree, ["books", "remove", "--id", "2"]); // prompts to confirm — destructive: true
```

## Enumerating commands (help text, completions)

```ts
import { walkCliCommands } from "@rhi-zone/fractal-cli-api-projector";

const entries = walkCliCommands(tree);
// [{ path: ["books", "list"], ... }, { path: ["books", "add"], ... }, ...]
```

Shell completion scripts are generated from the same walk:

```ts
import {
  generateBashCompletion,
  generateZshCompletion,
  generateFishCompletion,
} from "@rhi-zone/fractal-cli-api-projector/completions";
```

## Key exports

| Export                                                                    | Description                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `runCli(tree, argv, opts?)`                                               | Entry point — dispatches an invocation against the tree as nested subcommands |
| `walkCliCommands(tree)`                                                   | Flat list of `CliCommandEntry` for help text/completion                       |
| `cliErrors(mapping)`                                                      | Error-to-exit-code/message mapping                                            |
| `generateBashCompletion`/`generateZshCompletion`/`generateFishCompletion` | Shell completion script generation                                            |

Tag-driven behavior mirrors the other projections: `destructive`/non-`readOnly` ops get a confirm prompt. Decode/coercion/defaults/required-field validation are wired in per-tree via `applyValidation(key, tree, "cli")` (`@rhi-zone/fractal-api-tree/apply-validation`) — see `CliOpts.rewriters` — not a `runCli` built-in.
