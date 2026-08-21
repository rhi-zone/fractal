# Handoff — 2026-07-16 session: type IR + projectors built out

> **Update note (2026-08-21):** this doc's "what was built" section
> originally described the state as of the 2026-07-16 session (28 kinds all
> in `index.ts`, 21 projectors / 23 format targets). The package has grown
> substantially since — the historical narrative and rationale below are
> left as-is, but the counts, kind list, and file organization are corrected
> to current reality as of this date. See the corrected section immediately
> below; treat any other count mentioned later in this doc (e.g. "23 format
> targets" in the extractor section) as the same kind of stale snapshot.

## What was built (current, as of 2026-08-21)

### `packages/type-ir` — the type IR package

- **41 `TypeKind`s** total, split across two layers:
  - **23 core kinds** declared directly in the `TypeKinds` interface in
    `packages/type-ir/src/index.ts`: `boolean`, `number`, `integer`,
    `string`, `null`, `void`, `unknown`, `never`, `object`, `instance`,
    `array`, `stream`, `page`, `tuple`, `map`, `union`, `literal`, `enum`,
    `ref`, `intersection`, `function`, `method`, `interface`. Six of these
    (`instance`, `stream`, `page`, `function`, `method`, `interface`) are
    new since the 2026-07-16 session — see their doc comments in `index.ts`
    for the subtyping rationale (none of them are subtypes of `object`/
    `array`; each documents why and how projectors without a native
    equivalent should degrade).
  - **18 extension kinds**, no longer inline in `index.ts` — split into
    independently-importable modules under `packages/type-ir/src/kinds/`
    that augment `TypeKinds` via TypeScript declaration merging and register
    their own `parents` entry with `registerParent()`:
    - `kinds/int-widths.ts` — `int8`, `int16`, `int32`, `int64`, `uint8`,
      `uint16`, `uint32`, `uint64`
    - `kinds/float-widths.ts` — `float32`, `float64`
    - `kinds/date-time.ts` — `datetime`, `date`, `time`
    - `kinds/duration.ts` — `duration`
    - `kinds/semantic-strings.ts` — `uuid`, `uri`, `email`
    - `kinds/bytes.ts` — `bytes`
    - `kinds/wire-numerics.ts`, `kinds/temporal.ts`, `kinds/common.ts` are
      composite re-export modules (no kinds of their own) — `common.ts` is
      the "everything this package ships" convenience import.
    - `kinds/refinements.ts` also lives here but declares no `TypeKind`s —
      it's TS-type-only branded refinement tags (`MinLength<N>`, `Pattern<P>`,
      etc.) read by the extractor's static analysis, not IR kinds.
- **Subtyping hierarchy + `resolve()` fallback** (the `parents` map and the
  `ancestors()`/`resolve()` functions in `index.ts`): a
  `parents` map (e.g. `int32 → integer → number`, `uuid → string`) walked by
  `ancestors()`; `resolve(kind, handlers)` looks up the exact kind first, then
  walks ancestors until a handler matches. `registerParent()` lets consumers
  extend the hierarchy for kinds they add. This is the mechanism every
  projector uses instead of hardcoding a switch per kind.
- **Open metadata bag**: `TypeRef = { shape: TypeShape, meta: Readonly<Record<string, unknown>> }`.
  No fixed schema on `meta` — projectors read the keys they recognize.
