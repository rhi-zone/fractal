# Importers

The `from-*` subpaths go the opposite direction from every projector above:
source format → `TypeRef` (or `Record<string, TypeRef>` / `TypeRefDocument`
for formats with multiple, possibly cross-referencing, declarations). Each
mirrors the structural conventions of its forward-direction projector where
one exists (`from-json-schema.ts` reverses `json-schema.ts`, `from-sql.ts`
reverses `sql.ts`, …) — passthrough annotation keys, format detection, and
`meta` conventions line up so round-tripping is lossless where the target
format allows it.

## JSON Schema

```ts
import { fromJsonSchema } from "@rhi-zone/fractal-type-ir/from-json-schema"

fromJsonSchema({
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
  },
  required: ["id", "name"],
})
```

```ts
t(types.object({
  id: t(types.integer),
  name: t(types.string),
}))
```

`$ref` becomes an unresolved `types.ref(target)` (last path segment of the
JSON Pointer); `type: [T, "null"]` and a single-null-variant `anyOf` both
collapse to `meta.nullable: true` on the inner type; an empty `not: {}`
becomes `types.never`.

## OpenAPI

```ts
import { fromOpenApi30, fromOpenApi20 } from "@rhi-zone/fractal-type-ir/from-openapi"

fromOpenApi30({
  type: "object",
  properties: { id: { type: "string", format: "uuid" } },
})
```

```ts
t(types.object({ id: uuid() }))
```

`fromOpenApi30` reverses `toOpenApi30`'s structural subset (OAS 3.0.3
§4.8.24); `fromOpenApi20` additionally reverses Swagger 2.0's vendor-extension
encoding of unions (`x-oneOf`/`discriminator`) and its `x-nullable`/
`x-deprecated` stand-ins for concepts OAS 3.0 has native keywords for. Both
leave `$ref` unresolved, same convention as `fromJsonSchema`.

## Protobuf

```ts
import { fromProtoText } from "@rhi-zone/fractal-type-ir/from-protobuf"

const doc = fromProtoText(`
  message Person {
    string name = 1;
    int32 age = 2;
  }
`)
```

```ts
// doc.defs.Person:
t(types.object({
  name: t(types.string, { optional: true }),
  age: t(types.int32, { optional: true }),
}))
// doc.root: t(types.ref("Person"))  — first top-level declaration
```

Returns a `TypeRefDocument`: every message/enum becomes a `defs` entry keyed
by dotted nested path (`"Person"`, `"Person.Address"`), cross-references
resolve through `{ kind: "ref", target }`, and `root` refs the first
top-level declaration (or `unknown` if the file declares none).
`fromProtoDescriptor(file)` is the primary entry point — it takes the same
JSON shape `protoc --descriptor_set_out` (or a descriptor `toObject()`)
produces; `fromProtoText(source)` is `parseProtoText` (via the optional peer
dependency `protobufjs`) piped into `fromProtoDescriptor`. `service`/`rpc`
blocks are structurally skipped — this ingester's scope is message/enum
schemas, matching how `protobuf.ts`'s `toProtoService` is a one-way,
output-only concept.

## FlatBuffers

```ts
import { fromFlatbuffers } from "@rhi-zone/fractal-type-ir/from-flatbuffers"

fromFlatbuffers(`
  table Widget {
    active:bool;
    name:string;
  }
`)
```

```ts
// result.Widget:
t(types.object({
  active: t(types.boolean, { optional: true }),
  name: t(types.string, { optional: true }),
}))
```

Returns a flat `Record<string, TypeRef>` (no self-describing JSON descriptor
format exists for FlatBuffers, unlike protobuf), keyed by namespace-qualified
dotted name (`namespace a.b; table Foo` → key `"a.b.Foo"`). A hand-rolled
tokenizer + recursive-descent parser, since no widely-used JS `.fbs` grammar
library exists. `root_type` resolves its target and sets `meta.isRootType =
true`; `rpc_service` blocks are recognized but not converted.

## SQL

```ts
import { fromSql } from "@rhi-zone/fractal-type-ir/from-sql"

fromSql(`
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL
  )
`, { dialect: "postgres" })
```

```ts
// result.users:
t(types.object({
  id: t(types.integer, { primaryKey: true, autoincrement: true }),
  email: t(types.string, { unique: true }),
}))
```

