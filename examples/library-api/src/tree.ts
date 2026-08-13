// examples/library-api/src/tree.ts
//
// Library API — new-model authoring on the HttpRoute pipeline (naiveTransform
// + applyMethods/applyMoveTo/applyResponse, see packages/http-api-projector/src/route.ts
// and docs/design/routing-and-transforms.md). Each leaf carries its OWN tags —
// there is no ancestor tag inheritance (removed; see docs/design/router-model.md
// — "Tags"): a node-level tag does not flow down to its descendants.
//
// In the new node model, callables are leaf nodes stored in `children` via
// `op(fn, meta?)`. A node's `fallback` option (shape `{ name, subtree }`)
// captures the wildcard-capture subtree (replaces the former `param()`).
//
// This file is also the codegen entry-point: extractToolSchemas walks the
// exported `api` value's api() call and derives input schemas for inline
// ops, including the `books` subtree below (also authored via api()).

import { api as api_, fallback, op } from "@rhi-zone/fractal-api-tree/node";
import { http } from "@rhi-zone/fractal-http-api-projector/verbs";
import { httpProjection } from "@rhi-zone/fractal-http-api-projector/dx";
import { applyValidation } from "./generated/apply-validation.ts";

// ============================================================================
// Domain types + in-memory store
// ============================================================================

export type Book = {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly genre: string;
};

let _seq = 0;
const store = new Map<string, Book>();

/** Reset store and ID sequence between tests. */
export function clearStore(): void {
  store.clear();
  _seq = 0;
}

// ============================================================================
// Per-book REST resource — GET/PUT/DELETE co-located at /books/{bookId}
//
// The old model co-located these three leaves via a `meta.http.dispatch =
// {kind:"method"}` marker on their containing node — a feature of the
// retired direct tree-walk dispatcher. The HttpRoute pipeline has no
// dispatch-marker equivalent; the same co-location is expressed instead with
// the `moveTo` rewriter directive (`applyMoveTo`, see route.ts and
// docs/design/routing-and-transforms.md § "Motivating example"): `read`/
// `replace`/`remove` stay nested inside the fallback subtree (alongside
// `checkout` — this is what gives them the `books_bookId_read` etc. MCP/CLI
// names, since those projections read raw tree position with no moveTo
// pass), each with `moveTo: ".."` — go up to the parent position (see the
// path algebra in route.ts: paths resolve relative to the node's own
// position; `..` moves up one level to the parent — the fallback subtree's
// own root). Method assignment is a second, independent directive
// (`{kind:"method"}`, read by `applyMethods`) — `http.get`/`http.put`/
// `http.delete` bundle both the verb and the tags that verb implies.
//
// read   → readOnly              → GET    /books/{bookId}
// replace → idempotent            → PUT    /books/{bookId}
// remove  → idempotent+destructive → DELETE /books/{bookId}
// checkout (branch/action, no placement — stays at its own key) →
//   POST /books/{bookId}/checkout/{start,reserve}
// ============================================================================

/** Get a single book by its ID. GET /books/{bookId} (co-located, no extra segment). */
const readBook = op(
  (input: { bookId: string }) => {
    const book = store.get(input.bookId);
    if (book === undefined) throw new Error(`Not Found: ${input.bookId}`);
    return book;
  },
  http.get,
  http.moveTo(".."),
);

/** Replace book metadata wholesale. Idempotent. PUT /books/{bookId}. */
const replaceBook = op(
  (input: { bookId: string; title?: string; author?: string; genre?: string }) => {
    const existing = store.get(input.bookId);
    if (existing === undefined) throw new Error(`Not Found: ${input.bookId}`);
    const updated: Book = {
      id: existing.id,
      title: input.title !== undefined ? input.title : existing.title,
      author: input.author !== undefined ? input.author : existing.author,
      genre: input.genre !== undefined ? input.genre : existing.genre,
    };
    store.set(input.bookId, updated);
    return updated;
  },
  http.put,
  http.moveTo(".."),
);

