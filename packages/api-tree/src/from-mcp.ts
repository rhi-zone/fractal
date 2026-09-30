// What an MCP server advertises (tools/list, prompts/list, resources/list,
// resources/templates/list results) -> ApiDescription.
//
// Input: one object whose keys are the list results' own array fields
// (`tools`, `prompts`, `resources`, `resourceTemplates`), each optional. A
// key's value is either that array or the whole list result carrying it.
// Paginated results are concatenated by the caller before import.
//
// Addressing: every entry lives under a group named for its kind, so a tool,
// a prompt and a resource that share a name never collide:
//   tool              tools/<name>
//   prompt            prompts/<name>
//   resource          resources/<name>
//   resource template resourceTemplates/<name>/{var}.../read
// Exact wire names and URIs ride on `meta.mcp` (`name`, `uri`), never on how
// the tree joins segments, so a name containing `_`, `.` or `-` survives
// projection unchanged. A template's URI variables are param segments, which is
// what makes the mcp projector list it as a template rather than a resource.
//
// Input: a tool's `inputSchema` (an object schema) becomes the operation's
// named-params object; a prompt's arguments become string fields (optional
// unless `required`); a template's variables become string fields; a fixed
// resource takes none. Output: a tool's `outputSchema` when present; prompts
// and resources have no declared output type, so it stays absent.
//
// Meta: tool annotation hints become `meta.tags` (only the hints present, so
// unknown stays unknown). Fields with no existing reader (`icons`, `execution`,
// `_meta`, resource `annotations`/`size`, ...) are carried verbatim under
// `meta.mcp`.
//
// Named schemas: `$defs`/`definitions` inside a tool's schemas are hoisted into
// `api.defs`. Two tools defining the same name differently keep both, the
// later one renamed `<tool>.<name>`.
//
// Spec references: MCP specification 2026-07-28, server/tools (Data Types:
// Tool, Tool Names, Output Schema), server/prompts (Data Types: Prompt),
// server/resources (Data Types: Resource, Resource Templates, Annotations),
// basic (JSON Schema usage: default dialect 2020-12). ToolAnnotations
// (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint) as
// defined by the schema (@modelcontextprotocol/sdk 1.29.0 `ToolAnnotations`).
// URI templates: RFC 6570 §2.2 (Expressions), §2.3 (Variables), §3.2.1
// (Variable Expansion).

import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { fromJsonSchema } from "@rhi-zone/fractal-type-ir/from-json-schema";
import type { Diagnostic, Imported, Operation, Segment } from "./api-description.ts";
import { noInput } from "./api-description.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const stat = (name: string): Segment => ({ kind: "static", name });

const HINTS = [
  ["readOnlyHint", "readOnly"],
  ["destructiveHint", "destructive"],
  ["idempotentHint", "idempotent"],
  ["openWorldHint", "openWorld"],
] as const;

/** Every field of `o` outside `handled`, for verbatim carry-over. */
function rest(o: Obj, handled: ReadonlySet<string>): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (!handled.has(k)) out[k] = v;
  return out;
}

/** The array a list-result key holds, whether given bare or as the whole result. */
function listOf(input: Obj, key: string, diagnostics: Diagnostic[]): readonly unknown[] {
  const v = input[key];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (isObj(v) && Array.isArray(v[key])) return v[key] as unknown[];
  diagnostics.push({ at: key, message: `expected an array or a list result carrying "${key}"` });
  return [];
}

// ---------------------------------------------------------------------------
// Schemas and named defs
// ---------------------------------------------------------------------------

const LOCAL_REF = /^#\/(\$defs|definitions)\/([^/]+)$/;

