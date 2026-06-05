// packages/core/src/index.test.ts — the algebra, end to end. Builds an app from
// path/methods/choice/param, runs real Requests through it, and asserts status +
// body. Plus type-level proofs of the Handler<P> discharge model, and an
// ENFORCEMENT test (the iron rule) that scans ALL five packages' source and
// fails if any exported type declares a handler-shaped `(req: Request…) =>
// Response` call signature under a name other than the canonical `Handler`.

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  choice,
  methods,
  param,
  paramValue,
  path,
  provide,
  segments,
  rest,
  routeTable,
  withAuth,
  type Handler,
} from "./index.ts";

// --- a small worked app, composed entirely from the combinators -------------
const users = [
  { id: "1", name: "ada" },
  { id: "2", name: "alan" },
];

function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

const usersCollection = methods({
  GET: () => json(users),
  POST: () => json({ created: true }, { status: 201 }),
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

const usersResource = choice(usersCollection, userItem);
const health = methods({ GET: () => new Response("ok") });
const app = path({ users: usersResource, health });

// root adapter, inlined (toFetch lives in @rhi-zone/fractal-http).
const fetch = async (req: Request): Promise<Response> => {
  (req as Request & { ctx: {} }).ctx = {};
  return (
    (await (app as Handler<{}>)(req as Request & { ctx: {} })) ??
    new Response("Not Found", { status: 404 })
  );
};
const BASE = "http://x";
const hit = (p: string, method = "GET") => fetch(new Request(BASE + p, { method }));

describe("path/methods/choice/param dispatch", () => {
  it("GET /users -> collection", async () => {
    const res = await hit("/users");
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(2);
  });

  it("POST /users -> 201", async () => {
    const res = await hit("/users", "POST");
    expect(res.status).toBe(201);
  });

  it("GET /users/1 -> item (param route, id read off the Request)", async () => {
    const res = await hit("/users/1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("ada");
  });

  it("GET /health -> ok", async () => {
    expect(await (await hit("/health")).text()).toBe("ok");
  });

  it("unknown path -> 404", async () => {
    expect((await hit("/nope")).status).toBe(404);
  });

  // `methods` is PURE verb dispatch: a verb-miss is a PASS (undefined), NOT a
  // 405. The bare inline adapter here turns that pass into a 404. 405 / Allow /
  // auto-HEAD / OPTIONS are a PROJECTION computed by `toFetch` from `.meta` — see
  // those tests in @rhi-zone/fractal-http. This proves dispatch stays pure.
  it("known path wrong verb -> dispatch PASSES (undefined → bare-adapter 404)", async () => {
    const res = await hit("/users", "DELETE");
    expect(res.status).toBe(404);
  });

  it("HEAD is NOT auto-derived in bare dispatch (passes → 404)", async () => {
    const res = await hit("/users", "HEAD");
    expect(res.status).toBe(404);
  });

  it("OPTIONS is NOT synthesized in bare dispatch (passes → 404)", async () => {
    const res = await hit("/users", "OPTIONS");
    expect(res.status).toBe(404);
  });

  it("a verb explicitly in the table IS served directly by methods", async () => {
    const m = methods({ OPTIONS: () => new Response("custom-opts") });
    const req = new Request("http://x/", { method: "OPTIONS" }) as Request & {
      ctx: {};
    };
    req.ctx = {};
    const direct = await (m as Handler<{}>)(req);
    expect(await direct!.text()).toBe("custom-opts");
  });

  it("segments / rest helpers advance the URL", async () => {
    const r = new Request("http://x/a/b/c");
    expect(segments(r)).toEqual(["a", "b", "c"]);
    (r as Request & { ctx: {} }).ctx = {};
    expect(segments(rest(r as Request & { ctx: {} }))).toEqual(["b", "c"]);
  });
});

// ============================================================================
// provide / withAuth — context-producing middleware (ctx-discharge). Value is
// injected & readable typed; an auth-fail Response short-circuits; the injected
// var does NOT bleed across `choice` alts (fresh-ctx clone); and the VAR meta is
// invisible to the route table (no extra pattern / no path-param).
// ============================================================================
interface User {
  readonly id: string;
}

describe("provide / withAuth — ctx-discharge middleware", () => {
  const reqWithCtx = (url: string, init?: RequestInit) => {
    const r = new Request(url, init) as Request & { ctx: {} };
    r.ctx = {};
    return r;
  };

  it("provide injects a value that the inner handler reads typed", async () => {
    const h = provide(
      "tenant",
      () => "acme",
      methods({
        GET: (req: Request & { ctx: { tenant: string } }) =>
          json({ tenant: req.ctx.tenant }),
      }),
    ) as Handler<{}>;
    const res = await h(reqWithCtx("http://x/"));
    expect(res?.status).toBe(200);
    expect((await res!.json()) as { tenant: string }).toEqual({ tenant: "acme" });
  });

  it("provide returning a Response short-circuits (auth 401)", async () => {
    let innerRan = false;
    const h = provide(
      "user",
      () => new Response("nope", { status: 401 }),
      methods({
        GET: (req: Request & { ctx: { user: User } }) => {
          innerRan = true;
          return json(req.ctx.user);
        },
      }),
    ) as Handler<{}>;
    const res = await h(reqWithCtx("http://x/"));
    expect(res?.status).toBe(401);
    expect(innerRan).toBe(false);
  });

  it("provide returning undefined passes (not handled here)", async () => {
    const h = provide(
      "user",
      () => undefined,
      methods({
        GET: (req: Request & { ctx: { user: User } }) => json(req.ctx.user),
      }),
    ) as Handler<{}>;
    expect(await h(reqWithCtx("http://x/"))).toBeUndefined();
  });

  it("withAuth injects req.ctx.user typed and short-circuits on a Response", async () => {
    const authed = withAuth(
      (req): User | Response =>
        req.headers.get("authorization") === "Bearer ok"
          ? { id: "u1" }
          : new Response("unauthorized", { status: 401 }),
      methods({
        GET: (req: Request & { ctx: { user: User } }) => json(req.ctx.user),
      }),
    ) as Handler<{}>;

    const ok = await authed(reqWithCtx("http://x/", { headers: { authorization: "Bearer ok" } }));
    expect(ok?.status).toBe(200);
    expect((await ok!.json()) as User).toEqual({ id: "u1" });

    const bad = await authed(reqWithCtx("http://x/"));
    expect(bad?.status).toBe(401);
  });

  it("clone non-bleed under choice: a var injected in one alt does not leak to the next", async () => {
    // First alt provides `tag` then PASSES (its methods table has no matching verb
    // for the request), so `choice` falls to the second alt — which must see a ctx
    // WITHOUT `tag` (the provide cloned the request rather than mutating it).
    let secondSawTag: unknown = "UNSET";
    const first = provide(
      "tag",
      () => "leak",
      // GET-only; the request below is a POST, so this inner PASSES (undefined).
      methods({ GET: () => json({}) }),
    );
    const second = methods({
      POST: (req) => {
        secondSawTag = (req.ctx as Record<string, unknown>)["tag"];
        return json({ ok: true });
      },
    });
    const app = choice(first, second) as Handler<{}>;
    const res = await app(reqWithCtx("http://x/", { method: "POST" }));
    expect(res?.status).toBe(200);
    // The second alt's ctx must be the ORIGINAL `{}` — provide cloned, not mutated.
    expect(secondSawTag).toBeUndefined();
  });

  it("VAR meta is invisible to the route table (no extra pattern, no path-param)", () => {
    const plain = path({
      thing: methods({ GET: () => json({}) }),
    });
    const authed = path({
      thing: withAuth(
        (): User => ({ id: "x" }),
        methods({
          GET: (req: Request & { ctx: { user: User } }) => json(req.ctx.user),
        }),
      ),
    });
    // The flattened route tables must be IDENTICAL (same pattern, same verbs) —
    // the provide var contributes nothing to the path-param / pattern view.
    const norm = (h: { meta: unknown }) =>
      routeTable(h.meta).map((r) => ({
        pattern: r.pattern,
        verbs: [...r.verbs].sort(),
      }));
    expect(norm(authed)).toEqual(norm(plain));
  });
});

// ============================================================================
// TYPE-LEVEL proofs (compile-time only). A plain web handler IS a Handler; a
// typed ctx read is checked; an undischarged param/var does NOT type as a root.
// ============================================================================
function _typeProofs() {
  // a PLAIN web handler is assignable to Handler / Handler<{}> / Handler<{id}>.
  const list = (_req: Request): Response => json([]);
  const _p0: Handler = list;
  const _p1: Handler<{}> = list;
  const _p2: Handler<{ id: string }> = list;
  void _p0;
  void _p1;
  void _p2;

  // typed ctx read: req.ctx.id is string; a typo is a compile error.
  const user: Handler<{ id: string }> = (req) => json(req.ctx.id);
  const _userTypo: Handler<{ id: string }> = (req) =>
    // @ts-expect-error — `idd` is not a key of ctx; typed read catches it.
    json(req.ctx.idd);
  void user;
  void _userTypo;

  // compositional DISCHARGE: param("id", inner) discharges {id} → {}.
  // The {id} obligation is now EXTRACTED from the handler's declared ctx type
  // (no explicit `methods<{id:string}>` type-arg — that would erase the verbs).
  const inner = methods({
    GET: (req: Request & { ctx: { id: string } }) => json(req.ctx.id),
  });
  const _discharged: Handler<{}> = param("id", inner);
  void _discharged;

  // DISCHARGE via provide: a handler requiring `{ user }` becomes `Handler<{}>`
  // once wrapped — the var obligation is typed away.
  const needsUser = methods({
    GET: (req: Request & { ctx: { user: User } }) => json(req.ctx.user.id),
  });
  const _provideDischarged: Handler<{}> = provide(
    "user",
    (): User => ({ id: "1" }),
    needsUser,
  );
  void _provideDischarged;
  const _authDischarged: Handler<{}> = withAuth(
    (): User | Response => ({ id: "1" }),
    needsUser,
  );
  void _authDischarged;

  // ORDER both ways: param + withAuth compose, discharging BOTH keys.
  const needsBoth = methods({
    GET: (req: Request & { ctx: { id: string; user: User } }) =>
      json({ id: req.ctx.id, user: req.ctx.user }),
  });
  const _pa: Handler<{}> = param(
    "id",
    withAuth((): User | Response => ({ id: "1" }), needsBoth),
  );
  const _ap: Handler<{}> = withAuth(
    (): User | Response => ({ id: "1" }),
    param("id", needsBoth),
  );
  void _pa;
  void _ap;

  // a methods table value must be a Handler — a non-handler is rejected.
  const _guard = methods({
    // @ts-expect-error — a string is not a Handler.
    GET: "not a handler",
  });
  void _guard;
}
void _typeProofs;

// ============================================================================
// ENFORCEMENT — the IRON RULE, as a POSITIVE STRUCTURAL INVARIANT. The handler
// is the ONLY handler-shaped framework type. Scan EVERY package's source
// (core/http/client/openapi/codegen) and FAIL if any exported type alias or
// interface declares a HANDLER-SHAPED call signature — `(req: Request…) =>
// Response | …` — under any name OTHER than the canonical `Handler`.
//
// Why structural, not a name-blocklist: the old test scanned for the literal
// names Route/Segment/Router/Node/Ctx and was evadable by ANY differently-named
// rival framework type — `type Endpoint = (req: Request, ctx: unknown) =>
// Response` would sail through. A second handler-shaped type (a rival dispatch
// type, especially one with a `ctx` side-channel) is the actual failure mode the
// rule guards; this catches it regardless of what it is named. A planted
// `type Endpoint = (req: Request, …) => Response` MUST make this test fail.
// ============================================================================
describe("iron rule: Handler is the only handler-shaped framework type", () => {
  // ALL FIVE package src roots, relative to this file (packages/core/src).
  const PKG_SRC = [
    join(import.meta.dir, "..", "..", "core", "src"),
    join(import.meta.dir, "..", "..", "http", "src"),
    join(import.meta.dir, "..", "..", "client", "src"),
    join(import.meta.dir, "..", "..", "openapi", "src"),
    join(import.meta.dir, "..", "..", "codegen", "src"),
  ];

  /** Strip BOTH `//` line comments and `/* *​/` block comments (including
   *  multi-line ones) from a source string, so prose mentioning these shapes is
   *  not flagged. Block comments first (they can span lines), then line comments. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments (non-greedy, multi-line)
      .replace(/\/\/[^\n]*/g, ""); // line comments
  }

  // A RIVAL DISPATCH handler-shaped call signature. The canonical `Handler` and
  // the client `Transport` are both `(req: Request) => …Response…`; the rule must
  // catch a SECOND *dispatch* type without flagging those. A rival dispatch type
  // is distinguished by EITHER of two structural tells, both of which the planted
  // attacks exhibit and neither of which Handler/Transport do under another name:
  //
  //   (A) a SECOND PARAMETER after `req: Request` — the `ctx` side-channel
  //       (`(req: Request, ctx: …) => Response`). A handler with no ctx has one
  //       param; a dispatch type that smuggles state in a second arg is the
  //       forbidden shape. (The `Endpoint`/`Ctx` rivals are caught here.)
  //   (B) the DISPATCH PASS-PROTOCOL return `Response | …` (a UNION including
  //       `Response`, e.g. `Response | undefined`) — a renamed `Handler`. The
  //       client `Transport` returns a BARE `Promise<Response>` (no union), so it
  //       is not a dispatch type and is not flagged.
  //
  // Both regexes anchor on a first `req: Request` param; `[^=)]*` spans an
  // optional `& {…}` refinement without crossing into another param or the `=>`.
  const FIRST_REQ = String.raw`\(\s*_?\w+\s*:\s*Request\b[^=)]*`;
  // (A) a comma → a second parameter (the ctx side-channel) before `=>`.
  const CTX_SIDE_CHANNEL = new RegExp(FIRST_REQ + String.raw`,[^=]*=>[^;{]*\bResponse\b`);
  // (B) a `Response | …` UNION return (the pass protocol). `\|` before/after a
  //     `Response` token in the return position marks the union (vs bare Response).
  const PASS_PROTOCOL = new RegExp(
    FIRST_REQ + String.raw`\)\s*=>[^;{]*(?:\bResponse\b\s*\||\|\s*[^;{]*\bResponse\b)`,
  );
  const RIVAL_SHAPES: readonly [string, RegExp][] = [
    ["ctx side-channel (2nd param)", CTX_SIDE_CHANNEL],
    ["dispatch pass-protocol return (Response | …)", PASS_PROTOCOL],
  ];

  // An exported type alias / interface declaration; capture its name so a match
  // can be attributed and the canonical `Handler` can be exempted.
  const EXPORT_DECL = /\bexport\s+(?:type|interface)\s+(\w+)/g;

  function srcFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return srcFiles(full);
      if (!e.name.endsWith(".ts")) return [];
      if (e.name.endsWith(".test.ts")) return []; // skip the scanner / tests
      if (full.includes("/generated/")) return []; // skip generated files
      return [full];
    });
  }

  for (const root of PKG_SRC) {
    for (const file of srcFiles(root)) {
      const label = file.split("/packages/")[1] ?? file;
      it(`no rival handler-shaped type in ${label}`, () => {
        const code = stripComments(readFileSync(file, "utf8"));
        // Walk each exported type/interface decl; inspect the source slice from
        // its `=`/`{` up to the next top-level decl for a handler-shaped sig.
        const decls: { name: string; start: number }[] = [];
        for (const m of code.matchAll(EXPORT_DECL)) {
          decls.push({ name: m[1]!, start: m.index! });
        }
        for (let i = 0; i < decls.length; i++) {
          const { name, start } = decls[i]!;
          const end = decls[i + 1]?.start ?? code.length;
          const body = code.slice(start, end);
          if (name === "Handler") continue; // the one allowed bearer
          for (const [why, re] of RIVAL_SHAPES) {
            const hit = re.exec(body);
            expect(
              hit === null
                ? null
                : `rival handler-shaped type "${name}" [${why}] in ${label}: ${hit[0]
                    .replace(/\s+/g, " ")
                    .trim()}`,
            ).toBeNull();
          }
        }
      });
    }
  }
});
