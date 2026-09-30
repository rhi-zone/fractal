// RAML 1.0 and 0.8 API definitions (YAML text) -> ApiDescription.
//
// Addressing: resources nest by relative URI, so this is URL-shaped and uses
// `httpAddressing` (http-address.ts): an operation's address mirrors its full
// URL path (a literal segment is static, a whole-segment `{name}` is a param
// segment) followed by the lowercased method as the operation's own key, and
// `meta.http = { method, moveTo: "..", sourceMap }` places it back at exactly
// its URL. A relative URI that mixes literal text and a template in one
// segment (`/folder_{folderId}`) is reported and its operations are skipped.
// A trailing `{ext}` / `{mediaTypeExtension}` is dropped from the address and
// reported.
//
// Input: URI parameters (`sourceMap` store `path`), `queryParameters` and the
// properties of an object `queryString` (`query`), `headers` (`header`), and
// the properties of an object request body (`body`; 0.8 `formParameters` too),
// as one named-params object. A body that is not an object becomes one input
// field `body` and is reported. `required` (default true in 1.0 for
// properties, false for 0.8 parameters other than URI parameters) is
// `meta.optional`.
//
// Output: the first 2xx response's body (a response without a body is `void`;
// a body without a type is `unknown`). Every other response is kept verbatim:
// non-2xx in `meta.raml.errorResponses`, further 2xx in
// `meta.raml.extraSuccessResponses`, each with a diagnostic.
//
// Templates: `resourceTypes` and `traits` are expanded before mapping. A
// resource's `type` chain (a resource type may itself have a `type`), the
// method's own `is`, the resource's `is`, and each resource type's method and
// `is` are merged as: the method node, then each resource type's method node
// (nearer wins), then each trait in order (method's traits, resource's traits,
// then per resource type its method's traits and its own traits), with
// scalars kept from the nearer node, maps merged key by key and lists merged
// by value. A method or a top-level structural key spelled with a trailing `?`
// in a template applies only when the target already has it. `<<name>>` and
// `<<name | !fn>>` are substituted (reserved: resourcePath, resourcePathName,
// methodName) with the functions singularize, pluralize, uppercase,
// lowercase, lowercamelcase, uppercamelcase, lowerunderscorecase,
// upperunderscorecase, lowerhyphencase, upperhyphencase. Type names inside a
// template resolve in the scope of the resource that uses it.
//
// Modularization: `!include` is resolved by the caller-supplied `resolve`
// (path -> text); a `.raml`/`.yml`/`.yaml` target is parsed and its own
// includes resolved relative to it, anything else is a string. `uses`
// libraries contribute types, resourceTypes and traits under `alias.Name`;
// their securitySchemes and annotationTypes are kept in
// `meta.raml.libraries`. A missing resolver, an unresolvable path and an
// include cycle are diagnostics and the included value is `null`. Overlays,
// extensions and non-library fragments are not API definitions and throw.
//
// Meta: method `description` (else `displayName`) is `meta.description`;
// safe/idempotent method tags follow RFC 9110 §9.2; everything else goes
// under `meta.raml` verbatim: `displayName`, `is` (as written on the method),
// `securedBy` (method, else resource, else root), `annotations`, `protocols`,
// and any other method key. Resource `description`, `displayName`, `type`,
// `is` and annotations are group meta at the resource's address. Root
// title/version/baseUri/baseUriParameters/protocols/mediaType/documentation/
// securitySchemes/securedBy/annotationTypes/annotations are group meta at the
// root.
//
// 0.8: `schemas` (a list of maps) and list-form `resourceTypes`/`traits` are
// read; named parameters (`type` in string/number/integer/date/boolean/file,
// `repeat`, multiple-type lists) map to a type, `date` being RFC 2616
// datetime; a body's `schema` names a root `schemas` entry.
//
// Spec references: RAML 1.0: "The Root of the Document", "Base URI and Base
// URI Parameters", "Default Media Types", "RAML Data Types" (via type-ir's
// from-raml.ts), "Resources and Nested Resources", "Resource Property",
// "Template URIs and URI Parameters", "Methods", "Headers", "Query Strings
// and Query Parameters", "Bodies", "Responses", "Resource Types and Traits"
// (Declaring, Applying, Resource Type and Trait Parameters, Declaring HTTP
// Methods as Optional, Algorithm of Merging Traits and Methods, Effect on
// Collections), "Security Schemes", "Annotations", "Modularization"
// (Includes, Typed Fragments, Libraries). RAML 0.8: "Named Parameters",
// "Schemas", "Resource Types and Traits" (Optional Properties), "Body".
// Method safety/idempotence: RFC 9110 §9.2.1, §9.2.2.

import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import {
  fromRamlProperty,
  fromRamlType,
  fromRamlTypes,
  type RamlTypeContext,
} from "@rhi-zone/fractal-type-ir/from-raml";
import { parseDocument } from "yaml";
import {
  addressKey,
  patchGroup,
  type ApiDescription,
  type Diagnostic,
  type Imported,
  type Operation,
  type Segment,
} from "./api-description.ts";
import { httpAddressing } from "./http-address.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
const clone = <T>(v: T): T => structuredClone(v);
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export type RamlVersion = "1.0" | "0.8";

/** Path -> file text, or `undefined` when there is no such file. Paths are relative to the root file's location, in the same coordinates as `FromRamlOptions.path`; URLs are passed through verbatim. */
export type RamlResolver = (path: string) => string | undefined | null;

export type FromRamlOptions = {
  /** Resolves `!include` targets and `uses` libraries. Without it every include is a diagnostic. */
  readonly resolve?: RamlResolver;
  /** The location of the document itself, the base for its relative includes. Default: the resolver's root. */
  readonly path?: string;
};

export type ImportedRaml = Imported & {
  readonly ramlVersion: RamlVersion;
  readonly info: { readonly title?: string; readonly version?: string };
  readonly baseUri?: string;
};

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
type Method = (typeof METHODS)[number];
const isMethod = (k: string): k is Method => (METHODS as readonly string[]).includes(k);

// RFC 9110 §9.2.1: GET, HEAD and OPTIONS are safe.
const SAFE: ReadonlySet<Method> = new Set(["get", "head", "options"]);
// RFC 9110 §9.2.2: PUT, DELETE and the safe methods are idempotent.
const IDEMPOTENT: ReadonlySet<Method> = new Set(["put", "delete", ...SAFE]);

// ============================================================================
// Inflection and case functions (RAML 1.0 "Resource Type and Trait Parameters")
// ============================================================================

