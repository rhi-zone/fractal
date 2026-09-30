// AsyncAPI (2.x, 3.0) documents -> ApiDescription.
//
// Direction: an operation is described from the described application's
// side. `receive` (2.x `publish`, 3.0 `action: receive`) means the
// application is sent messages on the channel; `send` (2.x `subscribe`, 3.0
// `action: send`) means the application emits messages on it.
//   - receive: the message payload is the operation's input; the output is
//     `void`, or (3.0 `reply`) the reply message payload.
//   - send: input is the channel parameters only; the output is
//     `stream(payload)` and `meta.tags.streaming` is set.
//
// Addressing: an operation's address is its channel address split on "/"
// (a whole-segment `{name}` is a param segment, any other segment, dots and
// mixed text included, is one static segment) followed by the operation key:
// the 3.0 operation id, else the 2.x `operationId`, else the direction word
// (`receive`/`send`). A 3.0 channel with a null address is addressed by its
// channel id. No `meta.http` is produced: a channel address is not a URL. A
// key that would equal, or sit above, another operation's address is
// suffixed and reported.
//
// Input: every channel address expression is a required string field (its
// declared schema, else `string`; a 3.0 parameter with a `default` is
// optional); for `receive` with exactly one message whose payload is an
// object schema its properties follow as fields, otherwise the payload (a
// union for several messages, in message order) is the one field `payload`.
//
// Verbatim under `meta.asyncapi`: `action`, `operationId`, `channel` (the
// channel object without its operations/messages, plus `id`/`address`),
// `operation` (the operation object without its channel/message links),
// `messages` (every message of the operation, traits applied, in the order
// of the payload union) and `reply`. Document-level data (info, servers,
// defaultContentType, tags, externalDocs, remaining components) sits on the
// root group.
//
// Payload schemas: AsyncAPI Schema Object and JSON Schema
// (`application/schema+json`) go through `fromJsonSchema`, the OpenAPI 3.0
// Schema Object format through `fromOpenApi30`; any other `schemaFormat`
// makes the payload `unknown` and is reported. `components.schemas` and
// `components.messages` become `defs`; a message referenced from
// `components.messages` is a `ref` to its def.
//
// Spec references: AsyncAPI 2.6.0: Channels Object, Channel Item Object,
// Operation Object, Parameters Object, Parameter Object, Message Object
// (schemaFormat table), Message Trait Object, Operation Trait Object,
// Components Object, Reference Object, Correlation ID Object, Schema Object.
// AsyncAPI 3.0.0: Channels Object, Channel Object (address, Channel Address
// Expressions), Messages Object, Operations Object, Operation Object
// (`action`), Operation Reply Object, Parameter Object, Message Object,
// Multi Format Schema Object, Components Object, Reference Object, Traits
// Merge Mechanism. JSON Pointer: RFC 6901.

import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { fromJsonSchema } from "@rhi-zone/fractal-type-ir/from-json-schema";
import { fromOpenApi30 } from "@rhi-zone/fractal-type-ir/from-openapi";
import type {
  ApiDescription,
  Diagnostic,
  Group,
  Imported,
  Operation,
  Segment,
} from "./api-description.ts";

type Obj = Record<string, unknown>;
type Action = "send" | "receive";

export type ImportedAsyncApi = Imported & {
  /** The document's `asyncapi` version string. */
  readonly version: string;
  readonly info: { readonly title?: string; readonly version?: string };
};

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const escapePointer = (s: string): string => s.replaceAll("~", "~0").replaceAll("/", "~1");
const unescapePointer = (s: string): string =>
  decodeURIComponent(s).replaceAll("~1", "/").replaceAll("~0", "~");

const SCHEMA_REF = /^#\/components\/schemas\/([^/]+)$/;
const COMPONENT_MESSAGE_REF = /^#\/components\/messages\/([^/]+)$/;
const CHANNEL_REF = /^#\/channels\/([^/]+)$/;
const CHANNEL_MESSAGE_REF = /^#\/channels\/([^/]+)\/messages\/([^/]+)$/;
// Keys whose values are data, never schemas.
const DATA_KEYS: ReadonlySet<string> = new Set(["examples", "example", "default", "enum", "const"]);

