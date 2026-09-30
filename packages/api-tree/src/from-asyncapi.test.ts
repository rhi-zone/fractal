import { describe, expect, test } from "bun:test";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { toSDL } from "@rhi-zone/fractal-graphql-api-projector";
import { fromAsyncApiDocument } from "./from-asyncapi.ts";
import { lower, nameKeys, schemaMap, typeRefMap, UnboundOperationError } from "./lower.ts";
import type { Operation } from "./api-description.ts";
import type { Node } from "./node.ts";

const addr = (o: Operation): string =>
  o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/");
const fieldsOf = (o: Operation): Record<string, { meta: Record<string, unknown> }> =>
  (o.input.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields;
const at = (tree: Node, path: readonly string[]): Node => {
  let cur = tree;
  for (const seg of path) {
    const next = seg.startsWith(":") ? cur.fallback?.subtree : cur.children?.[seg];
    if (next === undefined) throw new Error(`no node at ${path.join("/")}`);
    cur = next;
  }
  return cur;
};

const v2 = {
  asyncapi: "2.6.0",
  id: "urn:example:signups",
  info: { title: "Signups", version: "1.0.0", description: "signup events" },
  defaultContentType: "application/json",
  servers: { prod: { url: "kafka.example.com:9092", protocol: "kafka" } },
  channels: {
    "user/{userId}/signedup": {
      description: "signups",
      servers: ["prod"],
      parameters: {
        userId: {
          description: "the user",
          schema: { type: "string" },
          location: "$message.payload#/user/id",
        },
      },
      bindings: { kafka: { partitions: 3 } },
      // the application is sent signups
      publish: {
        operationId: "onUserSignedUp",
        summary: "A user signed up",
        tags: [{ name: "signup" }],
        bindings: { kafka: { groupId: { type: "string" } } },
        message: { $ref: "#/components/messages/UserSignedUp" },
      },
      // the application emits signups
      subscribe: {
        message: {
          name: "SignupNotice",
          payload: { type: "object", properties: { note: { type: "string" } } },
        },
      },
    },
    "chat/{room}/message": {
      parameters: { room: { schema: { type: "string", enum: ["a", "b"] } } },
      publish: {
        message: {
          oneOf: [
            { $ref: "#/components/messages/TextMessage" },
            { $ref: "#/components/messages/ImageMessage" },
          ],
        },
      },
    },
    "avro/events": {
      publish: {
        message: {
          schemaFormat: "application/vnd.apache.avro;version=1.9.0",
          payload: { type: "record", name: "E", fields: [] },
        },
      },
    },
    "legacy.status": {
      subscribe: { message: { payload: { type: "string" } } },
    },
    unused: {},
  },
  components: {
    securitySchemes: { key: { type: "apiKey", in: "user" } },
    schemas: {
      User: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    messageTraits: { json: { contentType: "application/json", headers: { type: "object" } } },
    messages: {
      UserSignedUp: {
        name: "UserSignedUp",
        title: "User signed up",
        headers: { type: "object", properties: { "x-trace": { type: "string" } } },
        correlationId: { location: "$message.header#/x-trace" },
        traits: [{ $ref: "#/components/messageTraits/json" }],
        payload: {
          type: "object",
          required: ["user"],
          properties: {
            user: { $ref: "#/components/schemas/User" },
            at: { type: "string", format: "date-time" },
          },
        },
      },
      TextMessage: { name: "text", payload: { type: "string" } },
      ImageMessage: { name: "image", payload: { $ref: "#/components/schemas/Missing" } },
    },
  },
};

describe("fromAsyncApiDocument 2.x", () => {
  const imported = fromAsyncApiDocument(v2);
  const ops = Object.fromEntries(imported.api.operations.map((o) => [addr(o), o]));

  test("addresses are the channel path plus the operation key", () => {
    expect(Object.keys(ops)).toEqual([
      "user/{userId}/signedup/onUserSignedUp",
      "user/{userId}/signedup/send",
      "chat/{room}/message/receive",
      "avro/events/receive",
      "legacy.status/send",
    ]);
  });

  test("publish means the application receives; subscribe means it sends", () => {
    const recv = ops["user/{userId}/signedup/onUserSignedUp"]!;
    expect((recv.meta.asyncapi as { action: string }).action).toBe("receive");
    expect(recv.output!.shape.kind).toBe("void");
    expect(recv.meta.tags).toEqual({});
    expect(Object.keys(fieldsOf(recv))).toEqual(["userId", "user", "at"]);
    expect(fieldsOf(recv).user!.meta.optional).toBeUndefined();
    expect(fieldsOf(recv).at!.meta.optional).toBe(true);
    expect(fieldsOf(recv).userId!.meta.description).toBe("the user");

    const send = ops["user/{userId}/signedup/send"]!;
    expect((send.meta.asyncapi as { action: string }).action).toBe("send");
    expect(send.meta.tags).toEqual({ streaming: true });
    expect(Object.keys(fieldsOf(send))).toEqual(["userId"]);
    expect(send.output!.shape.kind).toBe("stream");
  });

  test("channel, operation and message data stay verbatim", () => {
    const recv = ops["user/{userId}/signedup/onUserSignedUp"]!;
    const meta = recv.meta.asyncapi as Record<string, any>;
    expect(meta.operationId).toBe("onUserSignedUp");
    expect(meta.channel.address).toBe("user/{userId}/signedup");
    expect(meta.channel.bindings).toEqual({ kafka: { partitions: 3 } });
    expect(meta.channel.servers).toEqual(["prod"]);
    expect(meta.channel.parameters.userId.location).toBe("$message.payload#/user/id");
    expect(meta.channel.publish).toBeUndefined();
    expect(meta.operation.bindings).toEqual({ kafka: { groupId: { type: "string" } } });
    expect(meta.operation.tags).toEqual([{ name: "signup" }]);
    expect(meta.messages[0].name).toBe("UserSignedUp");
    expect(meta.messages[0].correlationId).toEqual({ location: "$message.header#/x-trace" });
    expect(meta.messages[0].headers.properties["x-trace"]).toBeDefined();
    expect(recv.meta.description).toBe("A user signed up");
  });

  test("message traits fill what the message lacks", () => {
    const recv = ops["user/{userId}/signedup/onUserSignedUp"]!;
    const msg = (recv.meta.asyncapi as { messages: Record<string, unknown>[] }).messages[0]!;
    expect(msg.contentType).toBe("application/json");
    expect((msg.headers as { properties?: unknown }).properties).toBeDefined();
  });

  test("several messages become a union payload in message order", () => {
    const chat = ops["chat/{room}/message/receive"]!;
    expect(Object.keys(fieldsOf(chat))).toEqual(["room", "payload"]);
    const payload = (chat.input.shape as { fields: Record<string, any> }).fields.payload;
    expect(payload.shape.kind).toBe("union");
    expect(payload.shape.variants.map((v: any) => v.shape.target)).toEqual([
      "TextMessage",
      "ImageMessage",
    ]);
    const names = (chat.meta.asyncapi as { messages: { name: string }[] }).messages.map(
      (m) => m.name,
    );
    expect(names).toEqual(["text", "image"]);
    const room = (chat.input.shape as { fields: Record<string, any> }).fields.room;
    expect(room.shape.kind).toBe("enum");
  });

  test("components.schemas and components.messages become defs", () => {
    expect(Object.keys(imported.api.defs).sort()).toEqual([
      "ImageMessage",
      "TextMessage",
      "User",
      "UserSignedUp",
    ]);
    expect(imported.api.defs.User!.meta.typeName).toBe("User");
    expect(imported.api.defs.UserSignedUp!.shape.kind).toBe("object");
  });

  test("dotted channel names stay one static segment", () => {
    expect(ops["legacy.status/send"]!.address[0]).toEqual({
      kind: "static",
      name: "legacy.status",
    });
  });

  test("root group carries document-level data", () => {
    const root = imported.api.groups[0]!;
    expect(root.address).toEqual([]);
    expect(root.meta.description).toBe("signup events");
    const meta = root.meta.asyncapi as Record<string, any>;
    expect(meta.version).toBe("2.6.0");
    expect(meta.servers.prod.protocol).toBe("kafka");
    expect(meta.defaultContentType).toBe("application/json");
    expect(meta.components.securitySchemes.key.type).toBe("apiKey");
    expect(imported.info).toEqual({ title: "Signups", version: "1.0.0" });
  });

  test("unrepresentable parts are reported, not dropped silently", () => {
    const messages = imported.diagnostics.map((d) => `${d.at}: ${d.message}`);
    expect(messages.some((m) => m.includes("avro~1events") && m.includes("no ingester"))).toBe(
      true,
    );
    expect(
      messages.some((m) => m.includes("ImageMessage") && m.includes("could not be resolved")),
    ).toBe(true);
    expect(messages.some((m) => m.includes("#/channels/unused"))).toBe(true);
    const avro = ops["avro/events/receive"]!;
    expect((fieldsOf(avro) as any).payload.shape.kind).toBe("unknown");
  });

  test("the api description is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported.api))).toEqual(imported.api);
  });
});

const v3 = {
  asyncapi: "3.0.0",
  info: { title: "Devices", version: "2.0.0" },
  channels: {
    reading: {
      address: "devices/{deviceId}/reading",
      parameters: { deviceId: { description: "device id", examples: ["d1"] } },
      bindings: { mqtt: { qos: 1 } },
      messages: {
        reading: { $ref: "#/components/messages/Reading" },
        legacy: {
          payload: {
            schemaFormat: "application/vnd.google.protobuf;version=3",
            schema: "message L { }",
          },
        },
        spare: { payload: { type: "string" } },
      },
    },
    status: {
      address: null,
      messages: {
        status: {
          payload: {
            schemaFormat: "application/schema+json;version=draft-07",
            schema: { type: "object", properties: { up: { type: "boolean" } }, required: ["up"] },
          },
        },
      },
    },
    ping: { address: "ping", messages: { ping: { payload: { type: "string" } } } },
    pong: { address: "pong", messages: { pong: { payload: { type: "integer" } } } },
    dormant: { address: "dormant", messages: { x: { payload: { type: "string" } } } },
  },
  operations: {
    onReading: {
      action: "receive",
      title: "Readings",
      channel: { $ref: "#/channels/reading" },
      messages: [{ $ref: "#/channels/reading/messages/reading" }],
      bindings: { mqtt: { retain: false } },
      "x-owner": "iot",
    },
    watchStatus: {
      action: "send",
      channel: { $ref: "#/channels/status" },
    },
    replay: {
      action: "send",
      channel: { $ref: "#/channels/reading" },
      messages: [
        { $ref: "#/channels/reading/messages/reading" },
        { $ref: "#/channels/reading/messages/legacy" },
      ],
    },
    ping: {
      action: "receive",
      channel: { $ref: "#/channels/ping" },
      reply: {
        address: { location: "$message.header#/replyTo" },
        channel: { $ref: "#/channels/pong" },
      },
    },
    badAction: { action: "sideways", channel: { $ref: "#/channels/ping" } },
  },
  components: {
    messages: {
      Reading: {
        name: "Reading",
        correlationId: { location: "$message.header#/id" },
        payload: { $ref: "#/components/schemas/Reading" },
      },
    },
    schemas: {
      Reading: {
        schemaFormat: "application/vnd.aai.asyncapi+json;version=3.0.0",
        schema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "number" }, unit: { type: "string" } },
        },
      },
    },
  },
};

