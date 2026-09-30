import { describe, expect, test } from "bun:test";
import { toOpenApi } from "@rhi-zone/fractal-http-api-projector";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { types } from "@rhi-zone/fractal-type-ir";
import type { SmithyMember, SmithyModel } from "@rhi-zone/fractal-type-ir/from-smithy";
import { addressKey } from "./api-description.ts";
import { fromSmithyModel } from "./from-smithy.ts";
import { lower, nameKeys, routeKeys, schemaMap } from "./lower.ts";

const P = "smithy.api#";
const NS = "example.weather#";
const m = (target: string, traits: Record<string, unknown> = {}): SmithyMember => ({
  target,
  traits,
});
const required = { [`${P}required`]: {} };
const unit = { target: `${P}Unit` };

// The weather service from the Smithy quick start, plus a create/delete pair
// and an event stream so each mapping has a case.
const weather: SmithyModel = {
  smithy: "2.0",
  metadata: { suppressions: [] },
  shapes: {
    [`${NS}Weather`]: {
      type: "service",
      version: "2006-03-01",
      resources: [{ target: `${NS}City` }],
      operations: [{ target: `${NS}GetCurrentTime` }, { target: `${NS}SubscribeAlerts` }],
      traits: {
        [`${P}title`]: "Weather Service",
        [`${P}documentation`]: "Provides weather forecasts.",
        [`${P}paginated`]: {
          inputToken: "nextToken",
          outputToken: "nextToken",
          pageSize: "pageSize",
        },
        "aws.protocols#restJson1": {},
      },
    },
    [`${NS}City`]: {
      type: "resource",
      identifiers: { cityId: { target: `${NS}CityId` } },
      create: { target: `${NS}CreateCity` },
      read: { target: `${NS}GetCity` },
      delete: { target: `${NS}DeleteCity` },
      list: { target: `${NS}ListCities` },
      resources: [{ target: `${NS}Forecast` }],
      traits: { [`${P}documentation`]: "A city." },
    },
    [`${NS}Forecast`]: {
      type: "resource",
      identifiers: { cityId: { target: `${NS}CityId` } },
      read: { target: `${NS}GetForecast` },
    },
    [`${NS}CityId`]: { type: "string", traits: { [`${P}pattern`]: "^[A-Za-z0-9 ]+$" } },
    [`${NS}CityCoordinates`]: {
      type: "structure",
      members: {
        latitude: m(`${P}Float`, required),
        longitude: m(`${P}Float`, required),
      },
    },
    [`${NS}CitySummary`]: {
      type: "structure",
      members: {
        cityId: m(`${NS}CityId`, required),
        name: m(`${P}String`, required),
      },
    },
    [`${NS}CitySummaries`]: { type: "list", member: m(`${NS}CitySummary`) },
    [`${NS}NoSuchResource`]: {
      type: "structure",
      traits: { [`${P}error`]: "client" },
      members: { resourceType: m(`${P}String`, required) },
    },

    [`${NS}GetCity`]: {
      type: "operation",
      input: { target: `${NS}GetCityInput` },
      output: { target: `${NS}GetCityOutput` },
      errors: [{ target: `${NS}NoSuchResource` }],
      traits: {
        [`${P}readonly`]: {},
        [`${P}documentation`]: "Returns a city.",
        [`${P}http`]: { method: "GET", uri: "/city/{cityId}" },
        [`${P}tags`]: ["cities"],
      },
    },
    [`${NS}GetCityInput`]: {
      type: "structure",
      traits: { [`${P}input`]: {} },
      members: { cityId: m(`${NS}CityId`, { ...required, [`${P}httpLabel`]: {} }) },
    },
    [`${NS}GetCityOutput`]: {
      type: "structure",
      traits: { [`${P}output`]: {} },
      members: {
        name: m(`${P}String`, required),
        coordinates: m(`${NS}CityCoordinates`, required),
      },
    },

    [`${NS}CreateCity`]: {
      type: "operation",
      input: { target: `${NS}CreateCityInput` },
      output: { target: `${NS}GetCityOutput` },
      traits: { [`${P}http`]: { method: "POST", uri: "/city", code: 201 } },
    },
    [`${NS}CreateCityInput`]: {
      type: "structure",
      members: {
        name: m(`${P}String`, required),
        coordinates: m(`${NS}CityCoordinates`, { [`${P}jsonName`]: "coords" }),
        traceId: m(`${P}String`, { [`${P}httpHeader`]: "X-Trace-Id" }),
      },
    },

    [`${NS}DeleteCity`]: {
      type: "operation",
      input: { target: `${NS}GetCityInput` },
      output: unit,
      traits: {
        [`${P}idempotent`]: {},
        [`${P}deprecated`]: { message: "cities are forever", since: "2020" },
        [`${P}http`]: { method: "DELETE", uri: "/city/{cityId}" },
      },
    },

    [`${NS}ListCities`]: {
      type: "operation",
      input: { target: `${NS}ListCitiesInput` },
      output: { target: `${NS}ListCitiesOutput` },
      traits: {
        [`${P}readonly`]: {},
        [`${P}paginated`]: { items: "items" },
        [`${P}http`]: { method: "GET", uri: "/cities" },
      },
    },
    [`${NS}ListCitiesInput`]: {
      type: "structure",
      members: {
        nextToken: m(`${P}String`, { [`${P}httpQuery`]: "nextToken" }),
        pageSize: m(`${P}Integer`, { [`${P}httpQuery`]: "size" }),
      },
    },
    [`${NS}ListCitiesOutput`]: {
      type: "structure",
      members: {
        nextToken: m(`${P}String`),
        items: m(`${NS}CitySummaries`, required),
      },
    },

    [`${NS}GetForecast`]: {
      type: "operation",
      input: { target: `${NS}GetCityInput` },
      output: { target: `${NS}GetForecastOutput` },
      traits: {
        [`${P}readonly`]: {},
        [`${P}http`]: { method: "GET", uri: "/city/{cityId}/forecast" },
      },
    },
    [`${NS}GetForecastOutput`]: {
      type: "structure",
      members: { chanceOfRain: m(`${P}Float`) },
    },

    [`${NS}GetCurrentTime`]: {
      type: "operation",
      input: unit,
      output: { target: `${NS}GetCurrentTimeOutput` },
      traits: {
        [`${P}readonly`]: {},
        [`${P}http`]: { method: "GET", uri: "/current-time" },
      },
    },
    [`${NS}GetCurrentTimeOutput`]: {
      type: "structure",
      members: { time: m(`${P}Timestamp`, required) },
    },

    [`${NS}SubscribeAlerts`]: {
      type: "operation",
      input: unit,
      output: { target: `${NS}SubscribeAlertsOutput` },
      traits: { [`${P}readonly`]: {} },
    },
    [`${NS}SubscribeAlertsOutput`]: {
      type: "structure",
      members: { alerts: m(`${NS}AlertEvents`, required) },
    },
    [`${NS}AlertEvents`]: {
      type: "union",
      traits: { [`${P}streaming`]: {} },
      members: {
        rain: m(`${NS}CityId`),
        heat: m(`${P}Float`),
      },
    },
  },
};

