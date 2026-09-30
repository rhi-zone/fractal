// RAML 1.0 data type declarations (already parsed from YAML, `!include`s
// resolved) -> TypeRef. Covers `types`, inline declarations (properties,
// parameters, bodies), type expressions, inheritance, facets and JSON/XML
// schema strings. The API-level importer (api-tree's from-raml.ts) owns
// resources, methods, templates and file loading, and calls this module for
// every type they mention.
//
// Names: a declared type is a def keyed by `context.keyOf(name)`; a
// reference to it is `{ kind: "ref", target: key }`. A name with no
// declaration is reported and becomes `unknown` with
// `meta.raml.unresolvedType`.
//
// Built-ins: any -> unknown; object -> object; array -> array; string;
// number; integer; boolean; nil -> null; date-only -> date; time-only -> time;
// datetime -> datetime (`meta.raml.format = "rfc2616"` for that format);
// datetime-only -> datetime with `meta.raml.type = "datetime-only"` (no
// offset); file -> bytes with `meta.raml.type = "file"`. `format` on
// number/integer selects int8/int16/int32/int64/float32/float64 (`int` is
// int32, `long` is int64).
//
// Expressions: `T[]` is an array, `A | B` a union (`| nil` or a trailing `?`
// sets `meta.nullable` instead of a `null` variant), parentheses group.
//
// Inheritance: a declaration whose parent is not a built-in and that adds
// properties or items is an intersection of its parents and its own
// structure; one that only adds facets is the parent reference carrying the
// facets as meta. Multiple inheritance is an intersection of the parents.
//
// Properties: a trailing `?` on the key, or `required: false`, sets
// `meta.optional`; an explicit `required` makes a `?` part of the name, and a
// doubled `??` is an optional property whose name ends in `?`. A `//` pattern
// property with no declared properties is a `map(string, T)`; with declared
// properties it is `meta.additionalPropertyType`. Other pattern properties
// are kept in `meta.raml.patternProperties`.
//
// Facets: minimum, maximum, multipleOf, minLength, maxLength, pattern,
// minItems, maxItems, uniqueItems, minProperties, maxProperties,
// additionalProperties, default are `meta` keys of the same name;
// displayName is `meta.title`; description is `meta.description`;
// example/examples are `meta.examples` (values only). `enum` becomes an `enum`
// (all strings) or a union of `literal`s. Everything without an equivalent is
// under `meta.raml`: annotations, facets (declarations), facetValues (values
// of user-defined facets), xml, discriminator, discriminatorValue, fileTypes.
//
// External schemas: a string beginning with `{` is a JSON Schema and goes
// through `fromJsonSchema`; its `definitions`/`$defs` are returned as defs
// keyed by their names. A string beginning with `<` is an XML Schema, which
// is not represented.
//
// Spec references: RAML 1.0 "RAML Data Types" (Defining Types, Type
// Declarations, Built-in Types, Object Type, Property Declarations,
// Additional Properties, Using Discriminator, Array Type, Scalar Types, Union
// Type, Using XML and JSON Schemas, User-defined Facets, Determine Default
// Types, Type Expressions, Multiple Inheritance, Defining Examples in RAML),
// "Annotations".

import { t, types, type TypeRef } from "./index.ts";
import {
  bytes,
  date,
  datetime,
  float32,
  float64,
  int16,
  int32,
  int64,
  int8,
  time,
} from "./kinds/common.ts";
import { fromJsonSchema } from "./from-json-schema.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type RamlTypeDiagnostic = { readonly at: string; readonly message: string };

/** Name resolution in one file's scope. */
export type RamlScope = {
  /** The def key `name` (`Name`, or `alias.Name` for a library type) denotes here, or `undefined` when nothing by that name is declared. */
  readonly keyOf: (name: string) => string | undefined;
};

export type RamlTypeContext = RamlScope & {
  /** The declaration behind a def key and the scope its own names resolve in. */
  readonly lookup: (
    key: string,
  ) => { readonly decl: unknown; readonly scope: RamlScope } | undefined;
};