describe("fromAsyncApiDocument 3.0", () => {
  const imported = fromAsyncApiDocument(v3);
  const ops = Object.fromEntries(imported.api.operations.map((o) => [addr(o), o]));

  test("addresses are the channel address plus the operation id", () => {
    expect(Object.keys(ops)).toEqual([
      "devices/{deviceId}/reading/onReading",
      "status/watchStatus",
      "devices/{deviceId}/reading/replay",
      "ping/ping",
    ]);
  });

  test("receive takes the payload (object properties flattened), send streams it", () => {
    const recv = ops["devices/{deviceId}/reading/onReading"]!;
    expect(Object.keys(fieldsOf(recv))).toEqual(["deviceId", "value", "unit"]);
    expect(fieldsOf(recv).unit!.meta.optional).toBe(true);
    expect(fieldsOf(recv).deviceId!.meta.description).toBe("device id");
    expect(recv.output!.shape.kind).toBe("void");
    expect(recv.meta.description).toBe("Readings");

    const watch = ops["status/watchStatus"]!;
    expect(Object.keys(fieldsOf(watch))).toEqual([]);
    expect(watch.meta.tags).toEqual({ streaming: true });
    const el = (watch.output!.shape as { element: { shape: { kind: string } } }).element;
    expect(el.shape.kind).toBe("object");
  });

  test("a null address is addressed by its channel id", () => {
    expect(ops["status/watchStatus"]!.address[0]).toEqual({ kind: "static", name: "status" });
    const meta = ops["status/watchStatus"]!.meta.asyncapi as Record<string, any>;
    expect(meta.channel.id).toBe("status");
    expect(meta.channel.address).toBeNull();
  });

  test("a message from components.messages is a ref to its def", () => {
    const replay = ops["devices/{deviceId}/reading/replay"]!;
    const el = (replay.output!.shape as { element: any }).element;
    expect(el.shape.kind).toBe("union");
    expect(el.shape.variants[0].shape).toEqual({ kind: "ref", target: "ReadingMessage" });
    expect(el.shape.variants[1].shape.kind).toBe("unknown");
    expect(Object.keys(imported.api.defs)).toEqual(["Reading", "ReadingMessage"]);
    expect(imported.diagnostics.some((d) => d.message.includes('"ReadingMessage"'))).toBe(true);
    expect(imported.api.defs.ReadingMessage!.shape.kind).toBe("ref");
  });

  test("reply becomes the output of a receive operation", () => {
    const ping = ops["ping/ping"]!;
    expect(ping.output!.shape.kind).toBe("integer");
    const meta = ping.meta.asyncapi as Record<string, any>;
    expect(meta.reply.address.location).toBe("$message.header#/replyTo");
  });

  test("bindings, extensions and correlation ids stay verbatim", () => {
    const meta = ops["devices/{deviceId}/reading/onReading"]!.meta.asyncapi as Record<string, any>;
    expect(meta.channel.bindings).toEqual({ mqtt: { qos: 1 } });
    expect(meta.operation.bindings).toEqual({ mqtt: { retain: false } });
    expect(meta.operation["x-owner"]).toBe("iot");
    expect(meta.operationId).toBe("onReading");
    expect(meta.messages[0].correlationId).toEqual({ location: "$message.header#/id" });
  });

  test("unrepresentable parts are reported", () => {
    const messages = imported.diagnostics.map((d) => `${d.at}: ${d.message}`);
    expect(messages.some((m) => m.includes("legacy") && m.includes("protobuf"))).toBe(true);
    expect(
      messages.some((m) => m.includes("#/operations/badAction") && m.includes("sideways")),
    ).toBe(true);
    expect(messages.some((m) => m.includes("#/channels/dormant") && m.includes("not used"))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes("messages/spare") && m.includes("not used"))).toBe(true);
  });

  test("the api description is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported.api))).toEqual(imported.api);
  });
});

