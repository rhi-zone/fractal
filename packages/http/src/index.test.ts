// packages/http/src/index.test.ts — the renderer over the function-core tree.

import { describe, expect, it } from "bun:test";
import {
  app,
  group,
  methods,
  ok,
  param,
  path,
  route,
  str,
  type Result,
} from "@rhi-zone/fractal-core";
import {
  encodeErr,
  patternMatches,
  pathSegments,
  toFetch,
  type PatternSegment,
} from "./index.ts";

describe("path helpers", () => {
  it("splits a URL path and matches patterns", () => {
    expect(pathSegments("http://x/a/b/")).toEqual(["a", "b"]);
    const pat: PatternSegment[] = [
      { kind: "literal", value: "classes" },
      { kind: "param", name: "id" },
    ];
    expect(patternMatches(pat, ["classes", "c1"])).toBe(true);
    expect(patternMatches(pat, ["classes"])).toBe(false);
    expect(patternMatches(pat, ["other", "c1"])).toBe(false);
  });
});

describe("default encodeErr", () => {
  it("honours a numeric status, else 500", () => {
    expect(encodeErr({ status: 403, error: "x" }).status).toBe(403);
    expect(encodeErr("boom").status).toBe(500);
  });
});

// Standalone named producer — an inline arrow passed to `group` is contextually
// typed and collapses the top-down context flow.
function authUser(req: Request): Result<{ id: string }, { status: number; error: string }> {
  return req.headers.has("authorization")
    ? ok({ id: "u" })
    : { ok: false, error: { status: 401, error: "no auth" } };
}

describe("toFetch over a tree", () => {
  const tree = app(
    path({
      classes: param(
        "id",
        group(
          "user",
          authUser,
          methods({
            GET: route({
              query: { from: str() },
              handler: ({ id, from, user }) => ok({ id, from, by: user.id }),
            }),
          }),
        ),
      ),
    }),
  );
  const h = toFetch(tree);

  it("routes a GET, runs the capability + query, encodes ok", async () => {
    const res = await h(
      new Request("http://x/classes/c9?from=q", {
        headers: { authorization: "t" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "c9", from: "q", by: "u" });
  });

  it("404 unknown path, 401 capability fail, 405 + Allow wrong verb", async () => {
    expect((await h(new Request("http://x/nope"))).status).toBe(404);
    expect(
      (await h(new Request("http://x/classes/c1?from=q"))).status,
    ).toBe(401);
    const m = await h(
      new Request("http://x/classes/c1", { method: "POST", headers: { authorization: "t" } }),
    );
    expect(m.status).toBe(405);
    expect(m.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});
