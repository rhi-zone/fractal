# @rhi-zone/fractal-type-ir

Type intermediate representation: a subtyping hierarchy plus an open
metadata bag, projectable to JSON Schema, OpenAPI, or other targets.

## What it does

Defines `TypeRef` — a `{ shape, meta }` pair where `shape` is one of a
closed set of kinds (`string`, `object`, `array`, `union`, ...) refined by
an extensible parent chain (`uuid` extends `string`, `int32` extends
`integer` extends `number`, ...). `resolve()` looks up a handler for a
kind, walking up the ancestor chain when no exact match exists, so a
projection can handle `string` once and get `uuid`/`uri`/`datetime` for
free. Derive helpers (`partial`, `pick`, `omit`, `extend`, ...) transform
object shapes structurally. Subpath projections turn a `TypeRef` into JSON
Schema (draft 04/07, 2020-12) or OpenAPI 3.0 schema objects.

## Key exports

- `types` — shape constructors (`types.string`, `types.object(fields)`, `types.array(el)`, ...)
- `t(shape, meta?)` — wrap a shape with a metadata bag into a `TypeRef`
- `registerParent(kind, parent)`, `ancestors(kind)`, `resolve(kind, handlers)` — the subtyping lattice
- `partial`, `required`, `pick`, `omit`, `extend`, `nullable`, `withMeta`, `deepPartial`, `deepRequired` — structural derive helpers
- `./json-schema`, `./json-schema-07`, `./json-schema-04`, `./openapi30` — target projections
- `./jsdoc` — JSDoc-derived metadata helpers
- `buildSchema`, `compileValidator`, `compileValidatorModule` — `TypeRef` → TypeBox validator code, a build-time projector (`./compile`)

The build-time extractor (`createExtractorProgram`, `typeRefFromType`,
`schemaFromType`, `extractJsDoc`, ...), the whole-tree walkers
(`extractToolSchemas`, `extractRouteTypeRefs`, `extractToolTypeRefs`), the
build orchestrator (`buildValidatorModuleSource`, `writeValidatorModule`),
and the `fractal-api-tree` CLI (`build`/`watch`/`stub`/`check`) live in
`@rhi-zone/fractal-api-tree` (`./tree`, `./extract`) — they walk `api()`/
`op()` AUTHORING source, which is api-tree's concern. `compile.ts` (this
package) is the projector they hand `TypeRef`s to.

## Full export surface

`package.json`'s `exports` map publishes 115 subpaths in total (the root
entry plus 114 subpaths) — by far the largest export surface of any
package in this monorepo. "Key exports" above covers the handful most
consumers reach for directly; the rest groups into a few clear families.

