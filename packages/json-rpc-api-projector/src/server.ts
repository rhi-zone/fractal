// packages/json-rpc-api-projector/src/server.ts — @rhi-zone/fractal-json-rpc-api-projector
//
// Two OOTB transport adapters over the same dispatch core, both built from
// `projectMethods` (project.ts): `createJsonRpcHttpHandler` (HTTP POST,
// `(req: Request) => Promise<Response>`, matching http-api-projector's
// `createFetch`/mcp-api-projector's transport-per-call shape) and
// `createJsonRpcWebSocketHandlers` (a minimal duck-typed `{ message }`
// handler any WebSocket server — Bun.serve, `ws`, Deno — can be adapted to).
//
// Both transports share `dispatchRequest`/`dispatchBody` — the actual
// method-lookup + input-assembly + handler-call + result/error shaping —
// so the two adapters differ only in how a raw byte payload becomes a
// parsed body and how a Response/Notification gets sent back, never in
// dispatch semantics.
//
// Batch requests (§6): `dispatchBody` accepts either a single Request
// object or an array of them — an empty array is itself an Invalid Request
// (§6: "If the batch rpc call itself fails to be recognized ... the Server
// MUST return a single Response object"); a non-empty array dispatches each
// element independently (concurrently, via `Promise.all` — one element's
// failure or slow handler doesn't block the others) and collects the
// non-Notification results. If every element was a Notification, the
// resulting response array is empty; per §6 ("If there are no Response
// objects ... the Server MUST NOT return an empty Array") this returns
// `undefined`, and each transport's own adapter maps that to "no body sent"
// (HTTP: 204 No Content; WebSocket: nothing sent).
//
// Middleware + ALS: `CreateJsonRpcServerOptions.middleware`/`.als` mirror
// HTTP/MCP/CLI/GraphQL's own options (docs/guide/framework.md §3) — an
// around-hook composed outermost-first over the handler call, and an opt-in
// `AsyncLocalStorage` scope computed per dispatch from `JsonRpcAlsContext`.
// Both wrap `dispatch.handler` inside `dispatchRequest`, shared by both
// transports the same as the rest of dispatch semantics.
//
// Streaming (settled design decision — see project.ts's `JsonRpcMethod
// .streaming` doc): a handler returning an `AsyncIterable` is drained
// differently per transport, since only one of them has a push channel to
// deliver elements as they arrive:
//   - WebSocket: each yielded value becomes a `JsonRpcNotification`
//     (`{ method, params: { type: "chunk" | "progress", subscription: id,
//     ... } }` — `subscription` correlates the notification back to the
//     original call's `id`, the same `subscription`-keyed convention
//     several production JSON-RPC pub/sub extensions use, e.g.
//     `eth_subscribe`'s `eth_subscription` notifications). Once the
//     iterable completes, the original request's `id` still gets a normal
//     Response carrying the generator's return value (or `null`) as
//     `result` — symmetric with a non-streaming call, so a client that
//     only awaits the call's own promise still resolves normally once the
//     stream ends, regardless of whether it also listens for the
//     intermediate notifications.
//   - HTTP POST: no push channel exists mid-request, so the whole iterable
//     is drained to completion and its collected chunk values become the
//     single Response's `result` array (progress yields are dropped — they
//     have no synchronous consumer over a request/response transport).
//     This is a lossy but honest degrade, the same "materialize what a
//     transport can't natively express" convention type-ir's projectors use
//     throughout (e.g. protobuf.ts's stream -> repeated fallback).
//
// Error mapping: framework-level failures (malformed JSON, malformed
// Request shape, unknown method) use the JSON-RPC 2.0 standard codes
// (-32700..-32600, re-exported from wire.ts). A handler's own `Result.err`
// value is transport-agnostic (see @rhi-zone/fractal-api-tree's `Result`) —
// `JsonRpcErrorEncoder` (below) maps it to a `{code, message, data?}`
// envelope; app-specific codes are conventionally drawn from the
// -32000..-32099 server-error range (§5.1) so they never collide with a
// future spec-reserved code. `jsonRpcErrors` builds one from a
// `{ errKind: code }` mapping, mirroring MCP's `mcpErrors`/HTTP's
// `httpErrors`. Returning `undefined` (including when `errorEncoder` itself
// is omitted) falls back to `JSON_RPC_INVALID_PARAMS` with the raw error
// value as `data`.
//
// See:
//   packages/json-rpc-api-projector/src/project.ts   — projectMethods (descriptors + dispatch table)
//   packages/json-rpc-api-projector/src/wire.ts       — JSON-RPC 2.0 message types + standard codes
//   packages/mcp-api-projector/src/server.ts          — sibling preset (structural mirror: detection, errorEncoder)