Returns `Record<string, TypeRef>`, one entry per `CREATE TABLE`. `opts.dialect`
(`"postgres" | "mysql" | "sqlite"`) picks the type-mapping table for the three
dialects `sql.ts` targets (MSSQL is out of scope, matching `sql.ts` itself).
Column concepts `sql.ts`'s forward direction doesn't model at all —
`PRIMARY KEY`, `UNIQUE`, `REFERENCES`, `CHECK`, `AUTO_INCREMENT`/`SERIAL` —
round-trip as open `meta` conventions local to this pair of modules
(`meta.primaryKey`, `meta.unique`, `meta.autoincrement`, `meta.references`,
`meta.checks`). A lightweight hand-rolled parser, not a full SQL grammar;
non-`CREATE TABLE` statements are silently skipped.

## CQL (Cassandra)

```ts
import { fromCql } from "@rhi-zone/fractal-type-ir/from-cql"

fromCql(`
  CREATE TABLE events (
    id uuid PRIMARY KEY,
    payload blob
  )
`)
```

```ts
// result.events:
t(types.object({
  id: uuid({ primaryKey: true }),
  payload: bytes(),
}))
```

Returns `Record<string, TypeRef>`, one entry per `CREATE TABLE`/`CREATE TYPE`.
An independent hand-rolled parser (CQL's grammar diverges enough from SQL —
partition/clustering keys, collection types, UDTs, `frozen<...>` — that it
doesn't share code with `from-sql.ts`, matching this package's per-ingester
independence convention). A table's columns may `ref()` a UDT declared by an
earlier *or later* `CREATE TYPE` in the same string (CQL allows forward
references). Unrecognized statements (`CREATE KEYSPACE`, `ALTER TABLE`, …)
are silently skipped.

## Cap'n Proto

```ts
import { fromCapnp } from "@rhi-zone/fractal-type-ir/from-capnp"

fromCapnp(`
  struct Person {
    name @0 :Text;
    age @1 :UInt32;
  }
`)
```

```ts
// result.Person:
t(types.object({
  name: t(types.string),
  age: t(types.uint32),
}))
```

Returns a flat `Record<string, TypeRef>` (top-level and nested
struct/enum, keyed by dotted path, e.g. `"Person"`, `"Person.Address"`) —
same flat-map rationale as `from-flatbuffers.ts`: Cap'n Proto files commonly
declare several independent, mutually-referential top-level types with no
single root. A hand-rolled recursive-descent parser, since Cap'n Proto has
neither a widely-used JS parser library nor a usable self-describing JSON
descriptor format. `using`/`import`/`const`/`annotation`/`interface`
declarations are recognized and skipped structurally.

## Elasticsearch

```ts
import { fromElasticsearch } from "@rhi-zone/fractal-type-ir/from-elasticsearch"

fromElasticsearch({
  properties: {
    title: { type: "text" },
    createdAt: { type: "date" },
  },
})
```

```ts
t(types.object({
  title: t(types.string),
  createdAt: datetime(),
}))
```

No text parsing — an ES mapping is already structured JSON, so this is pure
structural traversal (same shape as `from-json-schema.ts`). `fromElasticsearch`
converts the mapping root; `fromElasticsearchField` converts a single field
definition (also used recursively for nested `properties`). `nested` degrades
to `array(object)` — the "each entry gets its own Lucene document" indexing
detail has no `TypeRef` equivalent. Unrecognized/future ES types degrade to
`unknown` with `meta.esType` preserved rather than guessed at.

## JSON value

```ts
import { fromJson } from "@rhi-zone/fractal-type-ir/from-json"

fromJson({ id: 42, email: "a@b.com", tags: ["x", "y", "z"] })
```

```ts
t(types.object({
  id: uint8(),
  email: t(types.string, { format: "email" }),
  tags: t(types.array(t(types.string))),
}))
```

Infers a `TypeRef` from a single JSON *value* by structural heuristic — no
declared schema to read, only a shape to guess. Core heuristic: narrow away
from a wide type only when the observed value lands in a subspace ~0% of the
wide type's inhabitants occupy (a whole number narrows to the tightest
fixed-width integer kind; a string that validates as a UUID/email/URI/date
narrows to that kind). Literal types are never inferred — a literal is a
single-inhabitant type, zero information gain once the shape is known. An
optional `InferConfig` tunes `arrayThreshold` (min elements before inferring
`array` over `tuple`, default 3), `narrowIntegerWidth`, `detectStringFormats`,
and `leafHeuristics` (custom heuristics tried before the built-ins, first
non-`undefined` result wins).

## JSON corpus

```ts
import { fromJsonCorpus } from "@rhi-zone/fractal-type-ir/from-json-corpus"

fromJsonCorpus([
  { id: 1, name: "a" },
  { id: 2, name: "b", nickname: "bee" },
])
```

```ts
t(types.object({
  id: uint8(),
  name: t(types.string),
  nickname: t(types.string, { optional: true }),
}))
```

