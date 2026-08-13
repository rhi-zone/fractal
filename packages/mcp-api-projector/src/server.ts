// Wires a Node tree into a running `@modelcontextprotocol/sdk` `Server`. One
// call turns a tree into a live MCP server, the way `createFetch`
// (http-api-projector/src/preset.ts) turns one into a live HTTP handler.
//
// Built on the SDK's low-level `Server` rather than the high-level `McpServer`.
// The high-level API describes a tool's input in Zod — a raw shape or a schema,
// but Zod either way — and project.ts already derives real JSON Schema from
// handler types. Using it would mean carrying a second description of the same
// handlers to buy nothing.
//
// `tools/list` and `tools/call` are always registered. The other two surfaces
// register only when the tree has leaves for them: `resources/list`,
// `resources/templates/list` and `resources/read` alongside a `resources`
// capability when any leaf is marked `meta.mcp.as: "resource"`, and
// `prompts/list`/`prompts/get` alongside a `prompts` capability when any leaf is
// marked `meta.mcp.as: "prompt"`. So the advertised capabilities describe the
// tree, unless `opts.capabilities` asks for more. The initialize handshake,
// transport framing and protocol version negotiation stay with the SDK.
//
// Each of project.ts's three walks hands back both its descriptors and the
// dispatch table built during that same walk, and this module dispatches
// through those tables. Nothing re-walks the tree per call, and no name or URI
// can be listed under one spelling and dispatched under another. Tools and
// prompts resolve by exact name; fixed resources by exact URI; resource
// templates by trying each compiled pattern in turn and binding the segments it
// captures.
//
// The returned `Server` is not connected to anything. Picking a transport and
// calling `server.connect(transport)` is the caller's — the same stance
// `createFetch` takes in returning a plain callable and leaving `Bun.serve`,
// `Deno.serve` or worker wiring alone. presets.ts packages the two common
// choices for callers who would rather not make it.
//
// See:
//   packages/mcp-api-projector/src/project.ts — the three walks, and the descriptors they build
//   packages/http-api-projector/src/preset.ts — sibling preset (createFetch, structural mirror)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  RequestHandlerExtra,
  RequestOptions,
} from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  ContentBlock,
  CreateMessageRequestParams,
  CreateMessageRequestParamsBase,
  CreateMessageRequestParamsWithTools,
  CreateMessageResult,
  CreateMessageResultWithTools,
  GetPromptResult,
  Implementation,
  LoggingLevel,
  ReadResourceResult,
  ServerCapabilities,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { LeafMeta, Node } from "@rhi-zone/fractal-api-tree/node";
import {
  assemble,
  composeErrorEncoders,
  isResultShape,
  isStreamChunk,
  isStreamProgress,
  matchKind,
} from "@rhi-zone/fractal-api-tree";
import type {
  CallerStoreShape,
  DetectionOptions,
  ErrorEncoder,
  ProjectorStores,
  SourceMap,
  Store,
} from "@rhi-zone/fractal-api-tree";

/**
 * The stores this projector builds, named and typed but not registered.
 *
 * A deployment registers them, once, in its own augmentation file
 * (`interface StoreRegistry extends McpStores {}`). This package deliberately
 * does not augment `StoreRegistry` itself: a projector that did would make the
 * available store names depend on which packages happen to be in the
 * compilation rather than on what the deployment actually composed
 * (docs/design/typed-store-spec.md §3). `HttpStores` in
 * http-api-projector/src/decode.ts is the same pattern worked through.
 *
 * Both members are optional because a request builds one or the other, never
 * both: a tool or prompt call builds `argument`, a resource read builds
 * `uri-variable`. `caller` is not here — core declares it once, for every
 * projector, as `CoreStores`.
 */
export interface McpStores {
  /** A tool call's or prompt's named arguments. */
  argument?: Store;
  /** A resource template's URI variables, captured from the requested URI. */
  "uri-variable"?: Store;
}

/**
 * Everything a dispatch has to hand: the registry's shared stores — core's
 * `caller`, plus whatever service stores the deployment registered — together
 * with MCP's own two. Intersecting rather than augmenting is what lets this
 * package build and read `argument` and `uri-variable` without registering
 * anything globally; `HttpStoreBag` (http-api-projector/src/decode.ts) is
 * assembled the same way.
 */
export type McpStoreBag = ProjectorStores & McpStores;

import type { AlsConfig } from "@rhi-zone/fractal-api-tree/context";
import { projectPrompts, projectResources, projectTools } from "./project.ts";
import type { ProjectPromptsOptions, ProjectResourcesOptions, SchemaMap } from "./project.ts";

// ============================================================================
// Rich content pass-through (tool call results, resource read results)
// ============================================================================
//
// What a handler returns decides the content type it becomes. A plain value —
// a string, a number, an ordinary object or array — is wrapped as a text
// block. A value already shaped like MCP content, or an array of such values,
// is passed through as it stands. That second path is how a handler returns an
// image, audio, or an embedded resource instead of watching everything flatten
// into JSON text.

/** The content-block discriminators eligible for pass-through. */
const MCP_CONTENT_TYPES = new Set(["text", "image", "audio", "resource"]);

