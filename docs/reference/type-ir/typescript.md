# TypeScript

`@rhi-zone/fractal-type-ir` ships one projector per TypeScript-ecosystem target: a plain
`.d.ts`-shaped native emitter, plus one code projector per runtime validator library (Zod,
Valibot, TypeBox, io-ts, Yup, Superstruct, runtypes, ArkType, Effect Schema), plus a
JSDoc/Closure emitter for plain-JS callers. Every projector follows the same shape — a
`handlers: Record<string, Converter>` table keyed on `shape.kind`, walked by a `toX(ref)`
entry point — so a `TypeRef`'s `object`/`optional`/`enum` vocabulary reliably degrades to
each library's nearest native construct (documented per-handler in each source file, with a
spec link).

## TypeScript (native)

```ts
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toTypeDeclaration } from "@rhi-zone/fractal-type-ir/typescript"

const variant = t(types.enum(["small", "medium", "large"]))
const orderItem = t(
  types.object({
    productId: t(types.string),
    quantity: t(types.integer),
    price: t(types.number),
    variant: { ...variant, meta: { ...variant.meta, optional: true } },
  }),
)

toTypeDeclaration("OrderItem", orderItem)
// type OrderItem = { productId: string; quantity: number; price: number; variant?: "small" | "medium" | "large" };
```

`toTypeScript(ref)` renders the bare type expression; `toTypeDeclaration(name, ref)` wraps it
in `type Name = ...;` with a TSDoc comment from `meta.description`/`meta.deprecated`;
`toTypeDeclarations(registry)` batches a `Record<string, TypeRef>` into one block.

### Zod

```ts
import { toZod } from "@rhi-zone/fractal-type-ir/zod"

const ref = t(types.object({ name: t(types.string), nickname: t(types.string, { optional: true }) }))
toZod(ref)
// z.object({ name: z.string(), nickname: z.string().optional() })
```

`meta.discriminator` on a `union` upgrades `z.union([...])` to `z.discriminatedUnion(key, [...])`.

### Valibot

```ts
import { toValibot } from "@rhi-zone/fractal-type-ir/valibot"

toValibot(ref)
// v.object({ name: v.string(), nickname: v.optional(v.string()) })
```

Constraints compose via `v.pipe(schema, ...actions)`; optional/nullable are wrapper calls
(`v.optional(...)`, `v.nullable(...)`), not chained methods.

### TypeBox

```ts
import { toTypeBox } from "@rhi-zone/fractal-type-ir/typebox"

toTypeBox(ref)
// Type.Object({ name: Type.String(), nickname: Type.Optional(Type.String()) })
```

Constraints ride as a trailing options-object argument (`Type.String({ minLength: 1 })`)
rather than a chained call.

### io-ts

```ts
import { toIoTs } from "@rhi-zone/fractal-type-ir/io-ts"

toIoTs(ref)
// t.intersection([t.type({ name: t.string }), t.partial({ nickname: t.string })])
```

io-ts has no per-field optional modifier — a mixed required/optional object splits into
`t.type({...required})` and `t.partial({...optional})`, merged via `t.intersection`. Every
primitive codec unsupported natively (uuid, datetime, …) falls back to the nearest built-in
with a trailing `/* note */` comment.

### Yup

```ts
import { toYup } from "@rhi-zone/fractal-type-ir/yup"

toYup(ref)
// yup.object({ name: yup.string().required(), nickname: yup.string() })
```

Yup fields are required-by-default — `.required()` marks the required ones instead of
`.optional()` marking the optional ones. Yup has no native record/union/literal-set type:
enums degrade to `.oneOf([...])` on `mixed()`, and schema unions degrade to `yup.lazy()` with
a best-effort runtime type guard per variant.

### Superstruct

```ts
import { toSuperstruct } from "@rhi-zone/fractal-type-ir/superstruct"

toSuperstruct(ref)
// s.object({ name: s.string(), nickname: s.optional(s.string()) })
```

Constraints wrap the expression outside-in (`s.size(s.string(), 1, 50)`) rather than chaining.

### runtypes

```ts
import { toRuntypes } from "@rhi-zone/fractal-type-ir/runtypes"

toRuntypes(ref)
// R.Record({ name: R.String, nickname: R.String.optional() })
```

runtypes has no built-in constraint or format validators at all — every `minimum`/`pattern`/…
degrades to a `.withConstraint(...)` predicate, and unsupported formats (uuid, email) fall
back to `R.String` with a comment.

### ArkType

```ts
import { toArkType } from "@rhi-zone/fractal-type-ir/arktype"

toArkType(ref)
// type({ name: "string", "nickname?": "string" })
```

ArkType's string-based syntax marks optionality on the *key* (`"nickname?"`), not the value —
the only variant here where "optional" isn't a wrapper or chained call at all.

### Effect Schema

```ts
import { toEffectSchema } from "@rhi-zone/fractal-type-ir/effect-schema"

toEffectSchema(ref)
// S.Struct({ name: S.String, nickname: S.optional(S.String) })
```

Effect Schema has no schema-level `.default()` — a field's `meta.default` is applied at the
`S.optionalWith(field, { default: () => value })` call site instead of as a generic chained
method, unlike the zod/typebox/valibot projectors.

### JSDoc

```ts
import { toJsDocTypedef } from "@rhi-zone/fractal-type-ir/jsdoc"

const userInput = t(
  types.object({
    name: t(types.string),
    age: t(types.integer, { optional: true }),
    roles: t(types.array(t(types.string))),
  }),
)
toJsDocTypedef("UserInput", userInput)
// /**
//  * @typedef {Object} UserInput
//  * @property {string} name
//  * @property {number} [age] - optional
//  * @property {Array.<string>} roles
//  */
```

`toJsDocType(ref)` renders a bare `@type`-position expression; `toJsDocTypedef` supports a
`mode: "typedef" | "interface" | "class"` option to emit `@interface`/`@constructs` blocks
instead; `toJsDocInlineType(ref)` wraps a single expression as `/** @type {...} */`.
