// Postman Collection v2.1 (and v2.0) documents -> ApiDescription.
//
// Addressing: a request's address mirrors its URL path followed by the
// lowercased HTTP method as the operation's own key (see http-address.ts), and
// `meta.http = { method, moveTo: ".." }` places it back at exactly its URL.
// Folders are grouping only: they never enter the address (that would make
// `meta.http` inexact). A request's folder path is `requests[i].folder` under
// `meta.postman`, and each folder's own description/auth/scripts/variables
// live in the root group's `meta.postman.folders`, keyed by the same path.
//
// Requests sharing a method and a URL position (the usual "happy path" and
// "error case" copies of one endpoint) are one operation: their parameters
// and examples are merged, and each contributing request keeps its own entry
// in `meta.postman.requests`.
//
// URL variables: a `{{var}}` is server information when it sits in the URL's
// authority (protocol, host, port, as Postman splits them); the base URL as
// written goes to `requests[i].server` and the root group's `servers`. A
// whole-segment `{{var}}` or `:var` in the path is a path parameter named
// `var`. Postman does not distinguish a constant from a parameter, so this is
// a positional rule, reported once per variable. A segment mixing literal text
// with a variable cannot be a param segment; that request is skipped.
// Environment files are not read; collection/folder/request `variable` lists
// are kept verbatim and their values become `examples` on the path param.
//
// Input: path, query and enabled/disabled header entries plus, when the raw
// body is a JSON object, that object's properties, as one named-params object
// with `meta.http.sourceMap`. Postman has no required/optional: a field is
// required iff every request merged into the operation supplies it enabled.
// Query/header/path values are strings on the wire, so they are typed string.
//
// Types: Postman has no schemas. Body and response types are inferred from
// example JSON by type-ir's corpus inference and are guesses; every inferred
// type carries `meta.inferred = true` and each operation with any gets a
// diagnostic. Integer widths are not narrowed and any non-empty array is an
// array, since an example is no evidence of range or arity.
//
// Output: among the saved responses of the operation's requests, those with
// the lowest 2xx status code form the corpus (no body at all is `void`).
// Other saved responses are kept verbatim in `requests[i].responses`; errors
// have no representation yet.
//
// Meta: `description` (request description, else the request name),
// method semantics into `tags`. Auth, scripts (`event`), proxy, certificate,
// protocolProfileBehavior, Content-Type/Accept/Authorization headers and
// bodies that could not be typed stay verbatim under `meta.postman`.
//
// Spec references: Postman Collection Format v2.1.0 and v2.0.0 JSON schemas
// (schema.postman.com): `info`, `item`, `item-group`, `request`, `url`,
// `header`, `body`, `response`, `variable`, `auth`, `event`, `description`.
// The two versions were read as structurally identical for every definition
// used here. Postman variable syntax `{{name}}` and path variable syntax
// `:name`: Postman Learning Center, "Variables" and "Send API requests".
// Method safety/idempotence: RFC 9110 §9.2.1, §9.2.2. Ignored header
// parameters: OAS 3.1.0 §4.8.12.2.

import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { fromJsonCorpus } from "@rhi-zone/fractal-type-ir/from-json-corpus";
import { bytes } from "@rhi-zone/fractal-type-ir/kinds/bytes";
import {
  addressKey,
  type ApiDescription,
  type Diagnostic,
  type Group,
  type Imported,
  type Operation,
  type Segment,
} from "./api-description.ts";
import { httpAddressing } from "./http-address.ts";

type Obj = Record<string, unknown>;

export type PostmanVersion = "2.0" | "2.1";

export type ImportedPostman = Imported & { readonly version: PostmanVersion };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// RFC 9110 §9.2.1: GET, HEAD, OPTIONS and TRACE are safe.
const SAFE = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
// RFC 9110 §9.2.2: PUT, DELETE and the safe methods are idempotent.
const IDEMPOTENT = new Set(["PUT", "DELETE", ...SAFE]);

// OAS 3.1.0 §4.8.12.2: these are never header parameters.
const NOT_PARAM_HEADERS = new Set(["content-type", "accept", "authorization"]);

const INFER = { narrowIntegerWidth: false, arrayThreshold: 1 } as const;

/** Description Object (a string or `{ content, type }`) as text. */
function descText(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (isObj(v) && typeof v.content === "string" && v.content.length > 0) return v.content;
  return undefined;
}