/**
 * Whether a value is already an MCP content block: a plain object with a
 * recognized `type`, and with the fields that particular type requires actually
 * present and of the right kind.
 *
 * Checking the payload and not just the discriminator is what keeps a domain
 * object that happens to have a `type: "text"` field from being mistaken for
 * content and passed through unwrapped.
 */
function isMcpContentBlock(value: unknown): value is ContentBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !MCP_CONTENT_TYPES.has(type)) return false;

  const v = value as Record<string, unknown>;
  switch (type) {
    case "text":
      return typeof v.text === "string";
    case "image":
    case "audio":
      return typeof v.data === "string" && typeof v.mimeType === "string";
    case "resource":
      return (
        typeof v.resource === "object" &&
        v.resource !== null &&
        typeof (v.resource as { uri?: unknown }).uri === "string"
      );
    default:
      return false;
  }
}

/**
 * Build the `content` array of a `tools/call` result from whatever the handler
 * returned.
 *
 * Content, or an array of content, passes through untouched. Anything else
 * becomes a single text block — a string used as-is, so it is not quoted and
 * escaped a second time, and any other value serialized as JSON.
 */
export function toCallToolContent(result: unknown): ContentBlock[] {
  if (Array.isArray(result) && result.length > 0 && result.every(isMcpContentBlock)) {
    return result;
  }
  if (isMcpContentBlock(result)) {
    return [result];
  }
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }];
}

/** One entry of a `resources/read` result: text or binary, never both. */
type ResourceContentEntry =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };

/**
 * Build one `contents` entry of a `resources/read` result from whatever the
 * handler returned.
 *
 * A handler that returned `{ text }` or `{ blob }` has already said how its
 * content should be carried, and may override the MIME type declared on the
 * resource while it is at it. Anything else is serialized as JSON text under
 * the declared type.
 */
export function toResourceContent(
  result: unknown,
  uri: string,
  defaultMimeType: string,
): ResourceContentEntry {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const v = result as Record<string, unknown>;
    if (typeof v.text === "string") {
      return {
        uri,
        mimeType: typeof v.mimeType === "string" ? v.mimeType : defaultMimeType,
        text: v.text,
      };
    }
    if (typeof v.blob === "string") {
      return {
        uri,
        mimeType: typeof v.mimeType === "string" ? v.mimeType : defaultMimeType,
        blob: v.blob,
      };
    }
  }
  return { uri, mimeType: defaultMimeType, text: JSON.stringify(result) };
}

// ============================================================================
// Streaming
// ============================================================================
//
// A handler that returns an `AsyncIterable` is drained here rather than being
// treated as a value (docs/design/middleware-and-caller-context.md, "Streaming
// and Progress"). Each of the three surfaces has its own collector below,
// because each accumulates into a different result shape, but all three read a
// yield the same way.
//
// A `StreamProgress` yield becomes a `notifications/progress`, but only if the
// request carried a `progressToken`. Without one there is nothing for the
// client to correlate a notification against, so progress is dropped rather
// than held.
//
// A `StreamChunk` yield contributes its `data`, and an untagged yield
// contributes itself — HTTP's `streamAsSse` (route.ts) reads an untagged yield
// as a chunk too. The generator's return value, distinct from anything it
// yielded, is appended last.

/**
 * Whether a value can be drained. Structural — the presence of
 * `Symbol.asyncIterator` and nothing more, so any async iterable qualifies, not
 * only an async generator. HTTP decides this the same way, in
 * packages/http-api-projector/src/route.ts.
 */
function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

/**
 * Drain a tool handler's stream into the `content` array `tools/call` answers
 * with, sending progress notifications along the way. Every yield that is not
 * progress, and finally the return value, goes through `toCallToolContent`, so
 * a handler can stream rich content and not only text.
 */
async function collectStreamedToolContent(
  iterable: AsyncIterable<unknown>,
  extra: McpRequestExtra,
): Promise<ContentBlock[]> {
  const progressToken = extra._meta?.progressToken;
  const content: ContentBlock[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      if (step.value !== undefined) content.push(...toCallToolContent(step.value));
      break;
    }
    const value: unknown = step.value;
    if (isStreamProgress(value)) {
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: value.progress,
            total: value.total ?? 1,
            ...(value.message !== undefined ? { message: value.message } : {}),
          },
        });
      }
    } else if (isStreamChunk(value)) {
      content.push(...toCallToolContent(value.data));
    } else {
      content.push(...toCallToolContent(value));
    }
  }
  return content;
}

/**
 * Drain a resource handler's stream into the `contents` array `resources/read`
 * answers with. Every yield that is not progress, and finally the return value,
 * becomes one entry, each carrying the resource's own URI and MIME type.
 */
async function collectStreamedResourceContents(
  iterable: AsyncIterable<unknown>,
  extra: McpRequestExtra,
  uri: string,
  defaultMimeType: string,
): Promise<ResourceContentEntry[]> {
  const progressToken = extra._meta?.progressToken;
  const contents: ResourceContentEntry[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      if (step.value !== undefined)
        contents.push(toResourceContent(step.value, uri, defaultMimeType));
      break;
    }
    const value: unknown = step.value;
    if (isStreamProgress(value)) {
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: value.progress,
            total: value.total ?? 1,
            ...(value.message !== undefined ? { message: value.message } : {}),
          },
        });
      }
    } else if (isStreamChunk(value)) {
      contents.push(toResourceContent(value.data, uri, defaultMimeType));
    } else {
      contents.push(toResourceContent(value, uri, defaultMimeType));
    }
  }
  return contents;
}