import {
  assemble,
  composeErrorEncoders,
  composeMiddleware,
  isResultShape,
  isStreamChunk,
  isStreamProgress,
  matchKind,
} from "@rhi-zone/fractal-api-tree";
import type {
  DetectionOptions,
  ErrorEncoder,
  ProjectorStores,
  Store,
} from "@rhi-zone/fractal-api-tree";
import type { AlsConfig } from "@rhi-zone/fractal-api-tree/context";
import type { LeafMeta, Node } from "@rhi-zone/fractal-api-tree/node";
import { projectMethods } from "./project.ts";
import type { Dispatch, ProjectMethodsOptions, SchemaMap } from "./project.ts";
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  isJsonRpcRequestShape,
  jsonRpcErrorResponse,
  jsonRpcSuccessResponse,
} from "./wire.ts";
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./wire.ts";

export type {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from "./wire.ts";
export {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_SERVER_ERROR_MAX,
  JSON_RPC_SERVER_ERROR_MIN,
  isJsonRpcError,
} from "./wire.ts";

/**
 * JSON-RPC's own store-name fragment: a plain, inert interface naming the one
 * store this projector builds and the shape it carries — not a `declare
 * module` augmentation of api-tree's `StoreRegistry`. Per
 * docs/design/typed-store-spec.md §3, a projector that augments core makes the
 * type surface depend on which packages are in the compilation rather than on
 * what the deployment composes. A deployment composes this in, once, in its own
 * augmentation file (`interface StoreRegistry extends JsonRpcStores {}`); see
 * `HttpStores` in http-api-projector/src/decode.ts for the worked example.
 *
 * The member is optional — a per-request store this projector builds when it
 * dispatches. `caller` is declared once by core (api-tree's `CoreStores`),
 * shared across every projector, not by this interface.
 */
export interface JsonRpcStores {
  /** A request's by-name `params` object (a positional/array `params` degrades to `{}` — see `dispatchRequest`). */
  params?: Store;
}

/**
 * The full per-request store bag a JSON-RPC dispatch builds: the shared
 * `Stores` (core's `caller`, plus whatever service stores the deployment
 * registered) intersected with this projector's own fragment — see
 * `HttpStoreBag`'s doc for why the intersection is what lets this package build
 * and read `params` without an ambient augmentation.
 */
export type JsonRpcStoreBag = ProjectorStores & JsonRpcStores;

// ============================================================================
// Error encoding
// ============================================================================

/** An error encoder's JSON-RPC-specific target shape — a full error object (code/message/data). */
export type JsonRpcErrorEncoder<E = unknown> = ErrorEncoder<
  E,
  { readonly code: number; readonly message: string; readonly data?: unknown }
>;

/**
 * Pre-built `JsonRpcErrorEncoder`: maps error `kind` values to JSON-RPC
 * error codes, e.g. `jsonRpcErrors({ notFound: -32001 })` (see module doc's
 * "Error mapping" section for the recommended -32000..-32099 range). The
 * error `message` defaults to the error value's own `message` field when
 * present (a string), else its `JSON.stringify`; the full error value is
 * always carried as `data`, so no information is lost even when `message`
 * degrades to the JSON dump. Internally a `composeErrorEncoders` over one
 * `matchKind` per mapping entry — first match wins (object key order).
 */
export function jsonRpcErrors<E = unknown>(
  mapping: Record<string, number>,
): JsonRpcErrorEncoder<E> {
  const encoders = Object.entries(mapping).map(([kind, code]) => matchKind<number>(kind, code));
  const composed = composeErrorEncoders(...encoders);
  return (error) => {
    const code = composed(error);
    if (code === undefined) return undefined;
    const messageField = (error as { message?: unknown } | null)?.message;
    const message = typeof messageField === "string" ? messageField : JSON.stringify(error);
    return { code, message, data: error };
  };
}

// ============================================================================
// Streaming helpers
// ============================================================================

/** True when `v` is an async iterable — mirrors MCP's `isAsyncIterable` (mcp-api-projector/src/server.ts). */
function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

/**
 * WebSocket-transport streaming: drain `iterable`, sending one
 * `JsonRpcNotification` per yielded `StreamChunk`/untagged value (and one
 * per `StreamProgress`, both keyed by `subscription: id`) via `send`.
 * Returns the generator's own return value (or `null`) — see module doc's
 * "Streaming" section for why that becomes the original call's `result`.
 */
async function streamViaNotifications(
  iterable: AsyncIterable<unknown>,
  method: string,
  id: JsonRpcId,
  send: (n: JsonRpcNotification) => void | Promise<void>,
): Promise<unknown> {
  const iterator = iterable[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) return step.value ?? null;
    const value: unknown = step.value;
    if (isStreamProgress(value)) {
      await send({
        jsonrpc: "2.0",
        method,
        params: {
          type: "progress",
          subscription: id,
          progress: value.progress,
          total: value.total ?? 1,
          ...(value.message !== undefined ? { message: value.message } : {}),
        },
      });
    } else if (isStreamChunk(value)) {
      await send({
        jsonrpc: "2.0",
        method,
        params: { type: "chunk", subscription: id, value: value.data },
      });
    } else {
      await send({ jsonrpc: "2.0", method, params: { type: "chunk", subscription: id, value } });
    }
  }
}

