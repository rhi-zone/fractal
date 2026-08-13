// A stand-in for an already-projected HTTP route tree: `methods` at a leaf
// position instead of a direct `handler`. That property is what tells a
// projected tree from a `Node` tree at the type level — this package cannot
// import `HttpRoute` itself (http-api-projector depends on api-tree, not the
// reverse), so both the runtime walker and the codegen's `isNodeType` work
// structurally, and these fixtures mirror the shape rather than importing it.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import type { Node } from "../node.ts";

export type FakeRoute = {
  readonly methods?: Readonly<
    Record<string, { readonly handler: (input: never) => unknown; readonly meta: object }>
  >;
  readonly children?: Readonly<Record<string, FakeRoute>>;
  readonly fallback?: { readonly name: string; readonly subtree: FakeRoute };
  readonly meta: object;
};

/** The `httpProjection(apiTree)`-shaped wrapper a call site has to be traced
 * through (unwrap one level, find the Node-typed argument). Ambient: no
 * fixture ever runs, only its types are read. */
export declare function fakeProjection(node: Node): FakeRoute;
