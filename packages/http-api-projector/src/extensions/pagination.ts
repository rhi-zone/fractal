// packages/http-api-projector/src/extensions/pagination.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: turns a call against a paginated endpoint
// (one whose handler returns `CursorPage<T>`/`OffsetPage<T>`, see
// packages/api-tree/src/page.ts) into an ENRICHED first page — the exact
// `{ items, cursor?/offset+total, hasMore }` object the server returned,
// with `[Symbol.asyncIterator]` and `getPage()` attached, so:
//
//   const page = await client.books.list()               // same shape as ever
//   for await (const book of await client.books.list())   // every item, every page
//   const p1 = await client.books.list().getPage()        // then p2 = await same.getPage()
//
// `client.ts`'s `makeCaller` is an `async` function — its return value is
// always adopted into a genuine `Promise`, so a paginated call needs exactly
// ONE `await` before its result is iterable/callable, same as this
// package's other stream-shaped extension: `streaming()`'s own doc comment
// (extensions/streaming.ts) shows the identical `for await (const chunk of
// await client.generate({ prompt }))` shape. `Object.assign`-ing the
// iterator methods onto a COPY of the raw first page (rather than wrapping
// it in a separate object) is what keeps `await client.books.list()` itself
// unchanged — every existing field is still there, just alongside two more.
//
// Detection is a RUNTIME shape check (`isPageShape`, from
// `@rhi-zone/fractal-api-tree`) on the actual response body — the same
// "conventions over contracts" split `streaming()`'s SSE Content-Type check
// uses, except pagination has no such header to sniff cheaply, so the check
// happens after decoding the body (inside the async `decodeResponse` value),
// not synchronously against the raw `Response`. A response that ISN'T
// page-shaped resolves through completely unchanged (no extra properties
// attached) — `pagination()` is therefore safe to install client-wide, not
// just on endpoints that happen to paginate; iterating a non-paginated
// result fails with JS's own "not async iterable" error, same as iterating
// any plain object would.
//
// Implemented on `decodeResponse` + `ctx.refetch` (extension.ts's
// `DecodeContext`): `refetch` is what lets each subsequent page be issued as
// a NEW `Request` through the same composed fetch pipeline (retry/timeout/
// logging/etc. still apply to every page, not just the first). Pagination is
// runtime-only — no `codegen` hook — a generated client's paginated call
// would need its own async-generator machinery à la `streaming()`'s
// `__requestStream`; out of scope for this first cut.
//
// `paginated()` (verbs.ts) is a pure customization hook, read here from
// `ctx.meta` via `getHttpMeta` — it overrides the input field names the
// next-page request uses (`inputCursorParam`/`inputOffsetParam`). None of it
// is required for the common case:
//
//   const listBooks = (input: { limit?: number; cursor?: string }) => {
//     return { items: [...], cursor: "abc", hasMore: true } satisfies CursorPage<Book>
//   }
//   const tree = api({ books: api({ list: op(listBooks, http.get) }) })
//
//   const client = createClient(tree, { extensions: [pagination()] })
//   for await (const book of await client.books.list()) { ... }

import { isPageShape } from "@rhi-zone/fractal-api-tree"
import { ClientError } from "../client-error.ts"
import { getHttpMeta } from "../project.ts"
import type { ClientExtension, DecodeContext, DecodedResponse, FetchImpl } from "../extension.ts"

// ============================================================================
// Public types
// ============================================================================

export type PaginationOptions = {
  /** Input field name the client sends carrying a cursor-style next-page token. Default `"cursor"`. */
  readonly cursorParam?: string
  /** Input field name the client sends carrying an offset-style next-page position. Default `"offset"`. */
  readonly offsetParam?: string
}

/**
 * A page value enriched with auto-pagination: every field the server's
 * `CursorPage<T>`/`OffsetPage<T>` response carried, PLUS `[Symbol.asyncIterator]`
 * (walks every item across every following page, fetching each lazily) and
 * `getPage()` (the manual, one-page-at-a-time escape hatch — the SAME
 * sequential cursor the async iterator advances, so mixing the two on one
 * returned value continues from wherever the other left off rather than
 * running two independent sequences).
 */
export type PageIterator<P extends { readonly items: readonly unknown[] }> = P &
  AsyncIterable<P["items"][number]> & {
    /** Fetch the next not-yet-fetched page. `undefined` once there is nothing left (`hasMore` was `false`). */
    getPage(): Promise<P | undefined>
  }

// ============================================================================
// Internal: page-shape classification + next-page request
// ============================================================================

type CursorPageLike = { readonly items: readonly unknown[]; readonly cursor?: string; readonly hasMore: boolean }
type OffsetPageLike = {
  readonly items: readonly unknown[]
  readonly offset: number
  readonly total: number
  readonly hasMore: boolean
}

type ResolvedPaginationOptions = {
  readonly cursorParam: string
  readonly offsetParam: string
}

function isOffsetPageLike(page: CursorPageLike | OffsetPageLike): page is OffsetPageLike {
  return "offset" in page && "total" in page
}

/**
 * Build the `Request` for the NEXT page: clones `original`'s URL (preserving
 * every OTHER query param the initial call set — `limit`, filters, etc.) and
 * overwrites just the cursor/offset param on top.
 *
 * Scoped to GET/HEAD/DELETE-style (query-param) requests — the conventional
 * shape for a read/list endpoint (`http.get`, verbs.ts) and the only shape
 * `client.ts`'s `makeCaller` encodes input into a URL rather than a JSON
 * body. A paginated endpoint exposed as POST/PUT/PATCH has no established
 * convention here yet (its original body was already consumed by the first
 * request, so it can't be read back to merge a next-page field into) — this
 * throws a clear, actionable error instead of silently mis-paginating.
 */
