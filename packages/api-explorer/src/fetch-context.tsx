import { createContext, useContext } from "react";

// ============================================================================
// The fetch a doc site's embedded <ApiExplorer/> instances call.
//
// Per-route MDX embeds (see http-api-projector's http-route-reference.ts)
// only serialize JSON-safe props (method/path/schemas) into the generated
// page — a JS function value (the fetch implementation itself) cannot
// survive that serialization. The fetch implementation is instead wired
// once, site-wide, via this context's Provider (typically in a Docusaurus
// `src/theme/Root.tsx` swizzle, or a Starlight layout override); every
// <ApiExplorer/> on every generated page then reads it from context instead
// of receiving it as a prop. This mirrors the `<TypeRef>` precedent
// (docusaurus-reference.ts's own doc comment): the projector emits a bare
// component reference, and the consuming site wires the one thing that
// can't be serialized into MDX.
//
// The context's type is the literal global-`fetch` call signature, restated
// structurally rather than as `typeof fetch` — matching http-api-projector's
// `DropInFetch` (preset.ts: `(input: RequestInfo | URL, init?: RequestInit)
// => Promise<Response>`) exactly, so a site under active development can
// pass `toDropInFetch(createFetch(tree))` directly with zero adaptation,
// and a site with nothing wired yet still works against a same-origin real
// backend (the default is the ambient global `fetch`, not a stub that
// throws). `typeof fetch` differs across ambient lib sets (DOM's vs. Bun's,
// which adds a `fetch.preconnect` static), giving mutually incompatible
// shapes depending on which `tsconfig.json` "types" a given consumer has —
// the structural restatement of just the call signature sidesteps that,
// and matches what every real caller (a plain arrow function,
// `toDropInFetch`'s return, `fetch` itself) already satisfies.
// ============================================================================

export type ApiExplorerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ApiExplorerFetchContext = createContext<ApiExplorerFetch>((input, init) =>
  fetch(input, init),
);

/** Wrap a subtree so every <ApiExplorer/> inside it issues requests through
 * `fetchImpl` instead of the ambient global `fetch` — the one site-wide
 * wiring point a generated doc page can't do for itself. See this module's
 * doc comment for why. */
export function ApiExplorerFetchProvider(props: {
  readonly fetch: ApiExplorerFetch;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  return (
    <ApiExplorerFetchContext.Provider value={props.fetch}>
      {props.children}
    </ApiExplorerFetchContext.Provider>
  );
}

/** The fetch implementation the nearest enclosing `<ApiExplorerFetchProvider>`
 * supplies, or the ambient global `fetch` if none wraps the caller. */
export function useApiExplorerFetch(): ApiExplorerFetch {
  return useContext(ApiExplorerFetchContext);
}
