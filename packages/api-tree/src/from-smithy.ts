// Smithy 2.0 JSON AST (the `smithy build` "model" projection output) ->
// ApiDescription.
//
// Addressing: services -> resources -> operations. A resource is a static
// segment (its shape name, lower-camel-cased) and its own identifiers (those
// not already bound by a parent resource) are param segments after it, in
// declaration order. An operation's address is its owner's address followed by
// its own key:
//   - instance lifecycle operations (`put`, `read`, `update`, `delete`) and
//     `operations` sit below the identifier segments;
//   - collection lifecycle operations (`create`, `list`) and
//     `collectionOperations` sit at the resource segment, above them;
//   - the key of a lifecycle operation is its role name, any other operation's
//     key is its lower-camel-cased shape name (kept as `meta.openapi.operationId`
//     and `meta.smithy.id` either way);
//   - service-level operations sit at the service root.
// A key that would collide with a sibling operation or with a group position
// falls back to the operation's own name (then a numeric suffix) and is
// reported. An operation bound in several places appears at each. When a model
// holds several services (and no `service` option picks one) each service gets
// its own top-level segment.
//
// Input: the input structure's members as one named-params object, identifier
// members included (they are the param segments' values). Output: a reference
// to the output structure; `void` for `Unit` or an empty structure. A
// `@streaming` member (event stream union, or blob) that is the whole of the
// output makes the output `stream(element)`; otherwise it is a `stream` typed
// field of an inline object. A `@paginated` operation whose output is only its
// `items` list and output token becomes `page(element, "cursor")`.
//
// Metadata: `@documentation` -> `meta.description`; `@readonly`,
// `@idempotent`, `@deprecated`, `@streaming` -> `meta.tags`; `@tags` ->
// `meta.openapi.tags`; the shape name -> `meta.openapi.operationId`.
//
// HTTP: `meta.http` is written only when it is exact, i.e. the operation's
// address (minus its own key) is precisely the `@http` uri path (a literal
// segment is a static segment, `{label}` is the param segment of that name)
// and every input member has a binding `sourceMap` can state (`@httpLabel`,
// `@httpQuery`, `@httpHeader`, else the JSON body, keyed by `@jsonName`).
// Anything else (an address that does not mirror the uri, a greedy label, a
// literal query string, `@httpPayload`, `@httpQueryParams`,
// `@httpPrefixHeaders`) keeps the `@http` trait verbatim under
// `meta.smithy.http` and adds a diagnostic; `meta.http` is then absent.
//
// Everything else the model says about an operation, resource or service that
// has no counterpart here is kept verbatim: unmapped traits under
// `meta.smithy.traits[traitShapeId]`, `errors` (the operation's then the
// service's) under `meta.smithy.errors`, `@paginated` (service-level merged
// under operation-level) under `meta.smithy.paginated`.
//
// Spec references: Smithy 2.0 specification: JSON AST; Service (§ "Service
// shape", `version`, `rename`, `errors`); Resource (§ "Resource shape":
// `identifiers`, lifecycle operations `create`/`put`/`read`/`update`/`delete`/
// `list`, `operations`, `collectionOperations`, `resources`); Operation
// (§ "Operation shape"); traits @http, @httpLabel, @httpQuery, @httpHeader,
// @httpPayload, @httpQueryParams, @httpPrefixHeaders (§ "HTTP binding
// traits"), @readonly, @idempotent, @deprecated, @paginated, @streaming,
// @tags, @documentation, @error. RFC 3986 §3.3 (path segments).

import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir";
import {
  fromSmithy,
  smithyShapeName,
  SMITHY_PRELUDE,
  type SmithyMember,
  type SmithyModel,
  type SmithyShape,
  type SmithyTypes,
} from "@rhi-zone/fractal-type-ir/from-smithy";
import {
  addressKey,
  type Diagnostic,
  type Group,
  type Imported,
  type Operation,
  type Segment,
} from "./api-description.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type SmithyImportOptions = {
  /** The service to import: an absolute shape id (`ns#Name`) or a bare name. Omitted: every service in the model. */
  readonly service?: string;
};

