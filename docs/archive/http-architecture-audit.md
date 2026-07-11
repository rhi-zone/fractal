# HTTP Projection Architecture Audit

**Branch:** `redesign/function-core`  
**Scope:** `packages/http/src/{project,layers,preset,verbs,adapter}.ts` + `packages/core/src/{node,tags}.ts`  
**Date:** 2026-07-09  
**Status:** Read-only audit; no source changes.

---

## 1. Concern-by-Concern Analysis

### 1.1 Structural Routing (tree walk → route table / paths)

**Where it lives:** `buildRoutes()` in `packages/http/src/project.ts:181-341`.

**Assessment:** This is the load-bearing function that conflates multiple concerns (see §2). As a pure tree-walk that outputs a flat `Route[]`, the structural routing concern (segment construction from child keys, `inferSegment()`, `legacyPath` override) is separable in principle — but it is not separated in practice. `inferSegment` (`project.ts:103-110`) and `parsePath` (`project.ts:117-126`) are standalone pure functions, which is good. The walk itself, however, is woven into the same `buildRoutes` recursive body as dispatch-marker handling, collision detection, and condition construction.

**Separability:** Partially. `inferSegment`, `parsePath`, `matchRoute`, `allowHeader` are all free-standing utilities (`project.ts:103-159`). The tree walk itself is not separately extractable without refactoring.

---

### 1.2 Verb Resolution (tags → verb, lattice, `meta.http.verb` override)

**Where it lives:** `verbFromTags()` in `packages/http/src/project.ts:77-94`.

**Assessment:** **Already composable.** `verbFromTags` is a pure, standalone function — it reads `meta.http.verb` first (override wins, `project.ts:79-83`), then falls through to `resolveTags(meta.tags)` (`project.ts:85-93`). It has no side-effects and no coupling to `buildRoutes` except being called from it. The three-valued lattice lives in `packages/core/src/tags.ts:117-142` (`resolveTags`, `effectiveTags`). 

`effectiveTags` (`tags.ts:158-170`) is the closest-wins ancestor-merge across the node path and is called inline in `buildRoutes` before invoking `verbFromTags` (`project.ts:205`, `264-266`, `318-321`). This is correct separation: tag inheritance is a core concern, verb derivation is an HTTP concern, and they compose via a clean data handoff.

**Separability:** Already separated and swappable. A caller could substitute a different `VerbResolver: (meta: Meta) => string` without touching anything else.

---

### 1.3 Dispatch Matching — **CRUCIAL: open/closed question**

**Where it lives:** Two interacting sites:

1. **Build time** — `buildRoutes()`, `project.ts:194-307`. The dispatch marker (`meta.http.dispatch`) on a node is read here; a `MatchCondition` is emitted per leaf.
2. **Runtime** — `matchConditions()`, `project.ts:356-371`. Evaluates the `MatchCondition[]` on a route against a live `Request`.

**Is the set of match-kinds OPEN or CLOSED?**

**CLOSED — hard-coded at both sites.**

At build time, the condition factory (`project.ts:257-263`, `292-299`) is a 3-way `if/else if/else` on `dispatch.by`:

```ts
// project.ts:257-263
const condition: MatchCondition =
  dispatch.by === "header"
    ? { kind: "header", name: dispatch.name, value: matchValue }
    : dispatch.by === "query"
      ? { kind: "query", name: dispatch.name, value: matchValue }
      : { kind: "contentType", value: matchValue }
```

`"method"` is a separate special case (project.ts:194-231). `DispatchMarker` (`project.ts:470-474`) is a closed discriminated union of exactly four variants: `"method" | { by: "header" } | { by: "query" } | { by: "contentType" }`.

At runtime, `matchConditions` is an `if/else if/else if/else if` chain over `cond.kind` (`project.ts:358-369`):

```ts
if (cond.kind === "method") { ... }
else if (cond.kind === "header") { ... }
else if (cond.kind === "query") { ... }
else if (cond.kind === "contentType") { ... }
```

No default / fallthrough — unknown kinds are silently skipped (vacuously pass), which is a latent bug.

**Could a date-matcher be added WITHOUT editing `buildRoutes`?** **No.** Adding a date-based dispatch kind requires:

1. Extending `DispatchMarker` with a new variant (e.g. `{ by: "date"; field: string }`).
2. Adding a branch in `buildRoutes`'s condition factory (`project.ts:257-263`).
3. Adding a branch in `matchConditions` (`project.ts:358-369`).
4. Adding a runtime evaluation strategy (date comparison is not equality, so `matchValue` semantics must extend too — a matcher that fires for ranges rather than exact values).