/**
 * Drain a prompt handler's stream into the `messages` array `prompts/get`
 * answers with. Every yield that is not progress, and finally the return value,
 * becomes one assistant message carrying JSON text — MCP gives a prompt yield
 * no richer content shape to aim at, and the non-streaming path below
 * serializes a plain return value the same way.
 */
async function collectStreamedMessages(
  iterable: AsyncIterable<unknown>,
  extra: McpRequestExtra,
): Promise<Array<{ role: "assistant"; content: { type: "text"; text: string } }>> {
  const progressToken = extra._meta?.progressToken;
  const messages: Array<{ role: "assistant"; content: { type: "text"; text: string } }> = [];
  const iterator = iterable[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      if (step.value !== undefined) {
        messages.push({
          role: "assistant",
          content: { type: "text", text: JSON.stringify(step.value) },
        });
      }
      break;
    }
    const value: unknown = step.value;
    if (isStreamProgress(value)) {
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: value.progress,
            total: value.total ?? 1,
            ...(value.message !== undefined ? { message: value.message } : {}),
          },
        });
      }
    } else if (isStreamChunk(value)) {
      messages.push({
        role: "assistant",
        content: { type: "text", text: JSON.stringify(value.data) },
      });
    } else {
      messages.push({ role: "assistant", content: { type: "text", text: JSON.stringify(value) } });
    }
  }
  return messages;
}

// ============================================================================
// Error encoding
// ============================================================================
//
// A handler's error value says nothing about any protocol —
// `{ kind: "notFound", message: "Book not found" }` is as true over HTTP or a
// CLI as it is here. `CreateMcpServerOptions.errorEncoder` is where a
// deployment says what such a value means in MCP terms. HTTP and CLI take the
// same value and answer the same question in their own vocabularies, through
// `HttpErrorEncoder` (packages/http-api-projector/src/route.ts) and
// `CliErrorEncoder` (packages/cli-api-projector/src/cli.ts).
//
// An encoder that declines to map a value returns `undefined`, and the error
// falls through to the default `isError` result. So does every error when no
// encoder is configured at all.

/** What an MCP error encoder produces: a code and the message to carry it. */
export type McpErrorResponse = {
  readonly code: number;
  readonly message: string;
};

/** An `ErrorEncoder` targeting MCP: handler error value in, code and message out. */
export type McpErrorEncoder<E = unknown> = ErrorEncoder<E, McpErrorResponse>;

/**
 * An encoder that maps error kinds to MCP error codes, for the common case
 * where that mapping is all a deployment needs.
 *
 * ```ts
 * errorEncoder: mcpErrors({ notFound: ErrorCode.InvalidParams })
 * ```
 *
 * Kinds are tried in the order the object lists them, and the first match wins.
 * A kind with no entry is left unencoded, so it falls through to the default
 * error result. The message is the error value serialized as JSON.
 */
export function mcpErrors<E = unknown>(mapping: Record<string, number>): McpErrorEncoder<E> {
  const encoders = Object.entries(mapping).map(([kind, code]) => matchKind<number>(kind, code));
  const composed = composeErrorEncoders(...encoders);
  return (error) => {
    const code = composed(error);
    if (code === undefined) return undefined;
    return { code, message: JSON.stringify(error) };
  };
}

/** Render an encoded error as the failing tool call's result. */
function encodeToolError(name: string, response: McpErrorResponse): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: `Error ${response.code} for tool "${name}": ${response.message}` },
    ],
  };
}

// ============================================================================
// Sampling
// ============================================================================
//
// `sampling/createMessage` lets a handler ask the connected client to run a
// completion mid-execution. Handlers reach it through
// `stores.caller.createMessage`, wired up in `callerStore` below.
//
// Sampling is a client capability in the MCP spec, not a server one:
// `ClientCapabilitiesSchema` has a `sampling` field and
// `ServerCapabilitiesSchema` has none. The SDK enforces it accordingly —
// `Server.createMessage` asserts against `_clientCapabilities.sampling`, which
// is populated from what the connected client declared during `initialize`.
// Nothing a server advertises enters into it, and there is no
// `ServerCapabilities` key to advertise it with.
//
// `CreateMcpServerOptions.sampling` therefore governs one thing: whether
// `stores.caller.createMessage` exists at all. Making it opt-in means a handler
// written against a capability the deployment never enabled fails on a missing
// field, rather than holding a function that rejects on every call.

/**
 * Configuration for `CreateMcpServerOptions.sampling`. Empty today, and
 * accepted so that a later per-server default — say, `RequestOptions` applied
 * to every `createMessage` call — can arrive without changing the option's
 * shape. Passing `true` has the same effect.
 */
export type SamplingConfig = Record<string, never>;

