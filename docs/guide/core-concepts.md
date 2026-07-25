# Fractal — Type-IR Core Concepts

A guide to the type-representation half of fractal, grounded in the as-built
code. This page assumes familiarity with [Core Concepts](./concepts.md) (the
API-tree/`Node` model) — it does not repeat that material, only the shared
pattern underneath both.

---

## 1. Same pattern, different domain

Fractal has two independent domains that share one structural pattern:

- **`@rhi-zone/fractal-api-tree`** — a `Node` discriminated union representing
  *routing* (which operation handles which request).
- **`@rhi-zone/fractal-type-ir`** — a `TypeRef` discriminated union
  representing *types* (what shape a value has), language-agnostic, feeding
  60+ projectors and importers.

Both are instances of the same three-layer separation — constructors that
produce a DU, an extensible DU, and interpreters/projectors that consume it
(see §5 below, and `docs/design/architecture-layers.md`). This page covers
the type-IR side.

---

## 2. `TypeRef` — the model

```ts
// packages/type-ir/src/index.ts
export type TypeRef = {
  readonly shape: TypeShape
  readonly meta: Readonly<Record<string, unknown>>
}
```

- **`shape`** — a discriminated union on `kind`, the structural payload
  (`{ kind: "object", fields }`, `{ kind: "array", element }`, …).
- **`meta`** — an open bag of side-channel conventions (§4). Never a second
  source of structural truth — `shape` alone determines what a `TypeRef` *is*.

`TypeShape = TypeKinds[keyof TypeKinds]`, where `TypeKinds` is the
augmentable interface (§3) enumerating every registered kind.

### Constructors: `t()` and `types.*`

```ts
import { t, types } from "@rhi-zone/fractal-type-ir"

const user = t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string, { format: "email" }),
  bio: t(types.string, { optional: true }),
}))
```

`t(shape, meta?)` wraps a shape into a `TypeRef` (`meta` defaults to `{}`).
`types.*` is one shape-constructor function per kind — `types.object(fields)`,
`types.array(element)`, `types.union(variants)`, `types.literal(value)`,
`types.map(key, value)`, and so on (`packages/type-ir/src/index.ts`). Structural
derive helpers (`partial`, `required`, `pick`, `omit`, `extend`, `nullable`,
`withMeta`, `deepPartial`, `deepRequired`, in `derive.ts`) transform an
existing `TypeRef` into another `TypeRef` — see
[`docs/reference/type-ir/derive.md`](../reference/type-ir/derive.md).

---

## 3. The DU pattern: `TypeKinds`, subtyping, and fallback

`TypeKinds` is the same "augmentable interface → discriminated union" pattern
`Node` uses, applied to types. The core module (`packages/type-ir/src/index.ts`)
defines the structural + universal-primitive kinds only:

```ts
export interface TypeKinds {
  boolean: { readonly kind: "boolean" }
  number: { readonly kind: "number" }
  integer: { readonly kind: "integer" }
  string: { readonly kind: "string" }
  object: { readonly kind: "object"; readonly fields: Readonly<Record<string, TypeRef>> }
  array: { readonly kind: "array"; readonly element: TypeRef }
  union: { readonly kind: "union"; readonly variants: readonly TypeRef[] }
  ref: { readonly kind: "ref"; readonly target: string }
  // … null, void, unknown, never, instance, stream, page, tuple, map,
  //     literal, enum, intersection, function, method, interface
}
```

Everything else — `int8`..`uint64`, `float32`/`float64`, `uuid`/`uri`/`email`,
`datetime`/`date`/`time`, `duration`, `bytes` — lives in independently
importable extension modules under `packages/type-ir/src/kinds/*.ts`
(`int-widths.ts`, `float-widths.ts`, `semantic-strings.ts`, `date-time.ts`,
`duration.ts`, `bytes.ts`, `wire-numerics.ts`, `refinements.ts`, `temporal.ts`,
or the composite `kinds/common.ts` bundling the pre-1.0 vocabulary). Each
augments `TypeKinds` via TypeScript declaration merging and registers its
parent:

```ts
// packages/type-ir/src/kinds/int-widths.ts
declare module "../index.ts" {
  interface TypeKinds {
    int8: { readonly kind: "int8" }
    int32: { readonly kind: "int32" }
    // …
  }
}

registerParent("int8", "integer")
registerParent("int32", "integer")

export const int32 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "int32" }, meta)
```

### Hierarchy via subtyping, not taxonomy

