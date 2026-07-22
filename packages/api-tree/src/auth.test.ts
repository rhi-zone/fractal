// packages/api-tree/src/auth.test.ts — auth adapter contract (./auth.ts)
//
// Proves the contract's two halves independently of any real provider
// (no OIDC/JWT involved — see @rhi-zone/fractal-auth-oidc for that):
//   - `authLayer`/`authMiddleware` against a fake `AuthAdapter`, wired into
//     `createFetch`'s `als`/`middleware` options exactly as a real provider
//     package would.
//   - `authExtension` against a fake `AuthClientAdapter`, wired into
//     `composeFetch` (the same runtime interpreter `createClient` uses).

import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "bun:test";
import { createFetch } from "@rhi-zone/fractal-http-api-projector/preset";
import { composeFetch } from "@rhi-zone/fractal-http-api-projector/extension";
import { api, op } from "./node.ts";
import { authExtension, authLayer, authMiddleware } from "./auth.ts";
import type { AuthAdapter, AuthClientAdapter } from "./auth.ts";

type User = { readonly id: string };

function bearerAdapter(): AuthAdapter<User> {
  return {
    resolve: async (req) => {
      const header = req.headers.get("Authorization");
      if (header === null || !header.startsWith("Bearer ")) return null;
      const token = header.slice("Bearer ".length);
      return token === "valid" ? { id: "user-1" } : null;
    },
    guard: (_req, user) => {
      if (user === null) return new Response("Unauthorized", { status: 401 });
      return undefined;
    },
  };
}

describe("authLayer", () => {
  it("resolves the user from the request into als.init", async () => {
    const adapter = bearerAdapter();
    const storage = new AsyncLocalStorage<User | null>();
    const tree = api({
      whoami: op((_: unknown) => ({ id: storage.getStore()?.id ?? null }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    });
    const fetchHandler = createFetch(tree, { als: { storage, init: authLayer(adapter) } });

    const authed = await fetchHandler(
      new Request("http://localhost/whoami", { headers: { Authorization: "Bearer valid" } }),
    );
    expect(await authed.json()).toEqual({ id: "user-1" });

    const anon = await fetchHandler(new Request("http://localhost/whoami"));
    expect(await anon.json()).toEqual({ id: null });
  });
});

describe("authMiddleware", () => {
  it("rejects with the guard's response when unauthenticated", async () => {
    const adapter = bearerAdapter();
    const storage = new AsyncLocalStorage<User | null>();
    const tree = api({
      secret: op((_: unknown) => ({ ok: true }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    });
    const fetchHandler = createFetch(tree, {
      als: { storage, init: authLayer(adapter) },
      middleware: [authMiddleware(adapter)],
    });

    const rejected = await fetchHandler(new Request("http://localhost/secret"));
    expect(rejected.status).toBe(401);

    const allowed = await fetchHandler(
      new Request("http://localhost/secret", { headers: { Authorization: "Bearer valid" } }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true });
  });

  it("is a no-op pass-through when the adapter has no guard", async () => {
    const adapter: AuthAdapter<User> = { resolve: async () => null };
    const middleware = authMiddleware(adapter);
    const inner = async () => new Response("ok");
    const wrapped = middleware(inner);
    const res = await wrapped(new Request("http://localhost/"));
    expect(await res.text()).toBe("ok");
  });
});

describe("authExtension", () => {
  it("injects the Authorization header from getToken", async () => {
    const seen: { auth: string | null } = { auth: null };
    const adapter: AuthClientAdapter = { getToken: async () => "abc123" };
    const base = async (req: Request): Promise<Response> => {
      seen.auth = req.headers.get("Authorization");
      return new Response("ok");
    };
    const wrapped = composeFetch(base, [authExtension(adapter)]);
    await wrapped(new Request("http://localhost/"));
    expect(seen.auth).toBe("Bearer abc123");
  });

  it("sends no Authorization header when getToken resolves null", async () => {
    const seen: { auth: string | null } = { auth: "unset" };
    const adapter: AuthClientAdapter = { getToken: async () => null };
    const base = async (req: Request): Promise<Response> => {
      seen.auth = req.headers.get("Authorization");
      return new Response("ok");
    };
    const wrapped = composeFetch(base, [authExtension(adapter)]);
    await wrapped(new Request("http://localhost/"));
    expect(seen.auth).toBeNull();
  });

  it("on 401, calls onUnauthorized and retries once with a fresh token", async () => {
    let token = "expired";
    let calls = 0;
    const adapter: AuthClientAdapter = {
      getToken: async () => token,
      onUnauthorized: async () => {
        token = "fresh";
        return true;
      },
    };
    const base = async (req: Request): Promise<Response> => {
      calls += 1;
      const auth = req.headers.get("Authorization");
      if (auth === "Bearer fresh") return new Response("ok", { status: 200 });
      return new Response("nope", { status: 401 });
    };
    const wrapped = composeFetch(base, [authExtension(adapter)]);
    const res = await wrapped(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("on 401 with onUnauthorized returning false, does not retry", async () => {
    let calls = 0;
    const adapter: AuthClientAdapter = {
      getToken: async () => "expired",
      onUnauthorized: async () => false,
    };
    const base = async (): Promise<Response> => {
      calls += 1;
      return new Response("nope", { status: 401 });
    };
    const wrapped = composeFetch(base, [authExtension(adapter)]);
    const res = await wrapped(new Request("http://localhost/"));
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });

  it("on 401 with no onUnauthorized hook, passes the 401 through unchanged", async () => {
    let calls = 0;
    const adapter: AuthClientAdapter = { getToken: async () => "expired" };
    const base = async (): Promise<Response> => {
      calls += 1;
      return new Response("nope", { status: 401 });
    };
    const wrapped = composeFetch(base, [authExtension(adapter)]);
    const res = await wrapped(new Request("http://localhost/"));
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });
});
