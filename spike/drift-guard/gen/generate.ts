// spike/drift-guard/gen/generate.ts
//
// Build an N-resource app (same shape as packages/type-ir/test/scale/gen.ts:
// each resource has GET/POST /res{i} + GET /res{i}/{id} ≈ 3N routes), then emit,
// for each N, the files each guard formulation needs to be typechecked in
// isolation:
//
//   app-{N}.ts          the source handler tree (exports `app`; its TYPE carries .meta)
//   noguard-{N}.ts      the plain generated client only (baseline: no guard)
//   f1-naive-{N}.ts     #1 naive full re-derive AssertExact
//   f2-flatmap-{N}.ts   #2 single flat route-map AssertExact (the candidate)
//   f3-perroute-{N}.ts  #3 N independent per-route AssertExact
//   f4-hybrid-{N}.ts    #4 key-set union assert + linear per-route asserts
//
// Each guard file `import type`s the source `app` and the generated artifact, so
// the guard lives WITH the consumer of the generated code and references source
// only via `import type` (generated depends on source; never the reverse).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "out");
mkdirSync(outDir, { recursive: true });

const Ns = (process.argv.length > 2 ? process.argv.slice(2) : ["100", "300", "600", "900"])
  .map((s) => Math.round(Number(s) / 3)); // arg is route count target; /3 → resources

// Relative import roots (out/ → spike root packages).
const CORE = "@rhi-zone/fractal-api-tree";
const DERIVE = "../derive.ts";

// ------------------------------------------------------------------------------
// Source app: a path({...}) whose value & type carry `.meta`. Resource i:
//   res{i}: choice( methods({GET,POST}), param("id", methods({GET})) )
// To exercise BODY/RESPONSE drift we make POST carry a typed body and GET a typed
// response via the validated/returns phantom handler TYPES (no runtime schema
// needed for the structural compare — we use the core phantom-tagged handler
// types directly so `__io` is populated).
// ------------------------------------------------------------------------------