/**
 * HTTP-transport streaming degrade: drain `iterable` to completion,
 * collecting `StreamChunk`/untagged yields into an array (progress yields
 * are dropped — see module doc's "Streaming" section). The generator's own
 * return value, when present, is appended last.
 */
async function drainToArray(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      if (step.value !== undefined) out.push(step.value);
      break;
    }
    const value: unknown = step.value;
    if (isStreamProgress(value)) continue;
    out.push(isStreamChunk(value) ? value.data : value);
  }
  return out;
}

// ============================================================================
// Dispatch core — shared by both transports
// ============================================================================

/**
 * A JSON-RPC middleware wraps the handler-invoking function `next` (itself
 * `F => F`). Composes like every other projector's middleware — onion-shaped,
 * first entry outermost — see CLI's `CliMiddleware` (cli-api-projector/src/
 * cli.ts) and docs/guide/framework.md §3. `stores` is the raw pre-assembly
 * `JsonRpcStoreBag` (`params` + `caller`); the handler itself never sees it,
 * structurally, the same as every sibling projector's base case.
 */
export type JsonRpcMiddleware = (
  next: (input: Record<string, unknown>, stores: JsonRpcStoreBag) => unknown | Promise<unknown>,
) => (input: Record<string, unknown>, stores: JsonRpcStoreBag) => unknown | Promise<unknown>;

/**
 * Dispatch context `CreateJsonRpcServerOptions.als`'s `init` receives — the
 * dispatched method's own `LeafMeta`, its name, and whether this call is a
 * Notification (§4.1: never gets a response, so a Notification's ALS context
 * is still established — a handler often behaves identically either way —
 * but nothing downstream can rely on ever reading a `JsonRpcResponse` back
 * out for it). Mirrors MCP's `McpAlsContext` (mcp-api-projector/src/server.ts)
 * and CLI's `CliAlsContext` (cli-api-projector/src/cli.ts).
 */
export type JsonRpcAlsContext = {
  readonly meta: LeafMeta;
  readonly method: string;
  readonly isNotification: boolean;
};

