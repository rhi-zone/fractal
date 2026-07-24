# Derive

`derive.ts` — re-exported from the package root — is not a projector. These
are pure structural `TypeRef => TypeRef` transforms, the primitives
everything else in fractal's codegen builds on (a projector never needs its
own partial/pick/omit logic; it composes these instead). All of them pass
non-object refs through unchanged unless noted, and none mutate their input.

```ts
import { partial, required, pick, omit, extend, nullable, withMeta, deepPartial, deepRequired } from "@rhi-zone/fractal-type-ir"
```

## `partial`

All fields become optional (`meta.optional = true`).

```ts
const before = t(types.object({ id: t(types.integer), name: t(types.string) }))
partial(before)
// t(types.object({
//   id: t(types.integer, { optional: true }),
//   name: t(types.string, { optional: true }),
// }))
```

## `required`

Inverse of `partial` — removes `meta.optional` from every field.

```ts
const before = t(types.object({ id: t(types.integer, { optional: true }) }))
required(before)
// t(types.object({ id: t(types.integer) }))
```

## `pick`

Keep only the named fields; missing keys are silently skipped.

```ts
const before = t(types.object({ id: t(types.integer), name: t(types.string), email: t(types.string) }))
pick(before, ["id", "name"])
// t(types.object({ id: t(types.integer), name: t(types.string) }))
```

## `omit`

Drop the named fields; missing keys are silently skipped.

```ts
const before = t(types.object({ id: t(types.integer), name: t(types.string), email: t(types.string) }))
omit(before, ["email"])
// t(types.object({ id: t(types.integer), name: t(types.string) }))
```

## `extend`

Merge two object TypeRefs — extension fields (and `meta`) override base
fields with the same name, last-write-wins. If either side isn't an object,
the extension wins outright (no error).

```ts
const base = t(types.object({ id: t(types.integer), name: t(types.string) }))
const extension = t(types.object({ name: t(types.string, { minLength: 1 }), email: t(types.string) }))
extend(base, extension)
// t(types.object({
//   id: t(types.integer),
//   name: t(types.string, { minLength: 1 }),
//   email: t(types.string),
// }))
```

## `nullable`

Sets `meta.nullable = true` on the ref.

```ts
const before = t(types.string)
nullable(before)
// t(types.string, { nullable: true })
```

## `withMeta`

Merge additional metadata into a TypeRef (constraints, descriptions, etc.).

```ts
const before = t(types.integer)
withMeta(before, { minimum: 0, description: "must be non-negative" })
// t(types.integer, { minimum: 0, description: "must be non-negative" })
```

## `deepPartial`

Like `partial`, but recurses into nested object fields (and object elements
of arrays/streams/pages), making every level optional. Non-object leaf
fields just get `meta.optional = true`. Cycle-safe — a shape already visited
is returned as-is rather than reprocessed.

```ts
const before = t(types.object({
  id: t(types.integer),
  address: t(types.object({ city: t(types.string) })),
}))
deepPartial(before)
// t(types.object({
//   id: t(types.integer, { optional: true }),
//   address: t(types.object({
//     city: t(types.string, { optional: true }),
//   }), { optional: true }),
// }))
```

## `deepRequired`

Inverse of `deepPartial` — recurses into nested object fields (and object
elements of arrays/streams/pages), removing `meta.optional` at every level.
Cycle-safe like `deepPartial`.

```ts
const before = t(types.object({
  id: t(types.integer, { optional: true }),
  address: t(types.object({ city: t(types.string, { optional: true }) }), { optional: true }),
}))
deepRequired(before)
// t(types.object({
//   id: t(types.integer),
//   address: t(types.object({ city: t(types.string) })),
// }))
```
