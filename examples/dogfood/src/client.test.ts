// examples/dogfood/src/client.test.ts
//
// The GENERATED typed client (codegen, from `app`) exercised IN-PROCESS, proving
// the generated types are correct and results match a direct toFetch round-trip.
//
// The whole resource is behind `withAuth`, so the in-process transport must carry
// a Bearer token — we wrap `inProcess(app)` to inject the Authorization header.
// NB (finding): the generated client signature has NO place to pass auth (it is a
// server-internal `provide` var), so threading credentials is a TRANSPORT concern
// the codegen client does not surface — see the findings report.

import { inProcess, type Transport } from "@rhi-zone/fractal-client";
import { beforeEach, describe, expect, it } from "bun:test";
import { app, handle, type Prospect } from "./app.ts";
import { reset } from "./domain.ts";
import { createClient } from "./generated/client.ts";

/** in-process transport that injects a Bearer token (the auth the app requires).
 *  Reads the body to a buffer and rebuilds the Request so the injected-header
 *  clone does not consume a shared stream (the param/provide clones re-reference
 *  the body downstream). */
function authed(token: string): Transport {
  const base = inProcess(app);
  return async (req) => {
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${token}`);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = hasBody ? await req.text() : undefined;
    const r = new Request(req.url, {
      method: req.method,
      headers,
      ...(body !== undefined && body !== "" ? { body } : {}),
    });
    return base(r);
  };
}

const client = () => createClient(app, authed("admin"));

beforeEach(() => reset());

describe("generated typed client over the prospects app — in-process", () => {
  it("POST then GET returns the created prospect (typed end-to-end)", async () => {
    const c = client();
    const created = await c["/prospects"].post({
      body: { contactName: "client-made", source: "api" },
    });
    expect(created.contactName).toBe("client-made");

    const list = await c["/prospects"].get();
    expect(list.some((p) => p.id === created.id)).toBe(true);
  });

  it("typed path param flows into GET /prospects/{id}", async () => {
    const c = client();
    const created = await c["/prospects"].post({ body: { contactName: "x", source: "api" } });
    const one = await c["/prospects/{id}"].get({ params: { id: created.id } });
    expect(one.contactName).toBe("x");
  });

  it("typed param + body flows into PATCH /prospects/{id}/status", async () => {
    const c = client();
    const created = await c["/prospects"].post({ body: { contactName: "y", source: "api" } });
    const res = await c["/prospects/{id}/status"].patch({
      params: { id: created.id },
      body: { status: "qualified" },
    });
    expect(res.status).toBe("qualified");
  });

  it("typed param + body flows into POST /prospects/{id}/assign (orchestration)", async () => {
    const c = client();
    const created = await c["/prospects"].post({ body: { contactName: "z", source: "api" } });
    const assigned = await c["/prospects/{id}/assign"].post({
      params: { id: created.id },
      body: { userId: "alice" },
    });
    expect(assigned.assignedToUserId).toBe("alice");
  });

  it("in-process equals a direct toFetch round-trip", async () => {
    const c = client();
    await c["/prospects"].post({ body: { contactName: "dup", source: "api" } });
    const viaClient = await c["/prospects"].get();
    const direct = await (
      await handle(
        new Request("http://x/prospects", { headers: { authorization: "Bearer admin" } }),
      )
    ).json();
    expect(viaClient).toEqual(direct);
  });
});

// Type-level: the response is typed as the prospect shape (a Prospect-ish object),
// not `unknown`. (`Prospect` import keeps the type referenced.)
const _typecheck: Prospect | undefined = undefined;
void _typecheck;
