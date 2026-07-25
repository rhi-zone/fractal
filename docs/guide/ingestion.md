# Ingesting existing schemas

Fractal's type IR (`@rhi-zone/fractal-type-ir`) has two families of modules:
60+ **projectors** that go `TypeRef -> target format` (`toZod`, `toPython`,
`toJsonSchema`, `toSqlDdl`, …), and a much smaller set of **ingesters** —
the `from-*` modules — that go the other way, `source -> TypeRef`.

An ingester exists so you don't have to hand-write a `TypeRef` for a schema
that already exists somewhere else. Ingest once, and every projector becomes
available for it: a SQL `CREATE TABLE` becomes a Zod validator, a Python
dataclass, and a JSON Schema document from a single `fromSql()` call, without
transcribing the shape three times by hand. This page is a workflow guide —
which ingester to reach for, and how the pieces fit together. For per-module
API detail (full signatures, every meta convention, worked before/after
examples), see [`reference/type-ir/importers`](../reference/type-ir/importers.md),
which this page defers to rather than duplicates.

## The catalog

Ingesters fall into four kinds, distinguished by what they read from: a
*declared* schema in some format's own grammar, a live language's type
system, or *no* declared schema at all — just example data to guess from.

### Schema-description formats

These read a format whose entire purpose is describing shapes (as opposed to
formats like SQL where the schema is incidental to another purpose).

| Ingester | Subpath | Reach for it when… |
| --- | --- | --- |
| `fromJsonSchema` | `from-json-schema` | You have a JSON Schema document (draft-07 or 2020-12 style) and want it as `TypeRef`. |
| `fromOpenApi30` / `fromOpenApi20` | `from-openapi` | You have an OpenAPI/Swagger schema object (not a whole spec — a `schema` node) to convert; `fromOpenApi20` additionally decodes Swagger 2.0's `x-oneOf`/`x-nullable` vendor extensions. |
| `fromJtd` / `fromJtdDocument` | `from-jtd` | You have an RFC 8927 JSON Type Definition schema, single or with `definitions`. |
| `fromStandardSchema` | `from-standard-schema` | You have a live [Standard Schema](https://standardschema.dev/) instance (a Zod, Valibot, or ArkType schema object) at runtime and want its `TypeRef`, not its source text. |

### IDL / wire formats

These read an interface-definition language for RPC or serialization, where
message/struct declarations may cross-reference each other.

| Ingester | Subpath | Reach for it when… |
| --- | --- | --- |
| `fromProtoText` / `fromProtoDescriptor` | `from-protobuf` | You have a `.proto` source string, or a `protoc --descriptor_set_out` JSON descriptor. |
| `fromFlatbuffers` | `from-flatbuffers` | You have a `.fbs` FlatBuffers schema source string. |
| `fromCapnp` | `from-capnp` | You have a Cap'n Proto `.capnp` schema source string. |
| `fromGraphql` | `from-graphql` | You have a GraphQL SDL document (`type`/`input`/`interface`/`enum`/`scalar`/`union` definitions). |

### Database schemas

These read DDL — the schema is a side effect of a `CREATE` statement, not a
document whose sole purpose is describing a type.

| Ingester | Subpath | Reach for it when… |
| --- | --- | --- |
| `fromSql` | `from-sql` | You have `CREATE TABLE` DDL for Postgres, MySQL, or SQLite. |
| `fromCql` | `from-cql` | You have Cassandra `CREATE TABLE`/`CREATE TYPE` CQL. |

### Search-index mappings

| Ingester | Subpath | Reach for it when… |
| --- | --- | --- |
| `fromElasticsearch` / `fromElasticsearchField` | `from-elasticsearch` | You have an Elasticsearch/OpenSearch mapping (`{ properties: {...} }`) as already-parsed JSON. |

### Live-language types

| Ingester | Subpath | Reach for it when… |
| --- | --- | --- |
| `typeRefFromType` + `createExtractorProgram` | `from-typescript` | You have real TypeScript source and want to extract `TypeRef`s from a live `ts.Program`/`ts.TypeChecker` — not text-parsing, actual compiler type resolution (handles generics, conditional/mapped types the compiler already resolved, JSDoc-derived meta, etc). |

### Value-based inference (heuristic, not declared)

These are fundamentally different in kind from everything above: there is no
schema to read, only example *values* to guess a schema from. Every ingester
above is a parser — deterministic, format-grammar-driven. These two are
statistical inference — probabilistic, tunable, and capable of being wrong
in ways a parser cannot be (a parser either matches the grammar or errors; a
heuristic can confidently infer the wrong shape from an unlucky sample).

| Ingester | Subpath | Reach for it when… |
| --- | --- | --- |
| `fromJson` | `from-json` | You have **one** example JSON value (e.g. one API response captured from the network tab) and no schema. |
| `fromJsonCorpus` | `from-json-corpus` | You have **many** example JSON values (a batch of API responses, a JSONL log sample) and want signal that only shows up across a population — which fields are actually optional, which string field is really an enum, whether a fanned-out shape is a discriminated union or a dict. |

Both are covered in API-reference depth in
[`reference/type-ir/importers`](../reference/type-ir/importers.md#json-value)
and in inference-specific depth in [`./inference.md`](./inference.md); this
page only tells you when to pick which.

## Round-tripping

Where an ingester's format has a corresponding forward-direction projector,
the ingester is written to mirror that projector's structural conventions —
same passthrough `meta` keys, same format-detection rules — so a round trip
through `format -> TypeRef -> format` is lossless wherever the target format
allows it. `fromJsonSchema` reverses `json-schema.ts`; `fromSql` reverses
`sql.ts`; `fromJtd` reverses `jtd.ts`'s `toJtd`; and so on.

A concrete example, SQL in, Zod out, SQL back out:

```ts
import { fromSql } from "@rhi-zone/fractal-type-ir/from-sql"
import { toZod } from "@rhi-zone/fractal-type-ir/typescript-zod"
import { toCreateTable } from "@rhi-zone/fractal-type-ir/sql"

const tables = fromSql(`
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL
  )
`, { dialect: "postgres" })

// Project the same TypeRef out to a Zod schema for runtime validation…
const usersSchema = toZod(tables.users)

// …and back out to DDL (same or a different dialect):
const ddl = toCreateTable("users", tables.users, { dialect: "postgres" })
// CREATE TABLE users (
//   id SERIAL NOT NULL PRIMARY KEY,
//   email TEXT NOT NULL UNIQUE
// );
```

`fromSql`'s `PRIMARY KEY`/`UNIQUE`/`AUTO_INCREMENT` handling round-trips
through `meta.primaryKey`/`meta.unique`/`meta.autoincrement` — conventions
local to the `from-sql.ts` / `sql.ts` pair — so `toCreateTable` recovers
constraints `fromSql` recorded, not just column types. Round-tripping
through an unrelated format (say, `toZod`) only carries whatever that
projector's own target format can express (Zod has no `PRIMARY KEY`
concept, so that constraint is simply absent from the Zod output — not lost
from the `TypeRef`, just not projected by a format with nowhere to put it).

