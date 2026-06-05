// packages/http/src/index.ts — @rhi-zone/fractal-http
//
// The WHATWG/runtime adapter kit for the handler algebra in
// @rhi-zone/fractal-core. Provides:
//   - toFetch(app)                  Handler<{}> → (Request) => Promise<Response>
//   - json / text / notFound / binary / sse / status helpers   response builders
//   - validated(schema, fn)         Standard Schema body validation (input type)
//   - returns(handler, outSchema)   output schema → typed client return type
//
// Runtime-agnostic: this module imports NO Bun and NO Node. The only runtime
// touch lives in ./adapter (serveBun / serveNode), which this file does not
// import. Streaming (SSE) and binary are ordinary Response bodies.

import {
  patternMatches,
  routeTable,
  segments,
  withParams,
  type Handler,
  type InferOutput,
  type MetaRoute,
  type Method,
  type Reflected,
  type ReturnsHandler,
  type StandardSchemaV1,
  type ValidatedHandler,
  type WithSchema,
} from "@rhi-zone/fractal-core";

// ============================================================================
// Response builders — plain functions returning real Response objects
// ============================================================================

export function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function text(body: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
  }
  return new Response(body, { ...init, headers });
}

export function notFound(body = "Not Found"): Response {
  return new Response(body, { status: 404 });
}

/** Binary response — body is any Uint8Array / ArrayBuffer / Blob. */
export function binary(
  body: Uint8Array | ArrayBuffer | Blob,
  contentType = "application/octet-stream",
  init?: ResponseInit,
): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", contentType);
  return new Response(body as BodyInit, { ...init, headers });
}

/** Convenience status-only helper: `status(201, body, init)` sets the code. */
export function status(code: number, body?: unknown, init?: ResponseInit): Response {
  if (body === undefined) return new Response(null, { ...init, status: code });
  return json(body, { ...init, status: code });
}

/** Server-Sent-Events response — a text/event-stream ReadableStream body.
 *  An ordinary Response; no special framework support needed. */
export function sse(
  produce: (emit: (event: string, data: unknown) => void) => void | Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown): void => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      try {
        await produce(emit);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ============================================================================
// The one adapter — toFetch
// ============================================================================

/**
 * Run `app`; turn a final `undefined` into the correct HTTP-correctness
 * response. Runtime-agnostic. The root only accepts a FULLY-DISCHARGED
 * `Handler<{}>`: an app that reads `req.params.id` without a `param("id", …)`
 * discharging it is `Handler<{id:string}>` and FAILS to compile here.
 *
 * HTTP correctness is a PROJECTION from `.meta`, NOT something dispatch emits
 * (see the dispatch-vs-projection boundary in @rhi-zone/fractal-core). Dispatch
 * (`methods`) is pure verb dispatch that PASSES on a verb-miss; here we close
 * the loop:
 *   1. Precompute the route table from `app.meta` ONCE (at construction).
 *   2. Per request, run `app(req)`. If it returns a `Response`, return it.
 *   3. On `undefined`, match the request path against the table's patterns
 *      (param segments match any one segment) and aggregate the verbs of EVERY
 *      matching pattern (so choice alts / mounts at the same path UNION their
 *      verbs — the cross-branch `Allow` no single `methods` node could compute):
 *        - HEAD where GET ∈ verbs → re-run dispatch as GET, return that
 *          response with a null body (status + headers preserved).
 *        - OPTIONS at a matched path → 204 + `Allow` (sorted union, HEAD when
 *          GET present, OPTIONS always).
 *        - any other verb at a matched path → 405 + that same `Allow`.
 *        - no pattern matches the path → 404.
 *
 * `app` is typed `Handler<{}>` for the root discharge invariant; the route table
 * is read off its `.meta` sidecar (absent on a bare handler → no routes → 404,
 * which is the correct degenerate behaviour).
 */
export function toFetch(app: Handler<{}>): (req: Request) => Promise<Response> {
  const table = routeTable((app as Partial<Reflected<unknown>>).meta);
  return async (req) => {
    const direct = await app(withParams(req, {}));
    if (direct !== undefined) return direct;

    // Dispatch passed — project the correct correctness response from .meta.
    const segs = segments(req);
    const matches = table.filter((r) => patternMatches(r.pattern, segs));
    if (matches.length === 0) return notFound(); // path doesn't exist → 404

    const verbs = unionVerbs(matches);
    const method = req.method as Method;

    if (method === "HEAD" && verbs.has("GET")) {
      // Re-run dispatch with the method swapped to GET, strip the body.
      const getReq = withParams(
        new Request(req.url, { ...req, method: "GET" }),
        {},
      );
      const res = await app(getReq);
      if (res !== undefined) return new Response(null, res);
      // GET handler itself passed → fall through to 405 (no body served).
    }

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { Allow: allowHeader(verbs) },
      });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: allowHeader(verbs) },
    });
  };
}

