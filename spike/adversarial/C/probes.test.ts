// Adversarial probes against the REAL core + http source.
// Run with: bun test spike/adversarial/C/probes.test.ts
import { test, expect } from "bun:test";
import {
  path,
  methods,
  choice,
  mount,
  param,
  paramValue,
  segments,
  withParams,
  type Handler,
} from "../../../packages/core/src/index.ts";
import { toFetch, json, text, validated } from "../../../packages/http/src/index.ts";

// A trivial Standard Schema that accepts any object.
const anySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "probe",
    validate: (value: unknown) => ({ value }),
  },
};

// ---------------------------------------------------------------------------
// 1. Param mutation leakage under choice retries.
// ---------------------------------------------------------------------------

test("1a. param-bound value does NOT leak into a sibling choice alt (passed alt)", async () => {
  // Alt A: param("id", ...) where the child PASSES (returns undefined) at a
  // sub-path that does not match. Alt B: a paramless handler at the SAME segment
  // count that reports whatever req.params.id it sees.
  const altA = param(
    "id",
    // child expects a further "details" segment; for /widgets/abc there is none,
    // so methods sees path consumed but maybe wrong verb -> we force a pass by
    // requiring a sub-segment that's absent => path returns undefined.
    path({ details: methods({ GET: () => text("A-details") }) }),
  );
  // altB reads params.id directly off the request it is handed.
  const altB: Handler = (req) =>
    text("B-saw-id:" + JSON.stringify((req as any).params?.id ?? null));

  const app = path({ widgets: choice(altA, altB) });
  const handler = toFetch(app as Handler<{}>);

  // /widgets/abc -> altA: param binds id=abc, advances URL to "/", then path
  // looks for "details" segment -> none -> undefined (pass). Falls to altB.
  const res = await handler(new Request("http://x/widgets/abc"));
  const body = await res.text();
  // CORRECT: altB should see id = null (param mutation must not leak across alts).
  expect(body).toBe("B-saw-id:null");
});

test("1b. param mutates a CLONE, not the shared request object", async () => {
  let outerParamsAfter: unknown = "UNSET";
  const inner = param("id", methods({ GET: (req) => text("id=" + (req as any).params.id) }));
  const probe: Handler = (req) => {
    // Run inner against this req, then inspect whether OUR req got mutated.
    return undefined; // never reached meaningfully; we test directly below
  };
  void probe;

  const req = withParams(new Request("http://x/abc"), {});
  const h = param("id", methods({ GET: (r) => text("inner-id=" + (r as any).params.id) }));
  await h(req);
  outerParamsAfter = (req as any).params;
  // CORRECT: the original req.params should still be {} (param worked on a clone).
  expect(outerParamsAfter).toEqual({});
});

