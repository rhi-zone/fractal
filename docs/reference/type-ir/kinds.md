# Type IR: kind reference

Exhaustive, field-by-field reference for every `TypeShape` kind — the core
`TypeKinds` vocabulary from `src/index.ts` plus every extension kind
registered by `src/kinds/*.ts`. See [the overview](./index.md) for the
conceptual model (`TypeRef`/`TypeShape`/`meta`, the `ancestors`/`resolve`/
`registerParent` subtyping mechanism, and why several kinds deliberately do
NOT subtype the kind they resemble). This page is the checklist to keep open
while building a new projector or importer: every kind, its exact shape, its
parent (if any), and a minimal `types.*` constructor call.

## Summary

### Core kinds (`src/index.ts`)

| kind | parent | one-line semantic |
|---|---|---|
| `boolean` | — | true/false |
| `number` | — | any numeric value |
| `integer` | `number` | whole-number numeric value |
| `string` | — | text |
| `null` | — | the null value |
| `void` | — | absence of a return value |
| `unknown` | — | unconstrained/unresolved type |
| `never` | — | uninhabited type |
| `object` | — | structural record of named fields |
| `instance` | — | nominal class identity only (no fields) |
| `array` | — | synchronous, materialized, indexable collection |
| `stream` | — | asynchronously-produced sequence of values |
| `page` | — | one window over a paginated collection |
| `tuple` | — | fixed-length, positionally-typed collection |
| `map` | — | dynamic-key dictionary |
| `union` | — | one of several variant types |
| `literal` | — | one exact value |
| `enum` | — | closed set of string members, no payload |
| `ref` | — | named reference into a `TypeRefDocument`'s `defs` |
| `intersection` | — | all-of several member types |
| `function` | — | standalone callable type |
| `method` | `function` | callable belonging to a type's method surface |
| `interface` | — | type whose surface is callables, not data |

### Extension kinds (`src/kinds/*.ts`)

| kind | parent | module | one-line semantic |
|---|---|---|---|
| `int8`/`int16`/`int32`/`int64` | `integer` | int-widths.ts | fixed-width signed integers |
| `uint8`/`uint16`/`uint32`/`uint64` | `integer` | int-widths.ts | fixed-width unsigned integers |
| `float32`/`float64` | `number` | float-widths.ts | fixed-width floating-point |
| `datetime` | — | date-time.ts | domain `Date`-with-time value |
| `date` | — | date-time.ts | domain date-only value |
| `time` | `string` | date-time.ts | time-of-day, formatted string |
| `duration` | `string` | duration.ts | elapsed time, formatted string |
| `uuid` | `string` | semantic-strings.ts | UUID-formatted string |
| `uri` | `string` | semantic-strings.ts | URI-formatted string |
| `email` | `string` | semantic-strings.ts | email-formatted string |
| `bytes` | — | bytes.ts | binary blob |