/** Options shared by both transport adapters (`createJsonRpcHttpHandler`/`createJsonRpcWebSocketHandlers`). */
export type CreateJsonRpcServerOptions<T = unknown> = {
  /** Method-name -> derived params/result schema + description (from codegen). Forwarded to `projectMethods`. */
  readonly schemas?: SchemaMap;
  /** Opt-in return-value detection, mirroring HTTP/MCP/CLI's own `detection` option — `result` gates `Result`-shape unwrapping, `streaming` gates `AsyncIterable` draining. Both default `true`. */
  readonly detection?: DetectionOptions;
  /** Maps a handler's `Result.err(E)` value to a JSON-RPC error object — see `JsonRpcErrorEncoder`/`jsonRpcErrors`. `undefined` (including when omitted) falls back to `JSON_RPC_INVALID_PARAMS` carrying the raw error as `data`. */
  readonly errorEncoder?: JsonRpcErrorEncoder;
  /**
   * Wrap the handler call so it runs inside its own `AsyncLocalStorage`
   * context. `init` computes the per-invocation context value from
   * `JsonRpcAlsContext`. Mirrors HTTP's `PresetOptions.als`, CLI's
   * `CliOpts.als`, and MCP's `CreateMcpServerOptions.als`. ALS is the
   * innermost wrapper — closer to the handler than `opts.middleware` — so
   * the store is active only while `dispatch.handler` (and anything it
   * calls, transitively) runs; a `JsonRpcMiddleware`'s own code, before or
   * after calling `next`, is not itself inside the ALS context —
   * `AsyncLocalStorage` doesn't propagate back out through an `await`'d
   * call once it settles. A middleware that needs cross-cutting context
   * should read it from `stores` (the second parameter every
   * `JsonRpcMiddleware` receives), or read the ALS store from code it
   * invokes synchronously inside `next`. Absent by default (no ALS
   * wrapping).
   */
  readonly als?: AlsConfig<JsonRpcAlsContext, T>;
  /**
   * Around-hooks wrapping the handler call — `F => F` where
   * `F = (input, stores) => result` (see `JsonRpcMiddleware` and
   * docs/guide/framework.md §3). Composes like an onion: the first entry in
   * the array is the outermost wrapper. When omitted (or empty), the
   * handler is called directly — zero overhead.
   */
  readonly middleware?: readonly JsonRpcMiddleware[];
};

type RunOptions<T = unknown> = {
  readonly detectResult: boolean;
  readonly detectStreaming: boolean;
  readonly errorEncoder: JsonRpcErrorEncoder | undefined;
  readonly als: AlsConfig<JsonRpcAlsContext, T> | undefined;
  readonly middleware: readonly JsonRpcMiddleware[];
  /** Present only for the WebSocket transport — enables the notification-streaming path (see `streamViaNotifications`) instead of HTTP's drain-to-array degrade. */
  readonly sendNotification: ((n: JsonRpcNotification) => void | Promise<void>) | undefined;
  /**
   * The `caller` store's contents for this dispatch — see `dispatchRequest`.
   * The HTTP transport builds this from the request's own headers (matching
   * http-api-projector's `httpStores` convention: dump every header
   * key-by-key, parsing is the consumer's job — docs/design/middleware-and-
   * caller-context.md). The WebSocket transport always passes `{}`: a
   * `message` handler has no per-message `Request`/headers at all (see
   * `createJsonRpcWebSocketHandlers`'s own doc comment for why that's a
   * structural limit of this transport, not an oversight).
   */
  readonly caller: Record<string, unknown>;
};

/**
 * Dispatch one JSON-RPC Request/Notification object: look up its method,
 * assemble the handler's input from the single `"params"` store (via the
 * shared `assemble` pipeline — see api-tree's input.ts), call it, and shape
 * the result. Returns `undefined` for a Notification (§4.1: never gets a
 * response) or when every framework-level check already ruled out sending
 * one; the caller (`dispatchBody`) is responsible for turning `undefined`
 * into "send nothing."
 */
