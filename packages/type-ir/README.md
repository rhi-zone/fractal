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
