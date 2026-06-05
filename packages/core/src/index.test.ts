// packages/core/src/index.test.ts — the algebra, end to end. Builds an app from
// path/methods/choice/param, runs real Requests through it, and asserts status +
// body. Plus type-level proofs of the Handler<P> discharge model, and an
// ENFORCEMENT test that fails if a Route/Segment/Router/Node type is declared in
// any package's source (the iron rule).

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  choice,
  methods,
  param,
  paramValue,
  path,
  segments,
  rest,
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
  (req as Request & { params: {} }).params = {};
  return (
    (await (app as Handler<{}>)(req as Request & { params: {} })) ??
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
      params: {};
    };
    req.params = {};
    const direct = await (m as Handler<{}>)(req);
    expect(await direct!.text()).toBe("custom-opts");
  });

  it("segments / rest helpers advance the URL", async () => {
    const r = new Request("http://x/a/b/c");
    expect(segments(r)).toEqual(["a", "b", "c"]);
    (r as Request & { params: {} }).params = {};
    expect(segments(rest(r as Request & { params: {} }))).toEqual(["b", "c"]);
  });
});

// ============================================================================
// TYPE-LEVEL proofs (compile-time only). A plain web handler IS a Handler; a
// typed param read is checked; an undischarged param does NOT type as a root.
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

  // typed param read: req.params.id is string; a typo is a compile error.
  const user: Handler<{ id: string }> = (req) => json(req.params.id);
  const _userTypo: Handler<{ id: string }> = (req) =>
    // @ts-expect-error — `idd` is not a key of params; typed read catches it.
    json(req.params.idd);
  void user;
  void _userTypo;

  // compositional DISCHARGE: param("id", inner) discharges {id} → {}.
  // The {id} obligation is now EXTRACTED from the handler's declared param type
  // (no explicit `methods<{id:string}>` type-arg — that would erase the verbs).
  const inner = methods({
    GET: (req: Request & { params: { id: string } }) => json(req.params.id),
  });
  const _discharged: Handler<{}> = param("id", inner);
  void _discharged;

  // a methods table value must be a Handler — a non-handler is rejected.
  const _guard = methods({
    // @ts-expect-error — a string is not a Handler.
    GET: "not a handler",
  });
  void _guard;
}
void _typeProofs;

// ============================================================================
// ENFORCEMENT — the IRON RULE. Scan every package's tracked SOURCE for a
// declaration of a forbidden framework type (Route / Segment / Router / Node /
// Ctx / RoutingCtx). The ONLY framework type is `Handler`. A planted
// `type Route = …` MUST make this test fail.
// ============================================================================
describe("iron rule: no Route/Segment/Router/Node type declarations", () => {
  // package src roots, relative to this file (packages/core/src).
  const PKG_SRC = [
    join(import.meta.dir, "..", "..", "core", "src"),
    join(import.meta.dir, "..", "..", "http", "src"),
    join(import.meta.dir, "..", "..", "client", "src"),
  ];

  // a declaration of a forbidden NAME as a type/interface/class/enum. Exact
  // identifier following the keyword, word-boundaried — so `ParamMeta`,
  // `MethodsMeta`, etc. are NOT matched; only an EXACT forbidden identifier.
  const FORBIDDEN = ["Route", "Segment", "Router", "Node", "Ctx", "RoutingCtx"];
  const decl = new RegExp(
    `\\b(?:type|interface|class|enum)\\s+(${FORBIDDEN.join("|")})\\b`,
  );

  function srcFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return srcFiles(full);
      if (!e.name.endsWith(".ts")) return [];
      if (e.name.endsWith(".test.ts")) return []; // skip the scanner / tests
      return [full];
    });
  }

  for (const root of PKG_SRC) {
    for (const file of srcFiles(root)) {
      const label = file.split("/packages/")[1] ?? file;
      it(`no forbidden type declaration in ${label}`, () => {
        const src = readFileSync(file, "utf8");
        for (const line of src.split("\n")) {
          // strip line comments so doc text mentioning the names is allowed.
          const code = line.replace(/\/\/.*$/, "");
          const m = decl.exec(code);
          expect(m === null ? null : `${m[1]} :: ${line.trim()}`).toBeNull();
        }
      });
    }
  }
});
