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
      methods<{ id: string }>({ GET: (req) => json(req.params.id) }),
    ),
  ) as Reflected<unknown>;
}
const app = path(routes) as Reflected<unknown>;

const doc = toOpenApi(app, { title: "Scale API", version: "1.0.0" });
const routeCount = Object.values(doc.paths).reduce(
  (n, item) => n + Object.keys(item).length,
  0,
);

const { client } = generate(doc);

const outDir = resolve(here, "out");
mkdirSync(outDir, { recursive: true });

// 1. the GENERATED concrete-types client.
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
