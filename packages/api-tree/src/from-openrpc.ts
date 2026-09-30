// OpenRPC 1.x documents -> ApiDescription.
//
// Addressing: a method's `name` is split on "." into its address (`eth.getBalance`
// -> `[eth, getBalance]`), so the json-rpc projector's dot-joined tree path
// reproduces the wire name exactly. A name that cannot be a plain dotted path
// (an empty segment, or a name that is also the prefix of another method's
// name, since a position holds a leaf or a group but not both) is addressed by
// one unique static segment and keeps its wire name in `meta.jsonrpc.name`.
//
// Input: the method's `params` as one named-params object, in declaration
// order; a param is optional unless its descriptor says `required: true`.
//
// Output: the `result` descriptor's schema. A method without `result` is a
// notification and its output is `void`.
//
// Meta: `deprecated` -> `meta.tags.deprecated`; `description` (else `summary`)
// -> `meta.description`. Everything else the format says about a method
// (summary, Tag Objects, errors, links, examples, servers, externalDocs,
// paramStructure, `x-` extensions) is kept verbatim, references resolved,
// under `meta.openrpc`. Document-level info, servers, externalDocs and
// extensions live on the root group's `meta.openrpc`.
//
// Types: descriptor and component schemas are JSON Schema. `$ref`s into
// `#/components/schemas/` stay `ref`s into `defs`; any other local `$ref`
// inside a schema is inlined. An unresolvable, external or cyclic reference
// is reported and the referring part is skipped (or typed `unknown`).
//
// Spec references: OpenRPC 1.3.2 "OpenRPC Object", "Info Object", "Server
// Object", "Method Object" (`paramStructure`, `result`, notifications),
// "Content Descriptor Object", "Error Object", "Link Object", "Example
// Pairing Object", "Example Object", "Tag Object", "External Documentation
// Object", "Components Object", "Reference Object", "Schema Object",
// "Specification Extensions"; JSON-RPC 2.0 §4 (Request Object), §4.2
// (Parameter Structures), §5.1 (Error Object).

import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { fromJsonSchema } from "@rhi-zone/fractal-type-ir/from-json-schema";
import type {
  ApiDescription,
  Diagnostic,
  Group,
  Imported,
  Operation,
  Segment,
} from "./api-description.ts";
import { addressKey } from "./api-description.ts";

type Obj = Record<string, unknown>;

export type ImportedOpenRpc = Imported & {
  /** The document's `openrpc` version string. */
  readonly version: string;
  /** `info.title`/`info.version`. */
  readonly info: { readonly title?: string; readonly version?: string };
};

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

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

/** Follow Reference Objects until a non-reference value; `undefined` if a reference is external, dangling or cyclic. */
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

const COMPONENT_SCHEMA = "#/components/schemas/";
// Keys whose values are data, not schemas.
const DATA_KEYS: ReadonlySet<string> = new Set(["enum", "const", "default", "example", "examples"]);

