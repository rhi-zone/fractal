// packages/openapi/src/index.ts — @rhi-zone/fractal-openapi
//
// The OpenAPI 3.x projection, derived FLAT from an app's inert `.meta`.
//
// CODE-FIRST: the handler tree is the source of truth; the OpenAPI document is a
// GENERATED projection, never hand-rolled. `toOpenApi(app, info)` walks the same
// `.meta` DATA tree the typed client walks (@rhi-zone/fractal-client) and emits a
// valid OpenAPI 3.0 document.
//
// The walk mirrors the client's runtime `build`: descend `path`/`prefix`/`param`
// accumulating path segments, then at each `methods` node emit one operation per
// declared verb. `choice` BRANCHES — every alt is its own set of endpoints, never
// collapsed. `param` turns the URL into the OpenAPI `/{id}` form and contributes
// a path parameter.
//
// Schemas (request body / response) ride the REFLECTABLE `MethodsMeta.schemas`
// carrier that @rhi-zone/fractal-http's `validated`/`returns` stamp onto a route
// and the `methods` constructor lifts into the meta. They are resolved to JSON
// Schema via the Standard-Schema JSON-Schema trait → plain-object → degrade ladder.
//
// No Route/Router/Node type is referenced; the OpenAPI type shapes are
// hand-written here (zero runtime dep — no `openapi-types`).

import type {
  ChoiceMeta,
  MethodsMeta,
  ParamMeta,
  PathMeta,
  PrefixMeta,
  Reflected,
  SchemaRef,
} from "@rhi-zone/fractal-core";

// ============================================================================
// Minimal OpenAPI 3.0 type shapes — hand-written, types-only (no runtime dep).
// Only the subset the projection emits is modeled; `JsonSchema` is the open
// escape hatch for resolved schemas (the trait returns arbitrary JSON Schema).
// ============================================================================

/** An arbitrary JSON Schema fragment (what the Standard-Schema trait returns, or
 *  a plain JSON-Schema-shaped value). Kept open — we do not constrain validator
 *  output. */
export type JsonSchema = Record<string, unknown>;

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly summary?: string;
}

export interface MediaType {
  readonly schema?: JsonSchema;
}

export interface RequestBody {
  readonly description?: string;
  readonly required?: boolean;
  readonly content: Readonly<Record<string, MediaType>>;
}

export interface ResponseObject {
  readonly description: string;
  readonly content?: Readonly<Record<string, MediaType>>;
}

export type Responses = Readonly<Record<string, ResponseObject>>;

export interface ParameterObject {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required?: boolean;
  readonly schema?: JsonSchema;
}

export interface Operation {
  readonly summary?: string;
  readonly description?: string;
  readonly operationId?: string;
  readonly parameters?: readonly ParameterObject[];
  readonly requestBody?: RequestBody;
  readonly responses: Responses;
}

/** lowercased HTTP verbs OpenAPI keys a Path Item by. */
export type HttpMethod =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "options"
  | "head"
  | "patch";

export type PathItem = Readonly<Partial<Record<HttpMethod, Operation>>>;

export type Paths = Readonly<Record<string, PathItem>>;

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: OpenApiInfo;
  readonly paths: Paths;
}

// ============================================================================
// Schema resolution — trait → plain-object → degrade ladder.
// ============================================================================

/** The optional Standard-Schema JSON-Schema reflective trait, mirrored types-only
 *  (it ships in `@standard-schema/spec` ≥1.1 / Zod 4.2+ / Valibot 1.2+ / ArkType
 *  2.1.28+). We never import a validator; we duck-type the trait off the value. */
interface JsonSchemaTrait {
  readonly "~standard"?: {
    readonly jsonSchema?: {
      readonly input?: (opts: { target: string }) => JsonSchema;
      readonly output?: (opts: { target: string }) => JsonSchema;
    };
  };
}

/** Heuristic: does `value` already look like a plain JSON Schema object? (TypeBox
 *  and friends ARE plain JSON Schema at runtime.) Detect the load-bearing keys. */
function looksLikeJsonSchema(value: object): boolean {
  return (
    "type" in value ||
    "$ref" in value ||
    "properties" in value ||
    "anyOf" in value ||
    "allOf" in value ||
    "oneOf" in value ||
    "enum" in value
  );
}