const T = (name: string): string => `${SMITHY_PRELUDE}${name}`;
const TRAITS = {
  documentation: T("documentation"),
  readonly: T("readonly"),
  idempotent: T("idempotent"),
  deprecated: T("deprecated"),
  paginated: T("paginated"),
  http: T("http"),
  tags: T("tags"),
  streaming: T("streaming"),
  httpLabel: T("httpLabel"),
  httpQuery: T("httpQuery"),
  httpHeader: T("httpHeader"),
  httpPayload: T("httpPayload"),
  httpQueryParams: T("httpQueryParams"),
  httpPrefixHeaders: T("httpPrefixHeaders"),
  jsonName: T("jsonName"),
  required: T("required"),
} as const;

const OPERATION_CONSUMED: ReadonlySet<string> = new Set([
  TRAITS.documentation,
  TRAITS.readonly,
  TRAITS.idempotent,
  TRAITS.deprecated,
  TRAITS.paginated,
  TRAITS.http,
  TRAITS.tags,
]);

const INSTANCE_ROLES = ["put", "read", "update", "delete"] as const;
const COLLECTION_ROLES = ["create", "list"] as const;

/** `GetCity` -> `getCity`, `URLShortener` -> `urlShortener`. */
const lowerCamel = (name: string): string =>
  name.replace(/^[A-Z]+(?=[A-Z][a-z])|^[A-Z]/, (m) => m.toLowerCase());

const targetOf = (v: unknown): string | undefined =>
  isObj(v) && typeof v.target === "string" ? v.target : undefined;

const targetsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((e) => targetOf(e) ?? []) : [];

const isUnit = (id: string | undefined): boolean => id === undefined || id === T("Unit");

const withoutConsumed = (traits: Obj | undefined, consumed: ReadonlySet<string>): Obj => {
  const out: Obj = {};
  for (const [id, v] of Object.entries(traits ?? {})) if (!consumed.has(id)) out[id] = v;
  return out;
};

type ServiceCtx = {
  readonly id: string;
  readonly shape: SmithyShape;
  readonly errors: readonly string[];
  readonly paginated: Obj | undefined;
};

type Pending = {
  readonly opId: string;
  readonly base: readonly Segment[];
  readonly preferred: string;
  readonly service: ServiceCtx;
  /** Identifier names bound by the segments above this operation. */
  readonly identifiers: readonly string[];
};

type HttpTrait = { method?: unknown; uri?: unknown; code?: unknown };