const UNCOUNTABLE: ReadonlySet<string> = new Set([
  "equipment",
  "information",
  "rice",
  "money",
  "species",
  "series",
  "fish",
  "sheep",
  "jeans",
  "police",
  "news",
  "data",
  "metadata",
  "feedback",
  "software",
  "hardware",
  "traffic",
  "media",
  "advice",
  "knowledge",
  "furniture",
]);

const IRREGULAR: readonly (readonly [string, string])[] = [
  ["person", "people"],
  ["human", "humans"],
  ["woman", "women"],
  ["man", "men"],
  ["child", "children"],
  ["foot", "feet"],
  ["tooth", "teeth"],
  ["goose", "geese"],
  ["mouse", "mice"],
  ["ox", "oxen"],
  ["leaf", "leaves"],
  ["life", "lives"],
  ["knife", "knives"],
  ["wife", "wives"],
  ["half", "halves"],
  ["wolf", "wolves"],
  ["shelf", "shelves"],
  ["thief", "thieves"],
  ["cactus", "cacti"],
  ["move", "moves"],
  ["sex", "sexes"],
  ["zombie", "zombies"],
];

const PLURAL_RULES: readonly (readonly [RegExp, string])[] = [
  [/(quiz)$/, "$1zes"],
  [/^(ox)$/, "$1en"],
  [/([ml])ouse$/, "$1ice"],
  [/(matr|vert|ind)(?:ix|ex)$/, "$1ices"],
  [/(x|ch|ss|sh)$/, "$1es"],
  [/([^aeiouy]|qu)y$/, "$1ies"],
  [/(hive)$/, "$1s"],
  [/(?:([^f])fe|([lr])f)$/, "$1$2ves"],
  [/sis$/, "ses"],
  [/([ti])a$/, "$1a"],
  [/([ti])um$/, "$1a"],
  [/(buffal|tomat|potat|her)o$/, "$1oes"],
  [/(bu)s$/, "$1ses"],
  [/(alias|status)$/, "$1es"],
  [/(octop|vir)us$/, "$1i"],
  [/(ax|test)is$/, "$1es"],
  [/s$/, "s"],
  [/$/, "s"],
];

const SINGULAR_RULES: readonly (readonly [RegExp, string])[] = [
  [/(database)s$/, "$1"],
  [/(quiz)zes$/, "$1"],
  [/(matr)ices$/, "$1ix"],
  [/(vert|ind)ices$/, "$1ex"],
  [/^(ox)en/, "$1"],
  [/(alias|status)(es)?$/, "$1"],
  [/(octop|vir)(us|i)$/, "$1us"],
  [/^(a)x[ie]s$/, "$1xis"],
  [/(cris|test)(is|es)$/, "$1is"],
  [/(shoe)s$/, "$1"],
  [/(o)es$/, "$1"],
  [/(bus)(es)?$/, "$1"],
  [/([ml])ice$/, "$1ouse"],
  [/(x|ch|ss|sh)es$/, "$1"],
  [/(m)ovies$/, "$1ovie"],
  [/(s)eries$/, "$1eries"],
  [/([^aeiouy]|qu)ies$/, "$1y"],
  [/([lr])ves$/, "$1f"],
  [/(tive)s$/, "$1"],
  [/(hive)s$/, "$1"],
  [/([^f])ves$/, "$1fe"],
  [/(^analy)(sis|ses)$/, "$1sis"],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/, "$1sis"],
  [/([ti])a$/, "$1um"],
  [/(n)ews$/, "$1ews"],
  [/(ss)$/, "$1"],
  [/s$/, ""],
];

/** Applies `fn` to the last word of `word` (camelCase, snake_case, kebab-case boundaries), keeping the prefix and the first letter's case. */
function onLastWord(word: string, fn: (lower: string) => string): string {
  if (/^[A-Z0-9_-]+$/.test(word) && /[A-Z]/.test(word)) return fn(word.toLowerCase()).toUpperCase();
  const m = /^(.*?)([A-Z]?[a-z]+)$/.exec(word);
  if (m === null) return word;
  const tail = m[2]!;
  const out = fn(tail.toLowerCase());
  const cased =
    out !== "" && tail[0] === tail[0]!.toUpperCase() ? out[0]!.toUpperCase() + out.slice(1) : out;
  return m[1]! + cased;
}

export function pluralize(word: string): string {
  return onLastWord(word, (w) => {
    if (UNCOUNTABLE.has(w)) return w;
    for (const [singular, plural] of IRREGULAR) {
      if (w === singular || w === plural) return plural;
    }
    for (const [re, to] of PLURAL_RULES) if (re.test(w)) return w.replace(re, to);
    return w;
  });
}

export function singularize(word: string): string {
  return onLastWord(word, (w) => {
    if (UNCOUNTABLE.has(w)) return w;
    for (const [singular, plural] of IRREGULAR) {
      if (w === singular || w === plural) return singular;
    }
    for (const [re, to] of SINGULAR_RULES) if (re.test(w)) return w.replace(re, to);
    return w;
  });
}

const words = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0);
const capitalize = (w: string): string => w[0]!.toUpperCase() + w.slice(1).toLowerCase();

const FUNCTIONS: Readonly<Record<string, (s: string) => string>> = {
  singularize,
  pluralize,
  uppercase: (s) => s.toUpperCase(),
  lowercase: (s) => s.toLowerCase(),
  lowercamelcase: (s) =>
    words(s)
      .map((w, i) => (i === 0 ? w.toLowerCase() : capitalize(w)))
      .join(""),
  uppercamelcase: (s) => words(s).map(capitalize).join(""),
  lowerunderscorecase: (s) => words(s).join("_").toLowerCase(),
  upperunderscorecase: (s) => words(s).join("_").toUpperCase(),
  lowerhyphencase: (s) => words(s).join("-").toLowerCase(),
  upperhyphencase: (s) => words(s).join("-").toUpperCase(),
};

// ============================================================================
// Parameter substitution
// ============================================================================

const PLACEHOLDER = /<<\s*([^<>|]+?)\s*((?:\|\s*![A-Za-z]+\s*)*)>>/g;
type Params = Readonly<Record<string, unknown>>;

type Substitution = {
  readonly params: Params;
  /** Names that may stay unresolved (their value arrives in a later pass). */
  readonly deferred: ReadonlySet<string>;
  readonly missing: Set<string>;
  readonly unknownFunctions: Set<string>;
};