/**
 * `stores.caller.createMessage` as a handler sees it: the SDK's own
 * `Server.createMessage` overloads, bound to this server so a handler needs no
 * reference to the `Server` itself.
 *
 * Its existence says the deployment enabled sampling, not that the call will
 * succeed. A client that never declared sampling support makes the call reject,
 * for the reason the "Sampling" section above gives.
 */
export interface CreateMessageFn {
  (params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;
  (
    params: CreateMessageRequestParamsWithTools,
    options?: RequestOptions,
  ): Promise<CreateMessageResultWithTools>;
  (
    params: CreateMessageRequestParams,
    options?: RequestOptions,
  ): Promise<CreateMessageResult | CreateMessageResultWithTools>;
}

// ============================================================================
// Logging
// ============================================================================
//
// MCP Tier 2 logging is two halves: `notifications/message`, which a server
// sends, and `logging/setLevel`, by which a client sets the minimum level it
// wants to receive. Handlers reach the sending half through
// `stores.caller.sendLog`, the same opt-in-field arrangement sampling uses.
//
// Logging, unlike sampling, is a server capability, so
// `CreateMcpServerOptions.logging` both advertises it and exposes `sendLog`.
//
// The negotiating half needs no code here at all. The SDK's `Server`
// constructor registers a `logging/setLevel` handler as soon as
// `capabilities.logging` is set, records each session's chosen minimum, and
// consults it inside `sendLoggingMessage` before anything goes out. Declaring
// the capability is the whole integration; this module adds only the
// handler-facing function on top of it.

/**
 * Configuration for `CreateMcpServerOptions.logging`. Empty today, and accepted
 * so that a later per-server default — say, a `logger` name used when a
 * `sendLog` call omits one — can arrive without changing the option's shape.
 * Passing `true` has the same effect. Mirrors `SamplingConfig`.
 */
export type LoggingConfig = Record<string, never>;

/** One log message: its severity, its payload, and optionally the name of the logger it came from. */
export type SendLogParams = {
  readonly level: LoggingLevel;
  readonly data: unknown;
  readonly logger?: string;
};

/**
 * `stores.caller.sendLog` as a handler sees it: emit one `notifications/message`
 * to the connected client, already bound to this server and to the session the
 * request arrived on, so a handler never threads a session id anywhere.
 *
 * Whether the message actually goes out is the SDK's call, per the level that
 * session negotiated — see the "Logging" section above.
 */
export interface SendLogFn {
  (params: SendLogParams): Promise<void>;
}

// ============================================================================
// Input assembly
// ============================================================================
//
// Every dispatch builds its stores, then runs the shared `assemble` pipeline
// (packages/api-tree/src/input.ts) over them to produce the bag the handler is
// called with.

/**
 * Build one request's `caller` store, identically for all three surfaces.
 *
 * Who is calling comes from the SDK's per-request `extra`: its `authInfo` and
 * `sessionId` are what `caller.authInfo` and `caller.sessionId` return. `extra`
 * itself goes no further — the `caller` store is the whole caller-context
 * surface, here as in every other projector
 * (docs/design/middleware-and-caller-context.md).
 *
 * What the caller can be asked to do comes from the two optional arguments,
 * present only when the deployment enabled the corresponding option:
 * `createMessage` for sampling, and `sendLog` for logging, the latter closed
 * over this request's session so the handler need not know it has one.
 */
function callerStore(
  extra: McpRequestExtra,
  createMessage?: CreateMessageFn,
  sendLoggingMessage?: (params: SendLogParams, sessionId?: string) => Promise<void>,
): CallerStoreShape {
  return {
    authInfo: extra.authInfo,
    sessionId: extra.sessionId,
    ...(createMessage !== undefined ? { createMessage } : {}),
    ...(sendLoggingMessage !== undefined
      ? { sendLog: (params: SendLogParams) => sendLoggingMessage(params, extra.sessionId) }
      : {}),
  };
}

/** Which parameters to assemble: everything the wire supplied, plus everything `sourceMap` named. A parameter sourced entirely from an override appears in no wire values at all, and would otherwise be missed. */
const paramNamesFor = (
  values: Record<string, unknown>,
  sourceMap: SourceMap,
): readonly string[] => [...new Set([...Object.keys(values), ...Object.keys(sourceMap)])];

// ----------------------------------------------------------------------------
// The two functions below differ only in which store the wire values land in,
// and are two functions rather than one taking a store name because of what
// that costs in types. A single function would have to build its stores with a
// computed key, `{ [storeName]: values }`, which TypeScript will not check
// against a literal member of `McpStoreBag` however the registry is declared;
// it would need a cast, and the cast would erase the checking this whole
// arrangement exists for (docs/design/typed-store-spec.md §5, §9(4)). Written
// out separately, each builds an object literal with a literal key and checks
// directly. Every call site already knows which one it wants, so the split
// costs callers nothing.
//
// Both return the stores alongside the assembled input, because middleware sees
// both — the assembled arguments, and the raw stores they were assembled from.
// The handler sees only the input.
//
// With no `sourceMap`, assembly is the identity: each parameter resolves from
// the store under its own name, and the handler receives the wire values as
// they arrived.
// ----------------------------------------------------------------------------

/** Assemble a tool call's or a prompt's input. Its arguments become the `argument` store. */
function assembleArgumentInput(
  values: Record<string, unknown>,
  sourceMap: SourceMap,
  extra: McpRequestExtra,
  createMessage?: CreateMessageFn,
  sendLoggingMessage?: (params: SendLogParams, sessionId?: string) => Promise<void>,
): { readonly input: Record<string, unknown>; readonly stores: McpStoreBag } {
  const stores: McpStoreBag = {
    argument: values,
    caller: callerStore(extra, createMessage, sendLoggingMessage),
  };
  return {
    input: assemble(stores, paramNamesFor(values, sourceMap), sourceMap, "argument"),
    stores,
  };
}

/** Assemble a resource read's input. The variables its URI captured become the `uri-variable` store. */
function assembleUriVariableInput(
  values: Record<string, unknown>,
  sourceMap: SourceMap,
  extra: McpRequestExtra,
  createMessage?: CreateMessageFn,
  sendLoggingMessage?: (params: SendLogParams, sessionId?: string) => Promise<void>,
): { readonly input: Record<string, unknown>; readonly stores: McpStoreBag } {
  const stores: McpStoreBag = {
    "uri-variable": values,
    caller: callerStore(extra, createMessage, sendLoggingMessage),
  };
  return {
    input: assemble(stores, paramNamesFor(values, sourceMap), sourceMap, "uri-variable"),
    stores,
  };
}

// ============================================================================
// Middleware
// ============================================================================
//
// A middleware wraps the call: `F => F`, where `F = (input, stores) => result`
// (docs/design/middleware-and-caller-context.md). There is no context bag
// besides those two arguments. `input` is the assembled domain arguments, the
// same values the handler will be called with; `stores` is what they were
// assembled from, which is how a middleware reaches anything the handler did
// not declare — caller identity, an audit trail, a raw argument nobody typed.
//
// The handler stays `(input) => result` throughout. It cannot see `stores`,
// because the base function below never passes them, which makes this a
// property of the code rather than a rule to remember.

/**
 * The per-request context the SDK passes every request handler, at the request
 * and notification types this package's low-level `Server` uses. `callerStore`
 * reads it; nothing else does.
 */
type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * A middleware: given the function that would run the call, return one that
 * runs it differently. Composition is onion-shaped, first entry outermost, as
 * it is for HTTP layers (packages/http-api-projector/src/layers.ts) and CLI
 * middleware (packages/cli-api-projector/src/cli.ts).
 */
export type McpMiddleware = (
  next: (input: Record<string, unknown>, stores: McpStoreBag) => unknown | Promise<unknown>,
) => (input: Record<string, unknown>, stores: McpStoreBag) => unknown | Promise<unknown>;

/** Wrap `base` in each middleware, first entry ending up outermost. An empty list returns `base` itself, unwrapped. */
function composeMiddleware(
  middleware: readonly McpMiddleware[],
  base: (input: Record<string, unknown>, stores: McpStoreBag) => unknown | Promise<unknown>,
): (input: Record<string, unknown>, stores: McpStoreBag) => unknown | Promise<unknown> {
  let wrapped = base;
  for (let i = middleware.length - 1; i >= 0; i--) {
    wrapped = middleware[i]!(wrapped);
  }
  return wrapped;
}

// ============================================================================
// ALS dispatch context
// ============================================================================
//
// `AsyncLocalStorage` is a side channel, not part of the call signature
// (docs/design/middleware-and-caller-context.md). What follows is the dispatch
// metadata `opts.als.init` is handed to compute a store from — not a context
// bag threaded through middleware, which sees `(input, stores)` and nothing
// else.

/** What the dispatch looks like from `opts.als.init`: which leaf, under which name, on which surface. */
export type McpAlsContext = {
  readonly meta: LeafMeta;
  /** The tool or prompt name, or the resource URI as requested. */
  readonly name: string;
  readonly requestType: "tool" | "resource" | "prompt";
};

export type CreateMcpServerOptions<T = unknown> = {
  /** Server name, given to clients during the initialize handshake. */
  readonly name: string;
  /** Server version, given alongside `name`. */
  readonly version: string;
  /** Human-readable title, if the server wants one distinct from its name. */
  readonly title?: string;
  /** Human-readable description of the server. */
  readonly description?: string;
  /** Derived schemas and descriptions, keyed by projected tool name. Forwarded to `projectTools`. */
  readonly schemas?: SchemaMap;
  /** Forwarded to `projectResources` — the URI scheme to derive resource URIs behind. */
  readonly resources?: ProjectResourcesOptions;
  /** Forwarded to `projectPrompts` — the derived schemas prompt arguments come from. */
  readonly prompts?: ProjectPromptsOptions;
  /**
   * Passes to run over `tree`, in order, before any projection walk sees it.
   * MCP's counterpart to HTTP's `PresetOptions.rewriters`
   * (packages/http-api-projector/src/preset.ts). Because MCP dispatches off the
   * same `Node` shape it is handed — there is no projected route table in
   * between, as there is for HTTP — a rewrite here is simply a rewrite of the
   * tree.
   *
   * This is how generated validation is wired in. There is no separate
   * `validators` option, because codegen anchors on the `applyValidation` call
   * site itself, which has to live in the consumer's own entry file; a call
   * `createMcpServer` made internally would be invisible to it.
   *
   * ```ts
   * import { applyValidation } from "./generated/apply-validation.ts"
   * const server = createMcpServer(tree, {
   *   name: "my-api",
   *   version: "1.0.0",
   *   rewriters: [(t) => applyValidation("books", t, "mcp")],
   * })
   * ```
   *
   * That third argument names the wire profile
   * (docs/design/wire-profiles-and-staged-validation.md). MCP's wire is JSON
   * that already carries its own types — a number arrives as a number — so the
   * profile coerces nothing except dates, which JSON has no literal for.
   * `"42"` where a number is expected is a validation error, not a value to be
   * helpfully converted.
   *
   * Validation covers exactly the leaves a generated validator names. A leaf it
   * does not name, or a tree with no `applyValidation` rewriter at all, reaches
   * its handler with the wire values as they arrived: the design's stated
   * tradeoff for a checkout where codegen has not been run.
   */
  readonly rewriters?: ReadonlyArray<(tree: Node) => Node>;
  /**
   * Capabilities to advertise on top of the ones derived from the tree. `tools`
   * is always advertised; `resources` and `prompts` are advertised when the
   * tree contains leaves of those kinds.
   */
  readonly capabilities?: ServerCapabilities;
  /**
   * Run each handler inside an `AsyncLocalStorage` context, computed per
   * invocation by `init` from the dispatch metadata in `McpAlsContext`.
   * HTTP's `PresetOptions.als` (packages/http-api-projector/src/preset.ts) and
   * CLI's `CliOpts.als` (packages/cli-api-projector/src/cli.ts) work the same
   * way. Off by default.
   *
   * Middleware sees no store, before or after `next`, for two separate
   * reasons. Before, because this is the innermost wrapper, nearer the handler
   * than any middleware — that part is a choice. After, because a context does
   * not follow execution back out of an `await` once the awaited call has
   * settled — that part is `AsyncLocalStorage` itself, and no wrapping order
   * would change it. Middleware needing cross-cutting context should read
   * `stores`, or read the store from code it calls synchronously inside `next`.
   */
  readonly als?: AlsConfig<McpAlsContext, T>;
  /**
   * Middleware wrapping every handler call, first entry outermost. See
   * `McpMiddleware` for the shape and the "Middleware" section above for what
   * each argument carries. Omitted or empty, handlers are called directly.
   */
  readonly middleware?: readonly McpMiddleware[];
  /**
   * Which shapes to recognize in a handler's return value. `result` governs
   * unwrapping a `Result` — tools only; resources and prompts pass one through
   * as an ordinary value. `streaming` governs draining an `AsyncIterable`, and
   * with it the reading of `StreamEffect` tags on what it yields. Both are on
   * unless turned off.
   *
   * Turn one off when a handler legitimately returns or yields data shaped like
   * one of those and it must not be read as protocol. HTTP's
   * `PresetOptions.detection` and CLI's `CliOpts.detection` offer the same
   * escape hatch; `DetectionOptions` in @rhi-zone/fractal-api-tree defines the
   * shape.
   */
  readonly detection?: DetectionOptions;
  /**
   * What a tool handler's error value means in MCP terms — see `mcpErrors` for
   * the common kind-to-code case, and `composeErrorEncoders`
   * (@rhi-zone/fractal-api-tree) to combine several encoders.
   *
   * Consulted when a tool returns an err `Result` and `detection.result` is on.
   * An error the encoder declines to map, or any error when no encoder is
   * configured, produces the default `isError` result instead. Tools only,
   * since only tools unwrap a `Result` in the first place. HTTP's
   * `PresetOptions.errorEncoder` and CLI's `CliOpts.errorEncoder` are the same
   * option in their own vocabularies.
   */
  readonly errorEncoder?: McpErrorEncoder;
  /**
   * Give handlers `stores.caller.createMessage`, so they can ask the connected
   * client for a completion mid-execution. Pass `true`, or a `SamplingConfig`
   * for the same effect and room to configure later.
   *
   * Off by default: a handler should not be able to reach for a capability the
   * deployment never considered and the connected client may not implement.
   * Enabling it advertises nothing, because sampling is a client capability —
   * the "Sampling" section above has the detail.
   */
  readonly sampling?: boolean | SamplingConfig;
  /**
   * Advertise the `logging` capability and give handlers
   * `stores.caller.sendLog`, so they can emit log messages to the connected
   * client. Pass `true`, or a `LoggingConfig` for the same effect and room to
   * configure later. Anything passed as `capabilities.logging` is merged in.
   *
   * Off by default. Level negotiation comes free with the capability — see the
   * "Logging" section above.
   */
  readonly logging?: boolean | LoggingConfig;
};

/**
 * Build an MCP `Server` from a Node tree: project the tree's tools, resources
 * and prompts, register handlers for whichever of the three the tree actually
 * uses, and return the server, unconnected.
 *
 * Choosing a transport and connecting it is the caller's:
 *
 * ```ts
 * const server = createMcpServer(tree, { name: "my-api", version: "1.0.0" })
 * await server.connect(new StdioServerTransport())
 * ```
 *
 * A handler that throws does not take the request down with it: the throw
 * becomes an `isError` tool result, which is MCP's own way of reporting that an
 * operation failed, as distinct from the transport failing. A generated
 * validator's rejection ends up in the same place by a different route — it
 * returns an err `Result` rather than throwing, and is caught by the
 * return-value check rather than the try/catch.
 */
export function createMcpServer<T = unknown>(tree: Node, opts: CreateMcpServerOptions<T>): Server {
  // Rewriters run before anything reads the tree, so every projection walk and
  // every dispatch table sees the same rewritten leaves.
  const workingTree = (opts.rewriters ?? []).reduce((t, rewrite) => rewrite(t), tree);

  const { tools, handlers } = projectTools(
    workingTree,
    opts.schemas !== undefined ? { schemas: opts.schemas } : {},
  );
  const {
    resources,
    resourceTemplates,
    handlers: resourceHandlers,
    templateHandlers,
  } = projectResources(workingTree, opts.resources ?? {});
  const hasResources = resources.length > 0 || resourceTemplates.length > 0;

  const { prompts, handlers: promptHandlers } = projectPrompts(workingTree, opts.prompts ?? {});
  const hasPrompts = prompts.length > 0;

  const middleware = opts.middleware ?? [];

  const detectResult = opts.detection?.result ?? true;
  const detectStreaming = opts.detection?.streaming ?? true;

  // The innermost wrapper, closer to the handler than any middleware. Without
  // `opts.als` it is the identity, so an unconfigured server wraps nothing.
  const withAls = (
    handler: (input: Record<string, unknown>) => unknown | Promise<unknown>,
    context: McpAlsContext,
  ): ((input: Record<string, unknown>) => unknown | Promise<unknown>) =>
    opts.als === undefined
      ? handler
      : (input) => {
          const store = opts.als!.init(context);
          return store instanceof Promise
            ? store.then((resolved) => opts.als!.storage.run(resolved, () => handler(input)))
            : opts.als!.storage.run(store, () => handler(input));
        };

  // The base of the middleware chain: it accepts `stores` and drops them, which
  // is what keeps a handler's signature `(input) => result` no matter how much
  // middleware sits above it.
  const toBase =
    (
      handler: (input: Record<string, unknown>) => unknown | Promise<unknown>,
    ): ((input: Record<string, unknown>, stores: McpStoreBag) => unknown | Promise<unknown>) =>
    (input, _stores) =>
      handler(input);

  const implementation: Implementation = {
    name: opts.name,
    version: opts.version,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  };

  const server = new Server(implementation, {
    capabilities: {
      ...opts.capabilities,
      tools: { ...opts.capabilities?.tools },
      ...(hasResources ? { resources: { ...opts.capabilities?.resources } } : {}),
      ...(hasPrompts ? { prompts: { ...opts.capabilities?.prompts } } : {}),
      // Sampling is absent here by design, being a client capability with no
      // `ServerCapabilities` field to occupy. Logging has one, and declaring it
      // does more than advertise: it is what makes the SDK register the
      // `logging/setLevel` handler. Both sections above have the detail.
      ...(opts.logging === true || (typeof opts.logging === "object" && opts.logging !== null)
        ? { logging: { ...opts.capabilities?.logging } }
        : {}),
    },
  });

  // Bound to this server, so what lands on `stores.caller` is callable on its
  // own and a handler never needs the `Server`. Left undefined when sampling is
  // off, which is what makes the field absent rather than present and failing.
  const samplingEnabled =
    opts.sampling === true || (typeof opts.sampling === "object" && opts.sampling !== null);
  const createMessage: CreateMessageFn | undefined = samplingEnabled
    ? (((params: CreateMessageRequestParams, options?: RequestOptions) =>
        server.createMessage(params, options)) as CreateMessageFn)
    : undefined;

  // Bound to this server for the same reason as `createMessage` above. The
  // session it sends on is bound later, per request, in `callerStore`.
  const loggingEnabled =
    opts.logging === true || (typeof opts.logging === "object" && opts.logging !== null);
  const sendLoggingMessage:
    | ((params: SendLogParams, sessionId?: string) => Promise<void>)
    | undefined = loggingEnabled
    ? (params, sessionId) => server.sendLoggingMessage(params, sessionId)
    : undefined;

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      const dispatch = handlers.get(name);

      if (dispatch === undefined) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
      }