export function fromSmithyModel(input: unknown, opts: SmithyImportOptions = {}): Imported {
  if (!isObj(input) || !isObj(input.shapes)) {
    throw new Error("fromSmithyModel: model must be a JSON AST object with a `shapes` map");
  }
  const model = input as SmithyModel;
  const shapes = model.shapes as Readonly<Record<string, SmithyShape>>;
  const conv: SmithyTypes = fromSmithy(model);
  const diagnostics: Diagnostic[] = [];
  const diag = (at: string, message: string): void => {
    diagnostics.push({ at, message });
  };

  const serviceIds = Object.keys(shapes).filter((id) => shapes[id]!.type === "service");
  let chosen = serviceIds;
  if (opts.service !== undefined) {
    chosen = serviceIds.filter((id) => id === opts.service || smithyShapeName(id) === opts.service);
    if (chosen.length === 0) {
      throw new Error(`fromSmithyModel: no service "${opts.service}" in the model`);
    }
  }
  if (chosen.length === 0) diag("", "the model has no service shape; only its types were imported");

  const groups: Group[] = [];
  const pendings: Pending[] = [];
  const emitted = new Set<string>();
  const multi = chosen.length > 1;

  const modelMeta: Obj = {};
  if (typeof model.smithy === "string") modelMeta.modelVersion = model.smithy;
  if (isObj(model.metadata) && Object.keys(model.metadata).length > 0) {
    modelMeta.metadata = model.metadata;
  }
  if (multi && Object.keys(modelMeta).length > 0) {
    groups.push({ address: [], meta: { smithy: modelMeta } });
  }

  const requireShape = (id: string, type: string, at: string): SmithyShape | undefined => {
    const shape = shapes[id];
    if (shape === undefined || shape.type !== type) {
      diag(at, `"${id}" is not a ${type} shape in the model; skipped`);
      return undefined;
    }
    return shape;
  };

  const walkResource = (
    resId: string,
    parent: readonly Segment[],
    bound: readonly string[],
    service: ServiceCtx,
    chain: ReadonlySet<string>,
    at: string,
  ): void => {
    if (chain.has(resId)) {
      diag(at, `resource "${resId}" contains itself; skipped`);
      return;
    }
    const res = requireShape(resId, "resource", at);
    if (res === undefined) return;

    const identifiers = isObj(res.identifiers) ? Object.keys(res.identifiers) : [];
    const own = identifiers.filter((n) => !bound.includes(n));
    const collection: readonly Segment[] = [
      ...parent,
      { kind: "static", name: lowerCamel(smithyShapeName(resId)) },
    ];
    const instance: readonly Segment[] = [
      ...collection,
      ...own.map((name): Segment => ({ kind: "param", name })),
    ];
    const allBound = [...bound, ...own];

    const meta: Obj = {};
    const description = res.traits?.[TRAITS.documentation];
    if (typeof description === "string") meta.description = description;
    const smithy: Obj = { id: resId };
    if (identifiers.length > 0) {
      smithy.identifiers = Object.fromEntries(
        identifiers.map((n) => [n, targetOf((res.identifiers as Obj)[n]) ?? null]),
      );
    }
    if (isObj(res.properties)) smithy.properties = res.properties;
    const traits = withoutConsumed(res.traits, new Set([TRAITS.documentation]));
    if (Object.keys(traits).length > 0) smithy.traits = traits;
    groups.push({ address: collection, meta: { ...meta, smithy } });

    const queue = (
      opId: string | undefined,
      base: readonly Segment[],
      preferred: string,
      ids: readonly string[],
    ): void => {
      if (opId === undefined) return;
      const dedupe = `${opId}@${addressKey(base)}`;
      if (emitted.has(dedupe)) return;
      emitted.add(dedupe);
      pendings.push({ opId, base, preferred, service, identifiers: ids });
    };

    for (const role of COLLECTION_ROLES) queue(targetOf(res[role]), collection, role, bound);
    for (const op of targetsOf(res.collectionOperations)) {
      queue(op, collection, lowerCamel(smithyShapeName(op)), bound);
    }
    for (const role of INSTANCE_ROLES) queue(targetOf(res[role]), instance, role, allBound);
    for (const op of targetsOf(res.operations)) {
      queue(op, instance, lowerCamel(smithyShapeName(op)), allBound);
    }

    const nextChain = new Set(chain).add(resId);
    for (const child of targetsOf(res.resources)) {
      walkResource(child, instance, allBound, service, nextChain, `${resId}`);
    }
  };

  for (const serviceId of chosen) {
    const shape = shapes[serviceId]!;
    const prefix: readonly Segment[] = multi
      ? [{ kind: "static", name: lowerCamel(smithyShapeName(serviceId)) }]
      : [];
    const paginated = shape.traits?.[TRAITS.paginated];
    const service: ServiceCtx = {
      id: serviceId,
      shape,
      errors: targetsOf(shape.errors),
      paginated: isObj(paginated) ? paginated : undefined,
    };

    const meta: Obj = {};
    const description = shape.traits?.[TRAITS.documentation];
    if (typeof description === "string") meta.description = description;
    const smithy: Obj = { id: serviceId };
    if (typeof shape.version === "string") smithy.version = shape.version;
    if (!multi) Object.assign(smithy, modelMeta);
    if (isObj(shape.rename) && Object.keys(shape.rename).length > 0) {
      smithy.rename = shape.rename;
      diag(serviceId, "`rename` is kept in meta.smithy but not applied to type names");
    }
    if (service.errors.length > 0) smithy.errors = service.errors;
    const traits = withoutConsumed(shape.traits, new Set([TRAITS.documentation]));
    if (Object.keys(traits).length > 0) smithy.traits = traits;
    groups.push({ address: prefix, meta: { ...meta, smithy } });

    for (const op of targetsOf(shape.operations)) {
      const dedupe = `${op}@${addressKey(prefix)}`;
      if (emitted.has(dedupe)) continue;
      emitted.add(dedupe);
      pendings.push({
        opId: op,
        base: prefix,
        preferred: lowerCamel(smithyShapeName(op)),
        service,
        identifiers: [],
      });
    }
    for (const res of targetsOf(shape.resources)) {
      walkResource(res, prefix, [], service, new Set(), serviceId);
    }
  }

  // Positions that hold children: an operation may not take one of these keys.
  const branches = new Set<string>();
  const addBranch = (address: readonly Segment[]): void => {
    for (let i = 0; i <= address.length; i++) branches.add(addressKey(address.slice(0, i)));
  };
  for (const g of groups) addBranch(g.address);
  for (const p of pendings) addBranch(p.base);

  const takenOps = new Set<string>();
  const operations: Operation[] = [];
  let anyErrors = false;

  for (const p of pendings) {
    const opShape = requireShape(p.opId, "operation", p.opId);
    if (opShape === undefined) continue;
    const name = smithyShapeName(p.opId);
    const candidates = [p.preferred, lowerCamel(name), `${lowerCamel(name)}Op`];
    let key: string | undefined;
    for (const c of candidates) {
      const k = addressKey([...p.base, { kind: "static", name: c }]);
      if (!takenOps.has(k) && !branches.has(k)) {
        key = c;
        break;
      }
    }
    for (let n = 2; key === undefined; n++) {
      const c = `${lowerCamel(name)}${n}`;
      const k = addressKey([...p.base, { kind: "static", name: c }]);
      if (!takenOps.has(k) && !branches.has(k)) key = c;
    }
    if (key !== p.preferred) {
      diag(p.opId, `key "${p.preferred}" is taken at this position; operation keyed "${key}"`);
    }
    const address: Segment[] = [...p.base, { kind: "static", name: key }];
    takenOps.add(addressKey(address));

    const built = buildOperation(p, opShape, address);
    if (built.hasErrors) anyErrors = true;
    operations.push(built.operation);
  }

  if (anyErrors) {
    diag("", "operation errors are kept as ids under meta.smithy.errors and are not projected");
  }

  function buildOperation(
    p: Pending,
    op: SmithyShape,
    address: readonly Segment[],
  ): { operation: Operation; hasErrors: boolean } {
    const at = p.opId;
    const tags: Obj = {};
    const traits = op.traits ?? {};
    if (traits[TRAITS.readonly] !== undefined) tags.readOnly = true;
    if (traits[TRAITS.idempotent] !== undefined) tags.idempotent = true;
    if (traits[TRAITS.deprecated] !== undefined) tags.deprecated = true;

    // Input.
    const inputId = targetOf(op.input);
    let inputFields: Record<string, TypeRef> = {};
    let inputMembers: Readonly<Record<string, SmithyMember>> = {};
    if (!isUnit(inputId)) {
      if (conv.typeOf(inputId!) === "structure") {
        inputFields = conv.fields(inputId!);
        inputMembers = conv.members(inputId!);
      } else diag(at, `input "${inputId}" is not a structure in the model; treated as no input`);
    }
    for (const name of p.identifiers) {
      if (!(name in inputFields)) {
        diag(at, `identifier "${name}" has no matching member in the input`);
      }
    }
    let streamedInput = false;
    for (const [name, member] of Object.entries(inputMembers)) {
      if (isStreaming(member)) {
        inputFields[name] = streamField(inputFields[name]!);
        streamedInput = true;
      }
    }
    if (streamedInput) {
      tags.streaming = true;
      diag(at, "an input event stream is kept as a stream-typed input field");
    }

    // Output.
    const outputId = targetOf(op.output);
    let output: TypeRef | undefined;
    let outputStreams = false;
    const paginated: Obj | undefined =
      p.service.paginated !== undefined || isObj(traits[TRAITS.paginated])
        ? {
            ...p.service.paginated,
            ...(isObj(traits[TRAITS.paginated]) ? (traits[TRAITS.paginated] as Obj) : {}),
          }
        : undefined;
    if (isUnit(outputId)) output = t(types.void);
    else if (conv.typeOf(outputId!) !== "structure") {
      diag(at, `output "${outputId}" is not a structure in the model; output left unknown`);
    } else {
      const members = conv.members(outputId!);
      const names = Object.keys(members);
      const streaming = names.filter((n) => isStreaming(members[n]!));
      if (names.length === 0) output = t(types.void);
      else if (streaming.length > 0) {
        outputStreams = true;
        const fields = conv.fields(outputId!);
        for (const n of streaming) fields[n] = streamField(fields[n]!);
        if (names.length === 1) {
          const { optional: _optional, ...meta } = fields[names[0]!]!.meta;
          output = { shape: fields[names[0]!]!.shape, meta };
        } else output = t(types.object(fields));
      } else {
        output = pageOutput(outputId!, members, paginated, at) ?? refTo(outputId!, at);
      }
    }
    if (outputStreams) tags.streaming = true;

    // Metadata.
    const meta: Obj = {};
    const description = traits[TRAITS.documentation];
    if (typeof description === "string") meta.description = description;
    meta.tags = tags;
    const openapi: Obj = { operationId: smithyShapeName(p.opId) };
    const opTags = traits[TRAITS.tags];
    if (Array.isArray(opTags) && opTags.every((x) => typeof x === "string")) openapi.tags = opTags;
    meta.openapi = openapi;

    const smithy: Obj = { id: p.opId };
    if (isObj(traits[TRAITS.deprecated])) smithy.deprecated = traits[TRAITS.deprecated];
    if (paginated !== undefined) smithy.paginated = paginated;
    const errors = [...targetsOf(op.errors), ...p.service.errors];
    if (errors.length > 0) smithy.errors = errors;
    const rest = withoutConsumed(traits, OPERATION_CONSUMED);
    if (Object.keys(rest).length > 0) smithy.traits = rest;

    const httpTrait = traits[TRAITS.http];
    if (isObj(httpTrait)) {
      const bound = bindHttp(httpTrait, address, inputMembers);
      if (bound.ok) {
        meta.http = bound.http;
        if (typeof httpTrait.code === "number" && httpTrait.code !== 200) {
          smithy.http = { code: httpTrait.code };
        }
      } else {
        smithy.http = httpTrait;
        diag(at, `@http binding kept under meta.smithy.http: ${bound.reason}`);
      }
    }
    meta.smithy = smithy;

    return {
      operation: {
        address,
        input: t(types.object(inputFields)),
        ...(output !== undefined ? { output } : {}),
        meta,
      },
      hasErrors: errors.length > 0,
    };
  }

  function isStreaming(member: SmithyMember): boolean {
    return conv.shape(member.target)?.traits?.[TRAITS.streaming] !== undefined;
  }

  function streamField(field: TypeRef): TypeRef {
    const { optional, ...rest } = field.meta;
    return t(types.stream({ shape: field.shape, meta: {} }), {
      ...rest,
      ...(optional !== undefined ? { optional } : {}),
    });
  }

  function refTo(id: string, at: string): TypeRef | undefined {
    const key = conv.keys[id];
    if (key === undefined) {
      diag(at, `output "${id}" is not a data shape in the model; output left unknown`);
      return undefined;
    }
    return t(types.ref(key));
  }

  // `@paginated` -> `page` only when the output is nothing but the items list
  // and the output token, so no other member is dropped.
  function pageOutput(
    outputId: string,
    members: Readonly<Record<string, SmithyMember>>,
    paginated: Obj | undefined,
    at: string,
  ): TypeRef | undefined {
    if (paginated === undefined) return undefined;
    const items = paginated.items;
    if (typeof items !== "string") return undefined;
    const outputToken =
      typeof paginated.outputToken === "string" ? paginated.outputToken : undefined;
    const itemsMember = members[items];
    const list = itemsMember !== undefined ? conv.shape(itemsMember.target) : undefined;
    if (
      list === undefined ||
      (list.type !== "list" && list.type !== "set") ||
      list.member === undefined
    ) {
      diag(
        at,
        `@paginated items "${items}" is not a list member of the output; page kind not used`,
      );
      return undefined;
    }
    const others = Object.keys(members).filter((n) => n !== items && n !== outputToken);
    if (others.length > 0) {
      diag(
        at,
        `@paginated output "${outputId}" has members besides items and the output token (${others.join(", ")}); page kind not used`,
      );
      return undefined;
    }
    return t(types.page(conv.memberType(list.member, `${itemsMember!.target}$member`), "cursor"));
  }

  return {
    api: { operations, groups, defs: conv.defs },
    diagnostics: [...diagnostics, ...conv.diagnostics],
  };
}

