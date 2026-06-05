// packages/codegen/src/index.ts — @rhi-zone/fractal-codegen
//
// CODE-FIRST CODEGEN: the handler tree is truth; `toOpenApi` projects a doc; this
// package projects PLAIN TypeScript from that doc — a typed client and typed
// server handler-signature aliases — with ZERO type-level computation.
//
// This is the whole point: the RETIRED in-TS `Client<App>` type (formerly in
// @rhi-zone/fractal-client) walked `.meta` with conditional/mapped types, which
// scaled poorly and inference-leaked on `methods({ GET: … })`. Here we emit
// CONCRETE interfaces — a flat record of path → verb → call signature — so tsc
// pays near-zero instantiation cost no matter how many routes, and a handler's
// `req.ctx` is typed from a generated alias with no inference contortion.
//
// INPUT is the `OpenApiDocument` `toOpenApi(app, info)` already produces. The doc
// carries resolved JSON Schema for bodies/responses and (with the param-codec
// sidecar wiring in core/openapi) typed path-parameter schemas. We convert JSON
// Schema → a TS type STRING (data over code: a plain string artifact, diffable,
// no closures), then assemble two source strings.

import type { JsonSchema, OpenApiDocument, Operation } from "@rhi-zone/fractal-openapi";

// ============================================================================
// JSON Schema → TS type string. A small, total converter over the JSON Schema
// subset the projection emits (object/array/string/number/boolean/enum/$ref/
// anyOf/allOf/oneOf). Unknown shapes degrade to `unknown` — never throws.
// ============================================================================

/** Convert a resolved JSON Schema fragment to a TS type STRING. `indent` is the
 *  current indentation (for nested object pretty-printing). */
export function jsonSchemaToTs(schema: JsonSchema | undefined, indent = ""): string {
  if (schema === undefined) return "unknown";
  if (typeof schema !== "object" || schema === null) return "unknown";

  // $ref — we emit a reference by its trailing name (components are not inlined;
  // a degraded `unknown` keeps the output total if the ref can't be named).
  if (typeof schema["$ref"] === "string") {
    const name = (schema["$ref"] as string).split("/").pop();
    return name && /^[A-Za-z_$][\w$]*$/.test(name) ? name : "unknown";
  }

  // enum — a union of literals.
  if (Array.isArray(schema["enum"])) {
    const lits = (schema["enum"] as unknown[]).map(literal);
    return lits.length > 0 ? lits.join(" | ") : "never";
  }

  // combinators.
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) {
      const parts = (schema[key] as JsonSchema[]).map((s) => jsonSchemaToTs(s, indent));
      return parts.length > 0 ? parts.map(paren).join(" | ") : "unknown";
    }
  }
  if (Array.isArray(schema["allOf"])) {
    const parts = (schema["allOf"] as JsonSchema[]).map((s) => jsonSchemaToTs(s, indent));
    return parts.length > 0 ? parts.map(paren).join(" & ") : "unknown";
  }

  const type = schema["type"];
  // a `type` array (e.g. ["string","null"]) → a union.
  if (Array.isArray(type)) {
    return (type as string[]).map((t) => primitive(t)).map(paren).join(" | ");
  }

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = schema["items"] as JsonSchema | undefined;
      const inner = jsonSchemaToTs(items, indent);
      return `${paren(inner)}[]`;
    }
    case "object":
    default: {
      const props = schema["properties"] as Record<string, JsonSchema> | undefined;
      if (props === undefined) {
        // an object with no declared props, or an untyped schema → permissive.
        return type === "object" ? "Record<string, unknown>" : "unknown";
      }
      const required = new Set(
        Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [],
      );
      const next = indent + "  ";
      const lines = Object.keys(props).map((k) => {
        const opt = required.has(k) ? "" : "?";
        return `${next}${propKey(k)}${opt}: ${jsonSchemaToTs(props[k], next)};`;
      });
      if (lines.length === 0) return "Record<string, unknown>";
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
  }
}

function primitive(t: string): string {
  switch (t) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    default: return "unknown";
  }
}

function literal(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return "unknown";
}

/** Wrap a union/intersection in parens when nesting; leave atoms bare. */
function paren(t: string): string {
  return /[|&]/.test(t) && !t.startsWith("{") ? `(${t})` : t;
}