/** A non-fatal warning the projection accumulates when a schema can't be resolved
 *  to JSON Schema (keeps the document valid: the body/response degrades to `{}`). */
export interface Warning {
  readonly path: string;
  readonly message: string;
}

/**
 * Resolve one schema value to a JSON Schema fragment via the ladder:
 *   1. call the Standard-Schema JSON-Schema trait for `role` with
 *      `{ target: 'openapi-3.0' }` if present;
 *   2. else if the value is already a plain JSON-Schema-shaped object, use it
 *      verbatim;
 *   3. else degrade to `{}` and (if `warn` given) record a warning.
 * Never throws — a document is always emittable.
 */
export function resolveSchema(
  value: unknown,
  role: "input" | "output",
  ctx?: { warn: (w: Warning) => void; at: string },
): JsonSchema {
  if (typeof value !== "object" || value === null) {
    ctx?.warn({ path: ctx.at, message: `${role} schema is not an object` });
    return {};
  }
  const trait = (value as JsonSchemaTrait)["~standard"]?.jsonSchema?.[role];
  if (typeof trait === "function") {
    try {
      return trait({ target: "openapi-3.0" });
    } catch (e) {
      ctx?.warn({
        path: ctx.at,
        message: `${role} JSON-Schema trait threw: ${String(e)}`,
      });
      return {};
    }
  }
  if (looksLikeJsonSchema(value)) return value as JsonSchema;
  ctx?.warn({
    path: ctx.at,
    message: `${role} schema exposes no JSON-Schema trait and is not plain JSON Schema; degraded to {}`,
  });
  return {};
}

/** Resolve a single Standard-Schema (or plain JSON-Schema) value to JSON Schema,
 *  defaulting to the input role. Falls out of `resolveSchema` for callers that
 *  only have one schema in hand. */
export function toJsonSchema(
  value: unknown,
  role: "input" | "output" = "input",
): JsonSchema {
  return resolveSchema(value, role);
}

// ============================================================================
// The walk — mirror the client's runtime meta walk, accumulating path segments.
// ============================================================================

type AnyMeta =
  | MethodsMeta<string, Record<string, { i: unknown; o: unknown }>>
  | PathMeta<Record<string, unknown>>
  | PrefixMeta<string, unknown>
  | ParamMeta<string, unknown, unknown>
  | ChoiceMeta<readonly unknown[]>;

/** A path parameter accumulated while descending through `param` nodes. The
 *  schema (if the param carried a codec/schema) resolves to JSON Schema; absent,
 *  it defaults to `{ type: "string" }` (a raw URL segment is a string). */
interface AccumParam {
  readonly name: string;
  readonly schema: JsonSchema;
}

interface WalkState {
  readonly segments: readonly string[];
  readonly params: readonly AccumParam[];
}

/** Render the OpenAPI path string from accumulated literal + `{param}` segments. */
function renderPath(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : "/" + segments.join("/");
}

function build(
  meta: unknown,
  state: WalkState,
  paths: Record<string, Record<string, Operation>>,
  warnings: Warning[],
): void {
  if (typeof meta !== "object" || meta === null) return;
  const m = meta as { tag?: string } & AnyMeta;
  switch (m.tag) {
    case "methods": {
      emitMethods(m as MethodsMeta<string, never>, state, paths, warnings);
      return;
    }
    case "path": {
      const pm = m as PathMeta<Record<string, unknown>>;
      for (const k of Object.keys(pm.routes)) {
        build(
          pm.routes[k],
          { ...state, segments: [...state.segments, k] },
          paths,
          warnings,
        );
      }
      return;
    }
    case "prefix": {
      const pm = m as PrefixMeta<string, unknown>;
      build(
        pm.rest,
        { ...state, segments: [...state.segments, pm.pre] },
        paths,
        warnings,
      );
      return;
    }
    case "param": {
      const pm = m as ParamMeta<string, unknown, unknown>;
      // A bare param carries no codec → a raw string URL segment (`{type:"string"}`).
      // The `param(name, codec, inner)` overload stamps the codec as an inert
      // reflectable `schema` sidecar (mirrors `validated`'s `__schema`); resolve it
      // through the trait → plain → degrade ladder so a codec'd param is typed.
      const param: AccumParam = {
        name: pm.name,
        schema:
          pm.schema !== undefined
            ? resolveSchema(pm.schema, "input", {
                warn: (w) => warnings.push(w),
                at: `param ${pm.name} @ ${renderPath(state.segments)}`,
              })
            : { type: "string" },
      };
      build(
        pm.rest,
        {
          segments: [...state.segments, `{${pm.name}}`],
          params: [...state.params, param],
        },
        paths,
        warnings,
      );
      return;
    }
    case "choice": {
      // BRANCH: every alt is its own set of endpoints at the SAME accumulated
      // path. Do NOT collapse — recurse each alt with the same state.
      for (const alt of (m as ChoiceMeta<readonly unknown[]>).alts) {
        build(alt, state, paths, warnings);
      }
      return;
    }
  }
}

