# Wire profiles + staged decode/validate

## Status

Design settled in conversation with the user (2026-08). The prerequisite arc
— meta unification / HTTP directive dissolution, see immediately below — has
LANDED (2026-08), in two phases:

- **Phase 1**: `meta.http.directives`/`HttpDirective`/the fold-by-`kind`
  `getHttpMeta` read-time switch are deleted; HTTP now authors flat
  `meta.http.*` keys directly, matching cli/mcp/graphql/json-rpc's existing
  shape.
- **Phase 2** (five-protocol convergence): `UncoveredSourceParams`'s static
  op()-time source-coverage check — previously exercised for HTTP via
  `http.source()`'s literal-preserving `ResolvedSourceMap` — now has the same
  literal-preserving authoring path for cli/mcp/graphql/json-rpc too
  (`cli.source()`/`mcp.source()`/`graphql.source()`/`jsonrpc.source()`, each
  package's own `source.ts`), built on shared machinery extracted into
  api-tree's input.ts (`SourceMapInput<Store>`/`ResolvedSourceMap<M>`/
  `resolveSourceMap`) rather than reimplemented per protocol — HTTP's own
  `http.source()` now calls this shared machinery too, not a local copy.
  CLI's resolution lifecycle also unified on snapshot-at-projection (see
  "Resolution lifecycle unifies on snapshot-at-projection" below). A
  consistency pass over the four non-HTTP protocols' `meta.<proto>` surfaces
  found them already shape-conformant (flat scalar/map keys, no envelope) —
  see `docs/design/directive-contract.md`'s per-protocol tables, updated to
  the unified story (and gaining a JSON-RPC section that page was missing
  entirely).

The staged decode/validate model itself (wire profiles, the
`validateEncoding`/`decode`/`defaults-fill`/`validateConstraints` pipeline)
has now LANDED, across four phases — **A** (`0cc83f0`, the type-ir
mechanism), **B** (`80e93d8`, `applyValidation`/codegen plumbing), **C**
(projector migration + retirement decisions), and **D** (below — defs/ref
recursion on the wire path, and the full retirement of the 2-arg
`applyValidation`/`compileValidatorModule` route phase C had deliberately
kept). This document captures the settled decisions this work implements;
see "Implementation trace (phase B)", "(phase C)", and "(phase D)" below for
the mechanism-level write-ups of what actually landed and the binding
choices made along the way.

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

### `UncoveredSourceParams` generalizes — LANDED (2026-08, phase 2)

The static source-coverage check (`UncoveredSourceParams`, api-tree's
input.ts) generalized from HTTP-specific `DirectivesOf`/`FindStoreForParam`
tuple-walking to all five protocols, walking `Meta.<proto>.sourceMap` directly
— simpler than the pre-migration directive-tuple walk, since there's no
array of `{kind:"source", map}` entries to fold at the type level, just one
flat map key per protocol. The type-erased-map guards (`string extends keyof
M`) stay load-bearing for the same reason they were pre-migration — a verb
bundle or other producer typed as an open DU would otherwise phantom-
contribute an erased map. The distribution guards that existed to make
`DirectivesOf` distribute over a directive-tuple union deleted along with the
phantom `HttpDirective` member they existed for (phase 1).

Mechanically, `op()`'s own `CheckedContributions`/`UncoveredSourceParams`
wiring (node.ts) is protocol-BLIND — it was already checking any leaf's
folded `Meta`, whichever namespaces happened to contribute a `sourceMap`,
before phase 2 landed. What phase 2 actually closed was a LATENT gap: cli/
mcp/graphql/json-rpc had no `http.source()`-equivalent helper, so a
`sourceMap` value only stayed literal-keyed by the accident of being written
as a raw object literal directly in an `op()` call — passing it through any
intermediately-typed variable silently widened it back to the index-
signature `SourceMap`, defeating the check without any error. Verified: none
of the four had a regression test proving the check was actually live for
them before this landed.