export function fromOpenRpcDocument(input: unknown): ImportedOpenRpc {
  if (!isObj(input)) throw new Error("fromOpenRpcDocument: document must be a JSON object");
  const doc = input;
  if (typeof doc.openrpc !== "string" || !doc.openrpc.startsWith("1.")) {
    throw new Error(
      `fromOpenRpcDocument: unsupported document version (openrpc=${String(doc.openrpc)})`,
    );
  }
  const diagnostics: Diagnostic[] = [];

  // Rewrites every schema `$ref` that is not a `#/components/schemas/NAME`
  // reference to its resolved target, so the only refs left are the ones
  // `fromJsonSchema` lowers to `ref`s that `defs` answers.
  const normalize = (schema: unknown, at: string, active: readonly string[] = []): unknown => {
    if (Array.isArray(schema)) return schema.map((s) => normalize(s, at, active));
    if (!isObj(schema)) return schema;
    if (typeof schema.$ref === "string") {
      const ref = schema.$ref;
      const name = ref.slice(COMPONENT_SCHEMA.length);
      if (ref.startsWith(COMPONENT_SCHEMA) && name.length > 0 && !name.includes("/")) return schema;
      const { $ref: _ref, ...siblings } = schema;
      if (active.includes(ref)) {
        diagnostics.push({ at, message: `cyclic schema reference "${ref}"; typed unknown` });
        return {};
      }
      const target = deref(doc, { $ref: ref });
      if (target === undefined) {
        diagnostics.push({ at, message: `schema reference "${ref}" could not be resolved` });
        return siblings;
      }
      const inlined = normalize(target, at, [...active, ref]);
      return isObj(inlined) ? { ...inlined, ...(normalize(siblings, at, active) as Obj) } : inlined;
    }
    const out: Obj = {};
    for (const [k, v] of Object.entries(schema)) {
      out[k] = DATA_KEYS.has(k) ? v : normalizeChild(k, v);
    }
    return out;

    function normalizeChild(key: string, v: unknown): unknown {
      // A map of name -> schema: normalize each value, never the map itself.
      if (
        (key === "properties" ||
          key === "patternProperties" ||
          key === "definitions" ||
          key === "$defs" ||
          key === "dependencies") &&
        isObj(v)
      ) {
        return Object.fromEntries(
          Object.entries(v).map(([name, s]) => [name, normalize(s, at, active)]),
        );
      }
      return normalize(v, at, active);
    }
  };

  const convertSchema = (s: unknown, at: string): TypeRef => {
    if (s === true) return t(types.unknown);
    if (s === false) return t(types.never);
    if (!isObj(s)) return t(types.unknown);
    return fromJsonSchema(normalize(s, at) as Obj);
  };

  const defs: Record<string, TypeRef> = {};
  const components = isObj(doc.components) ? doc.components : {};
  if (isObj(components.schemas)) {
    for (const [name, schema] of Object.entries(components.schemas)) {
      defs[name] = withMeta(convertSchema(schema, `#/components/schemas/${name}`), {
        typeName: name,
      });
    }
  }

  const groups: Group[] = [];
  const info = isObj(doc.info) ? doc.info : {};
  const rootOpenrpc: Obj = { ...extensions(doc) };
  if (isObj(doc.info)) rootOpenrpc.info = doc.info;
  if (doc.servers !== undefined) rootOpenrpc.servers = doc.servers;
  if (doc.externalDocs !== undefined) rootOpenrpc.externalDocs = doc.externalDocs;
  const rootMeta: Obj = {};
  const infoDescription = asString(info.description);
  if (infoDescription !== undefined) rootMeta.description = infoDescription;
  if (Object.keys(rootOpenrpc).length > 0) rootMeta.openrpc = rootOpenrpc;
  if (Object.keys(rootMeta).length > 0) groups.push({ address: [], meta: rootMeta });

  /** A Content Descriptor's schema, carrying the descriptor's own annotations as type meta. */
  const descriptorType = (cd: Obj, at: string): TypeRef => {
    let type = convertSchema(cd.schema, `${at}/schema`);
    const extra: Obj = { ...extensions(cd) };
    const description = asString(cd.description) ?? asString(cd.summary);
    if (description !== undefined) extra.description = description;
    if (cd.deprecated === true) extra.deprecated = true;
    if (Object.keys(extra).length > 0) type = withMeta(type, extra);
    return type;
  };

  /** `list`'s entries with references resolved; unresolvable entries are reported and left out. */
  const resolveList = (list: unknown, at: string): unknown[] => {
    if (!Array.isArray(list)) return [];
    const out: unknown[] = [];
    list.forEach((entry, i) => {
      const v = deref(doc, entry);
      if (v === undefined) {
        diagnostics.push({ at: `${at}/${i}`, message: "reference could not be resolved; skipped" });
      } else out.push(v);
    });
    return out;
  };

  const resolveExamples = (list: unknown, at: string): unknown[] =>
    resolveList(list, at).map((pairing, i) => {
      if (!isObj(pairing)) return pairing;
      const out: Obj = { ...pairing };
      if (Array.isArray(pairing.params)) {
        out.params = resolveList(pairing.params, `${at}/${i}/params`);
      }
      if (pairing.result !== undefined) {
        const r = deref(doc, pairing.result);
        if (r === undefined) {
          diagnostics.push({
            at: `${at}/${i}/result`,
            message: "reference could not be resolved; skipped",
          });
          delete out.result;
        } else out.result = r;
      }
      return out;
    });

  const methods = Array.isArray(doc.methods) ? doc.methods : [];
  type Pending = { readonly at: string; readonly name: string; readonly method: Obj };
  const pending: Pending[] = [];
  const seenNames = new Set<string>();
  methods.forEach((raw, i) => {
    const at = `#/methods/${i}`;
    const method = deref(doc, raw);
    if (!isObj(method) || typeof method.name !== "string") {
      diagnostics.push({ at, message: "method could not be resolved or has no name; skipped" });
      return;
    }
    if (seenNames.has(method.name)) {
      diagnostics.push({
        at,
        message: `method "${method.name}" is already defined; skipped`,
      });
      return;
    }
    seenNames.add(method.name);
    pending.push({ at, name: method.name, method });
  });

  // A name is a plain dotted path unless it has an empty segment or is the
  // proper prefix of another method's name.
  const plain = (name: string): boolean => name.split(".").every((s) => s.length > 0);
  const groupKeys = new Set<string>();
  for (const { name } of pending) {
    if (!plain(name)) continue;
    const segs = name.split(".");
    for (let n = 1; n < segs.length; n++) {
      groupKeys.add(addressKey(segs.slice(0, n).map((s) => ({ kind: "static", name: s }))));
    }
  }
  const dotted = (name: string): Segment[] =>
    name.split(".").map((s) => ({ kind: "static", name: s }));
  const isDotted = (name: string): boolean =>
    plain(name) && !groupKeys.has(addressKey(dotted(name)));
  // Every key a fallback address must avoid: groups and plain leaves.
  const reserved = new Set<string>(groupKeys);
  for (const { name } of pending) if (isDotted(name)) reserved.add(addressKey(dotted(name)));
  const addressOf = (name: string): { address: Segment[]; renamed: boolean } => {
    if (isDotted(name)) return { address: dotted(name), renamed: false };
    let candidate = name.length > 0 ? name : "method";
    while (reserved.has(addressKey([{ kind: "static", name: candidate }]))) candidate += "_";
    const address: Segment[] = [{ kind: "static", name: candidate }];
    reserved.add(addressKey(address));
    return { address, renamed: true };
  };

  const operations: Operation[] = [];
  for (const { at, name, method } of pending) {
    const { address, renamed } = addressOf(name);
    if (renamed) {
      diagnostics.push({
        at,
        message: `method "${name}" cannot be a plain dotted path (empty segment, or prefix of another method name); addressed as "${(address[0] as { name: string }).name}" with its wire name in meta.jsonrpc.name`,
      });
    }

    const fields: Record<string, TypeRef> = {};
    const params = Array.isArray(method.params) ? method.params : [];
    params.forEach((rawParam, pi) => {
      const pat = `${at}/params/${pi}`;
      const cd = deref(doc, rawParam);
      if (!isObj(cd) || typeof cd.name !== "string") {
        diagnostics.push({
          at: pat,
          message: "param could not be resolved or has no name; skipped",
        });
        return;
      }
      if (cd.name in fields) {
        diagnostics.push({ at: pat, message: `param "${cd.name}" is declared twice; skipped` });
        return;
      }
      let type = descriptorType(cd, pat);
      if (cd.required !== true) type = withMeta(type, { optional: true });
      fields[cd.name] = type;
    });

    const paramStructure = asString(method.paramStructure);
    if (paramStructure === "by-position") {
      diagnostics.push({
        at: `${at}/paramStructure`,
        message:
          'paramStructure "by-position" is not represented: the json-rpc side takes params by name only',
      });
    }

    let output: TypeRef | undefined;
    let resultInfo: Obj | undefined;
    const notification = method.result === undefined;
    if (notification) {
      output = t(types.void);
      diagnostics.push({
        at,
        message: "method has no result (a notification); represented with a void output",
      });
    } else {
      const rd = deref(doc, method.result);
      if (isObj(rd)) {
        output = descriptorType(rd, `${at}/result`);
        resultInfo = {};
        for (const k of ["name", "summary", "description"] as const) {
          if (rd[k] !== undefined) resultInfo[k] = rd[k];
        }
      } else {
        diagnostics.push({ at: `${at}/result`, message: "result could not be resolved" });
      }
    }

    const openrpc: Obj = { ...extensions(method) };
    for (const k of ["summary", "externalDocs", "servers"] as const) {
      if (method[k] !== undefined) openrpc[k] = method[k];
    }
    if (paramStructure !== undefined) openrpc.paramStructure = paramStructure;
    if (notification) openrpc.notification = true;
    if (resultInfo !== undefined && Object.keys(resultInfo).length > 0) openrpc.result = resultInfo;
    for (const k of ["tags", "errors", "links"] as const) {
      const list = resolveList(method[k], `${at}/${k}`);
      if (list.length > 0) openrpc[k] = list;
    }
    const examples = resolveExamples(method.examples, `${at}/examples`);
    if (examples.length > 0) openrpc.examples = examples;

    const description = asString(method.description) ?? asString(method.summary);
    const meta: Obj = {
      ...(description !== undefined ? { description } : {}),
      ...(method.deprecated === true ? { tags: { deprecated: true } } : {}),
      ...(renamed ? { jsonrpc: { name } } : {}),
      ...(Object.keys(openrpc).length > 0 ? { openrpc } : {}),
    };

    operations.push({
      address,
      input: t(types.object(fields)),
      ...(output !== undefined ? { output } : {}),
      meta,
    });
  }

  const api: ApiDescription = { operations, groups, defs };
  const title = asString(info.title);
  const infoVersion = asString(info.version);
  return {
    api,
    diagnostics,
    version: doc.openrpc,
    info: {
      ...(title !== undefined ? { title } : {}),
      ...(infoVersion !== undefined ? { version: infoVersion } : {}),
    },
  };
}
