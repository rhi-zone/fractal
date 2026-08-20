// packages/http-framework-projector/src/fastify.ts — @rhi-zone/fractal-http-framework-projector
//
// Fastify router codegen — second target per
// docs/design/framework-router-codegen.md's popularity-descending priority
// list (Express, then Fastify). Same shape as express.ts: walks an
// `HttpRoute` tree and emits a `create<RouterName>Routes(handlers)` factory
// — but returning a `FastifyPluginAsync` (Fastify's own encapsulation/
// "router" unit — Fastify has no `Router` object of its own, a plugin
// function registered via `fastify.register(...)` IS the idiomatic mountable
// unit) instead of an `express.Router()` instance.
//
// EJECT MODEL: same as express.ts — written once, `// @generated ... do not
// edit` header, no drift detection. See
// docs/design/framework-router-codegen.md "Regen vs. one-time eject".
//
// HANDLER WIRING: same as express.ts — the factory takes a `Handlers`
// argument mirroring the route tree's shape, each leaf typed as fractal's
// own `Handler<I, O>`. A server-side handler already receives path params
// merged into its one `input` object (`route.ts`'s `assemble`), so no
// per-call currying is needed.
//
// REQUEST DECODING: same simplified approximation as express.ts — for
// GET/HEAD/DELETE, `input = { ...request.params, ...request.query }`; for
// POST/PUT/PATCH, `input = { ...request.params, ...(request.body ?? {}) }`.
// No coercion beyond what Fastify's own schema validation performs (see
// VALIDATION below) — `request.params`/`request.query` values are strings
// unless a `params`/`querystring` schema with `type: "number"` etc. causes
// Fastify's `ajv`-backed validator to coerce them (Fastify does this by
// default when a schema is present, unlike Express which never touches
// `req.params`/`req.query` types at all — a real behavioral difference from
// express.ts's "no coercion at all" note, driven entirely by whether a
// schema was available to attach).
//
// VALIDATION: generated, unlike express.ts. Per
// docs/design/framework-router-codegen.md's "Validator/schema mapping per
// target" section, Fastify's dominant convention is JSON-Schema-native
// validation via the route `schema` option (`body`/`querystring`/`params`/
// `response`), validated internally by Fastify's own `ajv` instance — no
// user code calls a validator function the way Hono's `zValidator`/Elysia's
// `t.Object` do. Fractal's `SchemaMap`/`ToolSchema.inputSchema`/
// `outputSchema` are already JSON-Schema-shaped (see the design doc's
// correction: `SchemaMap` is a JSON-Schema projection of `TypeRef`), so
// generating Fastify's `schema` option is a direct structural fit rather
// than a TypeRef->Zod/TypeBox source-text emission the way Hono/Elysia will
// need — the design doc calls this out explicitly ("JSON-Schema-native
// validation, which lines up well with fractal's own schema story"). The
// one piece of real work: `ToolSchema.inputSchema` is a single combined
// object schema covering every input field (path params + query/body
// merged, mirroring how `assemble` merges them at runtime), while Fastify
// wants path params, query params, and body validated as three separate
// schemas (`params`/`querystring`/`body`). This module splits the combined
// input schema's `properties` by key: keys matching a `:name` path segment
// go to `params`, the rest go to `querystring` (GET/HEAD/DELETE) or `body`
// (POST/PUT/PATCH). Splitting only happens for a plain
// `{ type: "object", properties: {...} }` shape; an input schema that isn't
// a simple object of properties (rare, but `JsonSchema`'s union allows
// `anyOf`/`enum`/etc. at the top level) is left unsplit, and no `schema`
// option is emitted for that operation — the same documented-degradation
// approach express.ts takes for its own simplifications.
// `response: { 200: ... }` is emitted directly from `outputSchema` when
// present; no splitting is needed since it's already the whole response
// body shape.
//
// RESPONSE ENCODING: the handler's return value is returned directly from
// the route handler (`return await handlers...(input)`) rather than sent
// via an explicit `reply.send(...)` call — Fastify's own convention, where
// an async route handler's resolved return value becomes the response body
// (JSON-serialized automatically). This mirrors express.ts's implicit
// default-200 behavior (`defaultEncode`); custom status codes via
// `meta.http.response` are not reflected, same eject-then-hand-edit answer.
//
// ERRORS: not wrapped in try/catch, unlike express.ts's `next(err)`.
// Fastify's own convention: a thrown error (or rejected promise) from an
// async route handler is caught by Fastify itself and forwarded to its
// error-handling machinery (`setErrorHandler`, or Fastify's default JSON
// error response) automatically — there is no `next` parameter in a
// Fastify route handler to forward to.
//
// See:
//   packages/http-framework-projector/src/express.ts — this module's structural precedent (first target)
//   packages/http-api-projector/src/codegen.ts       — client codegen, express.ts's own precedent
//   packages/http-api-projector/src/route.ts         — HttpRoute, naiveTransform, assemble, defaultEncode
//   packages/api-tree/src/node.ts                    — Handler<I, O>
//   packages/api-tree/src/tree.ts                    — SchemaMap, ToolSchema, extractToolSchemas
//   docs/design/framework-router-codegen.md          — settled decisions this module implements

