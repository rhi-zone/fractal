// packages/json-rpc-api-projector/src/openrpc.ts — OpenRPC 1.x document emitter
//
// `toOpenRpc(tree, opts)` walks the same method list the server exposes
// (`projectMethods`) and describes it as an OpenRPC document. It is the
// output-side counterpart of api-tree's `fromOpenRpcDocument`: a document
// imported, lowered and emitted again keeps its methods, parameters, results,
// shared component schemas and everything the importer stored verbatim under
// `meta.openrpc`.
//
// Contract:
//   - One Method Object per projected method, named by its wire name.
//   - `params` come from `paramsSchema.properties` in property order; a
//     property is `required` iff listed in `paramsSchema.required`. The server
//     takes params by name only, so `paramStructure` is `"by-name"` unless
//     `meta.openrpc.paramStructure` says otherwise.
//   - `result` comes from `resultSchema`. A method without one is described
//     with an unconstrained result, except when `meta.openrpc.notification` is
//     true, in which case `result` is omitted (a notification).
//   - `description` is `meta.jsonrpc.description`, else `meta.description`,
//     else the schema map's description; never the tree key. It is left out
//     when it equals `meta.openrpc.summary` (the importer derives description
//     from summary).
//   - `deprecated` is the resolved `meta.tags.deprecated`.
//   - `errorDataSchema` has no Error Object slot (an Error Object's `data` is a
//     value, not a schema), so it is emitted as the method's
//     `x-error-data-schema` extension.
//   - Every other `meta.openrpc` key of a method (summary, tags, errors,
//     links, examples, servers, externalDocs, `x-` extensions, ...) is copied
//     as is; the root node's `meta.openrpc` (info, servers, externalDocs,
//     extensions) is copied likewise. Explicit `title`/`version` options win
//     over the copied `info`.
//   - Schemas are self-contained JSON Schema with a top-level `$defs`. Each
//     `$defs` entry moves to `components.schemas`, the `#/$defs/NAME` refs
//     become `#/components/schemas/NAME`, and a def shared by several methods
//     appears once. Two different defs with the same name are kept apart by
//     renaming the later one `NAME_2`, `NAME_3`, ...
//   - Schemas that no method reaches are not emitted.
//
// Spec (OpenRPC 1.3.2): "OpenRPC Object", "Info Object", "Method Object"
// (`name`, `params`, `result`, `paramStructure`, `deprecated`, notifications),
// "Content Descriptor Object", "Components Object" (`schemas`), "Reference
// Object", "Error Object", "Tag Object", "Specification Extensions".

import type { Node } from "@rhi-zone/fractal-api-tree/node";
import { getJsonRpcMeta, projectMethods } from "./project.ts";
import type {
  JsonRpcBranchMeta,
  JsonRpcLeafMeta,
  JsonSchema,
  ProjectMethodsOptions,
} from "./project.ts";

type Obj = Record<string, unknown>;

export type OpenRpcOptions = ProjectMethodsOptions & {
  /** `info.title`; falls back to the root's `meta.openrpc.info.title`, then "API". */
  readonly title?: string;
  /** `info.version`; falls back to the root's `meta.openrpc.info.version`, then "0.1.0". */
  readonly version?: string;
  /** The `openrpc` version string. Defaults to "1.3.2". */
  readonly openrpc?: string;
};

export type OpenRpcContentDescriptor = {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly deprecated?: boolean;
  readonly schema: JsonSchema;
  readonly [key: string]: unknown;
};

export type OpenRpcMethod = {
  readonly name: string;
  readonly description?: string;
  readonly params: readonly OpenRpcContentDescriptor[];
  readonly result?: OpenRpcContentDescriptor;
  readonly paramStructure?: string;
  readonly deprecated?: boolean;
  readonly [key: string]: unknown;
};

export type OpenRpcDoc = {
  readonly openrpc: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly [key: string]: unknown;
  };
  readonly methods: readonly OpenRpcMethod[];
  readonly components?: { readonly schemas: Readonly<Record<string, JsonSchema>> };
  readonly [key: string]: unknown;
};

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const DEFS_PREFIX = "#/$defs/";
const COMPONENTS_PREFIX = "#/components/schemas/";
// Keys whose values are data, not schemas.
const DATA_KEYS: ReadonlySet<string> = new Set(["enum", "const", "default", "example", "examples"]);
// Keys whose values are maps of name -> schema.
const SCHEMA_MAPS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependencies",
]);

const unescapePointer = (s: string): string => s.replaceAll("~1", "/").replaceAll("~0", "~");
const escapePointer = (s: string): string => s.replaceAll("~", "~0").replaceAll("/", "~1");

/** Key-order-independent serialization, for comparing two schemas. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** `schema` with every `#/$defs/NAME...` ref whose NAME is in `mapping` pointed at the mapped component name. */
function rewriteRefs(schema: unknown, mapping: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(schema)) return schema.map((s) => rewriteRefs(s, mapping));
  if (!isObj(schema)) return schema;
  const out: Obj = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$ref" && typeof v === "string" && v.startsWith(DEFS_PREFIX)) {
      const rest = v.slice(DEFS_PREFIX.length);
      const slash = rest.indexOf("/");
      const name = unescapePointer(slash === -1 ? rest : rest.slice(0, slash));
      const target = mapping.get(name);
      out[k] =
        target === undefined
          ? v
          : `${COMPONENTS_PREFIX}${escapePointer(target)}${slash === -1 ? "" : rest.slice(slash)}`;
    } else if (DATA_KEYS.has(k)) {
      out[k] = v;
    } else if (SCHEMA_MAPS.has(k) && isObj(v)) {
      out[k] = Object.fromEntries(
        Object.entries(v).map(([name, s]) => [name, rewriteRefs(s, mapping)]),
      );
    } else out[k] = rewriteRefs(v, mapping);
  }
  return out;
}

