// Run with `bun run generate` (see this directory's package.json and
// examples/doc-site-verification/README.md).
//
// Builds the fixture OpenApiDoc (via the real toOpenApi) from
// ./src/fixture-tree.ts and projects it through the real
// toDocusaurusRouteReference
// (@rhi-zone/fractal-http-api-projector/http-route-reference) into this
// site's docs/api/ directory — real generated MDX, not hand-authored fixture
// output, so `npm run build`'s real `docusaurus build` afterward checks the
// projector's current output.
//
// opts.schemas is supplied explicitly rather than opts.sourceFile (which
// shells out to the TypeScript compiler via extractRouteSchemas) — schema
// correlation for this generator's own two routes is simple enough to
// hand-write directly, keeping this script runnable with zero
// TypeScript-Program setup. The key convention (`"books/add"`,
// `"books/:bookId"`) matches buildPathMap's tree-relative "/"-joined
// unprefixed path (http-api-projector/src/openapi.ts's doc comment on
// buildPathMap/schemaKey) — the same keying toOpenApi(n, opts) uses to
// look schemas up via `schemas[schemaKey] ?? schemas[codenName]`.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toOpenApi } from "@rhi-zone/fractal-http-api-projector/openapi";
import { toDocusaurusRouteReference } from "@rhi-zone/fractal-http-api-projector/http-route-reference";
import { api } from "./src/fixture-tree.ts";

const outDir = join(import.meta.dirname, "docs", "api");

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

  const pages = toDocusaurusRouteReference(doc);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [filename, content] of pages) {
    writeFileSync(join(outDir, filename), content, "utf8");
    console.log(`wrote docs/api/${filename}`);
  }
}

await main();
