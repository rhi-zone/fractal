# Wire profiles + staged decode/validate

## Status

Design settled in conversation with the user (2026-08). Not yet implemented.
This document captures the settled decisions and elaborates them; three
sub-questions are explicitly left open for the user (see "Open questions"
below) — do not resolve them by picking a default in code.

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
by default. (Exactly where that override is declared is one of the open
questions below.)

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

## Open questions

The three questions below are genuinely open — options and tradeoffs only,
no pick.

### (a) Where are user profile overrides declared?

Three candidate locations, and they interact with the composition rule
(protocol default ⊕ override) differently:

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
the same way `meta.http.*` directives are.

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
  itself is keyed by protocol.

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

**Profile composition** (protocol default ⊕ override), whichever location
wins: needs its own rule — does an override REPLACE the protocol default's
entry for a field wholesale, or merge at some finer grain (e.g. override
just the decode function, keep the default's `validateEncoding`)? Not
addressed by any of the three location options above; it's a separate
choice orthogonal to where the override lives.

### (b) Wrap-layer idiom: raw `Node` everywhere, or projected-where-it-exists?

Today, HTTP's `applyValidation` integration point is `PresetOptions.rewriters`
on the PROJECTED `HttpRoute` (routing-and-transforms.md: "`applyValidation`
has to run on the PROJECTED shape here because `createFetch` never exposes
the intermediate `Node`"), while CLI/MCP/GraphQL apply it to the raw `Node`
(no separate projected type exists for them).

Whether a wire profile being PER-PROJECTION forces this asymmetry to
continue, or just favors it, depends on what a profile needs to know that
only the projected shape carries:

- HTTP's per-field wire source (query vs. body vs. header) is determined by
  `sources.sourceMap` — which, per `docs/guide/decode.md`, "attaches to one
  method entry on the `HttpRoute` tree… there is no `meta`-level directive
  that wires it in through `op()`/`api()` yet." So TODAY, a wire profile
  computed at the raw-`Node` level genuinely CANNOT see a field's per-source
  override for HTTP — that information exists only after projection. This
  is a real forcing function for HTTP specifically, not just a preference,
  UNLESS `sourceMap`-equivalent information is lifted into `meta` (a
  separate, currently out-of-scope change).
- CLI/MCP/GraphQL have no such asymmetry: every field's wire type is
  uniform for the whole protocol (argv is uniformly stringly, MCP/GraphQL
  uniformly typed JSON) — nothing about their wire profile depends on
  per-field routing/source information, so nothing forces projected-layer
  attachment for them. Node-level attachment already works for them today,
  unchanged.

So the honest framing: a per-projection profile FORCES projected-layer
attachment for HTTP (given `sourceMap`'s current placement), but only
FAVORS (doesn't force) it for CLI/MCP/GraphQL, where Node-level attachment
already suffices and matches routing-and-transforms.md's
"apply `applyValidation` ONCE, before any protocol-specific projection"
shared-tree pattern. A uniform "always wrap the projected shape" idiom
would need HTTP's asymmetry lifted for the other three protocols too (introducing
a projected type they don't currently have, or attaching to `Node` with an
awkward no-op projection step) — a larger change than this design's scope.

### (c) Default argv boolean encoding: strict vs. loose

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

Nothing in the settled decisions conflicts with code reality as read.
Two implementation-relevant facts worth surfacing for whoever builds this
(not conflicts, just detail the settled list assumed but didn't spell out):

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
