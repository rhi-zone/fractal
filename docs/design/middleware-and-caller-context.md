# Middleware and caller context

## Status

Settled design. Records the middleware signature and caller-context model
that replace the previous `(next, context) => (input) => result` /
`McpMiddlewareContext` / `CliMiddlewareContext` / `HttpHandlerMiddlewareContext`
pattern, and the `extra`-threading in MCP (commit `027baa6`).

---

## Middleware

Middleware is `F => F`, where:

```ts
type F = (input: Record<string, unknown>, stores: Stores) => Result
```

- `input` is the assembled, validated domain arguments — post-assembly,
  post-coercion. Same shape a handler receives.
- `stores` is the typed key-value stores interface — pre-validation,
  transport-populated. Cross-cutting context (caller identity, etc.) lives
  here.

The handler itself is `(input) => result` — no `stores` parameter. This is
structural, not a convention to remember: a handler cannot reach `stores`
because its type doesn't have the parameter.

The base adapter bridges handler to `F`:

```ts
const base: F = (input, _stores) => handler(input);
```

Middleware wraps `base` (or another middleware) and, unlike the handler it
wraps, sees both `input` and `stores`:

- `input` for validated domain arguments — the same values the handler sees.
- `stores` for cross-cutting context the handler didn't declare — caller
  identity, transport internals, anything a store exposes.

Middleware being "looser" than handlers — seeing all stores instead of only
declared params — is correct, not a leak. Middleware is cross-cutting by
nature; handlers are operation-specific and should only see what they
declared. Stores being pre-validation from middleware's point of view is
fine because middleware also has `input`, which is already validated, for
the values that need validation.

ALS (`AsyncLocalStorage`) is a side channel. It is strongly discouraged as
primary data flow — `stores` in the `F` signature is the primary channel.

### What this replaces

The previous signature was `(next, context) => (input) => result`, with a
separate invented context bag per projector: `McpMiddlewareContext`,
`CliMiddlewareContext`, `HttpHandlerMiddlewareContext`. That pattern is
removed. There is one middleware shape (`F => F`) and one context vehicle
(`stores`), shared across HTTP, CLI, and MCP.

---

## Caller context

Caller context — user identity, session, auth — is not a special concept.
It is just another store: a `caller` store, populated per-projector from
transport-specific sources.

- **HTTP**: from auth headers, cookies, session tokens.
- **CLI**: from env vars, OS user, config.
- **MCP**: from the SDK's `authInfo`, `sessionId`.

Handlers that need caller context declare it the same way they declare any
other store-sourced value: via `sourceMap`, e.g.
`{ store: "caller", key: "userId" }`. It becomes part of the assembled,
validated `input` — no special-cased handler parameter.

Middleware that needs caller context reads it directly from `stores.caller`
— no separate caller-context parameter, no ALS lookup.

### What this replaces

The `extra` threading added to MCP in commit `027baa6` (SDK's
`sendNotification`/`signal` pushed into `McpMiddlewareContext`) is reverted.
Caller context flows through the `caller` store like everything else.
ALS-based access to transport context is replaced by `stores` arriving as an
explicit parameter in the middleware signature.

---

## Stores typing

Stores use declaration merging, not a `Record<string, Store>` with
`get(key): unknown`:

- Each projector augments the `Stores` interface with what it provides
  (HTTP declares `caller`, `headers`, ...; CLI declares `caller`, `env`,
  ...; MCP declares `caller`, `authInfo`, ...).
- Cross-projector middleware reads from stores every projector declares —
  `caller` is the load-bearing example.
- Projector-specific middleware reads from projector-specific stores. The
  type system enforces the dependency: middleware that reads `stores.headers`
  only typechecks when composed into a tree whose `Stores` includes
  `headers`, i.e. only under HTTP.

This makes cross-cutting-vs-projector-specific a type-level distinction, not
a documentation convention.

---

## Streaming and Progress — Async Generator Protocol

A handler's return type widens from `T | Promise<T> | Result<T, E>` to also
allow `AsyncIterable<T | StreamEffect<T>>`. This is how a handler expresses
transport effects — progress, chunks — without knowing which transport it's
running under. `StreamEffect<T>` (`packages/api-tree/src/index.ts`) is the
tagged-value DU: `StreamProgress` (`{ kind: "progress", progress, total?,
message? }`) and `StreamChunk<T>` (`{ kind: "chunk", data: T }`), detected at
runtime with `isStreamEffect`/`isStreamProgress`/`isStreamChunk` — the same
loose-structural, exact-on-`kind` pattern `isResultShape` uses for `Result`.

- Projectors detect an async-generator return by checking for
  `Symbol.asyncIterator`, the same way they detect a `Promise` by checking
  for `.then` and a `Result` by checking `isResultShape`.
- Each yielded value is inspected: if it matches a recognized `StreamEffect`
  kind (`progress`, `chunk`), the projector interprets it per-transport (see
  table below); anything else yielded is treated as a chunk by default —
  the fallback keeps a plain `yield someValue` handler working without
  requiring every handler to wrap its yields in `{ kind: "chunk", data }`.
- The generator's return value (not a yielded value — the value the
  generator function itself returns via `return`) is the final result,
  handled the same way a non-streaming handler's return value is handled
  today (goes through `Result` detection, then encoding).
- Detection of stream-effect tags is **opt-in at the projector preset
  level**, not automatic sniffing of every yielded value's shape. This is
  the same concern `Result` detection already has (`decisions.md`): a
  handler that legitimately yields user data shaped like
  `{ kind: "progress", ... }` must not have it silently reinterpreted as a
  transport effect. A preset that hasn't opted in treats every yielded
  value as a chunk, full stop.
- Middleware (`F => F`, see above) passes an `AsyncIterable` return value
  through unchanged by default — it's just another value flowing through
  the `input, stores => result` shape — and may transform it (e.g. wrap the
  iterable to inject its own progress ticks, filter chunks, tee for
  logging) since the iterable is a first-class value, not a special case.

### Per-projector interpretation

| Effect | HTTP | MCP | CLI |
|--------|------|-----|-----|
| progress | SSE comment or custom event | `notifications/progress` | stderr |
| chunk | chunked transfer / SSE data | partial content | JSONL line |
| return value | final response / close | final tool result | final output |