/** `schema` with every local def reference renamed through `rename`; anything that is not a local def reference is reported and left alone. */
function rewriteRefs(
  schema: unknown,
  rename: ReadonlyMap<string, string>,
  at: string,
  diagnostics: Diagnostic[],
): unknown {
  if (Array.isArray(schema)) return schema.map((s) => rewriteRefs(s, rename, at, diagnostics));
  if (!isObj(schema)) return schema;
  const out: Obj = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$ref" && typeof v === "string") {
      const m = LOCAL_REF.exec(v);
      if (m === null) {
        diagnostics.push({
          at,
          message: `reference "${v}" is not a local $defs/definitions entry`,
        });
        out[k] = v;
      } else {
        const name = decodeURIComponent(m[2]!).replaceAll("~1", "/").replaceAll("~0", "~");
        out[k] = `#/$defs/${rename.get(name) ?? name}`;
      }
    } else {
      out[k] = rewriteRefs(v, rename, at, diagnostics);
    }
  }
  return out;
}

type Defs = {
  readonly table: Record<string, TypeRef>;
  readonly source: Map<string, string>;
};

/**
 * Convert `schema` to a TypeRef, hoisting its local `$defs`/`definitions` into
 * `defs`. A def whose name is taken by a different definition is renamed
 * `<owner>.<name>` (with a numeric suffix if that is taken too), and every
 * reference inside `schema` follows the rename.
 */
function convert(
  schema: Obj,
  owner: string,
  defs: Defs,
  at: string,
  diagnostics: Diagnostic[],
): TypeRef {
  const local: Obj = {
    ...(isObj(schema.definitions) ? schema.definitions : {}),
    ...(isObj(schema.$defs) ? schema.$defs : {}),
  };
  const { $defs: _a, definitions: _b, $schema: _c, ...body } = schema;

  const rename = new Map<string, string>();
  const silent: Diagnostic[] = [];
  for (let pass = 0; pass <= Object.keys(local).length; pass++) {
    let changed = false;
    for (const [name, def] of Object.entries(local)) {
      const key = rename.get(name) ?? name;
      const seen = defs.source.get(key);
      const json = JSON.stringify(rewriteRefs(def, rename, at, silent));
      if (seen === undefined || seen === json) continue;
      let candidate = `${owner}.${name}`;
      for (let n = 2; defs.source.has(candidate); n++) candidate = `${owner}.${name}~${n}`;
      rename.set(name, candidate);
      changed = true;
    }
    if (!changed) break;
  }
  for (const [name, def] of Object.entries(local)) {
    const key = rename.get(name) ?? name;
    const rewritten = rewriteRefs(def, rename, `${at}/$defs/${name}`, diagnostics);
    defs.source.set(key, JSON.stringify(rewritten));
    defs.table[key] = withMeta(fromJsonSchema(rewritten as Obj), { typeName: key });
    if (key !== name) {
      diagnostics.push({
        at: `${at}/$defs/${name}`,
        message: `definition "${name}" differs from another tool's; renamed "${key}"`,
      });
    }
  }
  return fromJsonSchema(rewriteRefs(body, rename, at, diagnostics) as Obj);
}

// ---------------------------------------------------------------------------
// URI templates (RFC 6570)
// ---------------------------------------------------------------------------

