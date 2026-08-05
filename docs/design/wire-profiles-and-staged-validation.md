# Wire profiles + staged decode/validate

## Status

Design settled in conversation with the user (2026-08). The prerequisite arc
— meta unification / HTTP directive dissolution, see immediately below — has
LANDED (2026-08): `meta.http.directives`/`HttpDirective`/the fold-by-`kind`
`getHttpMeta` read-time switch are deleted; HTTP now authors flat
`meta.http.*` keys directly, matching cli/mcp/graphql/json-rpc's existing
shape. The staged decode/validate model itself (wire profiles, the
`validateEncoding`/`decode`/`defaults-fill`/`validateConstraints` pipeline)
is still NOT implemented — this document captures the settled decisions for
that work and elaborates them.

A follow-up conversation (2026-08) settled the three sub-questions that were
originally left open (see "Settled: profile overrides, wrap-layer idiom, argv
boolean encoding" below) and added a **prerequisite arc** — meta unification /
directive dissolution — that has to land before the staged-validation
implementation, because decision (a) below (profile overrides declared in the
per-protocol meta namespaces) assumes those namespaces are flat, not the
directive-array envelope HTTP currently uses. See "Prerequisite: meta
unification (directive dissolution)" immediately below.

Builds on the `applyValidation` architecture landed in cf89fd0 (phase 1:
call-site-anchored mechanism), 56deb11 (phase 2: HTTP migration), and 1855c7a
(phase 3: CLI/MCP/GraphQL migration, `wrapValidators` deleted). See
`docs/design/routing-and-transforms.md`'s "Dispatch is not an interceptable
multi-stage pipeline" section for that mechanism's full history. This doc
does not change that architecture — the keyed, call-site-anchored generated
module, the one import, `assertValidationCoverage` — it changes what the
generated `parse()` a leaf's handler is wrapped with actually *does*.

---

## Problem

`packages/type-ir/src/compile.ts`'s generated `parse()` bakes in one
universal from-string coercion rule set, applied identically regardless of
which protocol the value arrived over:

- `booleanLeaf` (compile.ts:504–520): `"true"`/`"false"` string coercion.
- `numberFamilyLeaf` (compile.ts:480–502): any numeric string via `Number(v)`.
- `dateLeaf` (compile.ts:458–474): any string via `new Date(v)`.

This is wrong because coercion posture is **wire-shaped**, not universal:

| wire | shape |
|---|---|
| CLI argv | every flag value is `string \| string[] \| true` (see `cli-api-projector/src/cli.ts`'s `parseFlags`/`buildInput`) |
| HTTP query/path | strings (URL segments, query string) |
| HTTP JSON body | typed, but dateless (JSON has no date literal) |
| MCP / GraphQL | typed JSON — numbers are numbers, booleans are booleans, no coercion needed at all |

A single builtin rule set is simultaneously too permissive for mcp/graphql
(a JSON body's `42` needs no coercion, so pretending every input might be a
coercible string is dead code there) and not permissive enough for CLI
(argv's `true` flag-presence sentinel and `string[]` repeated-flag values
aren't in `compile.ts`'s vocabulary at all).

Two projectors independently noticed this gap and grew their own divergent
coercion, each disabling itself where the other's mechanism already ran
(the `isApplyValidationWrapped` sniff):

- `cli-api-projector/src/cli.ts`'s `coerceInput` (~826–964) walks the JSON
  Schema and additionally accepts a **loose boolean set**:
  `"1"`/`"yes"` → `true`, `"0"`/`"no"` → `false` (cli.ts:917–923) — a
  strictly wider vocabulary than `compile.ts`'s own `"true"`/`"false"`.
- `mcp-api-projector/src/server.ts`'s `validateAgainstSchema` (~120–205) does
  the opposite: a bare `typeof` gate, no coercion at all — correct for MCP's
  typed JSON wire, but a hand-rolled reimplementation of a `type`-kind
  `ValidationError` living outside `compile.ts`'s error taxonomy entirely.

Both fallbacks, and the sniff that makes them mutually exclusive with the
generated validator, are retired by this design (see "What goes away"
below) — replaced by making coercion posture an explicit, per-protocol,
per-field input to codegen, instead of an implicit universal default one
projector layer disagrees with and another duplicates.

### History: why the universal rule set existed

Per `docs/design/routing-and-transforms.md`'s superseded-lineage note,
coercion-in-the-validator was a deliberate decision made in July 2026 when
the only wire in view was HTTP's stringly-typed input bags — the premise at
the time was "raw protocol inputs are always strings." That premise broke
the moment typed wires (MCP tool-call arguments, GraphQL variables — both
JSON, both already typed by the time they reach a handler) entered the
picture: a universal string-coercion rule set is simply the wrong shape for
an input that was never a string to begin with. This design replaces the
premise, not just a symptom of it.

---

## Prerequisite: meta unification (directive dissolution)

Settled in the follow-up conversation. This is a PHASE that has to land
before the staged-validation work below, not an independent cleanup — decision
(a) (profile overrides declared in the per-protocol meta namespace, same
surface as `sourceMap`) only holds together if that namespace is a flat bag of
scalar/map/array keys. HTTP's current `meta.http.directives` — a single array
of a tagged-union `HttpDirective` value, resolved by `getHttpMeta`'s
fold-by-`kind` switch — is a different shape, kept that way specifically
because `FoldMeta`/`MergeTwoMeta` (node.ts) couldn't merge index-signature
maps or bare functions without losing literal types or call signatures (see
`VerbBundle`'s and `HttpDirective`'s own doc comments, project.ts/verbs.ts).
Wire profiles need a flat namespace to declare into; HTTP has to migrate to
one first.

### The rule: fold semantics follow value shape

Cardinality is expressed by shape, not by a directive `kind` tag:

- **At-most-one** → flat scalar key. Last-wins; the shape structurally
  precludes multiples — that's a feature (the right fit for scalar directives
  like a verb pin or a `moveTo` path), not a limitation being worked around.
- **Keyed partial contribution** → flat map key. Key-merge, later call wins
  per key — the shape `sourceMap` already has.
- **Genuinely multiple/ordered** → array key. Append; `MergeMetaValue`'s array
  branch (node.ts) already concatenates without recursing into elements, which
  is exactly why arrays already work today for `middleware`/`handlerMiddleware`
  and don't need to change.

### What dissolves for HTTP

`meta.http.directives` — the whole envelope — dissolves:

- `verb`, `method`, `moveTo`, `response`, `paginated`, `validate` become flat
  `meta.http.*` scalar keys (last-wins, matching what `getHttpMeta` already
  resolves them to today — the RESOLVED shape becomes the AUTHORED shape,
  collapsing the two).
- `source`'s resolved output, `sourceMap`, becomes a bare `meta.http.sourceMap`
  key (key-merged map) — no longer assembled from an array of `source`
  directives at read time; each `http.source()` call key-merges directly.
- `middleware`/`handlerMiddleware` become plain arrays under flat keys
  (`meta.http.middleware`, `meta.http.handlerMiddleware`) — same
  collect-into-ordered-list semantics as today, just authored as an array
  value instead of assembled from directive entries.
- `HttpDirective` (the DU), `getHttpMeta`'s fold-by-`kind` switch, and the
  already-retired holdovers this dissolves along with it — `segment`, `when`,
  `legacyPath`, and the `dispatch` marker (see `directive-contract.md`'s HTTP
  table: all four are already "currently unread," parsed but consumed by
  nothing since the direct tree-walk dispatcher's retirement) — all delete.
- Overlap/pollution avoidance (keeping `meta.http.*` keys from colliding with
  a deployment's own augmentation, or with another protocol's namespace) is no
  longer bought structurally by the directive envelope; it becomes a
  per-namespace naming-design obligation each protocol's flat-key vocabulary
  has to observe directly.

### All five protocols converge

http, cli, mcp, graphql, and json-rpc all converge on flat namespaced bags
with shape-directed folding — json-rpc also carries a `meta.jsonrpc.sourceMap`
(`packages/json-rpc-api-projector/src/project.ts`), already flat, already the
target shape. **HTTP is the migration, not the template** — cli/mcp/graphql/
json-rpc's `meta.<proto>.sourceMap` (see `directive-contract.md`'s per-protocol
tables) are already flat map keys today; HTTP is the one protocol whose
directive-array envelope needs to be dissolved to match.

### Exact-variant hygiene

Producer positions — verb bundles (`http.get`, `http.put`, …, verbs.ts) and
the other `http.*` helpers (`moveTo`, `source`, `validate`, `middleware`,
`handlerMiddleware`) — must be typed as the EXACT variants they construct,
never the open DU. This is what already keeps index-signature-widened types
out of the fold today (`VerbBundle`'s own doc comment, verbs.ts, documents the
hazard directly: intersecting a loosely-typed declared field with a literal
tuple type collapses tuple arity under TypeScript's inference). With that
constraint kept, `FoldMeta`/`MergeMetaValue` (node.ts) grows a new **keyed-
merge branch for map-shaped values operating on literal types** — a
`sourceMap`-like value with LITERAL keys (not an index-signature-erased
`Record<string, ParamSource>`) can be merged as `Omit<A, keyof B> & B`
(last-wins per key) the same way `MergeTwoMeta` already merges two meta
objects, without hitting the index-signature recursion limitation `source()`'s
doc comment (verbs.ts) currently works around by staying directive-array-
authored. **Soundness against a user's own hand-widened annotation is
explicitly a non-goal** — a user who annotates a contribution's `sourceMap` as
`Record<string, ParamSource>` themselves (defeating the literal-key inference)
gets the erased-map behavior back; their foot, their trigger.

### `UncoveredSourceParams` generalizes

The static source-coverage check (`UncoveredSourceParams`, api-tree's
input.ts) generalizes from HTTP-specific `DirectivesOf`/`FindStoreForParam`
tuple-walking to all five protocols, walking `Meta.<proto>.sourceMap` directly
— simpler than the current directive-tuple walk, since there's no longer an
array of `{kind:"source", map}` entries to fold at the type level, just one
flat map key per protocol. The type-erased-map guards (`string extends keyof
M`) stay load-bearing for the same reason they are today — a verb bundle or
other producer typed as an open DU would otherwise phantom-contribute an
erased map. The distribution guards that exist to make `DirectivesOf`
distribute over a directive-tuple union delete along with the phantom
`HttpDirective` member they exist for.

### Resolution lifecycle unifies on snapshot-at-projection

CLI's current `getCliMeta` read is live, per-dispatch (`cli.ts:1172`, inside
`runCli`'s per-request path, not resolved once at build/projection time) —
verified this is an artifact, not a load-bearing behavior: no test or doc
relies on meta being re-read per dispatch rather than snapshotted once. CLI
gains the same snapshot-at-projection shape HTTP already has (`meta.http`
resolved once when the `HttpRoute` tree is built, not per request).

### Implementation checkpoint — RESOLVED (verified, 2026-08)

`verbs.ts`'s `source()` doc comment (~296–306) stated that `moveTo`/`paginated`
chose directive-array authoring for "literal-type preservation" reasons
distinct from `source()`'s own index-signature-recursion reason (see
`VerbBundle`'s doc comment). Flat scalar keys were assumed, in this design, to
fold literal types through `FoldMeta`/`MergeMetaValue` just as cleanly as the
directive-tuple shape does. Re-verified with an actual `tsc` scratch repro
(not reasoned from memory) before the migration landed: CONFIRMED — flat
scalar keys fold literal types cleanly through the existing, unmodified
`FoldMeta`/`MergeTwoMeta`.

A second, related question surfaced during the SAME verification pass: does a
map-shaped value (`sourceMap`, three levels below `Meta` — `Meta -> http ->
sourceMap -> { store, key? }`) also fold correctly (keyed, last-wins,
whole-value-replace, never a partial field-merge) through the EXISTING
`FoldMeta`/`MergeTwoMeta`, without a dedicated new branch? Also CONFIRMED at
the TYPE level (the existing depth-2 cap already produces exactly the right
result) — but the same scratch pass found the RUNTIME counterpart,
`mergeRecords` (node.ts), did NOT match: it recursed without any depth limit,
which for a partial `ParamSource` (e.g. a `key`-omitting `http.source()` full
form) could resurrect a stale field from an earlier composed contribution
instead of replacing the value wholesale — a genuine, previously-unexercised
runtime/type divergence, not just a theoretical risk. Fixed by depth-capping
`mergeRecords` to match `MergeMetaValue`'s own cap exactly (see node.ts's
`mergeRecords` doc comment for the full trace) — closing the gap for
`sourceMap` and for any other object nested this deep, not just as a
`sourceMap`-specific patch.

---

## The staged model

Every arrow is precisely typed. No lying intermediates, no "best-effort":

```
Wire --validateEncoding--> ValidWire --decode (total)--> T --defaults-fill--> T --validateConstraints--> valid T
```

- **`Wire`** — whatever the protocol actually handed the handler: an argv
  flag value (`string | string[] | true`), a URL query/path string, a
  parsed-but-dateless JSON body, or already-typed MCP/GraphQL JSON.
- **`validateEncoding`** — per-profile, thin. Checks only that the wire
  value is in the shape the decode step expects (e.g. "is this a numeric
  string", "is this `string | string[]`"). Errors are phrased against what
  the caller actually sent: `"--page: expected numeric string"`, not a
  generic type mismatch against the target type `T`. This is the ONE stage
  that varies per wire profile.
- **`ValidWire`** — the refined type after `validateEncoding` passes. Real,
  emitted output — not a phantom brand. A user overriding one field's
  decoder writes `(w: FieldValidWire) => TField`, and it type-checks against
  the actual emitted `ValidWire` shape for that field, not a hand-guessed
  shape.
- **`decode`** — total BY CONSTRUCTION on `ValidWire`. Because
  `validateEncoding` already ruled out every input decode doesn't know how
  to handle, decode itself has no error path — it's a mechanical, partial
  function `ValidWire => T` that never needs to have been partial. This is
  the load-bearing simplification the staged split buys: today's
  `numberFamilyLeaf`/`booleanLeaf`/`dateLeaf` interleave the "is this
  coercible" check and the coercion itself in one function that has to
  handle its own failure case inline; splitting them means decode never
  has to.
- **`defaults-fill`** — see "Where defaults-fill sits," below.
- **`validateConstraints`** — min/max/pattern/enum/minLength/etc. on `T`.
  **Profile-independent** — compiled ONCE, shared across every profile and
  every projection. A `books` tree validated for both HTTP and MCP compiles
  this stage a single time; only `validateEncoding`+`decode` differ per
  wire profile. This is also the exact definition of "strict validation":
  the **identity profile** is `validateEncoding` reduced to a trivial
  "already the right shape" check plus the full `validateConstraints` pass
  — i.e. what today's `check`/`errors`/`parse` do for an in-process,
  already-typed value with no wire in between.
- **`valid T`** — the value a handler actually receives.

Fusing all four stages into one emitted `parse_profile(wire)` function per
leaf is a permitted EMISSION optimization — nothing requires four separate
generated function calls at runtime. What's fixed is the model, the types
between stages, and the error taxonomy (`ValidationError`'s existing kinds,
plus wire-specific ones as needed for `validateEncoding` — e.g. a
`coerce`-shaped error phrased against the wire value, which `compile.ts`
already has as a `ValidationError` kind since `numberFamilyLeaf`/
`booleanLeaf`/`dateLeaf` emit it today).

### Where defaults-fill sits

Decision: between `decode` and `validateConstraints` — deliberately mirroring
TypeBox's `Value.Convert` → `Value.Default` → `Value.Check` ordering.

Why not before `decode`: a default value is author-supplied and already
typed as `T` (e.g. `meta.default: 0` for a number field, the same
`meta.default` convention `json-schema.ts`'s `withMeta` already reads/emits)
— it has no wire encoding to decode FROM. Running it through `decode` would
require decode to accept `T` values it never emitted itself, breaking
decode's totality-by-construction guarantee for no benefit.

Why not after `validateConstraints`: a required-field / min-length /
pattern check on a field that's about to receive a default must not fire
against the field's ABSENCE — that's exactly the bug decision 4 calls out:
"validated leaves currently get no defaults, an inconsistency this fixes."
Filling defaults strictly before constraint checking means a defaulted
field is checked exactly like a caller-supplied one — same error taxonomy,
same codepath, no separate "missing-but-has-a-default, don't error" carve-out
in `validateConstraints` itself.

Net effect: `defaults-fill` turns a `T` that may have OMITTED optional
fields (decode only produces what the wire actually carried) into a
complete `T` before constraint-checking sees it. Today's inconsistency —
CLI's `applyDefaults`/`validateRequired` fallback fills defaults, but the
generated `parse()` path (when `isApplyValidationWrapped` shortcuts CLI's
own fallback) never does — is what this closes.

---

## Wire profiles are a type-ir mechanism, not api-tree-specific

The wire-decode stage becomes a new TypeRef projection, a sibling of the
existing zod/json-schema/validator emitters in `packages/type-ir/src/` —
NOT bolted onto `api-tree`. Input: `(TypeRef, wire profile)`.

This follows the same extensibility pattern `compile.ts` already uses for
`check`/`errors`/`parse`: a `Record<kind, Handler>` registry dispatched via
`resolve()` (index.ts's kind-ancestor walk), so a new TypeRef kind only
needs an entry (or inherits its parent's, e.g. `int32`/`uuid` falling back
to `number`/`string`) — never a change to the dispatch mechanism itself.

A **wire profile** is open data (same "open metadata bag" pattern as
`meta.http`, per `docs/design/design-philosophy.md`): a per-field /
per-type-kind mapping of source encoding → wire representation. Protocols
ship a default profile:

- **CLI**: every field's wire type is `string | string[] | true` (argv's
  actual shape per `parseFlags`).
- **HTTP**: composite, and genuinely PER FIELD, because a field's own input
  source varies within one operation — a query-string field and a JSON-body
  field on the same handler have different wire encodings even though
  they're both "HTTP." This is not a simplification for this design; it's
  already how HTTP decode works today (see `docs/guide/decode.md`'s
  `sources.sourceMap` — a per-param store override, defaulting by HTTP
  method).
- **MCP / GraphQL**: identity + JSON dates (typed JSON in, no coercion
  needed for anything except `Date`, which JSON has no literal for).

Users can override per field or per type — precision on demand, zero-setup
by default. Where that override is declared: **the per-protocol meta
namespace, same surface as `sourceMap`** — see "Settled: profile overrides,
wrap-layer idiom, argv boolean encoding" below for the full resolution and the
composition rule.

---

## What goes away

Per the settled decisions:

1. `compile.ts`'s single builtin universal from-string coercion rule set
   (`numberFamilyLeaf`/`booleanLeaf`/`dateLeaf`'s string-coercion branches)
   — superseded by the profile-driven `validateEncoding`/`decode` stages.
2. `cli-api-projector/src/cli.ts`'s `coerceInput`/`applyDefaults`/
   `validateRequired` fallback (~826–1010ish) — its schema-walking coercion,
   its loose boolean set, its defaults-fill, and its required-field check
   all move into the generated layer.
3. `mcp-api-projector/src/server.ts`'s `validateAgainstSchema` (~120–205)
   fallback — its hand-rolled `typeof` gate and its parallel, non-taxonomy
   error strings.
4. `isApplyValidationWrapped` (apply-validation.ts:112–114) and every call
   site that sniffs it (`cli.ts:1180`, `server.ts:1065`) — the exclusivity
   this sniff exists to enforce (generated validator XOR fallback) has no
   reason to exist once there is no fallback to be exclusive WITH. Decode
   and validation run unconditionally on every leaf; nothing overlaps
   because there is exactly one mechanism now, not two racing to skip each
   other.
5. HTTP's `meta.http.directives` envelope, `HttpDirective` (the DU), and
   `getHttpMeta`'s fold-by-`kind` switch — superseded by the flat
   `meta.http.*` keys the prerequisite arc migrates HTTP onto (see
   "Prerequisite: meta unification" above). This is the mechanism that lets
   decision (a) below (profile overrides in the per-protocol meta namespace)
   apply uniformly to HTTP too, not just to cli/mcp/graphql/json-rpc, which
   already have flat namespaces today.

What stays, unchanged: `applyValidation(key, projectedTree)` itself, the
declared-key/call-site-anchored codegen model, the generated module + stub
pass-through, the one import, `assertValidationCoverage`. This design
changes the CONTENTS of the generated `parse()` a leaf gets wrapped with —
not how or where it's wired on.

### Pre-codegen story, stated openly

Decoders are generated code — a fresh checkout with no codegen run yet has
no decoder to run. The stub module (`applyValidationStubSource`,
apply-validation-build.ts:435–450) is a pass-through over an empty
validator map; with the fallbacks deleted, a leaf under an unregistered key
gets NO decode and NO validation until codegen runs once — raw wire values
reach the handler directly. This is the existing stub's documented
contract (`createApplyValidation`'s doc comment: "Deliberately SILENT —
coverage is enforced by codegen and by the explicit
`assertValidationCoverage` build-mode check below, never by the stub") —
this design doesn't change that contract, it just removes the
fallback that used to soften it for CLI/MCP specifically. `assertValidationCoverage`
remains the loud, explicit way to catch an un-codegen'd leaf before runtime.

---

## Settled: profile overrides, wrap-layer idiom, argv boolean encoding

The three questions originally left open here were resolved in the follow-up
conversation. Each subsection below keeps the original tradeoff analysis as
rationale, then states the pick.

### (a) Where are user profile overrides declared? — RESOLVED: per-protocol meta namespace

**Decision: option 2** — profiles/overrides are declared in the per-protocol
meta namespaces, the same surface `sourceMap` already uses (`meta.http.*`
once the prerequisite migration lands, `meta.cli.*`, `meta.mcp.*`,
`meta.graphql.*`, `meta.jsonrpc.*`). A wire profile factors as:

```
field → source        (SourceMap, already exists)
      ⊕ source → encoding   (per-store encoding table; protocols ship defaults)
      ⊕ derived per-field encoding
      ⊕ per-field overrides   (genuine exceptions only)
```

Protocol default encoding tables: flag store `string | string[] | true`,
env/query strings, body json+dates, mcp/graphql argument stores
identity+json-dates.

**Composition**: keyed last-wins, the same rule every other map-shaped meta
value already follows (matching `sourceMap`'s own "later call's keys win on
overlap" convention) — not a new composition primitive, just the standard one
applied to this key too.

Below is the three-option tradeoff analysis that led here, kept for context:

Three candidate locations were considered, and they interact with the
composition rule (protocol default ⊕ override) differently:

**1. `applyValidation` call-site argument** — e.g.
`applyValidation("books", tree, { profile: {...} })`.

- Codegen already resolves this call site with a `ts.TypeChecker` (see
  `apply-validation-build.ts`'s `findApplyValidationCallSites` and
  `traceNodeType`) — adding a third argument the same scan reads is a small
  extension of an already-working mechanism.
- BUT the override needs to carry actual decode logic
  (`(w: FieldValidWire) => TField`), not JSON-serializable data — the
  scanner doesn't need to EXECUTE it, only find and re-emit a reference to
  it in the generated module, exactly like `guardAnnotation`
  (compile.ts:863–874) already does for `typeName`/`declarationFile`
  cross-references. `traceNodeType`'s own doc comment is explicit that
  cross-file resolution is out of scope for THIS phase ("declare the tree…
  in the entry file, or call `applyValidation` in the file that declares
  it") — an override argument inherits that same same-file constraint
  unless it's lifted.
- Composition is visible right at the call site, but ties the override's
  lifetime to one specific `applyValidation` invocation — a tree validated
  once and shared across two protocols (the `validatedApi` pattern in
  routing-and-transforms.md) can't give HTTP and CLI different overrides
  through this argument, since they share the one call.

**2. Tree/op metadata** — e.g. `meta.wire.*`, colocated with the operation
the same way `meta.http.*` directives are. **← chosen.**

- Matches the existing convention exactly: "Declaration merging by the user
  happens next to the API tree definition so that `meta.http` type-checks
  at the authoring site" (routing-and-transforms.md). An override function
  living in `meta` is ordinary TS data (functions are valid object-property
  values at runtime; nothing here is JSON-serialized), so no new codegen
  primitive is needed to CARRY it — only to find it.
- The `apply-validation-build.ts` scanner would need to walk the traced
  `Node` tree's actual meta at each leaf (not just its type) to read the
  override — a different traversal than the current call-site-only scan,
  closer to `extractRouteTypeRefs`'s tree-walking than to
  `findApplyValidationCallSites`'s call-expression walk.
- Naturally per-leaf (an operation's own `meta.wire` scopes to that
  operation), which sidesteps the "shared call site, different protocols"
  problem option 1 has — but a leaf shared across HTTP and CLI via one
  `Node` still has ONE `meta.wire`, not one per protocol, unless the value
  itself is keyed by protocol. Resolved by declaring overrides directly
  under EACH protocol's own namespace (e.g. `meta.http.*`, `meta.cli.*` —
  the exact field name for the override, as opposed to its namespace, is
  not specified by the settled decisions and is left to implementation)
  rather than a shared `meta.wire`, so a leaf shared across HTTP and CLI
  gets independent overrides per protocol for free — the same reason
  `sourceMap` is already namespaced per protocol instead of shared.

**3. A separate codegen config file** — e.g. a `wire-profiles.config.ts`
read directly by the build orchestrator, independent of any call site.

- Decoupled from the authoring site: codegen reads it directly with no
  `ts.TypeChecker` tracing needed for the override's LOCATION (only,
  perhaps, for what it references). Simplest for the scanner.
- But decoupled is also the risk: an override keyed by tree-relative path
  (the same `"books/:bookId"` convention `apply-validation.ts` already
  uses) drifts silently if the tree is refactored and the path changes —
  there's no local reference for a type error to catch, the way a
  `meta.wire` sitting directly on the node would.
- Cleanest separation from the tree/call-site if profile overrides are
  thought of as build configuration rather than domain modeling — but that
  framing is itself a design stance, not a given.

### (b) Wrap-layer idiom: raw `Node` everywhere, or projected-where-it-exists? — RESOLVED: dispatch where each projection dispatches

**Decision: keep the existing asymmetry, don't force uniformity.**
Validation/decode attach where each projection ALREADY dispatches — HTTP on
the projected `HttpRoute` (its per-field source resolution is
post-`projectRoute`, unchanged from today's `PresetOptions.rewriters`
integration point), cli/mcp/graphql/json-rpc at their `Node`-level dispatch
(also unchanged). Nothing is artificially projected for uniformity's sake —
this is the natural conclusion the tradeoff analysis below already pointed
toward (a per-projection profile FORCES projected-layer attachment for HTTP,
but only FAVORS it, without forcing it, for the other four), made explicit as
the pick rather than left as an open lean.

Original tradeoff analysis, kept for context:

Today, HTTP's `applyValidation` integration point is `PresetOptions.rewriters`
on the PROJECTED `HttpRoute` (routing-and-transforms.md: "`applyValidation`
has to run on the PROJECTED shape here because `createFetch` never exposes
the intermediate `Node`"), while CLI/MCP/GraphQL apply it to the raw `Node`
(no separate projected type exists for them).

Whether a wire profile being PER-PROJECTION forces this asymmetry to
continue, or just favors it, depends on what a profile needs to know that
only the projected shape carries:

- HTTP's per-field wire source (query vs. body vs. header) is determined by
  `sources.sourceMap`. Historically (before `http.source()` landed, commit
  `9bd373a`), this information existed only after projection, which was a
  real forcing function for HTTP specifically. `http.source()` now lets a
  `meta.http.sourceMap` (post the directive-dissolution migration, a flat
  key) be declared at authoring time — but the RESOLVED per-field source
  used at decode time is still computed post-`projectRoute` (method-derived
  primary-store convention + path-slug detection both depend on the route's
  mount position, which only exists after projection), so HTTP still
  attaches post-projection even though the override itself is now
  authorable pre-projection.
- CLI/MCP/GraphQL have no such asymmetry: every field's wire type is
  uniform for the whole protocol (argv is uniformly stringly, MCP/GraphQL
  uniformly typed JSON) — nothing about their wire profile depends on
  per-field routing/source information, so nothing forces projected-layer
  attachment for them. Node-level attachment already works for them today,
  unchanged.

So the honest framing: a per-projection profile FORCES projected-layer
attachment for HTTP, but only FAVORS (doesn't force) it for CLI/MCP/GraphQL,
where Node-level attachment already suffices and matches
routing-and-transforms.md's "apply `applyValidation` ONCE, before any
protocol-specific projection" shared-tree pattern. A uniform "always wrap the
projected shape" idiom would need HTTP's asymmetry lifted for the other three
protocols too (introducing a projected type they don't currently have, or
attaching to `Node` with an awkward no-op projection step) — ruled out as
larger than this design's scope, which is why the asymmetry stays.

### (c) Default argv boolean encoding: strict vs. loose — RESOLVED: strict

**Decision: strict (`"true"`/`"false"` only).** Consistency over convention —
chosen explicitly over loose to avoid a yaml-Norway-Problem-class
inconsistency: YAML 1.1's implicit-typing vocabulary (`y`/`n`/`yes`/`no`/
`on`/`off`/`true`/`false`, unquoted, all coerce to booleans) is exactly the
kind of loose membership set this decision avoids — it's why the country code
`"NO"` (Norway) silently coerces to boolean `false` in YAML 1.1 parsers, a
real-world case of a loose vocabulary swallowing a legitimate string value
that was never meant to be boolean-like. A loose CLI boolean set risks the
same class of collision (a legitimate string argument value that happens to
match a loose spelling). This is a knowing breaking change: it drops
`cli-api-projector`'s current `--flag=1`/`--flag=yes` support (see the loose
option's tradeoff below) for anyone currently relying on it.

- **Strict** (`"true"`/`"false"` only) — smaller surface, no case-sensitivity
  or abbreviation debate (`"y"`/`"yes"`/`"Y"`?), matches JSON boolean
  literal spelling exactly. This is `compile.ts`'s CURRENT universal
  behavior (`booleanLeaf`, compile.ts:504–520).
- **Loose** (`"1"`/`"0"`/`"yes"`/`"no"` in addition) — matches
  `cli-api-projector`'s OWN divergent coercion being deleted by this design
  (`coerceScalar`, cli.ts:917–923: `"true"`/`"1"`/`"yes"` → true;
  `"false"`/`"0"`/`"no"` → false), so choosing loose as the CLI default
  profile is behavior-preserving for existing CLI consumers; choosing
  strict is a breaking change for anyone currently passing `--flag=1`.

Prior art, briefly: zod's `z.coerce.boolean()` is the canonical cautionary
tale here — it coerces via JS truthiness (`Boolean(v)`), so ANY non-empty
string including the literal string `"false"` coerces to `true` (a widely
reported footgun, since `"false"` is a truthy string). Neither strict nor
loose as scoped here has that failure mode — both are explicit finite
membership tests, not `Boolean()` truthiness — but the zod trap is the
reason a "just be generous" third option (accept any truthy-looking string)
should stay off the table regardless of which of the two above is chosen.
CLI conventions broadly split too: many flag parsers treat presence alone
as `true` (`--verbose` needs no value) and reserve `--flag=false` /
`--no-flag` for explicit negation, which is a different axis from the
argv-STRING-value coercion question this section is actually about (argv's
`true` sentinel for bare-flag presence is already handled upstream in
`parseFlags`, before `coerceInput`/its replacement ever sees a string at
all).

---

## Anything from the settled list worth flagging

Nothing in the settled decisions conflicts with code reality as read. The one
previously-flagged item — the "Implementation checkpoint" under "Prerequisite:
meta unification" above (whether flat scalar keys, and map-shaped values like
`sourceMap`, fold cleanly through `FoldMeta`/`MergeTwoMeta`) — is now
RESOLVED (see that section). Three more implementation-relevant facts worth
surfacing for whoever builds the staged decode/validate work itself (not
conflicts, just detail the settled list assumed but didn't spell out):

- CLI's live-per-dispatch `getCliMeta` read (`cli.ts`, inside `runCli`'s
  per-request path — e.g. the `getCliMeta` call at `cli.ts:1172`, reading
  `sourceMap` fresh on every dispatch rather than once at projection time) is
  confirmed, by direct read, to be exactly what the meta-unification arc's
  "resolution lifecycle unifies on snapshot-at-projection" item describes —
  no test or doc reference to this being intentional was found in the same
  pass, consistent with the settled list's own characterization of it as an
  artifact rather than a load-bearing behavior.

- `compile.ts`'s `numberFamilyLeaf`/`booleanLeaf`/`dateLeaf` already draw
  exactly the `type` vs. `coerce` error distinction the staged model wants
  between `validateEncoding` and decode failures — "a string that failed to
  parse as a number is a coercion failure; any other wrong type… is a type
  error" (compile.ts:493–496 comment). The staged split doesn't need to
  invent this distinction; it needs to relocate it to the right stage and
  make it profile-driven instead of hardcoded to one string-coercion rule
  set.
- The per-leaf incremental compilation machinery `compile.ts` already has
  (`compileEntryFragment`/`compileDefsBlock`/`assembleValidatorModule`,
  compile.ts:1142–1265, used by both `build.ts` and
  `apply-validation-build.ts`'s Tier-2 caching) is exactly the shape a
  profile-driven `validateEncoding`+`decode` stage would need to plug into
  for caching to keep working — a leaf's compiled fragment already caches
  on the leaf's own IR fingerprint; a wire profile becomes a second
  fingerprint input alongside it, not a new caching mechanism.

Two known doc-drift fixes made alongside this update, both stale claims that
predated `http.source()` landing (commit `9bd373a`): `docs/guide/decode.md`
said "there is no `meta`-level directive that wires it in through
`op()`/`api()` yet" (twice — §3 and the closing summary); this design doc's
own now-superseded open-question (b) section repeated the same stale claim.
Both fixed to describe `http.source()` as the existing authoring mechanism —
see decode.md's own history for the fuller correction.

---

## Parked: semantic/effectful resolution (not in scope)

Recorded here for cross-reference, tracked as an open item in `TODO.md`
(project convention: cross-project/cross-session open items go there, not
left live only in conversation history) — NOT part of this design.

A possible distinct **resolve** stage — e.g. turning a validated `uid` into a
looked-up `User` — was discussed and explicitly parked as a separate concern
from wire profiles: profiles stay pure (encoding ⊕ decoding only, no I/O), and
this stage would sit AFTER `validateConstraints` if it's ever built, anchored
on branded types (a `uid: Branded<string, "UserId">` field the resolve stage
consumes and a `user: User` field it produces). Three shapes were on the
table, in order of preference:

1. **Effectful decoders in profiles** — rejected. Breaks the staged model's
   `decode` totality-by-construction guarantee (this doc's "The staged model"
   section) and the profile-purity property the whole design otherwise holds
   — decode would need an error/pending path for a lookup that can fail or
   take time, undoing exactly the simplification splitting `validateEncoding`
   from `decode` was meant to buy.
2. **A distinct resolve stage** — favored shape IF this is ever built. Keeps
   profiles pure; the effectful step is its own named stage after
   `validateConstraints`, with its own error taxonomy separate from
   `ValidationError`.
3. **Handler-level** (status quo) — a handler does its own lookup internally,
   no framework involvement. Simplest, and already how every handler in the
   codebase works today; the tradeoff against a resolve stage is purely
   whether centralizing the pattern (shared caching, consistent error
   shaping across leaves that all resolve a `uid`) is worth a new stage.
