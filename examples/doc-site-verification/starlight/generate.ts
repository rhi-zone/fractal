// examples/doc-site-verification/starlight/generate.ts — run with `bun run generate`.
// Mirrors the Docusaurus site's generate.ts (same fixture, same schema
// hand-authoring rationale — see that file's header comment) but projects
// through the REAL `toStarlightRouteReference` into
// src/content/docs/api/ (Starlight's content-collection convention, per
// src/content.config.ts).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toOpenApi } from "@rhi-zone/fractal-http-api-projector/openapi";
import { toStarlightRouteReference } from "@rhi-zone/fractal-http-api-projector/http-route-reference";
import { api } from "./src/fixture-tree.ts";

const outDir = join(import.meta.dirname, "src", "content", "docs", "api");

async function main(): Promise<void> {
  const doc = await toOpenApi(api, {
    title: "Doc-Site Verification Fixture API",
    version: "0.0.0",
    schemas: {
      "books/add": {
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            author: { type: "string" },
          },
          required: ["title", "author"],
        },
        outputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            author: { type: "string" },
          },
          required: ["id", "title", "author"],
        },
      },
      "books/:bookId": {
        inputSchema: {
          type: "object",
          properties: { bookId: { type: "string" } },
          required: ["bookId"],
        },
        outputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            author: { type: "string" },
          },
          required: ["id", "title", "author"],
        },
      },
    },
  });

  const pages = toStarlightRouteReference(doc);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [filename, content] of pages) {
    writeFileSync(join(outDir, filename), content, "utf8");
    console.log(`wrote src/content/docs/api/${filename}`);
  }
}

await main();
