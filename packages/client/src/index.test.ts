// packages/client/src/index.test.ts — @rhi-zone/fractal-client
//
// The client RUNTIME: the transports the generated client dispatches through.
// (The typed client surface itself is owned by @rhi-zone/fractal-codegen and is
// tested there, end-to-end over `inProcess`. This package only owns the runtime.)

import { describe, expect, it } from "bun:test";
import { choice, methods, param, paramValue, path } from "@rhi-zone/fractal-core";
import { json, text, toFetch } from "@rhi-zone/fractal-http";
import { http, inProcess } from "./index.ts";

const users = [
  { id: "1", name: "ada" },
  { id: "2", name: "alan" },
];

const app = path({
  users: choice(
    methods({ GET: () => json(users) }),
    param(
      "id",
      methods({
        GET: (req) => {
          const id = paramValue(req, "id");
          const user = users.find((u) => u.id === id);
          return user ? json(user) : json({ error: "no such user" }, { status: 404 });
        },
      }),
    ),
  ),
  health: methods({ GET: () => text("ok") }),
});

describe("inProcess transport", () => {
  const transport = inProcess(app);

  it("dispatches a GET through the SAME app handler in memory", async () => {
    const res = await transport(new Request("http://local/users"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(users);
  });

  it("resolves a typed param route", async () => {
    const res = await transport(new Request("http://local/users/1"));
    expect(await res.json()).toEqual({ id: "1", name: "ada" });
  });

  it("a final undefined (no route) becomes a 404 (mirrors toFetch)", async () => {
    const res = await transport(new Request("http://local/nope"));
    expect(res.status).toBe(404);
  });

  it("equals a direct toFetch round-trip (server-identical)", async () => {
    const handle = toFetch(app);
    const direct = await (await handle(new Request("http://x/users"))).json();
    const viaTransport = await (
      await transport(new Request("http://local/users"))
    ).json();
    expect(viaTransport).toEqual(direct);
  });
});

describe("http transport", () => {
  it("issues a fetch to baseUrl + path (+ search), forwarding the request", async () => {
    let seen: string | undefined;
    const fakeFetch = (async (input: RequestInfo | URL) => {
      seen = String(input);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const transport = http("http://example.test/", fakeFetch);
    await transport(new Request("http://local/users?q=1"));
    expect(seen).toBe("http://example.test/users?q=1");
  });
});
