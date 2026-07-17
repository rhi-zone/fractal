// packages/cli-api-projector/src/index.ts — @rhi-zone/fractal-cli-api-projector
//
// CLI projection for the function-core tree.
// Exports runCli, CliIO, CliMeta, CliOpts, walkCliCommands, CliCommandEntry, getCliMeta.

export type { CliIO, CliMeta, CliOpts, CliCommandEntry } from "./cli.ts"
export { getCliMeta, runCli, walkCliCommands } from "./cli.ts"
