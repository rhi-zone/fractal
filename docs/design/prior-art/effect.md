# Effect-TS — Modeling Primitives

Prior-art notes on the Layer/Service pattern, context propagation, middleware, and
multi-transport composition in the Effect ecosystem.

## Service Identity and Context

A **Service** is a type-level slot declared via `Context.Tag`. The tag carries both a
unique string identifier (stable across bundling/reload) and a phantom type parameter
encoding the service interface. When code yields a tag inside an Effect, the tag's type
propagates into the `R` (requirements) position of `Effect<A, E, R>`. The compiler
refuses to run an Effect whose `R` is not empty — provision must eliminate every
requirement before execution.

Context itself is a heterogeneous map keyed by tags; `Effect.provideService` inserts a
concrete implementation, narrowing `R`.

## Layer Composition

`Layer<ROut, E, RIn>` separates *what a layer produces* from *what it needs* and *how it
can fail*. Composition operators:

| Operator | Semantics |
|----------|-----------|
| `Layer.merge(a, b)` | Concurrent construction; output is `ROut_a \| ROut_b`, input is `RIn_a \| RIn_b`. |
| `Layer.provide(downstream, upstream)` | Sequential wiring; upstream's `ROut` satisfies part of downstream's `RIn`. Result's `RIn` is the leftover. |
| `Layer.effect` / `Layer.scoped` | Lift an Effect (optionally with finalization) into a Layer producing a single service. |

Union-type deduplication handles diamond dependencies: if two layers both require `Config`,
the union `Config | Logger | Config` collapses to `Config | Logger`, and the runtime
instantiates each service exactly once — memoized for the lifetime of the scope that built
the layer.

The final application layer is typically assembled by merging domain layers and then
providing infrastructure layers underneath, yielding `Layer<AppServices, E, never>` — a
fully-closed dependency graph that can boot without external input.

## Context Flow Through a Computation

An `Effect<A, E, R>` is a lazily-evaluated program description. When composed via
`flatMap`/`gen`, the `R` parameters union — each step may add requirements. Provision
(via `Effect.provide` with a Layer or direct service) subtracts from `R`. The runtime
propagates a `Context` value through the fiber, threading it implicitly (no explicit
parameter passing).

Scoped resources (`Scope` in `R`) attach finalizers to the current scope; layers manage
their own scopes, so resource lifetimes align with service lifetimes automatically.

## Middleware / Cross-Cutting Concerns

Effect models middleware as Layer transformations or as `HttpMiddleware` — a function
`HttpApp<E, R> -> HttpApp<E1, R1>` that wraps the handler while potentially adding or
removing type-level requirements.

At the HttpApi level, middleware attaches to the API or to individual groups via a
`middlewares: ReadonlySet<HttpApiMiddleware.TagClassAny>`. Each middleware tag is itself a
service whose Layer must be provided — the type system enforces that all declared
middleware is wired before the server can start.

This gives cross-cutting concerns (auth, logging, tracing) the same compositional
treatment as any other service: declare a tag, implement a layer, provide it.

## HTTP Routing and Multi-Transport (@effect/platform, @effect/rpc)

**HttpApi / HttpApiGroup / HttpApiBuilder** — declarative HTTP:
- `HttpApi` declares endpoint groups, each carrying typed request/response schemas and
  middleware sets.
- `HttpApiBuilder.serve()` produces an `HttpApp` (Effect from request to response) whose
  type tracks which groups have been implemented and which middleware is satisfied.
- Unimplemented groups surface as type errors — the server cannot compile until every
  declared endpoint has a handler layer.

**@effect/rpc** — transport-agnostic RPC:
- `Rpc.make` defines a procedure via `Schema` for payload, success, and error.
- `RpcGroup` collects procedures into a named group.
- Server handlers are built per-transport: `layerProtocolHttp`, `layerProtocolWebsocket`,
  `layerProtocolSocketServer` each produce a Layer that serves the same RpcGroup over a
  different wire format.
- Client is derived from the shared group definition (`RpcClient.make`), fully type-safe —
  transport choice is a Layer swap, not a code change.

The multi-transport model: define the contract once (RpcGroup + schemas), implement
handlers once (as Effects with requirements), then provide different transport layers at
the edge. The handler code never references HTTP or WebSocket directly.

## Summary of Modeling Primitives

1. **Tag** — type-level identity for a service slot.
2. **`Effect<A, E, R>`** — lazy computation tracking success, failure, and requirements.
3. **`Layer<ROut, E, RIn>`** — constructor for services, composable via merge/provide.
4. **Scope** — resource lifetime, wired automatically through layers.
5. **Schema** — runtime codec that also serves as the type-level contract for RPC/HTTP.

The unifying idea: everything is an Effect with typed requirements; composition is
requirement-union; provision is requirement-subtraction; the program compiles only when
all requirements reach `never`.
