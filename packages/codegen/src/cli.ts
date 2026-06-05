// packages/codegen/src/cli.ts — @rhi-zone/fractal-codegen CLI
//
// The CODE-FIRST loop made executable: import an app module, run
// `toOpenApi(app, info)` to PROJECT the doc from the live handler tree, then
// `generate` the client + server `.ts` and write them. The app running to project
// the doc is the whole point — the handler tree is truth, the doc + generated
// code are downstream projections.
//
// Usage:
//   fractal-codegen <app-module> --out <dir> [--title T] [--version V] \
//                   [--export app] [--client-type ApiClient] [--client-factory createClient]
//
// <app-module> is resolved relative to CWD; its named export (default `app`) must
// be a `Reflected<unknown>` (a root combinator). Outputs <dir>/client.ts and
// <dir>/server.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Reflected } from "@rhi-zone/fractal-core";
import { toOpenApi } from "@rhi-zone/fractal-openapi";
import { generate, type GenerateOptions } from "./index.ts";

interface CliArgs {
  readonly module: string;
  readonly out: string;
  readonly title: string;
  readonly version: string;
  readonly exportName: string;
  readonly opts: GenerateOptions;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i] ?? "";
    } else {
      positional.push(a);
    }
  }
  const module = positional[0];
  if (module === undefined) {
    throw new Error(
      "usage: fractal-codegen <app-module> --out <dir> [--title T] [--version V] [--export app]",
    );
  }
  const opts: GenerateOptions = {
    ...(flags["client-import"] ? { clientImport: flags["client-import"] } : {}),
    ...(flags["core-import"] ? { coreImport: flags["core-import"] } : {}),
    ...(flags["client-type"] ? { clientTypeName: flags["client-type"] } : {}),
    ...(flags["client-factory"]
      ? { clientFactoryName: flags["client-factory"] }
      : {}),
  };
  return {
    module,
    out: flags["out"] ?? "./generated",
    title: flags["title"] ?? "API",
    version: flags["version"] ?? "0.0.0",
    exportName: flags["export"] ?? "app",
    opts,
  };
}

export async function run(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const modPath = resolve(process.cwd(), args.module);
  const mod = (await import(pathToFileURL(modPath).href)) as Record<string, unknown>;
  const app = mod[args.exportName];
  if (app === undefined) {
    throw new Error(
      `module "${args.module}" has no export "${args.exportName}" (the app/root combinator)`,
    );
  }
  // PROJECT the doc from the live app — the code-first loop.
  const doc = toOpenApi(app as Reflected<unknown>, {
    title: args.title,
    version: args.version,
  });
  const generated = generate(doc, args.opts);

  const outDir = resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });
  const clientPath = resolve(outDir, "client.ts");
  const serverPath = resolve(outDir, "server.ts");
  mkdirSync(dirname(clientPath), { recursive: true });
  writeFileSync(clientPath, generated.client);
  writeFileSync(serverPath, generated.server);
  process.stdout.write(
    `generated:\n  ${clientPath}\n  ${serverPath}\n` +
      `from "${args.module}" export "${args.exportName}" ` +
      `(${Object.keys(doc.paths).length} paths)\n`,
  );
}

// Invoked directly (bun/node run): parse process.argv and go.
if (import.meta.main === true || process.argv[1]?.endsWith("cli.ts")) {
  run(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`fractal-codegen: ${String(e)}\n`);
    process.exit(1);
  });
}
