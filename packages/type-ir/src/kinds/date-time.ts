// packages/type-ir/src/kinds/date-time.ts — @rhi-zone/fractal-type-ir/kinds/date-time
//
// datetime/date represent the DOMAIN type (JS `Date`), not a wire format —
// type-ir describes what a value IS, not how it's serialized. Neither is a
// subtype of `string`: a `Date` isn't structurally a string (no `.length`,
// no `.charAt`, …), so chaining to `string`'s handlers/constraints
// (minLength/pattern/etc.) would be structurally wrong wherever a projector
// lacks an explicit datetime/date entry and falls back through `ancestors()`.
// Every projector in this package DOES carry an explicit datetime/date
// handler (see compile.ts, typescript.ts, zod.ts, …) — the wire-format
// string (`"2024-01-01T00:00:00Z"`) is a *projection concern* (JSON Schema's
// `{ type: "string", format: "date-time" }`, a REST body's serialized ISO
// string, …), produced by the projector that targets that wire format, not
// baked into the IR shape itself.
//
// `time` stays a subtype of `string` — JS has no native Time-of-day type
// (no `Time` class the way `datetime`/`date` have `Date`), so representing
// it as anything other than a formatted string would invent a domain type
// this runtime doesn't have.
import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    datetime: { readonly kind: "datetime" }
    date: { readonly kind: "date" }
    time: { readonly kind: "time" }
  }
}

registerParent("time", "string")

export const datetime = (meta?: Record<string, unknown>): TypeRef => t({ kind: "datetime" }, meta)
export const date = (meta?: Record<string, unknown>): TypeRef => t({ kind: "date" }, meta)
export const time = (meta?: Record<string, unknown>): TypeRef => t({ kind: "time" }, meta)