**Output format projectors** — `TypeRef` → a specific schema/IDL text or object, beyond the JSON Schema/OpenAPI 3.0 pair already listed above:
- `./openapi20` — Swagger 2.0 schema objects (draft-04-restricted JSON Schema vocabulary)
- `./graphql` — GraphQL SDL type projector
- `./protobuf` — proto3 message/service projector
- `./capnp` — Cap'n Proto schema projector
- `./flatbuffers` — FlatBuffers `.fbs` schema projector
- `./jtd` — JSON Type Definition (RFC 8927)
- `./json-rpc` — lowers an `interface` `TypeRef` (a service's method surface) to JSON-RPC 2.0 method descriptors (params/result/error schema per method)
- `./sql`, `./sql-mssql` — SQL DDL (postgres/mysql/sqlite via `./sql`; MSSQL is a separate dialect with its own IDENTITY/NVARCHAR conventions)

**Ingestion (`from-*`)** — the reverse direction, an external schema or source → `TypeRef`, mirroring the output projector of the same name where one exists:
- `./from-json-schema`, `./from-openapi`, `./from-graphql`, `./from-protobuf`, `./from-flatbuffers`, `./from-capnp`, `./from-jtd` — reverse of the matching projector above
- `./from-sql` — postgres/mysql/sqlite DDL → `TypeRef` (reverse of `./sql`)
- `./from-cql` — Cassandra CQL DDL (`CREATE TABLE`/`CREATE TYPE`, partition/clustering keys, collections, UDTs, `frozen<...>`) → `TypeRef`
- `./from-elasticsearch` — an Elasticsearch index mapping → `TypeRef` (pure structural traversal, already-JSON input)
- `./from-json` — a single JSON *value* → `TypeRef` by structural heuristic (no declared schema to read, only a shape to guess)
- `./from-json-corpus` — *multiple* JSON values → the tightest covering `TypeRef` (enum detection, discriminated unions, record-vs-dict, optional-field inference — signals only visible across a corpus)
- `./from-typescript` — general-purpose TS compiler-API ingester (`ts.Type` + `ts.TypeChecker` → `TypeRef`; primitives, literals, objects, arrays, tuples, unions incl. TS enums and discriminated unions, intersections incl. branded/opaque types)
- `./from-flow` — Flow type-annotation syntax → `TypeRef`, via `flow-parser` (Flow's own OCaml parser compiled to WASM)
- `./standard-schema`, `./from-standard-schema` — the two directions of [Standard Schema](https://standardschema.dev/), the vendor-neutral `~standard.validate` interface Zod/Valibot/ArkType and others implement: `./standard-schema` emits a runtime object implementing it from a `TypeRef`, `./from-standard-schema` ingests any object implementing it back into a `TypeRef`

**Documentation-site generators** — a `TypeRefDocument` → one reference page per named `defs` entry, one module per doc-site toolchain's conventions:
- `./docusaurus-reference` — MDX pages for Docusaurus
- `./starlight-reference` — Astro Starlight MDX pages
- `./mkdocs-reference` — Markdown pages for MkDocs-Material (admonitions, content tabs, abbreviations — no MDX/JSX)

**Type-level utilities:**
- `./derive` — the pure `TypeRef` → `TypeRef` transform operators (same family as `partial`/`pick`/`omit` above; every projector benefits automatically since these operate before projection)
- `./kinds/*` — the shape-kind extension modules the core lattice itself is assembled from: `int-widths`, `float-widths`, `wire-numerics` (int+float widths combined, for wire formats like protobuf/Avro/TypeBox), `date-time`, `duration`, `temporal` (date-time+duration combined), `semantic-strings` (`uuid`/`uri`/`email`, all subtype `string`), `bytes` (binary blob, no parent), `common` (everything above, bundled for convenience), `refinements` (branded refinement-tag types for authoring TS source that `./from-typescript` reads)

**TypeScript validation library projectors** — `TypeRef` → source that builds a runtime schema in a specific TS validation library. Each has a bare alias and a `typescript-`-prefixed alias pointing at the same module:
`./zod`, `./runtypes`, `./superstruct`, `./arktype`, `./typebox`, `./valibot`, `./io-ts`, `./yup`, `./effect-schema` (each also reachable as `./typescript-{name}`).

**Per-language serialization library variants** — the bulk of the export surface (52 subpaths across 18 general-purpose languages): `TypeRef` → an idiomatic struct/class in that language, wired to one specific serialization library. One module per `{language}-{library}` pair; a bare `./{language}` alias exists only for languages with exactly one variant today, and is removed once a language grows a second (no default silently wins the unqualified path). This is a **structural snapshot of `package.json`'s current `exports` map**, not a status/quality claim — for what's implemented-and-tested vs. still planned per language, and the history behind the bare-alias policy, see [`docs/roadmap.md`](../../docs/roadmap.md)'s "Output: General-Purpose Languages" and "Per-Language Serialization Library Variants" sections, which are the authoritative tracking for this matrix:

| Language | Variant export subpaths |
|---|---|
| TypeScript | `typescript`, `typescript-native` |
| Python | `python-dataclass`, `python-pydantic`, `python-attrs`, `python-msgspec`, `python-cattrs` |
| Go | `go-encoding-json`, `go-easyjson`, `go-jsoniter`, `go-sonic` |
| Rust | `rust`, `rust-serde` |
| Java | `java-jackson`, `java-gson`, `java-moshi`, `java-jsonb` |
| C# | `csharp-systemtextjson`, `csharp-newtonsoft`, `csharp-servicestack` |
| Swift | `swift-codable`, `swift-swiftyjson`, `swift-objectmapper` |
| Kotlin | `kotlin-kotlinx`, `kotlin-jackson`, `kotlin-gson` |
| Dart | `dart-json-serializable`, `dart-freezed`, `dart-built-value` |
| Elm | `elm`, `elm-json` |
| Haskell | `haskell`, `haskell-aeson` |
| Ruby | `ruby-sorbet`, `ruby-dry-types`, `ruby-rbs` |
| C++ | `cpp-nlohmann`, `cpp-rapidjson`, `cpp-simdjson`, `cpp-boost-json`, `cpp-glaze` |
| PHP | `php-native`, `php-symfony`, `php-jms` |
| Crystal | `crystal`, `crystal-json-serializable` |
| Objective-C | `objc`, `objc-foundation` |
| Flow | `flow`, `flow-native` |
| Elixir | `elixir`, `elixir-jason` |

## Generated Python code: unmodeled validation-metadata fields

The four Python serialization-variant projectors that model per-field
*validation* metadata (not just shape) — `./python-pydantic`,
`./python-msgspec`, `./python-cattrs`, `./python-attrs` — each keep a
`KNOWN_FIELD_META` allow-list of the `TypeRef` metadata keys they translate
into real target-library validation. Any metadata key present on a field
(or on an object's own `meta`) that ISN'T in that allow-list is
"unmodeled" for that target: instead of being silently dropped, each
projector's `unrecognizedMeta()` helper emits an inline marker into the
generated Python naming the specific unmodeled key(s), so the gap is
visible in the generated output rather than a silent no-op.

**Modeled by all four** (translated into real validation, not marked
unmodeled): `optional`, `nullable`, `readonly`, `description`,
`deprecated`, `default`, `examples`, `minLength`, `maxLength`, `pattern`,
`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
`discriminator`. (`typeName`/`declarationFile` are provenance keys, not
validation intent, and are excluded from consideration entirely — not
"unmodeled", just not applicable.)

**`multipleOf` is a divergence point**: modeled by `./python-pydantic` and
`./python-msgspec` (both emit real multiple-of validation), but
*deliberately* left out of `./python-cattrs` and `./python-attrs`'s
allow-lists — attrs (which cattrs' classes are also built on) has no
built-in multiple-of validator, so on those two targets `multipleOf` falls
through to the generic unmodeled-metadata stub like any other unrecognized
key (documented inline at each file's `KNOWN_FIELD_META` definition).

What the marker looks like per target, when a field or object carries an
unmodeled key:
- **`python-pydantic.ts`** (~line 213 per-field, ~line 233 object-level) —
  emits a `@field_validator`/`@model_validator` stub method whose body is a
  `# TODO: unmodeled validation metadata on "<name>": <keys>` comment
  followed by a no-op passthrough (`return v` / `return self`).
- **`python-msgspec.ts`** (~line 269 object-level, ~line 244 per-field,
  rendered at ~line 428/441) — `msgspec.Struct` has no post-init or
  per-field validator hook at all, so only a bare comment is emitted (no
  stub method), explicitly noting the field must be validated "after
  `msgspec.json.decode(...)` at the call site."
- **`python-cattrs.ts`** (~line 243 per-field, ~line 282 object-level) —
  emits a free `_validate_<field>(instance, attribute, value)` attrs
  validator function stub and an `__attrs_post_init__` object-level stub,
  each body a `# TODO: unmodeled validation metadata on "<name>": <keys>`
  comment.
- **`python-attrs.ts`** (~line 264 per-field, ~line 305 object-level) —
  same stub shapes as `python-cattrs.ts` (`_validate_<field>` +
  `__attrs_post_init__`), since cattrs' generated classes are themselves
  attrs classes.

Discriminated unions get a related but separate marker on these two
targets: `python-attrs.ts` has no native discriminated-union support and
emits a comment pointing at `cattrs.register_structure_hook` as the
concrete mechanism; `python-cattrs.ts` goes further and emits a concrete
`# TODO: register a structure hook ...` stub naming the union alias and
discriminant field directly, since it already assumes a module-level
`cattrs.Converter()` instance to hang the hook on.

## Usage

```ts
import { types, t, resolve } from "@rhi-zone/fractal-type-ir"

const book = t(types.object({
  id: t(types.uuid),
  title: t(types.string),
}))

const toDescription = resolve("uuid", {
  string: (r: typeof book) => "a string",
})
```

## Install

```bash
bun add @rhi-zone/fractal-type-ir
```

See the [root README](../../README.md) for the full picture across all projections.