function substituteString(s: string, sub: Substitution): unknown {
  const whole = /^<<\s*([^<>|]+?)\s*>>$/.exec(s);
  if (whole !== null) {
    const v = sub.params[whole[1]!];
    if (v !== undefined && typeof v !== "string") return v;
  }
  return s.replace(PLACEHOLDER, (all, rawName: string, fns: string) => {
    const name = rawName.trim();
    const v = sub.params[name];
    if (v === undefined) {
      if (!sub.deferred.has(name)) sub.missing.add(name);
      return all;
    }
    let out = typeof v === "string" ? v : JSON.stringify(v);
    for (const [, fn] of fns.matchAll(/\|\s*!([A-Za-z]+)/g)) {
      const f = FUNCTIONS[fn!];
      if (f === undefined) sub.unknownFunctions.add(fn!);
      else out = f(out);
    }
    return out;
  });
}

function substitute(v: unknown, sub: Substitution): unknown {
  if (typeof v === "string") return v.includes("<<") ? substituteString(v, sub) : v;
  if (Array.isArray(v)) return v.map((x) => substitute(x, sub));
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const key = k.includes("<<") ? String(substituteString(k, sub)) : k;
      out[key] = substitute(x, sub);
    }
    return out;
  }
  return v;
}

// ============================================================================
// Loading: YAML with `!include`
// ============================================================================

class IncludeRef {
  constructor(readonly target: string) {}
}

const isUrl = (p: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(p);

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(seg);
  }
  return out.join("/");
}

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** `target` as written in a file at `base`: absolute paths are relative to the root file's directory, relative ones to `base`'s. */
function resolvePath(base: string, target: string, rootDir: string): string {
  if (isUrl(target)) return target;
  if (target.startsWith("/"))
    return normalizePath(rootDir === "" ? target : `${rootDir}/${target}`);
  if (isUrl(base)) return new URL(target, base).toString();
  const dir = dirname(base);
  return normalizePath(dir === "" ? target : `${dir}/${target}`);
}

const YAML_FILE = /\.(raml|ya?ml)$/i;

type Loader = {
  /** Parses `text` (located at `path`) and resolves its includes. */
  readonly parse: (text: string, path: string) => unknown;
  /** The parsed file at `target` as written in `from`, or `undefined` (reported). */
  readonly load: (target: string, from: string) => { path: string; value: unknown } | undefined;
};

function createLoader(options: FromRamlOptions, diagnostics: Diagnostic[]): Loader {
  const rootDir = dirname(options.path ?? "");
  const stack: string[] = [];
  const cache = new Map<string, string | undefined>();

  const read = (path: string, at: string): string | undefined => {
    if (cache.has(path)) return cache.get(path);
    let text: string | undefined;
    if (options.resolve === undefined) {
      diagnostics.push({ at, message: "no resolver was supplied; the file is not loaded" });
    } else {
      try {
        text = options.resolve(path) ?? undefined;
      } catch (e) {
        diagnostics.push({ at, message: `resolver failed: ${(e as Error).message}` });
        cache.set(path, undefined);
        return undefined;
      }
      if (text === undefined) diagnostics.push({ at, message: "the resolver has no such file" });
    }
    cache.set(path, text);
    return text;
  };

  const tag = { tag: "!include", resolve: (s: string) => new IncludeRef(s.trim()) };

  const expand = (v: unknown, base: string): unknown => {
    if (v instanceof IncludeRef) return include(v.target, base);
    if (Array.isArray(v)) return v.map((x) => expand(x, base));
    if (isObj(v))
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x, base)]));
    return v;
  };

  const parse = (text: string, path: string): unknown => {
    const doc = parseDocument(text, { customTags: [tag as never] });
    for (const e of doc.errors)
      diagnostics.push({ at: path === "" ? "#" : path, message: `YAML: ${e.message}` });
    let value: unknown;
    try {
      value = doc.toJS();
    } catch {
      return null;
    }
    return expand(value, path);
  };

  const fragmentOf = (text: string, fragment: string, at: string): string => {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      diagnostics.push({ at, message: "fragment ignored: the file is not JSON" });
      return text;
    }
    let cur: unknown = doc;
    for (const raw of fragment.replace(/^\//, "").split("/")) {
      if (raw === "") continue;
      const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
      cur = isObj(cur) || Array.isArray(cur) ? (cur as Obj)[key] : undefined;
    }
    if (!isObj(cur)) {
      diagnostics.push({ at, message: "fragment does not point at a schema object" });
      return text;
    }
    const inherited = isObj(doc) ? { definitions: doc.definitions, $defs: doc.$defs } : {};
    return JSON.stringify({ ...inherited, ...cur });
  };

  const load = (target: string, from: string): { path: string; value: unknown } | undefined => {
    const [file, ...rest] = target.split("#");
    const fragment = rest.join("#");
    const path = resolvePath(from, file!, rootDir);
    const at = `!include ${target}`;
    if (stack.includes(path)) {
      diagnostics.push({ at, message: "include cycle" });
      return undefined;
    }
    const text = read(path, at);
    if (text === undefined) return undefined;
    if (YAML_FILE.test(file!)) {
      stack.push(path);
      try {
        return { path, value: parse(text, path) };
      } finally {
        stack.pop();
      }
    }
    if (fragment !== "") {
      const jsonPointer = fragment.startsWith("/");
      if (jsonPointer) return { path, value: fragmentOf(text, fragment, at) };
      diagnostics.push({
        at,
        message: "fragment ignored: only JSON pointers into JSON files are read",
      });
    }
    return { path, value: text };
  };

  const include = (target: string, base: string): unknown => load(target, base)?.value ?? null;

  return { parse, load };
}

// ============================================================================
// Scopes and registries
// ============================================================================

type Scope = {
  /** Def-key prefix of everything this file declares: `""` for the root document, `alias` for a library. */
  readonly prefix: string;
  readonly path: string;
  readonly uses: Map<string, Scope>;
};

type Entry<T> = { readonly decl: T; readonly scope: Scope };
type Registry<T> = Map<string, Entry<T>>;

const join = (prefix: string, name: string): string => (prefix === "" ? name : `${prefix}.${name}`);

function keyIn<T>(registry: Registry<T>, scope: Scope, name: string): string | undefined {
  const direct = join(scope.prefix, name);
  if (registry.has(direct)) return direct;
  const dot = name.indexOf(".");
  if (dot < 0) return undefined;
  const lib = scope.uses.get(name.slice(0, dot));
  if (lib === undefined) return undefined;
  const key = join(lib.prefix, name.slice(dot + 1));
  return registry.has(key) ? key : undefined;
}

/** A map, or a 0.8-style list of maps merged into one. */
function namedMap(v: unknown): Obj {
  if (isObj(v)) return v;
  if (Array.isArray(v)) return Object.assign({}, ...v.filter(isObj));
  return {};
}

// ============================================================================
// Templates
// ============================================================================

