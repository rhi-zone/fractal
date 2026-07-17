# @rhi-zone/fractal-cli

CLI projection for the function-core tree.

## What it does

Turns an `api()`/`op()` tree into a subcommand-dispatching CLI: tree
position becomes the subcommand path, JSON-ish argv parsing feeds the
handler's input, and tags drive behavior — a `destructive` leaf prompts for
confirmation before running unless the caller opts out. Depends on
`@rhi-zone/fractal-codegen` to resolve arguments against extracted input
schemas.

## Key exports

- `runCli(tree, argv, io?, opts?)` — dispatch argv against a tree and run the matched leaf
- `walkCliCommands(tree)` — enumerate all subcommands (path, tags, description) without running one, for help output
- `CliIO` — injectable stdin/stdout/stderr for testing
- `CliOpts` — confirm/no-confirm and other run options
- `CliCommandEntry` — one row of `walkCliCommands`'s output

## Usage

```ts
import { runCli } from "@rhi-zone/fractal-cli"
import { api } from "./tree.ts"

await runCli(api, ["books", "add", "--title", "Dune", "--author", "Herbert"])
```
