# Type IR

`@rhi-zone/fractal-type-ir` (`packages/type-ir/`) is a language-agnostic type
representation plus a library of pure functions ("projectors") that render it
into 60+ target languages, serialization libraries, schema formats, and wire
formats. It's the shared IR fractal's codegen tooling (`fractal-api-tree`,
`compile.ts`, doc generators) builds on.

## The model

```ts
type TypeRef = {
  readonly shape: TypeShape
  readonly meta: Readonly<Record<string, unknown>>
}
```

- **`shape`** is a discriminated union on `kind` — the structural payload
  (`{ kind: "object", fields }`, `{ kind: "array", element }`, …).
- **`meta`** is an open bag of side-channel conventions, not a fixed schema:
  `optional`, `nullable`, `readonly`, `description`, `deprecated`,
  `typeName`/`declarationFile`, `brand`, and anything a projector or extractor
  chooses to read. Nothing in `index.ts` enumerates the full set — consumers
  agree on keys by convention, the same way the rest of the codebase treats
  metadata bags over fixed contracts.

### `TypeKinds` — the kind vocabulary

The core structural + universal-primitive kinds live in `TypeKinds`
(`src/index.ts`): `boolean`, `number`, `integer`, `string`, `null`, `void`,
`unknown`, `never`, `object`, `instance`, `array`, `stream`, `page`, `tuple`,
`map`, `union`, `literal`, `enum`, `ref`, `intersection`, `function`,
`method`, `interface`.

A few are deliberately **not** subtypes of the kind they resemble, because
collapsing them would lose information a capable projector needs:

- `instance` (a class, nominal identity only — `className`/`source`) is not a
  subtype of `object`: a class's fields are only half its surface.
- `stream` (an async sequence) and `page` (one window over a paginated
  collection) are not subtypes of `array`: they encode laziness/backpressure
  and pagination that a plain array can't express.
- `interface` (a method surface, like a Protobuf `service`) is not a subtype
  of `object`: its members are callables, not data fields.
- `function` has no parent. `method` is the one kind that *does* register a
  parent (`function`) — see below.

Semantic refinements (`int32`/`int64`, `float32`/`float64`, `uuid`/`uri`,
`datetime`/`date`/`time`, `duration`, `bytes`, …) are **not** in this core
interface — they're independently importable extension modules under
`src/kinds/*` (`./kinds/int-widths`, `./kinds/date-time`,
`./kinds/semantic-strings`, `./kinds/bytes`, etc., or the composite
`./kinds/common` bundling all of them) that augment `TypeKinds` via
declaration merging and register their own parent relationship.

### Subtyping hierarchy: `ancestors`/`resolve`/`registerParent`

```ts
export function registerParent(kind: string, parent: string | null): void
export function ancestors(kind: string): string[]
export function resolve<T>(kind: string, handlers: Record<string, T>): T | undefined
```

Each kind has at most one parent, tracked in a flat `Record<string, string | null>`.
`ancestors("int32")` walks that chain (`int32 → integer → number`, say).
`resolve(kind, handlers)` is what every projector calls to dispatch: look up
`kind` in the handler table, and if it's missing, walk `ancestors(kind)` and
use the first handler found. This is the fallback mechanism that lets a
projector with no `int32` handler still render an `int32` correctly, by
falling back to its `integer` (then `number`) handler — a kind extension
module doesn't require every one of the 60+ projectors to be updated to stay
correct, only the ones that care about the distinction.