export type RamlTypeResult<T> = {
  readonly value: T;
  /** Defs the conversion itself introduced (a JSON Schema's `definitions`), keyed by name. */
  readonly defs: Readonly<Record<string, TypeRef>>;
  readonly diagnostics: readonly RamlTypeDiagnostic[];
};

export type RamlTypeOptions = {
  /** Location used in diagnostics. */
  readonly at?: string;
  /** What a declaration with neither `type` nor a type-specific facet is: `string` (types, properties, parameters) or `any` (bodies). */
  readonly defaultType?: "string" | "any";
};

export type RamlProperty = {
  readonly name: string;
  readonly type: TypeRef;
  readonly optional: boolean;
};

const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "any",
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "date-only",
  "time-only",
  "datetime-only",
  "datetime",
  "file",
  "nil",
]);

const OBJECT_FACETS = [
  "properties",
  "minProperties",
  "maxProperties",
  "additionalProperties",
  "discriminator",
  "discriminatorValue",
] as const;
const ARRAY_FACETS = ["items", "minItems", "maxItems", "uniqueItems"] as const;
const STRING_FACETS = ["pattern", "minLength", "maxLength"] as const;
const NUMBER_FACETS = ["minimum", "maximum", "multipleOf"] as const;

// Facets that map onto a same-named meta key.
const PLAIN_FACETS = [
  "minimum",
  "maximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
] as const;

// Keys handled outside facet-to-meta mapping.
const STRUCTURAL: ReadonlySet<string> = new Set([
  "type",
  "schema",
  "properties",
  "items",
  "enum",
  "required",
  "format",
  "allowedTargets",
  "usage",
  "displayName",
  "description",
  "example",
  "examples",
  "facets",
  "xml",
  "additionalProperties",
  "discriminator",
  "discriminatorValue",
  "fileTypes",
  ...PLAIN_FACETS,
]);

// ---------------------------------------------------------------------------
// Type expressions
// ---------------------------------------------------------------------------

type Expr =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "array"; readonly of: Expr }
  | { readonly kind: "union"; readonly of: readonly Expr[] };

/** `undefined` when `src` is not a well-formed type expression. */
function parseExpression(src: string): Expr | undefined {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "(" || c === ")" || c === "|") {
      tokens.push(c);
      i++;
    } else if (c === "[") {
      if (src[i + 1] !== "]") return undefined;
      tokens.push("[]");
      i += 2;
    } else {
      let j = i;
      while (j < src.length && !/[\s()|[\]]/.test(src[j]!)) j++;
      if (j === i) return undefined;
      tokens.push(src.slice(i, j));
      i = j;
    }
  }
  let pos = 0;
  const primary = (): Expr | undefined => {
    const tok = tokens[pos];
    if (tok === undefined) return undefined;
    if (tok === "(") {
      pos++;
      const inner = union();
      if (inner === undefined || tokens[pos] !== ")") return undefined;
      pos++;
      return inner;
    }
    if (tok === ")" || tok === "|" || tok === "[]") return undefined;
    pos++;
    return { kind: "name", name: tok };
  };
  const postfix = (): Expr | undefined => {
    let e = primary();
    while (e !== undefined && tokens[pos] === "[]") {
      pos++;
      e = { kind: "array", of: e };
    }
    return e;
  };
  const union = (): Expr | undefined => {
    const first = postfix();
    if (first === undefined) return undefined;
    const members: Expr[] = [first];
    while (tokens[pos] === "|") {
      pos++;
      const next = postfix();
      if (next === undefined) return undefined;
      members.push(next);
    }
    return members.length === 1 ? first : { kind: "union", of: members };
  };
  const result = union();
  return result !== undefined && pos === tokens.length ? result : undefined;
}