async function dispatchRequest<T>(
  handlers: ReadonlyMap<string, Dispatch>,
  raw: unknown,
  opts: RunOptions<T>,
): Promise<JsonRpcResponse | undefined> {
  if (!isJsonRpcRequestShape(raw)) {
    const id =
      typeof raw === "object" && raw !== null && "id" in raw && !Array.isArray(raw)
        ? ((raw as { id?: JsonRpcId }).id ?? null)
        : null;
    return jsonRpcErrorResponse(id, JSON_RPC_INVALID_REQUEST, "Invalid Request");
  }

  const req = raw as JsonRpcRequest;
  const isNotification = !("id" in req) || req.id === undefined;
  const id: JsonRpcId = req.id ?? null;

  const dispatch = handlers.get(req.method);
  if (dispatch === undefined) {
    return isNotification
      ? undefined
      : jsonRpcErrorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }

  // By-name params only (see type-ir's json-rpc.ts module doc's "Params"
  // section for why) — a positional (array) `params` degrades to an empty
  // object rather than attempting positional-to-name mapping, which would
  // need the method's own params schema threaded through here just to
  // recover argument order.
  const paramsObj: Record<string, unknown> =
    typeof req.params === "object" && req.params !== null && !Array.isArray(req.params)
      ? (req.params as Record<string, unknown>)
      : {};

  try {
    const stores: JsonRpcStoreBag = { params: paramsObj, caller: opts.caller };
    const paramNames = [
      ...new Set([...Object.keys(paramsObj), ...Object.keys(dispatch.sourceMap)]),
    ];
    const input = assemble(stores, paramNames, dispatch.sourceMap, "params");

    // Call handler — wrapped (innermost-first) by ALS (see
    // CreateJsonRpcServerOptions.als), then by any configured middleware
    // (outermost-first; see CreateJsonRpcServerOptions.middleware). With
    // neither configured, `callHandler` is just `dispatch.handler` itself
    // (zero overhead) — matching CLI's `runCli`/MCP's `server.ts`.
    const alsContext: JsonRpcAlsContext = { meta: dispatch.meta, method: req.method, isNotification };
    const alsHandler =
      opts.als !== undefined
        ? (input: Record<string, unknown>) => {
            const store = opts.als!.init(alsContext);
            return store instanceof Promise
              ? store.then((resolved) => opts.als!.storage.run(resolved, () => dispatch.handler(input)))
              : opts.als!.storage.run(store, () => dispatch.handler(input));
          }
        : dispatch.handler;
    // Bridge the plain handler `(input) => result` into `F => F`'s base case
    // `(input, stores) => handler(input)` — the handler never sees `stores`,
    // structurally (see JsonRpcMiddleware's doc above).
    const base = (input: Record<string, unknown>, _stores: JsonRpcStoreBag) => alsHandler(input);
    const callHandler =
      opts.middleware.length === 0 ? base : composeMiddleware(opts.middleware, base);

    let result: unknown = await callHandler(input, stores);

    if (opts.detectStreaming && isAsyncIterable(result)) {
      result =
        opts.sendNotification !== undefined
          ? await streamViaNotifications(result, req.method, id, opts.sendNotification)
          : await drainToArray(result);
    }

    if (opts.detectResult && isResultShape(result)) {
      if (result.kind === "err") {
        if (isNotification) return undefined;
        const encoded = opts.errorEncoder?.(result.error);
        return encoded !== undefined
          ? jsonRpcErrorResponse(id, encoded.code, encoded.message, encoded.data)
          : jsonRpcErrorResponse(id, JSON_RPC_INVALID_PARAMS, "Invalid params", result.error);
      }
      result = result.value;
    }

    return isNotification ? undefined : jsonRpcSuccessResponse(id, result);
  } catch {
    // A thrown error is never surfaced verbatim — matching HTTP/MCP/CLI's
    // own default (collapse to a generic message); a handler that wants a
    // client-facing failure should return `err(...)` instead (surfaced via
    // `errorEncoder` above), which is conveyed verbatim.
    return isNotification
      ? undefined
      : jsonRpcErrorResponse(id, JSON_RPC_INTERNAL_ERROR, "Internal error");
  }
}

/**
 * Dispatch a parsed JSON body — either a single Request object or a batch
 * array (§6, see module doc's "Batch requests" section). Returns `undefined`
 * when nothing should be sent back (a lone Notification, or a batch made
 * entirely of Notifications).
 */
async function dispatchBody<T>(
  handlers: ReadonlyMap<string, Dispatch>,
  body: unknown,
  opts: RunOptions<T>,
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (Array.isArray(body)) {
    if (body.length === 0)
      return jsonRpcErrorResponse(null, JSON_RPC_INVALID_REQUEST, "Invalid Request");
    const results = await Promise.all(body.map((item) => dispatchRequest(handlers, item, opts)));
    const responses = results.filter((r): r is JsonRpcResponse => r !== undefined);
    return responses.length > 0 ? responses : undefined;
  }
  return dispatchRequest(handlers, body, opts);
}

function resolveRunOptions<T>(
  opts: CreateJsonRpcServerOptions<T>,
  sendNotification: RunOptions<T>["sendNotification"],
  caller: Record<string, unknown>,
): RunOptions<T> {
  return {
    detectResult: opts.detection?.result ?? true,
    detectStreaming: opts.detection?.streaming ?? true,
    errorEncoder: opts.errorEncoder,
    als: opts.als,
    middleware: opts.middleware ?? [],
    sendNotification,
    caller,
  };
}

/** `req.headers` dumped key-by-key into a plain object — the HTTP transport's `caller` convention, matching `httpStores` (http-api-projector/src/decode.ts). */
function callerFromRequestHeaders(req: Request): Record<string, unknown> {
  const caller: Record<string, unknown> = {};
  for (const [key, value] of req.headers.entries()) caller[key] = value;
  return caller;
}