const addrs = (ops: readonly { readonly address: Parameters<typeof addressKey>[0] }[]): string[] =>
  ops.map((o) => addressKey(o.address));

describe("fromSmithyModel: addressing", () => {
  const { api } = fromSmithyModel(weather);

  test("resources group operations; identifiers are param segments", () => {
    expect(addrs(api.operations).sort()).toEqual(
      [
        "getCurrentTime",
        "subscribeAlerts",
        "city/create",
        "city/{cityId}/read",
        "city/{cityId}/delete",
        "city/list",
        "city/{cityId}/forecast/read",
      ].sort(),
    );
  });

  test("groups carry resource and service info", () => {
    const at = (a: string) => api.groups.find((g) => addressKey(g.address) === a)!;
    expect(at("").meta.description).toBe("Provides weather forecasts.");
    expect(at("").meta.smithy).toMatchObject({
      id: "example.weather#Weather",
      version: "2006-03-01",
      modelVersion: "2.0",
      metadata: { suppressions: [] },
      traits: { [`${P}title`]: "Weather Service", "aws.protocols#restJson1": {} },
    });
    expect(at("city").meta.description).toBe("A city.");
    expect(at("city").meta.smithy).toMatchObject({
      id: "example.weather#City",
      identifiers: { cityId: "example.weather#CityId" },
    });
  });

  test("the api description is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(api))).toEqual(api);
  });
});

