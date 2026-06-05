// Scale harness: build a ~900-route app, project the doc, and generate the
// concrete-types client — so we can time stock tsc on the generated client at N
// routes. (The in-TS `Client<App>` walk it once raced against is RETIRED — codegen
// is the single typed-client truth — so there is no longer a `.meta` baseline.)
//
//   bun test/scale/gen.ts 300   # 300 resources × 3 verb-routes ≈ 900 routes

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  choice,
  methods,
  param,
  path,
  type Reflected,
} from "@rhi-zone/fractal-core";
import { json } from "@rhi-zone/fractal-http";
import { toOpenApi } from "@rhi-zone/fractal-openapi";
import { generate } from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? "300");

// Build N resources, each with: GET/POST /res{i} and GET /res{i}/{id} → ~3N routes.
const routes: Record<string, Reflected<unknown>> = {};
for (let i = 0; i < N; i++) {
  routes[`res${i}`] = choice(
    methods({ GET: () => json([]), POST: () => json({}) }),
    param(
      "id",
      methods({
        GET: (req: Request & { params: { id: string } }) =>
          json(req.params.id),
      }),
    ),
  ) as Reflected<unknown>;
}
const app = path(routes) as Reflected<unknown>;

const doc = toOpenApi(app, { title: "Scale API", version: "1.0.0" });
const routeCount = Object.values(doc.paths).reduce(
  (n, item) => n + Object.keys(item).length,
  0,
);

const outDir = resolve(here, "out");
mkdirSync(outDir, { recursive: true });

// Emit the client WITH the embedded drift guard, importing a real SOURCE app
// module we also write below — so tsc must instantiate `RouteUnion<typeof app>`
// over the full N-route `.meta` AND the `AssertExact` against the generated union.
// This is the scale test of the LINEAR guard on the real `generate()` path.
const { client } = generate(doc, {
  appImport: "./generated-app.ts",
  appExport: "app",
});

// 0. the SOURCE app whose TYPE carries `.meta` (the guard's derived side reads it).
const appLines: string[] = [
  `import { choice, methods, param, path } from "@rhi-zone/fractal-core";`,
  `import { json } from "@rhi-zone/fractal-http";`,
  `export const app = path({`,
];
for (let i = 0; i < N; i++) {
  appLines.push(`  res${i}: choice(`);
  appLines.push(`    methods({ GET: () => json([]), POST: () => json({}) }),`);
  appLines.push(
    `    param("id", methods({ GET: (req: Request & { params: { id: string } }) => json(req.params.id) })),`,
  );
  appLines.push(`  ),`);
}
appLines.push(`});`);
writeFileSync(resolve(outDir, "generated-app.ts"), appLines.join("\n") + "\n");

// 1. the GENERATED concrete-types client (with the guard block).
writeFileSync(resolve(outDir, "generated-client.ts"), client);

// 2. a sample USAGE that probes a few of the generated types (forces tsc to
//    actually instantiate the call sigs, not just parse the interface).
const probes: string[] = [
  `import { createClient } from "./generated-client.ts";`,
  `import type { Handler } from "@rhi-zone/fractal-core";`,
  `declare const app: Handler<{}>;`,
  `const c = createClient(app);`,
];
for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 20))) {
  probes.push(`void c["/res${i}/{id}"].get({ params: { id: "1" } });`);
  probes.push(`void c["/res${i}"].post();`);
}
writeFileSync(resolve(outDir, "generated-usage.ts"), probes.join("\n") + "\n");

process.stdout.write(
  `N=${N} resources → ${routeCount} routes\n` +
    `wrote: ${outDir}/{generated-client.ts, generated-usage.ts}\n`,
);
