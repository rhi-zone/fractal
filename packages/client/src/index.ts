// packages/client/src/index.ts — @rhi-zone/fractal-client
//
// The CLIENT RUNTIME: transports only. The typed client surface is no longer
// derived in-TS here — @rhi-zone/fractal-codegen owns the typed client, emitting
// a concrete `ApiClient` interface + a `createClient` factory as plain `.ts` at a
// fraction of the tsc cost (no conditional/mapped-type walk over `.meta`).
//
// What this package now provides is the shared RUNTIME the generated client
// reuses: a `Transport` abstraction plus the in-process and HTTP transports. The
// generated `createClient(app, transport)` defaults `transport` to `inProcess(app)`.
//
// RETIRED (codegen is the single source of truth — "no two truths"):
//   - the type-level walk `Client<App>` / `Walk` / `FlatPath` / `FlatChoice` /
//     `UnionToIntersection` (the second typed-client truth codegen replaces), and
//   - the runtime `client(app, transport)` builder — its sole purpose was to back
//     `Client<App>`; codegen emits its own self-contained runtime builder.

import type { Handler } from "@rhi-zone/fractal-core";

// ============================================================================
// RUNTIME — the transports the generated client dispatches through. A leaf call
// builds a Request and runs it through a `Transport`; the in-process one calls
// the SAME app handler in memory (server-identical results, one code path, no
// network), the HTTP one issues a real fetch.
// ============================================================================

/** A transport: given a synthesized Request, return a Response. The in-process
 *  one just calls the app handler in memory. Swap for a fetch-based one to hit a
 *  remote server with the identical typed surface. */
export type Transport = (req: Request) => Promise<Response>;

/** In-process transport: run the SAME app handler in memory; a final `undefined`
 *  becomes a 404 (mirrors `toFetch`). */
export function inProcess(app: Handler<{}>): Transport {
  return async (req) => {
    // initialize the root params to `{}` (mirrors `toFetch`) — the app is the
    // fully-discharged root, so it carries no outstanding param obligation.
    (req as Request & { params: {} }).params = {};
    return (
      (await app(req as Request & { params: {} })) ??
      new Response("Not Found", { status: 404 })
    );
  };
}

/** HTTP transport: issue a real `fetch` to `baseUrl + path`. Same generated
 *  client type as `inProcess`, only execution differs. */
export function http(baseUrl: string, fetchImpl: typeof fetch = fetch): Transport {
  const base = baseUrl.replace(/\/$/, "");
  return async (req) => {
    const path = new URL(req.url).pathname + new URL(req.url).search;
    return fetchImpl(`${base}${path}`, req);
  };
}
