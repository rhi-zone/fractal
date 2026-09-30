// TypeSpec source -> ApiDescription, by compiling it with the real compiler
// (`@typespec/compiler`) and walking the checked program. `@typespec/http` is
// used for route, verb, parameter locations and responses.
//
// Compilation: the source is compiled from an in-memory file set. The
// compiler host reads those files from a virtual directory that sits next to
// the `node_modules` directory `@typespec/http` resolves from, so `import
// "@typespec/http"` (and any other library installed beside it) resolves like
// it would for a real project. Nothing is written to disk. Compiler
// diagnostics (errors and warnings) become importer diagnostics; the checked
// program is imported even when it has errors.
//
// Addressing: an operation's address is the path of the namespaces and
// interface that contain it (names verbatim) followed by its own name.
// Namespaces and interfaces are groups; their `@doc`/`@summary` are group
// `meta.description`, `@service` is `meta.typespec.service`. An operation name
// that collides with a group at the same position (or with another operation)
// falls back to `<name>Op`, then a numeric suffix, and is reported.
//
// Input: the operation's parameters as one named-params object, keyed by the
// parameter name. Output: with `@typespec/http` loaded, the body of the
// lowest-status 2xx response (`void` for no body; several distinct bodies
// become a union); otherwise the return type without its `@error` variants.
//
// Types: every named model, enum, union and scalar in the project becomes a
// def keyed by its name (`Ns.Name` when two share a bare name; a template
// instance is `Name_Arg`); std scalars are inlined as type-ir kinds; a named
// model with a base model is `intersection([ref(base), own fields])`. A field
// named by `@encodedName` keeps its property name as the key and the JSON name
// in `meta.jsonName`. Visibility (`@visibility`, `@withVisibility`) is not
// applied: a model is the full model.
//
// Metadata: `@doc` -> `meta.description` (`@summary` when there is no doc, else
// `meta.typespec.summary`; on a type `@summary` is `meta.title`); `#deprecated`
// -> `meta.tags.deprecated` on an operation, `meta.deprecated` on a type
// (message in `meta.deprecatedReason` / `meta.typespec.deprecated`);
// `@minLength`, `@maxLength`, `@minItems`, `@maxItems`, `@minValue`,
// `@maxValue`, `@minValueExclusive`, `@maxValueExclusive`, `@pattern`,
// `@format` -> the same-named type meta keys as the JSON Schema importers use;
// a property default -> `meta.default`. Every other decorator is listed by
// name (with plain-data arguments) under `meta.typespec.decorators`.
//
// HTTP: `meta.http` is written only when it is exact, i.e. the operation's
// address (minus its own key) is precisely the route path and every parameter
// has a binding `sourceMap` can state (`@path`, `@query`, `@header`,
// `@cookie`, an implicit body property keyed by its JSON name). Anything else
// (an address that does not mirror the route, a parameter with path style or
// explode options, `@body`, `@bodyRoot`, multipart) keeps the binding verbatim
// under `meta.typespec.http` and adds a diagnostic; `meta.http` is then
// absent. `meta.tags.readOnly`/`idempotent` follow the verb (RFC 9110 §9.2).
// Responses other than 2xx are kept under `meta.typespec.errors` with a
// diagnostic; a 2xx status other than 200 is kept as
// `meta.typespec.successStatus`. Authentication (`@useAuth`) is kept under
// `meta.typespec.auth`.
//
// Spec references: TypeSpec language: Namespaces, Models (§ "Spread", "is",
// "extends", "Model expressions"), Scalars, Enums, Unions, Interfaces,
// Operations (§ "Templates", "Operation signatures"), Decorators,
// `#deprecated` directive; `@typespec/http`: Routes (`@route`, verbs),
// Metadata (`@path`, `@query`, `@header`, `@cookie`, `@body`, `@bodyRoot`,
// `@statusCode`), Responses, Authentication (`@useAuth`); RFC 6570 §3.2
// (URI Template expansion) for path style/explode; RFC 9110 §9.2.1, §9.2.2
// (method safety and idempotence).

