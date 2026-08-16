// Codegen entry point: generates a standalone typed TypeScript client for
// the library-api example (src/tree.ts) and writes it to
// src/client.generated.ts. Run via `bun run codegen:client` (see
// package.json).
//
// generateClientFromSource walks the TS source with the TypeScript compiler
// API (same static machinery extractToolSchemas itself uses internally) and
// reconstructs the route structure from types alone — no runtime import of
// the tree at all, so this script has no `import { api } from "../src/tree.ts"`
// (compare git history: it used to `import`, and hand that live value to
// `generateClientFromNode`). `treeId: "api"` disambiguates src/tree.ts's
// three exported tree-shaped values (`api`, `validatedApi`, `httpRoutes`) —
// `api` is the pre-validation, pre-HTTP-projection tree, matching what this
// script always generated the client from.
//
// Must still run at build/codegen time (a Bun/Node process), not bundled
// into the runtime client itself — the TypeScript compiler API dependency
// doesn't go away, only the runtime tree import does (see TODO.md's
// watch-mode entry for what that unblocks).

import { generateClientFromSource } from "@rhi-zone/fractal-http-api-projector/codegen-source";

const treePath = new URL("../src/tree.ts", import.meta.url).pathname;
const outPath = new URL("../src/client.generated.ts", import.meta.url).pathname;

const source = generateClientFromSource(treePath, { treeId: "api" });

await Bun.write(outPath, source);

console.log(`Wrote ${source.length} bytes to ${outPath}`);
