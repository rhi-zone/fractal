// packages/http/src/index.test.ts — @rhi-zone/fractal-http
//
// The WHATWG adapter kit: toFetch, response builders, validated. Builds an app
// from the core combinators, wraps it with toFetch, and runs real Requests.

import { describe, expect, it } from "bun:test";
import {
  choice,
  methods,
  mount,
  param,
  paramValue,
  path,
  withAuth,
  type Handler,
  type StandardSchemaV1,
} from "@rhi-zone/fractal-core";
import {
  toOpenApi,
} from "@rhi-zone/fractal-openapi";
import {
  binary,
  cors,
  errorBoundary,
  json,
  logger,
  notFound,
  returns,
  sse,
  status,
  text,
  toFetch,
  validated,
} from "./index.ts";

// --- a hand-rolled Standard Schema fixture (types-only schema dep) ----------
interface NewUser {
  readonly name: string;
}
const newUserSchema: StandardSchemaV1<unknown, NewUser> = {
  "~standard": {
    version: 1,
    vendor: "test-fixture",
    validate(v) {
      if (
        typeof v !== "object" ||
        v === null ||
        typeof (v as NewUser).name !== "string"
      ) {
        return { issues: [{ message: "name must be a string" }] };
      }
      return { value: { name: (v as NewUser).name } };
    },
  },
};

const users = [
  { id: "1", name: "ada" },
  { id: "2", name: "alan" },
];

const usersCollection = methods({
  GET: () => json(users),
  POST: validated(newUserSchema, (value) =>
    json({ created: true, name: value.name }, { status: 201 }),
  ),
});

const userItem = param(
  "id",
  methods({
    GET: (req) => {
      const id = paramValue(req, "id");
      const user = users.find((u) => u.id === id);
      return user ? json(user) : json({ error: "no such user" }, { status: 404 });
    },
  }),
);

const tree = path({
  users: choice(usersCollection, userItem),
  health: methods({ GET: () => text("ok") }),
});

const fetch = toFetch(tree);
const BASE = "http://x";
const hit = (p: string, init?: RequestInit): Promise<Response> =>
  fetch(new Request(BASE + p, init));