The condition is a passive data record with a `kind` string; the evaluation strategy is hard-coded switch logic in `matchConditions`. There is no plug-in point.

**Separability:** Not separated. The dispatch extension surface is closed at both build time and runtime. This is the highest-priority extraction target (see §3).

---

### 1.4 Path / Segment + Param-Node Assignment

**Where it lives:** `buildRoutes()` inline, `project.ts:310-339` (segment dispatch block); `project.ts:103-126` (`inferSegment`, `parsePath`).

The segment logic: `http.segment ?? inferSegment(name)` (`project.ts:329, 335`). Param-node handling: `isParamNode(child)` check in each dispatch branch (`project.ts:199-201`, `241-242`, `312-313`).

**Assessment:** `inferSegment` and `parsePath` are pure and separately callable. The param-node check and the `{name}` path construction are repeated verbatim in all three `buildRoutes` branches (method/non-method/segment) — duplication, not conflation, but still a smell. Not a priority extraction target; DRY-up is enough.

**Separability:** `inferSegment` / `parsePath` already standalone. Param-branch logic is duplicated in-tree.

---

### 1.5 Per-Param Location (query / path / body / header)

**Where it lives:** `makeRouter()`, `project.ts:400-419`.

The handler's input is assembled as:

```ts
const input: Record<string, unknown> = { ...params }       // path params (provenance-blind)
for (const [k, v] of url.searchParams) { input[k] = v }   // all query params merged flat
// if Content-Type includes application/json:
Object.assign(input, body)                                  // body fields merged flat
```

Path params, query params, and JSON body fields are all merged into one flat object — **provenance-blind by design** (see `node.ts:43` comment: "handler sees one flat input"). Header values are NOT automatically extracted into the input; header dispatch is used only for routing selection, not for exposing header values to the handler.

**Assessment:** This is handled, but only for the default `makeRouter` path. The per-param location is not configurable — there is no `ParamLocator` or similar plug-point. Merging is flat and unconditional. For body + query key collision, last-wins (body wins over query because `Object.assign` comes after the query loop, `project.ts:403-415`).

**Separability:** Not currently separable. Extractable as a pure `assembleInput(req, params): Promise<Record<string, unknown>>` function — presently inlined in `makeRouter`.

---

### 1.6 Response Encoding (status, content-type, `encodeOk`/`encodeErr`)

**Where it lives:** `makeRouter()`, `project.ts:420-425`; `jsonResponse()`, `project.ts:433-439`.

```ts
// project.ts:421-425
const result: unknown = await (matched.handler(input) as Promise<unknown>)
return jsonResponse(result)            // status 200, Content-Type: application/json
// ...
return jsonResponse({ error: String(e) }, { status: 500 })  // unhandled throw → 500
```

`jsonResponse` is a pure standalone helper (`project.ts:433-439`). However, there is no `encodeOk`/`encodeErr` concept — the router hard-codes JSON serialization of whatever the handler returns and wraps throws as `{ error: "..." }` strings with 500. There is no:
- Status derivation from a `Result<T, E>` wrapper.
- Content-type negotiation.
- Per-route encoder.

**Assessment:** Currently a monolith baked into `makeRouter`. The `jsonResponse` helper is usable standalone but is not a plug-point. A `Result`-aware encoder or a content-type-negotiated encoder cannot be injected. Low priority for now (JSON-only is a valid starting position), but will become a gap when `Result` encoding lands.

**Separability:** `jsonResponse` is already a free function. A `ResponseEncoder = (result: unknown, meta: Meta) => Response` plug-point does not yet exist.

---

### 1.7 Layers (auto-method 405/HEAD/OPTIONS, CORS)

**Where it lives:** `packages/http/src/layers.ts`.

**Assessment:** **Already composable wrappers.** Both `autoMethodLayer` and `corsLayer` take `(inner: Fetch, routes: Route[]) => Fetch` and `(opts) => (inner: Fetch) => Fetch` shapes respectively. They compose purely by function wrapping — no shared mutable state, no coupling to `buildRoutes` internals. The comment at `layers.ts:24-26` correctly documents droppability: the core router returns 404 for HEAD/OPTIONS/wrong-method without the layer.

`corsLayer` is a factory returning a higher-order function — the cleanest shape of the three layer types (`layers.ts:113`).

`preset.ts:46-61` shows the composition sequence clearly: `buildRoutes → makeRouter → autoMethodLayer → (optional) corsLayer`. This is the correct architecture for layers.

**Separability:** Already composable. No changes needed here. New layers (e.g. rate-limiting, auth) can be added by writing the same `(inner: Fetch) => Fetch` signature without touching any existing code.

---

### 1.8 Collision Detection

**Where it lives:** Inline in `buildRoutes()`.

