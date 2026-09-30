// Protobuf source (`.proto`, proto3 and explicit proto2) -> ApiDescription: each
// `rpc` of each `service` becomes an operation; messages and enums become
// `defs` through type-ir's protobuf ingester.
//
// Addressing: `[...package segments, Service, Method]`, so the address spells
// the gRPC method path `/pkg.Service/Method` and two files with different
// packages never collide under `concatApi`. A file without a `package`
// yields `[Service, Method]`. Each service also gets a group at
// `[...package segments, Service]` carrying its doc comment and options.
//
// Input: the request message's fields as the named-params object. A request
// that is `google.protobuf.Empty` is an empty object. A request that resolves
// to a well-known non-message type (a wrapper, `Timestamp`, ...) has no
// fields to lift, so it becomes one field named `request`
// (`meta.grpc.requestField`), with a diagnostic.
//
// Output: the response message as a `ref` into `defs` (`google.protobuf.Empty`
// is `void`, other well-known types are their type-ir mapping). A
// server-streaming response is `stream(response)` and `meta.tags.streaming`.
//
// Client-streaming and bidirectional rpcs are skipped with a diagnostic: an
// operation's input is one named-params object and the tree has no way to
// say "a stream of these".
//
// Meta: `description` (the rpc's comment); `tags.readOnly`/`idempotent` from
// `idempotency_level`, `tags.deprecated` from `deprecated = true`,
// `tags.streaming` from a streamed response. Everything protobuf-specific goes
// under `meta.grpc`: `{ package?, service, method, requestType, responseType,
// requestStream?, responseStream?, requestField?, options?, http? }`, the type
// names fully qualified (`pkg.Message`) as written on the wire. `options` holds
// every other rpc option verbatim; `http` holds the `google.api.http` HttpRule
// verbatim (including `additional_bindings`). `meta.http` is never set: http
// `moveTo` cannot place a package/service/method address at an arbitrary URL.
//
// Types: an imported file's types are not loaded; a reference to one is left
// as a dangling `ref` in `defs` and diagnosed. In a proto2 file, a
// non-repeated field without `required` carries `meta.optional`.
//
// Spec references: Protocol Buffers Language Guide (proto3) "Defining
// Services" and "Packages" / "Name resolution" (protobuf.dev/programming-guides/proto3);
// Language Guide (proto2) "Specifying Field Rules" (protobuf.dev/programming-guides/proto2);
// descriptor.proto `MethodOptions.IdempotencyLevel` and `ServiceOptions`/
// `MethodOptions.deprecated`; google/api/http.proto `HttpRule` (gRPC
// transcoding, `google.api.http`); gRPC core concepts, RPC life cycle
// (grpc.io/docs/what-is-grpc/core-concepts) for the four streaming kinds.

import protobuf from "protobufjs";
import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { fromProtoField, fromProtoText } from "@rhi-zone/fractal-type-ir/from-protobuf";
import {
  noInput,
  type ApiDescription,
  type Diagnostic,
  type Group,
  type Imported,
  type Operation,
  type Segment,
} from "./api-description.ts";
import { reachableDefs } from "./lower.ts";

type Obj = Record<string, unknown>;

type Options = { readonly parsedOptions?: readonly Obj[] | undefined };

/** Every option in declaration order as one record; an option set more than once collects into an array. */
function optionsOf(node: Options): Obj {
  const out: Obj = {};
  for (const entry of node.parsedOptions ?? []) {
    for (const [key, value] of Object.entries(entry)) {
      const prior = out[key];
      if (key in out) out[key] = Array.isArray(prior) ? [...prior, value] : [prior, value];
      else out[key] = value;
    }
  }
  return out;
}

const HTTP_OPTION = "(google.api.http)";