describe("toFetch + response builders", () => {
  it("GET /users -> json collection", async () => {
    const res = await hit("/users");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(((await res.json()) as unknown[]).length).toBe(2);
  });

  it("GET /health -> text", async () => {
    const res = await hit("/health");
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("unknown path -> toFetch 404", async () => {
    expect((await hit("/nope")).status).toBe(404);
  });

  it("notFound builder -> 404", () => {
    expect(notFound().status).toBe(404);
  });

  it("status builder -> code + body", async () => {
    const res = status(201, { ok: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(status(204).status).toBe(204);
  });

  it("binary builder -> bytes + content-type", async () => {
    const res = binary(new Uint8Array([1, 2, 3]), "image/png");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(3);
  });

  it("sse builder -> text/event-stream chunks", async () => {
    const res = sse((emit) => {
      emit("connected", { ts: 0 });
      emit("done", { n: 1 });
    });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: connected");
    expect(body).toContain("event: done");
  });
});

// ===========================================================================
// HTTP CORRECTNESS — a PROJECTION computed by toFetch from .meta, NOT emitted by
// dispatch. `methods` passes on a verb-miss; toFetch turns the pass into 405 /
// Allow / auto-HEAD / OPTIONS / 404, aggregating verbs across choice & mount.
// ===========================================================================
describe("http correctness (toFetch projection from .meta)", () => {
  // single-table 405 + Allow
  it("known path, wrong verb -> 405 + Allow lists the table's verbs", async () => {
    const res = await hit("/users", { method: "DELETE" });
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow") ?? "";
    expect(allow.includes("GET")).toBe(true);
    expect(allow.includes("POST")).toBe(true);
  });

  // auto-HEAD: status + headers preserved, empty body
  it("auto-HEAD mirrors GET: status + headers preserved, empty body", async () => {
    const get = await hit("/users");
    const head = await hit("/users", { method: "HEAD" });
    expect(head.status).toBe(get.status);
    expect(head.headers.get("Content-Type")).toBe(get.headers.get("Content-Type"));
    expect(await head.text()).toBe("");
  });

  // OPTIONS 204 + Allow (includes HEAD when GET present, includes OPTIONS)
  it("OPTIONS -> 204 + Allow union (HEAD when GET present, OPTIONS always)", async () => {
    const res = await hit("/users", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    const allow = res.headers.get("Allow") ?? "";
    expect(allow).toBe("GET, HEAD, OPTIONS, POST");
  });

  // 404 vs 405 distinction
  it("unknown path -> 404 (path does not exist)", async () => {
    expect((await hit("/nope")).status).toBe(404);
  });
  it("unknown NESTED path -> 404, not 405", async () => {
    expect((await hit("/users/1/nope")).status).toBe(404);
  });
  it("known path, wrong verb -> 405, not 404", async () => {
    expect((await hit("/users", { method: "PATCH" })).status).toBe(405);
  });

  // param-route 405: DELETE on a GET-only /users/{id}
  it("param route, wrong verb -> 405 + Allow: GET", async () => {
    const res = await hit("/users/1", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  // method case: WHATWG `Request` normalizes the lowercase forms of the standard
  // verbs to uppercase, so `get` IS the GET verb and is served. (A non-standard
  // verb is NOT normalized — see the QUERY case below.)
  it("lowercase 'get' is normalized to GET by Request -> 200", async () => {
    const res = await hit("/health", { method: "get" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  // unknown methods at a known path -> 405
  it("unknown method QUERY at a known path -> 405 + Allow", async () => {
    const res = await hit("/health", { method: "QUERY" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});

// ===========================================================================
// REGRESSION — adversarial finding C-F1: correctness must compose across choice
// AND mount. A 405 must NOT short-circuit a later alt that DOES serve the verb,
// and Allow must be the UNION of verbs across every branch at the path.
// ===========================================================================
describe("regression: cross-choice / cross-mount correctness (C-F1)", () => {
  // choice(methods{GET}, methods{POST}) at the same path.
  const split = path({
    r: choice(
      methods({ GET: () => text("g") }),
      methods({ POST: () => text("p") }),
    ),
  });
  const splitFetch = toFetch(split as Handler<{}>);

  it("POST reaches the 2nd alt -> 200 (no 405 short-circuit)", async () => {
    const res = await splitFetch(new Request("http://x/r", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("p");
  });
  it("GET reaches the 1st alt -> 200", async () => {
    const res = await splitFetch(new Request("http://x/r"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("g");
  });
  it("PUT -> 405 with Allow aggregating BOTH alts' verbs", async () => {
    const res = await splitFetch(new Request("http://x/r", { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS, POST");
  });

  // two sub-routers mounted at the SAME path serving DIFFERENT verbs.
  const mountedA = mount("api", methods({ GET: () => text("ga") }));
  const mountedB = mount("api", methods({ POST: () => text("pb") }));
  const merged = choice(mountedA, mountedB);
  const mergedFetch = toFetch(merged as Handler<{}>);

  it("cross-mount: GET served by mount A", async () => {
    const res = await mergedFetch(new Request("http://x/api"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ga");
  });
  it("cross-mount: POST served by mount B (not short-circuited)", async () => {
    const res = await mergedFetch(new Request("http://x/api", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pb");
  });
  it("cross-mount: DELETE -> 405 with Allow unioning BOTH mounts' verbs", async () => {
    const res = await mergedFetch(new Request("http://x/api", { method: "DELETE" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS, POST");
  });
});

describe("validated body validation", () => {
  it("valid body -> handler runs (201)", async () => {
    const res = await hit("/users", {
      method: "POST",
      body: JSON.stringify({ name: "grace" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe("grace");
  });

  it("invalid body -> 400 VALIDATION", async () => {
    const res = await hit("/users", {
      method: "POST",
      body: JSON.stringify({ nope: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("VALIDATION");
  });

  it("malformed JSON -> 400 INVALID_JSON", async () => {
    const res = await hit("/users", {
      method: "POST",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("INVALID_JSON");
  });
});

describe("regression: sibling param routes with bodies (C-body-stream)", () => {
  // The NATURAL resource shape: several dynamic sibling routes share one `choice`,
  // each a `param("id", …)`. `param` matches ANY single segment, so the FIRST
  // sibling alt always advances past `:id` before its inner bails — and advancing
  // used to do `new Request(url, req)`, which CONSUMES/locks the source body
  // stream. When an earlier sibling READ the body and PASSED (returned undefined),
  // the next sibling's advance hit an already-used stream and threw "ReadableStream
  // has already been used" inside `withSegments`, so the matching leaf's `req.json()`
  // never ran. Fix: advancing TEES the body (`req.clone()`) instead of transferring
  // it, so any number of sibling alts can advance and the matching leaf still reads
  // the body exactly once. This block pins the natural shape end-to-end.

  // A schema fixture for a `{ contactName }` body.
  const bodySchema: StandardSchemaV1<unknown, { contactName: string }> = {
    "~standard": {
      version: 1,
      vendor: "test-fixture",
      validate(v) {
        if (
          typeof v !== "object" ||
          v === null ||
          typeof (v as { contactName?: unknown }).contactName !== "string"
        ) {
          return { issues: [{ message: "contactName must be a string" }] };
        }
        return { value: { contactName: (v as { contactName: string }).contactName } };
      },
    },
  };

  // The natural prospects tree: a GET/POST collection plus THREE sibling
  // `param("id", …)` alts — two behind a sub-path, one a bare item — exactly the
  // shape the dogfood example wanted but had to work around.
  const resource = path({
    prospects: choice(
      methods({
        GET: () => json(["a", "b"]),
        POST: validated(bodySchema, (v) => status(201, v)),
      }),
      // A bodied PATCH behind a sub-path. For a `/prospects/:id` request this alt
      // advances the `:id` segment, READS the body in `validated`, then PASSES
      // (the inner sub-path "status" is absent) — the precise condition that used
      // to lock the stream for the next sibling.
      param(
        "id",
        path({
          status: methods({
            PATCH: validated(bodySchema, (v, req) =>
              json({ id: paramValue(req, "id"), where: "status", ...v }),
            ),
          }),
        }),
      ),
      param(
        "id",
        path({
          assign: methods({
            POST: validated(bodySchema, (v, req) =>
              json({ id: paramValue(req, "id"), where: "assign", ...v }),
            ),
          }),
        }),
      ),
      // The bare item: GET one / bodied PATCH update / DELETE. This is the matching
      // leaf for `PATCH /prospects/:id` — it must still read the body after the
      // earlier sibling alts ran.
      param(
        "id",
        methods({
          GET: (req: Request & { ctx: { id: string } }) => json({ id: req.ctx.id }),
          PATCH: validated(bodySchema, (v, req) =>
            json({ id: paramValue(req, "id"), where: "item", ...v }),
          ),
          DELETE: () => status(204),
        }),
      ),
    ),
  });
  const run = toFetch(resource);
  const call = (p: string, init?: RequestInit): Promise<Response> =>
    run(new Request("http://x" + p, init));

  it("bodied PATCH on the bare item leaf parses, after sibling param alts ran", async () => {
    const res = await call("/prospects/42", {
      method: "PATCH",
      body: JSON.stringify({ contactName: "Ada" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42", where: "item", contactName: "Ada" });
  });

  it("bodied PATCH that DOES match a sub-path sibling still parses its body", async () => {
    const res = await call("/prospects/42/status", {
      method: "PATCH",
      body: JSON.stringify({ contactName: "Grace" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "42",
      where: "status",
      contactName: "Grace",
    });
  });

  it("a sibling GET still works (no body, no buffering needed)", async () => {
    const one = await call("/prospects/7", { method: "GET" });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ id: "7" });
    const list = await call("/prospects", { method: "GET" });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(["a", "b"]);
  });

  it("validated still rejects a bad body at the matching leaf (400)", async () => {
    const res = await call("/prospects/42", {
      method: "PATCH",
      body: JSON.stringify({ nope: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("VALIDATION");
  });

  it("404 for an unknown sub-path, 405 for an unsupported verb", async () => {
    const notFound = await call("/prospects/42/unknown", { method: "GET" });
    expect(notFound.status).toBe(404);
    const methodNotAllowed = await call("/prospects/42", { method: "PUT" });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("Allow")).toContain("PATCH");
  });

  it("clone-non-bleed: a passing param alt does not leak ctx into the next alt", async () => {
    // Two sibling param alts capture DIFFERENT key names. The first reads `req.ctx`
    // and passes; the second must see a ctx WITHOUT the first alt's bound key.
    let leaked: unknown = "unset";
    const probe = path({
      r: choice(
        // First alt binds `a`, inspects ctx, then PASSES (no matching sub-path).
        param("a", path({ never: methods({ GET: () => text("x") }) })),
        // Second alt binds `b`; its ctx must contain ONLY `b`, never `a`.
        param(
          "b",
          methods({
            GET: (req: Request & { ctx: { b: string } }) => {
              leaked = (req.ctx as Record<string, unknown>)["a"];
              return json({ b: req.ctx.b });
            },
          }),
        ),
      ),
    });
    const res = await toFetch(probe)(new Request("http://x/r/val", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ b: "val" });
    expect(leaked).toBeUndefined(); // the first alt's bound `a` did not bleed in
  });
});

// type-level: an UNDISCHARGED param app is NOT a Handler<{}> root.
function _typeGuard() {
  const leaky = methods({
    GET: (req: Request & { ctx: { id: string } }) => json(req.ctx.id),
  });
  // @ts-expect-error — undischarged {id} param is not a Handler<{}> root.
  toFetch(leaky);
  toFetch(param("id", leaky)); // discharged → compiles

  // type-level: an UNDISCHARGED VAR (req.ctx.user, no withAuth/provide) is also
  // NOT a Handler<{}> root — the SAME discharge invariant covers path params AND
  // injected vars uniformly.
  const needsUser = methods({
    GET: (req: Request & { ctx: { user: { id: string } } }) => json(req.ctx.user.id),
  });
  // @ts-expect-error — undischarged {user} var is not a Handler<{}> root.
  toFetch(needsUser);
  toFetch(
    withAuth(
      (): { id: string } | Response => ({ id: "1" }),
      needsUser,
    ),
  ); // discharged → compiles
}
void _typeGuard;

// ---------------------------------------------------------------------------
// Schema meta — validated / returns merge (not overwrite)
// ---------------------------------------------------------------------------

/** Minimal hand-rolled Standard Schema (no JSON-Schema trait; resolves to {} in
 *  OpenAPI, but the SchemaRef presence is what matters here). */
function makeSchema<T>(
  check: (v: unknown) => v is T,
  msg: string,
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "merge-test",
      validate: (v) =>
        check(v)
          ? { value: v }
          : { issues: [{ message: msg }] },
    },
  };
}

const bodySchema = makeSchema(
  (v): v is { name: string } =>
    typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string",
  "expected { name: string }",
);

const outputSchema = { type: "object", properties: { ok: { type: "boolean" } } };

type SchemasOf = { schemas?: Record<string, { input?: unknown; output?: unknown }> };

describe("validated + returns __schema merge", () => {
  it("validated then returns: both input and output survive in __schema", () => {
    const h = validated(bodySchema, (v) => json({ ok: true, name: v.name }));
    returns(h, outputSchema);
    const app = methods({ POST: h });
    const schemas = (app.meta as SchemasOf).schemas;
    expect(schemas?.["POST"]?.input).toBe(bodySchema);
    expect(schemas?.["POST"]?.output).toBe(outputSchema);
  });

  it("returns then validated: both input and output survive in __schema", () => {
    // validated() produces a ValidatedHandler; returns() wraps any Handler and
    // merges output into the existing __schema. Call returns after validated so
    // the output is stamped onto the validated handler's already-stamped input.
    const h = validated(bodySchema, (v) => json({ ok: true, name: v.name }));
    const h2 = returns(h, outputSchema);
    const app = methods({ POST: h2 });
    const schemas = (app.meta as SchemasOf).schemas;
    expect(schemas?.["POST"]?.input).toBe(bodySchema);
    expect(schemas?.["POST"]?.output).toBe(outputSchema);
  });

  it("validated then returns: toOpenApi emits requestBody AND response schema", () => {
    // Use a plain JSON-Schema-shaped object for the input schema so resolveSchema
    // picks it up without needing the JSON-Schema trait.
    const inputJsonSchema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
    const inputSchema: StandardSchemaV1<unknown, { title: string }> = {
      "~standard": {
        version: 1,
        vendor: "merge-test-openapi",
        validate: (v) => {
          if (typeof v === "object" && v !== null && typeof (v as { title?: unknown }).title === "string") {
            return { value: v as { title: string } };
          }
          return { issues: [{ message: "expected { title: string }" }] };
        },
      },
    };
    // Stamp the JSON-Schema property onto the ~standard interface so resolveSchema
    // can pick it up via the trait ladder. Cast through unknown to satisfy the
    // read-only standard interface.
    (inputSchema["~standard"] as unknown as Record<string, unknown>)["jsonSchema"] = {
      input: () => inputJsonSchema,
      output: () => inputJsonSchema,
    };

    const h = validated(inputSchema, (v) => json({ ok: true, title: v.title }));
    // Attach an output schema that looks like plain JSON Schema so toOpenApi resolves it.
    const h2 = returns(h, { type: "object", properties: { ok: { type: "boolean" } } });

    const app = methods({ POST: h2 });
    const doc = toOpenApi(app as unknown as Parameters<typeof toOpenApi>[0], { title: "t", version: "1" });
    const post = doc.paths["/"]?.post;
    // requestBody must be present (input schema was not clobbered)
    expect(post?.requestBody).toBeDefined();
    // response schema must be present (output schema was not clobbered)
    expect(post?.responses["200"]?.content?.["application/json"]?.schema).toBeDefined();
  });

  it("returns then validated: toOpenApi emits requestBody AND response schema", () => {
    // Same as above but stamp returns AFTER validated — the merge must work both ways.
    const inputSchema: StandardSchemaV1<unknown, { name: string }> = bodySchema;
    // Stamp JSON-Schema trait so the requestBody schema resolves to real JSON Schema.
    const inputJsonSchema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    (inputSchema["~standard"] as unknown as Record<string, unknown>)["jsonSchema"] = {
      input: () => inputJsonSchema,
      output: () => inputJsonSchema,
    };
    const h = validated(bodySchema, (_v, _req) => json({ done: true }));
    const h2 = returns(h, { type: "object", properties: { done: { type: "boolean" } } });

    const app = methods({ POST: h2 });
    const doc = toOpenApi(app as unknown as Parameters<typeof toOpenApi>[0], { title: "t", version: "1" });
    const post = doc.paths["/"]?.post;
    expect(post?.requestBody).toBeDefined();
    expect(post?.responses["200"]?.content?.["application/json"]?.schema).toBeDefined();
  });

  it("runtime dispatch is unchanged: validated still rejects bad input after returns", async () => {
    const h = validated(bodySchema, (v) => json({ ok: true, name: v.name }));
    returns(h, outputSchema);
    // Good body → 200
    const good = await h(
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ name: "ada" }),
        headers: { "Content-Type": "application/json" },
      }) as Request & { ctx: {} },
    );
    expect(good?.status).toBe(200);
    // Bad body → 400
    const bad = await h(
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify(42),
        headers: { "Content-Type": "application/json" },
      }) as Request & { ctx: {} },
    );
    expect(bad?.status).toBe(400);
  });
});

// ===========================================================================
// OBSERVING MIDDLEWARE — logger / cors / errorBoundary. Pure Handler<R> →
// Handler<R> wrappers: no ctx change, no discharge, and META is PRESERVED so the
// projections still see the routes through the wrapper.
// ===========================================================================
describe("observing middleware (logger / cors / errorBoundary)", () => {
  it("logger logs METHOD /path -> status and passes the response through", async () => {
    const lines: string[] = [];
    const wrapped = logger(
      path({ ping: methods({ GET: () => text("pong") }) }),
      (l) => lines.push(l),
    );
    const fetch = toFetch(wrapped as Handler<{}>);
    const res = await fetch(new Request("http://x/ping"));
    expect(await res.text()).toBe("pong");
    expect(lines.some((l) => l.includes("GET /ping -> 200"))).toBe(true);
  });

  it("logger PRESERVES .meta so toFetch projects 405/Allow through it", async () => {
    const wrapped = logger(path({ ping: methods({ GET: () => text("p") }) }), () => {});
    const fetch = toFetch(wrapped as Handler<{}>);
    const res = await fetch(new Request("http://x/ping", { method: "DELETE" }));
    expect(res.status).toBe(405); // requires .meta to have survived the wrapper
  });

  it("cors adds CORS headers to the response and answers preflight with 204", async () => {
    const wrapped = cors({ origin: "https://app.example" })(
      path({ data: methods({ GET: () => json({ ok: true }) }) }),
    );
    const fetch = toFetch(wrapped as Handler<{}>);
    const get = await fetch(new Request("http://x/data"));
    expect(get.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    const pre = await fetch(new Request("http://x/data", { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("errorBoundary turns a thrown error into a 500 (default render)", async () => {
    const boom = methods({
      GET: () => {
        throw new Error("kaboom");
      },
    });
    const wrapped = errorBoundary()(path({ boom }) as Handler<{}>);
    const fetch = toFetch(wrapped as Handler<{}>);
    const res = await fetch(new Request("http://x/boom"));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("INTERNAL");
  });
});
