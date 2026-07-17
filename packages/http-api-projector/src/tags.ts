// packages/http-api-projector/src/tags.ts — @rhi-zone/fractal-http-api-projector
//
// Verb derivation from the three-valued tag lattice + a `meta.http` verb
// override. Extracted from project.ts (the direct tree-walk dispatcher lived
// there originally; this function outlives that dispatcher — it is also used
// by the HttpRoute path indirectly (via `http.*` verb bundles in verbs.ts,
// which set BOTH the legacy `kind:"verb"` directive this function reads and
// the `kind:"method"` directive `applyMethods` reads) and by other packages'
// self-contained tree walks (openapi, client) that need to derive the same
// HTTP verb a leaf would get without depending on http's dispatch internals.
//
// Not placed in packages/api-tree/src/tags.ts: `resolveTags`/`Tags` there are
// agnostic (no knowledge of HTTP); this function reads `meta.http`, an
// HTTP-specific DU. Keeping it here avoids leaking HTTP shape into core.
//
// Dispatch rules (from tag-set.md §"HTTP verb selection"):
//   readOnly = true                        → GET
//   idempotent = true, destructive = true  → DELETE
//   idempotent = true, destructive ≠ true  → PUT   (unknown ≠ true)
//   else (idempotent unknown or false)     → POST  (conservative)
//
// A meta.http verb directive always wins — checked before tags.
// Tags are three-valued: true / false / undefined (unknown ≠ false).
// Tags are read directly from the node's own meta — there is no ancestor
// inheritance (see docs/design/router-model.md — "Tags").

import { resolveTags } from "@rhi-zone/fractal-api-tree/tags"
import type { Tags } from "@rhi-zone/fractal-api-tree/tags"
import type { Meta } from "@rhi-zone/fractal-api-tree/node"

/** Extract the `{ kind: "verb", value }` directive from `meta.http.directives`, if present. */
function verbDirective(meta: Meta): string | undefined {
  const h = meta.http
  if (typeof h !== "object" || h === null) return undefined
  const directives = (h as { directives?: unknown }).directives
  if (!Array.isArray(directives)) return undefined
  for (const entry of directives as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue
    const d = entry as Record<string, unknown>
    if (d.kind === "verb" && typeof d.value === "string") return d.value
  }
  return undefined
}

export function verbFromTags(meta: Meta): string {
  const httpVerb = verbDirective(meta)
  if (httpVerb !== undefined) return httpVerb.toUpperCase()

  const tags = resolveTags((meta.tags ?? {}) as Tags)
  // readOnly = true → GET (lattice: safe ⇒ idempotent; safe ⇒ ¬destructive)
  if (tags.readOnly === true) return "GET"
  // idempotent = true, destructive = true → DELETE
  if (tags.idempotent === true && tags.destructive === true) return "DELETE"
  // idempotent = true, destructive ≠ true → PUT (unknown destructive treated as ¬destructive)
  if (tags.idempotent === true) return "PUT"
  // Conservative default: unknown or false idempotent → POST
  return "POST"
}
