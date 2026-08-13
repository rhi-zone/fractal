import { GlobalRegistrator } from "@happy-dom/global-registrator";

// `bun test` loads every *.test.tsx in one process, and GlobalRegistrator
// throws if `.register()` runs twice — guard against whichever test file
// happens to import (and register) first.
try {
  GlobalRegistrator.register();
} catch {
  // already registered by another test file in this same process
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiExplorer } from "./api-explorer.tsx";
import { ApiExplorerFetchProvider } from "./fetch-context.tsx";

// ============================================================================
// End-to-end check spanning both the route-level projector
// (http-api-projector's http-route-reference.ts) and this package's
// <ApiExplorer/> component. Rather than asserting on each in isolation
// (http-route-reference.test.ts already checks the generated MDX text
// directly; api-explorer.test.tsx already checks the component against
// hand-written props), this test:
//
//   1. builds an OpenApiDoc from a tree (toOpenApi)
//   2. runs it through the toDocusaurusRouteReference projector
//   3. parses the method/path/responseSchema props out of the generated
//      MDX text (not reconstructed by hand)
//   4. renders <ApiExplorer/> with exactly those props, wired to a
//      toDropInFetch(createFetch(tree)) instance over the same tree
//   5. clicks Send and asserts the on-screen response is the tree's
//      handler output
//
// Every step, from tree construction to generated doc page to live
// component to rendered response, runs through real code.
// ============================================================================

import { api, op } from "../../api-tree/src/index.ts";
import { http } from "../../http-api-projector/src/verbs.ts";
import { createFetch, toDropInFetch } from "../../http-api-projector/src/preset.ts";
import { toOpenApi } from "../../http-api-projector/src/openapi.ts";
import { toDocusaurusRouteReference } from "../../http-api-projector/src/http-route-reference.ts";

const widgets = [{ id: "w1", name: "Widget One" }];

const tree = api({
  widgets: api({
    list: op(() => widgets, http.get),
  }),
});

const schemas = {
  "widgets/list": {
    inputSchema: { type: "object" as const },
    outputSchema: { type: "array" as const, items: { type: "object" as const } },
  },
};

/** Pull `method`/`path`/`responseSchema` back out of a generated MDX page's
 * `<ApiExplorer .../>` tag by parsing the projector's text output, rather
 * than calling internal helpers — this proves what the generated page
 * contains, not just what the projector's source intended to emit. */
function propsFromGeneratedPage(mdx: string): {
  method: string;
  path: string;
  responseSchema: unknown;
} {
  // `[^>]*` alone would also match the literal `<ApiExplorer .../>` mention
  // inside the page's own "not shipped by this projector" MDX-comment note
  // (see http-route-reference.ts's renderDocusaurusPage) — requiring the
  // real tag's first attribute (`method="`) right after the tag name
  // disambiguates the two.
  const tag = mdx.match(/<ApiExplorer method="[^>]*\/>/)?.[0];
  if (tag === undefined) throw new Error("no <ApiExplorer/> tag found in generated page");
  const method = tag.match(/method="([^"]*)"/)?.[1];
  const path = tag.match(/path="([^"]*)"/)?.[1];
  const prefix = "responseSchema={";
  const start = tag.indexOf(prefix);
  if (method === undefined || path === undefined || start === -1) {
    throw new Error(`could not extract props from tag: ${tag}`);
  }
  // Trailing " />" belongs to the JSX tag itself, not the JSON value; the
  // "}" immediately before it closes the `responseSchema={…}` JSX-attribute
  // wrapper (this tag is always the last attribute — see
  // renderDocusaurusPage), not the JSON.
  const responseSchemaText = tag.slice(start + prefix.length, -" />".length - 1);
  return { method, path, responseSchema: JSON.parse(responseSchemaText) };
}

describe("projector output -> live component, end to end", () => {
  test("the generated Docusaurus page's own <ApiExplorer/> props drive a real request against the same tree", async () => {
    const doc = await toOpenApi(tree, { title: "Widgets API", version: "1.0.0", schemas });
    const pages = toDocusaurusRouteReference(doc);
    const page = pages.get("widgets-list.mdx");
    expect(page).toBeDefined();

    const props = propsFromGeneratedPage(page!);
    expect(props).toEqual({
      method: "GET",
      path: "/widgets/list",
      responseSchema: { type: "array", items: { type: "object" } },
    });

    const realFetch = toDropInFetch(createFetch(tree));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApiExplorerFetchProvider fetch={realFetch}>
          <ApiExplorer
            method={props.method}
            path={props.path}
            responseSchema={props.responseSchema as never}
          />
        </ApiExplorerFetchProvider>,
      );
    });

    const button = container.querySelector("button");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const bodyEl = container.querySelector(".api-explorer-response-body");
    expect(JSON.parse(bodyEl?.textContent ?? "null")).toEqual(widgets);

    root.unmount();
    container.remove();
  });
});