import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { bytes } from "@rhi-zone/fractal-type-ir/kinds/bytes";
import { date, datetime, time } from "@rhi-zone/fractal-type-ir/kinds/date-time";
import { duration } from "@rhi-zone/fractal-type-ir/kinds/duration";
import { float32, float64 } from "@rhi-zone/fractal-type-ir/kinds/float-widths";
import {
  int16,
  int32,
  int64,
  int8,
  uint16,
  uint32,
  uint64,
  uint8,
} from "@rhi-zone/fractal-type-ir/kinds/int-widths";
import { uri } from "@rhi-zone/fractal-type-ir/kinds/semantic-strings";
import {
  compile,
  createSourceFile,
  getDeprecationDetails,
  getDiscriminator,
  getDoc,
  getEncode,
  getFormat,
  getLocationContext,
  getMaxItems,
  getMaxLength,
  getMaxValue,
  getMaxValueExclusive,
  getMinItems,
  getMinLength,
  getMinValue,
  getMinValueExclusive,
  getPattern,
  getService,
  getSourceLocation,
  getSummary,
  getTypeName,
  isArrayModelType,
  isErrorModel,
  isRecordModelType,
  isTemplateDeclaration,
  isTemplateInstance,
  NodeHost,
  resolveEncodedName,
  serializeValueAsJson,
  type CompilerHost,
  type Diagnostic as TspDiagnostic,
  type Enum,
  type Interface,
  type Model,
  type ModelProperty,
  type Namespace,
  type Operation as TspOperation,
  type Program,
  type Scalar,
  type Type,
  type Union,
} from "@typespec/compiler";
import {
  getAuthentication,
  getHttpOperation,
  type HttpOperation,
  type HttpOperationResponse,
  type HttpProperty,
} from "@typespec/http";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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

/** TypeSpec source: one `main.tsp` text, or a file set keyed by relative path (which must contain `main.tsp`; the files may import each other). */
export type TypeSpecSource = string | Readonly<Record<string, string>>;

const ENTRY = "main.tsp";

// ============================================================================
// Compilation
// ============================================================================

/** A directory beside the `node_modules` `@typespec/http` resolves from, so libraries installed next to it resolve from files placed there. */
function virtualRoot(): string {
  const entry = fileURLToPath(import.meta.resolve("@typespec/http"));
  const marker = `${"/"}node_modules${"/"}`;
  const at = entry.lastIndexOf(marker);
  const base = at >= 0 ? entry.slice(0, at) : dirname(entry);
  return join(base, "__fractal_typespec__");
}

function virtualHost(root: string, files: ReadonlyMap<string, string>): CompilerHost {
  const dirs = new Set<string>([root]);
  for (const path of files.keys()) {
    for (let d = dirname(path); !dirs.has(d); d = dirname(d)) dirs.add(d);
  }
  const isVirtual = (p: string): boolean => files.has(p) || dirs.has(p);
  return {
    ...NodeHost,
    readFile: async (path) => {
      const text = files.get(path);
      return text !== undefined ? createSourceFile(text, path) : NodeHost.readFile(path);
    },
    stat: async (path) =>
      files.has(path)
        ? { isFile: () => true, isDirectory: () => false }
        : dirs.has(path)
          ? { isFile: () => false, isDirectory: () => true }
          : NodeHost.stat(path),
    realpath: async (path) => (isVirtual(path) ? path : NodeHost.realpath(path)),
    readDir: async (path) => {
      if (!dirs.has(path)) return NodeHost.readDir(path);
      const names = new Set<string>();
      for (const p of [...files.keys(), ...dirs]) {
        if (p !== path && dirname(p) === path) names.add(basename(p));
      }
      return [...names];
    },
  };
}

const diagnosticAt = (d: TspDiagnostic, root: string): string => {
  const target = d.target as Parameters<typeof getSourceLocation>[0];
  const loc = getSourceLocation(target);
  if (loc === undefined) return d.code;
  const { line, character } = loc.file.getLineAndCharacterOfPosition(loc.pos);
  const path = loc.file.path.startsWith(root) ? relative(root, loc.file.path) : loc.file.path;
  return `${path}:${line + 1}:${character + 1}`;
};

/**
 * Compile `source` and import the checked program. Rejects only when the file
 * set is malformed or the compiler itself throws; TypeSpec errors in the
 * source are diagnostics.
 */
export async function fromTypeSpecSource(source: TypeSpecSource): Promise<Imported> {
  const entries = typeof source === "string" ? { [ENTRY]: source } : source;
  if (!(ENTRY in entries)) throw new Error(`fromTypeSpecSource: the file set has no "${ENTRY}"`);
  const root = virtualRoot();
  const files = new Map<string, string>();
  for (const [name, text] of Object.entries(entries)) {
    const path = join(root, name);
    if (relative(root, path).startsWith("..")) {
      throw new Error(`fromTypeSpecSource: "${name}" is outside the virtual directory`);
    }
    files.set(path, text);
  }
  const program = await compile(virtualHost(root, files), join(root, ENTRY), { noEmit: true });
  const imported = fromTypeSpecProgram(program);
  const compiler: Diagnostic[] = program.diagnostics.map((d) => ({
    at: diagnosticAt(d, root),
    message: `${d.severity} ${d.code}: ${d.message}`,
  }));
  return { api: imported.api, diagnostics: [...compiler, ...imported.diagnostics] };
}

