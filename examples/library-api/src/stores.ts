// The deployment's one store augmentation.
//
// This example app is the closest thing this repo has to a real deployment, so
// it owns the single `declare module` block that composes the store registry —
// per docs/design/typed-store-spec.md §3. Projector packages export inert
// fragment interfaces (`HttpStores`, `McpStores`, …) and augment nothing
// themselves; a deployment names the fragments it actually composes, here.
//
// This app projects its tree over HTTP (app.test.ts, client.test.ts) and MCP,
// so it composes those two fragments and no others — importing, say, the CLI
// projector does not add `flag`/`env` to what `stores.x` accepts; that
// inertness is the property §3 exists to provide.
//
// No service store is declared: this app registers no long-lived,
// deployment-provided capability (§2's second member kind). One would be added
// here as a required member, and supplied at the app's composition root
// through the single `ServiceStores`-typed registration object (§4).
//
// Two things about this file are load-bearing:
//   - The `declare module` block augments `StoreRegistry`, which requires
//     importing the augmented module (`@rhi-zone/fractal-api-tree/input`) in
//     this same file, before the block. An augmentation missing that import
//     declares a fresh `StoreRegistry` instead of extending the existing one.
//   - Nothing needs to import this file. It carries no runtime value; being
//     part of the compilation (tsconfig's `include`) is what applies it.

import "@rhi-zone/fractal-api-tree/input";
import type { HttpStores } from "@rhi-zone/fractal-http-api-projector";
import type { McpStores } from "@rhi-zone/fractal-mcp-api-projector";

declare module "@rhi-zone/fractal-api-tree/input" {
  interface StoreRegistry extends HttpStores, McpStores {}
}