`registerParent` is exported so extension modules (`src/kinds/*`, or a
consumer's own declaration-merged kind) can wire themselves into the chain
without editing `index.ts`.

### Building a `TypeRef`

```ts
import { t, types } from "@rhi-zone/fractal-type-ir"

const user = t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string, { format: "email" }),
  bio: { shape: types.string, meta: { optional: true } },
}))
```

`t(shape, meta?)` wraps a shape into a `TypeRef`. `types.*` are shape
constructors, one per kind (`types.object(fields)`, `types.array(element)`,
`types.union(variants)`, `types.literal(value)`, …) — see `src/index.ts` for
the full constructor list. Structural derive helpers (`partial`, `required`,
`pick`, `omit`, `extend`, `nullable`, `withMeta`, `deepPartial`,
`deepRequired`) transform an existing `TypeRef` into another one; see
[`derive.md`](./derive.md).

### `TypeRefDocument` — named/recursive types

```ts
type TypeRefDocument = {
  readonly root: TypeRef
  readonly defs: Readonly<Record<string, TypeRef>>
}
```

A bare `TypeRef` has no registry to resolve `{ kind: "ref", target }` against.
`TypeRefDocument` closes that gap: `root` plus every named definition `ref`s
in the tree point into. Every function that historically took a bare
`TypeRef` still works — a `TypeRef` with no `defs` is just a document with no
shared definitions. Doc-page projectors ([`doc-projectors.md`](./doc-projectors.md))
and several importers that produce multiple related types (e.g.
`from-protobuf`) operate on `TypeRefDocument` rather than a bare `TypeRef`.

## How projectors work

A projector is a pure function `TypeRef => string` (code-generating
projectors) or `TypeRef => <document>` (schema/wire-format projectors that
produce a structured object rather than source text). Internally, essentially
every one follows the same shape:

```ts
const handlers: Record<string, Converter> = {
  boolean: () => "boolean",
  object: (shape) => { /* render fields */ },
  array: (shape) => { /* render element */ },
  // ...
}

export function toX(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? /* fallback */ : converter(ref.shape)
}
```

`resolve` (see above) means a projector only needs handlers for the kinds it
actually cares to special-case; anything else falls back through the
subtyping chain, and a kind with no ancestor and no handler degrades to
whatever the projector considers its default "unknown" case (`unknown` in
TypeScript, `Any` in Python, an opaque placeholder in a schema format, or in
some cases an explicit throw for formats — like Cap'n Proto — that have no
honest way to degrade a purely-nominal `instance`).

## Reference pages

Each page below groups the projectors/importers for one language, format
family, or transform family, with a worked example per variant:

- [TypeScript](./typescript.md) — native, Zod, Valibot, TypeBox, io-ts, Yup,
  Superstruct, Runtypes, ArkType, Effect Schema, JSDoc
- [Python](./python.md) — dataclasses, Pydantic, attrs, msgspec, cattrs
- [Go](./go.md) — encoding/json, easyjson, jsoniter, sonic
- [Java](./java.md) — Jackson, Gson, Moshi, JSON-B
- [Kotlin](./kotlin.md) — kotlinx.serialization, Jackson, Gson
- [Swift](./swift.md) — Codable, SwiftyJSON, ObjectMapper
- [C#](./csharp.md) — System.Text.Json, Newtonsoft, ServiceStack
- [C++](./cpp.md) — nlohmann/json, RapidJSON, simdjson, Boost.JSON, Glaze
- [Rust](./rust.md) — serde
- [Ruby](./ruby.md) — Sorbet, dry-types, RBS
- [PHP](./php.md) — native, Symfony, JMS
- [Dart](./dart.md) — json_serializable, Freezed, built_value
- [Other languages](./other-languages.md) — Haskell (aeson), Elm, Flow,
  Objective-C (Foundation), Crystal
- [Schema formats](./schema-formats.md) — JSON Schema (2020-12/07/04),
  OpenAPI (3.0/2.0), JSON Type Definition, Standard Schema
- [Wire formats](./wire-formats.md) — Protobuf, Cap'n Proto, FlatBuffers,
  SQL DDL (+ MSSQL), GraphQL SDL, JSON-RPC
- [Importers](./importers.md) — the `from-*` subpaths: format → `TypeRef`
- [Doc projectors](./doc-projectors.md) — Docusaurus, Starlight, MkDocs
  reference-page generators
- [Derive](./derive.md) — structural `TypeRef → TypeRef` transforms
  (`partial`, `pick`, `nullable`, …)