const asComment = (c: string | null | undefined): string | undefined => {
  const trimmed = c?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** Every `Service` under `ns`, descending through package namespaces (never into messages). */
function collectServices(
  ns: protobuf.NamespaceBase,
  out: protobuf.Service[] = [],
): protobuf.Service[] {
  for (const node of ns.nestedArray) {
    if (node instanceof protobuf.Service) out.push(node);
    else if (node instanceof protobuf.Namespace && !(node instanceof protobuf.Type)) {
      collectServices(node, out);
    }
  }
  return out;
}

/** Every message `Type` under `ns`, nested ones included. */
function collectTypes(ns: protobuf.NamespaceBase, out: protobuf.Type[] = []): protobuf.Type[] {
  for (const node of ns.nestedArray) {
    if (node instanceof protobuf.Type) {
      out.push(node);
      collectTypes(node, out);
    } else if (node instanceof protobuf.Namespace) collectTypes(node, out);
  }
  return out;
}

const isProto2 = (source: string): boolean => /^\s*syntax\s*=\s*["']proto2["']/m.test(source);

/**
 * Parse `source` (which may declare `syntax = "proto2"`; a file with no
 * `syntax` statement is read as proto3) and import its services.
 * Throws when `source` is not parseable `.proto` text.
 */
export function fromProtobufSource(source: string): Imported {
  const diagnostics: Diagnostic[] = [];
  const defs: Record<string, TypeRef> = { ...fromProtoText(source).defs };

  const withSyntax = /^\s*syntax\s*=/m.test(source) ? source : `syntax = "proto3";\n${source}`;
  const parsed = protobuf.parse(withSyntax, { keepCase: true, alternateCommentMode: true });
  const pkg = parsed.package ?? "";
  const pkgSegments: Segment[] =
    pkg === "" ? [] : pkg.split(".").map((name) => ({ kind: "static", name }));

  // A def key is its dotted path without the package; the wire name is `pkg.key`.
  const wireName = (key: string): string => (pkg === "" ? key : `${pkg}.${key}`);
  const keyOfWire = new Map(Object.keys(defs).map((k) => [wireName(k), k] as const));

  if (isProto2(source)) {
    for (const type of collectTypes(parsed.root)) {
      const key = keyOfWire.get(type.fullName.slice(1));
      const def = key === undefined ? undefined : defs[key];
      if (key === undefined || def === undefined || def.shape.kind !== "object") continue;
      const fields: Record<string, TypeRef> = { ...def.shape.fields };
      for (const f of type.fieldsArray) {
        const current = fields[f.name];
        if (current === undefined || f instanceof protobuf.MapField) continue;
        if (f.repeated || f.partOf !== null || f.rule === "required") continue;
        fields[f.name] = { shape: current.shape, meta: { ...current.meta, optional: true } };
      }
      defs[key] = { shape: t(types.object(fields)).shape, meta: def.meta };
    }
  }

  type Resolved =
    | { readonly kind: "def"; readonly key: string; readonly wire: string }
    | { readonly kind: "known"; readonly type: TypeRef; readonly wire: string }
    | { readonly kind: "missing"; readonly wire: string };

  // Name resolution: a leading dot is absolute; otherwise the innermost
  // enclosing scope (the package, then each parent prefix, then the root)
  // that declares the name wins.
  const resolve = (raw: string): Resolved => {
    const scopes: string[][] = [];
    if (raw.startsWith(".")) scopes.push([]);
    else {
      const parts = pkg === "" ? [] : pkg.split(".");
      for (let i = parts.length; i >= 0; i--) scopes.push(parts.slice(0, i));
    }
    const bare = raw.replace(/^\./, "");
    for (const scope of scopes) {
      const wire = [...scope, bare].join(".");
      const key = keyOfWire.get(wire);
      if (key !== undefined) return { kind: "def", key, wire };
      if (wire.startsWith("google.protobuf.")) {
        const type = fromProtoField({
          name: "_",
          number: 1,
          type: "TYPE_MESSAGE",
          typeName: wire,
        });
        if (type.shape.kind !== "ref") return { kind: "known", type, wire };
      }
    }
    return { kind: "missing", wire: bare };
  };

  const operations: Operation[] = [];
  const groups: Group[] = [];

  for (const service of collectServices(parsed.root)) {
    const serviceAddress: Segment[] = [...pkgSegments, { kind: "static", name: service.name }];
    const serviceOptions = optionsOf(service);
    const serviceDescription = asComment(service.comment);
    groups.push({
      address: serviceAddress,
      meta: {
        ...(serviceDescription !== undefined ? { description: serviceDescription } : {}),
        grpc: {
          ...(pkg !== "" ? { package: pkg } : {}),
          service: service.name,
          ...(Object.keys(serviceOptions).length > 0 ? { options: serviceOptions } : {}),
        },
      },
    });

    for (const method of service.methodsArray) {
      const at = `${pkg === "" ? "" : `${pkg}.`}${service.name}/${method.name}`;
      const requestStream = method.requestStream === true;
      const responseStream = method.responseStream === true;
      if (requestStream) {
        diagnostics.push({
          at,
          message: `${responseStream ? "bidirectional" : "client"}-streaming rpc skipped: an operation's input is one named-params object and the tree has no stream-of-input type; supporting it needs an input-side stream kind plus a convention for projectors to consume it`,
        });
        continue;
      }

      const request = resolve(method.requestType);
      const response = resolve(method.responseType);
      for (const [role, r, raw] of [
        ["request", request, method.requestType],
        ["response", response, method.responseType],
      ] as const) {
        if (r.kind === "missing") {
          diagnostics.push({
            at,
            message: `${role} type "${raw}" is not declared in this source (imported files are not loaded); ${role === "request" ? "input is empty" : "output is unknown"}`,
          });
        }
      }

      let input: TypeRef = noInput();
      let requestField: string | undefined;
      if (request.kind === "def") {
        const def = defs[request.key];
        if (def !== undefined && def.shape.kind === "object") {
          input = t(types.object({ ...def.shape.fields }));
        } else {
          requestField = "request";
          input = t(types.object({ request: t(types.ref(request.key)) }));
          diagnostics.push({
            at,
            message: `request type "${request.wire}" is not a message; input is one field "request"`,
          });
        }
      } else if (request.kind === "known" && request.type.shape.kind !== "void") {
        requestField = "request";
        input = t(types.object({ request: request.type }));
        diagnostics.push({
          at,
          message: `request type "${request.wire}" is a well-known non-message mapping; input is one field "request"`,
        });
      }

      let output: TypeRef | undefined;
      if (response.kind === "def") output = t(types.ref(response.key));
      else if (response.kind === "known") output = response.type;
      if (output !== undefined && responseStream) output = t(types.stream(output));

      const options = optionsOf(method);
      const http = options[HTTP_OPTION];
      delete options[HTTP_OPTION];
      if (http !== undefined) {
        diagnostics.push({
          at,
          message:
            'google.api.http binding kept verbatim at meta.grpc.http and not mapped to meta.http: the operation is addressed by package/service/method, and http moveTo is relative with wildcards named "param", so it cannot place the operation at the bound URL',
        });
      }

      const level = options.idempotency_level;
      const tags: Obj = {
        ...(level === "NO_SIDE_EFFECTS" ? { readOnly: true } : {}),
        ...(level === "NO_SIDE_EFFECTS" || level === "IDEMPOTENT" ? { idempotent: true } : {}),
        ...(options.deprecated === true ? { deprecated: true } : {}),
        ...(responseStream ? { streaming: true } : {}),
      };
      const description = asComment(method.comment);

      operations.push({
        address: [...serviceAddress, { kind: "static", name: method.name }],
        input,
        ...(output !== undefined ? { output } : {}),
        meta: {
          ...(description !== undefined ? { description } : {}),
          ...(Object.keys(tags).length > 0 ? { tags } : {}),
          grpc: {
            ...(pkg !== "" ? { package: pkg } : {}),
            service: service.name,
            method: method.name,
            requestType: request.wire,
            responseType: response.wire,
            ...(responseStream ? { responseStream: true } : {}),
            ...(requestField !== undefined ? { requestField } : {}),
            ...(Object.keys(options).length > 0 ? { options } : {}),
            ...(http !== undefined ? { http } : {}),
          },
        },
      });
    }
  }

  for (const name of [...reachableDefs(Object.values(defs), defs)].sort()) {
    if (defs[name] === undefined) {
      diagnostics.push({
        at: name,
        message: `type "${name}" is referenced but not declared in this source (imported files are not loaded); its ref is dangling`,
      });
    }
  }

  const api: ApiDescription = { operations, groups, defs };
  return { api, diagnostics };
}