- Method-dispatch collision: `project.ts:209-215` (map of `verb → child name`).
- Attribute-dispatch collision: `project.ts:247-253` (leaf), `project.ts:284-291` (branch).

**Assessment:** Correct and appropriately placed — collision is a build-time property of the route table, not a runtime concern. No extraction needed. The collision check for method-dispatch and attribute-dispatch have slightly different error messages but identical structure; a shared helper would marginally reduce duplication.

**Separability:** Fine as-is. Already isolated to build time.

---

## 2. `meta.http` Key Enumeration

All keys are declared in `HttpMeta` (`project.ts:476-489`) and parsed by the private `getHttpMeta()` helper (`project.ts:492-521`):

| Key | Type | Consumer | Purpose |
|---|---|---|---|
| `verb` | `string` | `verbFromTags()` (via `getHttpMeta`) | Override tag-derived verb |
| `segment` | `string` | `buildRoutes()` | Override inferred path segment |
| `legacyPath` | `string` | `buildRoutes()` (DEBT) | Full-path override, bypasses tree walk |
| `dispatch` | `DispatchMarker` | `buildRoutes()` | Signals non-segment dispatch on this node's children |
| `when` | `string` | `buildRoutes()` | Per-child match-value override for attribute dispatch |

**Read by ONE monolith or per-concern?**

The `getHttpMeta()` parser is called four times — all inside `buildRoutes()` (`project.ts:191`, `245`, `281`, `322-323`). `verbFromTags()` reads `meta.http.verb` directly via its own access path (`project.ts:79-82`) rather than through `getHttpMeta`. So:

- `verb` — read by `verbFromTags()` directly (correctly separated).
- `segment`, `legacyPath`, `dispatch`, `when` — all read exclusively inside `buildRoutes()`.

**Assessment:** `meta.http` is effectively split between one standalone reader (`verbFromTags`) and one monolith (`buildRoutes`). This is acceptable for the current set of keys, but `dispatch` and `when` will need to be read by whatever plug-in mechanism replaces the hard-coded condition factory.

---

## 3. Verdict + Decomposition Proposal

### Monolith vs Already-Composable

| Concern | Status |
|---|---|
| Structural routing (tree walk) | **Monolith** — interleaved with dispatch/collision in `buildRoutes` |
| Verb resolution | **Already composable** — `verbFromTags()` is a standalone pure fn |
| Dispatch condition construction | **Monolith** — closed `if/else if` factory in `buildRoutes` |
| Dispatch condition evaluation (runtime) | **Monolith** — closed `if/else if` chain in `matchConditions` |
| Path/segment + param assignment | **Mostly composable** — helpers standalone, duplication in `buildRoutes` |
| Per-param location (input assembly) | **Monolith** — inlined in `makeRouter` |
| Response encoding | **Proto-composable** — `jsonResponse` standalone but no encoder plug-point |
| Layers (autoMethod, CORS) | **Already composable** — `(inner: Fetch) => Fetch` wrappers |
| Collision detection | **Fine as-is** — build-time, correctly placed |

### Priority 1 (Highest): Dispatch Matcher — Open Plug-Point

The blocker for a date-matcher (or any non-equality matcher) is that `MatchCondition` is a closed union AND its build-time factory and runtime evaluator are both hard-coded `if/else if` chains. The extraction has two halves:

**Build-time: open `DispatchMarker` → open condition constructor**

Replace the closed `DispatchMarker` union + the condition factory inside `buildRoutes` with a `MatcherSpec` + `ConditionBuilder` pair:

```ts
// A condition builder: given the dispatch marker config and the child's
// match value (derived from child key or `when` override), returns a MatchCondition.
export type ConditionBuilder<TSpec> = (
  spec: TSpec,
  matchValue: string,
) => MatchCondition

// An open registry entry: identifies a dispatch flavor by the `by` key,
// carries its ConditionBuilder.
export type DispatchPlugin<TSpec = unknown> = {
  readonly by: string  // discriminant; "method" stays special-cased
  readonly buildCondition: ConditionBuilder<TSpec>
}
```

`buildRoutes` (or a successor) receives a `plugins: readonly DispatchPlugin[]` argument and uses it to look up the builder for `dispatch.by` instead of the hard-coded `if/else if`. Unknown `by` keys throw at build time.

**Runtime: open `MatchCondition` → open condition evaluator**

Replace the closed `matchConditions` switch with a `ConditionEvaluator` registry:

```ts
export type ConditionEvaluator = (cond: MatchCondition, req: Request) => boolean

// Each plugin also carries its runtime evaluator.
export type DispatchPlugin<TSpec = unknown> = {
  readonly by: string
  readonly buildCondition: ConditionBuilder<TSpec>
  readonly evaluateCondition: ConditionEvaluator
}
```