/** Permanently delete a book. Destructive and irreversible. DELETE /books/{bookId}. */
const removeBook = op(
  (input: { bookId: string }) => ({ deleted: store.delete(input.bookId) }),
  http.delete,
  http.moveTo(".."),
);

/**
 * Checkout action subtree — nested directly under the fallback (no
 * placement needed).
 *
 * Initiate a checkout session for a book reservation.
 * Authored with `http.post` verb helper — bundles POST directive (no implied tags).
 * POST /books/{bookId}/checkout/start
 *
 * Reserve a book for a patron — idempotent (same patron+book = same reservation).
 * Authored with `http.put` verb helper — bundles PUT directive + idempotent:true.
 * The bundled `idempotent` tag flows to MCP (idempotentHint) for free.
 * PUT /books/{bookId}/checkout/reserve
 */
const checkoutNode = api_({
  start: op((input: { bookId: string }) => ({ sessionId: `checkout-${input.bookId}` }), http.post),
  reserve: op(
    (input: { bookId: string; patronId: string }) => ({
      reservationId: `res-${input.bookId}-${input.patronId}`,
      patronId: input.patronId,
    }),
    http.put,
  ),
});

// ============================================================================
// Books — list/add ops, plus the per-book fallback subtree
// ============================================================================

/** List all books in the library. GET /books/list */
const listBooks = op((_: unknown): Book[] => [...store.values()], http.get, {
  description: "List all books in the library.",
});

/** Add a new book to the collection. POST /books/add */
const addBook = op(
  (input: { title: string; author: string; genre: string }): Book => {
    const id = `book-${++_seq}`;
    const book: Book = { id, ...input };
    store.set(id, book);
    return book;
  },
  http.post,
  { description: "Add a new book to the collection." },
);

/**
 * Books subtree: `list`/`add` are static children; the per-book fallback
 * captures any other path segment as `bookId` and continues into the
 * read/replace/remove/checkout subtree — built inline via `fallback()`
 * (api-tree's node.ts DX sugar for the `{ name, subtree }` shape) instead of
 * hand-writing `{ name: "bookId", subtree: api_({...}) }` and a separate
 * named `bookItemNode` constant. `read`/`replace`/`remove` still co-locate
 * onto their parent position via each leaf's own `moveTo` directive (read by
 * the HttpRoute pipeline); `checkout` stays a branch, unaffected by
 * placement. This node previously also carried a
 * `{ http: { dispatch: { kind: "method" } } }` marker — the retired direct
 * tree-walk dispatcher's own co-location signal — but that marker was
 * verified read nowhere (docs/design/meta-role-split-spec.md §4/§9(6):
 * `dispatch` handling is deleted, not given a typed home) even before this
 * split, so it's dropped here rather than carried forward as dead meta.
 */
const booksNode = api_(
  {
    list: listBooks,
    add: addBook,
  },
  {
    fallback: fallback("bookId", {
      read: readBook,
      replace: replaceBook,
      remove: removeBook,
      checkout: checkoutNode,
    }),
  },
);

// ============================================================================
// API root
//
// Exported as `api` so extractToolSchemas (codegen) can walk the api() call.
// Both the inline `catalog: api(...)` and `books: booksNode` (also api()) are
// found by the codegen walker.
//
// A header-dispatch API-versioning demo (`X-Api-Version` selecting a
// response body at `GET /version`) previously lived here, exercising the
// retired direct tree-walk dispatcher's attribute-dispatch feature. The
// HttpRoute pipeline has no attribute-dispatch equivalent yet — reintroducing
// this demo is blocked on that open design question (see TODO.md
// "Attribute dispatch (header/query/contentType) is an open design
// question").
// ============================================================================

