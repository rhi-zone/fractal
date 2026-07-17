// packages/type-ir/src/kinds/int-widths.ts — @rhi-zone/fractal-type-ir/kinds/int-widths
//
// Fixed-width integer kinds (int32, int64) — both subtype "integer".

import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    int32: { readonly kind: "int32" }
    int64: { readonly kind: "int64" }
  }
}

registerParent("int32", "integer")
registerParent("int64", "integer")

export const int32 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "int32" }, meta)
export const int64 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "int64" }, meta)