const VAR_SEGMENT = /^\{\{([^{}]+)\}\}$/;
const COLON_SEGMENT = /^:([^:/{}]+)$/;

type Entry = {
  readonly key: string;
  readonly value: string | undefined;
  readonly enabled: boolean;
  readonly description: string | undefined;
};

type ParsedUrl = {
  readonly raw: string | undefined;
  readonly server: string;
  readonly segments: readonly string[];
  readonly query: readonly Obj[];
  readonly variables: readonly Obj[];
};

function splitRaw(raw: string): ParsedUrl {
  const noHash = raw.split("#", 1)[0]!;
  const qi = noHash.indexOf("?");
  const beforeQuery = qi === -1 ? noHash : noHash.slice(0, qi);
  const queryText = qi === -1 ? "" : noHash.slice(qi + 1);
  const proto = /^[a-z][a-z0-9+.-]*:\/\//i.exec(beforeQuery)?.[0] ?? "";
  const rest = beforeQuery.slice(proto.length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash);
  const query: Obj[] = [];
  for (const pair of queryText.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    query.push(eq === -1 ? { key: pair } : { key: pair.slice(0, eq), value: pair.slice(eq + 1) });
  }
  return {
    raw,
    server: proto + authority,
    segments: path.split("/").filter((s) => s.length > 0),
    query,
    variables: [],
  };
}