import { isLeaf } from "@rhi-zone/fractal-api-tree/node";
import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node";
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract";
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree";
import { httpProjection } from "@rhi-zone/fractal-http-api-projector";
import type { HttpRoute } from "@rhi-zone/fractal-http-api-projector/route";
import {
  safeKey,
  typeBaseName,
  schemaToType,
} from "@rhi-zone/fractal-http-api-projector/codegen";

// ============================================================================
// Public API
// ============================================================================

export type FastifyCodegenOptions = {
  /** Base name for the emitted `<RouterName>Handlers` type and `create<RouterName>Routes` factory. Defaults to "Api". */
  readonly routerName?: string;
};

/**
 * Generate Fastify plugin source directly from an already-projected
 * `HttpRoute` tree (and an optional `SchemaMap` for typed input/output
 * aliases plus generated `schema` options). The returned string is a
 * complete `.ts` file: type aliases, a `<RouterName>Handlers` type, and a
 * `create<RouterName>Routes(handlers)` factory returning a `FastifyPluginAsync`
 * — ready to write to disk and `app.register(create<RouterName>Routes(handlers))`
 * into an existing Fastify app.
 *
 * Without `schemas`, every operation's `Handlers` leaf degrades to
 * `Handler<unknown, unknown>` and no `schema` option is emitted for that
 * route — still complete and mountable, just untyped/unvalidated.
 *
 * Co-located method entries (multiple HTTP verbs placed at the same route
 * position via `applyMoveTo`) surface as members named by their lowercased
 * HTTP verb, and their schema-map lookup uses a path-derived codegen name —
 * same degradation `generateExpressRouter` documents. Use
 * `generateFastifyRoutesFromNode` when the original `Node` tree is available
 * to recover authored names and exact `extractToolSchemas` keys.
 */
export function generateFastifyRoutes(
  route: HttpRoute,
  schemas?: SchemaMap,
  options: FastifyCodegenOptions = {},
): string {
  return render(buildTree(route, "", schemas, undefined, undefined), options);
}

/**
 * Convenience wrapper: projects `node` via `httpProjection` (the standard
 * `naiveTransform` + `applyMethods`/`applyMoveTo`/`applyResponse` pipeline)
 * and also walks the raw `Node` tree once to build the two name maps
 * `generateFastifyRoutes` alone can't recover — mirrors
 * `generateExpressRouterFromNode` exactly, same two maps, same reason.
 */
export function generateFastifyRoutesFromNode(
  node: Node,
  schemas?: SchemaMap,
  options: FastifyCodegenOptions = {},
): string {
  const route = httpProjection(node);
  const codegenNames = buildCodegenNameMap(node);
  const memberNames = buildMemberNameMap(node);
  return render(buildTree(route, "", schemas, codegenNames, memberNames), options);
}

// ============================================================================
// Internal: handler -> name maps, built from the raw Node tree
//
// Duplicated from express.ts (which itself duplicates from codegen.ts)
// rather than imported/shared — matches this package family's existing
// convention of each projector deriving these facts via its own
// self-contained walk (see codegen.ts's own module doc, quoting
// openapi.ts: "Two projectors, two encodings of the same fact").
// ============================================================================

/** Full underscore-joined path name (e.g. "books_bookId_read") — for SchemaMap lookups. */
function buildCodegenNameMap(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>();
  const visit = (node: Node, prefix: string): void => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      const seg = prefix.length > 0 ? `${prefix}_${key}` : key;
      if (isLeaf(child)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        out.set(child.handler!, seg);
      } else {
        visit(child, seg);
      }
    }
    if (node.fallback !== undefined) {
      const seg = prefix.length > 0 ? `${prefix}_${node.fallback.name}` : node.fallback.name;
      if (isLeaf(node.fallback.subtree)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        out.set(node.fallback.subtree.handler!, seg);
      } else {
        visit(node.fallback.subtree, seg);
      }
    }
  };
  visit(n, "");
  return out;
}

