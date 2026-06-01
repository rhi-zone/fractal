# Design direction: compositional optics for the node algebra

## Status

Exploratory design direction — not yet implemented. Captures a design conversation about the primitive set and composition model. Supersedes the ad-hoc accretion of per-feature node types (`branch`, then `methods`, then anticipated `param`/`query`). HEAD at time of writing is the `methods` combinator commit; this record argues that combinator should ultimately desugar to a general dispatch primitive, not stand as a bespoke node type.

---

## Problem

fractal had been growing one REST-ism at a time: `branch` (path dispatch), `methods` (verb dispatch), and anticipated `param`/`query` — each as a new node type or annotation. That is accretion, not design.

Three concrete smells:

1. The `methods` node carries a `defaultVerb` fallback because HTTP method is meaningless on worker/stdio/in-process transports — an HTTP concept leaking into a transport-agnostic tree.
2. `branch` and `methods` are structurally identical (a `Record<string, AnyNode>` plus a selector over the request) yet are separate node kinds with separate handling in every interpreter (evaluate, dispatcher, client, OpenAPI).
3. The IR has rich input/dispatch structure but no principled home for response metadata (status/headers).

---

## Evaluation frame (five spaces)

A combinator's true effect is a tuple, one component per space:

| Space | Question |
|---|---|
| **Type** | Its function on the phantom I/O/E/Caps params |
| **State** | Its transition on a request-in-flight |
| **Representation** | The inert node it emits — must stay walkable data, since projection depends on it |
| **Projection** | What each interpreter (HTTP server, typed client, OpenAPI, test harness) renders — a vector with one component per surface |
| **Mental model** | What the author believes they are doing |

A combinator is **coherent** if and only if all five components are images of one intended meaning. `methods` is incoherent: it means "verb dispatch" to HTTP, "always POST" to a worker, and "per-verb fan-out" to OpenAPI — one promise, three disagreeing images.

---

## Three semantic categories (orthogonal in state space)

The in-flight state is `(position in tree, residual request [path, method, query, …], current input value, accumulated context/caps, error possibilities)`. Each family touches a different component:

- **NAVIGATE (dispatch)** — reduces the residual request.
- **COMPUTE (leaf / seq)** — reduces the input value. `seq` is the only type-changing combinator — the Kleisli arrow. Do not collapse it into dispatch.
- **ATTRIBUTE (annotate)** — decorates context or gates.

Response-shaping (status/headers) is **not** a fourth category. It is attribution that a projection reads — an annotation kind the HTTP binding interprets, never a node in the routing tree.

---

## Candidate minimal basis (4 primitives, down from 6)

| Primitive | Category | Notes |
|---|---|---|
| `leaf` | COMPUTE | Stream is the general case; unary = stream-of-one |
| `seq` | COMPUTE | The unique type-changer; the Kleisli arrow |
| `dispatch` | NAVIGATE | Match-and-bind a named request facet to a subtree — subsumes `branch`/`methods`/`param`/`query` as facet-descriptor configurations; open-capture vs closed-enum |
| `annotate` | ATTRIBUTE | Open metadata/effect/binding channel: capabilities gated, schema inert, HTTP-binding inert |

The floor is bounded by **reflectability**: primitives must stay inert, walkable data so projections derive from them. The only sanctioned opaque code is the leaf handler.

---

## The optics pivot

The three-way categorisation is the optics algebra:

- `seq` = optic composition
- `branch` / `methods` / `param` = lens / prism / indexed-optic (focus a product field / match a sum case / capture an index)
- `leaf` = the arrow at the focus
- interpreters = profunctor instances

The bidirectional payoff: a `Prism` is `{ view: match, review: build }`, which is exactly server-side dispatch (match; a miss = 404/405) **and** client-side construction (build) from the same definition. "Build a server and a client that agree" becomes a theorem, not a discipline.

### Critical encoding decision

Do **not** use the profunctor or van Laarhoven function encodings. TypeScript inference is brittle under polymorphic-function encodings, and a profunctor optic is a polymorphic function — the opposite of inert reflectable data.

Use the **concrete first-order struct encoding**, optionally tagged. Prior art: the sibling repo `@rhi-zone/rainbow` (published) already uses concrete struct optics — `Lens = { view, review }`, `Prism = { view: A -> B | undefined, review: B -> A }`, `Traversal = { getAll, modify }` — and achieves clean end-to-end TypeScript inference with no annotation burden.

Reuse rainbow's **vocabulary and encoding lesson**, not its code (ecosystem throughline T4: independent tools, shared pattern, no shared codebase; also rainbow's optics are reactivity-coupled and semantically opaque).

fractal's delta over rainbow:

- **Tagged optics + metadata-aware composition.** Rainbow's `compose*` builds fresh closures and would drop tags; composition must combine descriptors — a writer/monoid over the descriptor, where composite path = `parent.key ++ child.key`.
- **The transport/projection layer.** Rainbow has none; its "router" is a client-side SPA router.

