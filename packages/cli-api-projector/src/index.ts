// CLI projection for the function-core tree.
// Exports runCli, CliIO, CliLeafMeta/CliSharedMeta, CliOpts, walkCliCommands, CliCommandEntry, getCliMeta.

export type {
  CliAlsContext,
  CliErrorEncoder,
  CliErrorResponse,
  CliIO,
  CliLeafMeta,
  CliLeafMetaProperties,
  CliMiddleware,
  CliOpts,
  CliSharedMeta,
  CliSharedMetaProperties,
  CliCommandEntry,
} from "./cli.ts";
export type { CliStoreBag, CliStores } from "./cli.ts";
export { cliErrors, getCliMeta, runCli, walkCliCommands } from "./cli.ts";
export { cli, source } from "./source.ts";
export type { CliStoreName } from "./source.ts";