/** Own authored child key (e.g. "read") — for Handlers object member names. */
function buildMemberNameMap(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>();
  const visit = (node: Node): void => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      if (isLeaf(child)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        out.set(child.handler!, key);
      } else {
        visit(child);
      }
    }
    if (node.fallback !== undefined) {
      if (isLeaf(node.fallback.subtree)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        out.set(node.fallback.subtree.handler!, node.fallback.name);
      } else {
        visit(node.fallback.subtree);
      }
    }
  };
  visit(n);
  return out;
}

/** Fallback name derived purely from path + verb, for handlers absent from a name map. */
function nameFromPath(path: string, verb: string): string {
  const base =
    path === "/"
      ? "root"
      : path
          .split("/")
          .filter((s) => s.length > 0)
          .map((s) => (s.startsWith(":") ? s.slice(1) : s))
          .join("_");
  return `${base}_${verb.toLowerCase()}`;
}

// ============================================================================
// Internal: HttpRoute walk -> Fastify tree, decorated with schema/type info
// ============================================================================

type OperationEntry = {
  readonly memberName: string;
  readonly codegenName: string;
  readonly fastifyPath: string; // e.g. "/books/:bookId" — real Fastify (find-my-way) route syntax, same as Express
  readonly verb: string; // uppercase HTTP method
  readonly requestSchema?: JsonSchema;
  readonly responseSchema?: JsonSchema;
};

type FastifyTreeNode = {
  // Unified: both literal path-segment children AND a fallback (dynamic
  // path-param) child live in the same map, keyed by their own name — no
  // currying needed, same reasoning as express.ts.
  readonly children: Map<string, FastifyTreeNode>;
  readonly operations: Map<string, OperationEntry>;
};

/** A route position that is exactly one operation and nothing else. Mirrors express.ts's `isSingleLeafMethod`. */
function isSingleLeafMethod(route: HttpRoute): boolean {
  return (
    Object.keys(route.methods ?? {}).length === 1 &&
    Object.keys(route.children ?? {}).length === 0 &&
    route.fallback === undefined
  );
}

function attachOperation(
  node: FastifyTreeNode,
  memberName: string,
  verb: string,
  entry: { readonly handler: Handler },
  fastifyPath: string,
  schemas: SchemaMap | undefined,
  codegenNames: ReadonlyMap<Handler, string> | undefined,
): void {
  const codegenName = codegenNames?.get(entry.handler) ?? nameFromPath(fastifyPath, verb);
  const toolSchema = schemas?.[codegenName];

  node.operations.set(memberName, {
    memberName,
    codegenName,
    fastifyPath,
    verb: verb.toUpperCase(),
    ...(toolSchema?.inputSchema !== undefined ? { requestSchema: toolSchema.inputSchema } : {}),
    ...(toolSchema?.outputSchema !== undefined ? { responseSchema: toolSchema.outputSchema } : {}),
  });
}

/**
 * Walk an `HttpRoute` tree into a `FastifyTreeNode`. Structurally identical
 * to express.ts's `buildTree` — Fastify's `find-my-way` router uses the same
 * `:name` path-param syntax Express does, so no path-syntax translation is
 * needed here (unlike, say, a hypothetical target using `{name}` or `[name]`).
 */