/** The variable names a URI template mentions in order, deduplicated, and whether every expression is a plain `{name}`. */
function templateVariables(template: string): { names: string[]; simple: boolean } {
  const names: string[] = [];
  let simple = true;
  for (const m of template.matchAll(/\{([^}]*)\}/g)) {
    let expr = m[1]!;
    if (/^[+#./;?&=,!@|]/.test(expr)) {
      simple = false;
      expr = expr.slice(1);
    }
    for (const spec of expr.split(",")) {
      if (/[*:]/.test(spec)) simple = false;
      const name = spec.replace(/\*$/, "").replace(/:\d+$/, "");
      if (name.length > 0 && !names.includes(name)) names.push(name);
    }
  }
  return { names, simple };
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

const TOOL_HANDLED = new Set([
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
]);
const PROMPT_HANDLED = new Set(["name", "title", "description", "arguments"]);
const RESOURCE_HANDLED = new Set([
  "name",
  "title",
  "description",
  "uri",
  "uriTemplate",
  "mimeType",
]);

export function fromMcpListing(input: unknown): Imported {
  if (!isObj(input)) throw new Error("fromMcpListing: listing must be a JSON object");
  const diagnostics: Diagnostic[] = [];
  const operations: Operation[] = [];
  const defs: Defs = { table: {}, source: new Map() };

  const entries = (key: string): [number, Obj, string][] => {
    const out: [number, Obj, string][] = [];
    const used = new Set<string>();
    listOf(input, key, diagnostics).forEach((raw, i) => {
      const at = `${key}/${i}`;
      if (!isObj(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
        diagnostics.push({ at, message: "entry has no string name; skipped" });
        return;
      }
      if (used.has(raw.name)) {
        diagnostics.push({ at, message: `duplicate name "${raw.name}"; skipped` });
        return;
      }
      used.add(raw.name);
      out.push([i, raw, at]);
    });
    return out;
  };

  const withDescription = (description: string | undefined, mcp: Obj): Obj => ({
    ...(description !== undefined ? { description } : {}),
    mcp,
  });

  // Tools.
  for (const [, tool, at] of entries("tools")) {
    const name = tool.name as string;
    const description = asString(tool.description);
    const title = asString(tool.title);

    let inputRaw: Obj | undefined;
    if (isObj(tool.inputSchema)) inputRaw = tool.inputSchema;
    else
      diagnostics.push({
        at: `${at}/inputSchema`,
        message: "missing object schema; input is empty",
      });
    let inputType: TypeRef = noInput();
    const mcpExtra: Obj = {};
    if (inputRaw !== undefined) {
      const converted = convert(inputRaw, `tool:${name}`, defs, `${at}/inputSchema`, diagnostics);
      if (converted.shape.kind === "object") inputType = converted;
      else {
        diagnostics.push({
          at: `${at}/inputSchema`,
          message: `schema is not an object schema with properties; input is empty and the schema is kept in meta.mcp.inputSchema`,
        });
        mcpExtra.inputSchema = inputRaw;
      }
    }

    let output: TypeRef | undefined;
    if (tool.outputSchema !== undefined) {
      if (isObj(tool.outputSchema)) {
        output = convert(
          tool.outputSchema,
          `tool:${name}`,
          defs,
          `${at}/outputSchema`,
          diagnostics,
        );
      } else {
        diagnostics.push({ at: `${at}/outputSchema`, message: "not a schema object; skipped" });
      }
    }

    const tags: Obj = {};
    let annotationExtra: Obj | undefined;
    if (tool.annotations !== undefined) {
      if (isObj(tool.annotations)) {
        for (const [hint, tag] of HINTS) {
          const v = tool.annotations[hint];
          if (typeof v === "boolean") tags[tag] = v;
          else if (v !== undefined) {
            diagnostics.push({
              at: `${at}/annotations/${hint}`,
              message: "not a boolean; skipped",
            });
          }
        }
        if (tags.readOnly === true && tags.destructive === true) {
          diagnostics.push({
            at: `${at}/annotations`,
            message: "readOnlyHint and destructiveHint are both true",
          });
        }
        const others = rest(tool.annotations, new Set(HINTS.map(([h]) => h)));
        if (Object.keys(others).length > 0) annotationExtra = others;
        if (title !== undefined && others.title !== undefined && others.title !== title) {
          diagnostics.push({
            at: `${at}/annotations/title`,
            message: "differs from the tool's title; the tool's title wins when projected",
          });
        }
      } else {
        diagnostics.push({ at: `${at}/annotations`, message: "not an object; skipped" });
      }
    }

    const mcp: Obj = {
      ...rest(tool, TOOL_HANDLED),
      ...mcpExtra,
      as: "tool",
      name,
      ...(description !== undefined ? { description } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(annotationExtra !== undefined ? { annotations: annotationExtra } : {}),
    };
    operations.push({
      address: [stat("tools"), stat(name)],
      input: inputType,
      ...(output !== undefined ? { output } : {}),
      meta: {
        ...withDescription(description, mcp),
        ...(Object.keys(tags).length > 0 ? { tags } : {}),
      },
    });
  }

  // Prompts.
  for (const [, prompt, at] of entries("prompts")) {
    const name = prompt.name as string;
    const description = asString(prompt.description);
    const title = asString(prompt.title);
    const fields: Record<string, TypeRef> = {};
    const argumentExtras: Obj = {};
    if (prompt.arguments !== undefined) {
      const args = Array.isArray(prompt.arguments) ? prompt.arguments : [];
      if (!Array.isArray(prompt.arguments)) {
        diagnostics.push({ at: `${at}/arguments`, message: "not an array; skipped" });
      }
      args.forEach((raw, j) => {
        const argAt = `${at}/arguments/${j}`;
        if (!isObj(raw) || typeof raw.name !== "string") {
          diagnostics.push({ at: argAt, message: "argument has no string name; skipped" });
          return;
        }
        if (raw.name in fields) {
          diagnostics.push({ at: argAt, message: `duplicate argument "${raw.name}"; skipped` });
          return;
        }
        const extra: Obj = {};
        if (raw.required !== true) extra.optional = true;
        const d = asString(raw.description);
        if (d !== undefined) extra.description = d;
        fields[raw.name] = withMeta(t(types.string), extra);
        const others = rest(raw, new Set(["name", "description", "required"]));
        if (Object.keys(others).length > 0) argumentExtras[raw.name] = others;
      });
    }
    const mcp: Obj = {
      ...rest(prompt, PROMPT_HANDLED),
      ...(Object.keys(argumentExtras).length > 0 ? { argumentExtras } : {}),
      as: "prompt",
      name,
      ...(description !== undefined ? { description } : {}),
      ...(title !== undefined ? { title } : {}),
    };
    operations.push({
      address: [stat("prompts"), stat(name)],
      input: t(types.object(fields)),
      meta: withDescription(description, mcp),
    });
  }

  // Resources and resource templates share one URI space.
  const uris = new Set<string>();
  const claimUri = (uri: string, at: string): boolean => {
    if (uris.has(uri)) {
      diagnostics.push({ at, message: `duplicate URI "${uri}"; skipped` });
      return false;
    }
    uris.add(uri);
    return true;
  };

  for (const [, resource, at] of entries("resources")) {
    const name = resource.name as string;
    const uri = asString(resource.uri);
    if (uri === undefined) {
      diagnostics.push({ at: `${at}/uri`, message: "resource has no string uri; skipped" });
      continue;
    }
    if (!claimUri(uri, at)) continue;
    const description = asString(resource.description);
    const title = asString(resource.title);
    const mimeType = asString(resource.mimeType);
    const mcp: Obj = {
      ...rest(resource, RESOURCE_HANDLED),
      as: "resource",
      name,
      uri,
      ...(description !== undefined ? { description } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
    };
    operations.push({
      address: [stat("resources"), stat(name)],
      input: noInput(),
      meta: withDescription(description, mcp),
    });
  }

  for (const [, template, at] of entries("resourceTemplates")) {
    const name = template.name as string;
    const uriTemplate = asString(template.uriTemplate);
    if (uriTemplate === undefined) {
      diagnostics.push({
        at: `${at}/uriTemplate`,
        message: "resource template has no string uriTemplate; skipped",
      });
      continue;
    }
    if (!claimUri(uriTemplate, at)) continue;
    const { names, simple } = templateVariables(uriTemplate);
    if (names.length === 0) {
      diagnostics.push({
        at: `${at}/uriTemplate`,
        message: "template has no variables; it projects as a fixed resource",
      });
    }
    if (!simple) {
      diagnostics.push({
        at: `${at}/uriTemplate`,
        message:
          "template uses RFC 6570 operators or modifiers; variables are read by name but the projector matches only plain {name} expressions",
      });
    }
    const description = asString(template.description);
    const title = asString(template.title);
    const mimeType = asString(template.mimeType);
    const fields: Record<string, TypeRef> = {};
    for (const v of names) fields[v] = t(types.string);
    const mcp: Obj = {
      ...rest(template, RESOURCE_HANDLED),
      as: "resource",
      name,
      uri: uriTemplate,
      ...(description !== undefined ? { description } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
    };
    operations.push({
      address: [
        stat("resourceTemplates"),
        stat(name),
        ...names.map((v): Segment => ({ kind: "param", name: v })),
        stat("read"),
      ],
      input: t(types.object(fields)),
      meta: withDescription(description, mcp),
    });
  }

  return { api: { operations, groups: [], defs: defs.table }, diagnostics };
}
