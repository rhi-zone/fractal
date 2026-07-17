// packages/type-ir/src/kinds/semantic-strings.ts — @rhi-zone/fractal-type-ir/kinds/semantic-strings
//
// Semantically-tagged string kinds (uuid, uri) — both subtype "string".

import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    uuid: { readonly kind: "uuid" }
    uri: { readonly kind: "uri" }
  }
}

registerParent("uuid", "string")
registerParent("uri", "string")

export const uuid = (meta?: Record<string, unknown>): TypeRef => t({ kind: "uuid" }, meta)
export const uri = (meta?: Record<string, unknown>): TypeRef => t({ kind: "uri" }, meta)