## Return shape: single `TypeRef`, a flat map, or a `TypeRefDocument`

Different source formats have a different notion of "how many types are in
this file," and each ingester's return type reflects that rather than
forcing one shape on every format:

- **Single `TypeRef`** — the format describes exactly one type per call.
  `fromJson`, `fromJsonSchema`, `fromJtd`, `fromOpenApi30`/`fromOpenApi20`,
  `fromStandardSchema`, `fromElasticsearch`.
- **`Record<string, TypeRef>`** (a flat map, keyed by declared/dotted name)
  — the format commonly declares several independent, possibly
  cross-referencing top-level types with no single privileged "root."
  `fromSql`, `fromCql`, `fromGraphql` (keyed by declared name),
  `fromFlatbuffers` and `fromCapnp` (keyed by namespace/nesting-qualified
  dotted path, e.g. `"a.b.Foo"`, `"Person.Address"`).
- **`TypeRefDocument`** (`{ root, defs }`) — the format has both a
  well-defined entry point *and* a set of named, cross-referenced
  declarations that entry point (and each other) can point into.
  `fromProtoText`/`fromProtoDescriptor` (`root` is the first top-level
  message/enum declaration; `defs` holds every message/enum keyed by dotted
  nested path), `fromJtdDocument` (`root` is the top-level schema, `defs`
  is its `definitions` map).

The dividing line between the flat-map group and the `TypeRefDocument` group
is whether the format itself designates one declaration as the entry point.
Protobuf files and JTD documents with `definitions` do (first top-level
message; the document's root schema); FlatBuffers and Cap'n Proto files
routinely don't (`root_type` is FlatBuffers-only and optional, and Cap'n
Proto has no equivalent at all) — hence the flat map for those two, with
`meta.isRootType` marking FlatBuffers' `root_type` where it's present rather
than promoting it out of the map into a `root` field.

## Config knobs

`fromJson` and `fromJsonCorpus` are the two ingesters with tunable
heuristics — everything else is a grammar-driven parser with no thresholds
to adjust.

`fromJson` takes an optional `InferConfig`:

```ts
import { fromJson, type InferConfig } from "@rhi-zone/fractal-type-ir/from-json"

const config: InferConfig = {
  arrayThreshold: 3,        // min elements before inferring array over tuple
  narrowIntegerWidth: true, // narrow whole numbers to the tightest int kind
  detectStringFormats: true,// try uuid/email/uri/date detection on strings
  leafHeuristics: [],       // custom heuristics tried before the built-ins
}
```

`fromJsonCorpus` takes a `CorpusInferConfig` (a superset of `InferConfig`,
since corpus inference runs single-value inference as its base case and
layers accumulation-only heuristics on top: enum detection, discriminated-
union detection, dict-vs-record detection, dirty-data detection, and several
thresholds/knobs governing each — `enumMinSamples`, `objectSplitThreshold`,
`clusteringMethod`, and more). The module doc in
`packages/type-ir/src/inference-eval.ts` names three of the underlying
heuristics as examples of the kind of thing being tuned: K/N < 1/3 enum
saturation, Jaccard > 0.1 discriminated-union splits, growthRatio > 0.5 dict
detection. This page won't go deeper than that pointer — corpus inference's
internals, and how to evaluate/tune them, are covered in
[`./inference.md`](./inference.md).

## Worked example: which ingester?

| You have… | Reach for… |
| --- | --- |
| A `.proto` file | `fromProtoText` |
| A live Zod schema object | `fromStandardSchema` |
| A `CREATE TABLE` statement | `fromSql` |
| One example JSON API response, no schema | `fromJson` |
| A folder of example JSON API responses, no schema | `fromJsonCorpus` |
| A GraphQL SDL file | `fromGraphql` |
| A TypeScript interface in your own codebase | `from-typescript`'s `typeRefFromType` over a `ts.Program` |
| An Elasticsearch index mapping | `fromElasticsearch` |

The dividing case worth calling out explicitly: `fromJson` vs.
`fromJsonCorpus` for JSON data with **no** declared schema. A single sample
can only tell you what one instance looked like — every field it has looks
required, because absence-across-instances is exactly the signal a lone
sample can't provide. If you can gather more than one instance, `fromJsonCorpus`
almost always produces a materially better inference (correct optionality,
enum vs. free-form string, discriminated union vs. flattened
everything-optional object) for the same reason a type system inferred from
one call site is worse than one inferred from every call site.
