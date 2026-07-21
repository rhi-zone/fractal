# @rhi-zone/fractal-cli-api-projector

CLI projection for the function-core tree.

## What it does

Turns an `api()`/`op()` tree into a subcommand-dispatching CLI: tree
position becomes the subcommand path, JSON-ish argv parsing feeds the
handler's input, and tags drive behavior — a `destructive` leaf prompts for
confirmation before running unless the caller opts out. Depends on
`@rhi-zone/fractal-api-tree/tree` to resolve arguments against extracted
input schemas.

## Key exports

- `runCli(tree, argv, io?, opts?)` — dispatch argv against a tree and run the matched leaf
- `walkCliCommands(tree)` — enumerate all subcommands (path, tags, description) without running one, for help output
- `CliIO` — injectable stdin/stdout/stderr for testing
- `CliOpts` — confirm/no-confirm and other run options
- `CliCommandEntry` — one row of `walkCliCommands`'s output
- Shell completion generation (bash/zsh/fish) from the tree's own shape (`src/completions.ts`)
- JSONL streaming: a handler returning an `AsyncIterable` is streamed as one JSON line per yield, no extra opt-in required

## Usage

```ts
import { runCli } from "@rhi-zone/fractal-cli-api-projector"
import { api } from "./tree.ts"

await runCli(api, ["books", "add", "--title", "Dune", "--author", "Herbert"])
```

## Install

```bash
bun add @rhi-zone/fractal-cli-api-projector
```

See the [root README](../../README.md) for the full picture across all projections.