/** Moves `schema.$defs` into `components` (see the module contract) and returns `schema` without it. */
function hoistDefs(schema: JsonSchema, components: Record<string, JsonSchema>): JsonSchema {
  const { $defs, ...rest } = schema;
  const defs = isObj($defs) ? $defs : {};
  const names = Object.keys(defs);
  const mapping = new Map<string, string>(names.map((n) => [n, n]));
  const attempts = new Map<string, number>();
  const settled = new Map<string, JsonSchema>();

  // A rename changes what other defs' refs rewrite to, so repeat until no
  // def's target changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const name of names) {
      const rewritten = rewriteRefs(defs[name], mapping) as JsonSchema;
      let target = mapping.get(name)!;
      while (
        components[target] !== undefined &&
        canonical(components[target]) !== canonical(rewritten)
      ) {
        const n = (attempts.get(name) ?? 1) + 1;
        attempts.set(name, n);
        target = `${name}_${n}`;
      }
      if (target !== mapping.get(name)) {
        mapping.set(name, target);
        changed = true;
      }
      settled.set(name, rewritten);
    }
  }
  for (const name of names) components[mapping.get(name)!] = settled.get(name)!;
  return rewriteRefs(rest, mapping) as JsonSchema;
}

/** A by-name params schema as Content Descriptors, in property order. */
function paramDescriptors(paramsSchema: JsonSchema): OpenRpcContentDescriptor[] {
  const properties = isObj(paramsSchema.properties) ? paramsSchema.properties : {};
  const required = new Set(
    Array.isArray(paramsSchema.required)
      ? paramsSchema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  return Object.entries(properties).map(([name, schema]) => {
    const s = isObj(schema) ? (schema as JsonSchema) : {};
    return {
      name,
      ...(typeof s.description === "string" ? { description: s.description } : {}),
      ...(required.has(name) ? { required: true } : {}),
      ...(s.deprecated === true ? { deprecated: true } : {}),
      schema: s,
    };
  });
}

// `meta.openrpc` keys the emitter computes itself.
const COMPUTED_KEYS: ReadonlySet<string> = new Set([
  "name",
  "params",
  "result",
  "notification",
  "description",
  "deprecated",
]);

/** Describes `n`'s json-rpc methods (the ones `projectMethods` lists) as an OpenRPC document. */
export function toOpenRpc(n: Node, opts: OpenRpcOptions = {}): OpenRpcDoc {
  const { methods, handlers } = projectMethods(n, opts);
  const schemas = opts.schemas ?? {};
  const components: Record<string, JsonSchema> = {};

  const out: OpenRpcMethod[] = methods.map((m) => {
    const dispatch = handlers.get(m.name);
    const meta = (dispatch?.meta ?? {}) as Obj;
    const jr = getJsonRpcMeta(meta as JsonRpcLeafMeta & JsonRpcBranchMeta);
    const passthrough = isObj(meta.openrpc) ? meta.openrpc : {};

    const description =
      typeof jr.description === "string"
        ? jr.description
        : typeof meta.description === "string"
          ? meta.description
          : schemas[m.name]?.description;

    const method: Obj = { name: m.name };
    if (typeof description === "string" && description !== passthrough.summary) {
      method.description = description;
    }

    const params = hoistDefs(m.paramsSchema, components);
    method.params = paramDescriptors(params);
    method.paramStructure = "by-name";
    if (m.deprecated === true) method.deprecated = true;

    if (passthrough.notification !== true) {
      const info = isObj(passthrough.result) ? passthrough.result : {};
      const resultSchema =
        m.resultSchema !== undefined ? hoistDefs(m.resultSchema, components) : ({} as JsonSchema);
      method.result = {
        name: typeof info.name === "string" ? info.name : "result",
        ...(typeof info.summary === "string" ? { summary: info.summary } : {}),
        ...(typeof info.description === "string" ? { description: info.description } : {}),
        schema: resultSchema,
      };
    }

    if (jr.errorDataSchema !== undefined) {
      method["x-error-data-schema"] = hoistDefs(jr.errorDataSchema, components);
    }
    for (const [k, v] of Object.entries(passthrough)) {
      if (!COMPUTED_KEYS.has(k)) method[k] = v;
    }
    return method as OpenRpcMethod;
  });

  const rootOpenrpc = isObj(n.meta.openrpc) ? (n.meta.openrpc as Obj) : {};
  const rootInfo = isObj(rootOpenrpc.info) ? rootOpenrpc.info : {};
  const info = {
    ...(typeof (n.meta as Obj).description === "string" && rootInfo.description === undefined
      ? { description: (n.meta as Obj).description }
      : {}),
    ...rootInfo,
    title: opts.title ?? (typeof rootInfo.title === "string" ? rootInfo.title : "API"),
    version: opts.version ?? (typeof rootInfo.version === "string" ? rootInfo.version : "0.1.0"),
  };

  const doc: Obj = { openrpc: opts.openrpc ?? "1.3.2", info };
  for (const [k, v] of Object.entries(rootOpenrpc)) {
    if (k !== "info" && k !== "openrpc" && k !== "methods" && k !== "components") doc[k] = v;
  }
  doc.methods = out;
  if (Object.keys(components).length > 0) doc.components = { schemas: components };
  return doc as OpenRpcDoc;
}
