# CLI

`@rhi-zone/fractal-cli-api-projector` projects a `Node` tree into a CLI — each branch becomes a subcommand namespace, each leaf a subcommand, dispatch driven by the same tree the HTTP/MCP projections walk.

## What it does

`runCli` walks the tree following `argv` segments as subcommand names until it reaches a leaf, coerces remaining flags into the leaf's input using codegen'd schemas (`coerceInput`/`applyDefaults`/`validateRequired`), then invokes the handler. A leaf tagged `destructive` (or explicitly not `readOnly`) triggers an interactive confirm prompt before running, via the same tag lattice the MCP annotation hints read.

## Basic usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { runCli } from "@rhi-zone/fractal-cli-api-projector"

const tree = api({
  books: api({
    list: op(() => [{ id: "1", title: "Dune" }], { tags: { readOnly: true } }),
    add: op((input: { title: string; author: string }) => ({ id: "2", ...input })),
    remove: op((input: { id: string }) => ({ ok: true }), { tags: { destructive: true } }),
  }),
})

await runCli(tree, ["books", "list"])
await runCli(tree, ["books", "add", "--title", "Dune", "--author", "Herbert"])
await runCli(tree, ["books", "remove", "--id", "2"]) // prompts to confirm — destructive: true
```

## Enumerating commands (help text, completions)

```ts
import { walkCliCommands } from "@rhi-zone/fractal-cli-api-projector"

const entries = walkCliCommands(tree)
// [{ path: ["books", "list"], ... }, { path: ["books", "add"], ... }, ...]
```

Shell completion scripts are generated from the same walk:

```ts
import { generateBashCompletion, generateZshCompletion, generateFishCompletion } from "@rhi-zone/fractal-cli-api-projector/completions"
```

## Key exports

| Export | Description |
|---|---|
| `runCli(tree, argv, opts?)` | Entry point — dispatches an invocation against the tree as nested subcommands |
| `walkCliCommands(tree)` | Flat list of `CliCommandEntry` for help text/completion |
| `cliErrors(mapping)` | Error-to-exit-code/message mapping |
| `coerceInput`/`applyDefaults`/`validateRequired` | Flag-coercion primitives, reused by `runCli` |
| `generateBashCompletion`/`generateZshCompletion`/`generateFishCompletion` | Shell completion script generation |

Tag-driven behavior mirrors the other projections: `destructive`/non-`readOnly` ops get a confirm prompt; codegen'd schemas drive argument parsing and coercion.
