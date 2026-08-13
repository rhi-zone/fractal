// examples/library-api/src/stores.ts — the deployment's ONE store augmentation
//
// This example app is the closest thing this repo has to a real deployment, so
// it owns the single `declare module` block that composes the store registry —
// per docs/design/typed-store-spec.md §3. Projector packages export inert
// fragment interfaces (`HttpStores`, `McpStores`, …) and augment nothing
// themselves; a deployment names the fragments it actually composes, here.
//
// This app projects its tree over HTTP (app.test.ts, client.test.ts) and MCP,
// so it composes those two fragments and no others: importing, say, the CLI
// projector would NOT silently add `flag`/`env` to what `stores.x` accepts —
// that inertness is the property §3 exists to provide.
//
// No service store is declared: this app registers no long-lived,
// deployment-provided capability (§2's second member kind). One would be added
// here as a REQUIRED member, and supplied at the app's composition root through
// the single `ServiceStores`-typed registration object (§4).
//
// Two things about this file are load-bearing:
//   - The `import "@rhi-zone/fractal-api-tree/input"` must precede the
//     `declare module` block. Without an import of the augmented module in the
//     SAME file, the block SHADOWS `StoreRegistry` (declares a fresh one)
//     instead of augmenting it.
//   - Nothing needs to import THIS file. It carries no runtime value; being
//     part of the compilation (tsconfig's `include`) is what applies it.

import "@rhi-zone/fractal-api-tree/input";
import type { HttpStores } from "@rhi-zone/fractal-http-api-projector";
import type { McpStores } from "@rhi-zone/fractal-mcp-api-projector";

declare module "@rhi-zone/fractal-api-tree/input" {
  interface StoreRegistry extends HttpStores, McpStores {}
}
