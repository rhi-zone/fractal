// packages/type-ir/src/kinds/date-time.ts — @rhi-zone/fractal-type-ir/kinds/date-time
//
// Calendar/clock string kinds (datetime, date, time) — all subtype "string".

import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    datetime: { readonly kind: "datetime" }
    date: { readonly kind: "date" }
    time: { readonly kind: "time" }
  }
}

registerParent("datetime", "string")
registerParent("date", "string")
registerParent("time", "string")

export const datetime = (meta?: Record<string, unknown>): TypeRef => t({ kind: "datetime" }, meta)
export const date = (meta?: Record<string, unknown>): TypeRef => t({ kind: "date" }, meta)
export const time = (meta?: Record<string, unknown>): TypeRef => t({ kind: "time" }, meta)