const TEMPLATE_ONLY = ["usage", "is", "type"] as const;
const OPTIONAL_KEYS: ReadonlySet<string> = new Set([
  ...METHODS,
  "body",
  "headers",
  "queryParameters",
  "queryString",
  "responses",
  "uriParameters",
  "baseUriParameters",
]);

/** `target` with `template` merged under it: the target's scalars win, maps merge key by key, lists merge by value (target's items first). */
function merge(target: unknown, template: unknown): unknown {
  if (target === undefined || target === null) return clone(template);
  if (template === undefined || template === null) return target;
  if (isObj(target) && isObj(template)) {
    const out: Obj = { ...target };
    for (const [k, v] of Object.entries(template)) out[k] = k in out ? merge(out[k], v) : clone(v);
    return out;
  }
  if (Array.isArray(target) && Array.isArray(template)) {
    const out = [...target];
    for (const item of template) if (!out.some((x) => deepEqual(x, item))) out.push(clone(item));
    return out;
  }
  return target;
}

/** `merge` for a template node's top level, where `key?` applies only if `key` is already in the target. */
function mergeTemplate(target: Obj, template: Obj): Obj {
  const out: Obj = { ...target };
  for (const [k, v] of Object.entries(template)) {
    const optional = k.endsWith("?") && OPTIONAL_KEYS.has(k.slice(0, -1));
    const key = optional ? k.slice(0, -1) : k;
    if (optional && !(key in out)) continue;
    out[key] = key in out ? merge(out[key], v) : clone(v);
  }
  return out;
}

const without = (o: Obj, keys: readonly string[]): Obj =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

function templateRef(v: unknown): { name: string; params: Obj } | undefined {
  if (typeof v === "string") return { name: v.trim(), params: {} };
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const p = v[keys[0]!];
      return { name: keys[0]!, params: isObj(p) ? p : {} };
    }
  }
  return undefined;
}

// ============================================================================
// Type helpers
// ============================================================================

const isJsonMedia = (m: string): boolean => m === "application/json" || /\+json$|\/json$/.test(m);
const isMediaType = (k: string): boolean => /^[\w!#$&^.+-]+\/[\w!#$&^.+*-]+/.test(k);

/** The fields of an object-shaped type (through refs and intersections), or `undefined` when it is not object-shaped. */
function objectFields(
  ref: TypeRef,
  defs: Readonly<Record<string, TypeRef>>,
  seen: ReadonlySet<string> = new Set(),
): Record<string, TypeRef> | undefined {
  const s = ref.shape;
  if (s.kind === "object") return { ...s.fields };
  if (s.kind === "ref") {
    const target = defs[s.target];
    if (target === undefined || seen.has(s.target)) return undefined;
    return objectFields(target, defs, new Set(seen).add(s.target));
  }
  if (s.kind === "intersection") {
    const out: Record<string, TypeRef> = {};
    for (const m of s.members) {
      const f = objectFields(m, defs, seen);
      if (f === undefined) return undefined;
      Object.assign(out, f);
    }
    return out;
  }
  return undefined;
}

/** `ref` with every `ref` target `f` replaces substituted. */
function mapRefs(ref: TypeRef, f: (target: string) => TypeRef | undefined): TypeRef {
  const walk = (r: TypeRef): TypeRef => {
    const s = r.shape;
    let shape = s;
    let meta = r.meta;
    switch (s.kind) {
      case "ref": {
        const rep = f(s.target);
        return rep === undefined ? r : withMeta(rep, r.meta);
      }
      case "object":
        shape = {
          kind: "object",
          fields: Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, walk(v)])),
        };
        break;
      case "array":
        shape = { kind: "array", element: walk(s.element) };
        break;
      case "stream":
        shape = { kind: "stream", element: walk(s.element) };
        break;
      case "tuple":
        shape = { kind: "tuple", elements: s.elements.map(walk) };
        break;
      case "map":
        shape = { kind: "map", key: walk(s.key), value: walk(s.value) };
        break;
      case "union":
        shape = { kind: "union", variants: s.variants.map(walk) };
        break;
      case "intersection":
        shape = { kind: "intersection", members: s.members.map(walk) };
        break;
      default:
        break;
    }
    const extra = meta.additionalPropertyType;
    if (isObj(extra) && "shape" in extra)
      meta = { ...meta, additionalPropertyType: walk(extra as TypeRef) };
    const raml = meta.raml;
    if (isObj(raml) && isObj(raml.patternProperties)) {
      meta = {
        ...meta,
        raml: {
          ...raml,
          patternProperties: Object.fromEntries(
            Object.entries(raml.patternProperties).map(([k, v]) => [k, walk(v as TypeRef)]),
          ),
        },
      };
    }
    return { shape, meta };
  };
  return walk(ref);
}

function collectRefs(ref: TypeRef, into: Set<string>): void {
  mapRefs(ref, (target) => {
    into.add(target);
    return undefined;
  });
}

// ============================================================================
// Import
// ============================================================================

const stripExt = (path: string): string => path.replace(/\{(?:ext|mediaTypeExtension)\}/g, "");

/** The rightmost path fragment that contains no URI parameter. */
function resourcePathName(path: string): string {
  const parts = stripExt(path)
    .split("/")
    .filter((p) => p !== "" && !p.includes("{"));
  return parts[parts.length - 1] ?? "";
}

type Layer = {
  readonly node: Obj;
  readonly scope: Scope;
  readonly key: string;
  readonly name: string;
  /** Parameters without a value, by the top-level key of `node` that mentions them. Reported only when that key is applied. */
  readonly pending: ReadonlyMap<string, ReadonlySet<string>>;
};

