import { describe, expect, test } from "bun:test";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector/project";
import { toSDL } from "@rhi-zone/fractal-graphql-api-projector/schema";
import { fromProtobufSource } from "./from-protobuf.ts";
import { concatApi } from "./api-description.ts";
import { lower, nameKeys, schemaMap, typeRefMap } from "./lower.ts";

const shop = `
syntax = "proto3";
package shop.v1;

import "google/api/annotations.proto";
import "other.proto";

// The shop.
service Shop {
  option (some.service_opt) = "x";

  // Fetch one item.
  rpc GetItem(GetItemRequest) returns (Item) {
    option idempotency_level = NO_SIDE_EFFECTS;
    option (google.api.http) = {
      get: "/v1/items/{id}"
      additional_bindings { post: "/v1/items:get" body: "*" }
      additional_bindings { get: "/v1/legacy/{id}" }
    };
  }

  rpc CreateItem(Item) returns (Item) { option idempotency_level = IDEMPOTENT; }
  rpc DeleteItem(GetItemRequest) returns (google.protobuf.Empty) { option deprecated = true; }
  rpc Ping(google.protobuf.Empty) returns (google.protobuf.StringValue);
  rpc Watch(WatchRequest) returns (stream Item);
  rpc Upload(stream Item) returns (Item);
  rpc Chat(stream Item) returns (stream Item);
  rpc Label(google.protobuf.StringValue) returns (Item);
  rpc Foreign(other.Thing) returns (Item);
}

message GetItemRequest {
  // the item id
  string id = 1;
  optional string locale = 2;
}
message WatchRequest { repeated string ids = 1; }
message Item {
  string id = 1;
  string name = 2;
  Kind kind = 3;
  map<string, string> labels = 4;
  Item parent = 5;
  other.Thing thing = 6;
}
enum Kind { KIND_UNSPECIFIED = 0; BOOK = 1; }
`;

const fieldNames = (input: { shape: unknown }): string[] =>
  Object.keys((input.shape as { fields: object }).fields);

const opAt = (api: ReturnType<typeof fromProtobufSource>["api"], method: string) =>
  api.operations.find((o) => (o.meta.grpc as { method: string }).method === method)!;

