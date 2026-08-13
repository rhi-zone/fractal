// packages/http-api-projector/src/adapter.ts — @rhi-zone/fractal-http-api-projector runtime adapters
//
// The ONLY runtime touch in this package. The core http module (./index)
// imports nothing from here, so it stays runtime-agnostic. An adapter takes a
// WHATWG fetch handler and binds it to a concrete server runtime.
//
// Two shapes of adapter live here, named accordingly:
//   - `serveX` — imperatively starts (or registers) the runtime's request
//     loop: `serveBun`/`serveNode`/`serveDeno` bind a listening socket;
//     `serveFastlyCompute` registers Compute's `fetch` event listener. These
//     return a handle for stopping the loop where the runtime allows it.
//   - `toX` — a pure translation from `FetchHandler` to the export shape a
//     platform's own dispatcher expects (`toCloudflareWorker`, `toVercelEdge`,
//     `toAwsLambdaHandler`). These start nothing; the platform runtime calls
//     the returned value itself.

type FetchHandler = (req: Request) => Promise<Response>;

// Bun is ambient in a Bun runtime; declared here so the file typechecks
// without pulling Bun into the core http module.
declare const Bun: {
  serve(options: { fetch: FetchHandler; port?: number; hostname?: string }): {
    port: number;
    stop(closeActiveConnections?: boolean): void;
  };
};

/** Serve a fetch handler on Bun. The single Bun touch in the codebase. */
export function serveBun(
  handler: FetchHandler,
  options: { port?: number; hostname?: string } = {},
): { port: number; stop(closeActiveConnections?: boolean): void } {
  return Bun.serve({ fetch: handler, ...options });
}

/** Serve a fetch handler on Node via node:http.
 *
 *  A thin shim that adapts node's req/res to a WHATWG Request/Response. Kept
 *  minimal — the proof is runtime-neutrality, not a production Node server. */
export async function serveNode(
  handler: FetchHandler,
  options: { port?: number; hostname?: string } = {},
): Promise<{ port: number; stop(): void }> {
  const http = await import("node:http");
  const server = http.createServer((nodeReq, nodeRes) => {
    void (async () => {
      const host = nodeReq.headers.host ?? "localhost";
      const url = `http://${host}${nodeReq.url ?? "/"}`;
      const chunks: Uint8Array[] = [];
      for await (const chunk of nodeReq) chunks.push(chunk as Uint8Array);
      const hasBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" && chunks.length > 0;
      const init: RequestInit = {
        method: nodeReq.method ?? "GET",
        headers: nodeReq.headers as Record<string, string>,
      };
      if (hasBody) init.body = Buffer.concat(chunks);
      const request = new Request(url, init);
      const response = await handler(request);
      nodeRes.statusCode = response.status;
      response.headers.forEach((value, key) => nodeRes.setHeader(key, value));
      const buf = Buffer.from(await response.arrayBuffer());
      nodeRes.end(buf);
    })();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.hostname, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);
  return { port, stop: () => server.close() };
}

// Deno is ambient in a Deno runtime; declared here for the same reason as
// the `Bun` global above — the file typechecks without pulling `deno-types`
// into the core http module.
declare const Deno: {
  serve(
    options: { port?: number; hostname?: string },
    handler: FetchHandler,
  ): { addr: { port: number }; shutdown(): Promise<void> };
};

/** Serve a fetch handler on Deno via `Deno.serve`. Native Request/Response,
 *  so this is a near-identical shape to `serveBun`. */
export function serveDeno(
  handler: FetchHandler,
  options: { port?: number; hostname?: string } = {},
): { port: number; stop(): Promise<void> } {
  const server = Deno.serve(options, handler);
  return { port: server.addr.port, stop: () => server.shutdown() };
}

/** A Cloudflare Workers module-worker export: `{ fetch(request, env, ctx) }`.
 *
 *  `env`/`ctx` are Workers-specific bindings/lifecycle the core handler has
 *  no use for — they're accepted and discarded so the returned object is a
 *  drop-in `export default toCloudflareWorker(handler)`. */
export function toCloudflareWorker(handler: FetchHandler): {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
} {
  return { fetch: (request) => handler(request) };
}

/** A Vercel Edge Function default export: `(req: Request) => Promise<Response>`.
 *
 *  Vercel's edge runtime dispatches with the exact `FetchHandler` shape
 *  already used throughout this package (no extra bindings, unlike
 *  Workers), so this is the identity function — kept as a named export for
 *  discoverability and so the call site reads the same as the other
 *  platform adapters: `export default toVercelEdge(handler)`. */
export function toVercelEdge(handler: FetchHandler): FetchHandler {
  return handler;
}

/** Register a fetch handler on Fastly Compute (JS SDK) via the platform's
 *  `fetch` event listener — Compute's own entry-point convention, not a
 *  module export. `event.request` is a native WHATWG `Request`;
 *  `event.respondWith` accepts a `Response` or a promise of one, so the
 *  core handler plugs straight in. */
export function serveFastlyCompute(handler: FetchHandler): void {
  addEventListener("fetch", (event) => {
    const fastlyEvent = event as unknown as {
      request: Request;
      respondWith(response: Promise<Response>): void;
    };
    fastlyEvent.respondWith(handler(fastlyEvent.request));
  });
}

/** Minimal structural subset of the Lambda Function URL / API Gateway HTTP
 *  API v2 event — only the fields this adapter reads. Matches the shape
 *  Hono's `aws-lambda` adapter targets. */
export type APIGatewayProxyEventV2 = {
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
};

export type APIGatewayProxyStructuredResultV2 = {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
};

// Content types read back as text; anything else (images, other binary
// `binary()` response bodies) is base64-encoded, matching how Hono's own
// `aws-lambda` adapter decides the split.
const TEXT_CONTENT_TYPE =
  /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.+\+(json|xml)$)/i;

