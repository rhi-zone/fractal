// spike/std/client.test.ts — the meta-app + typed client + validation, end to
// end. Builds the SAME shape of app as app.ts but from the meta-carrying
// combinators (meta.ts), derives a typed client (client.ts), and runs real
// requests through the in-process transport. Type-level assertions (`satisfies`
// for positives, negative compile-error directives) prove body/param typing and
// that wrong calls don't compile.
//
// Run with: bun spike/std/client.test.ts

import {
  choice,
  methods,
  param,
  paramValue,
  path,
  validated,
  type StandardSchemaV1,
} from "./meta.ts";
import { client } from "./client.ts";
import { json, text, toFetch } from "./std.ts";

let passed = 0;
function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

// --- a hand-rolled Standard Schema fixture (rule 4: no concrete validator dep)
interface NewUser {
  readonly name: string;
}
const newUserSchema: StandardSchemaV1<unknown, NewUser> = {
  "~standard": {
    version: 1,
    vendor: "test-fixture",
    validate(v) {
      if (typeof v !== "object" || v === null || typeof (v as NewUser).name !== "string") {
        return { issues: [{ message: "name must be a string" }] };
      }
      return { value: { name: (v as NewUser).name } };
    },
  },
};

// --- in-memory data ---------------------------------------------------------
const users = [
  { id: "1", name: "ada" },
  { id: "2", name: "alan" },
];

// GET /users  +  POST /users (validated body)
const usersCollection = methods({
  GET: () => json(users),
  POST: validated<typeof newUserSchema, { created: true; name: string }>(
    newUserSchema,
    (value) => json({ created: true, name: value.name }, { status: 201 }),
  ),
});

// /users/{id} : GET the item. The id is read DIRECTLY off the request inside the
// GET handler (rule 4); `param` only advances the URL + records the position.
const userItem = param(
  "id",
  methods({
    // the id is read DIRECTLY off the Request (rule 4) via `paramValue`, where
    // `param` stashed it after advancing the URL past the segment (rule 5).
    GET: (req) => {
      const id = paramValue(req, "id");
      const user = users.find((u) => u.id === id);
      return user ? json(user) : json({ error: "no such user" }, { status: 404 });
    },
  }),
);

const usersResource = choice(usersCollection, userItem);

const health = methods({ GET: () => text("ok") });

const appMeta = path({
  users: usersResource,
  health,
});

const fetch = toFetch(appMeta);
const BASE = "http://x";

// ============================================================================
// RUNTIME assertions — the meta-app behaves byte-identically to app.ts's shape.
// ============================================================================
{
  const res = await fetch(new Request(BASE + "/users"));
  ok(res.status === 200, "GET /users -> 200");
  const body = (await res.json()) as unknown[];
  ok(Array.isArray(body) && body.length === 2, "GET /users -> 2 users");
}
{
  // POST with a VALID body → 201
  const res = await fetch(
    new Request(BASE + "/users", {
      method: "POST",
      body: JSON.stringify({ name: "grace" }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  ok(res.status === 201, "POST /users (valid) -> 201");
  const body = (await res.json()) as { created: boolean; name: string };
  ok(body.created === true && body.name === "grace", "POST /users -> created grace");
}
{
  // POST with an INVALID body → 400 from `validated`
  const res = await fetch(
    new Request(BASE + "/users", {
      method: "POST",
      body: JSON.stringify({ nope: 1 }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  ok(res.status === 400, "POST /users (invalid body) -> 400");
  const body = (await res.json()) as { error: string };
  ok(body.error === "VALIDATION", "POST /users invalid -> VALIDATION error");
}
{
  const res = await fetch(new Request(BASE + "/users/1"));
  ok(res.status === 200, "GET /users/1 -> 200 (param route)");
}
{
  const res = await fetch(new Request(BASE + "/health"));
  ok(res.status === 200 && (await res.text()) === "ok", "GET /health -> ok");
}
{
  const res = await fetch(new Request(BASE + "/users", { method: "DELETE" }));
  ok(res.status === 405, "DELETE /users -> 405 (405 still works under meta combinators)");
  const allow = res.headers.get("Allow") ?? "";
  ok(allow.includes("GET") && allow.includes("POST"), `405 Allow lists verbs (${allow})`);
}

// ============================================================================
// CLIENT runtime — derive a typed client and call it; in-process transport runs
// the SAME app handler, so results match the server exactly.
// ============================================================================
const api = client(appMeta);
{
  const list = (await api["/users"].get()) as typeof users;
  ok(Array.isArray(list) && list.length === 2, "client /users get() -> 2 users");
}
{
  const created = await api["/users"].post({ body: { name: "lin" } });
  ok(
    (created as { created: boolean; name: string }).name === "lin",
    "client /users post({body}) -> created lin",
  );
}
{
  const item = await api["/users/{id}"].get({ params: { id: "1" } });
  ok((item as { name: string }).name === "ada", "client /users/{id} get({params}) -> item");
}
{
  const h = (await api["/health"].get()) as string;
  ok(h === "ok", "client /health get() -> ok");
}

// ============================================================================
// TYPE-LEVEL assertions — prove the client surface is REAL, not `any`.
// `expectType`-style: `satisfies` for positives, `@ts-expect-error` for negatives.
// If a negative does NOT error, tsc reports TS2578 (unused @ts-expect-error) and
// the typecheck fails → the proof would be a no-op.
// ============================================================================
async function _typeChecks() {
  // (1) request body type is inferred FROM the validator (NewUser).
  const created = await api["/users"].post({ body: { name: "x" } });
  created satisfies { created: true; name: string };

  // @ts-expect-error — body must match the validator's output (name: string).
  await api["/users"].post({ body: { wrong: 1 } });

  // @ts-expect-error — body is REQUIRED on the validated POST.
  await api["/users"].post();

  // (2) path params are typed: id is a string, and required.
  const item = await api["/users/{id}"].get({ params: { id: "1" } });
  item satisfies unknown;

  // @ts-expect-error — params required for a {id} route.
  await api["/users/{id}"].get();

  // @ts-expect-error — wrong param key.
  await api["/users/{id}"].get({ params: { wrong: "1" } });

  // (3) unknown route key is a compile error.
  // @ts-expect-error — "/nope" is not a route in the app.
  await api["/nope"].get();

  // (4) GET takes no body arg.
  // @ts-expect-error — GET has no body.
  await api["/health"].get({ body: {} });
}
void _typeChecks;

console.log(`OK — ${passed} client/validation assertions passed`);