type SchemaKind = "json" | "openapi30";

/** Which converter a `schemaFormat` value selects; `undefined` for a format with no ingester. */
function classifyFormat(format: string | undefined): SchemaKind | undefined {
  if (format === undefined) return "json";
  const [base, ...params] = format.split(";").map((p) => p.trim());
  const media = (base ?? "").toLowerCase();
  if (/^application\/vnd\.aai\.asyncapi(\+json|\+yaml)?$/.test(media)) return "json";
  if (/^application\/schema(\+json|\+yaml)$/.test(media)) return "json";
  if (/^application\/vnd\.oai\.openapi(\+json|\+yaml)?$/.test(media)) {
    const v = params.find((p) => p.startsWith("version="))?.slice("version=".length);
    return v === undefined || v.startsWith("3.0") ? "openapi30" : "json";
  }
  return undefined;
}

/** RFC 6901 lookup inside `doc` for a local `#/...` reference. */
function resolvePointer(doc: Obj, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Obj)[unescapePointer(raw)];
  }
  return cur;
}

/** Target wins; `patch` only supplies what `target` lacks (objects merge recursively). Implements the "a property on a trait MUST NOT override the same property on the target" rule. */
function fill(target: Obj, patch: Obj): Obj {
  const out: Obj = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) out[k] = v;
    else if (isObj(out[k]) && isObj(v)) out[k] = fill(out[k], v);
  }
  return out;
}

const clone = <T>(v: T): T => structuredClone(v);

function detectMajor(doc: Obj): 2 | 3 {
  const v = doc.asyncapi;
  if (typeof v === "string") {
    if (v.startsWith("2.")) return 2;
    if (v.startsWith("3.")) return 3;
  }
  throw new Error(`fromAsyncApiDocument: unsupported document version (asyncapi=${String(v)})`);
}

type Msg = {
  /** Pointer to the message when it was reached through a reference, else where it is written. Unique per message. */
  readonly at: string;
  readonly componentKey?: string;
  /** Traits applied. */
  readonly raw: Obj;
};

type Conv = {
  /** Absent when the message declares no payload. */
  readonly type?: TypeRef;
  /** The payload schema with references followed, for object flattening. */
  readonly resolved?: Obj;
  readonly convert?: (schema: unknown) => TypeRef;
};

type Item = {
  readonly at: string;
  readonly segs: readonly Segment[];
  key: string;
  readonly action: Action;
  readonly input: TypeRef;
  readonly output?: TypeRef;
  readonly meta: Obj;
};

