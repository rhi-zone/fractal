// packages/http-api-projector/src/meta.ts — @rhi-zone/fractal-http-api-projector
//
// Package-level role-split meta fragments — the ONE public surface a
// deployment extends `LeafMeta`/`SharedMeta` with to pick up this whole
// package's meta shape (both the `http` namespace, owned by project.ts, and
// the `openapi` namespace, owned by openapi.ts — merged into this package
// per openapi.ts's own module doc). Inert plain interfaces only, no
// `declare module` — see docs/design/meta-role-split-spec.md §2/§3.
//
// ```ts
// // a deployment's own augmentation file:
// import "@rhi-zone/fractal-api-tree/node"
// import type { HttpLeafMeta, HttpSharedMeta } from "@rhi-zone/fractal-http-api-projector"
// declare module "@rhi-zone/fractal-api-tree/node" {
//   interface LeafMeta extends HttpLeafMeta {}
//   interface SharedMeta extends HttpSharedMeta {}
// }
// ```

import type { HttpLeafMetaProperties, HttpSharedMetaProperties } from "./project.ts";
import type { OpenApiLeafMetaProperties, OpenApiSharedMetaProperties } from "./openapi.ts";

/** This package's `meta` fields valid at BOTH leaf and branch position — `http` (project.ts) + `openapi` (openapi.ts) namespaces combined. */
export interface HttpSharedMeta {
  readonly http?: HttpSharedMetaProperties;
  readonly openapi?: OpenApiSharedMetaProperties;
}

/** This package's `meta` fields valid at LEAF (operation) position — `http` (project.ts) + `openapi` (openapi.ts) namespaces combined. */
export interface HttpLeafMeta {
  readonly http?: HttpLeafMetaProperties;
  readonly openapi?: OpenApiLeafMetaProperties;
}