describe("fromSmithyModel: types", () => {
  const { api } = fromSmithyModel(weather);
  const op = (a: string) => api.operations.find((o) => addressKey(o.address) === a)!;

  test("input is the input structure's members as named params", () => {
    const input = op("city/{cityId}/read").input;
    const fields = (input.shape as { fields: Record<string, { shape: unknown; meta: unknown }> })
      .fields;
    expect(Object.keys(fields)).toEqual(["cityId"]);
    expect(fields.cityId!.shape).toEqual(types.ref("CityId"));
    expect(fields.cityId!.meta).toEqual({
      smithy: { traits: { [`${P}httpLabel`]: {} } },
    });
    expect(op("getCurrentTime").input.shape).toEqual(types.object({}));
  });

  test("output is a ref to the output structure; Unit is void", () => {
    expect(op("city/{cityId}/read").output!.shape).toEqual(types.ref("GetCityOutput"));
    expect(op("city/{cityId}/delete").output!.shape.kind).toBe("void");
    expect(api.defs.GetCityOutput).toBeDefined();
    expect(api.defs.CityId!.meta.pattern).toBe("^[A-Za-z0-9 ]+$");
  });

  test("a paginated list output becomes a cursor page of the items", () => {
    const out = op("city/list").output!;
    expect(out.shape.kind).toBe("page");
    expect(out.shape).toMatchObject({
      style: "cursor",
      element: { shape: types.ref("CitySummary") },
    });
  });

  test("an event stream that is the whole output becomes a stream", () => {
    const out = op("subscribeAlerts").output!;
    expect(out.shape).toEqual(types.stream({ shape: types.ref("AlertEvents"), meta: {} }));
    expect(out.meta.optional).toBeUndefined();
  });
});

describe("fromSmithyModel: metadata", () => {
  const { api } = fromSmithyModel(weather);
  const op = (a: string) => api.operations.find((o) => addressKey(o.address) === a)!;

  test("traits map to tags, description and openapi", () => {
    const get = op("city/{cityId}/read");
    expect(get.meta.tags).toEqual({ readOnly: true });
    expect(get.meta.description).toBe("Returns a city.");
    expect(get.meta.openapi).toEqual({ operationId: "GetCity", tags: ["cities"] });
    const del = op("city/{cityId}/delete");
    expect(del.meta.tags).toEqual({ idempotent: true, deprecated: true });
    expect((del.meta.smithy as { deprecated: unknown }).deprecated).toEqual({
      message: "cities are forever",
      since: "2020",
    });
    expect(op("subscribeAlerts").meta.tags).toEqual({ readOnly: true, streaming: true });
  });

  test("paginated merges service defaults under the operation's", () => {
    expect((op("city/list").meta.smithy as { paginated: unknown }).paginated).toEqual({
      inputToken: "nextToken",
      outputToken: "nextToken",
      pageSize: "pageSize",
      items: "items",
    });
  });

  test("errors are kept as ids", () => {
    expect((op("city/{cityId}/read").meta.smithy as { errors: unknown }).errors).toEqual([
      "example.weather#NoSuchResource",
    ]);
    expect(api.defs.NoSuchResource!.meta.smithy).toMatchObject({
      traits: { [`${P}error`]: "client" },
    });
  });
});

describe("fromSmithyModel: http", () => {
  const { api, diagnostics } = fromSmithyModel(weather);
  const op = (a: string) => api.operations.find((o) => addressKey(o.address) === a)!;

  test("an address that mirrors the uri gets an exact binding", () => {
    expect(op("city/{cityId}/read").meta.http).toEqual({
      method: "GET",
      moveTo: "..",
      sourceMap: { cityId: { store: "path" } },
    });
    expect(op("city/{cityId}/forecast/read").meta.http).toMatchObject({ method: "GET" });
  });

  test("body members use jsonName, headers their header name; a non-200 code is kept", () => {
    const create = op("city/create");
    expect(create.meta.http).toEqual({
      method: "POST",
      moveTo: "..",
      sourceMap: {
        name: { store: "body" },
        coordinates: { store: "body", key: "coords" },
        traceId: { store: "header", key: "X-Trace-Id" },
      },
    });
    expect((create.meta.smithy as { http: unknown }).http).toEqual({ code: 201 });
  });

  test("an address that does not mirror the uri keeps @http verbatim and says so", () => {
    for (const a of ["city/list", "getCurrentTime"]) {
      const o = op(a);
      expect(o.meta.http).toBeUndefined();
      expect((o.meta.smithy as { http: unknown }).http).toMatchObject({ method: "GET" });
    }
    const messages = diagnostics.map((d) => `${d.at}: ${d.message}`);
    expect(
      messages.some((s) => s.includes("GetCurrentTime") && s.includes("does not mirror")),
    ).toBe(true);
    expect(messages.some((s) => s.includes("ListCities") && s.includes("does not mirror"))).toBe(
      true,
    );
    expect(messages.some((s) => s.includes("errors are kept"))).toBe(true);
  });
});

