// packages/type-ir/src/kinds/float-widths.ts — @rhi-zone/fractal-type-ir/kinds/float-widths
//
// Fixed-width float kinds (float32, float64) — both subtype "number".

import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    float32: { readonly kind: "float32" }
    float64: { readonly kind: "float64" }
  }
}

registerParent("float32", "number")
registerParent("float64", "number")

export const float32 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "float32" }, meta)
export const float64 = (meta?: Record<string, unknown>): TypeRef => t({ kind: "float64" }, meta)
