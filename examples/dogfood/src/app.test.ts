// examples/dogfood/src/app.test.ts
//
// In-process HTTP tests over the prospects slice via toFetch — covering the
// status codes a real app must get right: 200/201/204/400/401/404/405/409/422,
// query filtering, and the assign orchestration's side effect.

import { beforeEach, describe, expect, it } from "bun:test";
import { handle } from "./app.ts";
import { notifications, reset } from "./domain.ts";

const BASE = "http://localhost";
const AUTH = { authorization: "Bearer admin" };

async function hit(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return handle(new Request(`${BASE}${path}`, init));
}

async function create(name = "Acme"): Promise<{ id: string }> {
  const res = await hit("POST", "/prospects", {
    headers: AUTH,
    body: { contactName: name, source: "web" },
  });
  return res.json();
}

beforeEach(() => reset());

describe("auth (withAuth wraps the whole resource)", () => {
  it("401 without a Bearer token", async () => {
    const res = await hit("GET", "/prospects");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("UNAUTHORIZED");
  });

  it("auth runs before routing: unauthenticated wrong-verb still 401s", async () => {
    expect((await hit("PUT", "/prospects")).status).toBe(401);
  });
});

describe("create + validation", () => {
  it("201 on valid create", async () => {
    const res = await hit("POST", "/prospects", {
      headers: AUTH,
      body: { contactName: "Beta", source: "referral" },
    });
    expect(res.status).toBe(201);
    const p = await res.json();
    expect(p.status).toBe("new");
    expect(p.assignedToUserId).toBe(null);
  });

  it("400 on invalid create (missing field)", async () => {
    const res = await hit("POST", "/prospects", {
      headers: AUTH,
      body: { contactName: "x" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION");
  });
});

describe("list with query filters", () => {
  it("filters by status and source query params", async () => {
    await create("a");
    const b = await create("b");
    // move b to qualified
    await hit("PATCH", `/prospects/${b.id}/status`, {
      headers: AUTH,
      body: { status: "qualified" },
    });
    const all = await (await hit("GET", "/prospects", { headers: AUTH })).json();
    expect(all.length).toBe(2);
    const qualified = await (
      await hit("GET", "/prospects?status=qualified", { headers: AUTH })
    ).json();
    expect(qualified.length).toBe(1);
    expect(qualified[0].id).toBe(b.id);
    const web = await (
      await hit("GET", "/prospects?source=web", { headers: AUTH })
    ).json();
    expect(web.length).toBe(2);
  });

  it("400 on an invalid status query value", async () => {
    const res = await hit("GET", "/prospects?status=bogus", { headers: AUTH });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("BAD_QUERY");
  });
});

describe("get / update / delete by id", () => {
  it("GET /prospects/{id} returns the item", async () => {
    const p = await create("findme");
    const res = await hit("GET", `/prospects/${p.id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((await res.json()).contactName).toBe("findme");
  });

  it("GET unknown id -> 404", async () => {
    const res = await hit("GET", "/prospects/nope", { headers: AUTH });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("NOT_FOUND");
  });

  it("PATCH /prospects/{id} updates", async () => {
    const p = await create("old");
    const res = await hit("PATCH", `/prospects/${p.id}`, {
      headers: AUTH,
      body: { contactName: "new" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).contactName).toBe("new");
  });

  it("DELETE /prospects/{id} -> 204, then 404", async () => {
    const p = await create("doomed");
    expect((await hit("DELETE", `/prospects/${p.id}`, { headers: AUTH })).status).toBe(204);
    expect((await hit("GET", `/prospects/${p.id}`, { headers: AUTH })).status).toBe(404);
  });
});

describe("status transition: error-code -> status mapping", () => {
  it("409 ALREADY_CONVERTED", async () => {
    const p = await create();
    await hit("PATCH", `/prospects/${p.id}/status`, { headers: AUTH, body: { status: "qualified" } });
    await hit("PATCH", `/prospects/${p.id}/status`, { headers: AUTH, body: { status: "converted" } });
    const res = await hit("PATCH", `/prospects/${p.id}/status`, {
      headers: AUTH,
      body: { status: "lost" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("ALREADY_CONVERTED");
  });

  it("422 INVALID_TRANSITION (new -> converted is illegal)", async () => {
    const p = await create();
    const res = await hit("PATCH", `/prospects/${p.id}/status`, {
      headers: AUTH,
      body: { status: "converted" },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("INVALID_TRANSITION");
  });

  it("400 on a status value outside the picklist", async () => {
    const p = await create();
    const res = await hit("PATCH", `/prospects/${p.id}/status`, {
      headers: AUTH,
      body: { status: "bogus" },
    });
    expect(res.status).toBe(400);
  });
});

describe("assign orchestration (auth-role check + side effect)", () => {
  it("assigns to a valid admin and fires one notification", async () => {
    const p = await create();
    const res = await hit("POST", `/prospects/${p.id}/assign`, {
      headers: AUTH,
      body: { userId: "alice" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).assignedToUserId).toBe("alice");
    expect(notifications).toEqual([{ targetUserId: "alice", prospectId: p.id }]);
  });

  it("422 INVALID_ROLE for a non-admin target (no notification)", async () => {
    const p = await create();
    const res = await hit("POST", `/prospects/${p.id}/assign`, {
      headers: AUTH,
      body: { userId: "intruder" },
    });
    expect(res.status).toBe(422);
    expect(notifications).toEqual([]);
  });
});

describe("http correctness projection", () => {
  it("405 on a known path with a wrong verb", async () => {
    const res = await hit("PUT", "/prospects", { headers: AUTH });
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow") ?? "";
    expect(allow.includes("GET") && allow.includes("POST")).toBe(true);
  });

  it("404 on an unmatched path", async () => {
    expect((await hit("GET", "/nope", { headers: AUTH })).status).toBe(404);
  });
});
