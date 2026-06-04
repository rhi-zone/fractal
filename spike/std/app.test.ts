// Runnable assertions. Constructs real `new Request(...)` values, runs them
// through `toFetch(app)`, and asserts status + body for every required case.
// Throws on mismatch. Run with: bun spike/std/app.test.ts

import { app } from "./app.ts";
import { methods, toFetch, type Handler } from "./std.ts";

const fetch = toFetch(app);
const BASE = "http://x";

let passed = 0;
function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

async function get(p: string, method = "GET"): Promise<Response> {
  return fetch(new Request(BASE + p, { method }));
}

// --- GET /users (collection) ----------------------------------------------
{
  const res = await get("/users");
  ok(res.status === 200, "GET /users -> 200");
  const body = await res.json();
  ok(Array.isArray(body) && body.length === 2, "GET /users -> 2 users");
}

// --- POST /users -----------------------------------------------------------
{
  const res = await fetch(new Request(BASE + "/users", { method: "POST" }));
  ok(res.status === 201, "POST /users -> 201");
  const body = (await res.json()) as { created: boolean };
  ok(body.created === true, "POST /users -> created");
}

// --- GET /users/:id (id read off req) -------------------------------------
{
  const res = await get("/users/1");
  ok(res.status === 200, "GET /users/1 -> 200");
  const body = (await res.json()) as { id: string; name: string };
  ok(body.id === "1" && body.name === "ada", "GET /users/1 -> ada");
}
{
  const res = await get("/users/2");
  const body = (await res.json()) as { name: string };
  ok(body.name === "alan", "GET /users/2 -> alan");
}

// --- 404 unknown path ------------------------------------------------------
{
  const res = await get("/nope");
  ok(res.status === 404, "GET /nope -> 404");
}
{
  const res = await get("/users/1/comments");
  ok(res.status === 404, "GET /users/1/comments (unknown nested) -> 404");
}

// --- 405 known path, wrong verb, correct Allow ----------------------------
{
  const res = await fetch(new Request(BASE + "/users", { method: "DELETE" }));
  ok(res.status === 405, "DELETE /users -> 405");
  const allow = res.headers.get("Allow") ?? "";
  ok(allow.includes("GET") && allow.includes("POST"), `405 Allow lists verbs (${allow})`);
  ok(!allow.includes("DELETE"), "405 Allow does not list DELETE");
}

// --- auto-HEAD on a GET route ---------------------------------------------
{
  const head = await get("/users", "HEAD");
  ok(head.status === 200, "HEAD /users -> 200 (mirrors GET)");
  const body = await head.text();
  ok(body === "", "HEAD /users -> empty body");
}

// --- nested path /users/:id/posts (composition via URL-advancing) ----------
{
  const res = await get("/users/1/posts");
  ok(res.status === 200, "GET /users/1/posts -> 200");
  const body = (await res.json()) as { user: string; posts: string[] };
  ok(body.user === "1", "GET /users/1/posts -> user id 1");
  ok(body.posts[0] === "hello from 1", "GET /users/1/posts -> nested data");
}

// --- second top-level resource (top-level composition) ---------------------
{
  const res = await get("/health");
  ok(res.status === 200, "GET /health -> 200");
  ok((await res.text()) === "ok", "GET /health -> ok");
}

// --- trailing-slash normalization ------------------------------------------
{
  const res = await get("/users/");
  ok(res.status === 200, "GET /users/ (trailing slash) -> 200");
}
{
  const res = await get("/");
  ok(res.status === 404, "GET / (root, no route) -> 404");
}

// --- OPTIONS minimal -------------------------------------------------------
{
  const res = await get("/users", "OPTIONS");
  ok(res.status === 204, "OPTIONS /users -> 204");
  ok((res.headers.get("Allow") ?? "").includes("GET"), "OPTIONS Allow header");
}

// --- compile-time guard: a misspelled verb key is a type error -------------
// The closed `Method` union makes "GETT" rejected by `methods`. Uncommenting
// the @ts-expect-error block proves it (kept commented so the file runs):
const _guard: Handler = methods({
  GET: () => new Response("ok"),
  // @ts-expect-error — "GETT" is not a Method; closed union rejects the typo.
  GETT: () => new Response("nope"),
});
void _guard;

console.log(`OK — ${passed} assertions passed`);