export const api = api_({
  books: booksNode,

  // Each leaf carries its OWN readOnly tag — tags do not inherit from the
  // node (removed; see docs/design/router-model.md — "Tags").
  catalog: api_({
    /** Search the library catalog by title or author keyword. */
    search: op((input: { q?: string }) => {
      const q = input.q !== undefined ? input.q.toLowerCase() : undefined;
      return [...store.values()].filter(
        (b) =>
          q === undefined ||
          b.title.toLowerCase().includes(q) ||
          b.author.toLowerCase().includes(q),
      );
    }, http.get),

    /** List all genres in the catalog, optionally filtered to those starting with a prefix. */
    genres: op((input: { prefix?: string }) => {
      const all = [...new Set([...store.values()].map((b) => b.genre))];
      const { prefix } = input;
      return prefix !== undefined ? all.filter((g) => g.startsWith(prefix)) : all;
    }, http.get),
  }),
});

// ============================================================================
// Validator wiring — `applyValidation("books", api, "http")`
// (@rhi-zone/fractal-api-tree/apply-validation), the call-site-anchored,
// STAGED wire-profile mechanism (see
// docs/design/wire-profiles-and-staged-validation.md — phase C, "the doc's
// end state is staged-only"; phase D retired the separate 2-arg-only
// pipeline and its `build-wire`/`watch-wire`/`check-wire` subcommands, so
// `build`/`watch`/`check` are now the ONLY subcommands). `bun run codegen`
// (package.json, `build`) scans THIS file for 3-arg
// `applyValidation(key, treeExpr, protocol)`
// invocations and emits `examples/library-api/src/generated/apply-validation.ts`
// via `WireValidatorMap` — the third argument names the wire protocol
// (`"http"` here) so codegen derives each leaf's PER-FIELD encoding: query/
// path params decode from numeric/strict-boolean/ISO-date strings
// (`queryProfile`-style), a JSON body's `Date` fields decode from an ISO
// string (`jsonProfile`-style), everything else in the body arrives already
// typed with no coercion at all — see `packages/api-tree/src/wire-derive.ts`'s
// `deriveFieldProfiles("http", ...)`.
//
// Applied to `api` (the raw Node), BEFORE any protocol-specific projection —
// the same "validate once, share across every projector" shape
// `wrapValidators` (deleted, phase 3) used, and it still works for HTTP
// despite `read`/`replace`/`remove` below being `moveTo`-relocated onto the
// fallback's own root during HTTP projection: `applyValidation` wraps each
// leaf's HANDLER (a function reference), and the wrap travels with that
// reference wherever `httpProjection`'s `applyMoveTo` later moves it — the
// path keys this call's own walk uses (matching what codegen extracted) never
// need to agree with HTTP's post-projection dispatch paths. A leaf with no
// matching generated entry keeps its original handler untouched (permissive
// by default — `assertValidationCoverage` is the opt-in loud check, not run
// here).
//
// This tree is only ever DISPATCHED over HTTP in this example (`httpRoutes`
// below; MCP's own use of `api`, in app.test.ts, is schema-EXTRACTION via
// `toTools`, not a running MCP server) — so there is only one protocol's key
// to claim here. A tree genuinely dispatched over two DIVERGENT wires (e.g.
// HTTP and CLI) would claim one key PER protocol instead (decision 1,
// wire-profiles-and-staged-validation.md's "Implementation trace" section) —
// see that doc for the pattern this example would follow if a second live
// protocol were added.
// ============================================================================

export const validatedApi = applyValidation("books", api, "http");

// ============================================================================
// HttpRoute projection — the pre-composed pipeline (naiveTransform +
// applyMethods + applyMoveTo + applyResponse, see
// docs/design/routing-and-transforms.md and packages/http-api-projector/src/dx.ts),
// over the validated tree. This is the actual route tree
// `createFetch(validatedApi, ...)` (see app.test.ts) dispatches against —
// `createFetch` itself has no dedicated validation option; the tree passed in
// is already `applyValidation`-wrapped, here, before HTTP/MCP/CLI ever
// project it.
// ============================================================================

export const httpRoutes = httpProjection(validatedApi);