test("1c. two param alts: first passes after binding, second sees its OWN binding", async () => {
  // altA: param("id") then a path that won't match -> pass.
  const altA = param("id", path({ never: methods({ GET: () => text("never") }) }));
  // altB: param("slug") then a terminal methods -> matches.
  const altB = param("slug", methods({ GET: (req) => text("slug=" + (req as any).params.slug + " id=" + JSON.stringify((req as any).params.id ?? null)) }));
  const app = path({ items: choice(altA, altB) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/items/xyz"));
  const body = await res.text();
  // CORRECT: slug=xyz id=null  (no leakage of altA's id binding)
  expect(body).toBe("slug=xyz id=null");
});

// ---------------------------------------------------------------------------
// 2. 405 Allow aggregation across choice.
// ---------------------------------------------------------------------------

test("2a. choice(methods{GET}, methods{POST}) at same path: PUT -> 405 Allow: GET, POST", async () => {
  const app = path({
    r: choice(
      methods({ GET: () => text("g") }),
      methods({ POST: () => text("p") }),
    ),
  });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/r", { method: "PUT" }));
  expect(res.status).toBe(405);
  // CORRECT: both verbs exist at this path -> Allow lists their UNION across the
  // choice alts, plus the auto-served HEAD (GET present) and OPTIONS.
  expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS, POST");
});

test("2b. choice short-circuit: first alt's 405 hides a later alt that WOULD match the method", async () => {
  // altA only knows GET. altB knows POST. Send POST.
  const app = path({
    r: choice(
      methods({ GET: () => text("g") }),
      methods({ POST: () => text("p") }),
    ),
  });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/r", { method: "POST" }));
  const body = res.status === 200 ? await res.text() : `status ${res.status}`;
  // CORRECT: POST should reach altB -> "p".
  expect(body).toBe("p");
});

// ---------------------------------------------------------------------------
// 3. Body re-read.
// ---------------------------------------------------------------------------

test("3a. validated then handler re-reads body", async () => {
  const h = validated(anySchema, async (value, req) => {
    // try to re-read the raw body
    try {
      const again = await req.json();
      return json({ value, again });
    } catch (e) {
      return json({ value, reread: "FAILED:" + (e as Error).name });
    }
  });
  const app = path({ r: methods({ POST: h }) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(
    new Request("http://x/r", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  const out = await res.json();
  // We just record what happens (consumed body).
  expect(out).toBeDefined();
  (globalThis as any).__reread = out;
});

test("3b. a validated alt that passes; a sibling alt then needs the body", async () => {
  // altA: validated, but fn returns undefined (pass) AFTER consuming body.
  const altA = methods({
    POST: validated(anySchema, () => undefined),
  });
  // altB: needs to read the body itself.
  const altB: Handler = async (req) => {
    try {
      const b = await req.json();
      return json({ altB: b });
    } catch (e) {
      return json({ altB: "FAILED:" + (e as Error).name });
    }
  };
  const app = path({ r: choice(altA, altB) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(
    new Request("http://x/r", {
      method: "POST",
      body: JSON.stringify({ x: 9 }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  const out = await res.json();
  (globalThis as any).__altBReread = out;
  // We assert what we OBSERVE; corrected after first run.
  expect(out).toBeDefined();
});

// ---------------------------------------------------------------------------
// 4. URL / param encoding.
// ---------------------------------------------------------------------------

test("4a. %2F in a param segment", async () => {
  const app = path({ f: param("name", methods({ GET: (req) => text((req as any).params.name) })) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/f/a%2Fb"));
  const body = await res.text();
  (globalThis as any).__pct2f = body;
  expect(body).toBeDefined();
});

test("4b. unicode param", async () => {
  const app = path({ f: param("name", methods({ GET: (req) => text((req as any).params.name) })) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/f/" + encodeURIComponent("héllo")));
  const body = await res.text();
  (globalThis as any).__unicode = body;
  expect(body).toBeDefined();
});

test("4c. plus sign in param", async () => {
  const app = path({ f: param("name", methods({ GET: (req) => text((req as any).params.name) })) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/f/a+b"));
  const body = await res.text();
  (globalThis as any).__plus = body;
  expect(body).toBeDefined();
});

test("4d. dotdot traversal segment", async () => {
  const app = path({ f: param("name", methods({ GET: (req) => text("name=" + (req as any).params.name) })) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/f/.."));
  const body = res.status === 200 ? await res.text() : "status " + res.status;
  (globalThis as any).__dotdot = body;
  expect(body).toBeDefined();
});

test("4e. encoded dotdot %2e%2e traversal", async () => {
  const app = path({ f: param("name", methods({ GET: (req) => text("name=" + (req as any).params.name) })) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/f/%2e%2e"));
  const body = res.status === 200 ? await res.text() : "status " + res.status;
  (globalThis as any).__encdotdot = body;
  expect(body).toBeDefined();
});

test("4f. empty param segment (double slash) /f//", async () => {
  const app = path({ f: param("name", methods({ GET: (req) => text("name=[" + (req as any).params.name + "]") })) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/f//rest"));
  const body = res.status === 200 ? await res.text() : "status " + res.status;
  (globalThis as any).__emptyseg = body;
  expect(body).toBeDefined();
});

// ---------------------------------------------------------------------------
// 5. Path normalization.
// ---------------------------------------------------------------------------

test("5a. trailing slash: /users/ vs /users", async () => {
  const app = path({ users: methods({ GET: () => text("users") }) });
  const handler = toFetch(app as Handler<{}>);
  const noSlash = await handler(new Request("http://x/users"));
  const slash = await handler(new Request("http://x/users/"));
  (globalThis as any).__trailing = {
    noSlash: noSlash.status,
    slash: slash.status,
  };
  expect(noSlash.status).toBe(200);
});

test("5b. double slash //users", async () => {
  const app = path({ users: methods({ GET: () => text("users") }) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x//users"));
  (globalThis as any).__doubleSlash = res.status;
  expect(res.status).toBeDefined();
});

test("5c. root /", async () => {
  const app = methods({ GET: () => text("root") });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/"));
  const body = res.status === 200 ? await res.text() : "status " + res.status;
  (globalThis as any).__root = body;
  expect(res.status).toBe(200);
});

// ---------------------------------------------------------------------------
// 6. auto-HEAD correctness + OPTIONS.
// ---------------------------------------------------------------------------

test("6a. HEAD returns GET status + headers, empty body", async () => {
  const app = path({
    r: methods({
      GET: () =>
        new Response("hello-body", {
          status: 201,
          headers: { "X-Custom": "yes", "Content-Type": "text/plain" },
        }),
    }),
  });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/r", { method: "HEAD" }));
  const body = await res.text();
  (globalThis as any).__head = {
    status: res.status,
    xcustom: res.headers.get("X-Custom"),
    ct: res.headers.get("Content-Type"),
    cl: res.headers.get("Content-Length"),
    body,
  };
  expect(res.status).toBe(201);
  expect(body).toBe("");
});

test("6b. OPTIONS returns 204 + Allow", async () => {
  const app = path({ r: methods({ GET: () => text("g"), POST: () => text("p") }) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/r", { method: "OPTIONS" }));
  (globalThis as any).__options = { status: res.status, allow: res.headers.get("Allow") };
  expect(res.status).toBe(204);
});

test("6c. OPTIONS Allow includes HEAD/OPTIONS implicitly available?", async () => {
  const app = path({ r: methods({ GET: () => text("g") }) });
  const handler = toFetch(app as Handler<{}>);
  const res = await handler(new Request("http://x/r", { method: "OPTIONS" }));
  (globalThis as any).__optionsHead = { allow: res.headers.get("Allow") };
  // GET implies HEAD is auto-served; does Allow advertise it? Record.
  expect(res.headers.get("Allow")).toBeDefined();
});

// ---------------------------------------------------------------------------
// 7. Method case / unknown methods.
// ---------------------------------------------------------------------------

test("7a. lowercase method 'get'", async () => {
  const app = path({ r: methods({ GET: () => text("g") }) });
  const handler = toFetch(app as Handler<{}>);
  // fetch Request normalizes some methods; check what happens.
  let res: Response;
  try {
    res = await handler(new Request("http://x/r", { method: "get" }));
  } catch (e) {
    (globalThis as any).__lower = "THREW:" + (e as Error).message;
    return;
  }
  const body = res.status === 200 ? await res.text() : "status " + res.status;
  (globalThis as any).__lower = { method: "get", status: res.status, body };
  expect(res.status).toBeDefined();
});

test("7b. custom method QUERY", async () => {
  const app = path({ r: methods({ GET: () => text("g") }) });
  const handler = toFetch(app as Handler<{}>);
  let res: Response;
  try {
    res = await handler(new Request("http://x/r", { method: "QUERY" }));
  } catch (e) {
    (globalThis as any).__query = "THREW:" + (e as Error).message;
    return;
  }
  (globalThis as any).__query = { status: res.status, allow: res.headers.get("Allow") };
  expect(res.status).toBeDefined();
});

// Dump collected observations at the end.
test("zz. dump observations", () => {
  const g = globalThis as any;
  console.log("=== OBSERVATIONS ===");
  for (const k of [
    "__reread", "__altBReread", "__pct2f", "__unicode", "__plus",
    "__dotdot", "__encdotdot", "__emptyseg", "__trailing", "__doubleSlash",
    "__root", "__head", "__options", "__optionsHead", "__lower", "__query",
  ]) {
    console.log(k, "=", JSON.stringify(g[k]));
  }
  expect(true).toBe(true);
});
