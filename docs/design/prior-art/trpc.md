# tRPC — Modeling Primitives and Composition Patterns

Prior-art survey for Fractal's HTTP layer design.

## 1. Router / Procedure Definition

Routers are plain objects mapping string keys to procedures or nested routers:

```ts
type CreateRouterOptions = {
  [key: string]: AnyProcedure | AnyRouter | CreateRouterOptions | Lazy<AnyRouter>;
};
```

`createRouterFactory` flattens this into a `RouterDef` containing a flat `record` of
procedures. Reserved keys (`then`, `call`, `apply`) are rejected to avoid proxy
collisions. Routers compose via `mergeRouters(...routers)` which unions their records.
Lazy routers (`lazy(() => import(...))`) enable code-splitting.

## 2. Middleware (.use())

Each `.use(fn)` call returns a new builder with accumulated context overrides:

```ts
use<$CtxOut>(fn): ProcedureBuilder<
  TContext, TMeta,
  Overwrite<TContextOverrides, $CtxOut>,  // layered merge
  TInputIn, TInputOut, TOutputIn, TOutputOut, TCaller
>
```

Middleware receives `{ ctx, input, signal, path, next }`. Calling `next()` with optional
`{ ctx, input }` overrides merges them shallowly into downstream context. Middlewares
execute recursively (`callRecursive`); the final call invokes the resolver.

## 3. Input Validation

`.input(parser)` accepts any Zod-like object with `.parse()` / `.parseAsync()`. Multiple
`.input()` calls intersect their schemas (both `TInputIn` and `TInputOut` are
intersection-accumulated). Parsers are stored as `inputs: Parser[]` in the procedure def
and run sequentially at call time.

## 4. Multiple Transports

A single router definition serves all transports via **adapters**. Each adapter
(`node-http`, `ws`, `fetch`, `aws-lambda`, etc.) implements the same contract:

1. Extract path + input from the transport envelope.
2. Call a shared `resolveResponse()` / `callProcedure()` with the router, path, and input.
3. Serialize the result back into the transport envelope.

The procedure itself is transport-agnostic — a callable `(opts: ProcedureCallOptions) =>
Promise<output>`. Adapters differ only in how they build `createContext` and
marshal request/response.

## 5. Context

Context is built per-request by a user-supplied `createContext` function that receives
the raw transport objects (req/res for HTTP, connection info for WS). The adapter calls
it once, threads the result as `ctx` into middleware and resolver. Middleware enriches
context via `Overwrite<>` layering — each middleware's return merges atop the prior ctx.

## 6. Inspectability

The router's `_def.record` is a flat `Record<string, AnyProcedure>` — every procedure is
enumerable by key. Each procedure's `_def` exposes:

- `type`: `'query' | 'mutation' | 'subscription'`
- `inputs: Parser[]`: the registered input schemas (Zod objects are introspectable)
- `meta`: user-defined metadata (e.g. OpenAPI operation info)
- `$types`: compile-time input/output type brands

`trpc-openapi` and similar tools walk `_def.record`, read each procedure's `type`,
`inputs`, and `meta` to generate OpenAPI specs or typed SDK clients.

## Key Takeaways for Fractal

| Aspect | tRPC pattern | Observation |
|--------|-------------|-------------|
| Composition | Builder chain producing immutable defs | Clean but deeply generic — type params accumulate |
| Context | Middleware-layered `Overwrite<>` | Simple; no DI container, just object merge |
| Transport split | Adapter calls procedure as a function | Procedure is pure; transport is plumbing |
| Introspection | Flat record + `_def` metadata | Works because procedures are data, not just functions |
| Input | Intersected parser array | Enables base-procedure + refinement patterns |
