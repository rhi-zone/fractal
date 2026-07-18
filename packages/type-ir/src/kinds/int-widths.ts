// packages/type-ir/src/kinds/int-widths.ts — @rhi-zone/fractal-type-ir/kinds/int-widths
//
// Fixed-width integer kinds — all subtype "integer".

import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    int8: { readonly kind: "int8" }
    int16: { readonly kind: "int16" }
    int32: { readonly kind: "int32" }
    int64: { readonly kind: "int64" }
    uint8: { readonly kind: "uint8" }
    uint16: { readonly kind: "uint16" }
    uint32: { readonly kind: "uint32" }
    uint64: { readonly kind: "uint64" }
  }
}

registerParent("int8", "integer")
registerParent("int16", "integer")
registerParent("int32", "integer")
registerParent("int64", "integer")
registerParent("uint8", "integer")
registerParent("uint16", "integer")
registerParent("uint32", "integer")
registerParent("uint64", "integer")

export const int8 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "int8" }, meta)
export const int16 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "int16" }, meta)
export const int32 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "int32" }, meta)
export const int64 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "int64" }, meta)
export const uint8 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "uint8" }, meta)
export const uint16 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "uint16" }, meta)
export const uint32 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "uint32" }, meta)
export const uint64 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "uint64" }, meta)
