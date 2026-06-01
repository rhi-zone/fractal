# Design direction: compositional optics for the node algebra

## Status

Exploratory design direction — not yet implemented. Captures a design conversation about the primitive set and composition model. Supersedes the ad-hoc accretion of per-feature node types (`branch`, then `methods`, then anticipated `param`/`query`). HEAD at time of writing is the `methods` combinator commit; this record argues that combinator should ultimately dissolve entirely — it has no correct desugaring into the agnostic dispatch primitive because verb-dispatch is not a tree-level concept. See the "Protocol agnosticism" section for the full correction.

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
| `dispatch` | NAVIGATE | Match-and-bind a named request facet to a subtree — subsumes `branch`/`param`/`query` as facet-descriptor configurations; open-capture vs closed-enum. Facets are structural (path segment, query key, header key, operation name); verb is explicitly excluded — it is HTTP-binding rendering, not a tree-level dispatch facet (supersedes the earlier "dispatch on facet verb" framing). `methods` is therefore not a facet configuration; it dissolves entirely. |
| `annotate` | ATTRIBUTE | Open metadata/effect/binding channel: capabilities gated, schema inert, HTTP-binding inert |

The floor is bounded by **reflectability**: primitives must stay inert, walkable data so projections derive from them. The only sanctioned opaque code is the leaf handler.

---

## The optics pivot

The three-way categorisation is the optics algebra:

- `seq` = optic composition
- `branch` / `param` = lens / prism / indexed-optic (focus a product field / match a sum case / capture an index). `methods` does not map here — it dissolves rather than desugars, because verb-dispatch is not a tree-level primitive (supersedes the earlier "dispatch on facet verb" framing).
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

Surface sugar (`branch({ … })`) is fine **provided** it desugars to the one name-dispatch optic — sugar at the surface, one primitive underneath. `methods({ … })` does not get this reprieve: because verb-dispatch is not a tree-level concept (it is binding-side rendering), `methods` has no correct desugaring into the agnostic primitive and dissolves rather than desugars.

---

## Protocol agnosticism: tree × binding

"Protocol agnosticism" is two distinct things:

- **Transport-agnostic handlers** — easy.
- **Protocol-neutral description** — the tension. Pure neutrality forbids saying "this is a GET" and collapses HTTP to all-POST; embedding `method` pollutes the tree for stdio/worker.

Resolution: `method` is **not** a primitive, and neither is verb-dispatch. The earlier framing in this record — "the primitive is dispatch-on-a-named-abstract-facet; the tree says `dispatch on facet 'verb'`; the HTTP binding maps `facet 'verb' ← req.method`" — relocates *where* the verb is read from but leaves the verb vocabulary (GET/PUT/POST/DELETE/HEAD/OPTIONS) sitting in the dispatch keys. Branching on `{ GET: …, POST: … }` is still HTTP-specific. That framing is superseded (supersedes the earlier "dispatch on facet verb" framing).

**Corrected resolution:** dispatch on operation **names**; the HTTP verb is binding-side rendering, never a tree key. The GET/PUT/POST/DELETE/HEAD/OPTIONS enumeration is irreducibly HTTP-specific and must not appear as dispatch keys in the agnostic tree.

The agnostic tree has **named operations** — e.g. `todos: { list, create, remove }`. A name is meaningful on every protocol: CLI subcommand, MCP tool, RPC method, GraphQL field, in-process call. What looks like fundamental "branch by method" in REST (GET /todos = list vs POST /todos = create at one path) is actually two distinct named operations that the HTTP binding *collapses* onto one path, disambiguated by verb. Verb-branching is an HTTP **rendering** of name-branching, produced by the binding — not a primitive in the tree. This is precisely why the `methods` node was accretion: it smuggled a binding-level rendering into the IR.

The verb enumeration lives in exactly one place: the HTTP binding's name→verb mapping table. It appears in no other projection. GraphQL independently corroborates the generalisation: query/mutation/subscription is the same read/write/stream distinction at a coarser grain; HTTP verbs are a finer read/write taxonomy. Both are renderings of named operations, neither is primitive.

Projection table — same named tree, every surface:

| Surface | list | create |
|---|---|---|
| HTTP | GET /todos | POST /todos |
| Typed client | `client.todos.list()` | `client.todos.create(x)` |
| CLI | `app todos list` | `app todos create --title` |
| MCP | tool `todos_list` | tool `todos_create` |
| GraphQL | query | mutation |
| Worker/stdio | call by name | call by name |

The verb vocabulary appears only in the HTTP column. Consequently, **`methods` dissolves completely** — there is no verb-dispatch node and no `method()` primitive. The tree needs only name-dispatch (branch over keys) plus `leaf` and the semantic tag described below as metadata; the HTTP binding performs verb rendering and same-path collapsing.

### Verb inference sugar

The HTTP binding needs a signal to choose GET vs POST. Two forms, both optional:

1. **Naming convention** (server-less style): `list_* → GET`, `create_* → POST`, `remove_* → DELETE`, etc.
2. **Protocol-neutral semantic tag** on the operation: `read | create | replace | update | remove | stream` (with optional `idempotent` / `safe` modifiers). The tag describes effect, not HTTP. Each binding maps it independently: HTTP `read → GET`, `create → POST`, `remove → DELETE`; GraphQL `read → query`, `stream → subscription`, else `mutation`; worker/MCP ignore it.

HEAD and OPTIONS are not author concerns — the HTTP binding auto-derives them (HEAD from GET, OPTIONS from the allow-set). The author-facing operation vocabulary therefore shrinks to the semantic core.

### Escape hatch

For genuine HTTP-specificity (custom verbs, PROPFIND, deliberately-weird mappings): a per-operation annotation `http({ method, path })` read **only** by the HTTP binding, inert elsewhere. This is the tier-2 projection-scoped annotation already described below. Localised, honest non-agnosticism.

### Decisions

- Preserve agnosticism in the **description**, not in handlers or bindings. No HTTP concept is ever a node or a hardcoded field; they enter only via bindings (dispatch/extraction) or projection-scoped annotations (hints such as status/content-type — e.g. the existing `kind: 'http'` annotation, inert to all other interpreters).
- Dispatch in the tree is **name-dispatch only**. Verb-dispatch is not a tree primitive; it is a derived rendering in the HTTP binding.
- A route must be meaningful at the thinnest transport (input → output over a path); every richer facet (verb, headers, status, streaming) is an additive refinement that rich transports exploit and thin ones ignore. (This is the principled resolution of `methods()`'s `defaultVerb` — instead of a fallback baked into the node, the tree carries no verb at all; the binding renders it.)
- Three tiers for adding protocol-specific logic, each localising non-agnosticism: (1) named operations + semantic tag, binding renders to protocol-specific vocabulary (preferred); (2) projection-scoped annotation kind that only one binding reads; (3) explicit protocol-scoped subtree ("this branch only under HTTP").
- Bindings are **bidirectional, composable, first-class data** — not codegen — which is why this works for both server-side match and client-side build from one definition.

### Pragmatic scope

Reserve the name-dispatch / binding-renders-verb seam now (so neither `method` nor HTTP verb keys are ever nodes), but ship with only the HTTP binding implemented. WS/stdio bindings do not need to be built to get the architecture right — only the tree must not hardcode HTTP.

---

## Open questions / next step

A concrete spike: express one `todo` endpoint as tagged concrete extractor-optics and verify three things:

1. End-to-end TypeScript inference holds (as it does in rainbow).
2. A tagged optic walks to an OpenAPI fragment from its descriptor.
3. Mixed-kind (prism ∘ lens) composition works via the common `Optic` supertype.

One endpoint answers all three.

**Strategic fork to settle when fresh:** is fractal "server-less-for-TypeScript" (adopt the param-location decomposition, less novel) or the runtime-inert + direct-client-and-server + optics-composition bet (the differentiator)? This record assumes the latter.

**Facet descriptor scope (settled):** the `dispatch` primitive's facet descriptor covers structural request facets — path-segment capture, query-key capture, header-key capture, and operation-name selection. Verb is **explicitly excluded** from tree-level facet dispatch; it is handled entirely by the HTTP binding's name→verb rendering table and is invisible to every other projection.
