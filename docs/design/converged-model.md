# Converged operation/projection model (session 2026-06/07)

> **SUPERSEDED (node shape + dispatch only):** The node shape (`{ops, children, meta}`) and
> dispatch model described here are superseded by [`router-model.md`](router-model.md).
> The tags/metadata sub-bag design and projection principles below still hold.

> Most of the originating session was exploratory thrash; the durable result is
> small. Evidence trail: `docs/archive/fc-api-grouping/` and
> `docs/archive/fc-op-kinds/`. Provenance tags: **[CERTIFIED]** = user stated or
> explicitly affirmed; **[SYNTHESIS]** = assistant's synthesis, plausible but not
> user-ratified; **[OPEN]** = genuinely unresolved.

---

## The model

- **[CERTIFIED]** An operation is just a function `T => U` (+ composition as the
  base). Not a bidirectional view/review, not Kleisli-as-base.

- **[CERTIFIED]** Truth = inferred TS types + JSDoc (constraints AND descriptions).
  No reified runtime schema/metadata tree as a second source for the DATA.

- **[CERTIFIED]** One tree. Grouping and addressing are the SAME tree (a
  location-blind function's only organizational home is its position in the tree).
  Two trees = two conflicting mental models = no mental model. "You don't need to
  know where it is to know what it does" — behavior carries no address.

- **[CERTIFIED]** Grouping is recursive/hierarchical. Subject-type is the bottom
  rung, not the whole answer; the top level must stay small (a flat set of ~150
  subjects is just relocated sprawl). "ideally at least."

- **[CERTIFIED]** No deterministic program can divine taste; a definition has finite
  Shannon entropy. So: unaided projection for the obvious, first-class overrides for
  irreducible taste. Total/objective projection is wrong; but LOSING
  unaided-projection-for-the-obvious is a dealbreaker.

- **[CERTIFIED]** The operation-characterization is ARBITRARY METADATA. An op is a
  function carrying an open metadata bag; each protocol PROJECTION reads the keys it
  recognizes and ignores the rest. Metadata is ONLY for non-type-expressible
  projection/taste concerns (verb, idempotency, cache, auth), never a second source
  for domain data — types+JSDoc remain that. Boundary: metadata = only the
  non-type-expressible projection/taste bits.

- **[CERTIFIED]** There is no "operation kind"/verb taxonomy to design. Verbs are one
  lossy HTTP projection, downstream, not the agnostic object. The
  read→GET/replace→PUT/remove→DELETE/partial→PATCH table was assistant-invented and
  is REJECTED.

- **[CERTIFIED]** POST = a method call/invocation; create/new is NOT POST-by-being-
  creation.

- **[CERTIFIED]** Inference (e.g. verb/path from a name) is a fine but OVERRIDEABLE
  default — never authoritative. You don't rely on it being right; you rely on being
  able to override it.

- **[CERTIFIED]** Support BOTH authoring surfaces: standalone functions AND
  methods-on-a-service. Both lower to one primitive.

- **[CERTIFIED]** `server-less` (`/home/me/git/rhizone/server-less`) is the most
  direct prior art; it already implements this model.

- **[SYNTHESIS]** The one node primitive both surfaces lower to: a node =
  `{ operations (functions ± a receiver = subject param), child nodes, metadata }`.
  A method's `self` is just its subject parameter. A node's ops can be populated by
  an impl/service, a module, a list of functions, or a nested record — all producing
  the identical node.

- **[SYNTHESIS]** Three concerns kept separate: structure/addressing (the tree) vs
  per-op projection metadata (the open bag) vs data truth (the function signatures +
  JSDoc). `server-less` keeps these mostly separate; its one leak is name-driven
  inference coupling data-naming to the HTTP surface.

- **[SYNTHESIS]** JS mechanism for the metadata bag: a plain object
  (`{ http: {...}, cli: {...} }`) — inherently open, works on both standalone
  functions and records. TC39 decorators are class-member-only, so they're optional
  sugar for the method surface, not the foundation. A projection is a pure function
  `(op-tree + metadata + types) => surface`; build-time vs runtime is an operational
  choice, not a model fork (only reading erased TS types is build-time-bound, handled
  by codegen lowering types→data).

- **[SYNTHESIS]** fractal ≈ `server-less`'s model in JS, with genuine deltas: (1) ops
  can be standalone functions, not only `&self` methods in an impl block; (2)
  metadata bag fully open including cross-cutting keys (`server-less` centrally
  whitelists its shared param/route/response attrs). Name-inference and
  proc-macros-vs-codegen are NOT real deltas.

---

> **STALE (2026-07-10):** The AS-BUILT section below describes the state at the time of the
> converged-model session. The node shape (`{ops, children, meta}` / `Op<I,O>` / `ParamNode`)
> and dispatch model have since been superseded by [`router-model.md`](router-model.md)
> (`{handler?, children?, meta}`, attribute-dispatch). The tags/metadata principles remain
> valid; the concrete code descriptions do not reflect current state.

## AS-BUILT (implemented this session)

**[BUILT]** Workspaces (5 active): `@rhi-zone/fractal-api-tree`, `-http`, `-mcp`,
`-codegen`, `examples/library-api`. (`packages/openapi-api-projector` and `packages/client-api-projector`
exist but are fenced out of the workspace pending migration to the new model —
see `package.json` comment.) 130 tests pass across the 5 active workspaces,
0 fail; typecheck clean.

**[BUILT] `@rhi-zone/fractal-api-tree` (`packages/api-tree`):**
- `node.ts` — types: `Meta` (open bag, `tags?` sub-bag), `Op<I,O>` (`fn` +
  `meta`), `ParamNode` (`_tag:"param"`, `name`, `subtree`), `ChildEntry = Node |
  ParamNode`, `Node` (`ops`, `children`, `meta`). Constructors: `op(fn, meta?)`,
  `param(name, subtree)`, `node({ops?,children?,meta?})`, `service(instance,
  opts?)`. Runtime: `dispatch(node, segments, input, slugs?)` walker (accumulates
  param slugs provenance-blind into op input).
- `tags.ts` — `Tags` type (open three-valued dict: `readOnly?/idempotent?/
  destructive?/openWorld?/streaming?/[custom:string]?: boolean|undefined`).
  `resolveTags(tags): ResolvedTags` applies the implication lattice (`readOnly ⇒
  idempotent`; `readOnly ∧ destructive → conflict`). `effectiveTags(path)` merges
  root→op closest-wins; `undefined` defers upward (unknown ≠ false).
- `index.ts` — base primitives kept: `compose`/`pipe`; `Result<T,E>` + `ok/err/
  isOk/isErr/map/bind/match`; derived combinators `composeK`/`collect`. Old
  D-tree/Schema routing retired.

**[BUILT] `@rhi-zone/fractal-http-api-projector` (`packages/http-api-projector`):**
- `project.ts` — `buildRoutes(node)`: path purely from tree walk (static key →
  `/{seg}`, ParamNode → `/{name}`, segment inferral strips leading verb word +
  kebab-cases). `meta.http.segment` overrides a node/op's contribution;
  `meta.http.legacyPath` is a [DEBT] escape hatch that bypasses tree-walk.
  `verbFromTags(meta)`: lattice `readOnly→GET`, `idempotent+destructive→DELETE`,
  `idempotent→PUT`, else→`POST`; `meta.http.verb` override wins. `makeRouter`:
  exact verb+path dispatcher, 404 on miss — no HEAD/OPTIONS/405 built in.
- `layers.ts` — `autoMethodLayer(inner, routes)`: droppable layer adding
  HEAD-from-GET, OPTIONS→204+Allow, 405+Allow. `corsLayer(opts)`: opt-in CORS
  preflight + origin headers, off by default.
- `preset.ts` — `createFetch(node, opts?)`: OOTB preset composing buildRoutes +
  makeRouter + autoMethodLayer + optional corsLayer; returns WHATWG
  `(req)=>Promise<Response>` suitable for Bun, Deno, Cloudflare Workers, Node.
- `adapter.ts` — `serveBun` / `serveNode` runtime adapters (isolated; core stays
  runtime-agnostic).

**[BUILT] `@rhi-zone/fractal-mcp-api-projector` (`packages/mcp-api-projector`):**
- `project.ts` — `toTools(node, opts?)`: walks Node tree, emits `McpTool[]` (one
  per op). Name: underscore-joined prefix from tree walk (`meta.mcp.name` full
  override; `meta.mcp.segment` per-node contribution). Annotation hints
  (`readOnlyHint/destructiveHint/idempotentHint/openWorldHint`) derived from the
  SAME `meta.tags` as HTTP; three-valued semantics: unknown tag → hint OMITTED
  (unknown ≠ false). `meta.mcp.annotations` overrides individual hints.
  Description: `meta.mcp.description > meta.description > derived.description >
  op key`. `inputSchema` from supplied `SchemaMap` (codegen) or MCP spec minimum
  `{type:"object"}`.

**[BUILT] `@rhi-zone/fractal-codegen` (`packages/codegen`):**
- `extract.ts` — TS compiler API (read-only). `schemaFromType`: primitives
  (string/number/boolean), arrays, optional fields (strips `|undefined`), nested
  objects; punts unions/generics/exotic to `{type:"object",$comment:"TODO(codegen):
  …"}`. `schemaFromFunctionNode`: derives schema from op's first parameter type.
  `extractJsDoc`: reads leading JSDoc text, climbs parent chain to declaration.
- `tree.ts` — `extractToolSchemas(entryFile): SchemaMap`: walks exported `node()`
  calls at AST level (runtime type erases op input shapes), mirrors toTools'
  underscore-joined name construction. Supports `node({ops,children})`, `op(fn,
  meta)`, `param("name", node({…}))` children. NOTE: `meta.mcp.name` /
  `meta.mcp.segment` overrides not yet mirrored here (TODO in source).

**[BUILT] End-to-end proof (`examples/library-api`):**
`catalog.search` (tagged `readOnly` at node level via inheritance) projects to:
HTTP `GET /catalog/search`, MCP `catalog_search` with `readOnlyHint:true`, and a
real codegen-derived `inputSchema: {type:"object",properties:{q:{type:"string"}}}`.
One authoring source; three surfaces; live test assertions for each. Also
exercises: `service()` authoring (BooksService), `param("bookId",…)` subtree,
`destructive+idempotent→DELETE`, `idempotent→PUT`, autoMethodLayer (HEAD/OPTIONS/
405), and codegen schema derivation for `catalog.genres`.

**[BUILT] Legacy retired:** provisional D-tree combinators, `Schema` validators,
old `toFetch`, `spine-demo` removed. Composition (`compose/pipe`) and `Result`
base kept.

---

## Open (remaining — next work)

- **[BUILT]** ~~The CONCRETE authoring surface / API shape in TS~~ — done:
  `op/node/service/param` constructors, `meta`/`meta.tags` sub-bag, full test
  suite.

- **[BUILT]** ~~Tree EDGES for standalone functions~~ — done: `param(name,
  subtree)` for parameterized edges; `children` record for static edges.

- **[BUILT]** ~~Codegen specifics for lowering types+JSDoc → runtime data~~ —
  done: `extractToolSchemas` + `schemaFromType` via TS compiler API.

- **[OPEN]** Only HTTP and MCP projections exist. CLI, GraphQL, gRPC, WebSocket,
  and OpenAPI are still to build.

- **[OPEN]** Codegen does not yet honor `meta.mcp.name` / `meta.mcp.segment`
  overrides when reconstructing tool names in `tree.ts` — a mismatch will cause
  wrong key lookups if those overrides are used.

- **[OPEN]** Codegen punts unions, generics, and exotic types to `{type:
  "object"}`. Any op with a non-obvious input shape gets the MCP spec minimum.

- **[OPEN]** JSDoc description extraction is minimal (leading comment only; no
  `@param` / `@returns` / tag parsing).

- **[OPEN]** Per-param HTTP location (query vs path vs body vs header) is
  unresolved. Input is currently assembled flat and provenance-blind — the handler
  cannot distinguish a path slug from a query param from a body field.

- **[OPEN]** `openWorld` tag is provisional / weakly defined.

- **[OPEN]** `readOnly` tag name is provisional. The canonical tag-set document
  uses `safe`; the code uses `readOnly` pending final naming resolution.

- **[OPEN]** Whether shared structural metadata (`server-less`'s param/route/
  response equivalents) should also live in the open bag, or be a typed
  first-class concern.