function bytesToBase64(buf: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buf)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Translate a `FetchHandler` into an AWS Lambda handler over
 *  `APIGatewayProxyEventV2` (Lambda Function URLs and API Gateway HTTP APIs
 *  v2) — the one adapter here that isn't a thin Request/Response passthrough,
 *  since Lambda's event/result shape isn't WHATWG at all. `cookies` on the
 *  way in are folded into `Headers`; `set-cookie` on the way out is split
 *  back into the result's `cookies` array (API Gateway v2's multi-value
 *  convention). Text content types round-trip as plain strings; anything
 *  else is base64-encoded. */
export function toAwsLambdaHandler(
  handler: FetchHandler,
): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2> {
  return async (event) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(event.headers)) {
      if (value !== undefined) headers.append(key, value);
    }
    for (const cookie of event.cookies ?? []) headers.append("cookie", cookie);
    const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
    const url = `https://${headers.get("host") ?? "localhost"}${event.rawPath}${query}`;
    const method = event.requestContext.http.method;
    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD" && event.body !== undefined) {
      init.body = event.isBase64Encoded
        ? Uint8Array.from(atob(event.body), (c) => c.charCodeAt(0))
        : event.body;
    }
    const response = await handler(new Request(url, init));
    const resultHeaders: Record<string, string> = {};
    const cookies: string[] = [];
    response.headers.forEach((value, key) => {
      if (key === "set-cookie") cookies.push(value);
      else resultHeaders[key] = value;
    });
    const contentType = response.headers.get("content-type") ?? "";
    const isText = contentType === "" || TEXT_CONTENT_TYPE.test(contentType);
    const body_ = isText ? await response.text() : bytesToBase64(await response.arrayBuffer());
    return {
      statusCode: response.status,
      headers: resultHeaders,
      ...(cookies.length > 0 ? { cookies } : {}),
      body: body_,
      ...(isText ? {} : { isBase64Encoded: true }),
    };
  };
}
