// packages/http/src/index.test.ts — @rhi-zone/fractal-http
//
// The WHATWG adapter kit: toFetch, response builders, validated. Builds an app
// from the core combinators, wraps it with toFetch, and runs real Requests.

import { describe, expect, it } from "bun:test";
import {
  choice,
  methods,
  param,
  paramValue,
  path,
  type StandardSchemaV1,
} from "@rhi-zone/fractal-core";
import {
  binary,
  json,
  notFound,
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

// type-level: an UNDISCHARGED param app is NOT a Handler<{}> root.
function _typeGuard() {
  const leaky = methods<{ id: string }>({
    GET: (req) => json(req.params.id),
  });
  // @ts-expect-error — undischarged {id} param is not a Handler<{}> root.
  toFetch(leaky);
  toFetch(param("id", leaky)); // discharged → compiles
}
void _typeGuard;
