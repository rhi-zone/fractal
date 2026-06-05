// packages/client/src/index.test.ts — @rhi-zone/fractal-client
//
// The typed client derived FLAT from `.meta`. Builds a meta-app from the core
// combinators, derives a typed client, and runs real requests through the
// in-process transport. Type-level assertions prove body/param typing and that
// wrong calls do not compile.

import { describe, expect, it } from "bun:test";
import {
  choice,
  methods,
  param,
  paramValue,
  path,
  type StandardSchemaV1,
} from "@rhi-zone/fractal-core";
import { json, text, toFetch, validated } from "@rhi-zone/fractal-http";
import { client, inProcess } from "./index.ts";

// --- a hand-rolled Standard Schema fixture ----------------------------------
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
  POST: validated<typeof newUserSchema, { created: true; name: string }>(
    newUserSchema,
    (value) => json({ created: true, name: value.name }, { status: 201 }),
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

const appMeta = path({
  users: choice(usersCollection, userItem),
  health: methods({ GET: () => text("ok") }),
});

describe("typed client over the meta-app — in-process", () => {
  const api = client(appMeta);

  it("GET /users -> 2 users", async () => {
    const list = (await api["/users"].get()) as typeof users;
    expect(Array.isArray(list) && list.length === 2).toBe(true);
  });

  it("POST /users with typed validated body -> created", async () => {
    const created = await api["/users"].post({ body: { name: "lin" } });
    expect((created as { name: string }).name).toBe("lin");
  });

  it("GET /users/{id} with typed params -> item", async () => {
    const item = await api["/users/{id}"].get({ params: { id: "1" } });
    expect((item as { name: string }).name).toBe("ada");
  });

  it("GET /health -> ok", async () => {
    expect(await api["/health"].get()).toBe("ok");
  });

  it("in-process equals a direct toFetch round-trip", async () => {
    const handle = toFetch(appMeta);
    const direct = await (await handle(new Request("http://x/users"))).json();
    const viaClient = await api["/users"].get();
    expect(viaClient).toEqual(direct);
  });

  it("client over an explicit inProcess transport works", async () => {
    const api2 = client(appMeta, inProcess(appMeta));
    expect(await api2["/health"].get()).toBe("ok");
  });
});

// ============================================================================
// TYPE-LEVEL assertions — prove the client surface is REAL, not `any`.
// `satisfies` for positives, `@ts-expect-error` for negatives. A non-firing
// negative is TS2578 (unused @ts-expect-error) → the typecheck fails.
// ============================================================================
async function _typeChecks() {
  const api = client(appMeta);

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
