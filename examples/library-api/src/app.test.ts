// End-to-end tests for the library-api on the new fractal model.
// Exercises the whole stack: HTTP (createFetch) + MCP (toTools) + codegen
// (extractToolSchemas). Each assertion proves a specific new-model invariant.
//
// The byId subtree co-locates three leaves onto the fallback wildcard via
// `moveTo` directives (see route.ts § applyMoveTo):
//   read    → GET  /books/{bookId}
//   replace → PUT  /books/{bookId}
//   remove  → DELETE /books/{bookId}
// CLI/MCP name these by their agnostic child keys (read, replace, remove).

import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it } from "bun:test";
import { api, clearStore, httpRoutes, validatedApi } from "./tree.ts";
import { createFetch } from "@rhi-zone/fractal-http-api-projector/preset";
import {
  httpRoute,
  makeRouterFromRoute,
  mapRoute,
  routeCandidatesForUrl,
} from "@rhi-zone/fractal-http-api-projector/route";
import type { HttpRoute } from "@rhi-zone/fractal-http-api-projector/route";
import { radixRouter } from "@rhi-zone/fractal-http-api-projector";
import { http } from "@rhi-zone/fractal-http-api-projector/verbs";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags";
import type { Tags } from "@rhi-zone/fractal-api-tree/tags";
import { createApplyValidation } from "@rhi-zone/fractal-api-tree/apply-validation";
import { isResultShape } from "@rhi-zone/fractal-api-tree";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { extractToolSchemas } from "@rhi-zone/fractal-api-tree/tree";
import { wireValidatorsByKey } from "./generated/apply-validation.ts";

/** Candidate methods reachable at `path` in the library-api's HttpRoute tree. */
function methodsAt(path: string): string[] {
  return routeCandidatesForUrl(httpRoutes, `http://localhost${path}`).map((c) => c.method);
}

// Codegen reads the tree source directly
const treePath = new URL("./tree.ts", import.meta.url).pathname;

const fetch = createFetch(api);