Note: `Lens` and `Prism` share a common supertype in rainbow (`Optic = { view: A -> B | undefined, review }`), so cross-kind lens/prism composition yields an affine optic naturally. Only `Traversal` sits outside, and routing never needs `Traversal` at request time — it appears only when a projection walks all routes.

---

## Sibling repo: server-less — same thesis, different mechanism

`@rhi-zone/server-less` (Rust, crates.io v0.4.9) is the same "project one definition to many surfaces" thesis, shipped: annotate a Rust impl block, get HTTP/CLI/WS/MCP/JSON-RPC/GraphQL/gRPC plus OpenAPI and IDLs.

### Transfer 1 — param-location decomposition

server-less does not model routing as a dispatch tree. An endpoint is a function whose parameters carry a `ParamLocation` descriptor (`Query`, `Path`, `Body`, `Header`). The HTTP verb is a naming convention (`create_* → POST`) with override; the route string is derived; response status is a separate `ErrorCode → status` mapping.

fractal should adopt this decomposition, realised as **composable extractor-optics**: one optic per parameter, focusing the request to that argument; the location descriptor lives on the optic.

### Transfer 2 — response shaping is a projection concern

server-less keeps status/headers out of the route structure entirely (ErrorCode mapping). This validates the principle stated above: response metadata is attribution a projection reads, not a node.

### Rejection — the mechanism

server-less works via invisible compile-time proc-macro codegen reading a flat signature's AST. TypeScript has no equivalent: types are erased, there is no signature introspection, and fractal is a runtime inert-data library, not a codegen tool.

The same decomposition must therefore be reached the opposite way: by **explicit value-level composition of extractor-optics**. server-less hides the structure; fractal **is** the structure.

Also: server-less has two composition mechanisms (method-level within an impl; mount-traits to nest services) — a self-similarity break fractal must avoid.

The ecosystem already splits client generation out to `@rhi-zone/normalize` (OpenAPI → TS/Python/Rust stubs). fractal's distinctive bet vs the server-less + normalize pipeline: **one runtime inert value interpreted directly to both client and server, no OpenAPI round-trip, plus runtime reflectability**.

---

## The name as a design law

"Fractal" = self-similar under composition: the same shape at every scale, one composition law `optic ∘ optic = optic`, whether the optic extracts a field, validates a body, dispatches a path segment, or mounts an entire sub-API.

This is the **falsifiable test** for any proposed primitive: if it needs a second composition mechanism to scale up (as server-less's mount-traits do, and as bespoke dispatch nodes did), it is not fractal.

Surface sugar (`methods({ … })`, `branch({ … })`) is fine **provided** it desugars to the one facet-dispatch optic — sugar at the surface, one primitive underneath.

---

## Protocol agnosticism: tree × binding

"Protocol agnosticism" is two distinct things:

- **Transport-agnostic handlers** — easy.
- **Protocol-neutral description** — the tension. Pure neutrality forbids saying "this is a GET" and collapses HTTP to all-POST; embedding `method` pollutes the tree for stdio/worker.

Resolution: `method` is **not** a primitive. The primitive is dispatch-on-a-named-abstract-facet; each protocol **binds** the abstract facet to its concrete wire feature. The tree says `dispatch on facet "verb"`; the HTTP binding says `facet "verb" ← req.method` (and bidirectionally, the client sets `req.method ← verb`); a worker binding leaves it unbound. `projection = interpret(tree, binding)`.

### Decisions

- Preserve agnosticism in the **description**, not in handlers or bindings. No HTTP concept is ever a node or a hardcoded field; they enter only via bindings (dispatch/extraction) or projection-scoped annotations (hints such as status/content-type — e.g. the existing `kind: 'http'` annotation, inert to all other interpreters).
- A route must be meaningful at the thinnest transport (input → output over a path); every richer facet (verb, headers, status, streaming) is an additive refinement that rich transports exploit and thin ones ignore via a **binding-declared default**. (This is the principled version of `methods()`'s `defaultVerb` — the default is data on the binding, not baked into interpreters.)
- Three tiers for adding protocol-specific logic, each localising non-agnosticism: (1) abstract facet + binding (preferred); (2) projection-scoped annotation kind that only one binding reads; (3) explicit protocol-scoped subtree ("this branch only under HTTP").
- Bindings are **bidirectional, composable, first-class data** — not codegen — which is why this works for both server-side match and client-side build from one definition.

### Pragmatic scope

Reserve the facet/binding seam now (so `method` is never a node), but ship with only the HTTP binding implemented. WS/stdio bindings do not need to be built to get the architecture right — only the tree must not hardcode HTTP.

---

## Open questions / next step

A concrete spike: express one `todo` endpoint as tagged concrete extractor-optics and verify three things:

1. End-to-end TypeScript inference holds (as it does in rainbow).
2. A tagged optic walks to an OpenAPI fragment from its descriptor.
3. Mixed-kind (prism ∘ lens) composition works via the common `Optic` supertype.

One endpoint answers all three.

**Strategic fork to settle when fresh:** is fractal "server-less-for-TypeScript" (adopt the param-location decomposition, less novel) or the runtime-inert + direct-client-and-server + optics-composition bet (the differentiator)? This record assumes the latter.