/** `url` is a string or a URL object; the object's parts win over its `raw`. */
function parseUrl(u: unknown): ParsedUrl | undefined {
  if (typeof u === "string") return splitRaw(u);
  if (!isObj(u)) return undefined;
  const raw = asString(u.raw);
  const hasParts =
    u.host !== undefined ||
    u.path !== undefined ||
    u.query !== undefined ||
    u.protocol !== undefined;
  const variables = Array.isArray(u.variable) ? u.variable.filter(isObj) : [];
  if (!hasParts) return raw === undefined ? undefined : { ...splitRaw(raw), variables };
  const host = Array.isArray(u.host) ? u.host.join(".") : (asString(u.host) ?? "");
  const protocol = asString(u.protocol)?.replace(/:?\/*$/, "");
  const port = asString(u.port);
  const pathEls = Array.isArray(u.path) ? u.path : u.path === undefined ? [] : [u.path];
  const segments = pathEls
    .map((e) => (typeof e === "string" ? e : isObj(e) ? asString(e.value) : undefined))
    .filter((e): e is string => e !== undefined)
    .flatMap((e) => e.split("/"))
    .filter((e) => e.length > 0);
  return {
    raw,
    server: `${protocol !== undefined && protocol.length > 0 ? `${protocol}://` : ""}${host}${port !== undefined && port.length > 0 ? `:${port}` : ""}`,
    segments,
    query: Array.isArray(u.query) ? u.query.filter(isObj) : [],
    variables,
  };
}

/** A path segment in `{name}` template syntax; `varName` is set when it came from a `{{var}}`. */
function templateSegment(seg: string): { text: string; varName?: string } {
  const v = VAR_SEGMENT.exec(seg)?.[1]?.trim();
  if (v !== undefined && v.length > 0) return { text: `{${v}}`, varName: v };
  const c = COLON_SEGMENT.exec(seg)?.[1];
  if (c !== undefined) return { text: `{${c}}` };
  return { text: seg };
}

function toEntries(list: readonly Obj[]): Entry[] {
  const out: Entry[] = [];
  for (const e of list) {
    if (typeof e.key !== "string" || e.key.length === 0) continue;
    out.push({
      key: e.key,
      value: asString(e.value),
      enabled: e.disabled !== true,
      description: descText(e.description),
    });
  }
  return out;
}

/** v2.1 `header` is a list or a `Name: value` per-line string. */
function headerEntries(h: unknown): Entry[] {
  if (Array.isArray(h)) return toEntries(h.filter(isObj));
  if (typeof h !== "string") return [];
  const out: Obj[] = [];
  for (const line of h.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return toEntries(out);
}

/**
 * JSON.parse that also accepts a Postman variable standing where a JSON value
 * is expected (`"age": {{age}}`): such a variable is read as a string.
 * `repaired` says whether any was substituted.
 */
function parseJsonLoose(text: string): { value: unknown; repaired: boolean } | undefined {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch {
    // fall through to the variable-tolerant reading
  }
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "{" && text[i + 1] === "{") {
      const end = text.indexOf("}}", i);
      if (end === -1) return undefined;
      out += JSON.stringify(text.slice(i, end + 2));
      i = end + 1;
    } else out += ch;
  }
  try {
    return { value: JSON.parse(out), repaired: true };
  } catch {
    return undefined;
  }
}

const isJsonMedia = (m: string): boolean => /\bjson\b|\+json\b/i.test(m);

type Field = {
  type: TypeRef;
  readonly store: string;
  readonly key?: string;
  presentIn: number;
  optionalBy: boolean;
  examples: string[];
  description?: string;
};

type Collected = {
  readonly at: string;
  readonly folder: readonly string[];
  readonly item: Obj;
  readonly scopeVars: readonly Obj[];
};

type Request = {
  readonly c: Collected;
  readonly req: Obj;
  readonly method: string;
  readonly url: ParsedUrl;
  readonly path: string;
};

export function fromPostmanCollection(input: unknown): ImportedPostman {
  if (!isObj(input)) throw new Error("fromPostmanCollection: collection must be a JSON object");
  const info = isObj(input.info) ? input.info : {};
  const schema = asString(info.schema);
  let version: PostmanVersion = "2.1";
  const diagnostics: Diagnostic[] = [];
  if (schema !== undefined && /\/v2\.0\.\d+\//.test(schema)) version = "2.0";
  else if (schema !== undefined && /\/v2\.1\.\d+\//.test(schema)) version = "2.1";
  else if (schema !== undefined && /collection\/v1|\/v1\.0\.0\//.test(schema)) {
    throw new Error(`fromPostmanCollection: unsupported collection schema ${schema}`);
  } else if (!Array.isArray(input.item)) {
    throw new Error("fromPostmanCollection: not a Postman v2 collection (no `item` array)");
  } else {
    diagnostics.push({
      at: "#/info/schema",
      message:
        schema === undefined
          ? "no schema declared; read as v2.1"
          : `unrecognised schema "${schema}"; read as v2.1`,
    });
  }

  let withAuth = 0;
  let withEvents = 0;
  const collected: Collected[] = [];
  const folders: Obj[] = [];
  const walk = (
    items: unknown,
    at: string,
    folder: readonly string[],
    scopeVars: readonly Obj[],
  ): void => {
    if (!Array.isArray(items)) return;
    items.forEach((raw, i) => {
      const here = `${at}/${i}`;
      if (!isObj(raw)) {
        diagnostics.push({ at: here, message: "item is not an object; skipped" });
        return;
      }
      const vars = Array.isArray(raw.variable) ? raw.variable.filter(isObj) : [];
      if (Array.isArray(raw.item)) {
        const path = [...folder, asString(raw.name) ?? ""];
        const f: Obj = { path };
        for (const k of ["description", "auth", "event", "variable", "protocolProfileBehavior"]) {
          if (raw[k] !== undefined) f[k] = raw[k];
        }
        folders.push(f);
        if (raw.auth !== undefined) withAuth++;
        if (Array.isArray(raw.event) && raw.event.length > 0) withEvents++;
        walk(raw.item, `${here}/item`, path, [...scopeVars, ...vars]);
      } else if (raw.request !== undefined) {
        collected.push({ at: here, folder, item: raw, scopeVars: [...scopeVars, ...vars] });
      } else {
        diagnostics.push({ at: here, message: "item is neither a request nor a folder; skipped" });
      }
    });
  };
  const rootVars = Array.isArray(input.variable) ? input.variable.filter(isObj) : [];
  walk(input.item, "#/item", [], rootVars);

  // Parse every request first: the addressing needs all paths up front.
  const requests: Request[] = [];
  const pathVarNotes = new Set<string>();
  for (const c of collected) {
    const rawReq = c.item.request;
    const req: Obj = typeof rawReq === "string" ? { url: rawReq } : isObj(rawReq) ? rawReq : {};
    const at = `${c.at}/request`;
    const url = parseUrl(req.url);
    if (url === undefined) {
      diagnostics.push({ at, message: "request has no usable url; skipped" });
      continue;
    }
    const method = (asString(req.method) ?? "GET").toUpperCase();
    if (!/^[A-Z][A-Z0-9-]*$/.test(method)) {
      diagnostics.push({ at, message: `method "${method}" is not a fixed HTTP method; skipped` });
      continue;
    }
    const segs = url.segments.map(templateSegment);
    for (const s of segs) {
      if (s.varName !== undefined && !pathVarNotes.has(s.varName)) {
        pathVarNotes.add(s.varName);
        diagnostics.push({
          at,
          message: `{{${s.varName}}} in a path segment is imported as path parameter "${s.varName}" (Postman does not distinguish a constant from a parameter)`,
        });
      }
    }
    requests.push({ c, req, method, url, path: `/${segs.map((s) => s.text).join("/")}` });
  }

  const addressing = httpAddressing(requests.map((r) => r.path));
  type Group1 = {
    segments: readonly Segment[];
    pathParamKeys: ReadonlyMap<string, string>;
    members: Request[];
  };
  const byOp = new Map<string, Group1>();
  for (const r of requests) {
    const at = `${r.c.at}/request`;
    const addressed = addressing.addressPath(r.path);
    if (!addressed.ok) {
      diagnostics.push({ at, message: `${addressed.reason}; skipped` });
      continue;
    }
    for (const { own, bound } of addressed.rebound) {
      diagnostics.push({
        at,
        message: `path parameter "${own}" shares its position with "${bound}" in another path; bound to "${bound}"`,
      });
    }
    const id = `${r.method} ${addressKey(addressed.segments)}`;
    const g = byOp.get(id);
    if (g === undefined) {
      byOp.set(id, {
        segments: addressed.segments,
        pathParamKeys: addressed.pathParamKeys,
        members: [r],
      });
    } else g.members.push(r);
  }

  const operations: Operation[] = [];
  const servers: string[] = [];
  let withErrors = 0;
  let withoutSaved = 0;

  for (const [, g] of byOp) {
    const first = g.members[0]!;
    const at = `${first.c.at}/request`;
    const method = first.method;
    const n = g.members.length;
    if (n > 1) {
      diagnostics.push({
        at,
        message: `${n} requests share ${method} ${first.path}; merged into one operation (${g.members.map((m) => m.c.at).join(", ")})`,
      });
    }

    const fields = new Map<string, Field>();
    const sourceMapCollisions = new Set<string>();
    const addField = (
      name: string,
      type: TypeRef,
      store: string,
      key: string | undefined,
      extra: { example?: string; description?: string; present: boolean },
    ): void => {
      const existing = fields.get(name);
      if (existing === undefined) {
        fields.set(name, {
          type,
          store,
          ...(key !== undefined && key !== name ? { key } : {}),
          presentIn: extra.present ? 1 : 0,
          optionalBy: false,
          examples: extra.example !== undefined ? [extra.example] : [],
          ...(extra.description !== undefined ? { description: extra.description } : {}),
        });
        return;
      }
      if (existing.store !== store) {
        const msg = `"${name}" is declared in both ${existing.store} and ${store}; the ${store} one is skipped`;
        if (!sourceMapCollisions.has(msg)) {
          sourceMapCollisions.add(msg);
          diagnostics.push({ at, message: msg });
        }
        return;
      }
      if (JSON.stringify(existing.type.shape) !== JSON.stringify(type.shape)) {
        existing.type = t(types.union([existing.type, type]));
      }
      if (extra.present) existing.presentIn++;
      if (extra.example !== undefined && !existing.examples.includes(extra.example)) {
        existing.examples.push(extra.example);
      }
      if (existing.description === undefined && extra.description !== undefined) {
        existing.description = extra.description;
      }
    };

    const postmanRequests: Obj[] = [];
    const jsonBodies: unknown[] = [];
    let jsonObjectBodies = 0;
    const responseHits: { code: number; res: Obj; ri: number }[] = [];
    let inferredBody = false;
    let description: string | undefined;
    let anySaved = false;

    g.members.forEach((r, ri) => {
      const rat = `${r.c.at}/request`;
      const entry: Obj = {
        name: asString(r.c.item.name) ?? "",
        folder: [...r.c.folder],
      };
      const itemId = asString(r.c.item.id);
      if (itemId !== undefined) entry.id = itemId;
      if (r.url.raw !== undefined) entry.url = r.url.raw;
      entry.server = r.url.server;
      if (r.url.server.length > 0 && !servers.includes(r.url.server)) servers.push(r.url.server);
      description ??=
        descText(r.req.description) ?? descText(r.c.item.description) ?? asString(r.c.item.name);
      if (r.req.description !== undefined) entry.description = r.req.description;

      for (const [where, v] of [
        ["auth", r.req.auth],
        ["event", r.c.item.event],
        ["proxy", r.req.proxy],
        ["certificate", r.req.certificate],
        ["protocolProfileBehavior", r.c.item.protocolProfileBehavior],
      ] as const) {
        if (v !== undefined) entry[where] = v;
      }
      if (r.req.auth !== undefined) withAuth++;
      if (Array.isArray(r.c.item.event) && r.c.item.event.length > 0) withEvents++;

      // Path parameters, named by their bound param segment.
      const seen = new Set<string>();
      for (const [own, bound] of g.pathParamKeys) {
        if (seen.has(bound)) continue;
        seen.add(bound);
        const declared = r.url.variables.find((v) => v.key === own);
        const scoped = [...r.c.scopeVars].reverse().find((v) => v.key === own);
        const val = asString(declared?.value) ?? asString(scoped?.value);
        addField(bound, t(types.string), "path", undefined, {
          ...(val !== undefined && val.length > 0 && !val.includes("{{") ? { example: val } : {}),
          ...(descText(declared?.description) !== undefined
            ? { description: descText(declared?.description)! }
            : {}),
          present: true,
        });
      }

      // Query parameters; a repeated key is an array of strings.
      const queryByKey = new Map<string, Entry[]>();
      for (const e of toEntries(r.url.query)) {
        if (e.key.includes("{{")) {
          diagnostics.push({
            at: rat,
            message: `query parameter name "${e.key}" contains a variable; skipped`,
          });
          continue;
        }
        queryByKey.set(e.key, [...(queryByKey.get(e.key) ?? []), e]);
      }
      for (const [key, es] of queryByKey) {
        const on = es.filter((e) => e.enabled);
        const sample = (on[0] ?? es[0])!;
        addField(
          key,
          es.length > 1 ? t(types.array(t(types.string))) : t(types.string),
          "query",
          undefined,
          {
            ...(sample.value !== undefined &&
            sample.value.length > 0 &&
            !sample.value.includes("{{")
              ? { example: sample.value }
              : {}),
            ...(sample.description !== undefined ? { description: sample.description } : {}),
            present: on.length > 0,
          },
        );
      }

      // Headers.
      const kept: Obj[] = [];
      let contentType: string | undefined;
      for (const e of headerEntries(r.req.header)) {
        const lower = e.key.toLowerCase();
        if (lower === "content-type" && e.enabled) contentType = e.value;
        if (NOT_PARAM_HEADERS.has(lower)) {
          kept.push({
            key: e.key,
            ...(e.value !== undefined ? { value: e.value } : {}),
            ...(e.enabled ? {} : { disabled: true }),
          });
          continue;
        }
        if (e.key.includes("{{")) {
          diagnostics.push({
            at: rat,
            message: `header name "${e.key}" contains a variable; skipped`,
          });
          continue;
        }
        addField(e.key, t(types.string), "header", undefined, {
          ...(e.value !== undefined && e.value.length > 0 && !e.value.includes("{{")
            ? { example: e.value }
            : {}),
          ...(e.description !== undefined ? { description: e.description } : {}),
          present: e.enabled,
        });
      }
      if (kept.length > 0) entry.headers = kept;

      // Body.
      const body = isObj(r.req.body) ? r.req.body : undefined;
      if (body !== undefined && body.disabled !== true && typeof body.mode === "string") {
        const unrepresented = (why: string): void => {
          diagnostics.push({
            at: `${rat}/body`,
            message: `${why}; body kept verbatim under meta.postman`,
          });
          entry.body = body;
        };
        if (body.mode === "raw") {
          const text = asString(body.raw) ?? "";
          const options = isObj(body.options) && isObj(body.options.raw) ? body.options.raw : {};
          const lang = asString(options.language);
          const jsonHeader = contentType !== undefined && isJsonMedia(contentType);
          const mayBeJson = jsonHeader || lang === "json" || lang === undefined;
          if (text.trim().length === 0) {
            // an empty raw body says nothing
          } else if (!mayBeJson) {
            unrepresented(`raw body is ${lang ?? "not"} text, not JSON`);
          } else {
            const parsed = parseJsonLoose(text);
            if (parsed === undefined) unrepresented("raw body is not valid JSON");
            else {
              if (parsed.repaired) {
                diagnostics.push({
                  at: `${rat}/body`,
                  message: "variables standing where a JSON value is expected are read as strings",
                });
              }
              if (isObj(parsed.value)) {
                jsonBodies.push(parsed.value);
                jsonObjectBodies++;
              } else {
                unrepresented("JSON body is not an object");
              }
            }
          }
        } else if (body.mode === "urlencoded" || body.mode === "formdata") {
          const list = Array.isArray(body[body.mode])
            ? (body[body.mode] as unknown[]).filter(isObj)
            : [];
          for (const f of list) {
            if (typeof f.key !== "string" || f.key.length === 0) continue;
            const isFile = f.type === "file";
            addField(f.key, isFile ? bytes() : t(types.string), "body", undefined, {
              ...(!isFile &&
              typeof f.value === "string" &&
              f.value.length > 0 &&
              !f.value.includes("{{")
                ? { example: f.value }
                : {}),
              ...(descText(f.description) !== undefined
                ? { description: descText(f.description)! }
                : {}),
              present: f.disabled !== true,
            });
          }
          unrepresented(
            `${body.mode} body fields are mapped to the body store, but the wire encoding is not JSON`,
          );
        } else if (body.mode === "graphql") {
          unrepresented("graphql body is not represented");
        } else {
          unrepresented(`body mode "${body.mode}" is not represented`);
        }
      }

      // Saved responses.
      const saved = Array.isArray(r.c.item.response) ? r.c.item.response : [];
      const verbatim: Obj[] = [];
      saved.forEach((res, i) => {
        if (!isObj(res)) return;
        const code = typeof res.code === "number" ? res.code : undefined;
        if (code !== undefined && code >= 200 && code < 300) responseHits.push({ code, res, ri });
        else {
          verbatim.push(res);
          if (code === undefined) {
            diagnostics.push({
              at: `${r.c.at}/response/${i}`,
              message:
                "saved response has no integer status code; kept verbatim under meta.postman",
            });
          }
        }
      });
      if (saved.length > 0) anySaved = true;
      postmanRequests.push(entry);
      if (verbatim.length > 0) entry.responses = verbatim;
    });

    // Merge inferred body properties.
    if (jsonBodies.length > 0) {
      const inferred = fromJsonCorpus(jsonBodies, INFER);
      inferredBody = true;
      if (inferred.shape.kind === "object") {
        for (const [name, type] of Object.entries(inferred.shape.fields)) {
          addField(name, withMeta(type, { inferred: true }), "body", undefined, { present: true });
          const f = fields.get(name)!;
          if (f.store === "body") {
            f.presentIn = n;
            f.optionalBy = jsonObjectBodies < n || type.meta.optional === true;
          }
        }
      } else {
        diagnostics.push({
          at,
          message:
            'JSON bodies do not share one object shape; represented as one input field "body" that the http projector\'s body decoding does not fill',
        });
        addField(
          "body",
          withMeta(inferred, { inferred: true, optional: true }),
          "body",
          undefined,
          {
            present: true,
          },
        );
      }
    }

    // Output: lowest 2xx code among the saved responses.
    let output: TypeRef | undefined;
    let outputSamples = 0;
    if (responseHits.length > 0) {
      const code = Math.min(...responseHits.map((h) => h.code));
      const used = responseHits.filter((h) => h.code === code);
      for (const h of responseHits) {
        if (h.code === code) continue;
        const entry = postmanRequests[h.ri]!;
        entry.responses = [...((entry.responses as Obj[] | undefined) ?? []), h.res];
      }
      if (responseHits.some((h) => h.code !== code)) {
        diagnostics.push({
          at,
          message: `saved 2xx responses other than ${code} are not represented in the output type; kept verbatim under meta.postman`,
        });
      }
      const values: unknown[] = [];
      let sawText = false;
      for (const h of used) {
        const text = asString(h.res.body) ?? "";
        if (text.trim().length === 0) continue;
        const headers = headerEntries(h.res.header);
        const ct = headers.find((e) => e.key.toLowerCase() === "content-type")?.value;
        const preview = asString(h.res._postman_previewlanguage);
        const nonJson =
          (ct !== undefined && !isJsonMedia(ct)) || (preview !== undefined && preview !== "json");
        const parsed = nonJson ? undefined : parseJsonLoose(text);
        if (parsed === undefined) sawText = true;
        else values.push(parsed.value);
      }
      if (values.length > 0) {
        output = withMeta(fromJsonCorpus(values, INFER), { inferred: true });
        outputSamples = values.length;
      } else if (sawText) {
        diagnostics.push({
          at,
          message: "saved success response body is not JSON; output left unknown",
        });
      } else output = t(types.void);
      if (sawText && values.length > 0) {
        diagnostics.push({
          at,
          message: "some saved success response bodies are not JSON; ignored",
        });
      }
    }
    if (postmanRequests.some((e) => e.responses !== undefined)) withErrors++;
    if (!anySaved) withoutSaved++;

    // Assemble input.
    const inputFields: Record<string, TypeRef> = {};
    const sourceMap: Record<string, { store: string; key?: string }> = {};
    for (const [name, f] of fields) {
      const optional = f.store === "path" ? false : f.optionalBy || f.presentIn < n;
      const extra: Obj = {};
      if (optional) extra.optional = true;
      if (f.description !== undefined) extra.description = f.description;
      if (f.examples.length > 0) extra.examples = f.examples;
      inputFields[name] = Object.keys(extra).length > 0 ? withMeta(f.type, extra) : f.type;
      sourceMap[name] = f.key !== undefined ? { store: f.store, key: f.key } : { store: f.store };
    }

    const { key, collided } = addressing.operationKey(
      first.path,
      method,
      `http-${method.toLowerCase()}`,
    );
    if (collided) {
      diagnostics.push({
        at,
        message: `path segment "${method.toLowerCase()}" exists below this path; operation keyed "${key}"`,
      });
    }

    if (inferredBody || outputSamples > 0) {
      diagnostics.push({
        at,
        message: `types are inferred from examples (${jsonBodies.length} request bod${jsonBodies.length === 1 ? "y" : "ies"}, ${outputSamples} saved response${outputSamples === 1 ? "" : "s"}), not declared; marked meta.inferred`,
      });
    }

    const tags: Obj = {};
    if (SAFE.has(method)) tags.readOnly = true;
    if (IDEMPOTENT.has(method)) tags.idempotent = true;

    const postman: Obj = { requests: postmanRequests };
    if (inferredBody || outputSamples > 0) {
      postman.inference = { requestBodies: jsonBodies.length, responses: outputSamples };
    }
    operations.push({
      address: [...g.segments, { kind: "static", name: key }],
      input: t(types.object(inputFields)),
      ...(output !== undefined ? { output } : {}),
      meta: {
        ...(description !== undefined ? { description } : {}),
        tags,
        http: { method, moveTo: "..", sourceMap },
        postman,
      },
    });
  }

  const rootPostman: Obj = { info };
  for (const k of ["auth", "event", "variable", "protocolProfileBehavior"] as const) {
    if (input[k] !== undefined) rootPostman[k] = input[k];
  }
  if (input.auth !== undefined) withAuth++;
  if (Array.isArray(input.event) && input.event.length > 0) withEvents++;
  if (folders.length > 0) rootPostman.folders = folders;
  if (servers.length > 0) rootPostman.servers = servers;
  const rootMeta: Obj = { postman: rootPostman };
  const infoDescription = descText(info.description);
  if (infoDescription !== undefined) rootMeta.description = infoDescription;
  const groups: Group[] = [{ address: [], meta: rootMeta }];

  if (withAuth > 0) {
    diagnostics.push({
      at: "#",
      message: `auth on ${withAuth} collection/folder/request scope(s) is kept verbatim under meta.postman and not mapped to any projector; it may contain credentials`,
    });
  }
  if (withEvents > 0) {
    diagnostics.push({
      at: "#",
      message: `scripts (event) on ${withEvents} scope(s) are not represented; kept verbatim under meta.postman`,
    });
  }
  if (withErrors > 0) {
    diagnostics.push({
      at: "#/item",
      message: `saved responses other than the success example on ${withErrors} operation(s) are not represented as error types; kept verbatim under meta.postman`,
    });
  }
  if (withoutSaved > 0) {
    diagnostics.push({
      at: "#/item",
      message: `${withoutSaved} request(s) have no saved responses; their output type is unknown`,
    });
  }

  const api: ApiDescription = { operations, groups, defs: {} };
  return { api, diagnostics, version };
}
