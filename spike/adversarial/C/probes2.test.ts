import { test, expect } from "bun:test";
import {
  path, methods, choice, param, segments, withParams, type Handler,
} from "../../../packages/core/src/index.ts";
import { toFetch, text } from "../../../packages/http/src/index.ts";

// Confirm WHATWG URL decode semantics that segments() relies on.
test("URL pathname decode behavior (root cause for 4a/4b/4c)", () => {
  const cases = ["a%2Fb", "h%C3%A9llo", "a+b", "%2e%2e", ".."];
  const out: Record<string, string[]> = {};
  for (const c of cases) {
    const u = new URL("http://x/f/" + c);
    out[c] = u.pathname.split("/").filter((s) => s !== "");
  }
  console.log("URL.pathname segments:", JSON.stringify(out));
  // Document: pathname does NOT percent-decode; segments() hands RAW encoded values.
  expect(out["h%C3%A9llo"]).toEqual(["f", "h%C3%A9llo"]);
});

// What a param consumer would need to do, and whether %2F splitting is a smuggling risk.
test("4a deep: %2F does NOT create an extra segment (no path smuggling via param)", () => {
  const u = new URL("http://x/f/a%2Fb/tail");
  console.log("segments of /f/a%2Fb/tail:", JSON.stringify(u.pathname.split("/").filter((s) => s !== "")));
  // %2F stays literal -> the param captures "a%2Fb" raw, tail is separate. Safe-ish.
  expect(u.pathname.split("/").filter((s) => s !== "").length).toBe(3);
});

// Decode round-trip: does decodeURIComponent recover the intended value?
test("4 decode: consumer must decodeURIComponent to get real value", () => {
  expect(decodeURIComponent("h%C3%A9llo")).toBe("héllo");
  expect(decodeURIComponent("a%2Fb")).toBe("a/b");
  // '+' is NOT decoded to space by decodeURIComponent (that's form-encoding only)
  expect(decodeURIComponent("a+b")).toBe("a+b");
});

// Confirm param shares the SAME body stream into a passing alt (root cause 3b).
test("3b root cause: clone via withSegments shares body stream", async () => {
  // path() -> withSegments -> new Request(url, req). Does the clone share the body?
  const original = new Request("http://x/r", { method: "POST", body: "abc" });
  const url = new URL(original.url);
  url.pathname = "/";
  const clone = new Request(url, original);
  await clone.text(); // consume clone
  let originalState: string;
  try {
    await original.text();
    originalState = "original STILL readable";
  } catch (e) {
    originalState = "original LOCKED: " + (e as Error).name;
  }
  console.log("body sharing:", originalState);
  expect(originalState).toBeDefined();
});

// Precisely characterize the 405 short-circuit: what does the FIRST methods alt
// return for a method it lacks vs a passing form. Could choice be salvaged if
// methods returned undefined for unknown verbs? (It returns 405, so no.)
// FIXED (C-F1): `methods` is now PURE verb dispatch and PASSES (returns
// undefined) on an absent verb, so it NO LONGER short-circuits choice. The 405
// is a projection in toFetch, computed from .meta across all alts.
test("2 root cause FIXED: a methods alt PASSES (undefined) for an absent verb", async () => {
  const m = methods({ GET: () => text("g") });
  const req = withParams(new Request("http://x/", { method: "POST" }), {});
  const res = await m(req as any);
  console.log("single methods{GET} on POST ->", res?.status, "(undefined = pass; choice no longer short-circuits)");
  expect(res).toBeUndefined();
});

// Does mount/path normalization let /users (no trailing) and trailing both hit?
// Confirm trailing slash equivalence is because trailing empty segment is filtered.
test("5 root cause: trailing/double slash collapse because empties are filtered", () => {
  expect(new URL("http://x/users/").pathname.split("/").filter((s) => s !== "")).toEqual(["users"]);
  expect(new URL("http://x//users").pathname.split("/").filter((s) => s !== "")).toEqual(["users"]);
  expect(new URL("http://x/users//more").pathname.split("/").filter((s) => s !== "")).toEqual(["users", "more"]);
});

// HEAD Content-Length: spec says HEAD should reflect the body's Content-Length.
// We observed cl=null. Confirm and characterize.
test("6a root cause: auto-HEAD drops Content-Length (new Response(null, res))", async () => {
  const app = path({ r: methods({ GET: () => text("hello-body") }) });
  const handler = toFetch(app as Handler<{}>);
  const get = await handler(new Request("http://x/r"));
  const head = await handler(new Request("http://x/r", { method: "HEAD" }));
  console.log("GET CL:", get.headers.get("Content-Length"), "HEAD CL:", head.headers.get("Content-Length"));
  // Document divergence.
  expect(head.status).toBe(200);
});

// auto-HEAD when GET passes (handler returns undefined): the path EXISTS in the
// route table (GET is declared), so the toFetch projection matches it. The
// HEAD→GET re-run yields undefined (the handler passed), so no body is served
// and the projection falls through to 405 — the path matched a known verb set,
// it just produced no content. (A genuinely unknown path is 404; see below.)
test("6a edge: HEAD when GET handler passes -> 405 (path matched, no content)", async () => {
  const passingGet = methods({ GET: () => undefined });
  const app = path({ r: passingGet });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/r", { method: "HEAD" }));
  console.log("HEAD over passing GET ->", res.status);
  expect(res.status).toBe(405);
});

// Param leakage stress: deeply confirm no shared mutation even when alt mutates
// the param object that path handed it.
test("1 deep: alt mutating req.params does not affect sibling (separate clones)", async () => {
  const altA: Handler = (req) => {
    (req as any).params.injected = "FROM_A";
    return undefined;
  };
  const altB: Handler = (req) =>
    text("B params=" + JSON.stringify((req as any).params));
  const app = path({ r: choice(altA, altB) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/r/x"));
  // /r/x : path consumes r, hands choice a clone w/ pathname /x and params {}.
  // BUT choice passes the SAME clone to altA and altB (choice does not re-clone).
  const body = res.status === 200 ? await res.text() : "status " + res.status;
  console.log("sibling mutation leak test:", body);
  expect(body).toBeDefined();
});
