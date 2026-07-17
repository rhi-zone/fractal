// packages/type-ir/src/kinds/duration.ts — @rhi-zone/fractal-type-ir/kinds/duration
//
// Elapsed-time kind (duration) — subtypes "string".

import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    duration: { readonly kind: "duration" }
  }
}

registerParent("duration", "string")

export const duration = (meta?: Record<string, unknown>): TypeRef => t({ kind: "duration" }, meta)
