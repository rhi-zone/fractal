// packages/api-tree/src/page.ts — @rhi-zone/fractal-api-tree
//
// Page<T> — the pagination convention, sibling to StreamEffect<T>
// (index.ts). A handler returning `CursorPage<T>` / `OffsetPage<T>` (or a
// `Promise` of either) signals "this endpoint is paginated" the same way a
// handler returning `AsyncIterable<T>` signals streaming: no fixed contract
// to implement, just a recognizable shape. `@rhi-zone/fractal-api-tree`'s own
// build-time extractor (extract.ts) recognizes the shape via its type alias
// name and lowers it to `type-ir`'s `page` TypeRef kind (mirroring `stream`);
// `@rhi-zone/fractal-http-api-projector`'s `pagination()` client extension
// (extensions/pagination.ts) recognizes the shape at RUNTIME, on the actual
// resolved value — the same "conventions over contracts" split streaming
// uses between its build-time `stream` TypeRef and its runtime
// `isStreamChunk`/`isStreamProgress` checks.
//
// Two independent styles, matching the two pagination conventions APIs
// commonly expose — hierarchy via subtyping, not a closed enum: `Page<T>` is
// their union, not a third variant.

/**
 * Cursor-based pagination: an opaque continuation token. `cursor` is present
 * (and non-empty) while `hasMore` is `true`; absent once the caller has
 * reached the last page.
 */
export type CursorPage<T> = {
  readonly items: readonly T[]
  readonly cursor?: string
  readonly hasMore: boolean
}

/**
 * Offset-based pagination: a numeric window over a known-size collection.
 * `offset` is the index of `items[0]` within the full collection; `total` is
 * the full collection's size.
 */
export type OffsetPage<T> = {
  readonly items: readonly T[]
  readonly offset: number
  readonly total: number
  readonly hasMore: boolean
}

/**
 * Either pagination style — the type a handler signature typically names
 * (`(input) => Page<Book>`) when the caller doesn't care which convention
 * the implementation happens to use. A concrete handler body still returns
 * one concrete shape (`satisfies CursorPage<Book>` or `satisfies
 * OffsetPage<Book>`); `Page<T>` is the reader-facing union, not a third shape
 * of its own.
 */
export type Page<T> = CursorPage<T> | OffsetPage<T>

/** True when `v` structurally matches `CursorPage<unknown>` — has `items`/`hasMore` but not `OffsetPage`'s numeric `offset`/`total`. */
export function isCursorPage(v: unknown): v is CursorPage<unknown> {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return Array.isArray(o.items) && typeof o.hasMore === "boolean" && typeof o.offset !== "number"
}

/** True when `v` structurally matches `OffsetPage<unknown>` — numeric `offset`/`total` alongside `items`/`hasMore`. */
export function isOffsetPage(v: unknown): v is OffsetPage<unknown> {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return Array.isArray(o.items) && typeof o.hasMore === "boolean" && typeof o.offset === "number" && typeof o.total === "number"
}

/** True when `v` matches either pagination shape — the opt-in runtime sniff, mirroring `isStreamEffect`/`isResultShape` in index.ts. */
export function isPageShape(v: unknown): v is Page<unknown> {
  return isOffsetPage(v) || isCursorPage(v)
}
