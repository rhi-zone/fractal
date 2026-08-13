// examples/doc-site-verification/starlight/src/fetch-setup-client.ts
//
// Starlight's own site-wide wiring point for `ApiExplorerFetchProvider`
// (docs/design/mocked-fetch-backend.md's "Resolved" section names "a
// Starlight layout override" alongside Docusaurus's Root.tsx swizzle) turns
// out NOT to work the way that doc assumed — verified here, real Astro
// build + Astro's own documented islands architecture, not guessed:
//
// Astro only hydrates a component into its OWN independent React root when
// it carries an explicit `client:*` directive; a component with NO
// directive that's nested inside another component's JSX tree gets bundled
// into THAT ancestor's island instead. `http-route-reference.ts`'s
// Starlight renderer emits `<ApiExplorer client:load .../>` directly inside
// each generated MDX page — ApiExplorer therefore IS its own top-level
// island root on every page, never nested inside a Provider component's own
// render tree. A `ApiExplorerFetchProvider` mounted from a SEPARATE file
// (e.g. a Starlight layout/Head override, even if itself given a
// `client:*` directive) is a totally disconnected React hydration root —
// React context cannot cross that boundary. So the Docusaurus-style
// "wrap the whole app in one Provider" pattern has no Astro-islands
// equivalent for THIS component-authoring shape (a bare per-page
// `client:load` tag with no enclosing Provider JSX).
//
// The fix used here instead: `ApiExplorerFetchProvider`'s whole reason to
// exist is that a JS *function* can't survive MDX-prop serialization
// (fetch-context.tsx's own doc comment) — React context is ONE way to reach
// every instance without a per-page prop, but not the only one.
// `useApiExplorerFetch()` already falls back to the AMBIENT GLOBAL `fetch`
// when no Provider wraps a given `<ApiExplorer/>` — and the global `fetch`
// binding IS visible across every independently-hydrated island on a page,
// since they all share the same `window`. Monkey-patching `window.fetch`
// once, before any island hydrates, therefore reaches every `<ApiExplorer/>`
// site-wide with zero React-context involvement — see CustomHead.astro,
// which loads this as a real Vite-bundled module script in <head>.
//
// Still real in-process execution against the same fixture tree
// generate.ts projects to MDX (src/fixture-tree.ts) — no fabricated data,
// same as the Docusaurus site's Root.tsx wiring, just reached through a
// different mechanism appropriate to Astro's per-directive island model
// instead of Docusaurus's single-React-tree app shell.

import { createFetch, toDropInFetch } from "@rhi-zone/fractal-http-api-projector/preset";
import { api } from "./fixture-tree.ts";

const dropInFetch = toDropInFetch(createFetch(api));

// Cast needed: `window.fetch`'s ambient type is the full `typeof fetch`
// (may carry extra members like `preconnect` depending on lib set), while
// `dropInFetch` is `DropInFetch` — the literal call signature only. See
// fetch-context.tsx's own doc comment for why this package deliberately
// types against the call signature, not `typeof fetch`.
window.fetch = dropInFetch as typeof fetch;
