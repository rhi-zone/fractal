# The framework: one tree, five protocols

This page orients you across all five protocol projectors — how they relate, what they
share, and where they diverge. It assumes you've read [Core Concepts](./concepts.md); it
does not re-derive the `Node`/tags/metadata model, only the parts of it that matter for
choosing and combining projections. For the full export table of any one protocol, see its
reference page: [HTTP](../reference/framework/http.md), [MCP](../reference/framework/mcp.md),
[CLI](../reference/framework/cli.md), [GraphQL](../reference/framework/graphql.md),
[JSON-RPC](../reference/framework/json-rpc.md).

## 1. The shared model, briefly

There is one `Node` tree, authored with two constructors:

```ts
import { api, op } from "@rhi-zone/fractal-api-tree";

const tree = api({
  books: api({
    list: op(() => [{ id: "1", title: "Dune" }], { tags: { readOnly: true } }),
    add: op((input: { title: string }) => ({ id: "2", ...input })),
    remove: op((input: { id: string }) => ({ ok: true }), { tags: { destructive: true } }),
  }),
});
```

`meta.tags` (three-valued: `true` / `false` / `undefined`, no inheritance — see
[Concepts §4](./concepts.md#4-tags)) is the one authoring surface every projection reads to
derive protocol-specific behavior: HTTP verbs, MCP annotation hints, CLI confirmation
prompts, GraphQL Query-vs-Mutation placement.

Projections split into two dispatch modes (see
[Concepts §7](./concepts.md#7-projections--dispatching-vs-enumerating)):

| Mode            | Protocols              | What happens                                                                                                           |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Dispatching** | HTTP, CLI              | A request/argv arrives → walk the tree (or HTTP's derived route tree) to one leaf → call its handler                   |
| **Enumerating** | MCP, GraphQL, JSON-RPC | Flatten every leaf up front into a flat list (tools / fields / methods), then dispatch by name against that flat table |

The same tree, unmodified, feeds all five constructors below — nothing about `tree` above
is HTTP-specific, MCP-specific, etc.

## 2. Per-protocol summary

### HTTP — `@rhi-zone/fractal-http-api-projector`

Produces a WHATWG-`Request`/`Response` router, an OpenAPI 3.1 document, and a typed proxy
client, all derived from the same `HttpRoute` (itself built from `Node` via
`httpProjection` — see [Concepts §3](./concepts.md#3-building-the-http-route-tree--a-separate-transform-not-attribute-dispatch)).
**Dispatching**: `createFetch` walks the compiled `HttpRoute` directly, O(depth) via keyed
child lookup, no flat route table. Standout feature: because `toOpenApi` and `createClient`
walk the _same_ `HttpRoute` the server dispatches on, server/docs/client cannot drift apart
— there's no separate schema-authoring step to fall out of sync.

```ts
import { createFetch } from "@rhi-zone/fractal-http-api-projector";
const fetch = createFetch(tree);
await fetch(new Request("http://localhost/books/list")); // GET, derived from readOnly: true
```

### MCP — `@rhi-zone/fractal-mcp-api-projector`

Projects the tree into Model Context Protocol tools/resources/prompts over
`@modelcontextprotocol/sdk`. **Enumerating**: `toTools` walks the tree once, emitting one
`McpTool` per leaf with an underscore-joined name (`books_list`); a leaf can opt into
becoming a resource or prompt instead via `meta.mcp.as`. Standout feature: `readOnlyHint`/
`idempotentHint`/`destructiveHint`/`openWorldHint` annotations are derived straight from
`meta.tags`, three-valued — a hint is emitted only when the tag actually resolves, never
guessed from an `undefined`. `createMcpServer` returns an unconnected `Server` (same stance
as `createFetch`); `createStdioMcpServer`/`createHttpMcpServer` are one-call presets for the
two common transports, the latter session-keyed per the Streamable HTTP spec.

### CLI — `@rhi-zone/fractal-cli-api-projector`

Projects the tree into a CLI: each branch a subcommand namespace, each leaf a subcommand.
**Dispatching**: `runCli` walks the tree following `argv` segments — no separate route-tree
transform, since a CLI's shape already matches the domain tree's shape 1:1. Standout
feature: a leaf tagged `destructive` (or explicitly not `readOnly`) triggers an interactive
confirm prompt before running, reading the exact same tag lattice MCP's annotation hints
read. `walkCliCommands` enumerates the tree separately for help text and shell-completion
generation (bash/zsh/fish).

### GraphQL — `@rhi-zone/fractal-graphql-api-projector`

Projects the tree into SDL, resolver dispatch, subscriptions, and a typed client.
**Enumerating**: `projectGraphQL` walks the tree once; `readOnly`-tagged (and read-like
named) leaves become `Query` fields, everything else becomes `Mutation` fields, nested
branches become namespace object types, and a `fallback` becomes an argument threaded onto
every field beneath it. Standout feature: field-level type SDL is delegated to type-ir's
`toGraphQL`/`toGraphQLType` rather than reimplemented, and `createWsHandler`/
`handleBunWebSocket` project streaming leaves as GraphQL subscriptions.

### JSON-RPC — `@rhi-zone/fractal-json-rpc-api-projector`

Projects the tree into a JSON-RPC 2.0 surface over HTTP or WebSocket, plus a typed client.
**Enumerating**: `projectMethods`/`toMethods` walk the tree once into a flat
`JsonRpcMethod[]` with dot-joined method names (`books.list`) and a dispatch table keyed by
that same name. Standout feature: `createJsonRpcHttpHandler`/
`createJsonRpcWebSocketHandlers` wrap that dispatch table in the full JSON-RPC 2.0 envelope
— batch requests, notifications, and the standard `-32xxx` error codes — for free; this is
the thinnest of the five projectors, with no protocol-specific derivation from tags beyond
naming.

## 3. Middleware

Middleware is **not** MCP/CLI-specific — it's a shared shape (`docs/design/middleware-and-caller-context.md`)
implemented independently by HTTP, MCP, CLI, and GraphQL, all with the identical signature:
an around-hook `F => F` wrapping the handler-invoking function, composed outermost-first
(the first entry in the `middleware` array wraps every other entry, and runs closest to the
edge of the request):

```ts
// packages/mcp-api-projector/src/server.ts
export type McpMiddleware = (
  next: (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>,
) => (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>;
```

`CliMiddleware` (`packages/cli-api-projector/src/cli.ts`), `HttpHandlerMiddleware`
(`packages/http-api-projector/src/route.ts`), and `GraphQLHandlerMiddleware`
(`packages/graphql-api-projector/src/resolve.ts`) are structurally identical —
`(input, stores) => result` in, same shape out. Each is wired through its own options object
(`CreateMcpServerOptions.middleware`, `CliOpts.middleware`,
`PresetOptions.handlerMiddleware`, `ResolverOptions.middleware`) and composed by the same
`composeMiddleware`-shaped reducer, first-listed outermost. It sits _inside_ the
handler-invocation boundary — closer to the handler than protocol-level wrapping like
HTTP's `layers.ts` (`autoMethodLayer`, CORS) — and is the place to hang cross-cutting
concerns that need the assembled `input` and the shared `stores` (caller context, tracing,
auth) rather than raw wire bytes.

**JSON-RPC has no equivalent** — grepping `packages/json-rpc-api-projector/src` turns up no
`Middleware` type or `middleware` option; it only references the shared design doc in a
comment about caller-context, staying "a thin message pump." A JSON-RPC-specific
cross-cutting concern has to be baked into the tree's own handlers.

## 4. Extensions

"Extension" is HTTP-client-specific vocabulary — it names client-side wrappers around the
_fetch step_, not the server middleware from §3. A `ClientExtension`
(`packages/http-api-projector/src/extension.ts`) is one value with two independent
interpreters:

- **Runtime** (`wrapFetch`, `decodeResponse`) — wraps the live `FetchImpl` the runtime proxy
  client (`createClient`) calls, and/or claims a `Response` before the default JSON/text
  decode runs.
- **Codegen** (`codegen.wrap`, `codegen.wrapResult`, `codegen.streamingCall`,
  `codegen.resultHelpers`) — the same behavior expressed as source-text transforms, for
  `generateClient`'s standalone codegen output.

Composition order matches middleware: `extensions[0]` is outermost. The deliberate design
choice (per the module doc) is _not_ a fixed `beforeRequest`/`afterResponse` hook enum —
that shape can't express `retry`, which needs to re-run the entire inner fetch arbitrarily
many times, not just observe around one call. Built-in extensions in
`packages/http-api-projector/src/extensions/` (each an ordinary `ClientExtension`, no
privileged internal API):

| Extension                                                     | File                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `retry(options?)`                                             | `retry.ts`                                                     |
| `timeout(options)`                                            | `timeout.ts`                                                   |
| `interceptors(options?)`                                      | `interceptors.ts`                                              |
| `logging(options?)`                                           | `logging.ts`                                                   |
| `pagination(options?)`                                        | `pagination.ts`                                                |
| `errors`, `idempotency`, `streaming`, `tracing`, `validation` | (same directory — not yet in the reference table's short list) |

```ts
import { createClient } from "@rhi-zone/fractal-http-api-projector";
import { retry } from "@rhi-zone/fractal-http-api-projector/extensions/retry";
import { logging } from "@rhi-zone/fractal-http-api-projector/extensions/logging";

const client = createClient(tree, { extensions: [retry({ maxRetries: 3 }), logging()] });
// retry is outermost: it sees logging's effects on every attempt, including retried ones
```

No analogous client-extension mechanism exists for MCP, CLI, GraphQL, or JSON-RPC clients
in the packages read for this page — their typed clients (`createMcpClient`,
`createGraphQLClient`, `createJsonRpcClient`) take a transport/SDK client directly, with no
`extensions` option surfaced in their reference pages.

## 5. Cross-protocol consistency: one tag, five behaviors

Because every projection reads `meta.tags` directly off the same node — no inheritance, no
per-protocol re-authoring — a single tag asserted once changes behavior consistently
everywhere that tag is meaningful:

```ts
const remove = op((input: { id: string }) => ({ ok: true }), { tags: { destructive: true } });
```

| Projection | Effect of `destructive: true`                                          |
| ---------- | ---------------------------------------------------------------------- |
| HTTP       | `verbFromTags` derives `DELETE` (idempotent+destructive combination)   |
| MCP        | `destructiveHint: true` on the tool's annotations                      |
| CLI        | `runCli` prompts for interactive confirmation before invoking          |
| GraphQL    | Not read-like, so the field lands under `Mutation` rather than `Query` |

Similarly, `readOnly: true` (which the lattice also implies `idempotent: true` for) drives
HTTP's `GET`, MCP's `readOnlyHint`/`idempotentHint`, CLI skipping the confirm prompt, and
GraphQL's `Query`-field placement — from one line of authoring, not five.

## 6. Which protocol(s) do you need

These aren't mutually exclusive — the same tree commonly feeds more than one projector in
the same deployment.

- **HTTP** — public APIs, anything that needs OpenAPI docs or a REST-shaped surface for
  arbitrary HTTP clients (browsers, curl, generated SDKs in other languages).
- **MCP** — exposing operations as tools an LLM agent calls directly (Claude Desktop, any
  MCP-speaking client); the `readOnlyHint`/`destructiveHint` annotations exist specifically
  to inform an agent's tool-use decisions.
- **CLI** — scripting and local/operator use; the confirm-on-destructive behavior and shell
  completions are aimed at a human or script driving a terminal.
- **GraphQL** — clients that need to request exactly the fields they want in one round trip,
  or that already standardize on a GraphQL gateway.
- **JSON-RPC** — simple RPC-style clients that want direct method-name dispatch without
  REST resource/verb conventions or a GraphQL query language, and without needing
  destructive-hint or OpenAPI machinery.

## See also

- [Core Concepts](./concepts.md) — the `Node`/tags/metadata model these projections are
  built on.
- [HTTP reference](../reference/framework/http.md), [MCP reference](../reference/framework/mcp.md),
  [CLI reference](../reference/framework/cli.md), [GraphQL reference](../reference/framework/graphql.md),
  [JSON-RPC reference](../reference/framework/json-rpc.md) — full export tables per protocol.