`refinements.ts` registers no IR kind — see [Extension kinds § refinements.ts](#refinements-ts).

---

## Core kinds

### `boolean`

```ts
{ readonly kind: "boolean" }
```

- **Parent:** none.
- **Semantics:** true/false. Maps to every target language's native boolean.
- **Constructor:** `types.boolean` — a value, not a function (`t(types.boolean)`).

### `number`

```ts
{ readonly kind: "number" }
```

- **Parent:** none.
- **Semantics:** any numeric value — the untyped-width numeric root that
  `integer`, and every extension numeric kind, ultimately chains up to via
  `ancestors()`.
- **Constructor:** `types.number` (`t(types.number)`).

### `integer`

```ts
{ readonly kind: "integer" }
```

- **Parent:** `number`.
- **Semantics:** a whole-number numeric value with no fixed bit width. A
  projector without an `integer` handler falls back to its `number` handler.
- **Constructor:** `types.integer` (`t(types.integer)`).

### `string`

```ts
{ readonly kind: "string" }
```

- **Parent:** none.
- **Semantics:** text. Root that `time`, `duration`, `uuid`, `uri`, `email`
  (all extension kinds) chain up to.
- **Constructor:** `types.string` (`t(types.string)`).

### `null`

```ts
{ readonly kind: "null" }
```

- **Parent:** none.
- **Semantics:** the null value itself (distinct from `meta.nullable`, which
  marks an existing type as *additionally* accepting null).
- **Constructor:** `types.null` (`t(types.null)`).

### `void`

```ts
{ readonly kind: "void" }
```

- **Parent:** none.
- **Semantics:** absence of a return value — a function/method's `returnType`
  when nothing is returned.
- **Constructor:** `types.void` (`t(types.void)`).

### `unknown`

```ts
{ readonly kind: "unknown" }
```

- **Parent:** none.
- **Semantics:** an unconstrained or unresolved type. Also the conventional
  degrade target a code-generating projector falls back to for a kind it has
  no handler and no ancestor for (see [index.md](./index.md#how-projectors-work)).
- **Constructor:** `types.unknown` (`t(types.unknown)`).

### `never`

```ts
{ readonly kind: "never" }
```

- **Parent:** none.
- **Semantics:** an uninhabited type — no value can have this type. Also
  what `fromJsonSchema` produces for an empty `not: {}` schema.
- **Constructor:** `types.never` (`t(types.never)`).

### `object`

```ts
{ readonly kind: "object"; readonly fields: Readonly<Record<string, TypeRef>> }
```

- **Parent:** none.
- **Semantics:** a structural record of named fields, each itself a
  `TypeRef` (so per-field `meta.optional`/`meta.nullable`/`meta.readonly`
  etc. apply at the field level). Structural — no name of its own; naming is
  a declaration concern (`meta.typeName`), not part of the shape.
- **Constructor:**
  ```ts
  types.object({ id: t(types.integer), name: t(types.string) })
  ```

### `instance`

```ts
{
  readonly kind: "instance"
  readonly className: string
  readonly declarationFile: string
}
```

- **Parent:** none — **deliberately not a subtype of `object`**.
- **Semantics:** a class instance, purely nominal — carries only class
  identity, never structure. Per the doc comment: "a class's fields are only
  half its surface (methods are the other half, and often the point), so
  exposing `fields` here would misrepresent the type as plain data."
  Projectors that can express nominal identity read `className` (Zod's
  `z.instanceof`, JSON Schema's `x-class-name`); projectors that can't
  (protobuf, Cap'n Proto, SQL — anything needing a structural shape to emit)
  have no ancestor to fall back on and must degrade explicitly rather than
  silently rendering an object with no fields. `className` is kept distinct
  from `meta.typeName` — nominal class identity and a named-type reference
  for codegen imports are different mechanisms that happen to both carry a
  name — but `declarationFile` is the same concept `meta.declarationFile`
  names, aligned on that one field.
- **Constructor:**
  ```ts
  types.instance("User", "/src/models/user.ts")
  ```

### `array`

```ts
{ readonly kind: "array"; readonly element: TypeRef }
```

- **Parent:** none.
- **Semantics:** a synchronous, materialized, indexable collection —
  TypeScript's `T[]`/`Array<T>`. Root that `stream` and `page` deliberately
  do NOT chain up to (see below).
- **Constructor:**
  ```ts
  types.array(t(types.string))
  ```

### `stream`

```ts
{ readonly kind: "stream"; readonly element: TypeRef }
```

- **Parent:** none — **deliberately not a subtype of `array`**.
- **Semantics:** an asynchronously-produced sequence of values —
  TypeScript's `AsyncIterable<T>`/`AsyncGenerator<T, TReturn, TNext>` (and
  the `AsyncIterableIterator<T>` an `async function*` returns), or a
  server-streaming gRPC/service response. Per the doc comment: "an array is
  a materialized, synchronously-indexable collection, while a stream is an
  ongoing production of values over time — collapsing the two would
  misrepresent backpressure/laziness semantics that matter to projectors
  capable of expressing them natively" (TypeScript's `AsyncIterable<T>`,
  GraphQL subscriptions, gRPC server-streaming RPCs). Projectors without a
  native streaming construct degrade to their array/list equivalent over
  `element` — the honest-degrade convention, since the element type is still
  the closest structural analogue once asynchrony/laziness can't be
  preserved.
- **Constructor:**
  ```ts
  types.stream(t(types.string))
  ```

### `page`

```ts
{ readonly kind: "page"; readonly element: TypeRef; readonly style: "cursor" | "offset" }
```

- **Parent:** none — **deliberately not a subtype of `array`**.
- **Semantics:** a paginated collection — TypeScript's
  `CursorPage<T>`/`OffsetPage<T>`/`Page<T>` convention
  (`@rhi-zone/fractal-api-tree`'s pagination types). A handler returning one
  of these shapes (or `Promise<...>` of one) signals "this endpoint is
  paginated," the same convention-detection role `AsyncIterable<T>` plays
  for `stream`. `style` records which variant matched — `"cursor"` for
  `CursorPage<T>` (an opaque `cursor`/`hasMore` continuation token) or
  `"offset"` for `OffsetPage<T>` (a numeric `offset`/`total`/`hasMore`
  window). Per the doc comment: "a page is one WINDOW over a larger,
  not-yet-fetched collection, not the collection itself" — same reasoning as
  `stream`. A projector that can't express pagination natively degrades to
  its array/list equivalent over `element`.
- **Constructor:**
  ```ts
  types.page(t(types.object({ id: t(types.integer) })), "cursor")
  ```

### `tuple`

```ts
{ readonly kind: "tuple"; readonly elements: readonly TypeRef[] }
```

- **Parent:** none.
- **Semantics:** a fixed-length, positionally-typed collection — TypeScript's
  `[string, number]`.
- **Constructor:**
  ```ts
  types.tuple([t(types.string), t(types.integer)])
  ```

### `map`

```ts
{ readonly kind: "map"; readonly key: TypeRef; readonly value: TypeRef }
```

- **Parent:** none.
- **Semantics:** a dynamic-key dictionary — TypeScript's `Record<K, V>`/
  `Map<K, V>`. Also what `fromJsonSchema`/`fromOpenApi` ingest an
  object-with-schema `additionalProperties` into directly, bypassing
  `meta.additionalPropertyType`.
- **Constructor:**
  ```ts
  types.map(t(types.string), t(types.integer))
  ```

### `union`

```ts
{ readonly kind: "union"; readonly variants: readonly TypeRef[] }
```

- **Parent:** none.
- **Semantics:** one of several variant types — TypeScript's `A | B`. Numeric
  and mixed-type TS enums (which don't fit `enum`, below) lower to a `union`
  of `literal`s instead.
- **Constructor:**
  ```ts
  types.union([t(types.string), t(types.integer)])
  ```

### `literal`

```ts
{ readonly kind: "literal"; readonly value: string | number | boolean | null }
```

- **Parent:** none.
- **Semantics:** one exact value — TypeScript's `"foo"` or `42` literal
  types. `value` is restricted to `string | number | boolean | null`.
- **Constructor:**
  ```ts
  types.literal("foo")
  ```

### `enum`

```ts
{ readonly kind: "enum"; readonly members: readonly string[] }
```

- **Parent:** none.
- **Semantics:** a closed set of string members with no associated payload —
  informationally the same as a `union` of same-valued `literal` strings,
  kept as a distinct kind because most target languages have a native
  construct for it (TS/Kotlin/Swift/Rust string enums, protobuf/Cap'n Proto
  `enum`) that a projector would rather emit directly than reconstruct by
  pattern-matching a literal union. `members` is `readonly string[]` only —
  numeric and mixed-type enums (e.g. a TS numeric enum) don't fit this kind
  and lower to `union` of `literal` instead (see `from-typescript.ts`'s
  union-lowering).
- **Constructor:**
  ```ts
  types.enum(["ACTIVE", "INACTIVE"])
  ```

### `ref`

```ts
{ readonly kind: "ref"; readonly target: string }
```

- **Parent:** none.
- **Semantics:** a named reference into a `TypeRefDocument`'s `defs`, used
  for recursive and shared types. `target` is a plain string (not itself a
  `TypeRef`), so a `ref` contributes no children when walking a tree
  (`childTypeRefs`) — walking `root`+`defs` can never cycle structurally.
  `resolveRef(doc, ref)` resolves it against `defs`, throwing if `target` is
  missing (an unresolvable ref is a malformed document). A bare `TypeRef`
  with no `defs` simply never contains a `ref` for callers that don't
  produce one.
- **Constructor:**
  ```ts
  types.ref("User")
  ```

### `intersection`

```ts
{ readonly kind: "intersection"; readonly members: readonly TypeRef[] }
```

- **Parent:** none.
- **Semantics:** all-of several member types — TypeScript's `A & B`.
- **Constructor:**
  ```ts
  types.intersection([t(types.object({ id: t(types.integer) })), t(types.ref("Timestamped"))])
  ```

### `function`

```ts
{
  readonly kind: "function"
  readonly params: readonly { readonly name: string; readonly type: TypeRef }[]
  readonly returnType: TypeRef
  readonly thisType?: TypeRef
}
```

- **Parent:** none.
- **Semantics:** a callable type: ordered parameters, a return type, and an
  optional `this` binding (present for class methods and other functions
  with an explicit/implicit `this` — e.g. `types.instance("ClassName",
  declarationFile)`; absent for free functions with no `this`). Not used to
  inline class methods onto `instance` (which stays purely nominal); this
  kind is for callable types that appear in type positions (callback
  params, fields, etc.).
- **Constructor:**
  ```ts
  types.function(
    [{ name: "x", type: t(types.integer) }],
    t(types.boolean),
  )
  ```
  (`thisType` is a 3rd, optional argument.)

### `method`

```ts
{
  readonly kind: "method"
  readonly params: readonly { readonly name: string; readonly type: TypeRef }[]
  readonly returnType: TypeRef
  readonly thisType?: TypeRef
}
```

- **Parent:** `function` — `registerParent("method", "function")` means any
  projector without an explicit `method` handler falls back to its
  `function` handler automatically (see `resolve`).
- **Semantics:** a callable that belongs to a type's contract — not a
  standalone callable (that's `function`), but the shape of one entry in a
  service/interface's method surface. Same fields as `function` because a
  method IS a callable; kept distinct so projectors that DO care about the
  difference (protobuf RPCs, Cap'n Proto interface methods, TypeScript
  method-signature syntax vs. arrow-function syntax) can special-case it.
- **Constructor:**
  ```ts
  types.method(
    [{ name: "id", type: t(types.integer) }],
    t(types.object({ id: t(types.integer) })),
  )
  ```
  (`thisType` is a 3rd, optional argument.)

### `interface`

```ts
{
  readonly kind: "interface"
  readonly methods: Readonly<Record<string, TypeRef>>
}
```

- **Parent:** none — **deliberately not a subtype of `object`**.
- **Semantics:** a type that carries methods — the equivalent of Protobuf's
  `service` or Cap'n Proto's `interface`: not data, a contract of callable
  operations. Structural (no name of its own — naming is a declaration
  concern, same as `object`). `methods` are TypeRefs, typically (but not
  necessarily) of `method` kind. Same reasoning as `instance`: an
  interface's methods are not `object` fields, and projectors that can't
  express a service surface must degrade explicitly rather than silently
  rendering an object.
- **Constructor:**
  ```ts
  types.interface({
    getUser: t(types.method([{ name: "id", type: t(types.integer) }], t(types.ref("User")))),
  })
  ```

---

## Extension kinds

Registered by `src/kinds/*.ts` via declaration merging on `TypeKinds` plus a
`registerParent` call — none of these live in `index.ts` itself. Each module
is independently importable; `common.ts` bundles all of them.

### `int-widths.ts`

Fixed-width integer kinds, all with parent `integer`:

| kind | shape | constructor |
|---|---|---|
| `int8` | `{ readonly kind: "int8" }` | `int8(meta?)` |
| `int16` | `{ readonly kind: "int16" }` | `int16(meta?)` |
| `int32` | `{ readonly kind: "int32" }` | `int32(meta?)` |
| `int64` | `{ readonly kind: "int64" }` | `int64(meta?)` |
| `uint8` | `{ readonly kind: "uint8" }` | `uint8(meta?)` |
| `uint16` | `{ readonly kind: "uint16" }` | `uint16(meta?)` |
| `uint32` | `{ readonly kind: "uint32" }` | `uint32(meta?)` |
| `uint64` | `{ readonly kind: "uint64" }` | `uint64(meta?)` |

Example: `int32()` → `t({ kind: "int32" })`. A projector with no `int32`
handler falls back to `integer`, then `number`.

### `float-widths.ts`

Fixed-width float kinds, both with parent `number`:

| kind | shape | constructor |
|---|---|---|
| `float32` | `{ readonly kind: "float32" }` | `float32(meta?)` |
| `float64` | `{ readonly kind: "float64" }` | `float64(meta?)` |

### `wire-numerics.ts`

Not a kind-adding module itself — a composite that re-exports
`int-widths.ts` + `float-widths.ts` in one import, "as commonly needed
together for wire formats (protobuf, Avro, TypeBox, …)."

### `date-time.ts`

| kind | shape | parent | constructor |
|---|---|---|---|
| `datetime` | `{ readonly kind: "datetime" }` | none | `datetime(meta?)` |
| `date` | `{ readonly kind: "date" }` | none | `date(meta?)` |
| `time` | `{ readonly kind: "time" }` | `string` | `time(meta?)` |

Doc-comment rationale, quoted closely: `datetime`/`date` represent the
**domain type** (JS `Date`), not a wire format — type-ir describes what a
value IS, not how it's serialized. Neither is a subtype of `string`: a
`Date` isn't structurally a string (no `.length`, no `.charAt`, …), so
chaining to `string`'s handlers/constraints (`minLength`/`pattern`/etc.)
would be structurally wrong wherever a projector lacks an explicit
`datetime`/`date` entry and falls back through `ancestors()`. Every
projector in this package DOES carry an explicit `datetime`/`date` handler
— the wire-format string (`"2024-01-01T00:00:00Z"`) is a *projection
concern* produced by the projector targeting that wire format, not baked
into the IR shape.

`time` stays a subtype of `string` — JS has no native time-of-day type (no
`Time` class the way `datetime`/`date` have `Date`), so representing it as
anything other than a formatted string would invent a domain type this
runtime doesn't have.

### `duration.ts`

| kind | shape | parent | constructor |
|---|---|---|---|
| `duration` | `{ readonly kind: "duration" }` | `string` | `duration(meta?)` |

Elapsed-time kind; subtypes `string`.

### `temporal.ts`

Not a kind-adding module itself — a composite re-exporting `date-time.ts` +
`duration.ts`.

### `semantic-strings.ts`

| kind | shape | parent | constructor |
|---|---|---|---|
| `uuid` | `{ readonly kind: "uuid" }` | `string` | `uuid(meta?)` |
| `uri` | `{ readonly kind: "uri" }` | `string` | `uri(meta?)` |
| `email` | `{ readonly kind: "email" }` | `string` | `email(meta?)` |

Semantically-tagged string kinds, all subtyping `string`. The module also
exports canonical TS brand types (`Uuid`, `Uri`, `Email`) for consumers
authoring TS source that `from-typescript.ts` reads: a field typed as one of
these brands round-trips through extraction as the matching IR kind
(`types.uuid`/`types.uri`/`types.email`) instead of degrading to
`t(types.string, { brand: "..." })`. The brand lives behind a shared
`unique symbol` key (`BrandTag`) rather than a named string property, so it
is phantom and structurally inaccessible at runtime — the tag's string
literal value (not the symbol's declared name) carries the brand name,
matched case-insensitively by the extractor's promotion lookup.

### `bytes.ts`

| kind | shape | parent | constructor |
|---|---|---|---|
| `bytes` | `{ readonly kind: "bytes" }` | none | `bytes(meta?)` |

Binary blob kind. No parent — orthogonal to `string`, matching the core
hierarchy, where `bytes` was never a subtype of `string`.

### `refinements.ts`

Registers **no IR kind** — it's TS-type-only, read purely by the
extractor's static analysis, with no runtime constructor and nothing added
to `TypeKinds`. It exports branded refinement-tag types (`MinLength<N>`,
`MaxLength<N>`, `Pattern<P>`, `Format<F>`, `Minimum<N>`, `Maximum<N>`,
`ExclusiveMinimum<N>`, `ExclusiveMaximum<N>`, `MultipleOf<N>`) for consumers
authoring TS source that `from-typescript.ts`'s ingester reads. Intersecting
a base type with one or more of these tags (e.g. `string & MinLength<2> &
MaxLength<100>`) round-trips through extraction as the base kind carrying
the matching `meta` refinement key(s) (`minLength`/`maxLength`/…) — the same
keys `compile.ts` already validates and every projector (json-schema,
effect-schema, sql, …) already reads. All tags share one `unique symbol` key
(`RefinementTag`) rather than each carrying its own distinct property name,
but with a *structured* value (`{ minLength: N }`) instead of a single
string literal, so intersecting several tags merges their value objects
instead of colliding on one shared string.

### `common.ts`

Not a kind-adding module itself — the composite bundling every extension
module shipped with this package: `wire-numerics.ts`, `temporal.ts`,
`semantic-strings.ts`, `bytes.ts`, `refinements.ts`. "Convenience import for
consumers that want the full pre-1.0 vocabulary without picking modules
individually." Importing it registers every extension kind above
(`int8`…`uint64`, `float32`/`float64`, `datetime`/`date`/`time`, `duration`,
`uuid`/`uri`/`email`, `bytes`) plus the kind-less `refinements.ts` types.

---

## Unrecognized kinds

A projector or importer that encounters a `kind` string it has no handler
for — a consumer's own declaration-merged kind, or an extension module it
wasn't built against — doesn't need to know about it in advance. `resolve()`
walks `ancestors(kind)` (populated by that kind's own `registerParent` call)
and uses the first handler found up the chain, so an extension kind degrades
gracefully to whatever its nearest documented ancestor renders as. See
[index.md](./index.md#subtyping-hierarchy-ancestors-resolve-registerparent)
for the full mechanism.