export function fromRamlDocument(text: string, options: FromRamlOptions = {}): ImportedRaml {
  const header = /^﻿?#%RAML[ \t]+(\d+\.\d+)(?:[ \t]+(\S+))?/.exec(text);
  if (header === null) throw new Error("fromRamlDocument: the document has no #%RAML header");
  const ramlVersion = header[1] as RamlVersion;
  if (ramlVersion !== "1.0" && ramlVersion !== "0.8") {
    throw new Error(`fromRamlDocument: unsupported RAML version ${header[1]}`);
  }
  if (header[2] !== undefined) {
    throw new Error(`fromRamlDocument: a ${header[2]} fragment is not an API definition`);
  }
  const diagnostics: Diagnostic[] = [];
  const loader = createLoader(options, diagnostics);
  const rootPath = options.path ?? "";
  const doc = loader.parse(text, rootPath);
  if (!isObj(doc)) throw new Error("fromRamlDocument: the document root is not a map");
  if (doc.extends !== undefined) {
    throw new Error("fromRamlDocument: an overlay or extension is not an API definition");
  }

  // ---- scopes and declarations -------------------------------------------
  const rootScope: Scope = { prefix: "", path: rootPath, uses: new Map() };
  const typeDecls: Registry<unknown> = new Map();
  const resourceTypes: Registry<unknown> = new Map();
  const traits: Registry<unknown> = new Map();
  const libraries = new Map<string, Scope>();
  const prefixes = new Set<string>();
  const libraryMeta: Obj = {};

  const register = (node: Obj, scope: Scope, at: string): void => {
    if (node.types !== undefined && node.schemas !== undefined) {
      diagnostics.push({ at, message: '"types" and "schemas" are both declared' });
    }
    for (const source of [node.types, node.schemas]) {
      for (const [name, decl] of Object.entries(namedMap(source))) {
        typeDecls.set(join(scope.prefix, name), { decl, scope });
      }
    }
    for (const [name, decl] of Object.entries(namedMap(node.resourceTypes))) {
      resourceTypes.set(join(scope.prefix, name), { decl, scope });
    }
    for (const [name, decl] of Object.entries(namedMap(node.traits))) {
      traits.set(join(scope.prefix, name), { decl, scope });
    }
    for (const [alias, target] of Object.entries(namedMap(node.uses))) {
      const lib = typeof target === "string" ? loadLibrary(alias, target, scope) : undefined;
      if (lib === undefined) {
        diagnostics.push({ at: `${at} uses.${alias}`, message: "library could not be loaded" });
      } else scope.uses.set(alias, lib);
    }
  };

  const loadLibrary = (alias: string, target: string, from: Scope): Scope | undefined => {
    const path = resolvePath(from.path, target, dirname(rootPath));
    const known = libraries.get(path);
    if (known !== undefined) return known;
    const loaded = loader.load(target, from.path);
    if (loaded === undefined) return undefined;
    if (!isObj(loaded.value)) {
      diagnostics.push({ at: target, message: "library is not a map" });
      return undefined;
    }
    let prefix = alias;
    for (let n = 2; prefixes.has(prefix); n++) prefix = `${alias}~${n}`;
    prefixes.add(prefix);
    const scope: Scope = { prefix, path: loaded.path, uses: new Map() };
    libraries.set(path, scope);
    const rest: Obj = {};
    if (loaded.value.securitySchemes !== undefined)
      rest.securitySchemes = loaded.value.securitySchemes;
    if (loaded.value.annotationTypes !== undefined)
      rest.annotationTypes = loaded.value.annotationTypes;
    if (Object.keys(rest).length > 0) libraryMeta[prefix] = plain(rest);
    register(loaded.value, scope, target);
    return scope;
  };

  register(doc, rootScope, "#");

  // ---- types ----------------------------------------------------------------
  const defs: Record<string, TypeRef> = {};
  const addDef = (name: string, ref: TypeRef, at: string): void => {
    const existing = defs[name];
    if (existing !== undefined && !deepEqual(existing, ref)) {
      diagnostics.push({
        at,
        message: `def "${name}" is defined differently elsewhere; the first is kept`,
      });
      return;
    }
    defs[name] = ref;
  };

  const contextFor = (scope: Scope): RamlTypeContext => ({
    keyOf: (name) => keyIn(typeDecls, scope, name),
    lookup: (key) => {
      const e = typeDecls.get(key);
      return e === undefined
        ? undefined
        : { decl: e.decl, scope: { keyOf: (name) => keyIn(typeDecls, e.scope, name) } };
    },
  });

  const allScopes = [rootScope, ...libraries.values()];
  for (const scope of allScopes) {
    const local: Record<string, unknown> = {};
    for (const [key, e] of typeDecls) {
      if (e.scope === scope)
        local[key.slice(scope.prefix === "" ? 0 : scope.prefix.length + 1)] = e.decl;
    }
    const r = fromRamlTypes(local, contextFor(scope));
    for (const [key, ref] of Object.entries(r.value)) addDef(key, ref, `types.${key}`);
    for (const [key, ref] of Object.entries(r.defs)) addDef(key, ref, `types.${key}`);
    diagnostics.push(...r.diagnostics);
  }

  const ctx = contextFor(rootScope);
  const takeType = (decl: unknown, at: string, defaultType: "string" | "any"): TypeRef => {
    const r = fromRamlType(decl, ctx, { at, defaultType });
    for (const [key, ref] of Object.entries(r.defs)) addDef(key, ref, at);
    diagnostics.push(...r.diagnostics);
    return r.value;
  };

  // A 0.8 named parameter (one type, or a list of alternatives) as a type.
  const param08 = (
    decl: unknown,
    at: string,
    uri: boolean,
  ): { type: TypeRef; optional: boolean } => {
    const alts = Array.isArray(decl) ? decl : [decl];
    const convertOne = (a: unknown): TypeRef => {
      const d: Obj = isObj(a) ? { ...a } : {};
      delete d.required;
      delete d.repeat;
      if (d.type === "date") {
        d.type = "datetime";
        d.format = "rfc2616";
      }
      const type = takeType(d, at, "string");
      return isObj(a) && a.repeat === true ? t(types.array(type)) : type;
    };
    const converted = alts.map(convertOne);
    const first = alts[0];
    const declared =
      isObj(first) && typeof first.required === "boolean" ? first.required : undefined;
    const required = declared ?? uri;
    return {
      type: converted.length === 1 ? converted[0]! : t(types.union(converted)),
      optional: !required,
    };
  };

  const paramField = (
    name: string,
    decl: unknown,
    at: string,
    store: "path" | "query" | "header",
  ): { name: string; type: TypeRef; optional: boolean } => {
    if (ramlVersion === "0.8") return { name, ...param08(decl, at, store === "path") };
    const r = fromRamlProperty(name, decl, ctx, { at, requiredByDefault: true });
    for (const [key, ref] of Object.entries(r.defs)) addDef(key, ref, at);
    diagnostics.push(...r.diagnostics);
    return r.value;
  };

  // ---- root meta -------------------------------------------------------------
  const rootMedia: string[] = (
    Array.isArray(doc.mediaType) ? doc.mediaType : [doc.mediaType]
  ).filter((m): m is string => typeof m === "string");
  const rootSecuredBy = doc.securedBy;

  const rootRaml: Obj = {};
  for (const k of [
    "title",
    "version",
    "baseUri",
    "baseUriParameters",
    "protocols",
    "mediaType",
    "documentation",
    "securitySchemes",
    "securedBy",
    "annotationTypes",
  ]) {
    if (doc[k] !== undefined) rootRaml[k] = plain(doc[k]);
  }
  const rootAnnotations = annotationsOf(doc);
  if (rootAnnotations !== undefined) rootRaml.annotations = rootAnnotations;
  if (Object.keys(libraryMeta).length > 0) rootRaml.libraries = libraryMeta;
  const rootMeta: Obj = {};
  const rootDescription = asString(doc.description);
  if (rootDescription !== undefined) rootMeta.description = rootDescription;
  if (Object.keys(rootRaml).length > 0) rootMeta.raml = rootRaml;

  // ---- resources -------------------------------------------------------------
  const allPaths: string[] = [];
  const collectPaths = (node: Obj, prefix: string): void => {
    for (const [key, child] of Object.entries(node)) {
      if (!key.startsWith("/")) continue;
      allPaths.push(stripExt(prefix + key));
      if (isObj(child)) collectPaths(child, prefix + key);
    }
  };
  collectPaths(doc, "");
  const addressing = httpAddressing(allPaths);

  const operations: Operation[] = [];
  const groupPatches: { address: readonly Segment[]; meta: Obj }[] = [];
  const usedAddresses = new Set<string>();
  if (Object.keys(rootMeta).length > 0) groupPatches.push({ address: [], meta: rootMeta });

  const instantiate = (
    registry: Registry<unknown>,
    kind: string,
    ref: { name: string; params: Obj },
    scope: Scope,
    reserved: Params,
    deferred: ReadonlySet<string>,
    at: string,
  ): Layer | undefined => {
    const key = keyIn(registry, scope, ref.name);
    if (key === undefined) {
      diagnostics.push({ at, message: `${kind} "${ref.name}" is not declared` });
      return undefined;
    }
    const entry = registry.get(key)!;
    const params = { ...ref.params, ...reserved };
    const node: Obj = {};
    const pending = new Map<string, ReadonlySet<string>>();
    const unknownFunctions = new Set<string>();
    for (const [k, v] of Object.entries(isObj(entry.decl) ? entry.decl : {})) {
      const sub: Substitution = { params, deferred, missing: new Set(), unknownFunctions };
      const nk = k.includes("<<") ? String(substituteString(k, sub)) : k;
      node[nk] = substitute(v, sub);
      if (sub.missing.size > 0) pending.set(nk, sub.missing);
    }
    for (const fn of unknownFunctions) {
      diagnostics.push({ at, message: `${kind} "${ref.name}" uses unknown function "!${fn}"` });
    }
    const layer: Layer = { node, scope: entry.scope, key, name: ref.name, pending };
    if (kind === "trait") for (const k of pending.keys()) reportPending(layer, kind, k, at);
    return layer;
  };

  const reportPending = (layer: Layer, kind: string, key: string, at: string): void => {
    for (const name of layer.pending.get(key) ?? []) {
      diagnostics.push({
        at,
        message: `${kind} "${layer.name}" has no value for parameter "${name}"`,
      });
    }
  };

  const applyTraits = (
    target: Obj,
    refs: unknown,
    scope: Scope,
    reserved: Params,
    at: string,
    stack: readonly string[] = [],
  ): Obj => {
    if (refs === undefined || refs === null) return target;
    let out = target;
    for (const raw of Array.isArray(refs) ? refs : [refs]) {
      const ref = templateRef(raw);
      if (ref === undefined) {
        diagnostics.push({ at, message: "trait reference is not a name or a single-name map" });
        continue;
      }
      const inst = instantiate(traits, "trait", ref, scope, reserved, new Set(), at);
      if (inst === undefined) continue;
      if (stack.includes(inst.key)) {
        diagnostics.push({ at, message: `trait "${ref.name}" applies itself` });
        continue;
      }
      const filled = applyTraits(inst.node, inst.node.is, inst.scope, reserved, at, [
        ...stack,
        inst.key,
      ]);
      out = mergeTemplate(out, without(filled, TEMPLATE_ONLY));
    }
    return out;
  };

  const typeChain = (refValue: unknown, reserved: Params, at: string): Layer[] => {
    const chain: Layer[] = [];
    const seen = new Set<string>();
    let ref = refValue === undefined ? undefined : templateRef(refValue);
    let scope = rootScope;
    if (refValue !== undefined && ref === undefined) {
      diagnostics.push({
        at,
        message: "resource type reference is not a name or a single-name map",
      });
    }
    while (ref !== undefined) {
      const inst = instantiate(
        resourceTypes,
        "resource type",
        ref,
        scope,
        reserved,
        new Set(["methodName"]),
        at,
      );
      if (inst === undefined) break;
      if (seen.has(inst.key)) {
        diagnostics.push({ at, message: `resource type "${ref.name}" inherits itself` });
        break;
      }
      seen.add(inst.key);
      reportPending(inst, "resource type", "type", at);
      chain.push(inst);
      ref = inst.node.type === undefined ? undefined : templateRef(inst.node.type);
      scope = inst.scope;
    }
    return chain;
  };

  const effectiveMethod = (
    name: string,
    res: Obj,
    chain: readonly Layer[],
    reserved: Params,
    at: string,
  ): Obj => {
    const base = isObj(res[name]) ? res[name] : {};
    let merged: Obj = base;
    const traitLayers: { refs: unknown; scope: Scope }[] = [
      { refs: base.is, scope: rootScope },
      { refs: res.is, scope: rootScope },
    ];
    for (const layer of chain) {
      for (const key of [name, `${name}?`]) {
        if (!(key in layer.node)) continue;
        reportPending(layer, "resource type", key, at);
        const raw = layer.node[key];
        const sub: Substitution = {
          params: { methodName: name },
          deferred: new Set(),
          missing: new Set(),
          unknownFunctions: new Set(),
        };
        const rm = substitute(isObj(raw) ? raw : {}, sub) as Obj;
        merged = merge(merged, without(rm, ["is"])) as Obj;
        traitLayers.push({ refs: rm.is, scope: layer.scope });
      }
      reportPending(layer, "resource type", "is", at);
      traitLayers.push({ refs: layer.node.is, scope: layer.scope });
    }
    merged = without(merged, ["is", "usage"]);
    const withName = { ...reserved, methodName: name };
    for (const l of traitLayers) merged = applyTraits(merged, l.refs, l.scope, withName, at);
    return merged;
  };

  const methodNames = (res: Obj, chain: readonly Layer[]): Method[] => {
    const names: Method[] = Object.keys(res).filter(isMethod);
    for (const layer of chain) {
      for (const key of Object.keys(layer.node)) {
        const optional = key.endsWith("?");
        const bare = optional ? key.slice(0, -1) : key;
        if (!isMethod(bare) || names.includes(bare)) continue;
        if (!optional) names.push(bare);
        else if (Object.keys(res).includes(bare)) names.push(bare);
      }
    }
    return names;
  };

  const visitResource = (res: Obj, fullPath: string, parentUri: Obj): Obj => {
    const at = fullPath;
    const cleanPath = stripExt(fullPath);
    if (cleanPath !== fullPath) {
      diagnostics.push({ at, message: "the media type extension parameter is not represented" });
    }
    const reserved: Params = {
      resourcePath: cleanPath,
      resourcePathName: resourcePathName(fullPath),
    };
    const chain = typeChain(res.type, reserved, at);

    let eff: Obj = {};
    for (const [k, v] of Object.entries(res)) {
      if (k.startsWith("/") || isMethod(k) || k === "is" || k === "type") continue;
      eff[k] = v;
    }
    for (const layer of chain) {
      const rest: Obj = {};
      for (const [k, v] of Object.entries(layer.node)) {
        const bare = k.endsWith("?") ? k.slice(0, -1) : k;
        if (k.startsWith("/") || isMethod(bare) || (TEMPLATE_ONLY as readonly string[]).includes(k))
          continue;
        rest[k] = v;
        reportPending(layer, "resource type", k, at);
      }
      eff = mergeTemplate(eff, rest);
    }

    const uriParams: Obj = { ...parentUri, ...(isObj(eff.uriParameters) ? eff.uriParameters : {}) };

    const addressed = addressing.addressPath(cleanPath);
    const groupMeta: Obj = {};
    const desc = asString(eff.description);
    if (desc !== undefined) groupMeta.description = desc;
    const groupRaml: Obj = {};
    if (eff.displayName !== undefined) groupRaml.displayName = plain(eff.displayName);
    const groupAnnotations = annotationsOf(eff);
    if (groupAnnotations !== undefined) groupRaml.annotations = groupAnnotations;
    if (res.type !== undefined) groupRaml.type = plain(res.type);
    if (res.is !== undefined) groupRaml.is = plain(res.is);
    if (Object.keys(groupRaml).length > 0) groupMeta.raml = groupRaml;

    const names = methodNames(res, chain);
    if (!addressed.ok) {
      if (names.length > 0) diagnostics.push({ at, message: `${addressed.reason}; skipped` });
      return uriParams;
    }
    for (const { own, bound } of addressed.rebound) {
      diagnostics.push({
        at,
        message: `path parameter "${own}" shares its position with "${bound}" in another path; bound to "${bound}"`,
      });
    }
    if (Object.keys(groupMeta).length > 0)
      groupPatches.push({ address: addressed.segments, meta: groupMeta });

    for (const [declared] of Object.entries(isObj(eff.uriParameters) ? eff.uriParameters : {})) {
      if (
        declared !== "ext" &&
        declared !== "mediaTypeExtension" &&
        !addressed.pathParamKeys.has(declared)
      ) {
        diagnostics.push({
          at,
          message: `uriParameters declares "${declared}" but the path does not name it`,
        });
      }
    }

    for (const method of names) {
      const mAt = `${fullPath} ${method}`;
      const m = effectiveMethod(method, res, chain, reserved, mAt);
      const op = buildOperation({
        method,
        m,
        declared: isObj(res[method]) ? res[method] : {},
        eff,
        uriParams,
        path: cleanPath,
        segments: addressed.segments,
        pathParamKeys: addressed.pathParamKeys,
        at: mAt,
      });
      if (op === undefined) continue;
      const key = addressKey(op.address);
      if (usedAddresses.has(key)) {
        diagnostics.push({
          at: mAt,
          message: "another resource already has an operation at this address; skipped",
        });
        continue;
      }
      usedAddresses.add(key);
      operations.push(op);
    }
    return uriParams;
  };

  type OpInput = {
    method: Method;
    m: Obj;
    declared: Obj;
    eff: Obj;
    uriParams: Obj;
    path: string;
    segments: readonly Segment[];
    pathParamKeys: ReadonlyMap<string, string>;
    at: string;
  };

  const buildOperation = (o: OpInput): Operation | undefined => {
    const { method, m, at } = o;
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
    const addParams = (source: unknown, store: "query" | "header"): void => {
      for (const [key, decl] of Object.entries(isObj(source) ? source : {})) {
        const f = paramField(key, decl, `${at} ${store}.${key}`, store);
        addField(f.name, f.optional ? withMeta(f.type, { optional: true }) : f.type, store);
      }
    };

    for (const [name, bound] of o.pathParamKeys) {
      const f = paramField(name, o.uriParams[name], `${at} uriParameters.${name}`, "path");
      addField(name, f.type, "path", bound);
    }

    let queryStringVerbatim = false;
    addParams(m.queryParameters, "query");
    addParams(m.headers, "header");
    if (m.queryString !== undefined) {
      if (m.queryParameters !== undefined) {
        diagnostics.push({
          at,
          message: "queryString and queryParameters are both declared; queryString is skipped",
        });
      } else {
        const type = takeType(m.queryString, `${at} queryString`, "any");
        const qf = objectFields(type, defs);
        if (qf === undefined) {
          queryStringVerbatim = true;
          diagnostics.push({
            at,
            message: "queryString is not an object type; kept in meta.raml.queryString",
          });
        } else for (const [name, ft] of Object.entries(qf)) addField(name, ft, "query");
      }
    }

    const body = mediaEntries(m.body);
    const bodyChoice = pickMedia(body);
    if (bodyChoice !== undefined) {
      const [media, decl] = bodyChoice;
      if (media !== undefined && !isJsonMedia(media)) {
        diagnostics.push({ at, message: `request body media type "${media}" is not JSON` });
      }
      let type: TypeRef;
      if (ramlVersion === "0.8" && isObj(decl) && isObj(decl.formParameters)) {
        const formFields: Record<string, TypeRef> = {};
        for (const [key, p] of Object.entries(decl.formParameters)) {
          const f = param08(p, `${at} formParameters.${key}`, false);
          formFields[key] = f.optional ? withMeta(f.type, { optional: true }) : f.type;
        }
        type = t(types.object(formFields));
      } else type = takeType(decl, `${at} body`, "any");
      const bf = objectFields(type, defs);
      if (bf !== undefined) {
        for (const [name, ft] of Object.entries(bf)) addField(name, ft, "body");
      } else if (!(type.shape.kind === "unknown" && Object.keys(type.meta).length === 0)) {
        diagnostics.push({
          at,
          message:
            'request body is not an object type; represented as one input field "body" that the http projector\'s body decoding does not fill',
        });
        if (!("body" in fields)) fields.body = type;
      }
    }

    // Responses.
    let output: TypeRef | undefined;
    const responses = isObj(m.responses) ? m.responses : {};
    const statuses = Object.keys(responses).sort();
    const success = statuses.find((s) => /^2\d\d$/.test(s));
    const errorResponses: Obj = {};
    const extraSuccess: Obj = {};
    for (const s of statuses) {
      if (s === success) continue;
      (/^2\d\d$/.test(s) ? extraSuccess : errorResponses)[s] = plain(responses[s] ?? null);
    }
    if (success !== undefined) {
      const res = responses[success];
      const choice = isObj(res) ? pickMedia(mediaEntries(res.body)) : undefined;
      output =
        choice === undefined
          ? t(types.void)
          : takeType(choice[1], `${at} responses.${success}`, "any");
    }

    const { key, collided } = addressing.operationKey(o.path, method, `http-${method}`);
    if (collided) {
      diagnostics.push({
        at,
        message: `path segment "${method}" exists below this path; operation keyed "${key}"`,
      });
    }

    const raml: Obj = {};
    if (m.displayName !== undefined) raml.displayName = plain(m.displayName);
    if (o.declared.is !== undefined) raml.is = plain(o.declared.is);
    const securedBy = m.securedBy ?? o.eff.securedBy ?? rootSecuredBy;
    if (securedBy !== undefined) raml.securedBy = plain(securedBy);
    const annotations = annotationsOf(m);
    if (annotations !== undefined) raml.annotations = annotations;
    if (m.protocols !== undefined) raml.protocols = plain(m.protocols);
    if (queryStringVerbatim) raml.queryString = plain(m.queryString);
    if (Object.keys(errorResponses).length > 0) {
      raml.errorResponses = errorResponses;
      diagnostics.push({
        at,
        message:
          "non-2xx responses are kept verbatim in meta.raml.errorResponses; error types are not represented",
      });
    }
    if (Object.keys(extraSuccess).length > 0) {
      raml.extraSuccessResponses = extraSuccess;
      diagnostics.push({
        at,
        message:
          "success responses after the first are kept verbatim in meta.raml.extraSuccessResponses",
      });
    }
    const known = new Set([
      "displayName",
      "description",
      "queryParameters",
      "queryString",
      "headers",
      "body",
      "responses",
      "protocols",
      "securedBy",
      "is",
      "usage",
    ]);
    const other = Object.fromEntries(
      Object.entries(m).filter(([k]) => !known.has(k) && !(k.startsWith("(") && k.endsWith(")"))),
    );
    if (Object.keys(other).length > 0) raml.other = plain(other);

    const tags: Obj = {};
    if (SAFE.has(method)) tags.readOnly = true;
    if (IDEMPOTENT.has(method)) tags.idempotent = true;
    const description = asString(m.description) ?? asString(m.displayName);
    const meta: Obj = {
      ...(description !== undefined ? { description } : {}),
      tags,
      http: { method: method.toUpperCase(), moveTo: "..", sourceMap },
      ...(Object.keys(raml).length > 0 ? { raml } : {}),
    };

    return {
      address: [...o.segments, { kind: "static", name: key }],
      input: t(types.object(fields)),
      ...(output !== undefined ? { output } : {}),
      meta,
    };
  };

  const mediaEntries = (body: unknown): [string | undefined, unknown][] => {
    if (body === undefined || body === null) return [];
    if (isObj(body)) {
      const keys = Object.keys(body);
      if (keys.some(isMediaType)) return keys.filter(isMediaType).map((k) => [k, body[k]]);
    }
    return [[rootMedia[0], body]];
  };

  const pickMedia = (
    entries: [string | undefined, unknown][],
  ): [string | undefined, unknown] | undefined =>
    entries.find(([m]) => m !== undefined && isJsonMedia(m)) ?? entries[0];

  const walk = (node: Obj, parentPath: string, parentUri: Obj): void => {
    for (const [key, raw] of Object.entries(node)) {
      if (!key.startsWith("/")) continue;
      if (raw !== null && raw !== undefined && !isObj(raw)) {
        diagnostics.push({ at: parentPath + key, message: "resource is not a map; skipped" });
        continue;
      }
      const res = isObj(raw) ? raw : {};
      const full = parentPath + key;
      const uri = visitResource(res, full, parentUri);
      walk(res, full, uri);
    }
  };
  walk(doc, "", {});

  // ---- finish ----------------------------------------------------------------
  let api: ApiDescription = { operations, groups: [], defs };
  for (const g of groupPatches) api = patchGroup(api, g.address, g.meta);

  const dangling = new Set<string>();
  for (const op of api.operations) {
    collectRefs(op.input, dangling);
    if (op.output !== undefined) collectRefs(op.output, dangling);
  }
  for (const d of Object.values(api.defs)) collectRefs(d, dangling);
  for (const name of dangling) if (name in api.defs) dangling.delete(name);
  const replace = (target: string): TypeRef | undefined =>
    dangling.has(target) ? t(types.unknown, { raml: { unresolvedType: target } }) : undefined;
  for (const target of dangling) {
    diagnostics.push({ at: "#", message: `type "${target}" is referenced but not defined` });
  }
  const finalDefs: Record<string, TypeRef> = {};
  for (const [k, d] of Object.entries(api.defs)) finalDefs[k] = mapRefs(d, replace);
  // A def that is only a reference to itself, directly or through other such defs, denotes nothing.
  for (const start of Object.keys(finalDefs)) {
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined) {
      const d: TypeRef | undefined = finalDefs[cur];
      if (d === undefined || d.shape.kind !== "ref") break;
      if (seen.has(cur)) {
        diagnostics.push({ at: `types.${start}`, message: "type inherits itself" });
        finalDefs[start] = t(types.unknown, { raml: { unresolvedType: start } });
        break;
      }
      seen.add(cur);
      cur = d.shape.target;
    }
  }
  api = {
    operations: api.operations.map((op) => ({
      ...op,
      input: mapRefs(op.input, replace),
      ...(op.output !== undefined ? { output: mapRefs(op.output, replace) } : {}),
    })),
    groups: api.groups,
    defs: finalDefs,
  };

  const title = asString(doc.title);
  const version = asString(doc.version);
  const baseUri = asString(doc.baseUri);
  return {
    api,
    diagnostics,
    ramlVersion,
    info: {
      ...(title !== undefined ? { title } : {}),
      ...(version !== undefined ? { version } : {}),
    },
    ...(baseUri !== undefined ? { baseUri } : {}),
  };
}

/** The `(name): value` annotations on a node, by name. */
function annotationsOf(node: Obj): Obj | undefined {
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("(") && k.endsWith(")")) out[k.slice(1, -1)] = plain(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