      try {
        const { input, stores } = assembleArgumentInput(
          args ?? {},
          dispatch.sourceMap,
          extra,
          createMessage,
          sendLoggingMessage,
        );
        const toolContext: McpAlsContext = { meta: dispatch.meta, name, requestType: "tool" };
        const base = toBase(withAls(dispatch.handler, toolContext));
        const callHandler = middleware.length === 0 ? base : composeMiddleware(middleware, base);
        let result = await callHandler(input, stores);

        // Checked before the `Result` check because a stream is never also a
        // `Result` or a content block, so there is no ambiguity to resolve —
        // HTTP's `runRoute` (packages/http-api-projector/src/route.ts) orders
        // these the same way.
        if (detectStreaming && isAsyncIterable(result)) {
          return { content: await collectStreamedToolContent(result, extra) };
        }

        // A `Result` is unwrapped wherever it came from: the handler's own
        // `ok`/`err`, or a generated validator's `parse()`, which reports
        // failure in exactly the same shape. An err becomes an MCP error
        // result, an ok is unwrapped to its value before becoming content.
        // Handler and validator failures are therefore indistinguishable to a
        // client, which is the point — both are the operation declining, not
        // the server breaking.
        if (detectResult && isResultShape(result)) {
          if (result.kind === "err") {
            const encoded = opts.errorEncoder?.(result.error);
            if (encoded !== undefined) return encodeToolError(name, encoded);
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Invalid input for tool "${name}": ${JSON.stringify(result.error)}`,
                },
              ],
            };
          }
          result = result.value;
        }

        return {
          content: toCallToolContent(result),
        };
      } catch {
        // A thrown message can carry stack frames, file paths, driver text —
        // internals nobody chose to publish. None of it reaches the client;
        // HTTP collapses a throw to a bare 500 for the same reason
        // (packages/http-api-projector/src/route.ts).
        //
        // A handler with something to say to the client says it by returning
        // `err(...)`, which is passed through as written. That is the
        // deliberate channel; a throw is not one.
        return {
          isError: true,
          content: [{ type: "text", text: "internal error" }],
        };
      }
    },
  );

  if (hasResources) {
    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates }));

    const resourcesByUri = new Map(resources.map((r) => [r.uri, r] as const));

    server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request, extra): Promise<ReadResourceResult> => {
        const { uri } = request.params;

        // Exact URIs first, then templates: a fixed resource whose URI a
        // template also matches is still the more specific answer.
        const fixed = resourceHandlers.get(uri);
        if (fixed !== undefined) {
          const mimeType = resourcesByUri.get(uri)?.mimeType ?? "application/json";
          const fixedContext: McpAlsContext = {
            meta: fixed.meta,
            name: uri,
            requestType: "resource",
          };
          const base = toBase(withAls(fixed.handler, fixedContext));
          const callHandler = middleware.length === 0 ? base : composeMiddleware(middleware, base);
          // A fixed URI captures nothing, so there are no variables to
          // assemble from — but the store is still built, so middleware sees
          // the caller here as it does everywhere else.
          const { input, stores } = assembleUriVariableInput(
            {},
            {},
            extra,
            createMessage,
            sendLoggingMessage,
          );
          const result = await callHandler(input, stores);
          if (detectStreaming && isAsyncIterable(result)) {
            return {
              contents: await collectStreamedResourceContents(result, extra, uri, mimeType),
            };
          }
          return { contents: [toResourceContent(result, uri, mimeType)] };
        }

        for (const template of templateHandlers) {
          const match = template.pattern.exec(uri);
          if (match === null) continue;
          const captured: Record<string, string> = {};
          template.paramNames.forEach((name, i) => {
            captured[name] = match[i + 1] as string;
          });
          const { input, stores } = assembleUriVariableInput(
            captured,
            template.sourceMap,
            extra,
            createMessage,
            sendLoggingMessage,
          );
          const templateContext: McpAlsContext = {
            meta: template.meta,
            name: uri,
            requestType: "resource",
          };
          const base = toBase(withAls(template.handler, templateContext));
          const callHandler = middleware.length === 0 ? base : composeMiddleware(middleware, base);
          const result = await callHandler(input, stores);
          if (detectStreaming && isAsyncIterable(result)) {
            return {
              contents: await collectStreamedResourceContents(
                result,
                extra,
                uri,
                template.mimeType,
              ),
            };
          }
          return { contents: [toResourceContent(result, uri, template.mimeType)] };
        }

        throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
      },
    );
  }

  if (hasPrompts) {
    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts }));

    server.setRequestHandler(
      GetPromptRequestSchema,
      async (request, extra): Promise<GetPromptResult> => {
        const { name, arguments: args } = request.params;
        const dispatch = promptHandlers.get(name);

        if (dispatch === undefined) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
        }

        const { input, stores } = assembleArgumentInput(
          args ?? {},
          dispatch.sourceMap,
          extra,
          createMessage,
          sendLoggingMessage,
        );
        const promptContext: McpAlsContext = { meta: dispatch.meta, name, requestType: "prompt" };
        const base = toBase(withAls(dispatch.handler, promptContext));
        const callHandler = middleware.length === 0 ? base : composeMiddleware(middleware, base);
        const result = await callHandler(input, stores);

        // A streaming prompt's yields become the messages it answers with.
        if (detectStreaming && isAsyncIterable(result)) {
          return { messages: await collectStreamedMessages(result, extra) };
        }

        // A handler that already built its own messages has said exactly what
        // it wants sent, so it is sent. Anything else becomes one assistant
        // message carrying the value as JSON.
        if (
          typeof result === "object" &&
          result !== null &&
          Array.isArray((result as { messages?: unknown }).messages)
        ) {
          return result as GetPromptResult;
        }

        return {
          messages: [
            { role: "assistant", content: { type: "text", text: JSON.stringify(result) } },
          ],
        };
      },
    );
  }

  return server;
}