- **79 projector files covering 81 format targets**, one file + one test
  file each in `packages/type-ir/src/`, all exported as package subpaths in
  `packages/type-ir/package.json` (some subpaths are short aliases for the
  same file, e.g. `./zod` and `./typescript-zod` both resolve to
  `typescript-zod.ts` — the 79/81 counts are deduplicated by underlying
  file). This has grown far past the original 21/23 — languages covered now
  include, per language, multiple competing serialization-library targets
  (e.g. Go: `encoding/json`, easyjson, jsoniter, sonic; C++: nlohmann,
  RapidJSON, simdjson, Boost.JSON, Glaze; Python: dataclasses, Pydantic,
  attrs, msgspec, cattrs; Java: Jackson, Gson, Moshi, JSON-B; Kotlin:
  kotlinx, Jackson, Gson; C#: System.Text.Json, Newtonsoft, ServiceStack;
  Swift: Codable, SwiftyJSON, ObjectMapper; Ruby: Sorbet, dry-types, RBS;
  PHP: native, Symfony, JMS; plus Dart, Rust, Haskell, Elixir, Gleam,
  ReScript, Crystal, Flow, GraphQL, and documentation targets — Markdown,
  reStructuredText, Sphinx, MkDocs (+ vanilla variant), Docusaurus,
  Starlight, org-mode), alongside the original schema/IDL/validator targets:
  - `./json-schema`, `./json-schema-07`, `./json-schema-04` — JSON Schema
    (current, draft-07, draft-04)
  - `./openapi30`, `./openapi20` — OpenAPI 3.0 and 2.0
  - `./typescript` — TS type literal rendering
  - `./sql` — SQL DDL, **one file covering 3 dialects** (postgres default,
    mysql, sqlite) via a `dialect` option — this is why 79 files yield 81
    format targets (79 − 1 + 3)
  - `./sql-mssql` — SQL Server, kept as its own file/dialect
  - `./protobuf` — Protocol Buffers
  - `./capnp` — Cap'n Proto
  - `./flatbuffers` — FlatBuffers
  - `./jtd` — JSON Type Definition
  - `./json-rpc`, `./graphql` — JSON-RPC and GraphQL SDL
  - `./jsdoc` — JSDoc `@property`/`@type` annotations (interface and class
    declaration modes)
  - `./zod`, `./valibot`, `./typebox`, `./arktype`, `./runtypes`,
    `./superstruct`, `./io-ts`, `./yup`, `./effect-schema`, `./standard-schema`
    — runtime validator libraries
  - `./derive` — the derivation operators (below)
- **9 derivation operators** (`packages/type-ir/src/derive.ts`), operating
  purely on `TypeRef` so every projector benefits automatically:
  `partial`, `required`, `deepPartial`, `deepRequired`, `pick`, `omit`,
  `extend`, `nullable`, `withMeta`. `deepPartial`/`deepRequired` recurse into
  nested objects and array elements and are cycle-safe (a `seen` set keyed on
  shape identity).

### `packages/type-ir` — the extractor

Hardened TS → `TypeRef` extraction (`packages/type-ir/src/extract.ts`):
tuples, index signatures, literal types, TS enums and literal unions
(projected as `enum`/union-of-literals), discriminated unions, intersections
(native intersection support extended across io-ts, TypeBox, runtypes,
Effect Schema, ArkType, Superstruct, Yup), branded/opaque types (3 distinct
brand patterns recognized: unique-symbol-keyed, shared-symbol `[BRAND]: "X"`,
and intersection-based branding), recursive types, `Promise<T>` unwrapping,
and class member privacy filtering (`private`/`protected` excluded via
`isPrivateOrProtected`). Pipeline is TS source → `TypeRef` → any of the 81
format targets above.

## What's settled (verified, tested, committed)

- The type IR design itself: extensible DU via the `TypeKinds` interface,
  open metadata bag, subtyping hierarchy with fallback — this was the
  open thread from the 2026-07-14–16 session and is now built, not just
  designed at the principles level.
- The `handlers` + `resolve()` pattern used uniformly across all projectors
  (verified by reading `index.ts` and spot-checking `sql.ts`; as of
  2026-08-21 this is 79 projector files — see the corrected "what was built"
  section above).
- Metadata-key conventions in active use across projectors: `nullable`,
  `optional`, `description`, `deprecated`, `default`, `brand`,
  `discriminator`, `constraints` (min/max/pattern/etc, including exclusive
  bounds).