function appSource(resources: number): string {
  const lines: string[] = [];
  lines.push(`// SOURCE app (${resources} resources ≈ ${resources * 3} routes). Its TYPE carries .meta.`);
  lines.push(`import { choice, methods, param, path } from "${CORE}";`);
  lines.push(`import type { Handler, ReturnsHandler, ValidatedHandler } from "${CORE}";`);
  lines.push(``);
  // Body/response phantom handler factories (type-level only; runtime is a stub).
  lines.push(`// Phantom-typed handlers: the TYPE carries body (i) / response (o); runtime is inert.`);
  lines.push(`declare function vh<I>(): ValidatedHandler<I>;`);
  lines.push(`declare function rh<O>(): ReturnsHandler<O>;`);
  lines.push(`declare function h(): Handler<{ id: string }>;`);
  lines.push(``);
  lines.push(`// \`methods\` now takes ONE \`const T\` type-arg (commit "methods infers literal`);
  lines.push(`// verb sets …"): \`const T\` keeps the verb set literal ("GET", not the full`);
  lines.push(`// Method union) and \`ParamsOf<T>\` extracts the {id} obligation from the handler`);
  lines.push(`// value — so a bare \`methods(idTbl)\` over a handler declaring its param type is`);
  lines.push(`// enough; no explicit type-args (which would erase the literal verb set).`);
  lines.push(`const idTbl = { GET: h() };`);
  lines.push(``);
  lines.push(`export const app = path({`);
  for (let i = 0; i < resources; i++) {
    lines.push(`  res${i}: choice(`);
    lines.push(`    methods({ GET: rh<{ id: number; name: string }>(), POST: vh<{ title: string }>() }),`);
    lines.push(`    param("id", methods(idTbl)),`);
    lines.push(`  ),`);
  }
  lines.push(`});`);
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------------------
// Generated artifacts. We emit two GENERATED-side concrete types per N:
//   1. ApiClient — the existing flat path→verb→callsig interface (the real codegen
//      output shape; used by the no-guard baseline and the naive #1 formulation).
//   2. GenRoutes — a flat `{ "GET /res0/{id}": { params; body; response } }` map
//      (concrete types) mirroring `FlatRoutes<typeof app>`; used by #2/#3/#4.
// Both are PLAIN concrete types (the codegen scale win). The guard compares the
// DERIVED form against these.
// ------------------------------------------------------------------------------

interface RouteSpec {
  key: string; // "GET /res0/{id}"
  params: string; // TS type string
  body: string;
  response: string;
  // for ApiClient grouping:
  pathKey: string; // "/res0/{id}"
  verb: string; // "get"
}

function routesFor(resources: number): RouteSpec[] {
  const r: RouteSpec[] = [];
  for (let i = 0; i < resources; i++) {
    // methods({GET: returns<{id;name}>, POST: validated<{title}>}) at /res{i}.
    // POST has a typed BODY (validated) but NO typed response — `validated` types
    // input only; a typed response would require composing `returns`. So its
    // derived `o` is `unknown`, and the generated side must mirror that.
    r.push({ key: `GET /res${i}`, pathKey: `/res${i}`, verb: "get", params: "{}", body: "never", response: "{ id: number; name: string }" });
    r.push({ key: `POST /res${i}`, pathKey: `/res${i}`, verb: "post", params: "{}", body: "{ title: string }", response: "unknown" });
    // param("id", methods<{id}>({GET}))  at /res{i}/{id}
    r.push({ key: `GET /res${i}/{id}`, pathKey: `/res${i}/{id}`, verb: "get", params: "{ id: string }", body: "never", response: "unknown" });
  }
  return r;
}

// The concrete GenRoutes flat map (matches FlatRoutes<typeof app>).
function genRoutesSource(resources: number, opts?: { drift?: Drift }): string {
  const routes = applyDrift(routesFor(resources), opts?.drift);
  const lines: string[] = [];
  lines.push(`// GENERATED flat route map (concrete types). Mirrors FlatRoutes<typeof app>.`);
  lines.push(`export interface GenRoutes {`);
  for (const rt of routes) {
    lines.push(`  ${JSON.stringify(rt.key)}: { params: ${rt.params}; body: ${rt.body}; response: ${rt.response} };`);
  }
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

// The GENERATED union of route entries (concrete types). Mirrors RouteUnion<typeof app>.
// This is the f5 artifact — a flat UNION, never merged into a keyed object.
function genUnionSource(resources: number, opts?: { drift?: Drift }): string {
  const routes = applyDrift(routesFor(resources), opts?.drift);
  const lines: string[] = [];
  lines.push(`// GENERATED route-entry UNION (concrete types). Mirrors RouteUnion<typeof app>.`);
  lines.push(`import type { RouteEntry } from "${DERIVE}";`);
  lines.push(`export type GenUnion =`);
  const members = routes.map(
    (rt) => `  | RouteEntry<${JSON.stringify(rt.key)}, ${rt.params}, ${rt.body}, ${rt.response}>`,
  );
  lines.push(members.join("\n") + ";");
  return lines.join("\n") + "\n";
}

// The concrete ApiClient (path→verb→callsig), the real codegen shape.
function apiClientSource(resources: number): string {
  const routes = routesFor(resources);
  const byPath = new Map<string, RouteSpec[]>();
  for (const rt of routes) {
    const arr = byPath.get(rt.pathKey) ?? [];
    arr.push(rt);
    byPath.set(rt.pathKey, arr);
  }
  const lines: string[] = [];
  lines.push(`// GENERATED ApiClient (path → verb → call sig). The real codegen shape.`);
  lines.push(`export interface ApiClient {`);
  for (const [pk, rts] of byPath) {
    lines.push(`  ${JSON.stringify(pk)}: {`);
    for (const rt of rts) {
      const fields: string[] = [];
      if (rt.params !== "{}") fields.push(`params: ${rt.params}`);
      if (rt.body !== "never") fields.push(`body: ${rt.body}`);
      const arg = fields.length ? `args: { ${fields.join("; ")} }` : "";
      lines.push(`    ${rt.verb}: (${arg}) => Promise<${rt.response === "unknown" ? "unknown" : rt.response}>;`);
    }
    lines.push(`  };`);
  }
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------------------
// Drift injection. Each kind mutates the GENERATED side ONLY (source stays the
// truth), simulating a stale generated file. The guard must then error.
// ------------------------------------------------------------------------------

type Drift = "add" | "remove" | "renameParam" | "changeBody" | undefined;

function applyDrift(routes: RouteSpec[], drift: Drift): RouteSpec[] {
  if (!drift) return routes;
  const r = routes.map((x) => ({ ...x }));
  switch (drift) {
    case "add":
      // generated has an EXTRA route the source lacks.
      r.push({ key: `GET /ghost`, pathKey: `/ghost`, verb: "get", params: "{}", body: "never", response: "unknown" });
      return r;
    case "remove":
      // generated is MISSING a route the source has (drop the last GET /{id}).
      return r.filter((x) => x.key !== `GET /res${(routes.length / 3 | 0) - 1}/{id}`);
    case "renameParam": {
      // a param renamed in source but not generated: generated still says {id},
      // source would derive {ident}. We simulate by renaming generated's param key
      // value to a different name → shape mismatch.
      const idx = r.findIndex((x) => x.params.includes("id: string"));
      if (idx >= 0) r[idx].params = "{ ident: string }";
      return r;
    }
    case "changeBody": {
      // a body field type changed in source but generated stale: generated has
      // `title: string`, source would have `title: number`. We flip generated.
      const idx = r.findIndex((x) => x.body.includes("title"));
      if (idx >= 0) r[idx].body = "{ title: number }";
      return r;
    }
  }
  return routes;
}

// ------------------------------------------------------------------------------
// The four guard formulations (each as a standalone file). All `import type` the
// source `app` and the generated artifact, then assert.
// ------------------------------------------------------------------------------

// #5 — LINEAR union-vs-union AssertExact (the winner).
function f5_union(N: number): string {
  return [
    `// Formulation #5 — LINEAR union-vs-union AssertExact (the winner).`,
    `import type { app } from "./app-${N}.ts";`,
    `import type { GenUnion } from "./genunion-${N}.ts";`,
    `import type { Assert, AssertExact, RouteUnion } from "${DERIVE}";`,
    ``,
    `// Re-derive the route-entry UNION from source .meta and assert it equals the`,
    `// generated union. No object materialization → no O(N^2) merge.`,
    `export type _Derived = RouteUnion<typeof app>;`,
    `export const _guard: Assert<AssertExact<_Derived, GenUnion>> = true;`,
    ``,
  ].join("\n");
}

// #2 — single flat route-map AssertExact (the candidate).
function f2_flatmap(N: number): string {
  return [
    `// Formulation #2 — single flat route-map AssertExact.`,
    `import type { app } from "./app-${N}.ts";`,
    `import type { GenRoutes } from "./genroutes-${N}.ts";`,
    `import type { Assert, AssertExact, FlatRoutes } from "${DERIVE}";`,
    ``,
    `// Re-derive the flat map from the source .meta and assert it equals generated.`,
    `export type _Derived = FlatRoutes<typeof app>;`,
    `export const _guard: Assert<AssertExact<_Derived, GenRoutes>> = true;`,
    ``,
  ].join("\n");
}

// #1 — naive full re-derive: derive the FULL ApiClient shape (path→verb→callsig,
// the nested call-signature assembly) from .meta and AssertExact vs the generated
// ApiClient. This re-walks into the heavy nested form — the cost to measure.
function f1_naive(N: number): string {
  return [
    `// Formulation #1 — naive full ApiClient re-derive AssertExact (baseline).`,
    `import type { app } from "./app-${N}.ts";`,
    `import type { ApiClient } from "./apiclient-${N}.ts";`,
    `import type { Assert, AssertExact } from "${DERIVE}";`,
    `import type { ClientShapeFromMeta } from "../naive.ts";`,
    ``,
    `export type _Derived = ClientShapeFromMeta<typeof app>;`,
    `export const _guard: Assert<AssertExact<_Derived, ApiClient>> = true;`,
    ``,
  ].join("\n");
}

// #3 — per-route assertions: one AssertExact per route, each re-deriving a single
// route from the whole tree (watch for O(N²)).
function f3_perroute(N: number, resources: number): string {
  const routes = routesFor(resources);
  const lines: string[] = [
    `// Formulation #3 — N independent per-route AssertExact.`,
    `import type { app } from "./app-${N}.ts";`,
    `import type { GenRoutes } from "./genroutes-${N}.ts";`,
    `import type { Assert, AssertExact, FlatRoutes } from "${DERIVE}";`,
    ``,
    `type D = FlatRoutes<typeof app>;`,
    ``,
  ];
  let g = 0;
  for (const rt of routes) {
    lines.push(
      `export const _g${g++}: Assert<AssertExact<D[${JSON.stringify(rt.key)}], GenRoutes[${JSON.stringify(rt.key)}]>> = true;`,
    );
  }
  return lines.join("\n") + "\n";
}

// #4 — hybrid: ONE key-set equality assert (catches add/remove/rename of route
// KEYS cheaply) + per-route shape asserts that DON'T re-walk the tree (derive D
// once, index it). This is #3 plus a key-set guard, but with the per-route asserts
// indexing a single precomputed D (so no per-route whole-tree traversal).
function f4_hybrid(N: number, resources: number): string {
  const routes = routesFor(resources);
  const lines: string[] = [
    `// Formulation #4 — key-set union assert + linear per-route shape asserts.`,
    `import type { app } from "./app-${N}.ts";`,
    `import type { GenRoutes } from "./genroutes-${N}.ts";`,
    `import type { Assert, AssertExact, FlatRoutes } from "${DERIVE}";`,
    ``,
    `type D = FlatRoutes<typeof app>;`,
    ``,
    `// (a) cheap key-set equality — catches added/removed/renamed ROUTES.`,
    `export const _keys: Assert<AssertExact<keyof D, keyof GenRoutes>> = true;`,
    ``,
    `// (b) per-route shape equality — catches param/body/response shape drift.`,
    `//     Indexes the precomputed D (no per-route re-walk).`,
  ];
  let g = 0;
  for (const rt of routes) {
    lines.push(
      `export const _s${g++}: Assert<AssertExact<D[${JSON.stringify(rt.key)}], GenRoutes[${JSON.stringify(rt.key)}]>> = true;`,
    );
  }
  return lines.join("\n") + "\n";
}

function noguard(N: number): string {
  // baseline: just import the generated ApiClient and touch a few members.
  return [
    `// No-guard baseline: generated ApiClient only, a few touches (no derivation).`,
    `import type { ApiClient } from "./apiclient-${N}.ts";`,
    `declare const c: ApiClient;`,
    `export const _t0 = c["/res0"].get;`,
    `export const _t1 = c["/res0"].post;`,
    ``,
  ].join("\n");
}

// ------------------------------------------------------------------------------
// Emit everything per N.
// ------------------------------------------------------------------------------

for (const resources of Ns) {
  const N = resources; // file suffix is RESOURCE count to keep names short
  const routes = resources * 3;
  writeFileSync(resolve(outDir, `app-${N}.ts`), appSource(resources));
  writeFileSync(resolve(outDir, `genroutes-${N}.ts`), genRoutesSource(resources));
  writeFileSync(resolve(outDir, `genunion-${N}.ts`), genUnionSource(resources));
  writeFileSync(resolve(outDir, `apiclient-${N}.ts`), apiClientSource(resources));
  writeFileSync(resolve(outDir, `noguard-${N}.ts`), noguard(N));
  writeFileSync(resolve(outDir, `f1-naive-${N}.ts`), f1_naive(N));
  writeFileSync(resolve(outDir, `f2-flatmap-${N}.ts`), f2_flatmap(N));
  writeFileSync(resolve(outDir, `f3-perroute-${N}.ts`), f3_perroute(N, resources));
  writeFileSync(resolve(outDir, `f4-hybrid-${N}.ts`), f4_hybrid(N, resources));
  writeFileSync(resolve(outDir, `f5-union-${N}.ts`), f5_union(N));

  // Drift variants (for the drift proof) — only at the smallest N to keep it fast.
  if (resources === Ns[0]) {
    for (const d of ["add", "remove", "renameParam", "changeBody"] as const) {
      writeFileSync(resolve(outDir, `genroutes-${N}-${d}.ts`), genRoutesSource(resources, { drift: d }));
      writeFileSync(resolve(outDir, `genunion-${N}-${d}.ts`), genUnionSource(resources, { drift: d }));
    }
  }
  process.stdout.write(`resources=${resources} (~${routes} routes): wrote app/genroutes/apiclient + f1..f4 + noguard\n`);
}

process.stdout.write(`done. out: ${outDir}\n`);