describe("addressing collisions", () => {
  test("an operation whose address is another operation's parent is suffixed", () => {
    const { api, diagnostics } = fromAsyncApiDocument({
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      channels: {
        a: { address: "x", messages: { m: { payload: { type: "string" } } } },
        b: { address: "x/y", messages: { m: { payload: { type: "string" } } } },
      },
      operations: {
        y: { action: "receive", channel: { $ref: "#/channels/a" } },
        z: { action: "receive", channel: { $ref: "#/channels/b" } },
      },
    });
    expect(api.operations.map(addr)).toEqual(["x/y-receive", "x/y/z"]);
    expect(diagnostics.filter((d) => d.message.includes("keyed")).length).toBe(1);
    lower(api);
  });

  test("a 2.x operation without an operationId is keyed by direction, and a sibling clash is renamed", () => {
    const { api, diagnostics } = fromAsyncApiDocument({
      asyncapi: "2.0.0",
      info: { title: "t", version: "1" },
      channels: {
        "a/send": { publish: { message: { payload: { type: "string" } } } },
        a: { subscribe: { message: { payload: { type: "string" } } } },
      },
    });
    expect(api.operations.map(addr)).toEqual(["a/send/receive", "a/send-send"]);
    expect(diagnostics.some((d) => d.message.includes("keyed"))).toBe(true);
    lower(api);
  });

  test("params at one position are rebound to the first name", () => {
    const { api, diagnostics } = fromAsyncApiDocument({
      asyncapi: "2.0.0",
      info: { title: "t", version: "1" },
      channels: {
        "u/{id}/a": { publish: { message: { payload: { type: "string" } } } },
        "u/{uid}/b": { publish: { message: { payload: { type: "string" } } } },
      },
    });
    expect(api.operations.map(addr)).toEqual(["u/{id}/a/receive", "u/{id}/b/receive"]);
    expect(diagnostics.some((d) => d.message.includes("shares its position"))).toBe(true);
    lower(api);
  });
});