function jsonReq(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

// ============================================================================
// HTTP projection
// ============================================================================

describe("library-api — HTTP routes", () => {
  beforeEach(() => {
    clearStore();
  });

  it("readOnly op (books list) → GET route", () => {
    expect(methodsAt("/books/list")).toContain("GET");
  });

  it("read (placed onto the fallback wildcard) → GET /books/{bookId}", () => {
    expect(methodsAt("/books/book-1")).toContain("GET");
  });

  it("replace (placed onto the fallback wildcard) → PUT /books/{bookId}", () => {
    expect(methodsAt("/books/book-1")).toContain("PUT");
  });

  it("remove (placed onto the fallback wildcard) → DELETE /books/{bookId}", () => {
    expect(methodsAt("/books/book-1")).toContain("DELETE");
  });

  it("3 distinct methods converge at the same /books/{bookId} path", () => {
    const methods = methodsAt("/books/book-1");
    expect(methods).toHaveLength(3);
    expect(new Set(methods)).toEqual(new Set(["GET", "PUT", "DELETE"]));
  });

  it("checkout branch child under the fallback → its own segment, unaffected by placement", () => {
    // checkout is a branch, not a leaf placed onto the wildcard — its leaf
    // 'start' keeps its own path segment
    expect(methodsAt("/books/book-1/checkout/start")).toHaveLength(1);
  });

  it("catalog ops each carry an http.get bundle → GET routes", () => {
    expect(methodsAt("/catalog/search")).toContain("GET");
    expect(methodsAt("/catalog/genres")).toContain("GET");
  });

  it("fallback slug (bookId) threads into handler input provenance-blind", async () => {
    // Add a book; capture its generated ID
    const addRes = await fetch(
      jsonReq("POST", "http://localhost/books/add", {
        title: "The Pragmatic Programmer",
        author: "Hunt & Thomas",
        genre: "Engineering",
      }),
    );
    expect(addRes.status).toBe(200);
    const book = (await addRes.json()) as { id: string };

    // GET /books/{id} — read, placed onto the fallback wildcard
    const readRes = await fetch(new Request(`http://localhost/books/${book.id}`));
    expect(readRes.status).toBe(200);
    const details = (await readRes.json()) as { id: string; title: string };
    expect(details.id).toBe(book.id);
    expect(details.title).toBe("The Pragmatic Programmer");
  });

  it("DELETE /books/{id} → deletes the book", async () => {
    const addRes = await fetch(
      jsonReq("POST", "http://localhost/books/add", {
        title: "Clean Code",
        author: "Robert Martin",
        genre: "Engineering",
      }),
    );
    const { id } = (await addRes.json()) as { id: string };

    const delRes = await fetch(new Request(`http://localhost/books/${id}`, { method: "DELETE" }));
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("auto-method: OPTIONS → 204 + Allow header", async () => {
    const res = await fetch(new Request("http://localhost/books/list", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    const allow = res.headers.get("Allow");
    expect(allow).toContain("GET");
    expect(allow).toContain("OPTIONS");
  });

  it("auto-method: HEAD from GET → 200, no body", async () => {
    const res = await fetch(new Request("http://localhost/catalog/search", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("auto-method: wrong method → 405 + Allow", async () => {
    const res = await fetch(new Request("http://localhost/catalog/search", { method: "DELETE" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("GET");
  });
});

// ============================================================================
// MCP projection
// ============================================================================

describe("library-api — MCP tools", () => {
  it("readOnly op (books_list) → readOnlyHint: true", () => {
    const tools = toTools(api);
    const t = tools.find((t) => t.name === "books_list");
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it("destructive op (books_bookId_remove) → destructiveHint: true", () => {
    const tools = toTools(api);
    const t = tools.find((t) => t.name === "books_bookId_remove");
    expect(t?.annotations?.destructiveHint).toBe(true);
  });

  it("idempotent op (books_bookId_replace) → idempotentHint: true", () => {
    const tools = toTools(api);
    const t = tools.find((t) => t.name === "books_bookId_replace");
    expect(t?.annotations?.idempotentHint).toBe(true);
  });

  it("readOnly op (books_bookId_read) → readOnlyHint: true", () => {
    const tools = toTools(api);
    const t = tools.find((t) => t.name === "books_bookId_read");
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it("node-level readOnly inheritance: catalog_search → readOnlyHint: true", () => {
    const tools = toTools(api);
    // search op has no meta.tags of its own; readOnly comes from catalog node
    const t = tools.find((t) => t.name === "catalog_search");
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it("node-level readOnly inheritance: catalog_genres → readOnlyHint: true", () => {
    const tools = toTools(api);
    // genres op has no meta.tags of its own; readOnly comes from catalog node
    const t = tools.find((t) => t.name === "catalog_genres");
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it("catalog_search has real codegen-derived inputSchema (not placeholder)", () => {
    // tree.ts exports 3 candidate trees (`api`, `validatedApi`,
    // `httpRoutes`); `api` and `validatedApi` are structurally identical (the
    // latter is the former wrapped by `applyValidation`), so an unscoped
    // extraction would trip `assertUniqueName` on their shared leaf names.
    const schemas = extractToolSchemas(treePath, "api");
    const tools = toTools(api, { schemas });
    const t = tools.find((t) => t.name === "catalog_search");
    // Real schema has properties.q; the placeholder { type: "object" } does not
    expect(t?.inputSchema).toMatchObject({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  it("catalog_genres has real codegen-derived inputSchema (not placeholder)", () => {
    // tree.ts exports 3 candidate trees (`api`, `validatedApi`,
    // `httpRoutes`); `api` and `validatedApi` are structurally identical (the
    // latter is the former wrapped by `applyValidation`), so an unscoped
    // extraction would trip `assertUniqueName` on their shared leaf names.
    const schemas = extractToolSchemas(treePath, "api");
    const tools = toTools(api, { schemas });
    const t = tools.find((t) => t.name === "catalog_genres");
    // Real schema has properties.prefix
    expect(t?.inputSchema).toMatchObject({
      type: "object",
      properties: { prefix: { type: "string" } },
    });
  });
});

// ============================================================================
// Verb-helper bundles: one helper → HTTP verb and MCP hint
// ============================================================================

describe("library-api — verb-helper bundles (http.*)", () => {
  // http.put bundle: checkout/reserve op authored with http.put
  it("http.put on reserve: HTTP route is PUT /books/{bookId}/checkout/reserve", () => {
    expect(methodsAt("/books/book-1/checkout/reserve")).toContain("PUT");
  });

  it("http.put on reserve: MCP tool gets idempotentHint (bundle → MCP for free)", () => {
    const tools = toTools(api);
    const t = tools.find((t) => t.name === "books_bookId_checkout_reserve");
    expect(t?.annotations?.idempotentHint).toBe(true);
  });

  // http.post bundle: checkout/start op authored with http.post
  it("http.post on start: HTTP route is POST /books/{bookId}/checkout/start", () => {
    expect(methodsAt("/books/book-1/checkout/start")).toContain("POST");
  });

  it("http.post on start: MCP tool has no idempotentHint (plain mutation)", () => {
    const tools = toTools(api);
    const t = tools.find((t) => t.name === "books_bookId_checkout_start");
    // post bundles carry no idempotent tag; the hint is absent or false
    expect(t?.annotations?.idempotentHint).toBeFalsy();
  });

  // op(fn, http.put, { tags: { destructive: false } }) deep-merges: the bundle's
  // idempotent:true is preserved alongside the extra tags' destructive:false
  it("op(fn, http.put, extra-tags) deep-merges: bundle's idempotent preserved + extra applied", () => {
    const n = op((_: unknown) => {}, http.put, { tags: { destructive: false } });
    const nodeTags = (n.meta.tags ?? {}) as Tags;
    const resolved = resolveTags(nodeTags);
    // idempotent:true from the http.put bundle survives the extra contribution
    expect(resolved.idempotent).toBe(true);
    // destructive:false from extra contribution is applied
    expect(resolved.destructive).toBe(false);
    // verb flat key from bundle is preserved
    const httpMeta = n.meta.http as { verb?: string };
    expect(httpMeta.verb).toBe("PUT");
  });

  // end-to-end: verb-helper-authored reserve op dispatches correctly
  it("PUT /books/{bookId}/checkout/reserve dispatches via verb-helper route", async () => {
    const fetch = createFetch(api);
    const res = await fetch(
      new Request("http://localhost/books/book-1/checkout/reserve", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patronId: "patron-99" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reservationId: string; patronId: string };
    expect(body.reservationId).toBe("res-book-1-patron-99");
    expect(body.patronId).toBe("patron-99");
  });
});

// ============================================================================
// Codegen validators — `applyValidation("books", api, "http")` wiring
// (tree.ts's `validatedApi`/`httpRoutes`, wired via
// generated/apply-validation.ts, see src/generated/apply-validation.ts and
// package.json's `codegen` script (`build`) — see
// docs/design/wire-profiles-and-staged-validation.md). Applied to the raw
// `Node` before HttpRoute projection ever runs (see tree.ts's own doc
// comment for why this still keys correctly for HTTP despite
// `read`/`replace`/`remove`'s `moveTo` relocation) — HTTP is the only
// protocol this tree is actually dispatched over in this example (MCP's own
// use of `api`, below, is schema-extraction via `toTools`, not a running MCP
// server), so there is only one protocol's key ("http") to claim.
// ============================================================================

describe("library-api — codegen-generated validators", () => {
  it("httpRoutes' catalog/search GET handler is applyValidation-wrapped", () => {
    const handler = httpRoutes.children?.catalog?.children?.search?.methods?.GET?.handler;
    const originalHandler = api.children?.catalog?.children?.search?.handler;
    expect(handler).toBeDefined();
    // Verified by handler identity: decode + validation run unconditionally
    // on every leaf `applyValidation` covers.
    expect(handler).not.toBe(originalHandler);
  });

  it("a leaf tagged unvalidated, with no matching generated validator entry, is left untouched", () => {
    // Every leaf in the real `api` tree has a generated entry (see
    // generated/apply-validation.ts), so this exercises the pass-through
    // case on a synthetic tree instead, mirroring the "widgets"/"other" split
    // preset.test.ts uses for createFetch's own applyValidation wiring.
    // `applyValidation` is permissive by default: an uncovered leaf passes
    // through unwrapped, and `assertValidationCoverage` is the opt-in loud
    // check for that case, not exercised here — the `unvalidated` tag on
    // the fixture leaf is illustrative only. This uses a fresh
    // `createApplyValidation` instance, not the generated singleton (that
    // one already consumed key "books" in tree.ts, and a key can only be
    // used once per created function), over the same
    // `wireValidatorsByKey.books` map, so it exercises the real generated
    // data.
    const unwrapped = (input: unknown) => input;
    const fixture = api_({ other: op(unwrapped, { tags: { unvalidated: true } }) });
    const applyValidation = createApplyValidation({}, { books: wireValidatorsByKey.books });
    const wrapped = applyValidation("books", fixture, "http");
    expect(wrapped.children?.other?.handler).toBe(unwrapped);
  });

  // `catalog/search`'s generated schema is `{ q?: string }` — every value a
  // real HTTP GET query string can produce for `q` is already a string
  // (WHATWG `URLSearchParams` never yields anything else), so an actual HTTP
  // request to this route can't produce a type-mismatch. This calls the
  // wired handler directly with a malformed bag instead, confirming codegen
  // + wiring reject bad input rather than only ever passing it through.
  it("wired handler rejects a wrong-typed bag (q as a number, not a string)", async () => {
    const handler = httpRoutes.children?.catalog?.children?.search?.methods?.GET?.handler;
    expect(handler).toBeDefined();
    const result = await handler!({ q: 123 });
    expect(isResultShape(result)).toBe(true);
    if (!isResultShape(result)) throw new Error("expected a Result");
    expect(result.kind).toBe("err");
  });

  it("wired handler accepts a correctly-typed bag (q as a string)", async () => {
    const handler = httpRoutes.children?.catalog?.children?.search?.methods?.GET?.handler;
    expect(handler).toBeDefined();
    const result = (await handler!({ q: "hobbit" })) as unknown[];
    expect(Array.isArray(result)).toBe(true);
  });

  it("valid request through the validated route still returns 200 (GET /catalog/search?q=...)", async () => {
    const router = makeRouterFromRoute(httpRoutes);
    const res = await router(new Request("http://localhost/catalog/search?q=hobbit"));
    expect(res.status).toBe(200);
  });

  it("valid request through the validated route still returns 200 (GET /catalog/genres)", async () => {
    const router = makeRouterFromRoute(httpRoutes);
    const res = await router(new Request("http://localhost/catalog/genres"));
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// createFetch preset options — exercised against the real library-api tree
// (`api`, tree.ts), not a synthetic fixture. `preset.test.ts` covers each
// option in isolation against a minimal fixture; this section confirms the
// same toggles hold up against the actual example app the top-level `fetch`
// (createFetch(api), used throughout this file) is built from.
// ============================================================================

describe("library-api — createFetch preset options against the real tree", () => {
  beforeEach(() => {
    clearStore();
  });

  it("cors: true adds Access-Control-Allow-Origin; default fetch has none", async () => {
    const withCors = createFetch(api, { cors: true });
    const res = await withCors(new Request("http://localhost/catalog/genres"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const plain = await fetch(new Request("http://localhost/catalog/genres"));
    expect(plain.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("router: radixRouter dispatches the full tree correctly when passed as opts.router", async () => {
    const withRadix = createFetch(api, { router: radixRouter });

    const addRes = await withRadix(
      jsonReq("POST", "http://localhost/books/add", {
        title: "Domain-Driven Design",
        author: "Eric Evans",
        genre: "Engineering",
      }),
    );
    expect(addRes.status).toBe(200);
    const book = (await addRes.json()) as { id: string };

    const readRes = await withRadix(new Request(`http://localhost/books/${book.id}`));
    expect(readRes.status).toBe(200);
    expect(((await readRes.json()) as { title: string }).title).toBe("Domain-Driven Design");

    // fallback co-location (GET/PUT/DELETE at the same /books/{bookId})
    // still resolves through the radix compiler
    const delRes = await withRadix(
      new Request(`http://localhost/books/${book.id}`, { method: "DELETE" }),
    );
    expect(delRes.status).toBe(200);
  });

  it("als: whole request (including autoMethodLayer short-circuits) runs inside the AsyncLocalStorage context", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>();
    let observed: string | undefined;

    // A spy rewriter, built on the exported `mapRoute` tree-visitor, wraps
    // every method handler across the real tree so we can observe the
    // AsyncLocalStorage context from inside an actual library-api handler.
    const spyRewriter = (route: HttpRoute) =>
      mapRoute(route, (node) => {
        if (node.methods === undefined) return node;
        const wrapped = Object.fromEntries(
          Object.entries(node.methods).map(([method, entry]) => [
            method,
            {
              ...entry,
              handler: (input: unknown) => {
                observed = storage.getStore()?.requestId;
                return entry.handler(input);
              },
            },
          ]),
        );
        return httpRoute({
          methods: wrapped,
          children: node.children,
          fallback: node.fallback,
          meta: node.meta,
        });
      });

    const withAls = createFetch(api, {
      als: { storage, init: () => ({ requestId: "req-lib-1" }) },
      rewriters: [spyRewriter],
    });

    const res = await withAls(new Request("http://localhost/catalog/search"));
    expect(res.status).toBe(200);
    expect(observed).toBe("req-lib-1");

    // HEAD-as-GET (autoMethodLayer) also runs inside the ALS context
    const headRes = await withAls(
      new Request("http://localhost/catalog/search", { method: "HEAD" }),
    );
    const observedOnHead: string | undefined = observed;
    expect(headRes.status).toBe(200);
    expect(observedOnHead).toBe("req-lib-1");
  });

  it("directives: false — naiveTransform baseline; moveTo-placed /books/{id} routes disappear", async () => {
    const naive = createFetch(api, { directives: false });

    // read/replace/remove are moveTo-placed onto the fallback wildcard by
    // default; with directives off, that placement never runs.
    const moved = await naive(new Request("http://localhost/books/book-1"));
    expect(moved.status).toBe(404);
  });

  it("codegen-generated validators still run when combined with cors + a custom router", async () => {
    // `createFetch` has no dedicated validation option (see http-api-
    // projector's preset.ts module doc) — the tree passed in is already
    // `applyValidation`-wrapped (`validatedApi`, tree.ts), the same
    // Node-level wiring MCP/CLI share, applied before it ever reaches
    // `createFetch`.
    const combined = createFetch(validatedApi, {
      cors: true,
      router: radixRouter,
    });

    const withQuery = await combined(new Request("http://localhost/catalog/search?q=hobbit"));
    expect(withQuery.status).toBe(200);
    expect(withQuery.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const withoutQuery = await combined(new Request("http://localhost/catalog/search"));
    expect(withoutQuery.status).toBe(200);
  });
});
