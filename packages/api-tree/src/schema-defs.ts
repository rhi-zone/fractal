// Rebasing self-contained JSON Schemas (root + own `$defs`, the form
// lower.ts's `toSelfContainedJsonSchema` and `toJsonSchemaDocument` produce)
// onto a document-level registry such as OpenAPI's or OpenRPC's
// `components.schemas`, where a `#` ref resolves against the enclosing
// document rather than the schema.

type JsonSchema = Record<string, unknown>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const DEFS_PREFIX = "#/$defs/";
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

/** `schema` with every `#/$defs/NAME...` ref whose NAME is in `mapping` pointed at `prefix` + the mapped name. */
function rewriteRefs(
  schema: unknown,
  mapping: ReadonlyMap<string, string>,
  prefix: string,
): unknown {
  if (Array.isArray(schema)) return schema.map((s) => rewriteRefs(s, mapping, prefix));
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
          : `${prefix}${escapePointer(target)}${slash === -1 ? "" : rest.slice(slash)}`;
    } else if (DATA_KEYS.has(k)) {
      out[k] = v;
    } else if (SCHEMA_MAPS.has(k) && isObj(v)) {
      out[k] = Object.fromEntries(
        Object.entries(v).map(([name, s]) => [name, rewriteRefs(s, mapping, prefix)]),
      );
    } else out[k] = rewriteRefs(v, mapping, prefix);
  }
  return out;
}

/**
 * Moves `schema`'s top-level `$defs` into the shared `registry` and returns
 * `schema` without them, with every `#/$defs/NAME` ref rewritten to
 * `prefix + NAME` (e.g. `"#/components/schemas/"`). A def whose name is
 * already in `registry` with a different value is stored as `NAME_2`,
 * `NAME_3`, ... and its refs follow. Values under data keywords (`enum`,
 * `const`, `default`, `example(s)`) are never rewritten. Mutates `registry`
 * only; `schema` is not modified.
 */
export function hoistDefs(
  schema: JsonSchema,
  registry: Record<string, JsonSchema>,
  prefix: string,
): JsonSchema {
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
      const rewritten = rewriteRefs(defs[name], mapping, prefix) as JsonSchema;
      let target = mapping.get(name)!;
      while (
        registry[target] !== undefined &&
        canonical(registry[target]) !== canonical(rewritten)
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
  for (const name of names) registry[mapping.get(name)!] = settled.get(name)!;
  return rewriteRefs(rest, mapping, prefix) as JsonSchema;
}