function emitMethods(
  mm: MethodsMeta<string, never>,
  state: WalkState,
  paths: Record<string, Record<string, Operation>>,
  warnings: Warning[],
): void {
  const key = renderPath(state.segments);
  const item = (paths[key] ??= {});
  const parameters: ParameterObject[] = state.params.map((p) => ({
    name: p.name,
    in: "path" as const,
    required: true,
    schema: p.schema,
  }));
  const schemas: Readonly<Record<string, SchemaRef>> = mm.schemas ?? {};

  for (const verb of mm.verbs) {
    const lower = verb.toLowerCase() as HttpMethod;
    const ref = schemas[verb];
    const at = `${verb} ${key}`;

    // requestBody — from a `validated` schema on this verb.
    const reqBody: RequestBody | undefined =
      ref?.input !== undefined
        ? {
            required: true,
            content: {
              "application/json": {
                schema: resolveSchema(ref.input, "input", {
                  warn: (w) => warnings.push(w),
                  at,
                }),
              },
            },
          }
        : undefined;

    // responses — a `returns` output schema (success) plus sensible defaults.
    const successSchema =
      ref?.output !== undefined
        ? resolveSchema(ref.output, "output", {
            warn: (w) => warnings.push(w),
            at,
          })
        : undefined;
    const responses: Responses = {
      "200": {
        description: "Success",
        ...(successSchema !== undefined
          ? { content: { "application/json": { schema: successSchema } } }
          : {}),
      },
      ...(reqBody !== undefined
        ? { "400": { description: "Validation failed" } }
        : {}),
    };

    item[lower] = {
      operationId: operationId(verb, state.segments),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(reqBody !== undefined ? { requestBody: reqBody } : {}),
      responses,
    };
  }
}

/** A stable, readable operationId: verb + path segments, camel-ish. */
function operationId(verb: string, segments: readonly string[]): string {
  const tail = segments
    .map((s) => s.replace(/[{}]/g, ""))
    .filter((s) => s !== "")
    .join("_");
  return `${verb.toLowerCase()}${tail === "" ? "" : `_${tail}`}`;
}

// ============================================================================
// Public surface
// ============================================================================

/** The result of a projection: the document plus any non-fatal degradation
 *  warnings. `toOpenApi` returns the document directly; `toOpenApiWithWarnings`
 *  surfaces the warnings for tooling that wants them. */
export interface ProjectionResult {
  readonly document: OpenApiDocument;
  readonly warnings: readonly Warning[];
}

/**
 * Project an OpenAPI 3.0 document from an app's inert `.meta` tree.
 * `app` is any `Reflected<unknown>` (the root combinator). Non-fatal schema
 * degradations are swallowed (use `toOpenApiWithWarnings` to inspect them).
 */
export function toOpenApi(
  app: Reflected<unknown>,
  info: OpenApiInfo,
): OpenApiDocument {
  return toOpenApiWithWarnings(app, info).document;
}

/** As `toOpenApi`, but also returns the accumulated degradation warnings. */
export function toOpenApiWithWarnings(
  app: Reflected<unknown>,
  info: OpenApiInfo,
): ProjectionResult {
  const paths: Record<string, Record<string, Operation>> = {};
  const warnings: Warning[] = [];
  build(
    (app as { meta: unknown }).meta,
    { segments: [], params: [] },
    paths,
    warnings,
  );
  return {
    document: { openapi: "3.0.3", info, paths },
    warnings,
  };
}