/** Emit an object key, quoting it if it isn't a bare identifier. */
function propKey(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

// ============================================================================
// Per-operation extraction — pull the params / body / return TS types out of one
// OpenAPI Operation. (Pure functions over the doc data.)
// ============================================================================

const JSON_MEDIA = "application/json";

/** The TS type string for an operation's path params, or undefined if none. */
function paramsType(op: Operation): string | undefined {
  const params = op.parameters?.filter((p) => p.in === "path") ?? [];
  if (params.length === 0) return undefined;
  const lines = params.map(
    (p) => `    ${propKey(p.name)}: ${jsonSchemaToTs(p.schema, "    ")};`,
  );
  return `{\n${lines.join("\n")}\n  }`;
}

/** The TS type string for an operation's request body, or undefined if none. */
function bodyType(op: Operation): string | undefined {
  const schema = op.requestBody?.content?.[JSON_MEDIA]?.schema;
  if (schema === undefined) return undefined;
  return jsonSchemaToTs(schema, "  ");
}

/** The TS type string for an operation's success (2xx) response body. Defaults to
 *  `unknown` when no success schema is annotated. */
function returnType(op: Operation): string {
  const success =
    op.responses["200"] ?? op.responses["201"] ?? op.responses["2XX"];
  const schema = success?.content?.[JSON_MEDIA]?.schema;
  return schema === undefined ? "unknown" : jsonSchemaToTs(schema, "  ");
}

const VERBS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;
type Verb = (typeof VERBS)[number];

// ============================================================================
// Output 1 — the typed CLIENT. A flat interface of path → { verb: call sig }.
// The call wrapper threads through the runtime `Transport` from
// @rhi-zone/fractal-client (we generate TYPES + a thin builder, NOT a new HTTP
// runtime). Concrete types only — no conditional/mapped computation.
// ============================================================================

function clientSource(doc: OpenApiDocument, opts: Required<GenerateOptions>): string {
  const out: string[] = [];
  out.push(banner("typed client", doc));
  out.push(
    `import type { Transport } from "${opts.clientImport}";`,
    `import { inProcess } from "${opts.clientImport}";`,
    `import type { Handler } from "${opts.coreImport}";`,
    // Drift-guard substrate (TYPES ONLY) + the SOURCE app's type (import type only —
    // generated depends on source, no runtime import, no cycle).
    `import type {`,
    `  Assert,`,
    `  AssertExact,`,
    `  RouteEntry,`,
    `  RouteUnion,`,
    `} from "${opts.coreImport}";`,
    `import type { ${opts.appExport} } from "${opts.appImport}";`,
    "",
  );

  // Per-path interface members.
  const members: string[] = [];
  for (const path of Object.keys(doc.paths)) {
    const item = doc.paths[path]!;
    const verbLines: string[] = [];
    for (const verb of VERBS) {
      const op = item[verb];
      if (op === undefined) continue;
      verbLines.push(`    ${verb}: ${callSig(op)};`);
    }
    if (verbLines.length === 0) continue;
    members.push(`  ${JSON.stringify(path)}: {\n${verbLines.join("\n")}\n  };`);
  }

  out.push(`export interface ${opts.clientTypeName} {`);
  out.push(members.join("\n"));
  out.push("}", "");

  // The STATIC DRIFT GUARD — a union of concrete `RouteEntry`s (the same per-route
  // data the interface carries, in union form) plus a single `AssertExact` that
  // statically asserts it equals `RouteUnion<typeof app>` re-derived from the
  // SOURCE app's inert `.meta`. If the source gains/loses/renames a route or
  // changes a param/body/response shape WITHOUT regenerating, the derived union
  // differs and `_drift = true` fails to typecheck (a `__drift__` error). The
  // import is `import type` only — generated depends on source, never the reverse;
  // no runtime import, no cycle. Linear (union-vs-union, never materialized into a
  // keyed object — that is the O(N²) trap). See @rhi-zone/fractal-core/drift.ts.
  out.push(driftGuard(doc, opts));

  out.push("");

  // The runtime builder — walks the SAME doc shape the type describes, building a
  // path→verb→fn surface that dispatches through the given Transport (defaults to
  // in-process over the app). Mirrors @rhi-zone/fractal-client's `build`, but the
  // SHAPE is the generated concrete interface, not the inferred `Client<App>`.
  out.push(`const PATHS: Record<string, readonly string[]> = ${pathsTable(doc)};`, "");
  out.push(
    `/** Build the generated typed client over a runtime Transport. \`app\` is any`,
    ` *  Handler<{}> (the root combinator); \`transport\` defaults to in-process. */`,
    `export function ${opts.clientFactoryName}(`,
    `  app: Handler<{}>,`,
    `  transport: Transport = inProcess(app),`,
    `): ${opts.clientTypeName} {`,
    `  const surface: Record<string, Record<string, unknown>> = {};`,
    `  for (const path in PATHS) {`,
    `    const bucket: Record<string, unknown> = (surface[path] = {});`,
    `    for (const verb of PATHS[path]!) {`,
    `      bucket[verb] = async (args?: { params?: Record<string, string>; body?: unknown }) => {`,
    `        const filled = path.replace(/\\{([^}]+)\\}/g, (_, n: string) => args?.params?.[n] ?? "");`,
    `        const init: RequestInit = { method: verb.toUpperCase() };`,
    `        if (args?.body !== undefined) {`,
    `          init.body = JSON.stringify(args.body);`,
    `          init.headers = { "Content-Type": "application/json" };`,
    `        }`,
    `        const res = await transport(new Request(\`http://local\${filled}\`, init));`,
    `        if (res.status === 204) return undefined;`,
    `        const ct = res.headers.get("Content-Type") ?? "";`,
    `        return ct.includes("application/json") ? res.json() : res.text();`,
    `      };`,
    `    }`,
    `  }`,
    `  return surface as unknown as ${opts.clientTypeName};`,
    `}`,
    "",
  );

  return out.join("\n");
}

/** The call signature for one operation: `(args) => Promise<Return>` or, when no
 *  params and no body, `() => Promise<Return>`. */
function callSig(op: Operation): string {
  const params = paramsType(op);
  const body = bodyType(op);
  const ret = returnType(op);
  const fields: string[] = [];
  if (params !== undefined) fields.push(`params: ${params}`);
  if (body !== undefined) fields.push(`body: ${body}`);
  if (fields.length === 0) return `() => Promise<${ret}>`;
  return `(args: { ${fields.join("; ")} }) => Promise<${ret}>`;
}

// ============================================================================
// The static DRIFT GUARD. Emits a `GenUnion` — a union of concrete
// `RouteEntry<"VERB /path", params, body, response>` (one per route, the same
// data the ApiClient interface carries) — and a single `AssertExact` against
// `RouteUnion<typeof app>` re-derived from the source `.meta`.
//
// The per-route projection MUST mirror what `RouteUnion` derives from `.meta`
// (NOT the raw OpenAPI doc), or the guard would false-positive on a clean app:
//   - `params`  = the path-param object (`{}` if none).
//   - `body`    = the request-body type if present, else `never` (the validated
//                 INPUT phantom `i` is `never` when no `validated` handler).
//   - `response`= `unknown` when the route HAS a request body (a validated
//                 handler's output phantom `o` is `unknown` — `validated` types
//                 input only), else the 200 response type if present, else
//                 `unknown`. This matches core's `MethodsIO`: the ValidatedHandler
//                 arm is matched before ReturnsHandler, so a validated+returns
//                 route derives `o: unknown`.
// ============================================================================

/** The drift guard block: `GenUnion` + the `_drift` assertion. */
function driftGuard(doc: OpenApiDocument, opts: Required<GenerateOptions>): string {
  const members: string[] = [];
  for (const path of Object.keys(doc.paths)) {
    const item = doc.paths[path]!;
    for (const verb of VERBS) {
      const op = item[verb];
      if (op === undefined) continue;
      const key = `${verb.toUpperCase()} ${path}`;
      const params = paramsType(op) ?? "{}";
      const body = bodyType(op) ?? "never";
      // A request body ⇒ a validated handler ⇒ derived `o` is `unknown`.
      const response = bodyType(op) !== undefined ? "unknown" : returnType(op);
      members.push(
        `  | RouteEntry<${JSON.stringify(key)}, ${params}, ${body}, ${response}>`,
      );
    }
  }
  const union =
    members.length > 0
      ? `export type ${opts.genUnionName} =\n${members.join("\n")};`
      : `export type ${opts.genUnionName} = never;`;

  return [
    "",
    "// The generated route-entry UNION — one `RouteEntry` per route (concrete types,",
    "// mirroring `RouteUnion<typeof app>`). A union, NEVER merged into a keyed object",
    "// (that merge is the O(N^2) trap that crashes stock tsc at scale).",
    union,
    "",
    "// STATIC DRIFT GUARD: re-derive the route-entry union from the SOURCE app's",
    "// inert `.meta` and assert it equals the generated union above. Any drift —",
    "// added/removed/renamed route, or a changed param/body/response shape — that is",
    "// not reflected here makes this assignment fail to typecheck with a `__drift__`",
    "// error. Regenerate to fix. (import type only — no runtime import, no cycle.)",
    `export const _drift: Assert<`,
    `  AssertExact<RouteUnion<typeof ${opts.appExport}>, ${opts.genUnionName}>`,
    `> = true;`,
  ].join("\n");
}

/** A literal table of path → enabled verbs, for the runtime builder. */
function pathsTable(doc: OpenApiDocument): string {
  const entries: string[] = [];
  for (const path of Object.keys(doc.paths)) {
    const item = doc.paths[path]!;
    const verbs = VERBS.filter((v) => item[v] !== undefined);
    if (verbs.length === 0) continue;
    entries.push(`  ${JSON.stringify(path)}: [${verbs.map((v) => JSON.stringify(v)).join(", ")}]`);
  }
  return `{\n${entries.join(",\n")}\n}`;
}

// ============================================================================
// Output 2 — typed SERVER handler-signature aliases. For each path+verb, emit a
// `Handler<P>` alias whose `P` is the concrete path-param object. A user writes
//   const getTodoById: GetTodoById = (req) => json(req.ctx.id);
// → `req.ctx.id` is typed, a typo is a compile error, and the value drops into
// `methods({ GET: getTodoById })` cleanly (it's a plain `Handler`). No inference.
// ============================================================================

function serverSource(doc: OpenApiDocument, opts: Required<GenerateOptions>): string {
  const out: string[] = [];
  out.push(banner("typed server handler signatures", doc));
  out.push(`import type { Handler } from "${opts.coreImport}";`, "");

  for (const path of Object.keys(doc.paths)) {
    const item = doc.paths[path]!;
    for (const verb of VERBS) {
      const op = item[verb];
      if (op === undefined) continue;
      const name = aliasName(verb, path, op);
      const params = paramsType(op);
      const p = params === undefined ? "{}" : params.replace(/^\{/, "{").trimEnd();
      out.push(
        `/** Handler signature for \`${verb.toUpperCase()} ${path}\`. */`,
        `export type ${name} = Handler<${p}>;`,
        "",
      );
    }
  }

  return out.join("\n");
}

/** A PascalCase alias name from verb + path. Prefers the operationId when present
 *  (it's stable + readable), else derives one from the path segments. */
function aliasName(verb: Verb, path: string, op: Operation): string {
  const base = op.operationId ?? `${verb}_${path}`;
  const parts = base
    .replace(/[{}]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s !== "");
  return parts.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("") || "Root";
}

// ============================================================================
// Public surface
// ============================================================================

export interface GenerateOptions {
  /** Import specifier for @rhi-zone/fractal-client (Transport + inProcess). */
  readonly clientImport?: string;
  /** Import specifier for @rhi-zone/fractal-core (Handler). */
  readonly coreImport?: string;
  /** Name of the generated client interface type. */
  readonly clientTypeName?: string;
  /** Name of the generated client factory function. */
  readonly clientFactoryName?: string;
  /** Import specifier for the SOURCE app module (where `typeof app` lives), used
   *  by the static drift guard's `import type`. Relative to the OUTPUT file, e.g.
   *  `"../app.ts"`. The guard re-derives `RouteUnion<typeof app>` from the
   *  source's `.meta` and asserts it equals the generated union — so generated
   *  code self-verifies against source. */
  readonly appImport?: string;
  /** Named export of the source app in `appImport` (the root combinator). */
  readonly appExport?: string;
  /** Name of the generated route-entry union type (the guard's generated side). */
  readonly genUnionName?: string;
}

const DEFAULTS: Required<GenerateOptions> = {
  clientImport: "@rhi-zone/fractal-client",
  coreImport: "@rhi-zone/fractal-core",
  clientTypeName: "ApiClient",
  clientFactoryName: "createClient",
  appImport: "../app.ts",
  appExport: "app",
  genUnionName: "GenUnion",
};

/** The result of codegen: two plain `.ts` source strings (data over code). */
export interface Generated {
  readonly client: string;
  readonly server: string;
}

/**
 * Generate plain TypeScript from an OpenAPI document: a typed client (concrete
 * interface + thin Transport-backed factory) and typed server handler-signature
 * aliases. ZERO type-level computation in the output.
 */
export function generate(doc: OpenApiDocument, opts: GenerateOptions = {}): Generated {
  const full: Required<GenerateOptions> = { ...DEFAULTS, ...opts };
  return {
    client: clientSource(doc, full),
    server: serverSource(doc, full),
  };
}

function banner(what: string, doc: OpenApiDocument): string {
  return [
    `// GENERATED by @rhi-zone/fractal-codegen — ${what}.`,
    `// Source: OpenAPI "${doc.info.title}" v${doc.info.version}. DO NOT EDIT.`,
    `// Concrete types only — zero type-level computation (no Client<App> walk).`,
    "",
  ].join("\n");
}