- Test suite, run this session (`bun test` per workspace):
  - `packages/type-ir`: **1118 tests / 23 files, 0 failures**
  - `packages/type-ir`: 93 tests / 4 files
  - full monorepo across all 8 workspaces (`core`, `type-ir`, `http`, `mcp`,
    `codegen`, `openapi`, `cli`, `client`): **1365 tests, 0 failures**
    (measured directly this session by running `bun test` in each package
    directory and summing — not carried forward from an earlier claim).

## What's open

### Operation layer (new thread, primary follow-on)

`docs/design/operation-layer-spec.md` is a requirements document mined from
the consumer app's evidence (use-case descriptors, entity descriptors, HTTP
binding, audit specs, session-input threading, authorization guards,
error-code mapping) — not a fractal design proposal. It documents ~10
capabilities a single "operation" declaration would need so that HTTP route,
valibot schema, CLI, admin-page action, audit call, and error mapping become
projections of one declaration instead of independently hand-maintained
files.

Key tension: **this lands directly on the combinator-identity gap** (see
TODO.md — "Built code doesn't match the combinator identity"). The spec's
requirements need, in order:

1. The combinator identity resolved first — an operation declaration is
   presumably a combinator-composed value, and until the combinator
   primitives are settled there's no substrate to define "operation" in
   terms of.
2. A decision on whether auth/audit/side-effects/error-mapping are DU
   metadata on the type-IR-adjacent operation node (open metadata bag,
   consistent with the type IR's own pattern) or a wholly separate
   mechanism/layer.
3. Reconciliation of the spec's `handler` + `errorMap` binding (direct
   function binding, declarative catch→code mapping) with the existing
   Result-based composition in `packages/api-tree` — the spec's "bind directly
   to a typed function-with-throws" is in tension with the Kleisli/Result
   combinator style already built.

This is requirements evidence, not a settled design — the author's own
definition of the operation layer is still needed (consistent with the
"unsettled design questions need the author's own definition" guardrail in
TODO.md).

### SQL optional vs nullable

`partial()` (`derive.ts`) sets `meta.optional = true` on fields. The SQL
projector (`sql.ts`) only inspects `meta.nullable` when deciding whether to
emit a DDL column as nullable. A `partial()`-derived type therefore does not
currently render its optional fields as `NULL`-able columns in SQL — the
convention gap is real, not yet a bug fix, because it's unclear whether
`optional` should imply `nullable` for SQL specifically, or whether they
should stay separate axes (a field can be optional in an input schema
without being nullable in the stored table, e.g. defaulted server-side).
Design decision pending, not implementation.

### Integration into the consumer app

`type-ir` is built and tested in isolation but not yet wired into the
consumer app to replace any of the hand-duplicated schemas the
operation-layer-spec documents (`LocationCreateSchema` / `LocationPatchSchema`
/ `ListLocationsInputSchema`, the 3-4x duplicated "location patch" shape).
No integration work has started; the spec exists to define what integration
would need to unlock (the `Partial<T>` relationship becoming a `partial()`
derivation instead of a hand-retyped duplicate).

## Session transcripts

Previous sessions contain design discussion, rationale, and rejected alternatives that aren't captured in the settled artifacts. Mine these for context:

- `/home/me/.claude/projects/-home-me-git-rhizone-fractal/17d1a115-4ac5-4af8-8162-944408cf018d.jsonl` — 2026-07-16 (early): design philosophy, type IR principles, and shape hierarchy settled
- `/home/me/.claude/projects/-home-me-git-rhizone-fractal/dd86ffb9-a770-49e0-b36a-87d1a0e3dd2b.jsonl` — 2026-07-16 (afternoon): type IR implementation built out — 21 projectors, extractor, derivation operators, and test suite

## Pointers

- Type IR entry point: `packages/type-ir/src/index.ts`
- Derivation operators: `packages/type-ir/src/derive.ts`
- Extractor: `packages/type-ir/src/extract.ts`
- Operation layer requirements: `docs/design/operation-layer-spec.md`
- Architecture layers (prior session): `docs/design/architecture-layers.md`
- Type IR survey (prior session): `docs/design/type-ir-survey.md`
- TODO.md — open threads, updated this session