describe("fromProtobufSource", () => {
  const { api, diagnostics } = fromProtobufSource(shop);

  test("addresses are package segments, service, method", () => {
    expect(
      api.operations.map((o) =>
        o.address.map((s) => (s.kind === "static" ? s.name : "?")).join("/"),
      ),
    ).toEqual([
      "shop/v1/Shop/GetItem",
      "shop/v1/Shop/CreateItem",
      "shop/v1/Shop/DeleteItem",
      "shop/v1/Shop/Ping",
      "shop/v1/Shop/Watch",
      "shop/v1/Shop/Label",
      "shop/v1/Shop/Foreign",
    ]);
  });

  test("the api description is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(api))).toEqual(api);
  });

  test("the request message's fields are the named-params input", () => {
    expect(fieldNames(opAt(api, "GetItem").input)).toEqual(["id", "locale"]);
    const fields = (opAt(api, "GetItem").input.shape as { fields: Record<string, { meta: Obj }> })
      .fields;
    expect(fields.id!.meta.description).toBe("the item id");
    expect(fields.locale!.meta.optional).toBe(true);
    expect(fieldNames(opAt(api, "Ping").input)).toEqual([]);
  });

  test("messages and enums are defs; outputs ref them", () => {
    expect(Object.keys(api.defs).sort()).toEqual([
      "GetItemRequest",
      "Item",
      "Kind",
      "WatchRequest",
    ]);
    expect(opAt(api, "GetItem").output!.shape).toEqual({ kind: "ref", target: "Item" });
    expect(opAt(api, "DeleteItem").output!.shape.kind).toBe("void");
    expect(opAt(api, "Ping").output!.shape.kind).toBe("string");
  });

  test("server streaming is a stream output tagged streaming", () => {
    const watch = opAt(api, "Watch");
    expect(watch.output!.shape).toEqual({
      kind: "stream",
      element: { shape: { kind: "ref", target: "Item" }, meta: {} },
    });
    expect(watch.meta.tags).toEqual({ streaming: true });
    expect((watch.meta.grpc as Obj).responseStream).toBe(true);
  });

  test("client and bidirectional streaming are skipped with a diagnostic", () => {
    const messages = diagnostics.filter((d) => d.message.includes("streaming rpc skipped"));
    expect(messages.map((d) => d.at)).toEqual(["shop.v1.Shop/Upload", "shop.v1.Shop/Chat"]);
    expect(messages[0]!.message).toContain("client-streaming");
    expect(messages[1]!.message).toContain("bidirectional");
    expect(opAt(api, "Upload")).toBeUndefined();
  });

  test("idempotency level, deprecation and comments land in shared meta", () => {
    expect(opAt(api, "GetItem").meta.tags).toEqual({ readOnly: true, idempotent: true });
    expect(opAt(api, "CreateItem").meta.tags).toEqual({ idempotent: true });
    expect(opAt(api, "DeleteItem").meta.tags).toEqual({ deprecated: true });
    expect(opAt(api, "GetItem").meta.description).toBe("Fetch one item.");
    expect(opAt(api, "CreateItem").meta.description).toBeUndefined();
  });

  test("grpc names are fully qualified; other options are kept verbatim", () => {
    expect(opAt(api, "GetItem").meta.grpc).toMatchObject({
      package: "shop.v1",
      service: "Shop",
      method: "GetItem",
      requestType: "shop.v1.GetItemRequest",
      responseType: "shop.v1.Item",
      options: { idempotency_level: "NO_SIDE_EFFECTS" },
    });
    expect(opAt(api, "DeleteItem").meta.grpc).toMatchObject({
      responseType: "google.protobuf.Empty",
      options: { deprecated: true },
    });
    const group = api.groups.find((g) => g.address.length === 3)!;
    expect(group.meta).toEqual({
      description: "The shop.",
      grpc: { package: "shop.v1", service: "Shop", options: { "(some.service_opt)": "x" } },
    });
  });

  test("the google.api.http rule is kept verbatim, never mapped to meta.http", () => {
    const get = opAt(api, "GetItem");
    expect(get.meta.http).toBeUndefined();
    expect((get.meta.grpc as Obj).http).toEqual({
      get: "/v1/items/{id}",
      additional_bindings: [{ post: "/v1/items:get", body: "*" }, { get: "/v1/legacy/{id}" }],
    });
    expect(
      diagnostics.some(
        (d) => d.at === "shop.v1.Shop/GetItem" && d.message.includes("google.api.http"),
      ),
    ).toBe(true);
    expect((get.meta.grpc as { options: Obj }).options["(google.api.http)"]).toBeUndefined();
  });

  test("a well-known non-message request becomes one field", () => {
    const label = opAt(api, "Label");
    expect(fieldNames(label.input)).toEqual(["request"]);
    expect((label.meta.grpc as Obj).requestField).toBe("request");
  });

  test("types from imported files are diagnosed, not invented", () => {
    const foreign = opAt(api, "Foreign");
    expect(fieldNames(foreign.input)).toEqual([]);
    const messages = diagnostics.map((d) => `${d.at}: ${d.message}`);
    expect(
      messages.some((m) => m.startsWith("shop.v1.Shop/Foreign:") && m.includes("other.Thing")),
    ).toBe(true);
    expect(messages.some((m) => m.startsWith("other.Thing:") && m.includes("dangling"))).toBe(true);
  });

  test("a file with no package addresses [Service, Method]", () => {
    const { api: bare } = fromProtobufSource(
      `service S { rpc M(R) returns (R); } message R { int32 n = 1; }`,
    );
    expect(bare.operations[0]!.address).toEqual([
      { kind: "static", name: "S" },
      { kind: "static", name: "M" },
    ]);
    expect(bare.operations[0]!.meta.grpc).toEqual({
      service: "S",
      method: "M",
      requestType: "R",
      responseType: "R",
    });
  });

  test("relative and absolute type names resolve through the package scope", () => {
    const { api: a, diagnostics: d } = fromProtobufSource(`
      syntax = "proto3";
      package a.b;
      service S { rpc M(.a.b.R) returns (b.R); rpc N(R) returns (Outer.Inner); }
      message R { int32 n = 1; }
      message Outer { message Inner { string s = 1; } }
    `);
    expect(d).toEqual([]);
    expect(fieldNames(a.operations[0]!.input)).toEqual(["n"]);
    expect(a.operations[0]!.output!.shape).toEqual({ kind: "ref", target: "R" });
    expect(a.operations[1]!.output!.shape).toEqual({ kind: "ref", target: "Outer.Inner" });
  });

  test("proto2: fields without required are optional", () => {
    const { api: p2 } = fromProtobufSource(`
      syntax = "proto2";
      message R { optional string a = 1; required int32 b = 2; repeated int32 c = 3; }
      service S { rpc M(R) returns (R); }
    `);
    const fields = (p2.operations[0]!.input.shape as { fields: Record<string, { meta: Obj }> })
      .fields;
    expect(fields.a!.meta.optional).toBe(true);
    expect(fields.b!.meta.optional).toBeUndefined();
    expect(fields.c!.meta.optional).toBeUndefined();
  });

  test("two packages concatenate without address collisions", () => {
    const one = fromProtobufSource(`package a; service S { rpc M(R) returns (R); } message R {}`);
    const two = fromProtobufSource(`package b; service S { rpc M(R) returns (R); } message R {}`);
    expect(() => lower(concatApi(one.api, two.api))).not.toThrow();
  });

  test("source that is not .proto text throws", () => {
    expect(() => fromProtobufSource("service {")).toThrow();
  });
});

type Obj = Record<string, unknown>;

describe("lower + projectors", () => {
  const { api } = fromProtobufSource(shop);
  const lowered = lower(api);

  test("the tree mirrors the addresses", () => {
    const shopNode = lowered.tree.children!.shop!.children!.v1!.children!.Shop!;
    expect(shopNode.meta.description).toBe("The shop.");
    expect(Object.keys(shopNode.children!)).toContain("GetItem");
  });

  test("mcp tools carry the message fields and hints", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.shop_v1_Shop_GetItem).toBeDefined();
    expect(
      (byName.shop_v1_Shop_GetItem!.inputSchema as { properties: object }).properties,
    ).toHaveProperty("id");
    expect(byName.shop_v1_Shop_GetItem!.annotations?.readOnlyHint).toBe(true);
  });

  test("graphql args come from the request fields; streaming is a subscription", () => {
    const sdl = toSDL(lowered.tree, {
      types: typeRefMap(lowered, nameKeys),
      namedTypes: lowered.defs,
    });
    expect(sdl).toContain("GetItem(id: String!, locale: String): Item!");
    expect(sdl).toMatch(/type Subscription \{[^}]*shopV1ShopWatch\(ids: \[String!\]!\)/);
  });
});