Kinds form a hierarchy that mirrors actual subtyping (`int32 → integer →
number`, `uuid → string`), never an invented taxonomic superclass. Some kinds
are deliberately parentless even though they resemble another kind
structurally: `instance` is *not* a subtype of `object` (a class's fields are
only half its surface — methods are the other half); `stream` and `page` are
*not* subtypes of `array` (they encode laziness/backpressure and pagination
that plain arrays can't express); `interface` is *not* a subtype of `object`
(its members are callables, not data fields). `method` is the one kind that
*does* register a parent — `function` — because a method genuinely is a
callable.

### `ancestors` / `resolve` / `registerParent`

```ts
// packages/type-ir/src/index.ts
export function registerParent(kind: string, parent: string | null): void

export function ancestors(kind: string): string[] {
  const chain: string[] = []
  let current = parents[kind] ?? undefined
  while (current !== undefined) {
    chain.push(current)
    current = parents[current] ?? undefined
  }
  return chain
}

export function resolve<T>(
  kind: string,
  handlers: Record<string, T>,
): T | undefined {
  if (kind in handlers) return handlers[kind]
  for (const ancestor of ancestors(kind)) {
    if (ancestor in handlers) return handlers[ancestor]
  }
  return undefined
}
```

`parents` is a flat `Record<string, string | null>`, mutated in place by
`registerParent` — this is how an extension module wires a new kind into the
chain without editing `index.ts`. `ancestors("int32")` walks `int32 →
integer → number`. `resolve` is what every projector calls to dispatch: look
up the exact kind in its handler table; if absent, walk `ancestors()` and use
the first handler found. This is the same DU+interpreter shape the API tree
uses for `Node` (a projector handles the variants it recognizes), extended
with a fallback step: a projector with no `int32` case still renders `int32`
correctly by falling back to `integer`, then `number` — so a new kind
extension module doesn't require updating all 60+ projectors, only the ones
that care about the distinction.

---

## 4. Metadata: an open bag, same philosophy as the API tree

`TypeRef.meta` is an open bag — the same "open metadata bag over fixed
schema" philosophy as `Node.meta` in the API tree. Nothing in `index.ts`
enumerates the full set of recognized keys; consumers agree on keys by
convention. Documented conventions in `packages/type-ir/src/index.ts`
include:

| Key | Meaning |
|---|---|
| `optional: boolean` | the field may be omitted (set by `partial`/`required`/`deepPartial`/`deepRequired`) |
| `nullable: boolean` | the type additionally accepts `null` (set by `nullable()`) |
| `readonly: boolean` | field is immutable after construction (e.g. from a TS `readonly` modifier) |
| `description: string` | doc text, typically from JSDoc |
| `deprecated: boolean` | the field/type is deprecated |
| `brand: string` | nominal branding on an otherwise-structural type |
| `format: string` | schema-format hint (e.g. JSON Schema's `format: "email"`) |
| `typeName` + `declarationFile` | a top-level `TypeRef`'s named-type provenance, for codegen that references a type by name instead of inlining its structure |
| `additionalProperties: boolean` | JSON-Schema/OpenAPI-style closedness on an `object` kind |

Projectors read what they recognize and ignore the rest — no fixed axes, no
blessed set of fields. As with `Meta` on the API tree, `meta` is never a
second source of structural truth: `shape` alone determines what a `TypeRef`
*is*; `meta` carries only side-channel presence/provenance/format concerns.

---

## 5. The three layers, concretely, in both domains

Both domains implement the same three independent layers
(`docs/design/architecture-layers.md`): authoring constructors → an
inspectable DU → interpreters/projectors that consume it. Layers don't depend
on each other's internals — a constructor doesn't know which projectors
exist; a projector doesn't know which constructor produced the DU it's
walking.

| Layer | API tree | Type IR |
|---|---|---|
| 1. Authoring (constructors) | `op(fn, ...contributions)`, `api(children, opts?)` | `t(shape, meta?)`, `types.*` shape constructors |
| 2. DU (inspectable data) | `Node` — discriminated by `handler`/`children`/`fallback` presence | `TypeRef` — `{ shape, meta }`, `shape` discriminated on `kind` via `TypeKinds` |
| 3. Interpreters / projections | HTTP (`createFetch`), MCP (`toTools`), CLI (`runCli`), GraphQL | 60+ projectors (`toZod`, `toPython`, `toJsonSchema`, `toProtobuf`, …) |

The type-IR layer 3 also runs in reverse: **importers** go source → DU
instead of DU → source, e.g. `from-json.ts`, `from-sql.ts`,
`from-json-schema.ts`, `from-openapi.ts`, `from-typescript.ts`,
`from-protobuf.ts`, `from-graphql.ts`, `from-capnp.ts`, `from-cql.ts`,
`from-elasticsearch.ts`, `from-flatbuffers.ts`, `from-jtd.ts`,
`from-standard-schema.ts` (all under `packages/type-ir/src/`). A projector and
an importer for the same format are independent implementations against the
same `TypeRef` contract — the same serde-style ser/de split the design
philosophy describes for the routing layer's projections.

A projector or importer is, in the common case, a pure function
(`TypeRef => string` for code-generating projectors, `TypeRef => <document>`
for schema/wire-format projectors) built as a handler table keyed by `kind`,
dispatched through `resolve`:

```ts
const handlers: Record<string, Converter> = {
  boolean: () => "boolean",
  object: (shape) => { /* render fields */ },
  array: (shape) => { /* render element */ },
  // …
}

export function toX(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? /* unknown-case fallback */ : converter(ref.shape)
}
```

A kind with no ancestor and no handler degrades to whatever the projector
considers its "unknown" case — `unknown` in TypeScript, `Any` in Python, an
opaque placeholder in a schema format, or (for formats with no honest way to
degrade a purely-nominal `instance`, like Cap'n Proto) an explicit throw.

---

## 6. `TypeRefDocument` — named/recursive types

```ts
// packages/type-ir/src/index.ts
export type TypeRefDocument = {
  readonly root: TypeRef
  readonly defs: Readonly<Record<string, TypeRef>>
}
```

A bare `TypeRef` has no registry to resolve `{ kind: "ref", target }` against
— `target` is just an unresolvable name. `TypeRefDocument` closes that gap:
`root` is the top-level type, `defs` holds every named definition a `ref`
anywhere in the tree points into, keyed by name. Recursive types live in
`defs` — a recursive def's own body contains a `ref` back to its own name —
as do types a caller's own `shouldShare` heuristic decides are reused enough
to be worth sharing structurally rather than inlining repeatedly (e.g.
api-tree's extractor).

Every function that historically took a bare `TypeRef` still works unchanged
— a `TypeRef` with no `defs` is simply a document with no shared definitions.
Doc-page projectors and importers that produce multiple related types (e.g.
`from-protobuf`, which naturally yields one message per `def`) operate on
`TypeRefDocument` rather than a bare `TypeRef`.

---

## Quick reference

| Symbol | Package | What it is |
|---|---|---|
| `TypeRef` | `@rhi-zone/fractal-type-ir` | `{ shape, meta }` — the one type-IR value |
| `TypeShape` | `@rhi-zone/fractal-type-ir` | `TypeKinds[keyof TypeKinds]`, the discriminated shape union |
| `TypeKinds` | `@rhi-zone/fractal-type-ir` | Augmentable interface enumerating registered kinds |
| `TypeRefDocument` | `@rhi-zone/fractal-type-ir` | `{ root, defs }` — named/recursive types with a ref registry |
| `t(shape, meta?)` | `@rhi-zone/fractal-type-ir` | Wrap a shape into a `TypeRef` |
| `types.*` | `@rhi-zone/fractal-type-ir` | One shape constructor per kind |
| `registerParent(kind, parent)` | `@rhi-zone/fractal-type-ir` | Wire a kind into the subtyping chain |
| `ancestors(kind)` | `@rhi-zone/fractal-type-ir` | Walk a kind's parent chain |
| `resolve(kind, handlers)` | `@rhi-zone/fractal-type-ir` | Dispatch with fallback through `ancestors` |
| `partial`/`required`/`pick`/`omit`/`extend`/`nullable`/`withMeta`/`deepPartial`/`deepRequired` | `@rhi-zone/fractal-type-ir/derive` | Structural `TypeRef → TypeRef` transforms |
| `packages/type-ir/src/kinds/*.ts` | `@rhi-zone/fractal-type-ir/kinds/*` | Extension modules registering semantic-refinement kinds |
| `toZod`, `toPython`, `toJsonSchema`, … | `@rhi-zone/fractal-type-ir` | Projectors: `TypeRef(Document) => target` |
| `from-json.ts`, `from-sql.ts`, `from-protobuf.ts`, … | `@rhi-zone/fractal-type-ir` | Importers: `source => TypeRef(Document)` |
