// packages/http-api-projector/src/source-coverage.test.ts — wire-time source coverage
//
// The RUNTIME half of docs/design/typed-store-spec.md §6: the two resolution
// steps `op()`'s static check structurally cannot see (a path-param match,
// which depends on where a leaf is MOUNTED; and the convention fallback, which
// depends on the live request) are checked once when the route tree is built.
//
// The static half is covered by verbs.test.ts's own type-level block.

import { describe, expect, it } from "bun:test";
import {
  SourceCoverageError,
  checkRouteSourceCoverage,
  findRouteSourceCoverageProblems,
  httpRoute,
  makeRouterFromRoute,
} from "./route.ts";
import type { HttpRoute, Sources } from "./route.ts";

const noop = (input: Record<string, unknown>) => input;

const leaf = (method: string, sources: Sources): HttpRoute =>
  httpRoute({ methods: { [method]: { handler: noop, meta: {}, sources } } });

describe("findRouteSourceCoverageProblems", () => {
  it("flags a param whose override names a store nothing builds", () => {
    const route = leaf("GET", {
      paramNames: ["year"],
      sourceMap: { year: { store: "carrierPigeon" } },
    });

    const problems = findRouteSourceCoverageProblems(route);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ method: "GET", param: "year", kind: "unknown-store" });
    expect(problems[0]!.detail).toContain("carrierPigeon");
  });

  it("accepts every built-in store, and the method-derived convention", () => {
    // `a` is deliberately left out of this leaf's paramNames/sourceMap here —
    // an explicit `store: "path"` override needs a matching live segment at
    // the leaf's mounted position to be fillable (see the next test); a bare
    // leaf with no fallback ancestor at all has nothing to supply it, so it's
    // covered separately below instead of folded into this "every store is
    // otherwise fine" case.
    const route = leaf("POST", {
      paramNames: ["b", "c", "d", "e", "viaConvention"],
      sourceMap: {
        b: { store: "query" },
        c: { store: "header" },
        d: { store: "body" },
        e: { store: "caller" },
      },
    });

    // `viaConvention` has no override, so it resolves to POST's primary store
    // ("body") — a store this package builds, so no problem.
    expect(findRouteSourceCoverageProblems(route)).toEqual([]);
  });

  it('flags a store:"path" override whose key has no matching live segment at this leaf\'s mounted position', () => {
    // No fallback ancestor at all — nothing ever supplies "a" from "path",
    // regardless of the override's own store name being a known one.
    const route = leaf("GET", {
      paramNames: ["a"],
      sourceMap: { a: { store: "path" } },
    });

    const problems = findRouteSourceCoverageProblems(route);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ method: "GET", param: "a", kind: "unfillable-path" });
  });

  it("resolves a path param from the path store, ahead of any override", () => {
    // `id` is bound by the fallback segment, so `assemble` reads it from
    // "path" and never consults the override — which means the override's
    // bogus store is unreachable and must NOT be reported for `id`.
    const route = httpRoute({
      fallback: {
        name: "id",
        subtree: leaf("GET", { paramNames: ["id"], sourceMap: { id: { store: "carrierPigeon" } } }),
      },
      meta: {},
    });

    expect(findRouteSourceCoverageProblems(route)).toEqual([]);
  });

  it("flags an override for a param the route doesn't have", () => {
    const route = leaf("GET", {
      paramNames: ["year"],
      sourceMap: { yearr: { store: "query" } },
    });

    const problems = findRouteSourceCoverageProblems(route);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ param: "yearr", kind: "unused-override" });
  });

  it("skips a leaf with no paramNames — there is no fixed param set to check", () => {
    // §6's last bullet: without a codegen-derived param list, the parameter set
    // is request-shaped, so there is nothing to check coverage against.
    const route = leaf("GET", { sourceMap: { year: { store: "carrierPigeon" } } });
    expect(findRouteSourceCoverageProblems(route)).toEqual([]);
  });

  it("accepts a declaration-merged store name passed via knownStores", () => {
    const route = leaf("GET", {
      paramNames: ["session"],
      sourceMap: { session: { store: "cookie" } },
    });

    expect(findRouteSourceCoverageProblems(route)).toHaveLength(1);
    expect(findRouteSourceCoverageProblems(route, { knownStores: ["cookie"] })).toEqual([]);
  });

  it("reports EVERY problem across the whole tree in one pass, not just the first", () => {
    const route = httpRoute({
      children: {
        books: leaf("GET", { paramNames: ["a"], sourceMap: { a: { store: "nope1" } } }),
        authors: leaf("POST", { paramNames: ["b"], sourceMap: { b: { store: "nope2" } } }),
      },
      fallback: {
        name: "id",
        subtree: leaf("GET", { paramNames: ["c"], sourceMap: { c: { store: "nope3" } } }),
      },
      meta: {},
    });

    const problems = findRouteSourceCoverageProblems(route);
    expect(problems.map((p) => p.param).sort()).toEqual(["a", "b", "c"]);
    expect(problems.map((p) => p.path).sort()).toEqual(["/authors", "/books", "/{id}"]);
  });
});

describe("checkRouteSourceCoverage / makeRouterFromRoute", () => {
  it("throws one error carrying every problem", () => {
    const route = httpRoute({
      children: {
        books: leaf("GET", { paramNames: ["a"], sourceMap: { a: { store: "nope1" } } }),
        authors: leaf("GET", { paramNames: ["b"], sourceMap: { b: { store: "nope2" } } }),
      },
      meta: {},
    });

    expect(() => checkRouteSourceCoverage(route)).toThrow(SourceCoverageError);
    try {
      checkRouteSourceCoverage(route);
    } catch (e) {
      const err = e as SourceCoverageError;
      expect(err.problems).toHaveLength(2);
      // The message lists both, so one boot surfaces the whole list.
      expect(err.message).toContain("nope1");
      expect(err.message).toContain("nope2");
    }
  });

  it("runs at wire time — building the router throws, before any request", () => {
    const route = leaf("GET", { paramNames: ["a"], sourceMap: { a: { store: "nope" } } });
    expect(() => makeRouterFromRoute(route)).toThrow(SourceCoverageError);
  });

  it("a clean tree builds a router as before", () => {
    const route = leaf("GET", { paramNames: ["a"], sourceMap: { a: { store: "query" } } });
    expect(typeof makeRouterFromRoute(route)).toBe("function");
  });
});
