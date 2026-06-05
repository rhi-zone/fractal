// packages/http/src/index.ts — @rhi-zone/fractal-http
//
// The WHATWG/runtime adapter kit for the handler algebra in
// @rhi-zone/fractal-core. Provides:
//   - toFetch(app)                  Handler<{}> → (Request) => Promise<Response>
//   - json / text / notFound / binary / sse / status helpers   response builders
//   - validated(schema, fn)         Standard Schema body validation
//   - returns<O>(handler)           output-type annotation for the typed client
//
// Runtime-agnostic: this module imports NO Bun and NO Node. The only runtime
// touch lives in ./adapter (serveBun / serveNode), which this file does not
// import. Streaming (SSE) and binary are ordinary Response bodies.

import {
  withParams,
  type Handler,
  type InferOutput,
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

/** Run `app`; a final `undefined` becomes a 404. Runtime-agnostic. The root only
 *  accepts a FULLY-DISCHARGED `Handler<{}>`: an app that reads `req.params.id`
 *  without a `param("id", …)` discharging it is `Handler<{id:string}>` and FAILS
 *  to compile here. Initializes `params` to `{}` for the root. */
export function toFetch(app: Handler<{}>): (req: Request) => Promise<Response> {
  return async (req) => (await app(withParams(req, {}))) ?? notFound();
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
 * client requires a correctly-shaped `body`. `O` (optional) annotates the
 * response body type for client return typing.
 */
export function validated<
  S extends StandardSchemaV1<unknown, unknown>,
  O = unknown,
>(
  schema: S,
  fn: (
    value: InferOutput<S>,
    req: Request,
  ) => Response | undefined | Promise<Response | undefined>,
): ValidatedHandler<InferOutput<S>, O> {
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
  return h as ValidatedHandler<InferOutput<S>, O>;
}

/** `returns<O>(handler, schema?)` — annotate a non-validated handler's output
 *  type so the client return is typed, without forcing a body. Identity at
 *  runtime. If a Standard Schema (or plain JSON-Schema-shaped object) is passed,
 *  it is stamped as an inert reflectable `__schema.output` carrier so the OpenAPI
 *  projection can emit a typed success response. */
export function returns<O>(
  h: Handler,
  schema?: StandardSchemaV1<unknown, O> | object,
): ReturnsHandler<O> {
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
  return h as ReturnsHandler<O>;
}

// Re-export the schema types so HTTP consumers have a single import surface.
export type { InferOutput, StandardSchemaV1 } from "@rhi-zone/fractal-core";