function nextRequestFor(
  original: Request,
  page: CursorPageLike | OffsetPageLike,
  options: ResolvedPaginationOptions,
): Request {
  if (original.method !== "GET" && original.method !== "HEAD" && original.method !== "DELETE") {
    throw new TypeError(
      `pagination(): auto-pagination only supports GET/HEAD/DELETE-style (query-param) requests; got ${original.method}. Expose a paginated list endpoint via http.get.`,
    )
  }
  const isAbsolute = original.url.startsWith("http://") || original.url.startsWith("https://")
  const url = new URL(original.url, isAbsolute ? undefined : "http://localhost")
  if (isOffsetPageLike(page)) {
    url.searchParams.set(options.offsetParam, String(page.offset + page.items.length))
  } else if (page.cursor !== undefined) {
    url.searchParams.set(options.cursorParam, page.cursor)
  }
  const finalUrl = isAbsolute ? url.toString() : url.pathname + url.search
  return new Request(finalUrl, { method: original.method, headers: original.headers, signal: original.signal })
}

/** Parse a `Response` the same way `client.ts`'s default decode does, throwing `ClientError` on a non-`ok` status. */
async function decodeOrThrow(res: Response): Promise<unknown> {
  const ct = res.headers.get("Content-Type") ?? ""
  const body = ct.includes("application/json") ? await res.json() : await res.text()
  if (!res.ok) throw new ClientError(res.status, body)
  return body
}

// ============================================================================
// Internal: enrichment
// ============================================================================

/**
 * Attach `getPage()`/`[Symbol.asyncIterator]` to a copy of `first` (the
 * already-decoded first page). Both share the SAME mutable cursor state —
 * `fetchNext()` — so calling `getPage()` and then `for await`-ing the same
 * returned value (or vice versa) continues in one sequence rather than
 * restarting.
 */
function enrichPage(
  first: CursorPageLike | OffsetPageLike,
  originalRequest: Request,
  refetch: FetchImpl,
  options: ResolvedPaginationOptions,
): unknown {
  let currentPage: CursorPageLike | OffsetPageLike | undefined = first
  let nextRequest: Request | undefined = first.hasMore
    ? nextRequestFor(originalRequest, first, options)
    : undefined
  let firstPending = true

  /** Advance to (and return) the next not-yet-returned page; `undefined` once exhausted. */
  async function fetchNext(): Promise<CursorPageLike | OffsetPageLike | undefined> {
    if (firstPending) {
      firstPending = false
      return currentPage
    }
    if (nextRequest === undefined) return undefined
    const res = await refetch(nextRequest)
    const value = await decodeOrThrow(res)
    if (!isPageShape(value)) {
      nextRequest = undefined
      return undefined
    }
    const page = value as CursorPageLike | OffsetPageLike
    currentPage = page
    nextRequest = page.hasMore ? nextRequestFor(originalRequest, page, options) : undefined
    return page
  }

  const getPage = (): Promise<unknown> => fetchNext()

  const asyncIterator = (): AsyncIterator<unknown> => {
    let page: CursorPageLike | OffsetPageLike | undefined
    let itemIndex = 0
    return {
      async next() {
        for (;;) {
          if (page === undefined) {
            const fetched = await fetchNext()
            if (fetched === undefined) return { done: true, value: undefined }
            page = fetched
            itemIndex = 0
          }
          if (itemIndex < page.items.length) {
            return { done: false, value: page.items[itemIndex++] }
          }
          if (!page.hasMore) return { done: true, value: undefined }
          page = undefined
        }
      },
    }
  }

  return Object.assign({}, first, { getPage, [Symbol.asyncIterator]: asyncIterator })
}

/** Decode `res`; if page-shaped, enrich it with auto-pagination; otherwise pass the raw value through unchanged. */
async function buildResult(
  res: Response,
  originalRequest: Request,
  refetch: FetchImpl,
  options: ResolvedPaginationOptions,
): Promise<unknown> {
  const first = await decodeOrThrow(res)
  if (!isPageShape(first)) return first
  return enrichPage(first as CursorPageLike | OffsetPageLike, originalRequest, refetch, options)
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Auto-pagination client extension: recognizes a page-shaped response
 * (`CursorPage<T>`/`OffsetPage<T>`, checked at runtime via `isPageShape`) and
 * enriches it with `getPage()`/`[Symbol.asyncIterator]` — the SAME first-page
 * object the server returned, `await`-able exactly as before, ALSO iterable
 * across every following page.
 *
 * @example
 * const client = createClient(node, { extensions: [pagination()] })
 * for await (const book of await client.books.list()) { ... }
 */
export function pagination(options: PaginationOptions = {}): ClientExtension {
  const defaults: ResolvedPaginationOptions = {
    cursorParam: options.cursorParam ?? "cursor",
    offsetParam: options.offsetParam ?? "offset",
  }

  const decodeResponse = (res: Response, ctx: DecodeContext): DecodedResponse => {
    const paginatedMeta = getHttpMeta(ctx.meta).paginated
    const resolved: ResolvedPaginationOptions = {
      cursorParam: paginatedMeta?.inputCursorParam ?? defaults.cursorParam,
      offsetParam: paginatedMeta?.inputOffsetParam ?? defaults.offsetParam,
    }
    return { value: buildResult(res, ctx.request, ctx.refetch, resolved) }
  }

  return { name: "pagination", decodeResponse }
}