function namesIn(e: Expr): string[] {
  if (e.kind === "name") return [e.name];
  if (e.kind === "array") return namesIn(e.of);
  return e.of.flatMap(namesIn);
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

// `meta.raml` is merged one level deep, every other key is replaced.
const withMeta = (ref: TypeRef, extra: Obj): TypeRef => {
  if (Object.keys(extra).length === 0) return ref;
  const meta: Obj = { ...ref.meta, ...extra };
  if (isObj(ref.meta.raml) && isObj(extra.raml)) meta.raml = { ...ref.meta.raml, ...extra.raml };
  return { shape: ref.shape, meta };
};

const withRaml = (ref: TypeRef, extra: Obj): TypeRef =>
  withMeta(ref, { raml: { ...(isObj(ref.meta.raml) ? ref.meta.raml : {}), ...extra } });

type Run = {
  readonly ctx: RamlTypeContext;
  readonly defs: Record<string, TypeRef>;
  readonly diagnostics: RamlTypeDiagnostic[];
};

const INT_FORMATS: Readonly<Record<string, () => TypeRef>> = {
  int8: () => int8(),
  int16: () => int16(),
  int32: () => int32(),
  int: () => int32(),
  int64: () => int64(),
  long: () => int64(),
};

function builtin(name: string, format: unknown, run: Run, at: string): TypeRef {
  switch (name) {
    case "any":
      return t(types.unknown);
    case "object":
      return t(types.object({}));
    case "array":
      return t(types.array(t(types.unknown)));
    case "string":
      return t(types.string);
    case "boolean":
      return t(types.boolean);
    case "nil":
      return t(types.null);
    case "date-only":
      return date();
    case "time-only":
      return time();
    case "datetime-only":
      return datetime({ raml: { type: "datetime-only" } });
    case "file":
      return bytes({ raml: { type: "file" } });
    case "datetime":
      if (format === undefined || format === "rfc3339") return datetime();
      if (format === "rfc2616") return datetime({ raml: { format: "rfc2616" } });
      run.diagnostics.push({
        at,
        message: `datetime format "${String(format)}" is not rfc3339 or rfc2616`,
      });
      return datetime({ format });
    default: {
      const isInteger = name === "integer";
      if (typeof format === "string") {
        const int = INT_FORMATS[format];
        if (int !== undefined) return int();
        if (format === "float") return float32();
        if (format === "double") return float64();
        run.diagnostics.push({ at, message: `number format "${format}" is not recognised` });
        return t(isInteger ? types.integer : types.number, { format });
      }
      return t(isInteger ? types.integer : types.number);
    }
  }
}

const isBuiltinName = (s: string): boolean => BUILTIN_NAMES.has(s);

function unresolved(name: string, run: Run, at: string): TypeRef {
  run.diagnostics.push({ at, message: `type "${name}" is not declared` });
  return t(types.unknown, { raml: { unresolvedType: name } });
}

function fromExpr(e: Expr, run: Run, at: string): TypeRef {
  if (e.kind === "name") {
    if (isBuiltinName(e.name)) return builtin(e.name, undefined, run, at);
    const key = run.ctx.keyOf(e.name);
    return key === undefined ? unresolved(e.name, run, at) : t(types.ref(key));
  }
  if (e.kind === "array") return t(types.array(fromExpr(e.of, run, at)));
  const variants = e.of.map((m) => fromExpr(m, run, at));
  const isNil = (v: TypeRef): boolean => v.shape.kind === "null";
  const rest = variants.filter((v) => !isNil(v));
  if (rest.length === variants.length) return t(types.union(variants));
  if (rest.length === 0) return t(types.null);
  if (rest.length === 1) return withMeta(rest[0]!, { nullable: true });
  return t(types.union(rest), { nullable: true });
}

function fromExternalSchema(text: string, run: Run, at: string): TypeRef {
  if (text.startsWith("<")) {
    run.diagnostics.push({ at, message: "XML schemas are not represented" });
    return t(types.unknown, { raml: { xmlSchema: text } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    run.diagnostics.push({ at, message: "schema looks like JSON but does not parse" });
    return t(types.unknown, { raml: { schema: text } });
  }
  if (!isObj(parsed)) {
    run.diagnostics.push({ at, message: "JSON schema is not an object" });
    return t(types.unknown, { raml: { schema: text } });
  }
  for (const holder of [parsed.definitions, parsed.$defs]) {
    if (!isObj(holder)) continue;
    for (const [name, schema] of Object.entries(holder)) {
      if (isObj(schema) && !(name in run.defs)) run.defs[name] = fromJsonSchema(schema);
    }
  }
  return fromJsonSchema(parsed);
}

function fromString(src: string, run: Run, at: string): TypeRef {
  const text = src.trim();
  if (text.startsWith("{") || text.startsWith("<")) return fromExternalSchema(text, run, at);
  const nilable = text.endsWith("?");
  const expr = parseExpression(nilable ? text.slice(0, -1) : text);
  if (expr === undefined) {
    run.diagnostics.push({ at, message: `"${src}" is not a valid type expression` });
    return t(types.unknown, { raml: { unresolvedType: src } });
  }
  const ref = fromExpr(expr, run, at);
  return nilable ? withMeta(ref, { nullable: true }) : ref;
}

function typeList(decl: Obj): unknown[] {
  const v = decl.type ?? decl.schema;
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Names of the user-defined facets `decl` and every ancestor declare. */
function declaredFacets(
  decl: unknown,
  scope: RamlScope,
  run: Run,
  seen: Set<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  if (!isObj(decl)) return out;
  if (isObj(decl.facets)) for (const k of Object.keys(decl.facets)) out.add(k.replace(/\?$/, ""));
  for (const parent of typeList(decl)) {
    const names: string[] = [];
    if (typeof parent === "string") {
      const e = parseExpression(parent.trim().replace(/\?$/, ""));
      if (e !== undefined) names.push(...namesIn(e));
    }
    for (const name of names) {
      if (isBuiltinName(name)) continue;
      const key = scope.keyOf(name);
      const found = key === undefined ? undefined : run.ctx.lookup(key);
      if (key === undefined || found === undefined || seen.has(key)) continue;
      seen.add(key);
      for (const f of declaredFacets(found.decl, found.scope, run, seen)) out.add(f);
    }
    if (isObj(parent)) for (const f of declaredFacets(parent, scope, run, seen)) out.add(f);
  }
  return out;
}

const exampleValue = (ex: unknown): unknown => (isObj(ex) && "value" in ex ? ex.value : ex);

function facetMeta(own: Obj, run: Run, at: string): Obj {
  const meta: Obj = {};
  const raml: Obj = {};
  if (typeof own.description === "string") meta.description = own.description;
  if (typeof own.displayName === "string") meta.title = own.displayName;
  for (const k of PLAIN_FACETS) if (own[k] !== undefined) meta[k] = own[k];
  if (typeof own.additionalProperties === "boolean")
    meta.additionalProperties = own.additionalProperties;
  const examples: unknown[] = [];
  if (own.example !== undefined) examples.push(exampleValue(own.example));
  if (isObj(own.examples))
    for (const ex of Object.values(own.examples)) examples.push(exampleValue(ex));
  if (examples.length > 0) meta.examples = examples;

  const annotations: Obj = {};
  for (const [k, v] of Object.entries(own)) {
    if (k.startsWith("(") && k.endsWith(")")) annotations[k.slice(1, -1)] = v;
  }
  if (Object.keys(annotations).length > 0) raml.annotations = annotations;
  if (own.facets !== undefined) raml.facets = own.facets;
  if (own.xml !== undefined) raml.xml = own.xml;
  if (own.discriminator !== undefined) raml.discriminator = own.discriminator;
  if (own.discriminatorValue !== undefined) raml.discriminatorValue = own.discriminatorValue;
  if (own.fileTypes !== undefined) raml.fileTypes = own.fileTypes;

  const facetValues: Obj = {};
  const custom = Object.keys(own).filter((k) => !STRUCTURAL.has(k) && !k.startsWith("("));
  if (custom.length > 0) {
    const declared = declaredFacets(own, run.ctx, run);
    for (const k of custom) {
      facetValues[k] = own[k];
      if (!declared.has(k))
        run.diagnostics.push({ at, message: `"${k}" is not a built-in or declared facet` });
    }
    raml.facetValues = facetValues;
  }
  if (Object.keys(raml).length > 0) meta.raml = raml;
  return meta;
}

function ownProperties(
  own: Obj,
  run: Run,
  at: string,
): { fields: Record<string, TypeRef>; patterns: Record<string, TypeRef> } {
  const fields: Record<string, TypeRef> = {};
  const patterns: Record<string, TypeRef> = {};
  if (own.properties !== undefined && own.properties !== null && !isObj(own.properties)) {
    run.diagnostics.push({ at, message: "properties is not a map; ignored" });
  }
  if (!isObj(own.properties)) return { fields, patterns };
  for (const [key, decl] of Object.entries(own.properties)) {
    if (key.length >= 2 && key.startsWith("/") && key.endsWith("/")) {
      patterns[key.slice(1, -1)] = convert(decl, run, `${at}.properties.${key}`, "string");
      continue;
    }
    const prop = property(key, decl, run, `${at}.properties.${key}`, true);
    if (prop.name in fields) {
      run.diagnostics.push({
        at,
        message: `property "${prop.name}" is declared twice; the first is kept`,
      });
      continue;
    }
    fields[prop.name] = prop.optional ? withMeta(prop.type, { optional: true }) : prop.type;
  }
  return { fields, patterns };
}

function objectType(own: Obj, run: Run, at: string): TypeRef {
  const { fields, patterns } = ownProperties(own, run, at);
  const anyKey = patterns[""];
  const other = Object.entries(patterns).filter(([k]) => k !== "");
  if (
    Object.keys(fields).length === 0 &&
    anyKey !== undefined &&
    own.additionalProperties !== false &&
    other.length === 0
  ) {
    return t(types.map(t(types.string), anyKey));
  }
  let meta: Obj = {};
  if (anyKey !== undefined) meta.additionalPropertyType = anyKey;
  if (other.length > 0) {
    run.diagnostics.push({
      at,
      message: "pattern properties are kept in meta.raml.patternProperties and not enforced",
    });
    meta = { ...meta, raml: { patternProperties: Object.fromEntries(other) } };
  }
  return t(types.object(fields), meta);
}

function hasKeys(own: Obj, keys: readonly string[]): boolean {
  return keys.some((k) => own[k] !== undefined);
}

function inferBase(own: Obj, defaultType: "string" | "any"): string {
  if (hasKeys(own, OBJECT_FACETS)) return "object";
  if (hasKeys(own, ARRAY_FACETS)) return "array";
  if (hasKeys(own, STRING_FACETS)) return "string";
  if (hasKeys(own, NUMBER_FACETS)) return "number";
  if (own.fileTypes !== undefined) return "file";
  if (own.format === "rfc3339" || own.format === "rfc2616") return "datetime";
  if (
    typeof own.format === "string" &&
    (own.format in INT_FORMATS || own.format === "float" || own.format === "double")
  ) {
    return "number";
  }
  return defaultType === "any" ? "any" : "string";
}

function applyEnum(result: TypeRef, values: unknown, run: Run, at: string): TypeRef {
  if (!Array.isArray(values)) {
    run.diagnostics.push({ at, message: "enum is not a list; ignored" });
    return result;
  }
  const meta = { ...result.meta };
  if (values.every((v) => typeof v === "string")) return t(types.enum(values as string[]), meta);
  if (values.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
    return t(
      types.union(values.map((v) => t(types.literal(v as string | number | boolean | null)))),
      meta,
    );
  }
  run.diagnostics.push({ at, message: "enum has non-scalar members; kept in meta.raml.enum" });
  return withRaml(result, { enum: values });
}

function convertMap(own: Obj, run: Run, at: string, defaultType: "string" | "any"): TypeRef {
  if (own.type !== undefined && own.schema !== undefined) {
    run.diagnostics.push({
      at,
      message: '"type" and "schema" are both declared; "schema" is ignored',
    });
  }
  const parents = typeList(own);
  const single =
    parents.length === 1 && typeof parents[0] === "string" ? parents[0].trim() : undefined;
  const builtinBase = single !== undefined && isBuiltinName(single) ? single : undefined;
  const meta = facetMeta(own, run, at);
  let result: TypeRef;

  if (builtinBase !== undefined || parents.length === 0) {
    const base = builtinBase ?? inferBase(own, defaultType);
    if (base === "object") result = objectType(own, run, at);
    else if (base === "array") {
      result = t(
        types.array(
          own.items === undefined
            ? t(types.unknown)
            : convert(own.items, run, `${at}.items`, "any"),
        ),
      );
    } else result = builtin(base, own.format, run, at);
    if (
      typeof own.format === "string" &&
      base !== "datetime" &&
      base !== "number" &&
      base !== "integer"
    ) {
      run.diagnostics.push({ at, message: `format "${own.format}" does not apply to ${base}` });
      result = withMeta(result, { format: own.format });
    }
    result = withMeta(result, meta);
  } else {
    const refs = parents.map((p, i) => convert(p, run, `${at}.type[${i}]`, defaultType));
    const structure: TypeRef[] = [];
    if (own.properties !== undefined) structure.push(objectType(own, run, at));
    if (own.items !== undefined)
      structure.push(t(types.array(convert(own.items, run, `${at}.items`, "any"))));
    const members = [...refs, ...structure];
    const format = typeof own.format === "string" ? { format: own.format } : {};
    const merged = { ...meta, ...format };
    result =
      members.length === 1 ? withMeta(members[0]!, merged) : t(types.intersection(members), merged);
  }
  return own.enum === undefined ? result : applyEnum(result, own.enum, run, at);
}

function convert(decl: unknown, run: Run, at: string, defaultType: "string" | "any"): TypeRef {
  if (decl === null || decl === undefined)
    return t(defaultType === "any" ? types.unknown : types.string);
  if (typeof decl === "string") return fromString(decl, run, at);
  if (Array.isArray(decl)) return convertMap({ type: decl }, run, at, defaultType);
  if (isObj(decl)) return convertMap(decl, run, at, defaultType);
  run.diagnostics.push({ at, message: "not a type declaration" });
  return t(types.unknown);
}

function property(
  key: string,
  decl: unknown,
  run: Run,
  at: string,
  requiredByDefault: boolean,
): RamlProperty {
  const explicit = isObj(decl) && typeof decl.required === "boolean" ? decl.required : undefined;
  let name = key;
  let required = requiredByDefault;
  if (explicit !== undefined) required = explicit;
  else if (key.endsWith("?")) {
    name = key.slice(0, -1);
    required = false;
  }
  let body = decl;
  if (isObj(decl) && "required" in decl) {
    const rest = { ...decl };
    delete rest.required;
    body = rest;
  }
  return { name, type: convert(body, run, at, "string"), optional: !required };
}

function newRun(ctx: RamlTypeContext): Run {
  return { ctx, defs: {}, diagnostics: [] };
}

const result = <T>(run: Run, value: T): RamlTypeResult<T> => ({
  value,
  defs: run.defs,
  diagnostics: run.diagnostics,
});

/** One type declaration (a `type`/`schema` value, an inline declaration, a parameter, a body). */
export function fromRamlType(
  decl: unknown,
  context: RamlTypeContext,
  options: RamlTypeOptions = {},
): RamlTypeResult<TypeRef> {
  const run = newRun(context);
  return result(run, convert(decl, run, options.at ?? "#", options.defaultType ?? "string"));
}

/** One entry of a properties declaration; `requiredByDefault` is `false` for parameter sets that default to optional. */
export function fromRamlProperty(
  name: string,
  decl: unknown,
  context: RamlTypeContext,
  options: RamlTypeOptions & { readonly requiredByDefault?: boolean } = {},
): RamlTypeResult<RamlProperty> {
  const run = newRun(context);
  return result(
    run,
    property(name, decl, run, options.at ?? name, options.requiredByDefault ?? true),
  );
}

/** A `types` map: every declaration as a def keyed by `context.keyOf(name)`, each with `meta.typeName`. */
export function fromRamlTypes(
  declarations: Readonly<Record<string, unknown>>,
  context: RamlTypeContext,
): RamlTypeResult<Record<string, TypeRef>> {
  const run = newRun(context);
  const out: Record<string, TypeRef> = {};
  for (const [name, decl] of Object.entries(declarations)) {
    const key = context.keyOf(name) ?? name;
    out[key] = withMeta(convert(decl, run, `types.${name}`, "string"), { typeName: name });
  }
  return result(run, out);
}
