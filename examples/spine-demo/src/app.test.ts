// examples/spine-demo/src/app.test.ts — the runtime spine, end to end.
//
// Drives real WHATWG Requests through the rendered fetch handler and asserts
// status + body + headers. Plus type-level proofs that the leaf `options` is
// genuinely inferred (not `any`) in real package context.

import { describe, expect, it } from "bun:test";
import { handler } from "./index.ts";
import { tree } from "./app.ts";
import {
  app,
  group,
  methods,
  ok,
  param,
  path,
  route,
  str,
  type Node,
  type Result,
} from "@rhi-zone/fractal-core";

const BASE = "http://localhost";
const AUTH = { authorization: "Bearer u-42" };

function req(
  method: string,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...opts.headers };
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return new Request(url, init);
}

describe("function-core spine", () => {
  it("GET with path-param + query reaches the handler with the typed options", async () => {
    const res = await handler(
      req("GET", `${BASE}/classes/c1?from=roster`, { headers: AUTH }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "c1", from: "roster", userId: "u-42" });
  });

  it("POST body validation works and the capability flows in", async () => {
    const res = await handler(
      req("POST", `${BASE}/classes/c1?from=ui`, {
        headers: AUTH,
        body: { title: "Algebra" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "c1",
      from: "ui",
      title: "Algebra",
      userId: "u-42",
    });
  });

  it("POST with a bad body short-circuits with 400 (negative test)", async () => {
    const res = await handler(
      req("POST", `${BASE}/classes/c1?from=ui`, {
        headers: AUTH,
        body: { title: 123 }, // title must be a string
      }),
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("BAD_REQUEST");
  });

  it("a missing query field short-circuits with 400", async () => {
    const res = await handler(req("GET", `${BASE}/classes/c1`, { headers: AUTH }));
    expect(res.status).toBe(400);
  });

  it("a missing capability (no auth) short-circuits with 401", async () => {
    const res = await handler(req("GET", `${BASE}/classes/c1?from=roster`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("the auth 401 fires before a 405 would (OPTIONS is not gated by auth)", async () => {
    // OPTIONS at a matched path → 204 + Allow, WITHOUT running the producer.
    const res = await handler(req("OPTIONS", `${BASE}/classes/c1`));
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS, POST");
  });

  it("health route needs no capability or producers", async () => {
    const res = await handler(req("GET", `${BASE}/health`));
    expect(res.status).toBe(200);
    expect(await res.json()).toBe("up");
  });

  it("404 for an unknown path", async () => {
    const res = await handler(req("GET", `${BASE}/nope`));
    expect(res.status).toBe(404);
  });

  it("405 + correct Allow for a wrong method on a matched path", async () => {
    const res = await handler(req("DELETE", `${BASE}/classes/c1`, { headers: AUTH }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS, POST");
  });

  it("HEAD is auto-served from GET (status + headers, no body)", async () => {
    const res = await handler(
      req("HEAD", `${BASE}/health`),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("the tree is a runtime Node value", () => {
    expect((tree as { kind: string }).kind).toBe("path");
  });
});

// --- type-level proof: the leaf `options` is genuinely inferred --------------
// These never run; they fail `tsc` if the inference regresses.
// Capability producers are standalone named functions (as in app.ts). An INLINE
// arrow passed straight to `group` is contextually typed by the parameter and
// disrupts the top-down `C` flow — see the finding in this slice's report.
function probeUser(_req: Request): Result<{ id: string }, never> {
  return ok({ id: "u" });
}

describe("inference (compile-time)", () => {
  it("accumulates param + capability + query fields exactly", () => {
    const ok1: Node<{}> = app(
      path({
        items: param(
          "id",
          group(
            "user",
            probeUser,
            methods({
              GET: route({
                query: { q: str() },
                handler: (o) => {
                  // all three are present and typed
                  const _id: string = o.id;
                  const _q: string = o.q;
                  const _u: string = o.user.id;
                  return ok({ _id, _q, _u });
                },
              }),
            }),
          ),
        ),
      }),
    );
    expect((ok1 as { kind: string }).kind).toBe("path");

    // @ts-expect-error — `nope` is not an inferred field of options
    const bad = route<{ id: string }>({ handler: (o) => ok(o.nope) });
    void bad;
  });
});
