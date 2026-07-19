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