// ============================================================================
// Walking the checked program
// ============================================================================

const isProject = (program: Program, type: Type): boolean =>
  getLocationContext(program, type).type === "project";

/** A JSON-safe copy of a decorator argument's JS value, or `undefined` when it holds anything that is not plain data. */
function plain(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (depth > 6 || typeof v !== "object") return undefined;
  if (Array.isArray(v)) {
    const items = v.map((e) => plain(e, depth + 1));
    return items.some((e) => e === undefined) ? undefined : items;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  if ("kind" in v && "entityKind" in v) return undefined;
  const out: Obj = {};
  for (const [k, e] of Object.entries(v)) {
    const p = plain(e, depth + 1);
    if (p === undefined) return undefined;
    out[k] = p;
  }
  return out;
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

// Decorators whose meaning is mapped (or recorded under a dedicated key), so
// they are not repeated in `meta.typespec.decorators`.
const CONSUMED_DECORATORS: ReadonlySet<string> = new Set([
  "@doc",
  "docFromCommentDecorator",
  "@summary",
  "@minLength",
  "@maxLength",
  "@minItems",
  "@maxItems",
  "@minValue",
  "@maxValue",
  "@minValueExclusive",
  "@maxValueExclusive",
  "@pattern",
  "@format",
  "@encodedName",
  "@encode",
  "@error",
  "@service",
  "@discriminator",
  "@route",
  "@get",
  "@put",
  "@post",
  "@patch",
  "@delete",
  "@head",
  "@path",
  "@query",
  "@header",
  "@cookie",
  "@body",
  "@bodyRoot",
  "@bodyIgnore",
  "@multipartBody",
  "@statusCode",
  "@useAuth",
]);

const STD_SCALARS: Readonly<Record<string, () => TypeRef>> = {
  string: () => t(types.string),
  boolean: () => t(types.boolean),
  bytes: () => bytes(),
  int8: () => int8(),
  int16: () => int16(),
  int32: () => int32(),
  int64: () => int64(),
  uint8: () => uint8(),
  uint16: () => uint16(),
  uint32: () => uint32(),
  uint64: () => uint64(),
  integer: () => t(types.integer),
  safeint: () => t(types.integer),
  numeric: () => t(types.number),
  float: () => t(types.number),
  float32: () => float32(),
  float64: () => float64(),
  decimal: () => t(types.number, { format: "bigdecimal" }),
  decimal128: () => t(types.number, { format: "bigdecimal" }),
  plainDate: () => date(),
  plainTime: () => time(),
  utcDateTime: () => datetime(),
  offsetDateTime: () => datetime(),
  duration: () => duration(),
  url: () => uri(),
};

// RFC 9110 §9.2.1: GET, HEAD, OPTIONS and TRACE are safe; §9.2.2: PUT, DELETE
// and the safe methods are idempotent.
const SAFE: ReadonlySet<string> = new Set(["get", "head", "options", "trace"]);
const IDEMPOTENT: ReadonlySet<string> = new Set(["put", "delete", ...SAFE]);

type StatusCodes = HttpOperationResponse["statusCodes"];
const isSuccessStatus = (s: StatusCodes): boolean =>
  typeof s === "number" ? s >= 200 && s < 300 : s !== "*" && s.start >= 200 && s.end < 300;
const lowestStatus = (s: StatusCodes): number =>
  typeof s === "number" ? s : s === "*" ? Infinity : s.start;

/**
 * Import an already checked program. Only project-declared types and
 * operations are imported (plus any library type they reference).
 */
export function fromTypeSpecProgram(program: Program): Imported {
  const diagnostics: Diagnostic[] = [];
  const diag = (at: string, message: string): void => {
    diagnostics.push({ at, message });
  };
  const nameOf = (type: Type): string => {
    try {
      return getTypeName(type);
    } catch {
      return "?";
    }
  };

  // ---------------------------------------------------------------- types
  const defs: Record<string, TypeRef> = {};
  const defKeys = new Map<Type, string>();
  const claimedKeys = new Set<string>();

  const templateArgName = (arg: unknown): string => {
    if (typeof arg === "object" && arg !== null && "kind" in arg) {
      const a = arg as Type;
      if ("name" in a && typeof a.name === "string" && a.name.length > 0) return sanitize(a.name);
      if (a.kind === "String" || a.kind === "Number" || a.kind === "Boolean") {
        return sanitize(String(a.value));
      }
    }
    return "T";
  };

  const claimKey = (type: Model | Enum | Union | Scalar): string => {
    const bare = sanitize(type.name ?? "");
    const args = isTemplateInstance(type)
      ? ((type as { templateMapper?: { args: readonly unknown[] } }).templateMapper?.args ?? [])
      : [];
    const base = args.length > 0 ? `${bare}_${args.map(templateArgName).join("_")}` : bare;
    for (const candidate of [base, nameOf(type).replace(/[<>, ]+/g, "_")]) {
      if (candidate.length > 0 && !claimedKeys.has(candidate)) return candidate;
    }
    let n = 2;
    while (claimedKeys.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  };

  /** A def worth naming: declared with a name, not a template declaration, and not from the compiler's own std library. */
  const isNamedDef = (type: Type): boolean => {
    if (type.kind !== "Model" && type.kind !== "Enum" && type.kind !== "Union") {
      if (type.kind !== "Scalar") return false;
    }
    const name = (type as { name?: string }).name;
    if (name === undefined || name.length === 0) return false;
    if (isTemplateDeclaration(type as Model)) return false;
    return getLocationContext(program, type).type !== "compiler";
  };

  const unknownRef = (at: string, what: string): TypeRef => {
    diag(at, `${what} is not representable; imported as unknown`);
    return t(types.unknown);
  };

  const decoratorList = (type: Type): { name: string; args?: unknown[] }[] => {
    const out: { name: string; args?: unknown[] }[] = [];
    for (const d of (type as { decorators?: readonly Obj[] }).decorators ?? []) {
      const declared = (d.definition as { name?: string } | undefined)?.name;
      const jsName = (d.decorator as { name?: string } | undefined)?.name ?? "";
      const name = declared ?? (jsName.startsWith("$") ? `@${jsName.slice(1)}` : jsName);
      if (name === "" || CONSUMED_DECORATORS.has(name)) continue;
      const args = ((d.args as { jsValue?: unknown }[] | undefined) ?? []).map((a) =>
        plain(a.jsValue),
      );
      out.push(args.length > 0 && args.every((a) => a !== undefined) ? { name, args } : { name });
    }
    return out;
  };

  /** Meta shared by types and properties: docs, deprecation, refinements. */
  const commonMeta = (type: Type): Obj => {
    const meta: Obj = {};
    const doc = getDoc(program, type);
    if (doc !== undefined) meta.description = doc;
    const summary = getSummary(program, type);
    if (summary !== undefined) meta.title = summary;
    const dep = getDeprecationDetails(program, type);
    if (dep !== undefined) {
      meta.deprecated = true;
      if (dep.message.length > 0) meta.deprecatedReason = dep.message;
    }
    const set = (key: string, v: unknown): void => {
      if (v !== undefined) meta[key] = v;
    };
    if (type.kind === "Scalar" || type.kind === "ModelProperty") {
      set("minLength", getMinLength(program, type));
      set("maxLength", getMaxLength(program, type));
      set("minimum", getMinValue(program, type));
      set("maximum", getMaxValue(program, type));
      set("exclusiveMinimum", getMinValueExclusive(program, type));
      set("exclusiveMaximum", getMaxValueExclusive(program, type));
      set("pattern", getPattern(program, type));
      set("format", getFormat(program, type));
      const encode = getEncode(program, type);
      if (encode !== undefined) {
        meta.typespec = {
          encode: {
            ...(encode.encoding !== undefined ? { encoding: encode.encoding } : {}),
            type: encode.type.name,
          },
        };
      }
    }
    if (type.kind === "Model" || type.kind === "ModelProperty") {
      set("minItems", getMinItems(program, type));
      set("maxItems", getMaxItems(program, type));
    }
    return meta;
  };

  const withTypespec = (meta: Obj, extra: Obj): Obj => {
    if (Object.keys(extra).length === 0) return meta;
    return { ...meta, typespec: { ...(meta.typespec as Obj | undefined), ...extra } };
  };

  const convertNamed = (type: Model | Enum | Union | Scalar): TypeRef => {
    let key = defKeys.get(type);
    if (key === undefined) {
      key = claimKey(type);
      claimedKeys.add(key);
      defKeys.set(type, key);
      defs[key] = t(types.unknown);
      const at = nameOf(type);
      let body: TypeRef;
      try {
        body = convertBody(type, at);
      } catch (e) {
        body = unknownRef(at, `type (${e instanceof Error ? e.message : String(e)})`);
      }
      const decorators = decoratorList(type);
      let meta = withTypespec(
        { ...commonMeta(type), typeName: key },
        { name: nameOf(type), ...(decorators.length > 0 ? { decorators } : {}) },
      );
      if (type.kind === "Model") {
        const disc = getDiscriminator(program, type);
        if (disc !== undefined) meta = withTypespec(meta, { discriminator: disc.propertyName });
        if (isErrorModel(program, type)) meta = withTypespec(meta, { error: true });
      }
      defs[key] = withMeta(body, meta);
    }
    return t(types.ref(key));
  };

  const propertyType = (prop: ModelProperty): TypeRef => {
    const at = nameOf(prop);
    const meta: Obj = commonMeta(prop);
    if (prop.optional) meta.optional = true;
    if (prop.defaultValue !== undefined) {
      try {
        meta.default = serializeValueAsJson(program, prop.defaultValue, prop.type);
      } catch {
        diag(at, "default value is not JSON-serializable; dropped");
      }
    }
    const json = resolveEncodedName(program, prop, "application/json");
    if (json !== prop.name) meta.jsonName = json;
    const decorators = decoratorList(prop);
    const typespec: Obj = {};
    if (decorators.length > 0) typespec.decorators = decorators;
    const inner = convert(prop.type, at);
    const merged = withTypespec(meta, typespec);
    return Object.keys(merged).length > 0 ? withMeta(inner, merged) : inner;
  };

  const modelBody = (model: Model, at: string): TypeRef => {
    const fields: Record<string, TypeRef> = {};
    for (const [name, prop] of model.properties) fields[name] = propertyType(prop);
    const own = Object.keys(fields).length > 0 || model.indexer === undefined;
    const parts: TypeRef[] = [];
    if (model.baseModel !== undefined && !isArrayModelType(model) && !isRecordModelType(model)) {
      parts.push(convert(model.baseModel, at));
    }
    if (model.indexer !== undefined) {
      if (own && Object.keys(fields).length > 0) parts.push(t(types.object(fields)));
      const value = convert(model.indexer.value, at);
      parts.push(
        model.indexer.key.name === "integer"
          ? t(types.array(value))
          : t(types.map(t(types.string), value)),
      );
    } else if (Object.keys(fields).length > 0 || parts.length === 0) {
      parts.push(t(types.object(fields)));
    }
    return parts.length === 1 ? parts[0]! : t(types.intersection(parts));
  };

  const scalarBody = (scalar: Scalar, at: string): TypeRef => {
    const isStd = getLocationContext(program, scalar).type === "compiler";
    const std = STD_SCALARS[scalar.name];
    if (isStd && std !== undefined) return std();
    if (scalar.baseScalar !== undefined) return convert(scalar.baseScalar, at);
    return unknownRef(at, `scalar "${scalar.name}"`);
  };

  const enumBody = (en: Enum): TypeRef => {
    const values = [...en.members.values()].map((m) => m.value ?? m.name);
    if (values.every((v): v is string => typeof v === "string")) return t(types.enum(values));
    return t(types.union(values.map((v) => t(types.literal(v)))));
  };

  const convertBody = (type: Model | Enum | Union | Scalar, at: string): TypeRef => {
    switch (type.kind) {
      case "Model":
        return modelBody(type, at);
      case "Enum":
        return enumBody(type);
      case "Scalar":
        return scalarBody(type, at);
      case "Union":
        return t(types.union([...type.variants.values()].map((v) => convert(v.type, at))));
    }
  };

  const convert = (type: Type, at: string): TypeRef => {
    switch (type.kind) {
      case "Intrinsic":
        switch (type.name) {
          case "void":
            return t(types.void);
          case "never":
            return t(types.never);
          case "null":
            return t(types.null);
          case "unknown":
            return t(types.unknown);
          default:
            return unknownRef(at, "an erroneous type");
        }
      case "String":
        return t(types.literal(type.value));
      case "Number":
        return t(types.literal(type.value));
      case "Boolean":
        return t(types.literal(type.value));
      case "StringTemplate":
        return t(types.string);
      case "Tuple":
        return t(types.tuple(type.values.map((v) => convert(v, at))));
      case "UnionVariant":
      case "ModelProperty":
        return convert(type.type, at);
      case "EnumMember":
        return t(types.literal(type.value ?? type.name));
      case "Model":
        if (isArrayModelType(type) && !isNamedDef(type) && type.indexer !== undefined) {
          return t(types.array(convert(type.indexer.value, at)));
        }
        if (isRecordModelType(type) && !isNamedDef(type) && type.indexer !== undefined) {
          return t(types.map(t(types.string), convert(type.indexer.value, at)));
        }
        return isNamedDef(type) ? convertNamed(type) : modelBody(type, at);
      case "Scalar":
        if (isNamedDef(type)) return convertNamed(type);
        return scalarBody(type, at);
      case "Enum":
        return isNamedDef(type) ? convertNamed(type) : enumBody(type);
      case "Union":
        return isNamedDef(type)
          ? convertNamed(type)
          : t(types.union([...type.variants.values()].map((v) => convert(v.type, at))));
      case "TemplateParameter":
        return unknownRef(at, "a template parameter");
      default:
        return unknownRef(at, `a ${type.kind} used as a type`);
    }
  };

  // ------------------------------------------------------------ operations
  const hasHttp = program.resolveTypeReference("TypeSpec.Http")[0] !== undefined;
  const operations: Operation[] = [];
  const groups: Group[] = [];

  type Pending = {
    readonly op: TspOperation;
    readonly container: readonly string[];
  };
  const pending: Pending[] = [];
  const groupAddresses = new Set<string>();

  const groupMeta = (type: Namespace | Interface): Obj => {
    let meta: Obj = {};
    const doc = getDoc(program, type);
    const summary = getSummary(program, type);
    if (doc !== undefined) meta.description = doc;
    else if (summary !== undefined) meta.description = summary;
    const extra: Obj = {};
    if (doc !== undefined && summary !== undefined) extra.summary = summary;
    const dep = getDeprecationDetails(program, type);
    if (dep !== undefined) {
      meta.tags = { deprecated: true };
      if (dep.message.length > 0) extra.deprecated = dep.message;
    }
    if (type.kind === "Namespace") {
      const service = getService(program, type);
      if (service !== undefined) {
        extra.service = service.title !== undefined ? { title: service.title } : {};
      }
      if (hasHttp) {
        const auth = getAuthentication(program, type);
        if (auth !== undefined) extra.auth = plain(JSON.parse(JSON.stringify(auth, authReplacer)));
      }
    }
    const decorators = decoratorList(type);
    if (decorators.length > 0) extra.decorators = decorators;
    meta = withTypespec(meta, extra);
    return meta;
  };

  const addGroup = (path: readonly string[], type: Namespace | Interface): void => {
    groupAddresses.add(addressKey(path.map(segStatic)));
    const meta = groupMeta(type);
    if (Object.keys(meta).length > 0 && path.length > 0) {
      groups.push({ address: path.map(segStatic), meta });
    }
  };

  const walk = (ns: Namespace, path: readonly string[]): void => {
    if (path.length > 0 && isProject(program, ns)) addGroup(path, ns);
    for (const iface of ns.interfaces.values()) {
      if (!isProject(program, iface) || isTemplateDeclaration(iface)) continue;
      const ipath = [...path, iface.name];
      addGroup(ipath, iface);
      for (const op of iface.operations.values()) pending.push({ op, container: ipath });
    }
    for (const op of ns.operations.values()) {
      if (isProject(program, op) && !isTemplateDeclaration(op)) {
        pending.push({ op, container: path });
      }
    }
    for (const type of [
      ...ns.models.values(),
      ...ns.enums.values(),
      ...ns.unions.values(),
      ...ns.scalars.values(),
    ]) {
      if (isProject(program, type) && isNamedDef(type)) convertNamed(type);
    }
    for (const child of ns.namespaces.values()) walk(child, [...path, child.name]);
  };
  walk(program.getGlobalNamespaceType(), []);

  // Operation keys: name verbatim; a key that lands on a group position or on
  // another operation falls back to `<name>Op` (then a numeric suffix).
  const usedOperationKeys = new Set<string>();
  const keyFor = (container: readonly string[], op: TspOperation, at: string): string => {
    const taken = (name: string): boolean => {
      const k = addressKey([...container, name].map(segStatic));
      return groupAddresses.has(k) || usedOperationKeys.has(k);
    };
    let key = op.name;
    if (taken(key)) {
      const first = `${op.name}Op`;
      key = first;
      for (let n = 2; taken(key); n++) key = `${first}${n}`;
      diag(at, `operation name collides with a group or another operation; keyed "${key}"`);
    }
    usedOperationKeys.add(addressKey([...container, key].map(segStatic)));
    return key;
  };

  const httpPaths: string[] = [];
  const httpOps = new Map<TspOperation, HttpOperation>();
  if (hasHttp) {
    for (const { op } of pending) {
      const [httpOp, httpDiagnostics] = getHttpOperation(program, op);
      httpOps.set(op, httpOp);
      httpPaths.push(httpOp.path);
      for (const d of httpDiagnostics) {
        if (program.diagnostics.some((x) => x.code === d.code && x.message === d.message)) continue;
        diag(nameOf(op), `${d.severity} ${d.code}: ${d.message}`);
      }
    }
  }
  const addressing = httpAddressing(httpPaths);

  for (const { op, container } of pending) {
    const at = nameOf(op);
    const key = keyFor(container, op, at);
    const address: Segment[] = [...container, key].map(segStatic);
    const httpOp = httpOps.get(op);

    const fields: Record<string, TypeRef> = {};
    for (const [name, prop] of op.parameters.properties) fields[name] = propertyType(prop);

    // ---- output and non-success responses
    let output: TypeRef;
    let firstSuccessStatus: number | undefined;
    const errors: Obj[] = [];
    if (httpOp !== undefined) {
      const successBodies: TypeRef[] = [];
      let bodiless = false;
      let successStatus: number | undefined;
      const responses = [...httpOp.responses].sort(
        (a, b) => lowestStatus(a.statusCodes) - lowestStatus(b.statusCodes),
      );
      for (const response of responses) {
        const success = isSuccessStatus(response.statusCodes);
        for (const content of response.responses) {
          const body = content.body;
          if (content.headers !== undefined && Object.keys(content.headers).length > 0) {
            diag(at, "response headers are not represented");
          }
          if (
            body !== undefined &&
            body.contentTypes.length > 0 &&
            !body.contentTypes.some((c) => c === "application/json" || c.endsWith("+json"))
          ) {
            diag(at, `response body content type "${body.contentTypes.join(", ")}" is not JSON`);
          }
          const ref = body !== undefined ? convert(body.type, at) : undefined;
          if (success) {
            if (ref === undefined) bodiless = true;
            else if (!successBodies.some((b) => JSON.stringify(b) === JSON.stringify(ref))) {
              successBodies.push(ref);
            }
            if (successStatus === undefined && typeof response.statusCodes === "number") {
              successStatus = response.statusCodes;
            }
          } else {
            errors.push({
              status: response.statusCodes,
              ...(ref !== undefined ? { type: ref } : {}),
              ...(response.description !== undefined ? { description: response.description } : {}),
            });
          }
        }
      }
      if (successBodies.length === 0) output = t(types.void);
      else if (successBodies.length === 1) output = successBodies[0]!;
      else output = t(types.union(successBodies));
      if (bodiless && successBodies.length > 0) {
        diag(at, "some success responses carry no body; the output is the bodies of the others");
      }
      firstSuccessStatus = successStatus;
    } else {
      const rt = op.returnType;
      const variants =
        rt.kind === "Union" && rt.name === undefined
          ? [...rt.variants.values()].map((v) => v.type)
          : [rt];
      const isErr = (v: Type): boolean => v.kind === "Model" && isErrorModel(program, v);
      const ok = variants.filter((v) => !isErr(v));
      for (const v of variants.filter(isErr)) errors.push({ type: convert(v, at) });
      if (ok.length === 0) {
        output = t(types.void);
        diag(at, "every return variant is an @error model; the output is void");
      } else if (ok.length === 1) output = convert(ok[0]!, at);
      else output = t(types.union(ok.map((v) => convert(v, at))));
    }
    if (errors.length > 0) {
      diag(
        at,
        "non-success responses are kept under meta.typespec.errors; error types are not represented",
      );
    }

    // ---- metadata
    const meta: Obj = {};
    const doc = getDoc(program, op);
    const summary = getSummary(program, op);
    if (doc !== undefined) meta.description = doc;
    else if (summary !== undefined) meta.description = summary;
    const typespec: Obj = { id: at };
    if (doc !== undefined && summary !== undefined) typespec.summary = summary;
    const tags: Obj = {};
    const dep = getDeprecationDetails(program, op);
    if (dep !== undefined) {
      tags.deprecated = true;
      if (dep.message.length > 0) typespec.deprecated = dep.message;
    }
    const decorators = decoratorList(op);
    if (decorators.length > 0) typespec.decorators = decorators;
    if (errors.length > 0) typespec.errors = errors;

    if (httpOp !== undefined) {
      const verb = httpOp.verb;
      if (SAFE.has(verb)) tags.readOnly = true;
      if (IDEMPOTENT.has(verb)) tags.idempotent = true;
      if (firstSuccessStatus !== undefined && firstSuccessStatus !== 200) {
        typespec.successStatus = firstSuccessStatus;
      }
      if (httpOp.authentication !== undefined) {
        typespec.auth = plain(JSON.parse(JSON.stringify(httpOp.authentication, authReplacer)));
        diag(
          at,
          "authentication is kept under meta.typespec.auth and is not mapped to meta.openapi.security",
        );
      }

      const bound = bindHttp(program, httpOp, fields, container, addressing);
      if (bound.ok) {
        meta.http = { method: verb.toUpperCase(), moveTo: "..", sourceMap: bound.sourceMap };
      } else {
        typespec.http = {
          method: verb.toUpperCase(),
          path: httpOp.path,
          uriTemplate: httpOp.uriTemplate,
          bindings: bound.bindings,
        };
        diag(at, `http binding kept under meta.typespec.http: ${bound.reason}`);
      }
    }
    if (Object.keys(tags).length > 0) meta.tags = tags;
    meta.typespec = typespec;

    operations.push({
      address,
      input: t(types.object(fields)),
      output,
      meta,
    });
  }

  const api: ApiDescription = { operations, groups, defs };
  return { api, diagnostics };
}

const segStatic = (name: string): Segment => ({ kind: "static", name });

// `HttpAuth.model` (and other `Type` references) would drag the type graph
// into the JSON; the scheme's own data is everything else.
const authReplacer = (key: string, value: unknown): unknown =>
  key === "model" || key === "params" ? undefined : value;

type Binding = { kind: HttpProperty["kind"]; key?: string; path?: (string | number)[] };
type BoundHttp =
  | { readonly ok: true; readonly sourceMap: Record<string, { store: string; key?: string }> }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly bindings: Readonly<Record<string, Binding>>;
    };

/** Where each input field lives on the wire, and whether that is exactly statable as `meta.http`. */
function bindHttp(
  program: Program,
  httpOp: HttpOperation,
  fields: Readonly<Record<string, TypeRef>>,
  container: readonly string[],
  addressing: ReturnType<typeof httpAddressing>,
): BoundHttp {
  const bindings: Record<string, Binding> = {};
  const reasons: string[] = [];
  const sourceMap: Record<string, { store: string; key?: string }> = {};

  const addressed = addressing.addressPath(httpOp.path);
  if (!addressed.ok) reasons.push(`the route ${httpOp.path}: ${addressed.reason}`);
  else {
    const mirrors =
      addressed.segments.length === container.length &&
      addressed.segments.every((s, i) => s.kind === "static" && s.name === container[i]);
    if (!mirrors) {
      reasons.push(`the address does not mirror the route ${httpOp.path}`);
    }
  }

  const nested = new Set<string>();
  for (const hp of httpOp.parameters.properties) {
    const top = hp.path[0];
    if (typeof top !== "string" || !(top in fields)) continue;
    if (hp.path.length > 1) {
      nested.add(top);
      continue;
    }
    const wire = (hp as { options?: { name?: string } }).options?.name;
    const key = wire !== undefined && wire !== top ? wire : undefined;
    bindings[top] = { kind: hp.kind, ...(key !== undefined ? { key } : {}) };
    switch (hp.kind) {
      case "path": {
        const bound = addressed.ok ? addressed.pathParamKeys.get(wire ?? top) : undefined;
        const o = hp.options;
        if (o.style !== "simple" || o.allowReserved || o.explode) {
          reasons.push(`path parameter "${top}" uses style/explode/reserved options`);
        }
        sourceMap[top] = {
          store: "path",
          ...(bound !== undefined && bound !== top ? { key: bound } : {}),
        };
        break;
      }
      case "query":
        if (hp.options.explode && fields[top]?.shape.kind === "array") {
          reasons.push(`query parameter "${top}" is exploded`);
        }
        sourceMap[top] = { store: "query", ...(key !== undefined ? { key } : {}) };
        break;
      case "header":
        sourceMap[top] = { store: "header", ...(key !== undefined ? { key } : {}) };
        break;
      case "cookie":
        sourceMap[top] = { store: "cookie", ...(key !== undefined ? { key } : {}) };
        break;
      case "contentType":
        sourceMap[top] = { store: "header", key: "Content-Type" };
        break;
      case "bodyProperty": {
        const json = resolveEncodedName(program, hp.property, "application/json");
        sourceMap[top] = { store: "body", ...(json !== top ? { key: json } : {}) };
        break;
      }
      default:
        reasons.push(`parameter "${top}" is bound as ${hp.kind}, which sourceMap cannot state`);
    }
  }
  for (const name of Object.keys(fields)) {
    if (nested.has(name)) reasons.push(`parameter "${name}" carries nested http metadata`);
    if (!(name in bindings) && !nested.has(name)) {
      reasons.push(`parameter "${name}" has no http binding`);
    }
  }
  if (httpOp.parameters.body?.bodyKind === "multipart") reasons.push("the body is multipart");

  if (reasons.length > 0) return { ok: false, reason: [...new Set(reasons)].join("; "), bindings };
  return { ok: true, sourceMap };
}
