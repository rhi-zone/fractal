> **Status: Partially superseded** — [`invariants.md`](./invariants.md) is the
> authoritative model, mined verbatim from the design conversation, and supersedes
> this doc wherever they conflict — specifically the authored-verb/placement
> framing, the two-tree split, and the verb-convention scheme are superseded.
> Everything not touched by `invariants.md` (the function-category core, one-
> directional transforms, producer model, package boundaries) remains current.

# Function core and projection — the converged architecture

## Status

**Canonical.** This is the spec the rewrite builds to. It supersedes the
`Handler<R>` / `req.ctx` / `.meta` model documented in
[`handler-model.md`](./handler-model.md) and the optic-pair direction in
[`optics-direction.md`](./optics-direction.md). Those docs are retained for
reasoning history and carry superseded banners pointing here.

Written for implementers and future sessions. Each section states the model and a
short rationale; TS sketches are illustrative, not final API. The routing-tree
**authoring syntax** — previously the one OPEN item — is now **resolved** (the
verified "Candidate D" syntax; see [Routing tree](#routing--an-explicit-protocol-neutral-tree)).
One sub-question remains deferred: the producer representation, entangled with open
tensions #1/#2.

---

## Thesis

fractal is a **generic typed-data transformation library**. Its first serious
application is an **HTTP framework**, which serves two roles at once:

- **Dogfood** — building a real HTTP framework on the generic core proves the core
  is actually general, not HTTP-shaped underneath.
- **Product** — the HTTP framework is meant to win on its own merits.

Twin, non-negotiable goals: **best-in-class DX / mental model** *and*
**best-in-class runtime performance**. The architecture below is chosen so these
do not trade off — the runtime is plain functions (fast, no interpreter), and the
type story is inferred (no per-route type-level accumulation, which is the Hono
`hc` / Elysia Eden scaling failure recorded in [`scale.md`](./scale.md)).

---

## Core = the function category

Everything is a plain function `A => B`. Composition is ordinary function
composition. This maximally-general base **is** the core.

```ts
type Fn<A, B> = (a: A) => B;
const compose =
  <A, B>(f: Fn<A, B>) =>
  <C>(g: Fn<B, C>): Fn<A, C> =>
  (a) => g(f(a));
```

**Kleisli composition** (thread a `Result` / short-circuit on error) and
**applicative composition** (run several producers and collect their outputs in
parallel) are **derived combinators built on top** — never the base.

```ts
// Derived: Kleisli arrow over Result. Built from compose + bind, not primitive.
const composeK =
  <A, B, E>(f: Fn<A, Result<B, E>>) =>
  <C>(g: Fn<B, Result<C, E>>): Fn<A, Result<C, E>> =>
  (a) => bind(f(a), g);
```

**Rationale.** Kleisli is strictly *less* general than `.`: `f >=> g = \a -> f a >>= g`
is derived from composition plus bind and *requires* a monad. Making Kleisli the
base forfeits composing plain (non-monadic) functions — which is most of what a
transformation library does. The general arrow is the floor; the error-threading
and parallel-collection arrows are conveniences sitting on it.

---

## Transforms are one-directional

A transform is a plain `A => B`. Validation/coercion that can fail returns
`Result<B, E>`. There are **no bidirectional view/review pairs**.

```ts
type Transform<A, B, E = never> = (a: A) => [E] extends [never] ? B : Result<B, E>;
```

**Rationale.** Bidirectionality forces invertibility, which kills arbitrary/lossy
transforms — and "arbitrary data => arbitrary data" is the whole point of a generic
transformation library. It also drags in the optic-kind lattice (lens ∘ prism =
affine, partial composition rules, a common `Optic` supertype) that
[`optics-direction.md`](./optics-direction.md) explored and this model rejects as
the core abstraction.

**"Encode" is not special.** Output serialization (`T => Response`) is just another
one-directional function, sitting in output position. An invertible codec reusable
in *both* positions is **optional sugar** — `iso(f, g)` is simply two independent
arrows bundled — never the core abstraction.

**Inputs are typed, not "raw."** Wire values carry their native types: path / query
/ header values are `string`; a body is `unknown`. A transform's `In` is the
source's native type. The pipeline is the **identity** unless it actually narrows
(coerces / validates). `unknown` is just the top type — there is no special "raw"
category that needs unwrapping.

---

## The operation (handler) = a pure typed function

The unit of application logic is a pure function from a flat named record of typed
domain values to a `Result`:

```ts
function markDone(options: {
  id: string;
  done: boolean;
  notify: boolean;
  user: User; // a capability — see Producers; the function can't tell it apart
}): Result<Todo, NotFound> { /* ... */ }
```

- `options` is a **flat** named record of typed **domain** values — `{ id, from, user }`,
  not `{ body, params, query }`.
- It is **provenance-free and protocol-blind**: the function never learns *where* a
  value came from (path / query / cookie / auth header / server-produced). No
  `body`/`source` wrappers, no `Request`, no transport in the signature.
- This is the in-process API. It is **directly callable** from tests, queues, other
  functions — no HTTP needed to exercise application logic.

**Rationale.** A flat typed record is the honest shape of "what this operation
needs." Protocol detail in the signature couples the logic to HTTP and makes it
untestable without a transport. Keeping the function provenance-blind is what lets
the same function back HTTP, CLI, a queue worker, and an in-process call.

---

## Producers fill the option fields

Each field of `options` is produced by a **producer**: a function that extracts and
coerces a typed value from the protocol input.

```ts
// In the http package — protocol-specific, NOT in the generic core.
const id: Producer<string>      = pathParam("id");
const notify: Producer<boolean> = query("notify", asBoolean);
const user: Producer<User>      = authBearer(verifyToken); // server-side
```

- Producers are **protocol-specific** and live in the **protocol package** (http),
  never in the generic core.
- A **capability** (authed user, db handle, request id) is just a field whose
  producer is a **server-side function**. The function consuming `options` cannot
  distinguish it from a wire-provided field — and must not need to.
- **Provenance** (wire-provided vs server-produced) is **metadata used only by
  projection**: server-produced fields are excluded from the generated client and
  the OpenAPI parameters. The function never sees provenance.
- Producers can **fail** (`=> Result`). A failed producer **short-circuits** the
  pipeline (e.g. a missing/invalid auth token → the operation never runs).

**Rationale.** "Where does this value come from" is a protocol concern, not an
application concern, so it lives in the protocol package and is attached per field.
Treating capabilities as ordinary fields with server-side producers is what removes
the special `provide`/`withAuth`/`req.ctx` machinery of the old model — there is
one mechanism (a producer), and auth is not a distinct concept.

---

## The endpoint is just a function

An endpoint is built by **composing functions** — there is **no `leaf` primitive**:

```
endpoint = buildOptions >>> handle >>> encode
```

- `buildOptions: In => Result<Options, E>` — itself a composable transform: a
  **record combinator** that runs each field's producer and collects the results
  (the applicative/parallel-collection combinator; a failed producer short-circuits).
- `handle: Options => Result<T, E>` — the pure typed function above.
- `encode: T => Response` — output serialization (see [Output](#output)).

All three are `A => Result<B>` arrows joined by composition, with the
Result-threading (Kleisli) combinator for the fallible parts. The input→options
step is **not** a special node — it is an ordinary transform built from the record
combinator over the producers.

**Rationale.** Collapsing the endpoint to "compose these arrows" keeps the model
fractal: the same composition law at every scale, no bespoke endpoint node to
special-case in every projection (the accretion that
[`optics-direction.md`](./optics-direction.md) diagnosed).

---

## Output

The handler returns `Result<T, E>`, where `T` is a **typed construct**, each with
its own encoder `T => Response`:

| `T` | Encoder target |
|---|---|
| a record | JSON |
| `Stream<X>` | SSE / chunked |
| `Bytes` | binary |
| `Redirect` | 3xx + `Location` |
| ... | each construct has one encoder |

```ts
// Final stage: Result<T, E> => Response
const finish = (r: Result<T, E>): Response =>
  match(r, { ok: encodeOk, err: encodeErr });
```

- **No raw `Response` escape hatch** inside the handler. The handler speaks typed
  constructs; turning them into a `Response` is the encoder's job.
- `E => Response` (error → status) is a **plain function the http package exports as
  an overridable default** (`encodeErr`). Apps override it; they don't hand-build
  `Response`s in leaves.
- The final stage `Result<T, E> => Response` is `match(encodeOk, encodeErr)`.

**Rationale.** A raw `Response` in the leaf is opaque to every projection — the
client and OpenAPI can't see its type. Typed constructs keep the response shape
*inferable*, which is what makes the generated client's return type real instead of
`unknown` (an honest gap in the old model, per `roadmap.md` §4).

---

## Source of truth = TS types (inferred) + JSDoc

The structure **is** the inferred types. There is no parallel reified description.

- **Value types + response type** come from the handler's **inferred** signature.
- **Constraints** (`@minLength`, `@format`, `@pattern`, `@min`/`@max`, ...) and
  **docs** (descriptions, `@example`, `@deprecated`) come from **JSDoc tags**.
- Codegen reads both via the **raw TypeScript compiler API** — walking `ts.Type` +
  JSDoc tags. (The internal consumer / dogfood target already proves this pattern in
  production.)

```ts
/**
 * Mark a todo done.
 * @param id   @format uuid
 * @param notify whether to send a notification
 */
function markDone(options: { id: string; done: boolean; notify: boolean }): Result<Todo, NotFound>
// → types give the shape; JSDoc gives `format: uuid` + descriptions.
```

- **No runtime reified meta tree. No `_def`. No `__schema` stamping.** Behaviour
  never leaves JS as data — projection happens at build time via the compiler API,
  not by interpreting a runtime descriptor.
- The `{ closure, metadata }` shape appears **only where a value genuinely needs a
  tag** (e.g. a producer recording its protocol location/provenance for projection;
  see [Open questions](#open-questions--unresolved-tensions)). The default is pure
  inference.

**Rationale.** A runtime meta tree (`.meta`, `_def`) is a second source of truth
that drifts from the types and must be kept in sync by hand or by a guard (the old
model needed an `AssertExact` drift guard precisely because it had two truths).
Reading the types directly removes the second truth and the guard with it.

---

## Projections (codegen outputs)

All projections are generated at **build time** from `types + JSDoc + structure`:

- **Validators** — runtime input validation derived from the inferred types +
  constraint tags.
- **OpenAPI document** — generated *from the types*, as an **output** projection
  (not, as in the old model, an intermediate the codegen reads back).
- **Typed client** — mirrors the function signature **exactly**:
  `client.markDone({ id, done, notify })` reads like calling the function in-process.

**Graceful degradation is mandatory.** Codegen must **not hard-throw** on an
unhandled type construct — it degrades to `unknown` and continues. (Hard-throwing on
unhandled constructs was a known failure mode of the prior-art emitter; the existing
`jsonSchemaToTs` in `packages/type-ir` already follows the never-throw discipline
and is salvageable as a projection helper, with its direction reversed: types → schema.)

**Rationale.** Build-time projection of concrete types is what keeps tsc cost ~linear
in route count (`scale.md`: concrete codegen is ~38× cheaper than the in-TS walk at
N=900). The exact-mirror client is the DX payoff — the client call site is
indistinguishable from the in-process call.

---

## Routing = an explicit, protocol-neutral tree

Routing is the **authored primitive**: an explicit, hierarchical, **protocol-neutral**
abstract tree. Leaves are the typed functions ([endpoints](#the-endpoint-is-just-a-function)).

The tree carries three things:

1. **Operation namespace / hierarchy** — the nesting of operations (e.g.
   `todos: { list, create, get, markDone }`).
2. **Parameterized levels** — "this level is indexed by an id." Protocol-neutral:
   rendered `/:id` in HTTP, a positional argument in CLI.
3. **Capability / grouping** — "this subtree needs a `user`."

It is **explicit** (not ops scattered across files, not pure decorator magic) and
**hierarchical** (its *shape* determines the path / subcommand structure).

**Rationale.** A single explicit tree is the one place shared prefixes and splits are
visible, and the one structure every protocol projects from. It is protocol-neutral
because the same hierarchy is meaningful as an HTTP path, a CLI subcommand chain, an
MCP tool namespace, or an in-process call path — only the *rendering* differs.

### Authoring syntax — RESOLVED (Candidate D)

The concrete authoring syntax is **resolved**. It is a **bare object-literal tree**
with **no per-level lambdas**, **un-annotated handlers**, and **producers flat at the
leaf**. It satisfies every constraint the spike was held to: nesting is routing
splits only; no colon path-DSL; one nested tree (not a flat list); object-literal
keys are literal segments. This is the verified "Candidate D" syntax — it compiled
clean under tsc 6.0.3 `--strict --exactOptionalPropertyTypes`.

#### The shape

```ts
app(
  path({
    classes: param("id",
      group("user", () => currentUser,
        methods({
          GET:  route({ query: { from: str() },
                  handler: ({ id, from, user }) => ok({ id, from, userId: user.id }) }),
          POST: route({ query: { from: str() }, body: obj<{ title: string }>(),
                  handler: ({ id, from, body, user }) => ok({ id, from, title: body.title }) }),
        }))),
    health: methods({ GET: route({ handler: () => ok("up") }) }),
  }),
);
```

The combinators and what each contributes to the tree:

- **`path({…})`** — literal-segment keys map segment name → child node. The
  routing-namespace split.
- **`param("id", child)`** — a **dynamic** segment split. Binds path-param `id`
  (typed `string`) into the context for the whole `child` subtree.
- **`group("key", produce, child)`** — a **capability** over a subtree. `produce`
  is a server-side function `(req) => V`; the capability `key: V` is added to the
  context for `child`. This is the only place auth / db-handle / request-id
  capabilities enter — as an ordinary context field.
- **`methods({…})`** — the **verb** split (`GET` / `POST` / …), each mapping to a
  child node.
- **`route({ query?, body?, handler })`** — the **leaf**. Producers are **flat in
  the def** (`query`, `body`), never nesting wrappers — no pyramid.

The handler receives a flat, fully-inferred `options` record =
**(ancestor path-params from every enclosing `param`)** &
**(capabilities from every enclosing `group`)** &
**(this leaf's producer fields from `query` / `body`)**. It is **provenance-blind**:
`{ id, from, user }` arrives as one flat record; the handler cannot tell a path-param
from a capability from a query field, and must not need to. This is exactly the pure
typed function of [The operation](#the-operation-handler--a-pure-typed-function).

#### Combinator type signatures

These compiled clean under tsc 6.0.3 `--strict --exactOptionalPropertyTypes`:

```ts
interface Node<C> { readonly __c?: C; readonly kind: string; }

function path<C>(routes: Record<string, Node<NoInfer<C>>>): Node<C>

function param<C, N extends string>(
  name: N,
  child: Node<NoInfer<C> & Record<N, string>>,
): Node<C>

function group<C, N extends string, V>(
  key: N,
  produce: (req: Request) => V,
  child: Node<NoInfer<C> & Record<N, V>>,
): Node<C>

function methods<C>(table: Partial<Record<Method, Node<NoInfer<C>>>>): Node<C>

function route<C, Q extends Record<string, Schema<unknown>> = {}, B = never>(def: {
  query?: Q;
  body?: Schema<B>;
  handler: (
    opts: Flatten<NoInfer<C> & QueryFields<Q> & ([B] extends [never] ? {} : { body: B })>,
  ) => Result<unknown, unknown>;
}): Node<C>

declare function app(root: Node<{}>): void;  // the root anchor
```

#### Implementation note — WHY it works (load-bearing)

This is the mechanism that makes the bare-tree, un-annotated-handler syntax infer
correctly, and it must be preserved precisely.

The naive expectation is that eager nested calls infer **bottom-up**: the innermost
`route` resolves first, and with nothing to pin the ancestor context `C`, each outer
call would collapse `C` to `unknown`. Two things fix this and make context flow
**top-down** instead:

1. **`NoInfer<C>` on every child / table / handler context position.** This blocks
   the compiler from *inferring* `C` bottom-up from a child node. With the only
   bottom-up inference site closed, the **contextual return type** of each call
   becomes the sole source of `C`.
2. **A single root anchor `app(root: Node<{}>)`.** This seeds `C = {}` at the
   outermost call. From there each call's `C` is **pinned by its parent's contextual
   return type** and flows top-down, **accumulating exactly one nesting level at a
   time** (`param` adds `Record<N, string>`, `group` adds `Record<N, V>`) down to
   each leaf.

Both mechanisms are **invisible to authors**: `NoInfer` lives inside the combinator
definitions, and the anchor is just the `app(…)` entry point. Authors write a bare
tree; the inference machinery is hidden.

**Verified by tsc 6.0.3:**

- The full tree compiles clean.
- Wrong-field probes flag **genuinely-inferred** fields (the handler `options` type
  is real, not `any`).
- A capability used **without** its enclosing `group` ancestor errors precisely —
  i.e. context **accumulation is exact**, not over-broad.
- **Removing the anchor** collapses the whole chain to `Node<unknown>` — confirming
  the anchor is what seeds the top-down flow.

#### Still deferred: the producer representation

One sub-question remains open: the **producer representation** —
**schema-style** (`{ from: str() }`, a schema value per field) vs **function-style**
(`{ from: qp("from") }`, an extractor function per field). This is entangled with
open tensions **#1 (provenance recovery)** and **#2 (runtime-tree vs
build-time-types seam)** below: how a producer records its protocol location /
provenance for projection depends on whether it is a schema or a closure-with-tag.
The example above uses **schema-style provisionally**; the choice is not yet
committed.

---

## Protocol projection

A protocol's concrete addressing is a **projection of (abstract tree + per-protocol
binding)**:

- **Path / subcommand structure + path-params** ← the abstract tree's hierarchy +
  parameterized levels. This is a **structural** projection: the tree's shape *is*
  the path.
- **Non-path field placement (query / header / cookie / body) + verb** ← the
  **per-protocol binding**: a convention *policy* (defaults, e.g. GET→query,
  POST→body, capability→auth header/cookie, path-param by tree position) plus
  **explicit overrides**.

```
HTTP addressing  =  project( abstractTree , httpBinding )
CLI addressing   =  project( abstractTree , cliBinding )
```

**The cookie / header / query / verb decisions are ALWAYS authored at the protocol
layer** — either as producer combinators (direct authoring) or as the binding's
policy/overrides (codegen path). They are **never inferred from the protocol-neutral
abstract tree alone.** Bespoke URL shapes (where the URL deliberately diverges from
the namespace hierarchy) are binding overrides.

**Rationale.** This is the resolution `optics-direction.md` reached the long way
around: the verb/location vocabulary is irreducibly HTTP-specific and must not leak
into the neutral tree. Keeping it in the binding means the neutral tree stays
projectable to non-HTTP surfaces, while HTTP keeps full control of its own
addressing.

---

## Three authoring levels

All three **desugar to the same explicit abstract tree** — none is a parallel
registry.

1. **Floor / primitive — the explicit abstract tree, hand-authored.** Plus *direct
   protocol-specific tree authoring* (producers carry location explicitly) for full
   HTTP control. This is the generality floor: anything the higher levels can express
   bottoms out here.
2. **Default (the internal consumer / dogfood target's path) — codegen from
   operations + a binding convention policy.** Consistent, zero-config: write the
   typed functions, let the convention policy assign verbs/locations.
3. **Optional, highest — a decorator / metadata / global layer** that implicitly
   assembles the explicit tree. **Must desugar to the same explicit tree** — never a
   second, parallel route registry.

**Rationale.** One desugaring target means every projection reads one structure,
regardless of how it was authored. The old model's accretion came from features that
each added their own node; here, sugar is sugar and the floor is fixed.

---

## Package boundaries

- **Generic core** — functions + composition + the derived combinators (Kleisli,
  applicative). Protocol-agnostic; knows nothing about HTTP. (`Result`/`match`/`bind`
  live here.)
- **http package** — a **library of plain functions**: producers (query / header /
  cookie / param / auth), encoders (`T => Response`), error renderers (`E => Response`),
  tree → dispatcher rendering, and the binding convention policy. CLI/MCP packages are
  analogous.
- **codegen** — reads typed source via the compiler API → projections (validators,
  OpenAPI, typed client).

**Rationale.** The core stays general by construction: if HTTP concepts can't be
imported into it, they can't leak in. The http package being *just functions* (not a
framework object) is what keeps producers composable and individually testable.

---

## Migration

**Retire** (rewrite the model layer — these are the old-model constructs that the
new model removes):

- The `Handler<R> = (req: Request & { ctx: R }) => Response | undefined` type and the
  `req.ctx` bag.
- `path` / `param` / `mount` / `methods` / `choice` as the routing model;
  `provide` / `withAuth`.
- `validated` / `returns` and the `__schema` stamping (`WithSchema`,
  `ValidatedHandler`, `ReturnsHandler` phantoms).
- The `Omit<Q, K>`-discharge trick, `CtxOf`, `MethodsIO`.
- The runtime `.meta` sidecar: `Reflected`, `withMeta`, and the `*Meta` shapes
  (`MethodsMeta` / `PathMeta` / `ParamMeta` / `ProvideMeta` / `ChoiceMeta`).
- `toOpenApi`-from-`.meta` as the OpenAPI *source* (OpenAPI returns as an *output*
  projection generated from types).
- The drift guard: `RouteUnion` / `RouteEntry` / `AssertExact` / `drift.ts` — there is
  no second truth to guard once types are the only source.

**Salvage** (read critically — these are infrastructure, not blessed model):

- The **WHATWG Request/Response adapter** — `packages/http-api-projector/src/adapter.ts`
  (`serveBun` / `serveNode`). Runtime-agnostic, model-independent.
- **`toFetch`'s correctness *behaviour*** — 404 / 405 + `Allow` (verb union across
  matching routes) / auto-HEAD-from-GET / OPTIONS 204+`Allow`. The *logic* is
  salvageable; it must be recomputed from the new routing tree (which now *is* the
  authored structure) instead of walking `.meta`.
- The **response builders** `json` / `text` / `binary` / `sse` / `status` /
  `notFound` — these become the per-construct **encoders**.
- The **compiler-API codegen patterns** (proven by the internal consumer) and the
  existing **`jsonSchemaToTs` graceful-degradation discipline** (never throw → degrade
  to `unknown`).
- The **Standard Schema** type mirror — optional, for validator interop.
- The **test infrastructure** and the `todo-api` / `dogfood` examples as fixtures.

**Discipline (per repo rules):** finish the migration before building on top.
Fence/mark as legacy whatever is not finished, so old patterns aren't read as
canonical and copied forward.

---

## Open questions / unresolved tensions

The routing-tree authoring syntax is now resolved (see
[Authoring syntax — RESOLVED (Candidate D)](#authoring-syntax--resolved-candidate-d));
its one remaining sub-question — the producer representation — is entangled with
tensions #1/#2 below. The unresolved tensions are:

1. **How does build-time codegen recover provenance?** Provenance (wire-provided vs
   server-produced) is declared to be projection-only metadata. But projection is the
   compiler-API walk, and a producer is a plain function — its provenance is not in
   the *type* of the value it yields. So the walk must recover provenance *structurally*:
   from which producer combinator was used at the leaf, or from a tag on the producer
   (`{ closure, metadata }`). This is the one place the "mostly pure inference, tag only
   where needed" principle bites — the producer location/provenance almost certainly
   *is* a value that needs a tag. The spike should settle whether the routing tree (a
   runtime value) records per-field location, or whether the compiler-API walk reads it
   off the producer's declared type. (This intersects the next point.)

2. **The routing tree is runtime data; the type meta is not — keep them cleanly
   split.** The tree *must* exist at runtime to dispatch requests (segment names,
   param levels, capability grouping, leaf functions). But per-leaf *types and
   constraints* are explicitly **not** runtime data (inferred + JSDoc, read at build).
   Implementers must not let schemas creep back onto the runtime tree — that would
   reintroduce the `.meta` second-truth this model retires. The tree carries
   *structure + functions*; the compiler API carries *types + constraints*. The seam
   between "what the runtime tree records" and "what the compiler-API walk reads" needs
   to be drawn precisely in the spike (and is entangled with provenance, point 1).

3. **Streaming returns in the typed client.** `Stream<X>` projects cleanly to SSE on
   the HTTP wire, but the exact-mirror typed client and the in-process call must agree
   on how a streaming return is represented (an async iterable? a callback?). Minor, but
   the "client mirrors the signature exactly" promise needs a concrete answer for
   non-record `T`.

4. **OpenAPI: output vs intermediate.** This doc relocates OpenAPI from *intermediate*
   (old: `.meta` → OpenAPI → codegen reads it back) to *output* (new: types → OpenAPI,
   and types → client directly, in parallel). Confirm during the rewrite that nothing
   in the codegen pipeline still treats the OpenAPI doc as the client's *input* — the
   client should be generated from types, not from the doc, or the relocation is
   incomplete.