`matchConditions` iterates conditions, looks up the evaluator for `cond.kind` in the plugin registry, and calls it. Unknown kinds throw (fixing the current silent-pass bug).

**`MatchCondition` must become an open type** (or carry an opaque payload):

```ts
// Option A: open discriminant — plugins define their own cond.kind values
export type MatchCondition = {
  readonly kind: string
  readonly [key: string]: unknown
}

// Option B: typed sum + opaque escape hatch
export type MatchCondition =
  | { readonly kind: "method"; readonly value: string }
  | { readonly kind: "header"; readonly name: string; readonly value: string }
  | { readonly kind: "query"; readonly name: string; readonly value: string }
  | { readonly kind: "contentType"; readonly value: string }
  | { readonly kind: string; readonly payload: unknown }  // plugin-opaque
```

Option A is simpler; Option B preserves typed built-ins at the cost of a union.

**Date-matcher example under this scheme:**

```ts
const dateMatcher: DispatchPlugin<{ field: string }> = {
  by: "date",
  buildCondition: (spec, matchValue) => ({
    kind: "date",
    field: spec.field,
    value: matchValue,  // e.g. "2026-01-01/2026-12-31" ISO interval
  }),
  evaluateCondition: (cond, req) => {
    // interpret cond.value as date range, check req header/query field
    ...
  },
}
// Usage: meta.http.dispatch = { by: "date", field: "X-Request-Date" }
// Added via: buildRoutes(node, { plugins: [dateMatcher] })
// NO changes to project.ts.
```

### Priority 2: Input Assembly Extraction

Extract the body of `makeRouter`'s input-assembly block (`project.ts:400-419`) into:

```ts
export type InputAssembler = (req: Request, params: Record<string, string>) => Promise<Record<string, unknown>>
```

Default implementation covers the current behavior (path + query + JSON body). Alternative implementations (e.g. multipart, form-encoded, schema-validated) can be injected without touching `makeRouter`. This is low-risk and straightforward.

### Priority 3: Response Encoder Plug-Point

When `Result<T, E>` encoding lands, extract:

```ts
export type ResponseEncoder = (result: unknown, req: Request, meta: Meta) => Response | Promise<Response>
```

Pass to `makeRouter`. Default is the current `jsonResponse(result)` behavior. This keeps `makeRouter` runtime-agnostic as format needs grow.

### What Stays In Core-HTTP (No Plug-Point Needed)

- `verbFromTags()` — already composable, no changes needed.
- `autoMethodLayer` / `corsLayer` — already the right abstraction.
- `buildRoutes` tree walk structure — the recursive segment/param/leaf discrimination is stable; only the dispatch-condition factory inside it needs opening.
- `collision detection` — fine as-is; build-time, no runtime surface.
- `parsePath` / `inferSegment` / `matchRoute` — already standalone utilities.

### `buildRoutes` as Composition of Stages (Post-Extraction)

After Priority 1 extraction, `buildRoutes` signature becomes:

```ts
export function buildRoutes(
  n: Node,
  opts: { plugins?: readonly DispatchPlugin[] } = {},
  prefix?: string,
  tagPath?: ...,
  inheritedConditions?: ...,
): Route[]
```

The condition factory block (`project.ts:257-263`, `292-299`) is replaced by a plugin-registry lookup. The rest of the tree walk is unchanged. Behavior is identical for the four built-in match kinds (they become built-in plugins in the default set).

---

## Appendix: File-Line Reference Summary

| Claim | File:Line |
|---|---|
| `buildRoutes` signature | `project.ts:181-186` |
| Method-dispatch branch | `project.ts:194-231` |
| Non-method attribute dispatch branch | `project.ts:233-307` |
| Closed condition factory | `project.ts:257-263`, `292-299` |
| `matchConditions` closed evaluator | `project.ts:356-371` |
| `DispatchMarker` closed union | `project.ts:470-474` |
| `HttpMeta` key definitions | `project.ts:476-489` |
| `getHttpMeta` parser | `project.ts:492-521` |
| `verbFromTags` standalone | `project.ts:77-94` |
| Input assembly in `makeRouter` | `project.ts:400-419` |
| `jsonResponse` standalone | `project.ts:433-439` |
| `autoMethodLayer` composable wrapper | `layers.ts:34-82` |
| `corsLayer` composable factory | `layers.ts:113-169` |
| `createFetch` composition sequence | `preset.ts:46-61` |
| `effectiveTags` tag inheritance | `tags.ts:158-170` |
| `resolveTags` lattice | `tags.ts:117-142` |