export function fromAsyncApiDocument(input: unknown): ImportedAsyncApi {
  if (!isObj(input)) throw new Error("fromAsyncApiDocument: document must be a JSON object");
  const doc = input;
  const major = detectMajor(doc);
  const diagnostics: Diagnostic[] = [];
  const diag = (at: string, message: string): void => {
    diagnostics.push({ at, message });
  };

  const follow = (v: unknown): { value: unknown; ref?: string } => {
    const seen = new Set<string>();
    let ref: string | undefined;
    while (isObj(v) && typeof v.$ref === "string") {
      if (seen.has(v.$ref)) return { value: undefined, ...(ref !== undefined ? { ref } : {}) };
      seen.add(v.$ref);
      ref = v.$ref;
      v = resolvePointer(doc, v.$ref);
    }
    return { value: v, ...(ref !== undefined ? { ref } : {}) };
  };

  const withTraits = (obj: Obj, at: string): Obj => {
    if (!Array.isArray(obj.traits)) return obj;
    let out = obj;
    obj.traits.forEach((raw, i) => {
      const trait = follow(raw).value;
      if (!isObj(trait)) diag(`${at}/traits/${i}`, "trait could not be resolved; skipped");
      else out = fill(out, trait);
    });
    return out;
  };

  // ---- schemas ----------------------------------------------------------

  const pendingRefs: { name: string; at: string }[] = [];
  const noteRefs = (v: unknown, at: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => noteRefs(x, `${at}/${i}`));
      return;
    }
    if (!isObj(v)) return;
    if (typeof v.$ref === "string") {
      const m = SCHEMA_REF.exec(v.$ref);
      if (m) pendingRefs.push({ name: unescapePointer(m[1]!), at });
      else {
        diag(
          at,
          `reference "${v.$ref}" is not under #/components/schemas; the type is a ref that resolves against no def`,
        );
      }
      return;
    }
    for (const [k, c] of Object.entries(v)) {
      if (!DATA_KEYS.has(k)) noteRefs(c, `${at}/${escapePointer(k)}`);
    }
  };

  const isMultiFormat = (v: unknown): v is Obj =>
    isObj(v) &&
    "schema" in v &&
    Object.keys(v).every((k) => /^(schema|schemaFormat|x-.*)$/.test(k));

  /** A schema-or-reference (3.0: also a Multi Format Schema Object) under `formatIn` (2.x `schemaFormat`), as a TypeRef. */
  const convertSchemaEntry = (entry: unknown, formatIn: string | undefined, at: string): Conv => {
    let format = formatIn;
    let raw: unknown = entry;
    let value = follow(entry).value;
    const viaSchemaRef =
      isObj(entry) && typeof entry.$ref === "string" ? SCHEMA_REF.exec(entry.$ref) : null;
    if (major === 3 && isMultiFormat(value)) {
      format = asString(value.schemaFormat) ?? format;
      if (viaSchemaRef === null) raw = value.schema;
      value = follow(value.schema).value;
    }
    const kind = classifyFormat(format);
    if (kind === undefined) {
      if (viaSchemaRef !== null) return { type: t(types.ref(unescapePointer(viaSchemaRef[1]!))) };
      diag(at, `schemaFormat "${String(format)}" has no ingester; the type is unknown`);
      return { type: t(types.unknown) };
    }
    if (value === undefined) {
      diag(at, "schema could not be resolved; the type is unknown");
      return { type: t(types.unknown) };
    }
    if (isObj(raw) && typeof raw.$ref === "string" && !SCHEMA_REF.test(raw.$ref)) raw = value;
    noteRefs(raw, at);
    const convert = (s: unknown): TypeRef => {
      if (!isObj(s)) return t(types.unknown);
      try {
        return kind === "openapi30" ? fromOpenApi30(s) : fromJsonSchema(s);
      } catch (e) {
        diag(at, `schema could not be converted (${e instanceof Error ? e.message : String(e)})`);
        return t(types.unknown);
      }
    };
    return { type: convert(raw), ...(isObj(value) ? { resolved: value } : {}), convert };
  };

  const defs: Record<string, TypeRef> = {};
  const components = isObj(doc.components) ? doc.components : {};
  const schemaNames = new Set<string>();
  if (isObj(components.schemas)) {
    for (const [name, entry] of Object.entries(components.schemas)) {
      const conv = convertSchemaEntry(
        entry,
        undefined,
        `#/components/schemas/${escapePointer(name)}`,
      );
      defs[name] = withMeta(conv.type!, { typeName: name });
      schemaNames.add(name);
    }
  }

  const resolveMessage = (entry: unknown, at: string): Msg | undefined => {
    const { value, ref } = follow(entry);
    if (!isObj(value)) {
      diag(ref ?? at, "message could not be resolved; skipped");
      return undefined;
    }
    const key = ref !== undefined ? COMPONENT_MESSAGE_REF.exec(ref)?.[1] : undefined;
    return {
      at: ref ?? at,
      ...(key !== undefined ? { componentKey: unescapePointer(key) } : {}),
      raw: withTraits(value, ref ?? at),
    };
  };

  const convMemo = new Map<string, Conv>();
  const convertMessage = (msg: Msg): Conv => {
    const memo = convMemo.get(msg.at);
    if (memo !== undefined) return memo;
    let conv: Conv;
    if (msg.raw.payload === undefined) {
      diag(msg.at, "message declares no payload");
      conv = {};
    } else {
      conv = convertSchemaEntry(
        msg.raw.payload,
        major === 2 ? asString(msg.raw.schemaFormat) : undefined,
        `${msg.at}/payload`,
      );
    }
    convMemo.set(msg.at, conv);
    return conv;
  };

  const messageDefs = new Map<string, string>();
  if (isObj(components.messages)) {
    for (const key of Object.keys(components.messages)) {
      const at = `#/components/messages/${escapePointer(key)}`;
      const msg = resolveMessage({ $ref: at }, at);
      if (msg === undefined) continue;
      const conv = convertMessage(msg);
      if (conv.type === undefined) continue;
      let name = key;
      for (let n = 1; name in defs; n++) name = n === 1 ? `${key}Message` : `${key}Message${n}`;
      if (name !== key)
        diag(at, `def name "${key}" is taken by another def; the message def is "${name}"`);
      defs[name] = withMeta(conv.type, { typeName: name });
      messageDefs.set(key, name);
    }
  }

  const payloadType = (msg: Msg): TypeRef => {
    const conv = convertMessage(msg);
    const def = msg.componentKey !== undefined ? messageDefs.get(msg.componentKey) : undefined;
    if (def !== undefined) return t(types.ref(def));
    return conv.type ?? t(types.unknown);
  };

  const unionOf = (msgs: readonly Msg[]): TypeRef => {
    const variants = msgs.map(payloadType);
    return variants.length === 1 ? variants[0]! : t(types.union(variants));
  };

  // ---- operations -------------------------------------------------------

  const items: Item[] = [];
  // Param-segment name already bound at each static prefix.
  const paramNameAt = new Map<string, string>();
  const usedChannelMessages = new Set<string>();
  const usedChannels = new Set<string>();

  const buildItem = (a: {
    at: string;
    action: Action;
    key: string;
    channelId?: string;
    address: unknown;
    channel: Obj;
    channelAt: string;
    operation: Obj;
    msgs: readonly Msg[];
    reply?: { readonly value: Obj; readonly msgs: readonly Msg[] };
  }): void => {
    const { at, action, channel } = a;
    const address = typeof a.address === "string" ? a.address : (a.channelId ?? a.key);
    const exprNames: string[] = [];
    if (typeof a.address === "string") {
      for (const m of a.address.matchAll(/\{([^{}]+)\}/g)) {
        if (!exprNames.includes(m[1]!)) exprNames.push(m[1]!);
      }
    }

    const segs: Segment[] = [];
    let prefix = "";
    for (const raw of address.split("/").filter((s) => s.length > 0)) {
      const whole = /^\{([^{}]+)\}$/.exec(raw);
      if (whole) {
        const own = whole[1]!;
        const bound = paramNameAt.get(prefix) ?? own;
        paramNameAt.set(prefix, bound);
        if (bound !== own) {
          diag(
            a.channelAt,
            `address parameter "${own}" shares its position with "${bound}" in another channel; the address segment is "${bound}"`,
          );
        }
        segs.push({ kind: "param", name: bound });
        prefix += "/{}";
      } else {
        segs.push({ kind: "static", name: raw });
        prefix += `/${raw}`;
      }
    }

    const fields: Record<string, TypeRef> = {};
    const origin: Record<string, string> = {};
    const addField = (name: string, type: TypeRef, from: string): void => {
      if (name in fields) {
        diag(at, `"${name}" is both ${origin[name]} and ${from}; the ${from} one is skipped`);
        return;
      }
      fields[name] = type;
      origin[name] = from;
    };

    const params = isObj(channel.parameters) ? channel.parameters : {};
    for (const name of exprNames) {
      const pAt = `${a.channelAt}/parameters/${escapePointer(name)}`;
      const p = follow(params[name]).value;
      if (!isObj(p)) {
        diag(pAt, `address names "{${name}}" but no parameter declares it; it is a string`);
        addField(name, t(types.string), "an address parameter");
        continue;
      }
      let type: TypeRef;
      let optional = false;
      if (major === 2) {
        type =
          p.schema !== undefined
            ? (convertSchemaEntry(p.schema, undefined, `${pAt}/schema`).type ?? t(types.unknown))
            : t(types.string);
      } else {
        const schema: Obj = { type: "string" };
        if (Array.isArray(p.enum)) schema.enum = p.enum;
        if (typeof p.default === "string") {
          schema.default = p.default;
          optional = true;
        }
        if (Array.isArray(p.examples)) schema.examples = p.examples;
        type = fromJsonSchema(schema);
      }
      const extra: Obj = {};
      const pd = asString(p.description);
      if (pd !== undefined) extra.description = pd;
      if (optional) extra.optional = true;
      addField(
        name,
        Object.keys(extra).length > 0 ? withMeta(type, extra) : type,
        "an address parameter",
      );
    }
    for (const name of Object.keys(params)) {
      if (!exprNames.includes(name)) {
        diag(
          `${a.channelAt}/parameters/${escapePointer(name)}`,
          "parameter is not used in the channel address; skipped",
        );
      }
    }

    let output: TypeRef | undefined;
    if (action === "receive") {
      if (a.msgs.length === 0) {
        diag(at, "operation names no messages; it takes no payload");
      } else {
        const only = a.msgs.length === 1 ? a.msgs[0]! : undefined;
        const conv = only !== undefined ? convertMessage(only) : undefined;
        const props = conv !== undefined ? flattenObject(conv) : undefined;
        if (props !== undefined) {
          for (const [name, type] of Object.entries(props))
            addField(name, type, "a payload property");
        } else if (conv?.type !== undefined || a.msgs.length > 1) {
          addField("payload", unionOf(a.msgs), "the payload");
        }
      }
      if (a.reply !== undefined) {
        output = a.reply.msgs.length === 0 ? t(types.unknown) : unionOf(a.reply.msgs);
      } else {
        output = t(types.void);
      }
    } else {
      if (a.msgs.length === 0)
        diag(at, "operation names no messages; its stream element is unknown");
      output = t(types.stream(a.msgs.length === 0 ? t(types.unknown) : unionOf(a.msgs)));
      if (a.reply !== undefined) {
        diag(at, "a reply on a send operation is not represented in the input or output");
      }
    }

    const { publish: _p, subscribe: _s, messages: _m, ...channelRest } = channel;
    const { channel: _c, message: _m1, messages: _m2, reply: _r, ...operationRest } = a.operation;
    const asyncapi: Obj = {
      action,
      ...(major === 3 || a.operation.operationId !== undefined ? { operationId: a.key } : {}),
      channel: clone({
        ...(a.channelId !== undefined ? { id: a.channelId } : {}),
        ...(a.address !== undefined ? { address: a.address } : {}),
        ...channelRest,
      }),
      operation: clone(operationRest),
      messages: clone(a.msgs.map((m) => m.raw)),
      ...(a.reply !== undefined ? { reply: clone(a.reply.value) } : {}),
    };
    const description =
      asString(a.operation.description) ??
      asString(a.operation.summary) ??
      asString(a.operation.title);
    items.push({
      at,
      segs,
      key: a.key,
      action,
      input: t(types.object(fields)),
      ...(output !== undefined ? { output } : {}),
      meta: {
        ...(description !== undefined ? { description } : {}),
        tags: action === "send" ? { streaming: true } : {},
        asyncapi,
      },
    });
  };

  /** The payload's properties as fields when it is a plain object schema; `undefined` otherwise. */
  function flattenObject(conv: Conv): Record<string, TypeRef> | undefined {
    const r = conv.resolved;
    if (r === undefined || conv.convert === undefined || !isObj(r.properties)) return undefined;
    if (["oneOf", "anyOf", "allOf", "not", "if"].some((k) => k in r)) return undefined;
    if (r.type !== undefined && r.type !== "object") return undefined;
    const required = new Set(Array.isArray(r.required) ? (r.required as string[]) : []);
    const out: Record<string, TypeRef> = {};
    for (const [name, schema] of Object.entries(r.properties)) {
      const ty = conv.convert(schema);
      out[name] = required.has(name) ? ty : withMeta(ty, { optional: true });
    }
    return out;
  }

  const channels = isObj(doc.channels) ? doc.channels : {};

  if (major === 2) {
    for (const [name, rawItem] of Object.entries(channels)) {
      const channelAt = `#/channels/${escapePointer(name)}`;
      const channel = follow(rawItem).value;
      if (!isObj(channel)) {
        diag(channelAt, "channel could not be resolved; skipped");
        continue;
      }
      let any = false;
      for (const [dir, action] of [
        ["publish", "receive"],
        ["subscribe", "send"],
      ] as const) {
        if (channel[dir] === undefined) continue;
        any = true;
        const at = `${channelAt}/${dir}`;
        const found = follow(channel[dir]).value;
        if (!isObj(found)) {
          diag(at, "operation could not be resolved; skipped");
          continue;
        }
        const operation = withTraits(found, at);
        const m = operation.message;
        const entries =
          isObj(m) && m.$ref === undefined && Array.isArray(m.oneOf)
            ? m.oneOf.map((e, i) => [e, `${at}/message/oneOf/${i}`] as const)
            : m === undefined
              ? []
              : [[m, `${at}/message`] as const];
        const msgs = entries
          .map(([e, p]) => resolveMessage(e, p))
          .filter((x): x is Msg => x !== undefined);
        buildItem({
          at,
          action,
          key: asString(operation.operationId) ?? action,
          address: name,
          channel,
          channelAt,
          operation,
          msgs,
        });
      }
      if (!any) diag(channelAt, "channel has neither a publish nor a subscribe operation");
    }
  } else {
    const operations = isObj(doc.operations) ? doc.operations : {};
    for (const [id, rawOp] of Object.entries(operations)) {
      const at = `#/operations/${escapePointer(id)}`;
      const found = follow(rawOp).value;
      if (!isObj(found)) {
        diag(at, "operation could not be resolved; skipped");
        continue;
      }
      const operation = withTraits(found, at);
      const action = operation.action;
      if (action !== "send" && action !== "receive") {
        diag(at, `action "${String(action)}" is neither "send" nor "receive"; skipped`);
        continue;
      }
      const { value: channel, ref: channelRef } = follow(operation.channel);
      if (!isObj(channel) || channelRef === undefined) {
        diag(at, "channel could not be resolved; skipped");
        continue;
      }
      const channelKey = CHANNEL_REF.exec(channelRef)?.[1];
      const channelId = channelKey !== undefined ? unescapePointer(channelKey) : undefined;
      const channelAt = channelKey !== undefined ? channelRef : `${at}/channel`;
      if (channelId !== undefined) usedChannels.add(channelId);

      const channelMessages = (from: Obj, fromAt: string, fromId: string | undefined): Msg[] => {
        const list = isObj(from.messages) ? from.messages : {};
        const out: Msg[] = [];
        for (const [k, e] of Object.entries(list)) {
          const ptr = `${fromAt}/messages/${escapePointer(k)}`;
          if (fromId !== undefined) usedChannelMessages.add(ptr);
          const msg = resolveMessage(e, ptr);
          if (msg !== undefined) out.push(msg);
        }
        return out;
      };
      const listed = (refs: unknown[], base: string): Msg[] => {
        const out: Msg[] = [];
        refs.forEach((e, i) => {
          if (isObj(e) && typeof e.$ref === "string" && CHANNEL_MESSAGE_REF.test(e.$ref)) {
            usedChannelMessages.add(e.$ref);
          }
          const msg = resolveMessage(e, `${base}/${i}`);
          if (msg !== undefined) out.push(msg);
        });
        return out;
      };

      const msgs = Array.isArray(operation.messages)
        ? listed(operation.messages, `${at}/messages`)
        : channelMessages(channel, channelAt, channelId);

      let reply: { value: Obj; msgs: Msg[] } | undefined;
      if (operation.reply !== undefined) {
        const rv = follow(operation.reply).value;
        if (!isObj(rv)) diag(`${at}/reply`, "reply could not be resolved; skipped");
        else if (Array.isArray(rv.messages)) {
          reply = { value: rv, msgs: listed(rv.messages, `${at}/reply/messages`) };
        } else {
          const { value: rc, ref: rref } = follow(rv.channel);
          const rkey = rref !== undefined ? CHANNEL_REF.exec(rref)?.[1] : undefined;
          if (rkey !== undefined) usedChannels.add(unescapePointer(rkey));
          reply = {
            value: rv,
            msgs:
              isObj(rc) && rref !== undefined
                ? channelMessages(rc, rref, rkey !== undefined ? unescapePointer(rkey) : undefined)
                : [],
          };
        }
      }

      buildItem({
        at,
        action,
        key: id,
        ...(channelId !== undefined ? { channelId } : {}),
        address: channel.address,
        channel,
        channelAt,
        operation,
        msgs,
        ...(reply !== undefined ? { reply } : {}),
      });
    }
    for (const [id, ch] of Object.entries(channels)) {
      const at = `#/channels/${escapePointer(id)}`;
      if (!usedChannels.has(id)) {
        diag(at, "channel is not used by any operation");
        continue;
      }
      const c = follow(ch).value;
      for (const k of isObj(c) && isObj(c.messages) ? Object.keys(c.messages) : []) {
        const ptr = `${at}/messages/${escapePointer(k)}`;
        if (!usedChannelMessages.has(ptr)) diag(ptr, "message is not used by any operation");
      }
    }
  }

  // ---- addresses --------------------------------------------------------

  const sk = (segs: readonly Segment[]): string =>
    segs.map((s) => `${s.kind === "param" ? "p" : "s"}:${s.name}`).join("\u0000");
  const own = (i: Item, key = i.key): string => sk([...i.segs, { kind: "static", name: key }]);
  const shown = (i: Item): string =>
    [...i.segs, { kind: "static", name: i.key } as Segment]
      .map((s) => (s.kind === "param" ? `{${s.name}}` : s.name))
      .join("/");
  const clashes = (i: Item, key: string, earlierOnly: boolean): boolean => {
    const mine = own(i, key);
    return items.some((o, idx) => {
      if (o === i) return false;
      const theirs = own(o);
      if (theirs === mine) return !earlierOnly || idx < items.indexOf(i);
      return (
        theirs.startsWith(`${mine}\u0000`) || (!earlierOnly && mine.startsWith(`${theirs}\u0000`))
      );
    });
  };
  for (let pass = 0; pass <= items.length; pass++) {
    let changed = false;
    for (const item of items) {
      if (!clashes(item, item.key, true)) continue;
      const before = shown(item);
      const candidates = [`${item.key}-${item.action}`];
      for (let n = 2; n < items.length + 3; n++) candidates.push(`${item.key}-${n}`);
      const next = candidates.find((c) => !clashes(item, c, false));
      if (next === undefined) continue;
      item.key = next;
      changed = true;
      diag(
        item.at,
        `address "${before}" is taken or is another operation's parent; keyed "${next}"`,
      );
    }
    if (!changed) break;
  }

  const operations: Operation[] = items.map((i) => ({
    address: [...i.segs, { kind: "static", name: i.key }],
    input: i.input,
    ...(i.output !== undefined ? { output: i.output } : {}),
    meta: i.meta,
  }));

  for (const ref of pendingRefs) {
    if (!schemaNames.has(ref.name)) {
      diag(ref.at, `reference to "#/components/schemas/${ref.name}", which is not defined`);
    }
  }

  // ---- document-level ---------------------------------------------------

  const info = isObj(doc.info) ? doc.info : {};
  const rootMeta: Obj = {};
  const infoDescription = asString(info.description);
  if (infoDescription !== undefined) rootMeta.description = infoDescription;
  const { schemas: _sc, messages: _ms, ...otherComponents } = components;
  const asyncapi: Obj = {
    version: doc.asyncapi,
    ...(doc.info !== undefined ? { info: clone(doc.info) } : {}),
    ...(doc.id !== undefined ? { id: doc.id } : {}),
    ...(doc.servers !== undefined ? { servers: clone(doc.servers) } : {}),
    ...(doc.defaultContentType !== undefined ? { defaultContentType: doc.defaultContentType } : {}),
    ...(doc.tags !== undefined ? { tags: clone(doc.tags) } : {}),
    ...(doc.externalDocs !== undefined ? { externalDocs: clone(doc.externalDocs) } : {}),
    ...(Object.keys(otherComponents).length > 0 ? { components: clone(otherComponents) } : {}),
  };
  rootMeta.asyncapi = asyncapi;
  const groups: Group[] = [{ address: [], meta: rootMeta }];

  const api: ApiDescription = { operations, groups, defs };
  const title = asString(info.title);
  const infoVersion = asString(info.version);
  return {
    api,
    diagnostics,
    version: doc.asyncapi as string,
    info: {
      ...(title !== undefined ? { title } : {}),
      ...(infoVersion !== undefined ? { version: infoVersion } : {}),
    },
  };
}
