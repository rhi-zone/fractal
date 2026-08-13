// packages/api-tree/src/__fixtures__/deployment-store.fixture.ts
//
// api-tree has no real deployment of its own (it's the core package), but its
// own tests exercise `assemble()` against store names no core file declares
// (`query`, `header`, `path`), and exercise the service-store registration
// mechanism (`ServiceStores`/`RequiredServiceStoreKeys`, input.ts) against a
// required member core likewise doesn't declare. Per
// docs/design/typed-store-spec.md §3: projectors never augment core's
// `StoreRegistry` themselves — only a DEPLOYMENT's own file does, exactly
// once. This file is that one file for api-tree's own test suite — the test
// suite's stand-in "deployment."
//
// Sibling to `deployment-meta.fixture.ts`, which does the same job for
// `LeafMeta`/`BranchMeta`; kept as a separate file only because the two
// augment different modules (`../node.ts` vs `../input.ts`).
//
// The `import "../input.ts"` above the `declare module` block is load-bearing:
// without an import of the augmented module in the SAME file, the block
// SHADOWS `StoreRegistry` (declares a fresh one) instead of augmenting it.

import "../input.ts";
import type { HttpStores } from "@rhi-zone/fractal-http-api-projector";

declare module "../input.ts" {
  interface StoreRegistry extends HttpStores {
    /**
     * A stand-in REQUIRED service store — the second kind of member
     * (typed-store-spec §2): deployment-provided and long-lived, not built
     * per-request by a projector, so it carries no `?` and the deployment's
     * single `ServiceStores` registration site is checked against it.
     *
     * Shaped in the CONSUMER's vocabulary — "read a tabular source by id" —
     * never after whatever concrete adapter happens to back it (§9(5)). The
     * shape is the spec's own §7 worked example; api-tree has no real
     * consumer, so this exists purely to give the mechanism something to be
     * checked against.
     */
    tabularSource: {
      read(sourceId: string): Promise<{
        readonly headers: readonly string[];
        readonly rows: readonly (readonly unknown[])[];
      }>;
    };
  }
}
