// packages/type-ir/src/kinds/bytes.ts — @rhi-zone/fractal-type-ir/kinds/bytes
//
// Binary blob kind (bytes). No parent — orthogonal to string (matches the
// current core hierarchy, where "bytes" was never a subtype of "string").

import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    bytes: { readonly kind: "bytes" }
  }
}

registerParent("bytes", null)

export const bytes = (meta?: Record<string, unknown>): TypeRef => t({ kind: "bytes" }, meta)
