// Astro only hydrates a component into its own independent React root when
// it carries an explicit `client:*` directive; a component with no
// directive that's nested inside another component's JSX tree gets bundled
// into that ancestor's island instead. `http-route-reference.ts`'s
// Starlight renderer emits `<ApiExplorer client:load .../>` directly inside
// each generated MDX page, so ApiExplorer is its own top-level island root
// on every page, never nested inside a Provider component's render tree. An
// `ApiExplorerFetchProvider` mounted from a separate file (e.g. a Starlight
// layout/Head override, even under its own `client:*` directive) is a
// disconnected React hydration root — React context cannot cross that
// boundary, so the Docusaurus site's "wrap the whole app in one Provider"
// pattern has no equivalent for this per-page bare `client:load` shape.
//
// `ApiExplorerFetchProvider` exists because a JS function can't survive
// MDX-prop serialization (fetch-context.tsx's doc comment); React context
// is one way to reach every instance without a per-page prop, not the only
// one. `useApiExplorerFetch()` falls back to the ambient global `fetch`
// when no Provider wraps a given `<ApiExplorer/>`, and the global `fetch`
// binding is visible across every independently-hydrated island on a page,
// since they share the same `window`. Monkey-patching `window.fetch` once,
// before any island hydrates, reaches every `<ApiExplorer/>` site-wide with
// no React-context involvement — see CustomHead.astro, which loads this as
// a Vite-bundled module script in <head>.
//
// Runs in-process against the same fixture tree generate.ts projects to
// MDX (src/fixture-tree.ts), reached through Astro's per-directive island
// model instead of Docusaurus's single-React-tree app shell.

import { createFetch, toDropInFetch } from "@rhi-zone/fractal-http-api-projector/presets";
import { api } from "./fixture-tree.ts";

const dropInFetch = toDropInFetch(createFetch(api));

// Cast needed: `window.fetch`'s ambient type is the full `typeof fetch`
// (may carry extra members like `preconnect` depending on lib set), while
// `dropInFetch` is `DropInFetch` — the literal call signature only. See
// fetch-context.tsx's own doc comment for why this package deliberately
// types against the call signature, not `typeof fetch`.
window.fetch = dropInFetch as typeof fetch;