describe("lower + projectors", () => {
  const imported = fromAsyncApiDocument(v2);
  const lowered = lower(imported.api);

  test("unbound operations throw a typed error", () => {
    const leaf = at(lowered.tree, ["user", ":userId", "signedup", "onUserSignedUp"]);
    expect(() => leaf.handler!({})).toThrow(UnboundOperationError);
  });

  test("mcp tools: a send operation is a streaming tool, a receive operation takes the payload", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        "avro_events_receive",
        "chat_room_message_receive",
        "legacy.status_send",
        "user_userId_signedup_onUserSignedUp",
        "user_userId_signedup_send",
      ].sort(),
    );
    const recv = byName.user_userId_signedup_onUserSignedUp!;
    expect((recv.inputSchema as { properties: object }).properties).toHaveProperty("user");
    expect(recv.streaming).toBeFalsy();
    expect(byName.user_userId_signedup_send!.streaming).toBe(true);
  });

  test("graphql exposes send operations as subscriptions", () => {
    const sdl = toSDL(lowered.tree, {
      types: typeRefMap(lowered, nameKeys),
      namedTypes: lowered.defs,
    });
    const subscription = /type Subscription \{([^}]*)\}/.exec(sdl)?.[1] ?? "";
    expect(subscription).toContain("userUserIdSignedupSend");
    const mutation = /type Mutation \{([^}]*)\}/.exec(sdl)?.[1] ?? "";
    expect(mutation).toContain("userUserIdSignedupOnUserSignedUp");
    expect(mutation).not.toContain("Send");
  });

  test("the 3.0 description lowers", () => {
    const l3 = lower(fromAsyncApiDocument(v3).api);
    expect(at(l3.tree, ["status", "watchStatus"]).handler).toBeDefined();
  });
});
