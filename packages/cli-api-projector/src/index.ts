// packages/cli-api-projector/src/index.ts — @rhi-zone/fractal-cli-api-projector
//
// CLI projection for the function-core tree.
// Exports runCli, CliIO, CliMeta, CliOpts, walkCliCommands, CliCommandEntry, getCliMeta.

export type {
  CliAlsContext,
  CliErrorEncoder,
  CliErrorResponse,
  CliIO,
  CliMeta,
  CliMiddleware,
  CliOpts,
  CliCommandEntry,
} from "./cli.ts"
export { cliErrors, getCliMeta, runCli, walkCliCommands } from "./cli.ts"
