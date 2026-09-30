// OpenAPI (3.0.x, 3.1.x) and Swagger 2.0 documents -> ApiDescription.
//
// Addressing: an operation's address mirrors its URL path (a literal path
// segment is a static segment, a whole-segment `{name}` template is a param
// segment) followed by the lowercased HTTP method as the operation's own
// key. `meta.http = { method, moveTo: ".." }` places it back at exactly its
// URL under the http projector. `moveTo` is relative to the address, so a
// transform that re-addresses an operation also moves its URL unless it
// rewrites `moveTo` to match.
//
// Input: the operation's parameters (path, query, header, cookie) and, when
// the request body is a JSON object schema, that object's properties, as one
// named-params object. `meta.http.sourceMap` records each name's store.
//
// Output: the first 2xx response's JSON schema (a response with no content
// is `void`).
//
// Spec references: OAS 3.1.0 §4.8.8 (Paths Object), §4.8.9 (Path Item
// Object), §4.8.10 (Operation Object), §4.8.12 (Parameter Object), §4.8.13
// (Request Body Object), §4.8.16 (Responses Object), §4.8.23 (Reference
// Object), §4.8.24 (Schema Object), §4.8.27 (Security Scheme Object),
// §4.9 (Specification Extensions); OAS 3.0.3 same section numbers; Swagger
// 2.0 §4.6 (Data Types), §4.7.5 (Paths), §4.7.9 (Operation), §4.7.12
// (Parameter), §4.7.16 (Responses). Method safety/idempotence: RFC 9110
// §9.2.1, §9.2.2.

import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { fromJsonSchema } from "@rhi-zone/fractal-type-ir/from-json-schema";
import { fromOpenApi20, fromOpenApi30 } from "@rhi-zone/fractal-type-ir/from-openapi";
import type {
  ApiDescription,
  Diagnostic,
  Group,
  Imported,
  Operation,
  Segment,
} from "./api-description.ts";

type Obj = Record<string, unknown>;

export type OpenApiVersion = "2.0" | "3.0" | "3.1";

export type ImportedOpenApi = Imported & {
  readonly version: OpenApiVersion;
  /** `info.title`/`info.version`, for `toOpenApi`'s own `title`/`version` options. */
  readonly info: { readonly title?: string; readonly version?: string };
  /** The document-level security requirement, for `toOpenApi`'s `defaultSecurity`. */
  readonly defaultSecurity?: readonly Record<string, string[]>[];
};

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type Method = (typeof METHODS)[number];

// RFC 9110 §9.2.1: GET, HEAD, OPTIONS and TRACE are safe.
const SAFE: ReadonlySet<Method> = new Set(["get", "head", "options", "trace"]);
// RFC 9110 §9.2.2: PUT, DELETE and the safe methods are idempotent.
const IDEMPOTENT: ReadonlySet<Method> = new Set(["put", "delete", ...SAFE]);

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function detectVersion(doc: Obj): OpenApiVersion {
  if (doc.swagger === "2.0") return "2.0";
  if (typeof doc.openapi === "string") {
    if (doc.openapi.startsWith("3.0")) return "3.0";
    if (doc.openapi.startsWith("3.1")) return "3.1";
  }
  throw new Error(
    `fromOpenApiDocument: unsupported document version (swagger=${String(doc.swagger)}, openapi=${String(doc.openapi)})`,
  );
}

/** RFC 6901 JSON pointer lookup inside `doc`, for a local `#/...` reference. */
function resolvePointer(doc: Obj, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Obj)[key];
  }
  return cur;
}

/** Follow Reference Objects (§4.8.23) until a non-reference value; `undefined` if a reference is external, dangling or cyclic. */
function deref(doc: Obj, v: unknown): unknown {
  const seen = new Set<string>();
  while (isObj(v) && typeof v.$ref === "string") {
    if (seen.has(v.$ref)) return undefined;
    seen.add(v.$ref);
    v = resolvePointer(doc, v.$ref);
  }
  return v;
}