type HttpBinding =
  | { readonly ok: true; readonly http: Obj }
  | { readonly ok: false; readonly reason: string };

/** The `meta.http` for `httpTrait` if `address` mirrors its uri exactly and every input member's store is expressible; otherwise why not. */
function bindHttp(
  httpTrait: HttpTrait,
  address: readonly Segment[],
  members: Readonly<Record<string, SmithyMember>>,
): HttpBinding {
  const { method, uri } = httpTrait;
  if (typeof method !== "string" || typeof uri !== "string") {
    return { ok: false, reason: "method or uri is not a string" };
  }
  const [path = "", query] = uri.split("?", 2) as [string, string | undefined];
  if (query !== undefined && query.length > 0) {
    return { ok: false, reason: "the uri has literal query parameters" };
  }
  const want: Segment[] = [];
  for (const raw of path.split("/").filter((s) => s.length > 0)) {
    const label = /^\{([^{}+]+)\}$/.exec(raw);
    if (label) want.push({ kind: "param", name: label[1]! });
    else if (raw.includes("{")) {
      return { ok: false, reason: `uri segment "${raw}" is a greedy or mixed label` };
    } else want.push({ kind: "static", name: raw });
  }
  const have = address.slice(0, -1);
  const mirrors =
    want.length === have.length &&
    want.every((s, i) => s.kind === have[i]!.kind && s.name === have[i]!.name);
  if (!mirrors) {
    return {
      ok: false,
      reason: `address "${addressKey(address)}" does not mirror uri "${uri}"`,
    };
  }

  const sourceMap: Record<string, { store: string; key?: string }> = {};
  const labels = new Set<string>();
  for (const [name, member] of Object.entries(members)) {
    const traits = member.traits ?? {};
    if (traits[TRAITS.httpPayload] !== undefined) {
      return { ok: false, reason: `member "${name}" is the @httpPayload` };
    }
    if (traits[TRAITS.httpQueryParams] !== undefined) {
      return { ok: false, reason: `member "${name}" is @httpQueryParams` };
    }
    if (traits[TRAITS.httpPrefixHeaders] !== undefined) {
      return { ok: false, reason: `member "${name}" is @httpPrefixHeaders` };
    }
    const store = (s: string, key: unknown): { store: string; key?: string } =>
      typeof key === "string" && key !== name ? { store: s, key } : { store: s };
    if (traits[TRAITS.httpLabel] !== undefined) {
      labels.add(name);
      sourceMap[name] = { store: "path" };
    } else if (traits[TRAITS.httpQuery] !== undefined) {
      sourceMap[name] = store("query", traits[TRAITS.httpQuery]);
    } else if (traits[TRAITS.httpHeader] !== undefined) {
      sourceMap[name] = store("header", traits[TRAITS.httpHeader]);
    } else {
      sourceMap[name] = store("body", traits[TRAITS.jsonName]);
    }
  }
  const wantLabels = want.flatMap((s) => (s.kind === "param" ? [s.name] : []));
  if (wantLabels.length !== labels.size || wantLabels.some((n) => !labels.has(n))) {
    return { ok: false, reason: "the uri labels and the @httpLabel members differ" };
  }
  return { ok: true, http: { method: method.toUpperCase(), moveTo: "..", sourceMap } };
}
