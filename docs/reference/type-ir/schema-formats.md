# Schema formats

Each of these projectors lowers a `TypeRef` to a schema **document** — a
plain JSON-serializable object, not source code text. All examples below
render the same shape:

```ts
import { t, types } from "@rhi-zone/fractal-type-ir"

const user = t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string),
  age: { shape: types.integer, meta: { optional: true, minimum: 0 } },
}))
```

## JSON Schema (2020-12)

```ts
import { toJsonSchema, toJsonSchemaDocument } from "@rhi-zone/fractal-type-ir/json-schema"

toJsonSchema(user)
```

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "integer" },
    "name": { "type": "string" },
    "email": { "type": "string" },
    "age": { "type": "integer", "minimum": 0 }
  },
  "required": ["id", "name", "email"]
}
```

The current default draft (2020-12). `toJsonSchemaDocument(doc)` projects a
whole `TypeRefDocument` — root schema plus a top-level `$defs` object (one
entry per `doc.defs`, §8.2.4) that `ref` handlers' `#/$defs/NAME` `$ref`s
resolve against; empty/absent `defs` omits `$defs` entirely.

## JSON Schema (draft-07)

```ts
import { toJsonSchema07 } from "@rhi-zone/fractal-type-ir/json-schema-07"

toJsonSchema07(user)
```

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "integer" },
    "name": { "type": "string" },
    "email": { "type": "string" },
    "age": { "type": "integer", "minimum": 0 }
  },
  "required": ["id", "name", "email"]
}
```

Divergences from 2020-12 handled internally: tuples via `items` array +
`additionalItems` (2020-12 renamed this to `prefixItems`), `$ref` targets
`#/definitions/...` instead of `#/$defs/...`, `never` as the literal boolean
schema `false` (draft-07 permits boolean schemas).

## JSON Schema (draft-04)

```ts
import { toJsonSchema04Document } from "@rhi-zone/fractal-type-ir/json-schema-04"

toJsonSchema04Document(user)
```

```json
{
  "$schema": "http://json-schema.org/draft-04/schema#",
  "type": "object",
  "properties": {
    "id": { "type": "integer" },
    "name": { "type": "string" },
    "email": { "type": "string" },
    "age": { "type": "integer", "minimum": 0 }
  },
  "required": ["id", "name", "email"]
}
```

`toJsonSchema04(ref)` renders a bare per-node schema; `toJsonSchema04Document(ref, declaration?)`
wraps it with draft-04's document-level keywords (`$schema`, `id`,
`definitions`). No `const` (draft-06+) — literals become `enum: [value]`; no
boolean schemas — `never` is `{ "not": {} }`; `exclusiveMinimum`/
`exclusiveMaximum` are booleans modifying `minimum`/`maximum`, not standalone
numbers (that arrives in draft-06); no `readOnly`/`writeOnly`/`examples`/
`propertyNames`.

## OpenAPI 3.0

```ts
import { toOpenApi30, toOpenApi30Document } from "@rhi-zone/fractal-type-ir/openapi30"

toOpenApi30(user)
```

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "integer" },
    "name": { "type": "string" },
    "email": { "type": "string" },
    "age": { "type": "integer", "minimum": 0 }
  },
  "required": ["id", "name", "email"]
}
```

OAS 3.0.3's Schema Object (§4.8.24) is a JSON Schema Wright Draft-05-based
vocabulary: `nullable: true` (no type-array nullable), boolean
`exclusiveMinimum`/`exclusiveMaximum` modifiers (same draft-04-style encoding
as `openapi20.ts`/`json-schema-04.ts` — the numeric standalone form arrives
only with OAS 3.1's move to 2020-12). `toOpenApi30Document(doc)` returns
`{ schema, components: { schemas } }` — the caller merges `components.schemas`
into a full OAS document's own top-level `components`.

## OpenAPI 2.0 (Swagger)

```ts
import { toOpenApi20, toOpenApi20Definitions } from "@rhi-zone/fractal-type-ir/openapi20"

toOpenApi20(user)
```

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "integer" },
    "name": { "type": "string" },
    "email": { "type": "string" },
    "age": { "type": "integer", "minimum": 0 }
  },
  "required": ["id", "name", "email"]
}
```

Swagger 2.0 (§4.6/§4.7.4) restricts the vocabulary further than draft-04: no
`oneOf`/`anyOf`/`not`, `type` must be a single string, no `nullable` keyword
(the de facto `x-nullable` vendor extension is used instead), no
`deprecated` (emitted as `x-deprecated`), no `writeOnly`. `toOpenApi20Definitions(refs)`
builds the top-level `definitions` map keyed by name, for `#/definitions/Name`
refs.

## JSON Type Definition (JTD)

```ts
import { toJtd } from "@rhi-zone/fractal-type-ir/jtd"

toJtd(user)
```

```json
{
  "properties": {
    "id": { "type": "int32" },
    "name": { "type": "string" },
    "email": { "type": "string" }
  },
  "optionalProperties": {
    "age": { "type": "int32", "metadata": { "minimum": 0 } }
  }
}
```

RFC 8927's eight schema forms (empty/type/enum/elements/properties/values/
discriminator/ref). `optional`/`nullable` map to JTD's own
`optionalProperties` split / top-level `nullable` keyword; everything else in
`meta` rides in `metadata` (§2.2.7, the spec's explicit ignore-me extension
point — same role `x-*` vendor extensions play in the OpenAPI formats above).
JTD has no generic "number"/"integer" — `number` degrades to `float64`,
`integer` to `int32`.

## Standard Schema

```ts
import { toStandardSchema } from "@rhi-zone/fractal-type-ir/standard-schema"

const schema = toStandardSchema(user)
schema["~standard"].vendor    // "fractal-type-ir"
schema["~standard"].validate(value)
schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })
```

Implements both interfaces the [Standard Schema](https://standardschema.dev/)
spec defines: `StandardSchemaV1` (`~standard.validate` — structural runtime
validation, interpreting the `TypeRef` tree directly against a value, not
codegen) and `StandardJSONSchemaV1` (`~standard.jsonSchema.input`/`.output`,
delegating to this package's own JSON Schema/OpenAPI projectors for the
spec's three named targets — `"draft-2020-12"` → `toJsonSchema`,
`"draft-07"` → `toJsonSchema07`, `"openapi-3.0"` → `toOpenApi30`). Input and
output are identical — no defaults injection or coercion happens here.