function extensions(o: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (k.startsWith("x-")) out[k] = v;
  return out;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function fromOpenApiDocument(input: unknown): ImportedOpenApi {
  if (!isObj(input)) throw new Error("fromOpenApiDocument: document must be a JSON object");
  const doc = input;
  const version = detectVersion(doc);
  const diagnostics: Diagnostic[] = [];
  const convertSchema = (s: unknown): TypeRef => {
    if (!isObj(s)) return t(types.unknown);
    if (version === "2.0") return fromOpenApi20(s);
    if (version === "3.0") return fromOpenApi30(s);
    return fromJsonSchema(s);
  };

  // Named schemas: `components.schemas` (3.x) / `definitions` (2.0). Every
  // `$ref` a schema carries resolves by its last pointer segment, which is
  // the convention `fromOpenApi30`/`fromJsonSchema` already lower `$ref` to.
  const defs: Record<string, TypeRef> = {};
  const components = isObj(doc.components) ? doc.components : {};
  const named = version === "2.0" ? doc.definitions : components.schemas;
  if (isObj(named)) {
    for (const [name, schema] of Object.entries(named)) {
      defs[name] = withMeta(convertSchema(schema), { typeName: name });
    }
  }

  const operations: Operation[] = [];
  const groups: Group[] = [];

  const rootMeta: Obj = {};
  const info = isObj(doc.info) ? doc.info : {};
  const infoDescription = asString(info.description);
  if (infoDescription !== undefined) rootMeta.description = infoDescription;
  const securitySchemes =
    version === "2.0" ? doc.securityDefinitions : (components.securitySchemes as unknown);
  if (isObj(securitySchemes) && Object.keys(securitySchemes).length > 0) {
    rootMeta.openapi = { securitySchemes };
  }
  if (Object.keys(rootMeta).length > 0) groups.push({ address: [], meta: rootMeta });

  // Param-segment names already bound at each tree position, keyed by the
  // static prefix; a later path naming the same position differently is
  // rebound to the first name (its input field keeps its own name and reads
  // the path store under the first name).
  const paramNameAt = new Map<string, string>();

  let hasErrorResponses = false;
  const paths = isObj(doc.paths) ? doc.paths : {};

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(doc, rawItem);
    if (!isObj(item)) {
      diagnostics.push({ at: `#/paths/${path}`, message: "path item could not be resolved" });
      continue;
    }

    const segments: Segment[] = [];
    const pathParamStoreKey = new Map<string, string>();
    let unsupported = false;
    let prefix = "";
    for (const raw of path.split("/").filter((s) => s.length > 0)) {
      const whole = /^\{([^{}]+)\}$/.exec(raw);
      if (whole) {
        const own = whole[1]!;
        const bound = paramNameAt.get(prefix) ?? own;
        paramNameAt.set(prefix, bound);
        if (bound !== own) {
          diagnostics.push({
            at: `#/paths/${path}`,
            message: `path parameter "${own}" shares its position with "${bound}" in another path; bound to "${bound}"`,
          });
        }
        pathParamStoreKey.set(own, bound);
        segments.push({ kind: "param", name: bound });
        prefix += "/{}";
      } else if (raw.includes("{")) {
        unsupported = true;
        break;
      } else {
        segments.push({ kind: "static", name: raw });
        prefix += `/${raw}`;
      }
    }
    if (unsupported) {
      diagnostics.push({
        at: `#/paths/${path}`,
        message: "a path segment mixes literal text and a template expression; skipped",
      });
      continue;
    }

    const itemParams = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of METHODS) {
      const rawOp = item[method];
      if (!isObj(rawOp)) continue;
      const at = `#/paths/${path}/${method}`;

      // §4.8.10 `parameters`: operation-level entries override path-item-level
      // ones with the same (name, in).
      const byKey = new Map<string, Obj>();
      for (const p of [
        ...itemParams,
        ...(Array.isArray(rawOp.parameters) ? rawOp.parameters : []),
      ]) {
        const param = deref(doc, p);
        if (!isObj(param) || typeof param.name !== "string" || typeof param.in !== "string") {
          diagnostics.push({ at, message: "parameter could not be resolved; skipped" });
          continue;
        }
        byKey.set(`${param.in}:${param.name}`, param);
      }

      const fields: Record<string, TypeRef> = {};
      const sourceMap: Record<string, { store: string; key?: string }> = {};
      const addField = (name: string, type: TypeRef, store: string, key?: string): void => {
        if (name in fields) {
          diagnostics.push({
            at,
            message: `"${name}" is declared in both ${sourceMap[name]?.store} and ${store}; the ${store} one is skipped`,
          });
          return;
        }
        fields[name] = type;
        sourceMap[name] = key !== undefined && key !== name ? { store, key } : { store };
      };

      let bodyParam: Obj | undefined;
      let formParams: Obj[] = [];
      for (const param of byKey.values()) {
        const name = param.name as string;
        const where = param.in as string;
        if (where === "body") {
          bodyParam = param;
          continue;
        }
        if (where === "formData") {
          formParams = [...formParams, param];
          continue;
        }
        if (!["path", "query", "header", "cookie"].includes(where)) {
          diagnostics.push({
            at,
            message: `parameter "${name}" has unknown location "${where}"; skipped`,
          });
          continue;
        }
        // 3.x: the parameter's type is its `schema` (or a single `content`
        // entry's schema); 2.0: the non-body Parameter Object itself carries
        // the type keywords.
        let schema: unknown;
        if (version === "2.0") schema = param;
        else if (isObj(param.schema)) schema = param.schema;
        else if (isObj(param.content))
          schema = Object.values(param.content).map((m) => (isObj(m) ? m.schema : undefined))[0];
        let type = convertSchema(schema);
        const extra: Obj = {};
        // §4.8.12: a path parameter is always required.
        if (where !== "path" && param.required !== true) extra.optional = true;
        const pd = asString(param.description);
        if (pd !== undefined) extra.description = pd;
        if (param.deprecated === true) extra.deprecated = true;
        if (Object.keys(extra).length > 0) type = withMeta(type, extra);
        addField(name, type, where, where === "path" ? pathParamStoreKey.get(name) : undefined);
      }

      for (const [name] of pathParamStoreKey) {
        if (!(name in fields)) {
          diagnostics.push({
            at,
            message: `path template names "${name}" but no path parameter declares it`,
          });
          addField(name, t(types.string), "path", pathParamStoreKey.get(name));
        }
      }

      // Request body: 3.x `requestBody` (§4.8.13), 2.0 `in: body` parameter.
      let bodySchema: unknown;
      let bodyRequired = false;
      if (version === "2.0") {
        if (bodyParam !== undefined) {
          bodySchema = bodyParam.schema;
          bodyRequired = bodyParam.required === true;
        } else if (formParams.length > 0) {
          diagnostics.push({ at, message: "formData parameters are not represented" });
        }
      } else {
        const rb = deref(doc, rawOp.requestBody);
        if (isObj(rb) && isObj(rb.content)) {
          const media = Object.keys(rb.content);
          const json = media.find((m) => m === "application/json" || /\+json$|\/json$/.test(m));
          const chosen = json ?? media[0];
          if (chosen !== undefined) {
            if (json === undefined) {
              diagnostics.push({ at, message: `request body media type "${chosen}" is not JSON` });
            }
            const entry = (rb.content as Obj)[chosen];
            bodySchema = isObj(entry) ? entry.schema : undefined;
            bodyRequired = rb.required === true;
          }
        }
      }
      if (bodySchema !== undefined) {
        const resolved = deref(doc, bodySchema);
        const props =
          isObj(resolved) && isObj(resolved.properties) ? resolved.properties : undefined;
        if (props !== undefined && resolved !== undefined && isObj(resolved)) {
          const required = new Set(
            Array.isArray(resolved.required) ? (resolved.required as string[]) : [],
          );
          for (const [name, propSchema] of Object.entries(props)) {
            let type = convertSchema(propSchema);
            if (!required.has(name) || !bodyRequired) type = withMeta(type, { optional: true });
            addField(name, type, "body");
          }
        } else {
          diagnostics.push({
            at,
            message:
              'request body is not an object schema; represented as one input field "body" that the http projector\'s body decoding does not fill',
          });
          let type = convertSchema(bodySchema);
          if (!bodyRequired) type = withMeta(type, { optional: true });
          if (!("body" in fields)) fields.body = type;
        }
      }

      // Output: the first 2xx response in ascending status order (§4.8.16).
      let output: TypeRef | undefined;
      const responses = isObj(rawOp.responses) ? rawOp.responses : {};
      const statuses = Object.keys(responses).sort();
      const success = statuses.find((s) => /^2(\d\d|XX)$/.test(s));
      if (statuses.some((s) => s !== success)) hasErrorResponses = true;
      if (success !== undefined) {
        const res = deref(doc, responses[success]);
        if (isObj(res)) {
          let schema: unknown;
          if (version === "2.0") schema = res.schema;
          else if (isObj(res.content)) {
            const media = Object.keys(res.content);
            const chosen =
              media.find((m) => m === "application/json" || /\+json$|\/json$/.test(m)) ?? media[0];
            const entry = chosen !== undefined ? (res.content as Obj)[chosen] : undefined;
            schema = isObj(entry) ? entry.schema : undefined;
          }
          output = schema === undefined ? t(types.void) : convertSchema(schema);
        }
      }

      // Operation key: the method, unless a sibling static path segment
      // already uses that name at the same position.
      const siblingTaken = Object.keys(paths).some((other) => {
        const segs = other.split("/").filter((s) => s.length > 0);
        const mine = path.split("/").filter((s) => s.length > 0);
        return (
          segs.length === mine.length + 1 &&
          segs.slice(0, -1).join("/") === mine.join("/") &&
          segs[segs.length - 1] === method
        );
      });
      let key: string = method;
      if (siblingTaken) {
        key = asString(rawOp.operationId) ?? `http-${method}`;
        diagnostics.push({
          at,
          message: `path segment "${method}" exists below this path; operation keyed "${key}"`,
        });
      }

      const openapi: Obj = { ...extensions(rawOp) };
      for (const k of ["operationId", "summary", "description", "tags", "security"] as const) {
        if (rawOp[k] !== undefined) openapi[k] = rawOp[k];
      }
      if (rawOp.deprecated === true) openapi.deprecated = true;

      const tags: Obj = {};
      if (SAFE.has(method)) tags.readOnly = true;
      if (IDEMPOTENT.has(method)) tags.idempotent = true;
      if (rawOp.deprecated === true) tags.deprecated = true;

      const description = asString(rawOp.description) ?? asString(rawOp.summary);
      const meta: Obj = {
        ...(description !== undefined ? { description } : {}),
        tags,
        http: { method: method.toUpperCase(), moveTo: "..", sourceMap },
        openapi,
      };

      if (rawOp.callbacks !== undefined)
        diagnostics.push({ at, message: "callbacks are not represented" });

      operations.push({
        address: [...segments, { kind: "static", name: key }],
        input: t(types.object(fields)),
        ...(output !== undefined ? { output } : {}),
        meta,
      });
    }
  }

  if (hasErrorResponses) {
    diagnostics.push({ at: "#/paths", message: "non-2xx responses are not represented" });
  }
  if (isObj(doc.webhooks) && Object.keys(doc.webhooks).length > 0) {
    diagnostics.push({ at: "#/webhooks", message: "webhooks are not represented" });
  }

  const api: ApiDescription = { operations, groups, defs };
  const title = asString(info.title);
  const infoVersion = asString(info.version);
  return {
    api,
    diagnostics,
    version,
    info: {
      ...(title !== undefined ? { title } : {}),
      ...(infoVersion !== undefined ? { version: infoVersion } : {}),
    },
    ...(Array.isArray(doc.security)
      ? { defaultSecurity: doc.security as Record<string, string[]>[] }
      : {}),
  };
}
