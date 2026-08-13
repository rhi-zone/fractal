// packages/http-api-projector/src/http-route-reference.test.ts
//
// Builds a REAL OpenApiDoc (via toOpenApi, over a real Node tree with real
// handlers) and asserts on the actual generated MDX text — same "run the
// real projection, inspect the real output" standard as openapi.test.ts,
// not a hand-constructed OpenApiDoc literal standing in for one.

import { describe, expect, it } from "bun:test";
import { api, op } from "@rhi-zone/fractal-api-tree/node";
import { http } from "./verbs.ts";
import { toOpenApi, type OpenApiDoc } from "./openapi.ts";
import { toDocusaurusRouteReference, toStarlightRouteReference } from "./http-route-reference.ts";

const tree = api({
  books: api({
    list: op(() => [{ id: "1", title: "Fractal Reference" }], http.get),
    create: op((input: { title: string }) => ({ id: "2", title: input.title }), http.post),
  }),
});

const schemas = {
  "books/list": {
    inputSchema: { type: "object" as const },
    outputSchema: { type: "array" as const, items: { type: "object" as const } },
  },
  "books/create": {
    inputSchema: {
      type: "object" as const,
      properties: { title: { type: "string" as const } },
      required: ["title"],
    },
    outputSchema: { type: "object" as const, properties: { id: { type: "string" as const } } },
  },
};

async function buildDoc(): Promise<OpenApiDoc> {
  return toOpenApi(tree, { title: "Books API", version: "1.0.0", schemas });
}

describe("toDocusaurusRouteReference", () => {
  it("emits one page per (path, method) operation", async () => {
    const doc = await buildDoc();
    const pages = toDocusaurusRouteReference(doc);
    expect([...pages.keys()].sort()).toEqual(["books-create.mdx", "books-list.mdx"]);
  });

  it("the GET page embeds <ApiExplorer/> with method/path/responseSchema, no requestSchema", async () => {
    const doc = await buildDoc();
    const pages = toDocusaurusRouteReference(doc);
    const page = pages.get("books-list.mdx")!;
    expect(page).toContain('<ApiExplorer method="GET" path="/books/list"');
    expect(page).toContain('responseSchema={{"type":"array"');
    expect(page).not.toContain("requestSchema=");
  });

  it("the POST page embeds both requestSchema and responseSchema", async () => {
    const doc = await buildDoc();
    const pages = toDocusaurusRouteReference(doc);
    const page = pages.get("books-create.mdx")!;
    expect(page).toContain('<ApiExplorer method="POST" path="/books/create"');
    expect(page).toContain("requestSchema={");
    expect(page).toContain('"title":{"type":"string"}');
    expect(page).toContain("responseSchema={");
  });

  it("carries the not-shipped-by-this-projector note, same convention as <TypeRef>", async () => {
    const doc = await buildDoc();
    const pages = toDocusaurusRouteReference(doc);
    const page = pages.get("books-list.mdx")!;
    expect(page).toContain("is not shipped by this projector");
    expect(page).toContain("@rhi-zone/fractal-api-explorer");
  });

  it("respects options.basePath in the returned keys", async () => {
    const doc = await buildDoc();
    const pages = toDocusaurusRouteReference(doc, { basePath: "api/routes" });
    expect([...pages.keys()].sort()).toEqual([
      "api/routes/books-create.mdx",
      "api/routes/books-list.mdx",
    ]);
  });

  it("respects options.apiExplorerImport in the emitted note", async () => {
    const doc = await buildDoc();
    const pages = toDocusaurusRouteReference(doc, { apiExplorerImport: "@acme/docs-widgets" });
    const page = pages.get("books-list.mdx")!;
    expect(page).toContain("@acme/docs-widgets");
    expect(page).not.toContain("@rhi-zone/fractal-api-explorer");
  });
});

describe("toStarlightRouteReference", () => {
  it("emits one page per operation, each with an explicit import line", async () => {
    const doc = await buildDoc();
    const pages = toStarlightRouteReference(doc);
    expect([...pages.keys()].sort()).toEqual(["books-create.mdx", "books-list.mdx"]);
    const page = pages.get("books-list.mdx")!;
    expect(page).toContain('import { ApiExplorer } from "@rhi-zone/fractal-api-explorer";');
  });

  it("embeds the tag with client:load (not client:only, which is broken inside MDX)", async () => {
    const doc = await buildDoc();
    const pages = toStarlightRouteReference(doc);
    const page = pages.get("books-list.mdx")!;
    expect(page).toContain('<ApiExplorer client:load method="GET" path="/books/list"');
    expect(page).not.toContain("client:only");
  });

  it("the POST page's request schema round-trips through the emitted JSON", async () => {
    const doc = await buildDoc();
    const pages = toStarlightRouteReference(doc);
    const page = pages.get("books-create.mdx")!;
    const afterPrefix = page.split("requestSchema={")[1]!;
    const beforeResponse = afterPrefix.split(" responseSchema={")[0]!;
    // Trailing "}" belongs to the requestSchema={…} JSX-attribute wrapper,
    // not the JSON value itself.
    const json = beforeResponse.slice(0, -1);
    expect(JSON.parse(json)).toEqual(schemas["books/create"].inputSchema);
  });
});