The fix: `cli.source()`/`mcp.source()`/`graphql.source()`/`jsonrpc.source()`
(each protocol's own `source.ts`) — literal-preserving authoring helpers
mirroring `http.source()`, making literal-preservation the DEFAULT authoring
path instead of an accident of writing the literal inline. The mapped type
and shorthand-expansion runtime logic these all share (`SourceMapInput<Store>`/
`ResolvedSourceMap<M>`/`resolveSourceMap`) now live once, in api-tree's
input.ts, generic over each protocol's own store-name type — `http.source()`
itself was rewritten to call this shared machinery rather than keep its own
copy, so the mechanism genuinely isn't a per-protocol reimplementation.
Regression tests (`source.test.ts` in each of the four packages, mirroring
`http-api-projector/src/verbs.test.ts`'s existing `http.source()` coverage)
confirm the op()-time check now fires for all five protocols, not just HTTP.

### Resolution lifecycle unifies on snapshot-at-projection — LANDED (2026-08, phase 2)

CLI's prior `getCliMeta` read was live, per-dispatch (`cli.ts`'s old
`runCli`-inline read, not resolved once at build/projection time) — verified
this was an artifact, not a load-bearing behavior: no test or doc relied on
meta being re-read per dispatch rather than snapshotted once.

CLI gained a snapshot, but not the SAME shape as mcp/graphql/json-rpc/HTTP:
those four build a whole-tree dispatch table (`Map<string, Dispatch>`, or
`HttpRoute` for HTTP) ONCE, ahead of any individual request, precisely
because their dispatch key (a flat name, or a compiled route) is knowable
without seeing a specific request's own data. CLI can't do the same —
`resolveLeaf`'s `fallback` (wildcard-capture) traversal means a leaf's
terminal argv segment can BE a runtime slug value only knowable from that
invocation's own argv, so there's no whole-tree `Dispatch` map to precompute
ahead of a specific call the way the other four have. The minimal equivalent
CLI actually landed: `Resolved` (cli.ts, the per-invocation leaf-resolution
result `resolveLeaf` returns) grew a `sourceMap` field, populated once,
inside `resolveLeaf`, at the exact point a leaf is found — before any
subsequent per-request step (including an `await` gap, the destructive-
confirmation prompt) runs. Every later read in `runCli` consumes
`target.sourceMap` (the snapshot), not a fresh `getCliMeta(...)` call. Same
"resolved once, not re-derived per read site" property the other four
protocols' `Dispatch`/`meta.http` snapshots have, scoped to what CLI's
per-argv dispatch shape actually allows precomputing.

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

## Implementation trace (phase B)

Phase A (commit `0cc83f0`) landed the type-ir mechanism (`WireProfile`,
`compileWireEntryFragment`, `compileConstraintsFn`, `assembleWireModule`,
`compileWireModule`, `wireValidatorKey`, `wireTypeText`) — purely additive,
zero change to `check`/`errors`/`parse`. Phase B wires that mechanism onto
`applyValidation`'s call-site-anchored codegen (`apply-validation-build.ts`)
and the runtime (`apply-validation.ts`). The design doc above specifies the
model; several MECHANISM decisions below were not specified and were made by
this implementer — flagged explicitly as this implementer's binding choice,
not a re-derivation of anything the doc already settled.

### `protocol` as `applyValidation`'s optional third argument

**Decision (this implementer's, not pre-specified):** `applyValidation(key,
tree, protocol?)`. Omitting `protocol` is the COMPLETELY UNCHANGED 2-argument
behavior — same codegen surface (`ValidatorMap`), same runtime shape. A
3-argument call opts into wire-profile-driven validation for that
`(key, protocol)` pair, resolved against a SEPARATE, ADDITIVE map
(`WireValidatorMap`) that `createApplyValidation` takes as an optional SECOND
argument (default `{}`). This is the smallest change consistent with the
doc's zero-setup story: every existing codegen'd module, every existing
test/fixture, keeps compiling and running with ZERO changes — a 3-arg call
site is purely additive on top.

A tree validated once and shared across two protocols with DIFFERENT wire
shapes needs one 3-arg call/key per protocol (each protocol claims its own
key, same as any two independent trees would); two protocols that happen to
resolve to the SAME base profile (mcp+graphql+jsonrpc, all `jsonProfile`) can
share one key/call if the tree itself is one tree for both. `usedKeys`
staying key-only (not key+protocol) is what makes reusing one key across two
different protocols a loud double-registration error rather than a silent
last-wins — the same duplicate-key discipline the 2-arg path already has.

### Per-protocol store→encoding derivation (`packages/api-tree/src/wire-derive.ts`)

`deriveFieldProfiles(protocol, sourceMap, method, pathParamNames)` returns
either `{ profile }` (identity/mcp/graphql/jsonrpc — uniform, no meta read at
all) or `{ fieldProfiles, defaultProfile }` (http/cli — genuinely per-field).
Store→encoding tables:

- **cli**: `flag`/`path`/`env` all → `argvProfile`-style encoding (argv is
  uniform today) — routed through the SAME per-store table lookup as HTTP
  anyway, not shortcut straight to `argvProfile`, so a future non-uniform CLI
  store only needs a table entry. Default store `"flag"`, except a field
  whose name matches the leaf's own tree-relative path's fallback-segment
  name(s) (the `:name` convention `apply-validation.ts`'s `fallbackSegment`
  already uses) — those default to `"path"` instead.
- **http**: `path`/`query`/`header` → `queryProfile`-style encoding;
  `body` → `jsonProfile`-style encoding. Default store is
  `primaryStoreForMethod(method)` — REIMPLEMENTED in `wire-derive.ts` (api-tree
  cannot depend on http-api-projector; the dependency runs the other way),
  mirroring `http-api-projector/src/decode.ts`'s function of the same name
  exactly (GET/HEAD/DELETE → query, else → body) — except a field matching a
  fallback-segment name defaults to `"path"` instead, same convention as CLI.
  An explicit `sourceMap` override always wins over either default.

**SUPERSEDED (2026-08-05, session
https://claude.ai/code/session_011tFKVomiW7x2MkeRg3mw88) — was "KNOWN
LIMITATION, documented explicitly":** this paragraph originally documented
HTTP's real per-field source resolution (`http-api-projector`'s `assemble`)
as using the FULLY PROJECTED route's mount position for path-slug detection,
with `http.moveTo` able to relocate a leaf and change its EFFECTIVE
path-param set — invisible to codegen's PRE-projection static analysis, so
`wire-derive.ts`'s HTTP branch (using only the leaf's own LOCAL, pre-
projection tree-relative path segments) was correct for the dominant case and
an approximation when `moveTo` relocated a leaf.

That runtime — where a `moveTo`-relocated leaf's implicit path binding
depended on where it ended up — no longer exists. `moveTo` is now purely an
address transform: a leaf's field↔store binding is a pure function of its
AUTHORED declarations (its own pre-moveTo local path-slug ancestry, plus any
explicit `sourceMap`/`http.source()` entry), never of where `moveTo`
relocates it. See `http-api-projector/src/route.ts`'s `Sources.
authoredPathParams` (stamped by `naiveTransform`, before any rewriter runs)
for the runtime mechanism, and `findRouteSourceCoverageProblems` for the new
`"unfillable-path"` wire-time check this enables (a leaf whose authored slug
or explicit path-sourceMap doesn't survive to its final mounted position now
fails loudly at router-construction time instead of silently losing the
field).

`wire-derive.ts`'s HTTP branch needed NO change: reading only the leaf's own
local, pre-projection path segments IS now the exact definition of
authored-path-slug detection, not an approximation of a runtime that resolved
against the final projected position — that runtime is gone. This mirrors
(is not a contradiction of) the existing same-file-only scope cut
`traceNodeType`'s doc comment (`apply-validation-build.ts`) already documents
for tree tracing.

### Static-meta-read investigation (decision 4/5) — (a) panned out, with one real gap

Task instructions asked to investigate, before assuming, whether reading a
leaf's declared `meta` as a runtime VALUE (not just its TYPE) via static AST
analysis had any precedent in this codebase. It does:
`tree.ts`'s `mcpMetaOverride` already reads `meta.mcp.name`/`meta.mcp.segment`
as string-literal VALUES off a resolved `Node` TYPE
(`checker.getPropertyOfType`/`getTypeOfSymbolAtLocation`/`isStringLiteral()`)
— option (a) from the task ("find a legitimate static-meta-read path").
Generalized (purely additively — `mcpMetaOverride` itself is untouched) into
two new exported `tree.ts` functions:

- `readMetaStringLiteral(nodeType, namespace, key, loc, checker)` — the same
  technique for an arbitrary namespace/key (`meta.http.method`/`.verb`).
- `readMetaSourceMap(nodeType, namespace, loc, checker)` — one level deeper:
  enumerates `sourceMap`'s own literal keys (`getPropertiesOfType`, the same
  enumeration `walkNodeType` already uses for `children`) and reads each
  entry's `store`/`key` as string literals.
- `readMetaEncodingMapProfileNames(nodeType, namespace, loc, checker)` — the
  same enumeration for `encodingMap`'s STRING-form (base-profile-name)
  entries.

Getting a leaf's own node TYPE into `apply-validation-build.ts`'s hands
required one additive change to `tree.ts`'s `OnLeaf` callback type: appended
a trailing `nodeType: ts.Type` parameter. Purely additive by TypeScript's own
function-type compatibility rule (a callback declaring fewer parameters
satisfies a type requiring more) — every existing `OnLeaf` implementation
(`extractRouteTypeRefs`, the unchanged 2-arg `extractApplyValidationTypeRefs`)
needed zero changes. Option (b) (`getConstantValue`/partial evaluation of
object literals) was not separately investigated once (a) panned out.

**The one real gap:** `encodingMap`'s FUNCTION-form entry
(`(w: FieldValidWire) => TField`) has no analogous read. A function value has
no literal TYPE for the checker to hand back — unlike a string, there is
nothing to read "as a value." Emitting a reference to it in the generated
module would need either (a) the function being a named export elsewhere
codegen could import (not what the design describes — it's authored inline,
per field, in the meta object literal) or (b) copying its source text into
the generated module (fragile: closures, scoping; no existing codegen path in
this codebase does this — `guardAnnotation`'s cross-file resolution imports a
TYPE reference, never re-emits a VALUE's source). Neither is implemented. A
function-valued `encodingMap` entry is silently OMITTED by
`readMetaEncodingMapProfileNames` — the field falls through to whatever the
protocol's own derivation would otherwise assign, exactly as if no override
had been declared, rather than producing a wrong or silently-inconsistent
result. This is the one part of decision 4/5 left as a documented gap, not
"fully wired."

`encodingMap`'s STRING-form (base-profile-name) entries ARE fully wired for
`http`/`cli` (the two protocols with per-field derivation at all) in
`extractWireApplyValidationTypeRefs`. Applying `encodingMap` overrides to the
UNIFORM protocols (identity/mcp/graphql/jsonrpc) is a further, deliberate
scope cut — it would require those protocols to also go through the
composite (per-field) derivation path, which their base wire shape doesn't
otherwise need; left for a future phase if a real need for it surfaces.

### `encodingMap` field name

Used exactly `encodingMap`, as specified — sibling of `sourceMap` in the same
per-protocol meta namespace, same keyed-merge (last-wins per key) semantics.
No dedicated authoring helper (à la `http.source()`) was built: given the
static-meta-read gap above only lets the STRING-form entries be read at all,
and reading a raw literal directly (the same "accident of writing the object
literal inline" `sourceMap` itself relies on pre-`http.source()`) is
sufficient for that form, a helper would only buy literal-preservation for
the FUNCTION form this phase can't read anyway. Revisit if/when the function
form gets a real read path.

### `ValidatorMap`/`createApplyValidation` shape

**Decision (this implementer's):** a SECOND, OPTIONAL parameter —
`createApplyValidation(validators, wireValidators = {})` — rather than
reshaping `ValidatorMap` itself. This is exactly the "buys backward
compatibility for free" shape the task flagged as likely: every existing
single-argument call site (every already-codegen'd module, every existing
test/fixture) keeps compiling and running unchanged. `WireValidatorMap` is
`Record<key, Record<path, Partial<Record<ProtocolName, GeneratedEntry>>>>` —
one extra nesting level (protocol) versus `ValidatorMap`. `injectValidators`/
`collectUncoveredLeaves` (the structural walk) are UNCHANGED — a 3-arg call
flattens `wireValidators[key]` down to the ordinary `path -> entry` shape
those functions already walk (`flattenWireForKey`), keeping only the entries
for the call's own `protocol`, so neither function needed to learn about
protocols at all.

### A genuine, previously-unexercised bug found along the way

`compileConstraintsFn` (compile.ts, Phase A) gives each call its own fresh
`GenCtx`, whose const-naming counter (`__ref0`, `__ref1`, ...) always starts
at 0. Splicing more than one ENTRY's `compileConstraintsFn` output into one
module at shared scope — exactly what `assembleWireModule` (compile.ts) and
this phase's own `assembleWireApplyValidationModule`
(`apply-validation-build.ts`) both do — produces a DUPLICATE `const`
declaration whenever two entries each need at least one hoisted const (the
common case: any plain typed field's `type`-kind error references one via
`refLiteral`). Reproduced directly against `compileWireModule` with two
plain two-field entries (no api-tree involved) — confirmed this is a Phase A
mechanism issue, not something Phase B introduced, and that no existing test
exercises more than one ENTRY in one wire module (every existing multi-profile
test uses a single entry across several profiles, whose fragments are
correctly IIFE-scoped and unaffected — only the constraints functions'
module-scope consts collide).

Worked around, NOT fixed at the root (`compileConstraintsFn`/`GenCtx` are out
of this phase's mandate to modify — see "What not to do"), by a purely
textual, per-entry disambiguation at the assembly layer in
`apply-validation-build.ts` (`disambiguateConstraintsConsts`): renames only
the const names a given entry's OWN `compileConstraintsFn` output declares,
with a per-entry-unique suffix, before splicing it into the module.
`assembleWireModule`/`compileWireModule` (compile.ts) still have the
UNDERLYING bug for any caller that compiles ≥2 entries into one module
directly — flagged here for whoever picks that up, not silently patched
there.

A second, unrelated, harmless byte-level oddity found in the same file:
`wireValidatorKey`'s template literal (`` `${name} ${profileName}` ``, Phase A)
has an actual U+0000 (NUL) character where the source visually reads as a
plain space between the two interpolations — confirmed via a raw byte read of
the committed file, not a rendering artifact. Functionally harmless (every
caller goes through `wireValidatorKey`/`wireValidatorKey`-derived keys
consistently, so the literal byte value never needs to be a real space), but
worth a follow-up cleanup pass since it makes the generated key visually
unreadable and could confuse anyone debugging by printing it directly.

---

## Implementation trace (phase C) — LANDED (2026-08)

Phase C's mandate: fix the two phase-A bugs phase B flagged, migrate every
projector onto staged validation deleting the legacy layers, retire the old
universal-coercion path where tenable, migrate `examples/library-api`, and
bring the docs/tests up to the staged story.

### The two phase-A bugs — fixed at root, not worked around

- `compileConstraintsFn`'s `GenCtx` always started its const-naming counter
  at 0 per call, so splicing ≥2 entries' constraints fns into one module's
  shared scope produced duplicate `const` declarations. Fixed at the root:
  `GenCtx` now takes an optional `namespace` (default `""`, so every
  existing single-`GenCtx`-per-module caller is byte-identical), and
  `compileConstraintsFn` passes the entry name as that namespace — every
  entry's hoisted names are module-unique by construction. Phase B's
  `disambiguateConstraintsConsts` (a purely textual post-hoc rename at the
  assembly layer) is deleted; `assembleWireModule`/
  `assembleWireApplyValidationModule` now just splice `fn.lines` directly.
- `wireValidatorKey`'s template literal had an actual U+0000 byte where the
  source visually read as a space. Replaced with a real space; no caller
  needed a workaround since (per the phase-B trace) every caller went through
  `wireValidatorKey` consistently, so nothing depended on the byte value.

Regression tests added in `packages/type-ir/src/wire-profiles.test.ts`: a
two-entry module that previously threw a duplicate-const `SyntaxError` on
eval, and a byte-level assertion on `wireValidatorKey`'s output.

### Projector migration — legacy layers deleted, staged model wired in

Per protocol, migrated to `applyValidation(key, tree, protocol)`:

- **cli-api-projector**: `coerceInput`/`applyDefaults`/`validateRequired`
  (including the loose boolean vocabulary `"1"`/`"yes"`/`"0"`/`"no"`) are
  deleted. `runCli` passes `buildInput`'s raw assembled input straight to the
  handler unconditionally — a leaf covered by `applyValidation(key, tree,
  "cli")` gets decode+validate from the generated wire validator; an
  uncovered leaf gets raw wire values with NO coercion at all (the accepted
  zero-setup tradeoff — `--flag=1`/`--flag=yes` no longer coerce to a
  boolean; they pass through as the literal string, or get a structured
  rejection if the leaf IS wired and its wire profile is strict-boolean).
- **mcp-api-projector**: `validateAgainstSchema` (the hand-rolled `typeof`
  gate + its own non-`ValidationError` error strings) is deleted. Args pass
  straight to the handler unconditionally; a covered leaf gets identity +
  JSON-date validation via `applyValidation(key, tree, "mcp")` — strict, no
  coercion of stringified numbers, structured `ValidationError`s on
  rejection.
- **graphql-api-projector** / **json-rpc-api-projector**: neither package had
  grown a coercion fallback in the first place (confirmed by direct search,
  not assumed) — the design doc's own "History" section only ever named
  cli/mcp as the two packages that diverged. Both now document
  `applyValidation(key, tree, "graphql"/"jsonrpc")` as the staged path
  alongside the still-supported 2-arg form.
- **http-api-projector**: never had a projector-local coercion fallback
  either (the old `compileValidatorModule` path already covered HTTP via the
  2-arg call) — verified `route.ts`'s existing Result→400 mapping already
  handles a wire-validator-rejected leaf with zero route.ts changes needed.
  Docs now show `applyValidation(key, routes, "http")` as the recommended
  form (per-field query/path/header coercion via `queryProfile`, JSON-body
  `Date` coercion via `jsonProfile`, composite per-field derivation via
  phase B's `compileWireEntryFragmentComposite`/`wire-derive.ts`), alongside
  a new end-to-end test proving `?page=3` decodes to the number `3` and
  `?page=notanumber` gets a 400.
- Every projector's `isApplyValidationWrapped` sniff site is deleted, along
  with the export itself and its backing `appliedHandlerBrand` `WeakSet`
  (`apply-validation.ts`) — decode+validation now run unconditionally on
  every leaf `applyValidation` wraps; there was nothing left to sniff/skip.
  Tests that asserted "wrapped" now compare handler IDENTITY (a covered
  leaf's handler is a freshly-built wrapper, never the original function)
  instead of calling a brand-check API.

### Retirement of the old universal-coercion path — PARTIAL, by design, not an oversight

The design doc's end state calls this "staged-only." Investigated whether the
2-arg `applyValidation(key, tree)` route and `compileValidatorModule` could be
fully deleted in this phase. **Blocked on one real, load-bearing capability
gap, not inertia**: the 2-arg path supports `shouldShare`/defs structural-
sharing (a type reused across several leaves' inputs compiles to ONE shared
def, referenced from every call site —
`packages/api-tree/src/__fixtures__/apply-validation-sharing-input.fixture.ts`
exercises this directly against `buildApplyValidationModuleSource`). The
staged wire path has an explicit, documented scope cut against exactly this
("No `defs`/`ref` recursion support for wire profiles", compile.ts's
wire-profiles section header) — deleting the 2-arg path in this phase would
have silently dropped defs-sharing support for `applyValidation`-based
codegen entirely, with no replacement. Per this phase's own instructions
("stop and report... instead of leaving both silently alive"): both paths
are kept, but NOT silently — `docs/guide/codegen-cli.md`'s "Connecting to
`applyValidation`" section now states explicitly which capability each path
buys and recommends the 3-arg form as the default, reserving the 2-arg form
for the one case (defs sharing) it alone covers.

What DID retire cleanly in this phase (no capability loss): every
`isApplyValidationWrapped` sniff site (above) — that mechanism had no
differentiating capability, only an obsolete exclusivity check with nothing
left to be exclusive with.

`packages/api-tree/src/cli.ts` gained `build-wire`/`watch-wire`/`check-wire`
subcommands (mirroring `build`/`watch`/`check`, but calling
`buildWireApplyValidationModuleSource` instead of
`buildApplyValidationModuleSource`) so the staged path has its own CLI entry
point — this was a genuine gap (no command invoked the phase-B build
functions from the actual CLI at all before this phase) rather than a
retirement decision.

### `examples/library-api` migration

`tree.ts`'s single `applyValidation("books", api)` call became
`applyValidation("books", api, "http")` — the example's tree is only ever
DISPATCHED over HTTP (MCP's use of the tree, in `app.test.ts`, is schema
extraction via `toTools`, not a running MCP server), so there is exactly one
protocol's key to claim; a tree genuinely dispatched over two divergent wires
would claim one key per protocol instead (see `docs/guide/codegen-cli.md`).
`package.json`'s `codegen`/`codegen:check` scripts switched from
`build`/`check` to `build-wire`/`check-wire`. `app.test.ts`'s
`isApplyValidationWrapped` uses converted to handler-identity checks; its
direct `createApplyValidation({...})` construction converted to the 2-arg-map
form's wire equivalent, `createApplyValidation({}, { books:
wireValidatorsByKey.books })`.

### Docs and tests

`docs/guide/codegen-cli.md` rewritten to describe both builder pipelines and
both call-site forms side by side, with the 3-arg form as the recommended
default. `docs/guide/decode.md`'s `sources.transform` section corrected — the
"parsing a numeric string" example was stale (that coercion is now upstream,
in the wire profile, when a leaf is wired through `applyValidation(key, tree,
"http")`). `docs/design/routing-and-transforms.md`'s `applyValidation`
integration-point examples updated to the 3-arg form; its CLI/MCP fallback
history section documents the retirement. Per-package docs
(`packages/api-tree/README.md`, `docs/reference/framework/cli.md`,
`docs/reference/framework/mcp.md`) updated by the migrating agents themselves
(see each package's own git history for that package's specifics).

Test additions beyond the regression tests already listed above: a shared-key
-across-protocols test (`packages/api-tree/src/apply-validation-build.test.ts`)
confirming one `applyValidation` call registered under one protocol tag
produces a wrapped tree that behaves identically regardless of which
protocol's server later dispatches through it, when the involved protocols
share a base profile (mcp/graphql/jsonrpc, all `jsonProfile`); an HTTP
query-param decode end-to-end test (`packages/http-api-projector/src/
wire-apply-validation.test.ts`) proving `?page=3`/`?page=notanumber` decode/
reject correctly through a real `fetch` call; per-package tests for CLI's
raw-passthrough/strict-boolean behavior and MCP's structured stringified-
number rejection (see each package's own test files).

---

## Implementation trace (phase D) — LANDED (2026-08)

Phase D's mandate: close phase C's one deliberately-kept blocker (the 2-arg
`applyValidation(key, tree)`/`compileValidatorModule` path, kept only for its
`shouldShare`/defs structural-sharing capability), then retire the 2-arg path
now that the gap is closed, migrate every consumer, and bring docs/tests up to
the single-mechanism story.

**Defs/ref recursion landed on the wire path first** (commit `b5c7254`, this
same session, prior to the retirement below): `compile.ts`'s
`compileConstraintsFn` gained an optional `externalDefNames` param (seeding
`ctx.defNames` so a `ref` resolves via the existing `validateHandlers.ref`
machinery); the decode layer gained `WireDefsRegistry` (one compiled
wire-decode function + one `ValidWire` type alias per `(defName, profileName)`
pair actually referenced, lazily memoized, self-recursive-safe by reserving
the function name before generating its body); `assembleWireModule`/
`compileWireModule` gained optional defs-block params; api-tree's
`extractWireApplyValidationTypeRefs` gained the same `shouldShare`/
`SharingRegistry`/`finalizeSharedDefs` opt-in the 2-arg path already had, and
`WireApplyValidationCarryForwardState` gained a real `defNamesFingerprint`
(previously stubbed to the empty set).

**Retirement.** With that gap closed, the 2-arg path had no capability the
3-arg path lacked — deleted: `extractApplyValidationTypeRefs`,
`buildApplyValidationModuleSource`/`buildApplyValidationModuleSourceIncremental`/
`buildApplyValidationModuleCached`, `writeApplyValidationModule`/
`writeApplyValidationModuleCached` (`apply-validation-build.ts`), and
type-ir's module-assembly layer they were backed by —
`compileValidatorModule`/`compileEntryFragment`/`assembleValidatorModule`/
`CompiledEntryFragment` (`compile.ts`). `compileDefsBlock`/`CompiledDefsBlock`
were NOT deleted — the wire path's own build functions use them for the
constraints layer's shared `defs` block. `compileValidator` (the standalone,
non-module AOT-compile projector) was NOT touched — a separate, still-live,
general-purpose API with its own extensive test suite, unrelated to the
`applyValidation` codegen route.

### Decision A: what a 2-arg `applyValidation(key, tree)` call does now

**Picked: sugar for the explicit `"identity"` protocol**, at both layers:

- **Codegen** (`extractWireApplyValidationTypeRefs`): a call site's absent
  `protocol` resolves to `"identity"` instead of being skipped — every
  `applyValidation` call site, 2-arg or 3-arg, is extracted and compiled
  through this ONE pipeline now.
- **Runtime** (`apply-validation.ts`'s `createApplyValidation`): a 2-arg call
  (`protocol` omitted) resolves against the legacy, hand-authored
  `ValidatorMap` FIRST — so a caller that builds `createApplyValidation` from
  a hand-rolled map directly (independent of codegen, as several of this
  package's own runtime tests do) keeps working unchanged — falling back to
  `WireValidatorMap` tagged `"identity"` when `ValidatorMap` has no entry for
  that key. `assertValidationCoverage` mirrors the same resolution.

Rejected: making an omitted protocol a build-time/runtime ERROR. The sugar
reading is non-breaking (every existing 2-arg call site — hand-authored map
tests, and any codegen'd module — keeps working with zero source changes) and
is exactly the reading the design's own vocabulary already supports: "the
identity profile is `validateEncoding` reduced to a trivial check plus the
full `validateConstraints` pass — i.e. what today's check/errors/parse do for
an in-process, already-typed value with no wire in between" (see "The staged
model" above). The pre-codegen stub story is unaffected either way — a leaf
under an unregistered key still gets no decode/validation, loud only via
`assertValidationCoverage`.

**One accepted, intentional behavior change**, named here rather than left
silent: the OLD 2-arg path's `parse()` (`compileValidatorModule`'s output)
ran through `compileValidator`'s universal, protocol-blind from-string
coercion (`numberFamilyLeaf`/`booleanLeaf`/`dateLeaf` — coercing ANY numeric
string regardless of whether it plausibly arrived over a wire). A 2-arg call
site now resolves to `identityProfile` instead, which is strict — no
coercion at all. Concretely: a 2-arg `applyValidation("books", httpRoutes)`
call site that used to silently coerce a query string like `"3"` to the
number `3` now rejects it as an encoding error, because `identityProfile`
correctly assumes its input is already the right in-process shape, not a raw
wire value. This is a CORRECTNESS fix, not a regression — that exact
accidental universal coercion is the "Problem" this whole design document
exists to supersede (see "Problem" above: "a single builtin rule set is
simultaneously too permissive... and not permissive enough"). No production
call site in this repo was affected: `examples/library-api` moved to the
3-arg `applyValidation("books", api, "http")` form back in phase C; every
remaining 2-arg call site in the tree is either a runtime test exercising
`createApplyValidation`'s hand-authored-map path directly (never touches a
wire value at all) or a codegen fixture with no HTTP-string-coercion
expectation.

### Decision B: CLI subcommand naming

**Picked: `build-wire`/`watch-wire`/`check-wire` retired outright, folded
into `build`/`watch`/`check`** (which now run what `build-wire`/etc. used to)
— not kept as a deprecated alias. With one mechanism left, a `-wire`
qualifier that existed only to disambiguate two coexisting pipelines is
noise, not signal. Matches this repo's own precedent for a "one mechanism
left" retirement: `wrapValidators`/`isValidatorWrapped`/`isApplyValidationWrapped`
were all deleted outright (not kept as compatibility shims) once the
mechanism they existed to disambiguate against had nothing left to be
exclusive with.

### Migration

`examples/library-api`'s `package.json` `codegen`/`codegen:check` scripts
switched from `build-wire`/`check-wire` back to `build`/`check` (no source
change needed in `tree.ts` — it already used the 3-arg form since phase C;
regenerating `src/generated/apply-validation.ts` produced byte-identical
output). `docs/guide/codegen-cli.md` collapsed to describe the single
pipeline. `packages/api-tree/README.md`/`packages/type-ir/README.md` updated.
Tests: `apply-validation-build.test.ts`'s 2-arg-specific describe blocks
(extraction, generated-module shape, caching, the ported build.test.ts edge
cases — named-type import resolution, builtin/DOM structural inlining, defs
sharing, multi-root Program sharing) ported onto
`extractWireApplyValidationTypeRefs`/`buildWireApplyValidationModuleSource*`
against the SAME fixtures (2-arg call sites, now processed as `"identity"`);
`cache.test.ts`/`cache-v3.test.ts` (which use a 2-arg fixture purely as a
generic exercise vehicle for `cache.ts`'s own mechanics, not to test
anything 2-arg-specific) migrated to the wire path's cached/incremental
functions, with leaf-artifact keys updated to fold the now-implied
`"identity"` protocol in via `wireValidatorKey`. `type-ir/src/compile.test.ts`
lost its `compileValidatorModule`-specific tests; the regression coverage
they existed for (a recursive def's nested-field guard annotation using the
locally-declared alias, not an unresolved bare name) is preserved by
asserting the same substrings against `compileValidator`'s (kept) standalone
output instead — the underlying mechanism (`guardAnnotation`/`compileDefs`)
is shared code, and `compileValidator`'s own tsc-typecheck regression test
already proved it bug-free for this exact shape.

---

## Implementation trace (phase E) — LANDED (2026-08-05, session
https://claude.ai/code/session_011tFKVomiW7x2MkeRg3mw88)

Phase E's mandate: close the one real gap the phase-B trace's "Static-meta-
read investigation" section documented — `encodingMap`'s FUNCTION-form entry
(`(w: FieldValidWire) => TField`) had no codegen path at all and was silently
OMITTED, falling through to the protocol's fused default decode as if no
override had been declared. This phase wires the function form in end to
end: static existence detection, per-field hook emission, a runtime wrap-time
hook injection mechanism, a new `"decode"` error kind, two-directional
stale-module detection, authoring-site decoder typing (`WireOf`), and tests.

### The function never moves — where the pieces live

Per the settled design: the decoder function is declared in tree meta
(`meta.<proto>.encodingMap.field = (w) => …`) and stays exactly there — no
inlining, no import emission, no source re-emission. Codegen only ever
detects its EXISTENCE (a field name), never its value or body:

- `tree.ts`'s new `readMetaEncodingMapFunctionFields(nodeType, namespace,
  loc, checker)` — `readMetaEncodingMapProfileNames`'s sibling. Where the
  string form reads a literal VALUE off a resolved TYPE, this one only
  checks whether a property's TYPE carries a call signature at all
  (`checker.getSignaturesOfType(fieldType, ts.SignatureKind.Call).length >
  0`) — a function value has no literal payload for the checker to hand
  back, so existence is the only question codegen can (and needs to) answer.
- `apply-validation-build.ts`'s `extractWireApplyValidationTypeRefs` calls
  this alongside the existing string-form read (http/cli only, same scope
  cut the string form already has), producing each leaf's `hookFields:
  readonly string[]` (sorted, for deterministic fingerprinting) —
  `WireApplyValidationLeaf` gained this field; `flatWireEntries`/
  `compileWireLeafFragment`/`fingerprintableDerivation`'s caller all thread
  it through.
- `type-ir/compile.ts`'s `wireObjectWithFieldProfiles` gained an optional
  `hookFields` parameter (default empty — every pre-existing caller
  unaffected): a hook-covered field still runs its ordinary
  `genWireEncodeDecode` STATEMENTS (the same `validateEncoding` check every
  other field gets — reused unmodified, not duplicated) but discards that
  call's own decoded `outExpr`; if no NEW error was pushed for that field
  (tracked via an `errs.length` snapshot before/after), the assignment
  becomes `out[name] = hooks[name](fv)` — `fv` the RAW wire field value,
  which IS `ValidWire` once `validateEncoding` passed (no existing leaf
  handler mutates its input before decoding it) — wrapped in try/catch. A
  missing/non-function hook or a thrown value both become a `"decode"`
  `ValidationError`, never an uncaught exception from the generated code
  itself. `compileWireEntryFragmentComposite` threads `hookFields` through
  and emits a second, optional `hooks` parameter on the generated `parse`
  (`compileWireEntryFragment`'s uniform-profile path is unaffected — hooks
  are a per-field-name concept and that path never dispatches per field
  name, matching the string form's own uniform-protocol scope cut).
- `CompiledWireEntryFragment` and `build.ts`'s `GeneratedEntry` both gained
  `hookFields: readonly string[]` (the latter optional, defaulting to
  absent for every hand-authored entry) — the one static surface both the
  wrap-time stale-module check and the incremental-build fingerprint need,
  embedded VERBATIM as a literal property on the generated entry object so
  it survives into the runtime module with zero extra plumbing.
- `apply-validation.ts`'s `createApplyValidation`/`injectValidators` now
  thread the call's own literal `protocol` argument down to a new
  `resolveHooks` helper, which reads the REAL function values off the
  actual running tree's `meta.<protocol>.encodingMap` (`readEncodingMapHooks`
  — the runtime counterpart of `readMetaEncodingMapFunctionFields`) and
  passes them as `entry.parse`'s second argument. This is the ONE place the
  real function value is ever touched — at WRAP time, not codegen time,
  exactly as settled.

### The `"decode"` `ValidationError` kind

Added to both copies of the `ValidationError` DU `type-ir/compile.ts` keeps
in sync (the internal type and `VALIDATION_ERROR_TYPE_SOURCE`, its
generated-module string-literal mirror):

```ts
| { kind: "decode"; path: string[]; message: string }
```

Chosen over reusing `"encoding"` or `"coerce"`: both of those are
PRE-decode (a `coerce` failure is a builtin coercion failure; an `encoding`
failure means the wire wasn't even the right SHAPE for decode to run at
all). A decoder throw happens strictly AFTER `validateEncoding` already
passed — the wire value IS shape-valid — so it's a distinct, later failure:
semantically-invalid CONTENT per the user's OWN decoder, which this
codebase's own machinery could never have predicted. `message` is always
`error instanceof Error ? error.message : String(error)` — a decoder can
throw anything, not just an `Error`.

### Decision 5: the two stale-module-mismatch throws

Both directions throw, LOUDLY, at WRAP time (not deferred to the first
request that happens to hit the field) — `apply-validation.ts`'s
`resolveHooks`:

- **(a) generated entry expects a hook the runtime doesn't have**
  (`entry.hookFields` names a field; `meta.<protocol>.encodingMap[field]`
  isn't a function on the real tree). Left silent, a request against that
  field would either crash inside the generated `parse` (the fragment's own
  defensive "no decoder hook supplied" `"decode"` error — a SECOND, weaker
  line of defense, not a substitute for this one) or, worse, silently run
  whatever partial/stale hooks map WAS supplied. Thrown eagerly instead.
- **(b) the runtime HAS a function-valued `encodingMap` entry the generated
  entry does NOT declare a hook for** — codegen ran BEFORE this override was
  authored (or simply hasn't been re-run since). Left unhandled, this is the
  most dangerous case of the two: the field would silently fall through to
  the fragment's FUSED default decode instead of the user's own decoder —
  the WRONG decode, run silently, with no error and no signal anything is
  off. This is exactly the "ran the wrong decode silently" failure mode the
  design doc's own loud-by-default posture exists to prevent, so it throws
  for the same reason (a).

Both throws fire once per wrap (not per request) and name the leaf path,
the field, the protocol, and the remediation (re-run codegen). No third
"warn and fall through" option was implemented — the design's own posture
statement leaves no room for a silent middle ground once BOTH directions of
drift are detectable, which they are here.

### `WireOf<T, Profile>` and the `op()`-time decoder-typing check

`WireOf<T, P>` (new file, `type-ir/src/wire-of.ts`, re-exported from
`index.ts`) is the type-level mirror of `wireTypeText`/`WireProfile.
leafHandlers`, computed over an ordinary TypeScript type rather than a
`TypeRef` — parameterized by `WireProfileName` (`"identity" | "json" |
"query" | "argv"`, the four identities `compile.ts`'s own leaf handlers
distinguish), not by a `WireProfile` VALUE (there is no type-level way to
pattern-match a value's identity, only a type's). Verified against a scratch
`tsc` repro for every leaf kind (`number`/`boolean`/`Date`/`string`),
nullable/optional fields, arrays, and nested objects before being wired in —
see the session's own scratch files for the exact assertions run.

`api-tree/src/input.ts` gained the per-field store-resolution machinery this
needs (`HttpNamespaceOf`/`CliNamespaceOf`/`HttpMethodOf`/`HttpDefaultStore`/
`StoreProfile`/`ExplicitStoreForField`/`FallbackStoresForField`/
`ResolvedStoresForField`/`EncodingMapWireOf`), scoped to exactly `http`/`cli`
(the two namespaces with per-field derivation at all — same scope cut the
string form already has), and `MismatchedEncodingMapDecoders<H, Meta, NS>` —
the phantom-property-based static check, folded into `node.ts`'s
`CheckedContributions` alongside `UncoveredSourceParams`, that flags a
function-form `encodingMap` decoder whose param/return types don't match
`(w: EncodingMapWireOf<Meta, NS, P, HandlerInput<H>[P]>) => HandlerInput<H>[P]`.
A mismatch widens `op()`'s own contributions parameter to require an extra
phantom property the actual call site's literal argument doesn't carry —
the same mechanism, and the same "the compiler's own error names the
offending field" property, `UncoveredSourceParams` already has. Tests:
`api-tree/src/wire-of-check.test.ts` (`@ts-expect-error`-driven, asserted at
`bun run typecheck` time, mirroring `cli-api-projector/src/source.test.ts`'s
own convention) — a correct decoder, a wrong-parameter-type decoder, a
wrong-return-type decoder, a JSON-body-sourced field (no coercion expected),
CLI's argv profile, the string form staying untouched by this check, and the
exactness-gap case below.

**Exactness finding (task instructions asked this be verified precisely, not
hand-waved) — NOT fully exact; the gap is real but narrow.** A field with NO
explicit `sourceMap` entry could, in principle, resolve to either a
path-slug match or the protocol's own default store — and `op()` cannot
resolve which, regardless of `moveTo`. Per 24bd2af (`fix(http-api-projector):
moveTo no longer affects input binding`, landed the session before this one),
a leaf's path-slug binding is now a pure function of its AUTHORED ancestry
(the local, pre-moveTo path segments it's nested under), not of where
`moveTo` eventually relocates it — `wire-derive.ts`'s codegen can see that
authored ancestry exactly, because it statically walks the whole call-site
tree (see that module's own header comment and this doc's phase-B
supersession note above). `op()`'s own type-level check has no equivalent
visibility: it type-checks the leaf in isolation, before the leaf is ever
composed into a tree, so it has no way to know whether the field it's
declaring will later be nested under a same-named path slug. The ambiguity
is `op()`'s own ancestry-blindness at invocation time — a structural gap
distinct from (and unaffected by) moveTo — not a "future mount position"
question. Whether that ambiguity forces an actual type-level UNION depends
on whether "path" and the default store happen to share a wire profile:

- **CLI**: `cliStoreEncoding` is CONSTANT — every store (`flag`/`path`/`env`)
  maps to `argvProfile`. "path" and CLI's default store (`flag`) ALWAYS
  agree — never ambiguous, for any field type.
- **HTTP, GET/HEAD/DELETE** (or no method literal authored at all —
  `wire-derive.ts`'s own `method ?? "GET"` default): the default store is
  `"query"`, the SAME profile `"path"` already resolves to. Not ambiguous.
- **HTTP, any other method** (POST/PUT/PATCH/…): the default store is
  `"body"` (`jsonProfile`), which genuinely DIFFERS from `"path"`'s
  `queryProfile` for any coercing leaf kind. Confirmed empirically (scratch
  `tsc`, not asserted from reasoning alone): `WireOf<number,"query">` is
  `string`; `WireOf<number,"json">` is `number` — NOT the same type. For
  exactly this case — a field with no explicit override, under a non-GET
  method — the computed type is the UNION `WireOf<T,"query"> |
  WireOf<T,"json">`, precisely the fallback the task instructions
  themselves anticipated as the likely resolution ("default to the union...
  when it can't statically rule out a path-slug match").

Concretely, what this MISSES and ALLOWS: it doesn't (can't) tell the author
which of the two shapes their leaf will actually receive once composed into a
tree, so a decoder narrower than the full union is rejected even if the
leaf's authored ancestry would only ever deliver one of the two shapes (a
false positive, in the "too strict" direction) — and a decoder that DOES
handle both shapes is accepted even for a leaf whose authored ancestry only
ever delivers one (safe, but not maximally precise). Both are the SOUND-but-
imprecise side of a genuine "`op()` cannot see its own authored ancestry at
invocation time" structural block — not a bug, and not a gap that widens
unsoundly (the union is a real over-approximation of the two ACTUAL
candidate shapes, never wider than that). `input.ts`'s
`ResolvedStoresForField`/`EncodingMapWireOf` doc comments carry this finding
in full, and `wire-of-check.test.ts`'s "the real exactness gap" test
demonstrates it directly against a real `op()` call.

### Tests added this phase

- `packages/api-tree/src/__fixtures__/wire-apply-validation-hooks.fixture.ts`
  — http/cli/mixed-protocol/no-hook leaves exercising the "dollars-amount
  numeric string -> integer cents" decoder (the canonical nontrivial-decode
  example — see the fixture's own doc comment for why this ISN'T a
  currency-symbol-prefixed string: a hooked field's `validateEncoding` check
  still runs unmodified, so under query/argv encoding the wire must already
  be a bare numeric string before the hook ever sees it).
- `packages/api-tree/src/wire-apply-validation-hooks.test.ts` — static
  existence detection, generated-module shape, end-to-end runtime decode
  (http and cli), a decoder throw surfacing as `"decode"`, a wire-shape-
  invalid input rejected as `"encoding"` (never reaching the hook), BOTH
  stale-module-mismatch directions, fused<->hook fingerprint invalidation,
  and `GeneratedEntry`'s additive-hookFields backward compatibility.
- `packages/api-tree/src/wire-of-check.test.ts` — the authoring-site typing
  check (see above).

### What this phase deliberately left as-is

`encodingMap` overrides (either form) applying to the UNIFORM protocols
(identity/mcp/graphql/jsonrpc) remains the SAME deliberate scope cut the
string form already made — those protocols have no per-field derivation at
all, so a function-form entry declared under one of their namespaces has
nothing to hook into and is silently inert (never read by
`readMetaEncodingMapFunctionFields`, which only runs for http/cli). No
dedicated authoring helper (à la `http.source()`) was built for the function
form either, for the same reason the string form didn't get one: nothing
about authoring a raw function-valued object-literal property needs
literal-preservation machinery the way `sourceMap`'s STORE NAMES did.

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