Infers from *multiple* JSON values, unifying evidence across the whole
corpus — this is where accumulation-only signals live: enum detection,
discriminated-union detection, dict-vs-record detection, and (as above)
optional-field detection from a field's absence in some samples. Two-phase
internally: `collectEvidence(values, config)` is a purely mechanical upward
pass that mirrors the corpus's structure without making any type-commitment
decision; `resolveEvidence(tree, strategy)` reads that evidence tree and
applies every heuristic (structural merge incl. integer-width widening, enum/
discriminated-union/dict detection). `fromJsonCorpus` runs both phases back
to back as a convenience.

## JSON Type Definition (JTD)

```ts
import { fromJtd, fromJtdDocument } from "@rhi-zone/fractal-type-ir/from-jtd"

fromJtd({
  properties: { id: { type: "uint32" }, name: { type: "string" } },
})
```

```ts
t(types.object({
  id: t(types.uint32),
  name: t(types.string),
}))
```

`fromJtd` reverses `jtd.ts`'s `toJtd` for a single schema (RFC 8927), including
its escape-hatch `metadata` flags for kinds JTD can't natively express
(`int64`, `never`, `tuple`, `intersection`, `union`, `stream`, `function`,
non-string `literal`). One documented lossy case: a JTD `enum` form always
reads back as `types.enum`, even a single-member one (RFC 8927 has no separate
"single literal string" form). `ref` forms become unresolved `types.ref`;
`fromJtdDocument(jtd)` additionally converts a root schema's `definitions`
into `{ root, defs }`.

## TypeScript

```ts
import { typeRefFromType, createExtractorProgram } from "@rhi-zone/fractal-type-ir/from-typescript"
```

General-purpose `ts.Type` + `ts.TypeChecker` → `TypeRef` extraction over a
real TypeScript compiler `Program` — primitives, literals, objects (incl.
optional/readonly/JSDoc-derived meta), arrays, tuples, unions (incl. TS
enums, literal unions, discriminated object unions), intersections (branded/
opaque-type and refinement-tag conventions), classes (→ `types.instance` +
method surface), `Map`/`Set`, index-signature types (→ `types.map`),
generics, `Promise`/`AsyncIterable` unwrapping, and an opt-in
`SharingRegistry` that extracts reused named types into `defs` instead of
inlining them at every use site. `createExtractorProgram(entryFile)` builds a
reasonable-defaults, read-only `ts.Program` for a build-time extraction pass
(`noEmit`, `skipLibCheck`, ES2022/ESNext/Bundler resolution). Needs a live
compiler instance to demo meaningfully — `typeRefFromType(type, checker, loc,
seen?, registry?)` takes a `ts.Type` already resolved against a real
`Program`, not a snippet of source text, so no fabricated before/after is
shown here. Anything genuinely unsupported (constructable types, exotic
conditional/mapped types, unconstrained generics) punts to
`t(types.unknown, { $comment: "…" })` naming the unhandled case rather than
guessing.

## GraphQL SDL

```ts
import { fromGraphql } from "@rhi-zone/fractal-type-ir/from-graphql"

fromGraphql(`
  type User {
    id: ID!
    name: String
    friends: [User!]!
  }
`)
```

```ts
// result.User:
t(types.object({
  id: t(types.string),
  name: t(types.string, { optional: true }),
  friends: t(types.array(t(types.ref("User")))),
}))
```

Returns `Record<string, TypeRef>` keyed by declared name. Parses SDL text via
`graphql-js`'s own parser (already a workspace dependency of the sibling
`graphql-api-projector` package) rather than a hand-rolled grammar. Only
type-system definitions are read (`type`, `input`, `interface`, `enum`,
`scalar`, `union`); operations, fragments, and schema/directive definitions
are ignored.

## Standard Schema

```ts
import { fromStandardSchema } from "@rhi-zone/fractal-type-ir/from-standard-schema"

fromStandardSchema(someZodOrValibotSchema)
```

```ts
t(types.object({ id: t(types.string) }), { vendor: "zod" })
```

Converts any [Standard Schema](https://standardschema.dev/) implementation
(Zod, Valibot, ArkType, …) to a `TypeRef`, in priority order: (1) if the
schema implements `StandardJSONSchemaV1` (`~standard.jsonSchema.input`), export
JSON Schema (`draft-2020-12`, falling back to `draft-07`) and delegate to
`fromJsonSchema` — the richest, most accurate path since it reflects the
vendor's own structural description; (2) otherwise fall back to a runtime
`~standard.types` sample if the vendor happens to provide one, inferring via
`fromJson`; (3) otherwise degrade to `types.unknown`. `meta.vendor`
(`~standard.vendor`) is always preserved, on every path.
