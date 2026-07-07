// packages/core/src/tags.ts — @rhi-zone/fractal-core  (new model, alongside legacy spine)
//
// Standard agnostic behavioral tags + the implication lattice resolver.
//
// Tags are well-known keys in the open meta.tags sub-bag — NOT a closed enum.
// A consumer can add their own tag keys; these constants are the standard library.
//
// Three-valued semantics:
//   true      — this tag is explicitly asserted
//   false     — this tag is explicitly negated
//   undefined — unknown (absence asserts nothing; no default inference)
//
// See:
//   docs/artifacts/fc-op-kinds/tag-set.md  — canonical definitions + lattice
//   docs/design/converged-model.md          — open-bag constraint [CERTIFIED]
// ============================================================================

// ============================================================================
// Standard tag keys
// ============================================================================

/**
 * `readOnly`: The operation produces no observable side-effects on persistent
 * state; calling it any number of times is equivalent to calling it once.
 *
 * NOTE: The canonical tag-set document names this tag `safe`; `readOnly` is a
 * provisional alias used here pending final naming resolution. When the name
 * is settled, this constant (and any authored meta keys) will be migrated.
 *
 * Implies `idempotent`. Mutually exclusive with `destructive`.
 */
export const TAG_READ_ONLY = "readOnly" as const

/**
 * `idempotent`: Calling the operation multiple times with the same arguments
 * produces the same state as calling it once.
 * Implied by `readOnly`. Valid in combination with `destructive` (e.g. DELETE).
 */
export const TAG_IDEMPOTENT = "idempotent" as const

/**
 * `destructive`: The operation irrevocably destroys or removes existing state;
 * the effect cannot be undone by a subsequent call without out-of-band recovery.
 * Mutually exclusive with `readOnly`. Valid in combination with `idempotent`.
 */
export const TAG_DESTRUCTIVE = "destructive" as const

/**
 * `openWorld`: The operation may reach external systems, networks, or resources
 * outside the local service boundary.
 * Orthogonal to all other standard tags.
 */
export const TAG_OPEN_WORLD = "openWorld" as const

/**
 * `streaming`: The operation yields a sequence of items over time rather than
 * a single value.
 * Orthogonal to all other standard tags.
 * NOTE: This will be derivable from the return type (e.g. `AsyncIterable<T>`)
 * via codegen later; for now it is read directly from meta.
 */
export const TAG_STREAMING = "streaming" as const

// ============================================================================
// Tags sub-bag — open three-valued dict
// ============================================================================

/**
 * Open three-valued tag dictionary, carried as `meta.tags` on a Node or Op.
 *
 * Standard keys are typed explicitly. Any consumer may add custom boolean
 * tags via the index signature. Three-valued: true / false / undefined (unknown).
 */
export type Tags = {
  readOnly?: boolean | undefined
  idempotent?: boolean | undefined
  destructive?: boolean | undefined
  openWorld?: boolean | undefined
  streaming?: boolean | undefined
  [custom: string]: boolean | undefined
}

// ============================================================================
// Tag resolution — implication lattice
// ============================================================================

/** A tag value in the Tags bag (three-valued: true / false / unknown). */
export type TagValue = boolean | undefined

/**
 * The resolved tag set produced by `resolveTags`. Carries both the original
 * (authored) values and any values derived by the implication lattice.
 * `conflict` is present only when mutually-exclusive tags are both asserted.
 */
export type ResolvedTags = {
  readonly readOnly: TagValue
  readonly idempotent: TagValue
  readonly destructive: TagValue
  readonly openWorld: TagValue
  readonly streaming: TagValue
  readonly conflict?: string
}

/**
 * Apply the implication lattice to a Tags bag (from `meta.tags`).
 *
 * Lattice rules applied:
 *   readOnly ⇒ idempotent   (if readOnly=true and idempotent=undefined → set idempotent=true)
 *   readOnly ∧ destructive  → conflict (both true is a contradiction)
 *
 * Unknowns stay unknown — absence does NOT default to false. The `streaming`
 * and `openWorld` tags are orthogonal and pass through untouched.
 *
 * Standard tag keys are read from the Tags bag; any additional keys the
 * caller added are ignored here (they remain in the bag, untouched).
 */
export function resolveTags(tags: Tags): ResolvedTags {
  const readOnly = tags[TAG_READ_ONLY] as TagValue
  const destructive = tags[TAG_DESTRUCTIVE] as TagValue
  const rawIdempotent = tags[TAG_IDEMPOTENT] as TagValue
  const openWorld = tags[TAG_OPEN_WORLD] as TagValue
  const streaming = tags[TAG_STREAMING] as TagValue

  // readOnly ⇒ idempotent: lift unknown to true when readOnly is asserted
  const idempotent: TagValue =
    readOnly === true && rawIdempotent === undefined ? true : rawIdempotent

  // readOnly ∧ destructive is a contradiction (both cannot be true)
  const conflict: string | undefined =
    readOnly === true && destructive === true
      ? `readOnly and destructive are mutually exclusive (both asserted true)`
      : undefined

  return {
    readOnly,
    idempotent,
    destructive,
    openWorld,
    streaming,
    ...(conflict !== undefined ? { conflict } : {}),
  }
}

// ============================================================================
// Tag inheritance — closest-wins merge along the node path
// ============================================================================

/**
 * Merge tags from root → ... → op, closest-wins.
 *
 * A defined value (true OR false) at a closer level overrides a farther one.
 * `undefined` at a level does NOT override — it defers upward.
 * The last element of the path array is treated as the op itself.
 *
 * @param path - Array of nodes/ops from root to op (inclusive), each
 *               optionally carrying `meta.tags`.
 */
export function effectiveTags(path: Array<{ meta?: { tags?: Tags } }>): Tags {
  const merged: Record<string, boolean | undefined> = {}
  for (const entry of path) {
    const entryTags = entry.meta?.tags
    if (entryTags === undefined) continue
    for (const [key, value] of Object.entries(entryTags)) {
      if (value !== undefined) {
        merged[key] = value
      }
    }
  }
  return merged as Tags
}