function buildTree(
  route: HttpRoute,
  fastifyPath: string,
  schemas: SchemaMap | undefined,
  codegenNames: ReadonlyMap<Handler, string> | undefined,
  memberNames: ReadonlyMap<Handler, string> | undefined,
): FastifyTreeNode {
  const node: FastifyTreeNode = { children: new Map(), operations: new Map() };
  const displayPath = fastifyPath === "" ? "/" : fastifyPath;

  for (const [verb, entry] of Object.entries(route.methods ?? {})) {
    const memberName = memberNames?.get(entry.handler) ?? verb.toLowerCase();
    attachOperation(node, memberName, verb, entry, displayPath, schemas, codegenNames);
  }

  for (const [seg, child] of Object.entries(route.children ?? {})) {
    const childPath = `${fastifyPath}/${seg}`;
    if (isSingleLeafMethod(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const [verb] = Object.keys(child.methods!);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const entry = child.methods![verb!]!;
      attachOperation(node, seg, verb!, entry, childPath, schemas, codegenNames);
    } else {
      node.children.set(seg, buildTree(child, childPath, schemas, codegenNames, memberNames));
    }
  }

  if (route.fallback !== undefined) {
    const { name, subtree } = route.fallback;
    const childPath = `${fastifyPath}/:${name}`;
    node.children.set(name, buildTree(subtree, childPath, schemas, codegenNames, memberNames));
  }

  return node;
}

// ============================================================================
// Internal: naming helpers — safeKey/typeBaseName/schemaToType come from
// http-api-projector's codegen.ts (identical shape needed here); the two
// helpers below are specific to this router's own generated call sites.
// ============================================================================

/** `.books.bookId.read` — dotted accessor chain onto the `handlers` argument. */
function handlerAccessExpr(pathKeys: readonly string[], memberName: string): string {
  return ["handlers", ...pathKeys, memberName].map(safeKey).join(".");
}

/** `"/books/:bookId"` -> `["bookId"]` — path-param names, for splitting a combined input schema. */
function pathParamNames(path: string): string[] {
  return path
    .split("/")
    .filter((seg) => seg.startsWith(":"))
    .map((seg) => seg.slice(1));
}

// ============================================================================
// Internal: split a combined input JsonSchema into Fastify's separate
// params/querystring/body positions — see module doc's VALIDATION section.
// ============================================================================

type SplitInputSchema = {
  readonly params?: JsonSchema;
  readonly rest?: JsonSchema; // querystring (GET/HEAD/DELETE) or body (POST/PUT/PATCH)
};

/**
 * Splits `schema.properties` by whether each key is a path-param name.
 * Returns `undefined` fields (rather than empty-object schemas) when a
 * position has nothing to validate. Only handles the plain
 * `{ type: "object"|implicit, properties: {...} }` shape express.ts's own
 * `schemaToType` already assumes is the common case for a fractal input
 * type; anything else (top-level `anyOf`/`enum`/`const`, no `properties` at
 * all) is left unsplit and reported as `undefined` for both positions; no
 * `schema` option is emitted for that operation, a documented degradation.
 */
function splitInputSchema(
  schema: JsonSchema | undefined,
  paramNames: readonly string[],
): SplitInputSchema {
  if (schema === undefined) return {};
  if (
    "const" in schema ||
    schema.enum !== undefined ||
    schema.anyOf !== undefined ||
    schema.oneOf !== undefined
  ) {
    return {};
  }
  const properties = schema.properties;
  if (properties === undefined) return {};

  const paramNameSet = new Set(paramNames);
  const required = new Set(schema.required ?? []);

  const paramEntries = Object.entries(properties).filter(([key]) => paramNameSet.has(key));
  const restEntries = Object.entries(properties).filter(([key]) => !paramNameSet.has(key));

  const toObjectSchema = (entries: [string, JsonSchema][]): JsonSchema | undefined => {
    if (entries.length === 0) return undefined;
    const reqKeys = entries.map(([key]) => key).filter((key) => required.has(key));
    return {
      type: "object",
      properties: Object.fromEntries(entries),
      ...(reqKeys.length > 0 ? { required: reqKeys } : {}),
    } as JsonSchema;
  };

  const params = toObjectSchema(paramEntries);
  const rest = toObjectSchema(restEntries);
  return {
    ...(params !== undefined ? { params } : {}),
    ...(rest !== undefined ? { rest } : {}),
  };
}

// ============================================================================
// Internal: Handlers type renderer
// ============================================================================

function nodeTypeLiteral(node: FastifyTreeNode, indent: string): string {
  const nextIndent = indent + "  ";
  const lines: string[] = [];

  for (const [key, child] of node.children) {
    lines.push(`${nextIndent}readonly ${safeKey(key)}: ${nodeTypeLiteral(child, nextIndent)}`);
  }

  for (const [memberName, entry] of node.operations) {
    const base = typeBaseName(entry.codegenName);
    const inputType = entry.requestSchema !== undefined ? `${base}Input` : "unknown";
    const outputType = entry.responseSchema !== undefined ? `${base}Output` : "unknown";
    lines.push(
      `${nextIndent}readonly ${safeKey(memberName)}: Handler<${inputType}, ${outputType}>`,
    );
  }

  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${indent}}`;
}

// ============================================================================
// Internal: collect every operation in the tree (for type-alias emission and
// route registration)
// ============================================================================

type CollectedOperation = OperationEntry & { readonly pathKeys: readonly string[] };

function collectOperations(
  node: FastifyTreeNode,
  pathKeys: readonly string[] = [],
  out: CollectedOperation[] = [],
): CollectedOperation[] {
  for (const entry of node.operations.values()) out.push({ ...entry, pathKeys });
  for (const [key, child] of node.children) collectOperations(child, [...pathKeys, key], out);
  return out;
}

// ============================================================================
// Internal: top-level render
// ============================================================================

/** Indented JSON.stringify — for embedding a JsonSchema object literal as a JS source expression. */
function schemaLiteral(schema: JsonSchema, indent: string): string {
  return JSON.stringify(schema, null, 2).split("\n").join(`\n${indent}`);
}

function render(root: FastifyTreeNode, options: FastifyCodegenOptions): string {
  const routerName = options.routerName ?? "Api";
  const handlersTypeName = `${routerName}Handlers`;
  const factoryName = `create${routerName}Routes`;
  const entries = collectOperations(root);

  const typeDecls: string[] = [];
  const seenBases = new Set<string>();
  for (const entry of entries) {
    const base = typeBaseName(entry.codegenName);
    if (seenBases.has(base)) continue;
    seenBases.add(base);
    if (entry.requestSchema !== undefined) {
      typeDecls.push(`export type ${base}Input = ${schemaToType(entry.requestSchema, "")}`);
    }
    if (entry.responseSchema !== undefined) {
      typeDecls.push(`export type ${base}Output = ${schemaToType(entry.responseSchema, "")}`);
    }
  }

  const handlersTypeDecl = `export type ${handlersTypeName} = ${nodeTypeLiteral(root, "")}`;

  const registrations = entries
    .map((entry) => {
      const accessExpr = handlerAccessExpr(entry.pathKeys, entry.memberName);
      const method = entry.verb.toLowerCase();
      const isBodyVerb = entry.verb === "POST" || entry.verb === "PUT" || entry.verb === "PATCH";
      const inputExpr = isBodyVerb
        ? "{ ...(request.params as object), ...((request.body as object) ?? {}) }"
        : "{ ...(request.params as object), ...(request.query as object) }";

      const { params, rest } = splitInputSchema(
        entry.requestSchema,
        pathParamNames(entry.fastifyPath),
      );
      const schemaLines: string[] = [];
      if (params !== undefined)
        schemaLines.push(`      params: ${schemaLiteral(params, "      ")},`);
      if (rest !== undefined) {
        const restKey = isBodyVerb ? "body" : "querystring";
        schemaLines.push(`      ${restKey}: ${schemaLiteral(rest, "      ")},`);
      }
      if (entry.responseSchema !== undefined) {
        schemaLines.push(
          `      response: { 200: ${schemaLiteral(entry.responseSchema, "      ")} },`,
        );
      }
      const optionsExpr =
        schemaLines.length > 0 ? `{\n    schema: {\n${schemaLines.join("\n")}\n    },\n  }` : "{}";

      return [
        `  fastify.${method}(${JSON.stringify(entry.fastifyPath)}, ${optionsExpr}, async (request, reply) => {`,
        `    const input = ${inputExpr}`,
        `    return await ${accessExpr}(input)`,
        `  })`,
      ].join("\n");
    })
    .join("\n\n");

  return (
    [
      HEADER,
      IMPORTS,
      typeDecls.join("\n\n"),
      handlersTypeDecl,
      [
        `export function ${factoryName}(handlers: ${handlersTypeName}): FastifyPluginAsync {`,
        `  return async (fastify) => {`,
        registrations,
        `  }`,
        `}`,
      ].join("\n"),
    ]
      .filter((chunk) => chunk.length > 0)
      .join("\n\n") + "\n"
  );
}

// ============================================================================
// Static template chunks
// ============================================================================

const HEADER =
  "// @generated by @rhi-zone/fractal-http-framework-projector's Fastify router codegen — do not edit\n" +
  "// Eject model: this file is written once and not automatically regenerated — see\n" +
  "// docs/design/framework-router-codegen.md. Hand-edit freely; rerunning codegen\n" +
  "// overwrites this file wholesale, so re-run only when you intend to discard local edits.\n" +
  "//\n" +
  "// Register the returned plugin on an existing Fastify instance, e.g.\n" +
  "// `app.register(createApiRoutes(handlers))`. `params`/`querystring`/`body`/`response`\n" +
  "// JSON Schemas are attached per-route when a SchemaMap was available at codegen time —\n" +
  "// Fastify validates (and, where types allow, coerces) requests against them natively.";

const IMPORTS =
  'import type { FastifyPluginAsync } from "fastify"\n' +
  'import type { Handler } from "@rhi-zone/fractal-api-tree/node"';