// ============================================================================
// HTTP POST transport
// ============================================================================

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build an HTTP POST transport for `tree`: a plain
 * `(req: Request) => Promise<Response>` handler, the same shape
 * `createFetch` (http-api-projector)/`Bun.serve`/`Deno.serve`/a Cloudflare
 * Worker all accept directly. Every request is POSTed a JSON-RPC Request
 * object or batch array (§6) as its body; the method itself is not read
 * from the URL — JSON-RPC's addressing is entirely inside the payload, so
 * every call goes to the same endpoint URL.
 *
 * A malformed JSON body is a Parse error (§4.2, code -32700). A body that's
 * neither a Request-shaped object nor a batch array is an Invalid Request
 * (§4.2, code -32600). See module doc for batch/streaming/error-mapping
 * behavior.
 */
export function createJsonRpcHttpHandler<T = unknown>(
  tree: Node,
  opts: CreateJsonRpcServerOptions<T> = {},
): (req: Request) => Promise<Response> {
  const { handlers } = projectMethods(tree, toProjectOptions(opts));

  return async (req) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(jsonRpcErrorResponse(null, JSON_RPC_PARSE_ERROR, "Parse error"));
    }

    const runOpts = resolveRunOptions(opts, undefined, callerFromRequestHeaders(req));
    const result = await dispatchBody(handlers, body, runOpts);
    // §6: a batch consisting entirely of Notifications (or a lone
    // Notification) sends no response at all — 204 No Content is the
    // conventional HTTP rendering of "nothing to say back."
    if (result === undefined) return new Response(null, { status: 204 });
    return jsonResponse(result);
  };
}

// ============================================================================
// WebSocket transport
// ============================================================================

/** The minimal socket shape this transport needs — deliberately duck-typed (not `import type { ServerWebSocket } from "bun"`) so this package has no hard dependency on any one runtime's WebSocket API; Bun's `ServerWebSocket`, `ws`'s `WebSocket`, and the standard `WebSocket` all satisfy it. */
export type JsonRpcSocket = { send(data: string): void };

/** The handler shape `createJsonRpcWebSocketHandlers` returns — matches (a subset of) Bun's `WebSocketHandler<T>` and is trivially adaptable to `ws`'s `on("message", ...)` event shape. */
export type JsonRpcWebSocketHandlers = {
  readonly message: (
    ws: JsonRpcSocket,
    raw: string | ArrayBufferLike | Uint8Array,
  ) => Promise<void>;
};

function decodeMessage(raw: string | ArrayBufferLike | Uint8Array): string {
  if (typeof raw === "string") return raw;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return new TextDecoder().decode(bytes);
}

/**
 * Build a WebSocket transport for `tree`: a `{ message }` handler any
 * WebSocket server can drive per-connection. Unlike the HTTP transport,
 * this one has a genuine push channel — a streaming handler's elements are
 * delivered as JSON-RPC Notifications over the same connection the request
 * arrived on, interleaved with any other in-flight calls (see module doc's
 * "Streaming" section).
 *
 * One connection dispatches every message it receives against the same
 * `tree`; there is no per-connection state beyond what `tree`'s own
 * handlers close over — a consumer that needs per-connection identity
 * (auth, session) should bake it into the `tree`'s handlers via whatever
 * mechanism it already uses for caller context (see
 * docs/design/middleware-and-caller-context.md), not this transport, which
 * stays a thin message pump.
 */
export function createJsonRpcWebSocketHandlers<T = unknown>(
  tree: Node,
  opts: CreateJsonRpcServerOptions<T> = {},
): JsonRpcWebSocketHandlers {
  const { handlers } = projectMethods(tree, toProjectOptions(opts));

  return {
    async message(ws, raw) {
      let body: unknown;
      try {
        body = JSON.parse(decodeMessage(raw));
      } catch {
        ws.send(JSON.stringify(jsonRpcErrorResponse(null, JSON_RPC_PARSE_ERROR, "Parse error")));
        return;
      }

      const runOpts = resolveRunOptions(opts, (n) => ws.send(JSON.stringify(n)), {});
      const result = await dispatchBody(handlers, body, runOpts);
      if (result !== undefined) ws.send(JSON.stringify(result));
    },
  };
}

function toProjectOptions<T>(opts: CreateJsonRpcServerOptions<T>): ProjectMethodsOptions {
  return opts.schemas !== undefined ? { schemas: opts.schemas } : {};
}