describe("fromSmithyModel: edge cases", () => {
  test("an @httpPayload input is not an exact binding", () => {
    const { api, diagnostics } = fromSmithyModel({
      shapes: {
        "a#Svc": { type: "service", operations: [{ target: "a#Put" }] },
        "a#Put": {
          type: "operation",
          input: { target: "a#PutInput" },
          traits: { [`${P}http`]: { method: "PUT", uri: "/" } },
        },
        "a#PutInput": {
          type: "structure",
          members: { body: m(`${P}Blob`, { [`${P}httpPayload`]: {} }) },
        },
      },
    });
    expect(api.operations[0]!.meta.http).toBeUndefined();
    expect(diagnostics.some((d) => d.message.includes("@httpPayload"))).toBe(true);
  });

  test("a key that collides with a child resource falls back and is reported", () => {
    const { api, diagnostics } = fromSmithyModel({
      shapes: {
        "a#Svc": { type: "service", resources: [{ target: "a#Box" }] },
        "a#Box": {
          type: "resource",
          operations: [{ target: "a#Item" }],
          resources: [{ target: "b#Item" }],
        },
        "a#Item": { type: "operation" },
        "b#Item": { type: "resource" },
      },
    });
    expect(addrs(api.operations)).toEqual(["box/itemOp"]);
    expect(diagnostics.some((d) => d.message.includes('keyed "itemOp"'))).toBe(true);
  });

  test("several services each get a top-level segment; `service` picks one", () => {
    const model: SmithyModel = {
      shapes: {
        "a#One": { type: "service", operations: [{ target: "a#Ping" }] },
        "b#Two": { type: "service", operations: [{ target: "a#Ping" }] },
        "a#Ping": { type: "operation" },
      },
    };
    expect(addrs(fromSmithyModel(model).api.operations)).toEqual(["one/ping", "two/ping"]);
    expect(addrs(fromSmithyModel(model, { service: "Two" }).api.operations)).toEqual(["ping"]);
    expect(() => fromSmithyModel(model, { service: "Nope" })).toThrow();
  });

  test("a model without a service still imports its types", () => {
    const { api, diagnostics } = fromSmithyModel({
      shapes: { "a#S": { type: "structure" } },
    });
    expect(Object.keys(api.defs)).toEqual(["S"]);
    expect(diagnostics.some((d) => d.message.includes("no service"))).toBe(true);
  });
});

describe("lower + projectors", () => {
  const imported = fromSmithyModel(weather);
  const lowered = lower(imported.api);

  test("lowers to a tree with the resource nesting", () => {
    expect(Object.keys(lowered.tree.children!).sort()).toEqual(
      ["city", "getCurrentTime", "subscribeAlerts"].sort(),
    );
    expect(lowered.tree.children!.city!.fallback!.name).toBe("cityId");
  });

  test("openapi out places the exactly-bound operations at their uri", async () => {
    const doc = await toOpenApi(lowered.tree, {
      schemas: schemaMap(lowered, routeKeys),
      title: "Weather",
      version: "2006-03-01",
    });
    const ops = Object.entries(doc.paths).flatMap(([p, ms]) =>
      Object.entries(ms).map(([method, o]) => `${method.toUpperCase()} ${p} ${o.operationId}`),
    );
    expect(ops).toContain("GET /city/{cityId} GetCity");
    expect(ops).toContain("DELETE /city/{cityId} DeleteCity");
    expect(ops).toContain("POST /city CreateCity");
    expect(ops).toContain("GET /city/{cityId}/forecast GetForecast");
    expect(doc.paths["/city/{cityId}"]!.delete!.deprecated).toBe(true);
  });

  test("mcp tools carry hints and stream/page markers", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.city_cityId_read!.annotations?.readOnlyHint).toBe(true);
    expect(byName.city_cityId_delete!.annotations?.idempotentHint).toBe(true);
    expect(byName.subscribeAlerts!.streaming).toBe(true);
    expect(byName.city_list!.paginated).toBe(true);
  });
});