/** Union the verb sets of every matching route (cross-choice / cross-mount). */
function unionVerbs(matches: readonly MetaRoute[]): Set<Method> {
  const verbs = new Set<Method>();
  for (const r of matches) for (const v of r.verbs) verbs.add(v);
  return verbs;
}

/** A sorted `Allow` value: the declared verbs, plus HEAD when GET is present and
 *  OPTIONS always (both are auto-served by this projection). */
function allowHeader(verbs: ReadonlySet<Method>): string {
  const all = new Set<Method>(verbs);
  if (all.has("GET")) all.add("HEAD");
  all.add("OPTIONS");
  return [...all].sort().join(", ");
}

// ============================================================================
// Validation — ORTHOGONAL, opt-in. `validated(schema, fn)` wraps a body-consuming
// handler: it validates `await req.json()` against a Standard Schema, renders 400
// on failure, and attaches the input type to a phantom so the client's request
// body is typed. Stays a plain core `Handler` at runtime.
// ============================================================================

/**
 * `validated(schema, fn)` — orthogonal body validation. Returns a plain core
 * `Handler` (so it slots straight into a `methods` table). On a request it:
 *   1. reads `await req.json()`,
 *   2. validates it against `schema` (Standard Schema),
 *   3. on issues → `400` JSON `{ error, issues }`,
 *   4. on success → calls `fn(value, req)` with the *typed* validated value.
 * The input type `InferOutput<schema>` is carried as a phantom so the typed
 * client requires a correctly-shaped `body`. `validated` types the INPUT ONLY —
 * a typed RESPONSE requires a real output schema value, which `returns(handler,
 * outputSchema)` supplies (codegen projects the return type from the runtime
 * `__schema.output` carrier → OpenAPI `responses[200]`, never from a TS phantom,
 * so an output type param here would be a dead phantom invisible to the client).
 * To type a validated route's response, compose: `returns(validated(s, fn), out)`.
 */
export function validated<S extends StandardSchemaV1<unknown, unknown>>(
  schema: S,
  fn: (
    value: InferOutput<S>,
    req: Request,
  ) => Response | undefined | Promise<Response | undefined>,
): ValidatedHandler<InferOutput<S>> {
  const h: Handler = async (req) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const r = await schema["~standard"].validate(raw);
    if ("issues" in r && r.issues !== undefined) {
      return new Response(
        JSON.stringify({ error: "VALIDATION", issues: r.issues }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return fn((r as { value: InferOutput<S> }).value, req);
  };
  // Stamp the body schema as an INERT, reflectable runtime carrier so the
  // `methods` constructor can lift it into `.meta` for the OpenAPI projection.
  // Erased from the dispatch path (an extra own-property on the function).
  // MERGE into any existing carrier (e.g. `returns` may have already set
  // `output`) rather than replacing it, so both `input` and `output` survive
  // when `validated` and `returns` are composed on the same handler.
  const existing = (h as unknown as WithSchema).__schema;
  (h as unknown as { __schema: WithSchema["__schema"] }).__schema = {
    ...existing,
    input: schema,
  };
  return h as ValidatedHandler<InferOutput<S>>;
}

/** `returns<O>(handler, schema?)` — annotate a non-validated handler's output
 *  type so the client return is typed, without forcing a body. Identity at
 *  runtime. If a Standard Schema (or plain JSON-Schema-shaped object) is passed,
 *  it is stamped as an inert reflectable `__schema.output` carrier so the OpenAPI
 *  projection can emit a typed success response. */
export function returns<O, H extends Handler = Handler>(
  h: H,
  schema?: StandardSchemaV1<unknown, O> | object,
): H & ReturnsHandler<O> {
  if (schema !== undefined) {
    // MERGE into any existing carrier (e.g. `validated` may have already set
    // `input`) rather than replacing it, so both `input` and `output` survive
    // when `validated` and `returns` are composed on the same handler.
    const existing = (h as unknown as WithSchema).__schema;
    (h as unknown as { __schema: WithSchema["__schema"] }).__schema = {
      ...existing,
      output: schema,
    };
  }
  // PRESERVE the input handler's brand: `returns(validated(s, fn), out)` is a
  // `ValidatedHandler<I> & ReturnsHandler<O>`, so the `.meta` `__io` phantom keeps
  // the validated INPUT type (which the drift guard compares against the generated
  // body). Returning a bare `ReturnsHandler<O>` would erase the `validated` brand
  // and the guard would see `body: never` for a route that DOES take a body.
  return h as H & ReturnsHandler<O>;
}

// Re-export the schema types so HTTP consumers have a single import surface.
export type { InferOutput, StandardSchemaV1 } from "@rhi-zone/fractal-core";
