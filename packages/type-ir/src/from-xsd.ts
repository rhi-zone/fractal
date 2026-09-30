// XML Schema (XSD 1.0 / 1.1) schema documents -> TypeRef.
//
// Input: already-parsed `xs:schema` elements as `XmlElement` trees (this
// module has no XML parser dependency; api-tree's WSDL importer produces the
// trees). A WSDL `types` section holds several schemas that import each other
// by namespace, so all of them are passed together.
//
// Naming: every named simpleType/complexType is an entry in `defs`, keyed by
// its local name, or `<namespace token>.<local>` when two namespaces declare
// the same local name (then a numeric suffix if that still clashes). A global
// element whose type is anonymous is also a def (keyed by the element's local
// name, `<local>Element` if a type already took it) because a `ref` is the
// only way to point at it; a global element with a named type is not, its
// value type is a `ref` to that type. Every reference to a named type is
// `{ kind: "ref", target: key }`; `keys` maps `{namespace}local` to the key.
//
// Simple types (Datatypes §3.2 primitive, §3.3 derived):
//   - string family (string, normalizedString, token, language, Name, NCName,
//     NMTOKEN, ID, IDREF, ENTITY, QName, NOTATION, anySimpleType, the g*
//     date parts) -> `string`; NMTOKENS/IDREFS/ENTITIES -> array of string.
//     The XSD name of every lossy mapping is kept as `meta.xsd.builtin`.
//   - boolean -> boolean; anyURI -> uri; base64Binary/hexBinary -> bytes;
//     dateTime/date/time/duration -> the same-named kinds.
//   - byte/short/int/long and their unsigned forms -> int8..int64 / uint8..
//     uint64; integer -> `integer` with format "bigint" (nonNegativeInteger,
//     positiveInteger, nonPositiveInteger, negativeInteger add `minimum` /
//     `maximum`); decimal -> `number` with format "bigdecimal"; float/double
//     -> float32/float64.
//   - restriction: facets apply to the flattened base. enumeration -> `enum`
//     (string-like bases), a union of number literals (numeric bases), or a
//     union of boolean literals; pattern -> `meta.pattern` anchored as
//     `^(?:p)$` when the expression uses no XSD-only construct (else kept
//     verbatim as `meta.xsd.pattern` and reported); a restriction of a
//     restriction that both carry a pattern intersects them with a lookahead;
//     length/minLength/maxLength -> minLength/maxLength (string-like) or
//     minItems/maxItems (list), else verbatim; min/maxInclusive/Exclusive ->
//     minimum/maximum/exclusiveMinimum/exclusiveMaximum (numeric bases), else
//     verbatim; totalDigits, fractionDigits, whiteSpace, explicitTimezone
//     verbatim under `meta.xsd`; assertion (1.1) verbatim and reported.
//   - list -> `array` of the item type (`meta.xsd.list`); union -> `union`.
//
// Complex types (Structures §3.4, §3.8, §3.9):
//   - sequence / all -> `object`; an element particle is a field named by
//     its local name, `meta.optional` when minOccurs is 0 (or an enclosing
//     particle's is), `array` (with `minItems`/`maxItems`) when maxOccurs > 1,
//     `meta.nullable` when nillable. A repeated name within one type merges
//     into one array field when the types agree.
//   - attribute -> a field of the same name (`meta.xsd.attribute`), optional
//     unless use="required"; a clash with an element field renames it `@name`
//     (reported); use="prohibited" removes it. attributeGroup and group
//     references expand in place.
//   - a content model that is exactly one non-repeated `choice` -> a `union`
//     of objects, one per alternative (each carrying the attributes); a
//     choice anywhere else (nested, repeated, extended) -> every alternative
//     is an optional field marked `meta.xsd.choice`, and the lost exclusivity
//     or order is reported. A repeated sequence/all/group becomes per-element
//     arrays, reported.
//   - extension / restriction of a complex type flatten the base's fields
//     into the derived object (`meta.xsd.extends` names the base def).
//   - simpleContent -> the text type when the type has no attributes, else an
//     object with the text as field `value` (`$value` on a name clash).
//   - `xs:any` / `xs:anyAttribute` -> `meta.xsd.any` / `meta.xsd.anyAttribute`
//     (namespace, processContents) and reported; mixed content -> `meta.xsd.mixed`
//     and reported.
//   - `default` -> `meta.default` when the value is representable as the
//     field's type, else `meta.xsd.default`; `fixed` -> `meta.xsd.fixed`.
//   - `xs:documentation` -> `meta.description`; appinfo is reported.
//
// Reported, not represented: identity constraints (key/keyref/unique),
// substitution groups, abstract types/elements beyond `meta.xsd.abstract`,
// xs:include / xs:redefine / xs:override, xs:import of a namespace that is
// not among the given schemas, notations, type alternatives (1.1), open
// content (1.1), element/attribute declarations that reference a name that is
// not declared, and derivation from an unresolvable base.
//
// Spec references: XML Schema Part 1 Structures 1.0 (2nd ed.) §3.2 Attribute
// Declarations, §3.3 Element Declarations, §3.4 Complex Type Definitions,
// §3.5 Attribute Uses, §3.6 Attribute Group Definitions, §3.7 Model Group
// Definitions, §3.8 Model Groups, §3.9 Particles, §3.10 Wildcards, §3.11
// Identity-constraint Definitions, §3.13 Annotations, §3.14 Simple Type
// Definitions, §3.15 Schemas as a Whole, §4.2 (include, redefine, import);
// Structures 1.1 §3.12 Type Alternatives, §3.13 Assertions, §3.15
// Annotations, §3.16 Simple Type Definitions, §4.2.5 override. Part 2
// Datatypes 1.0 §3.2, §3.3, §4.3.1-§4.3.12 (facets), §2.5.1.2/§2.5.1.3
// (list, union), Appendix F (regular expressions); Datatypes 1.1 §3.3, §3.4,
// §4.3.13 (assertions), §4.3.14 (explicitTimezone), Appendix G.

import { ancestors, t, types, withMeta, type TypeRef } from "./index.ts";
import {
  bytes,
  date,
  datetime,
  duration,
  float32,
  float64,
  int16,
  int32,
  int64,
  int8,
  time,
  uint16,
  uint32,
  uint64,
  uint8,
  uri,
} from "./kinds/common.ts";

export const XSD_NS = "http://www.w3.org/2001/XMLSchema";

/** A parsed XML element. `scope` is every namespace prefix in effect (`""` is the default namespace), so QName-valued attributes and text resolve without the ancestors. Namespace declarations are not in `attrs`; attributes are keyed as written (`prefix:local` when prefixed). */
export type XmlElement = {
  readonly name: string;
  readonly local: string;
  readonly ns: string | undefined;
  readonly attrs: Readonly<Record<string, string>>;
  readonly scope: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The element's own text nodes concatenated (not its descendants'). */
  readonly text: string;
};

export type XsdName = { readonly ns: string; readonly local: string };

export type XsdDiagnostic = { readonly at: string; readonly message: string };

export type XsdTypes = {
  /** Named types and anonymously-typed global elements, keyed as described above. */
  readonly defs: Readonly<Record<string, TypeRef>>;
  /** `{namespace}local` of every named type -> its def key. */
  readonly keys: Readonly<Record<string, string>>;
  readonly diagnostics: readonly XsdDiagnostic[];
  /** The value type of global element `name`: a `ref` to its def, or the named/builtin type it declares (`meta.nullable` if nillable); `undefined` when no such element exists. */
  element(name: XsdName): TypeRef | undefined;
  /** A reference to the named or built-in type `name`; `undefined` when it does not exist. */
  type(name: XsdName): TypeRef | undefined;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ============================================================================
// XmlElement helpers (shared with the WSDL importer).
// ============================================================================

/** Resolve a QName-valued string against `el`'s in-scope namespaces. An unprefixed name is in the default namespace, if any. `undefined` for an undeclared prefix. */
export function resolveQName(el: XmlElement, value: string): XsdName | undefined {
  const v = value.trim();
  const i = v.indexOf(":");
  if (i < 0) return { ns: el.scope[""] ?? "", local: v };
  const ns = el.scope[v.slice(0, i)];
  return ns === undefined ? undefined : { ns, local: v.slice(i + 1) };
}

/** The value of attribute `local` in namespace `ns` on `el` (`ns` `""`: an unprefixed attribute). */
export function attrNs(el: XmlElement, ns: string, local: string): string | undefined {
  for (const [key, value] of Object.entries(el.attrs)) {
    const i = key.indexOf(":");
    if (i < 0) {
      if (ns === "" && key === local) return value;
    } else if (key.slice(i + 1) === local && el.scope[key.slice(0, i)] === ns) return value;
  }
  return undefined;
}

/** `el`'s element children in namespace `ns` named `local`. */
export const childrenNs = (el: XmlElement, ns: string, local: string): XmlElement[] =>
  el.children.filter((c) => c.ns === ns && c.local === local);

/** The text of `el` and all its descendants, in document order. */
export function textContent(el: XmlElement): string {
  return el.text + el.children.map(textContent).join("");
}

// ============================================================================
// Built-in datatypes (Datatypes §3.2, §3.3).
// ============================================================================

const xsd = (meta: Obj): Obj => ({ xsd: meta });
const str = (builtin: string): TypeRef => t(types.string, xsd({ builtin }));
const listOf = (builtin: string): TypeRef =>
  t(types.array(t(types.string)), xsd({ builtin, list: true }));
const bigint = (builtin: string, extra: Obj = {}): TypeRef =>
  t(types.integer, { format: "bigint", ...extra, ...xsd({ builtin }) });

const BUILTINS: Readonly<Record<string, () => TypeRef>> = {
  string: () => t(types.string),
  normalizedString: () => str("normalizedString"),
  token: () => str("token"),
  language: () => str("language"),
  Name: () => str("Name"),
  NCName: () => str("NCName"),
  NMTOKEN: () => str("NMTOKEN"),
  ID: () => str("ID"),
  IDREF: () => str("IDREF"),
  ENTITY: () => str("ENTITY"),
  QName: () => str("QName"),
  NOTATION: () => str("NOTATION"),
  NMTOKENS: () => listOf("NMTOKENS"),
  IDREFS: () => listOf("IDREFS"),
  ENTITIES: () => listOf("ENTITIES"),
  anySimpleType: () => str("anySimpleType"),
  anyAtomicType: () => str("anyAtomicType"),
  anyURI: () => uri(),
  boolean: () => t(types.boolean),
  base64Binary: () => bytes(),
  hexBinary: () => bytes(xsd({ builtin: "hexBinary" })),
  decimal: () => t(types.number, { format: "bigdecimal", ...xsd({ builtin: "decimal" }) }),
  integer: () => bigint("integer"),
  nonNegativeInteger: () => bigint("nonNegativeInteger", { minimum: 0 }),
  positiveInteger: () => bigint("positiveInteger", { minimum: 1 }),
  nonPositiveInteger: () => bigint("nonPositiveInteger", { maximum: 0 }),
  negativeInteger: () => bigint("negativeInteger", { maximum: -1 }),
  long: () => int64(),
  int: () => int32(),
  short: () => int16(),
  byte: () => int8(),
  unsignedLong: () => uint64(),
  unsignedInt: () => uint32(),
  unsignedShort: () => uint16(),
  unsignedByte: () => uint8(),
  float: () => float32(),
  double: () => float64(),
  dateTime: () => datetime(),
  dateTimeStamp: () => datetime(xsd({ builtin: "dateTimeStamp" })),
  date: () => date(),
  time: () => time(),
  duration: () => duration(),
  dayTimeDuration: () => duration(xsd({ builtin: "dayTimeDuration" })),
  yearMonthDuration: () => duration(xsd({ builtin: "yearMonthDuration" })),
  gYear: () => str("gYear"),
  gYearMonth: () => str("gYearMonth"),
  gMonth: () => str("gMonth"),
  gMonthDay: () => str("gMonthDay"),
  gDay: () => str("gDay"),
};

// Datatypes §4.3.6: the whiteSpace a built-in applies before validating.
const COLLAPSING: ReadonlySet<string> = new Set([
  "token",
  "language",
  "Name",
  "NCName",
  "NMTOKEN",
  "ID",
  "IDREF",
  "ENTITY",
  "QName",
  "NOTATION",
]);

const isKind = (kind: string, root: string): boolean =>
  kind === root || ancestors(kind).includes(root);

const collapse = (s: string): string => s.replace(/[\t\n\r ]+/g, " ").trim();

// ============================================================================
// XSD regular expressions (Datatypes Appendix F / G) -> ECMAScript.
// ============================================================================

/** Why `pattern` cannot be used unchanged as an ECMAScript regular expression, or `undefined` when it can. */
function xsdRegexProblem(pattern: string): string | undefined {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[i + 1];
      if (n !== undefined && "iIcC".includes(n))
        return `escape \\${n} has no ECMAScript equivalent`;
      if (n === "p" || n === "P") return "Unicode category/block escapes need the u flag";
      i++;
    } else if (inClass) {
      if (c === "[") return "character class subtraction";
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
      if (pattern[i + 1] === "^") i++;
    } else if (c === "^" || c === "$") {
      return `"${c}" is a literal character in an XSD regular expression`;
    }
  }
  return undefined;
}

// ============================================================================
// The converter.
// ============================================================================

type Facets = {
  enumeration: string[];
  pattern: string[];
  assertions: string[];
  other: Record<string, string>;
};

type FieldSpec = { name: string; type: TypeRef; optional: boolean; xsd?: Obj };

type Content = {
  elements: FieldSpec[];
  attributes: FieldSpec[];
  /** Simple content's text type. */
  text?: TypeRef;
  /** The alternatives of an exact top-level choice. */
  variants?: FieldSpec[][];
  mixed: boolean;
  any?: Obj;
  anyAttribute?: Obj;
  extendsKey?: string;
  description?: string;
};

type Ctx = { optional: boolean; repeated: boolean };

type Entry = {
  readonly clark: string;
  readonly name: XsdName;
  readonly el: XmlElement;
  readonly at: string;
  key?: string;
};

const clark = (n: XsdName): string => `{${n.ns}}${n.local}`;

const kidsOf = (el: XmlElement, local: string): XmlElement[] => childrenNs(el, XSD_NS, local);
const kidOf = (el: XmlElement, local: string): XmlElement | undefined => kidsOf(el, local)[0];

function nsToken(ns: string): string {
  const tokens = ns.replace(/^[a-z][a-z0-9+.-]*:\/*/i, "").split(/[^A-Za-z0-9]+/);
  return tokens.filter((s) => s.length > 0).pop() ?? "ns";
}

function occurs(el: XmlElement): { min: number; max: number } {
  const min = Number(el.attrs.minOccurs ?? "1");
  const raw = el.attrs.maxOccurs ?? "1";
  const max = raw === "unbounded" ? Number.POSITIVE_INFINITY : Number(raw);
  return {
    min: Number.isFinite(min) && min >= 0 ? min : 1,
    max: Number.isNaN(max) || max < 0 ? 1 : max,
  };
}

export function fromXsd(input: XmlElement | readonly XmlElement[]): XsdTypes {
  const schemaEls: readonly XmlElement[] = "children" in input ? [input] : input;
  const diagnostics: XsdDiagnostic[] = [];
  const diag = (at: string, message: string): void => {
    diagnostics.push({ at, message });
  };

  const typeEntries = new Map<string, Entry>();
  const elementEntries = new Map<string, Entry>();
  const attributeEntries = new Map<string, Entry>();
  const groupEntries = new Map<string, Entry>();
  const attributeGroupEntries = new Map<string, Entry>();

  const schemas = schemaEls.filter((s, i) => {
    const ok = s.ns === XSD_NS && s.local === "schema";
    if (!ok) diag(`schema[${i}]`, `"${s.name}" is not an xs:schema element; skipped`);
    return ok;
  });
  const provided = new Set(schemas.map((s) => s.attrs.targetNamespace ?? ""));

  // ---- registry ------------------------------------------------------------
  for (const [i, schema] of schemas.entries()) {
    const tns = schema.attrs.targetNamespace ?? "";
    const base = `schema[${tns === "" ? i : tns}]`;
    const register = (map: Map<string, Entry>, el: XmlElement, what: string): Entry | undefined => {
      const local = el.attrs.name;
      if (local === undefined) {
        diag(`${base}/${what}`, `a global ${what} has no name; skipped`);
        return undefined;
      }
      const name = { ns: tns, local };
      const entry: Entry = { clark: clark(name), name, el, at: `${base}/${what}[${local}]` };
      if (map.has(entry.clark)) {
        diag(entry.at, `"${local}" is declared more than once; the first declaration is used`);
        return undefined;
      }
      map.set(entry.clark, entry);
      return entry;
    };
    for (const c of schema.children) {
      if (c.ns !== XSD_NS) continue;
      switch (c.local) {
        case "simpleType":
        case "complexType":
          register(typeEntries, c, c.local);
          break;
        case "element":
          register(elementEntries, c, "element");
          break;
        case "attribute":
          register(attributeEntries, c, "attribute");
          break;
        case "group":
          register(groupEntries, c, "group");
          break;
        case "attributeGroup":
          register(attributeGroupEntries, c, "attributeGroup");
          break;
        case "annotation":
          break;
        case "import": {
          const ns = c.attrs.namespace ?? "";
          if (!provided.has(ns)) {
            diag(
              base,
              `xs:import of namespace "${ns}"${c.attrs.schemaLocation ? ` (${c.attrs.schemaLocation})` : ""} is not among the given schemas; references into it are unresolved`,
            );
          }
          break;
        }
        case "include":
        case "redefine":
        case "override":
          diag(
            base,
            `xs:${c.local}${c.attrs.schemaLocation ? ` of ${c.attrs.schemaLocation}` : ""} is not followed`,
          );
          break;
        case "notation":
          diag(base, `xs:notation "${c.attrs.name ?? ""}" is not represented`);
          break;
        default:
          diag(base, `schema-level xs:${c.local} is not represented`);
      }
    }
  }

  // ---- def keys ------------------------------------------------------------
  const used = new Set<string>();
  const claim = (candidates: readonly string[]): string => {
    for (const c of candidates) {
      if (!used.has(c)) {
        used.add(c);
        return c;
      }
    }
    const last = candidates[candidates.length - 1]!;
    for (let n = 2; ; n++) {
      if (!used.has(`${last}${n}`)) {
        used.add(`${last}${n}`);
        return `${last}${n}`;
      }
    }
  };
  const localCount = new Map<string, number>();
  for (const e of typeEntries.values()) {
    localCount.set(e.name.local, (localCount.get(e.name.local) ?? 0) + 1);
  }
  for (const e of typeEntries.values()) {
    const q = `${nsToken(e.name.ns)}.${e.name.local}`;
    e.key = claim((localCount.get(e.name.local) ?? 0) > 1 ? [q] : [e.name.local, q]);
  }
  for (const e of elementEntries.values()) {
    if (kidOf(e.el, "complexType") !== undefined || kidOf(e.el, "simpleType") !== undefined) {
      e.key = claim([e.name.local, `${e.name.local}Element`]);
    }
  }

  // ---- lookups -------------------------------------------------------------
  const qn = (el: XmlElement, value: string, at: string): XsdName | undefined => {
    const name = resolveQName(el, value);
    if (name === undefined) diag(at, `"${value}" uses a namespace prefix that is not declared`);
    return name;
  };

  const unresolved = (at: string, what: string, name: XsdName): TypeRef => {
    diag(
      at,
      `${what} "{${name.ns}}${name.local}" is not declared in the given schemas; treated as unknown`,
    );
    return t(types.unknown, xsd({ unresolved: clark(name) }));
  };

  const typeRef = (name: XsdName, at: string): TypeRef => {
    if (name.ns === XSD_NS) {
      if (name.local === "anyType") return t(types.unknown, xsd({ builtin: "anyType" }));
      const make = BUILTINS[name.local];
      if (make !== undefined) return make();
      return unresolved(at, "built-in type", name);
    }
    const entry = typeEntries.get(clark(name));
    return entry === undefined ? unresolved(at, "type", name) : t(types.ref(entry.key!));
  };

  const docOf = (el: XmlElement, at: string): string | undefined => {
    const parts: string[] = [];
    for (const a of kidsOf(el, "annotation")) {
      for (const d of kidsOf(a, "documentation")) {
        const text = textContent(d).trim();
        if (text.length > 0) parts.push(text);
      }
      if (kidsOf(a, "appinfo").length > 0) diag(at, "xs:appinfo is not represented");
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  };

  const withDoc = (type: TypeRef, el: XmlElement, at: string): TypeRef => {
    const description = docOf(el, at);
    return description === undefined ? type : withMeta(type, { description });
  };

  const mergeXsd = (meta: Obj, extra: Obj): Obj =>
    Object.keys(extra).length === 0
      ? meta
      : { ...meta, xsd: { ...(isObj(meta.xsd) ? meta.xsd : {}), ...extra } };

  const withXsd = (type: TypeRef, extra: Obj): TypeRef =>
    Object.keys(extra).length === 0 ? type : t(type.shape, mergeXsd(type.meta, extra));

  // ---- memoised conversion ---------------------------------------------------
  const flatMemo = new Map<string, TypeRef>();
  const flatBusy = new Set<string>();
  const contentMemo = new Map<string, Content>();
  const contentBusy = new Set<string>();

  const isComplex = (e: Entry): boolean => e.el.local === "complexType";

  /** The simple type `name` with its restrictions applied, as a value (never a `ref`). */
  function flatSimple(name: XsdName, at: string): TypeRef {
    if (name.ns === XSD_NS) return typeRef(name, at);
    const entry = typeEntries.get(clark(name));
    if (entry === undefined) return unresolved(at, "type", name);
    if (isComplex(entry)) {
      const text = contentOf(entry).text;
      if (text !== undefined) return flattenSimple(text);
      diag(
        at,
        `"${name.local}" is a complex type without simple content where a simple type is required`,
      );
      return t(types.unknown);
    }
    const memo = flatMemo.get(entry.clark);
    if (memo !== undefined) return memo;
    if (flatBusy.has(entry.clark)) {
      diag(entry.at, "the simple type is defined in terms of itself; treated as unknown");
      return t(types.unknown);
    }
    flatBusy.add(entry.clark);
    const converted = convertSimple(entry.el, entry.at);
    flatBusy.delete(entry.clark);
    flatMemo.set(entry.clark, converted);
    return converted;
  }

  /** A `ref` to a named simple type resolved to its value; anything else unchanged. */
  function flattenSimple(type: TypeRef): TypeRef {
    if (type.shape.kind !== "ref") return type;
    const target = type.shape.target;
    const entry = [...typeEntries.values()].find((e) => e.key === target);
    if (entry === undefined || isComplex(entry)) return type;
    return flatSimple(entry.name, entry.at);
  }

  function readFacets(restriction: XmlElement): Facets {
    const f: Facets = { enumeration: [], pattern: [], assertions: [], other: {} };
    for (const c of restriction.children) {
      if (c.ns !== XSD_NS) continue;
      const value = c.attrs.value;
      switch (c.local) {
        case "enumeration":
          if (value !== undefined) f.enumeration.push(value);
          break;
        case "pattern":
          if (value !== undefined) f.pattern.push(value);
          break;
        case "assertion":
        case "assert":
          if (c.attrs.test !== undefined) f.assertions.push(c.attrs.test);
          break;
        case "length":
        case "minLength":
        case "maxLength":
        case "whiteSpace":
        case "minInclusive":
        case "maxInclusive":
        case "minExclusive":
        case "maxExclusive":
        case "totalDigits":
        case "fractionDigits":
        case "explicitTimezone":
          if (value !== undefined) f.other[c.local] = value;
          break;
      }
    }
    return f;
  }

  /** Datatypes §4.3: constrain `base` by `facets`. */
  function applyFacets(base: TypeRef, f: Facets, at: string): TypeRef {
    let shape = base.shape;
    const meta: Obj = { ...base.meta };
    const verbatim: Obj = {};
    const kind = shape.kind;
    const stringy = isKind(kind, "string");
    const numeric = isKind(kind, "number");
    const stringLike = stringy || kind === "enum";
    const baseBuiltin = isObj(base.meta.xsd)
      ? (base.meta.xsd.builtin as string | undefined)
      : undefined;
    const whiteSpace =
      f.other.whiteSpace ??
      (isObj(base.meta.xsd) ? (base.meta.xsd.whiteSpace as string | undefined) : undefined) ??
      (baseBuiltin !== undefined && COLLAPSING.has(baseBuiltin)
        ? "collapse"
        : kind === "string" || kind === "array"
          ? "preserve"
          : "collapse");
    const norm = (v: string): string =>
      whiteSpace === "collapse"
        ? collapse(v)
        : whiteSpace === "replace"
          ? v.replace(/[\t\n\r]/g, " ")
          : v;

    if (f.enumeration.length > 0) {
      const values = [...new Set(f.enumeration.map(norm))];
      if (numeric) {
        const nums = values.map((v) => Number(v));
        const integral = isKind(kind, "integer");
        if (nums.every((n) => (integral ? Number.isSafeInteger(n) : Number.isFinite(n)))) {
          shape = types.union(nums.map((n) => t(types.literal(n))));
        } else {
          verbatim.enumeration = values;
          diag(
            at,
            "enumeration values are not representable as numbers; kept verbatim under meta.xsd.enumeration",
          );
        }
      } else if (kind === "boolean") {
        const bools = values.map((v) =>
          v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : undefined,
        );
        if (bools.every((b) => b !== undefined)) {
          shape = types.union([...new Set(bools)].map((b) => t(types.literal(b as boolean))));
        } else verbatim.enumeration = values;
      } else if (kind === "array" || kind === "bytes") {
        verbatim.enumeration = values;
      } else {
        shape = types.enum(values);
      }
    }

    if (f.pattern.length > 0) {
      const problem = f.pattern.map(xsdRegexProblem).find((p) => p !== undefined);
      if (!stringLike || problem !== undefined) {
        verbatim.pattern = f.pattern.length === 1 ? f.pattern[0] : f.pattern;
        diag(
          at,
          !stringLike
            ? "a pattern on a non-string type constrains its lexical form; kept verbatim under meta.xsd.pattern"
            : `XSD pattern not translated (${problem}); kept verbatim under meta.xsd.pattern`,
        );
      } else {
        const body =
          f.pattern.length === 1 ? f.pattern[0]! : f.pattern.map((p) => `(?:${p})`).join("|");
        const anchored = `(?:${body})$`;
        meta.pattern =
          typeof meta.pattern === "string" ? `^(?=${meta.pattern})${anchored}` : `^${anchored}`;
      }
    }

    const lengthKeys: readonly [string, string] | undefined = stringLike
      ? ["minLength", "maxLength"]
      : kind === "array"
        ? ["minItems", "maxItems"]
        : undefined;
    for (const facet of ["length", "minLength", "maxLength"] as const) {
      const raw = f.other[facet];
      if (raw === undefined) continue;
      const n = Number(raw);
      if (lengthKeys === undefined || !Number.isInteger(n)) {
        verbatim[facet] = raw;
      } else if (facet === "length") {
        meta[lengthKeys[0]] = n;
        meta[lengthKeys[1]] = n;
      } else meta[facet === "minLength" ? lengthKeys[0] : lengthKeys[1]] = n;
    }
    const bounds = {
      minInclusive: "minimum",
      maxInclusive: "maximum",
      minExclusive: "exclusiveMinimum",
      maxExclusive: "exclusiveMaximum",
    } as const;
    for (const [facet, key] of Object.entries(bounds)) {
      const raw = f.other[facet];
      if (raw === undefined) continue;
      const n = Number(raw);
      if (numeric && Number.isFinite(n)) meta[key] = n;
      else verbatim[facet] = raw;
    }
    for (const facet of ["totalDigits", "fractionDigits", "whiteSpace", "explicitTimezone"]) {
      const raw = f.other[facet];
      if (raw === undefined) continue;
      const n = Number(raw);
      verbatim[facet] = facet.endsWith("Digits") && Number.isInteger(n) ? n : raw;
    }
    if (f.assertions.length > 0) {
      verbatim.assertions = f.assertions;
      diag(
        at,
        "assertions (XSD 1.1) are kept verbatim under meta.xsd.assertions and not evaluated",
      );
    }
    return t(shape, mergeXsd(meta, verbatim));
  }

  function convertSimple(el: XmlElement, at: string): TypeRef {
    const restriction = kidOf(el, "restriction");
    const list = kidOf(el, "list");
    const union = kidOf(el, "union");
    let out: TypeRef;
    if (restriction !== undefined) {
      const baseAttr = restriction.attrs.base;
      const inline = kidOf(restriction, "simpleType");
      let base: TypeRef;
      if (inline !== undefined) base = convertSimple(inline, `${at}/restriction/simpleType`);
      else if (baseAttr !== undefined) {
        const name = qn(restriction, baseAttr, at);
        base = name === undefined ? t(types.unknown) : flatSimple(name, at);
      } else {
        diag(at, "xs:restriction has no base; treated as unknown");
        base = t(types.unknown);
      }
      out = applyFacets(base, readFacets(restriction), at);
    } else if (list !== undefined) {
      const inline = kidOf(list, "simpleType");
      let item: TypeRef;
      if (inline !== undefined) item = convertSimple(inline, `${at}/list/simpleType`);
      else if (list.attrs.itemType !== undefined) {
        const name = qn(list, list.attrs.itemType, at);
        item = name === undefined ? t(types.unknown) : typeRef(name, at);
      } else {
        diag(at, "xs:list has no itemType; items treated as unknown");
        item = t(types.unknown);
      }
      out = t(types.array(item), xsd({ list: true }));
    } else if (union !== undefined) {
      const members: TypeRef[] = [];
      for (const raw of (union.attrs.memberTypes ?? "").split(/\s+/).filter((s) => s.length > 0)) {
        const name = qn(union, raw, at);
        members.push(name === undefined ? t(types.unknown) : typeRef(name, at));
      }
      for (const inline of kidsOf(union, "simpleType")) {
        members.push(convertSimple(inline, `${at}/union/simpleType`));
      }
      out = t(types.union(members));
    } else {
      diag(at, "xs:simpleType has no restriction, list or union; treated as string");
      out = t(types.string);
    }
    return withDoc(out, el, at);
  }

  // ---- element / attribute typing -------------------------------------------
  function defaultValue(type: TypeRef, raw: string): unknown {
    const kind = flattenSimple(type).shape.kind;
    if (isKind(kind, "number")) {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    if (kind === "boolean")
      return raw === "true" || raw === "1"
        ? true
        : raw === "false" || raw === "0"
          ? false
          : undefined;
    if (isKind(kind, "string") || kind === "enum" || kind === "datetime" || kind === "date")
      return raw;
    return undefined;
  }

  function applyDefaults(type: TypeRef, el: XmlElement): TypeRef {
    const extra: Obj = {};
    const meta: Obj = {};
    if (el.attrs.default !== undefined) {
      const v = defaultValue(type, el.attrs.default);
      if (v === undefined) extra.default = el.attrs.default;
      else meta.default = v;
    }
    if (el.attrs.fixed !== undefined) extra.fixed = el.attrs.fixed;
    return withXsd(Object.keys(meta).length > 0 ? withMeta(type, meta) : type, extra);
  }

  /** The type an element declaration (local or global) declares, without occurrence or nillable. */
  function declaredType(el: XmlElement, at: string, defKey?: string): TypeRef {
    if (defKey !== undefined) return t(types.ref(defKey));
    const inlineComplex = kidOf(el, "complexType");
    const inlineSimple = kidOf(el, "simpleType");
    if (inlineComplex !== undefined)
      return convertComplexInline(inlineComplex, `${at}/complexType`);
    if (inlineSimple !== undefined) return convertSimple(inlineSimple, `${at}/simpleType`);
    if (el.attrs.type !== undefined) {
      const name = qn(el, el.attrs.type, at);
      return name === undefined ? t(types.unknown) : typeRef(name, at);
    }
    return t(types.unknown, xsd({ builtin: "anyType" }));
  }

  const elementTypeMemo = new Map<string, TypeRef>();
  function elementValueType(entry: Entry): TypeRef {
    const memo = elementTypeMemo.get(entry.clark);
    if (memo !== undefined) return memo;
    let type = declaredType(entry.el, entry.at, entry.key);
    if (entry.el.attrs.nillable === "true") type = withMeta(type, { nullable: true });
    if (entry.key === undefined) type = withDoc(type, entry.el, entry.at);
    elementTypeMemo.set(entry.clark, type);
    return type;
  }

  function elementSpec(
    el: XmlElement,
    ctx: Ctx,
    at: string,
    choice?: number,
  ): FieldSpec | undefined {
    const { min, max } = occurs(el);
    if (max === 0) return undefined;
    let name: string;
    let type: TypeRef;
    let extra: Obj = {};
    if (el.attrs.ref !== undefined) {
      const ref = qn(el, el.attrs.ref, at);
      if (ref === undefined) return undefined;
      const entry = elementEntries.get(clark(ref));
      name = ref.local;
      if (entry === undefined) type = unresolved(at, "element", ref);
      else type = elementValueType(entry);
    } else if (el.attrs.name !== undefined) {
      name = el.attrs.name;
      at = `${at}/element[${name}]`;
      type = declaredType(el, at);
      if (el.attrs.nillable === "true") type = withMeta(type, { nullable: true });
      type = applyDefaults(withDoc(type, el, at), el);
    } else {
      diag(at, "an xs:element has neither name nor ref; skipped");
      return undefined;
    }
    if (el.attrs.abstract === "true") extra.abstract = true;
    if (el.attrs.substitutionGroup !== undefined) {
      extra.substitutionGroup = el.attrs.substitutionGroup;
      diag(at, "substitution group members are not expanded");
    }
    if (kidOf(el, "key") || kidOf(el, "keyref") || kidOf(el, "unique")) {
      diag(at, "identity constraints (key, keyref, unique) are not represented");
    }
    if (kidOf(el, "alternative")) diag(at, "type alternatives (XSD 1.1) are not represented");
    if (choice !== undefined) extra = { ...extra, choice };
    const many = max > 1 || ctx.repeated;
    if (many) {
      type = t(types.array(type), {
        ...(min > 1 ? { minItems: min } : {}),
        ...(Number.isFinite(max) && max > 1 && !ctx.repeated ? { maxItems: max } : {}),
      });
    }
    return {
      name,
      type,
      optional: ctx.optional || min === 0,
      ...(Object.keys(extra).length > 0 ? { xsd: extra } : {}),
    };
  }

  // ---- particles ---------------------------------------------------------------
  type Sink = {
    fields: Map<string, FieldSpec>;
    any?: Obj;
    nextChoice: number;
  };

  const addField = (sink: Sink, spec: FieldSpec, at: string): void => {
    const existing = sink.fields.get(spec.name);
    if (existing === undefined) {
      sink.fields.set(spec.name, spec);
      return;
    }
    const inner = (x: TypeRef): TypeRef => (x.shape.kind === "array" ? x.shape.element : x);
    if (JSON.stringify(inner(existing.type).shape) !== JSON.stringify(inner(spec.type).shape)) {
      diag(at, `element "${spec.name}" occurs twice with different types; the second is skipped`);
      return;
    }
    if (existing.type.shape.kind !== "array") {
      existing.type = t(types.array(existing.type), {});
    }
    existing.optional = existing.optional && spec.optional;
  };

  const wildcard = (el: XmlElement): Obj => ({
    namespace: el.attrs.namespace ?? "##any",
    processContents: el.attrs.processContents ?? "strict",
  });

  const groupBody = (ref: XmlElement, at: string): { body: XmlElement; at: string } | undefined => {
    const refName = ref.attrs.ref === undefined ? undefined : qn(ref, ref.attrs.ref, at);
    if (refName === undefined) {
      diag(at, "an xs:group reference has no usable ref; skipped");
      return undefined;
    }
    const entry = groupEntries.get(clark(refName));
    if (entry === undefined) {
      diag(at, `group "{${refName.ns}}${refName.local}" is not declared; skipped`);
      return undefined;
    }
    const body = ["sequence", "choice", "all"]
      .map((n) => kidOf(entry.el, n))
      .find((b) => b !== undefined);
    if (body === undefined) {
      diag(entry.at, "the group has no model group; skipped");
      return undefined;
    }
    return { body, at: entry.at };
  };

  const groupStack: string[] = [];

  function walkGroup(group: XmlElement, ctx: Ctx, sink: Sink, at: string, choice?: number): void {
    const { min, max } = occurs(group);
    let next = ctx;
    if (min === 0 && !ctx.optional) next = { ...next, optional: true };
    if (max > 1 && !ctx.repeated) {
      next = { ...next, repeated: true };
      diag(
        at,
        `repeated xs:${group.local}: its elements become per-element arrays and the grouping of instances is not kept`,
      );
    }
    let alt = choice;
    if (group.local === "choice") {
      alt = sink.nextChoice++;
      next = { ...next, optional: true };
      diag(
        at,
        "a choice that is not the whole content model becomes optional fields; exclusivity is not kept (meta.xsd.choice groups them)",
      );
    }
    for (const p of group.children) {
      if (p.ns !== XSD_NS) continue;
      switch (p.local) {
        case "element": {
          const spec = elementSpec(p, next, at, alt);
          if (spec !== undefined) addField(sink, spec, at);
          break;
        }
        case "sequence":
        case "choice":
        case "all":
          walkGroup(p, next, sink, `${at}/${p.local}`, alt);
          break;
        case "group": {
          const g = groupBody(p, `${at}/group`);
          if (g === undefined) break;
          if (groupStack.includes(g.at)) {
            diag(g.at, "the group contains itself; the inner reference is skipped");
            break;
          }
          groupStack.push(g.at);
          const { min: gmin, max: gmax } = occurs(p);
          let inner = next;
          if (gmin === 0) inner = { ...inner, optional: true };
          if (gmax > 1) inner = { ...inner, repeated: true };
          walkGroup(g.body, inner, sink, g.at, alt);
          groupStack.pop();
          break;
        }
        case "any":
          sink.any = wildcard(p);
          diag(at, "xs:any wildcard content is not represented as fields; kept under meta.xsd.any");
          break;
        case "annotation":
          break;
        default:
          diag(at, `xs:${p.local} inside a model group is not represented`);
      }
    }
  }

  /** The content model particle directly under `container` (a complexType, extension or restriction). */
  function readParticle(
    container: XmlElement,
    at: string,
  ): Pick<Content, "elements" | "variants" | "any"> {
    const direct = container.children.find(
      (c) => c.ns === XSD_NS && ["sequence", "choice", "all", "group"].includes(c.local),
    );
    if (direct === undefined) return { elements: [] };
    const sink: Sink = { fields: new Map(), nextChoice: 0 };
    const top =
      direct.local === "group"
        ? groupBody(direct, `${at}/group`)
        : { body: direct, at: `${at}/${direct.local}` };
    if (top === undefined) return { elements: [] };
    const outer = occurs(direct);
    const inner = occurs(top.body);
    let variants: FieldSpec[][] | undefined;
    const ctx: Ctx = { optional: false, repeated: false };
    if (top.body.local === "choice" && outer.max === 1 && inner.max === 1) {
      variants = [];
      for (const alt of top.body.children) {
        if (alt.ns !== XSD_NS || alt.local === "annotation") continue;
        const one: Sink = { fields: new Map(), nextChoice: 0 };
        const holder: XmlElement = {
          ...top.body,
          name: "xs:sequence",
          local: "sequence",
          children: [alt],
          attrs: {},
        };
        walkGroup(holder, ctx, one, top.at);
        variants.push([...one.fields.values()]);
      }
      if (Math.min(outer.min, inner.min) === 0) variants.push([]);
      if (variants.length === 0) variants = undefined;
      // The flattened view serves derivations only; every problem in it was
      // already reported by the per-alternative walks above.
      const saved = diagnostics.length;
      walkGroup(top.body, { optional: outer.min === 0, repeated: false }, sink, top.at);
      diagnostics.length = saved;
    } else if (direct.local === "group") {
      const holder: XmlElement = {
        ...top.body,
        attrs: {
          ...top.body.attrs,
          minOccurs: String(outer.min),
          maxOccurs: outer.max === Number.POSITIVE_INFINITY ? "unbounded" : String(outer.max),
        },
      };
      walkGroup(holder, ctx, sink, top.at);
    } else walkGroup(top.body, ctx, sink, top.at);
    return {
      elements: [...sink.fields.values()],
      ...(variants !== undefined ? { variants } : {}),
      ...(sink.any !== undefined ? { any: sink.any } : {}),
    };
  }

  // ---- attributes ------------------------------------------------------------------
  const attrGroupStack: string[] = [];

  type AttrSink = { specs: FieldSpec[]; prohibited: Set<string>; any?: Obj };

  function attributeSpecs(container: XmlElement, at: string, out: AttrSink): void {
    for (const a of container.children) {
      if (a.ns !== XSD_NS) continue;
      if (a.local === "attribute") {
        let name: string;
        let type: TypeRef;
        let declEl = a;
        if (a.attrs.ref !== undefined) {
          const ref = qn(a, a.attrs.ref, at);
          if (ref === undefined) continue;
          const entry = attributeEntries.get(clark(ref));
          name = ref.local;
          if (entry === undefined) {
            type = unresolved(at, "attribute", ref);
          } else {
            declEl = entry.el;
            type = withDoc(attributeType(entry.el, entry.at), entry.el, entry.at);
          }
        } else if (a.attrs.name !== undefined) {
          name = a.attrs.name;
          type = withDoc(
            attributeType(a, `${at}/attribute[${name}]`),
            a,
            `${at}/attribute[${name}]`,
          );
        } else {
          diag(at, "an xs:attribute has neither name nor ref; skipped");
          continue;
        }
        if (a.attrs.use === "prohibited") {
          out.prohibited.add(name);
          continue;
        }
        const withDefaults = applyDefaults(
          type,
          a.attrs.default !== undefined || a.attrs.fixed !== undefined ? a : declEl,
        );
        out.specs.push({
          name,
          type: withDefaults,
          optional: a.attrs.use !== "required",
          xsd: { attribute: true },
        });
      } else if (a.local === "attributeGroup") {
        const ref = a.attrs.ref === undefined ? undefined : qn(a, a.attrs.ref, at);
        if (ref === undefined) continue;
        const entry = attributeGroupEntries.get(clark(ref));
        if (entry === undefined) {
          diag(at, `attribute group "{${ref.ns}}${ref.local}" is not declared; skipped`);
          continue;
        }
        if (attrGroupStack.includes(entry.clark)) {
          diag(entry.at, "the attribute group contains itself; the inner reference is skipped");
          continue;
        }
        attrGroupStack.push(entry.clark);
        attributeSpecs(entry.el, entry.at, out);
        attrGroupStack.pop();
      } else if (a.local === "anyAttribute") {
        out.any = wildcard(a);
        diag(at, "xs:anyAttribute is not represented as fields; kept under meta.xsd.anyAttribute");
      }
    }
  }

  function attributeType(el: XmlElement, at: string): TypeRef {
    const inline = kidOf(el, "simpleType");
    if (inline !== undefined) return convertSimple(inline, `${at}/simpleType`);
    if (el.attrs.type !== undefined) {
      const name = qn(el, el.attrs.type, at);
      return name === undefined ? t(types.unknown) : typeRef(name, at);
    }
    return str("anySimpleType");
  }

  const mergeAttributes = (
    base: FieldSpec[],
    own: FieldSpec[],
    prohibited: ReadonlySet<string>,
  ): FieldSpec[] => {
    const byName = new Map(
      base.filter((s) => !prohibited.has(s.name)).map((s) => [s.name, s] as const),
    );
    for (const s of own) byName.set(s.name, s);
    return [...byName.values()];
  };

  // ---- complex types ---------------------------------------------------------------
  function emptyContent(): Content {
    return { elements: [], attributes: [], mixed: false };
  }

  function contentOfEl(el: XmlElement, at: string): Content {
    const mixedAttr = el.attrs.mixed === "true";
    const attrs: AttrSink = { specs: [], prohibited: new Set() };
    const simple = kidOf(el, "simpleContent");
    const complex = kidOf(el, "complexContent");
    let content: Content;
    if (simple !== undefined) {
      const deriv = kidOf(simple, "extension") ?? kidOf(simple, "restriction");
      if (deriv === undefined || deriv.attrs.base === undefined) {
        diag(at, "xs:simpleContent has no extension or restriction with a base; treated as empty");
        content = emptyContent();
      } else {
        const dat = `${at}/simpleContent/${deriv.local}`;
        const base = qn(deriv, deriv.attrs.base, dat);
        const baseEntry =
          base === undefined || base.ns === XSD_NS ? undefined : typeEntries.get(clark(base));
        const baseContent =
          baseEntry !== undefined && isComplex(baseEntry) ? contentOf(baseEntry) : undefined;
        let text: TypeRef;
        if (base === undefined) text = t(types.unknown);
        else if (deriv.local === "extension") {
          text = baseContent?.text ?? typeRef(base, dat);
        } else {
          const inline = kidOf(deriv, "simpleType");
          const flat =
            inline !== undefined
              ? convertSimple(inline, dat)
              : baseContent?.text !== undefined
                ? flattenSimple(baseContent.text)
                : flatSimple(base, dat);
          text = applyFacets(flat, readFacets(deriv), dat);
        }
        attributeSpecs(deriv, dat, attrs);
        content = {
          elements: [],
          attributes: mergeAttributes(baseContent?.attributes ?? [], attrs.specs, attrs.prohibited),
          text,
          mixed: false,
          ...(baseEntry !== undefined ? { extendsKey: baseEntry.key! } : {}),
        };
      }
    } else if (complex !== undefined) {
      const deriv = kidOf(complex, "extension") ?? kidOf(complex, "restriction");
      if (deriv === undefined || deriv.attrs.base === undefined) {
        diag(at, "xs:complexContent has no extension or restriction with a base; treated as empty");
        content = emptyContent();
      } else {
        const dat = `${at}/complexContent/${deriv.local}`;
        const base = qn(deriv, deriv.attrs.base, dat);
        let baseContent = emptyContent();
        let extendsKey: string | undefined;
        if (base !== undefined && !(base.ns === XSD_NS && base.local === "anyType")) {
          const baseEntry = typeEntries.get(clark(base));
          if (baseEntry === undefined || !isComplex(baseEntry)) {
            unresolved(dat, "base type", base);
          } else {
            baseContent = contentOf(baseEntry);
            extendsKey = baseEntry.key!;
          }
        }
        const own = readParticle(deriv, dat);
        attributeSpecs(deriv, dat, attrs);
        const mixed = mixedAttr || complex.attrs.mixed === "true" || baseContent.mixed;
        const anyAttribute = attrs.any ?? baseContent.anyAttribute;
        if (deriv.local === "extension") {
          const keepVariants = own.elements.length === 0 && baseContent.variants !== undefined;
          if (baseContent.variants !== undefined && !keepVariants) {
            diag(
              dat,
              "the base type's content is a choice and this extension adds content; the alternatives become optional fields, exclusivity is not kept",
            );
          }
          const merged = new Map<string, FieldSpec>();
          for (const s of [...baseContent.elements, ...own.elements]) merged.set(s.name, s);
          const any = own.any ?? baseContent.any;
          content = {
            elements: [...merged.values()],
            attributes: mergeAttributes(baseContent.attributes, attrs.specs, attrs.prohibited),
            ...(keepVariants ? { variants: baseContent.variants! } : {}),
            ...(baseContent.text !== undefined ? { text: baseContent.text } : {}),
            mixed,
            ...(any !== undefined ? { any } : {}),
            ...(anyAttribute !== undefined ? { anyAttribute } : {}),
          };
        } else {
          content = {
            elements: own.elements,
            attributes: mergeAttributes(baseContent.attributes, attrs.specs, attrs.prohibited),
            ...(own.variants !== undefined ? { variants: own.variants } : {}),
            mixed,
            ...(own.any !== undefined ? { any: own.any } : {}),
            ...(anyAttribute !== undefined ? { anyAttribute } : {}),
          };
        }
        if (extendsKey !== undefined) content.extendsKey = extendsKey;
      }
    } else {
      const particle = readParticle(el, at);
      attributeSpecs(el, at, attrs);
      content = {
        elements: particle.elements,
        attributes: mergeAttributes([], attrs.specs, attrs.prohibited),
        ...(particle.variants !== undefined ? { variants: particle.variants } : {}),
        mixed: mixedAttr,
        ...(particle.any !== undefined ? { any: particle.any } : {}),
        ...(attrs.any !== undefined ? { anyAttribute: attrs.any } : {}),
      };
    }
    const description = docOf(el, at);
    if (description !== undefined) content.description = description;
    if (content.mixed) {
      diag(
        at,
        "mixed content: the interleaved text is not represented; meta.xsd.mixed marks the type",
      );
    }
    return content;
  }

  function contentOf(entry: Entry): Content {
    const memo = contentMemo.get(entry.clark);
    if (memo !== undefined) return memo;
    if (contentBusy.has(entry.clark)) {
      diag(entry.at, "the type is derived from itself; treated as empty");
      return emptyContent();
    }
    contentBusy.add(entry.clark);
    const content = contentOfEl(entry.el, entry.at);
    contentBusy.delete(entry.clark);
    contentMemo.set(entry.clark, content);
    return content;
  }

  const fieldType = (spec: FieldSpec): TypeRef => {
    let type = spec.type;
    if (spec.optional) type = withMeta(type, { optional: true });
    return spec.xsd === undefined ? type : t(type.shape, mergeXsd(type.meta, spec.xsd));
  };

  /** Lay `specs` out as one object's fields, renaming clashes with an earlier field. */
  function objectFields(
    specs: readonly FieldSpec[],
    into: Record<string, TypeRef>,
    at: string,
    sigil: string,
  ): void {
    for (const spec of specs) {
      let name = spec.name;
      if (name in into) {
        name = `${sigil}${name}`;
        diag(
          at,
          `"${spec.name}" is declared both as an element and an attribute; the attribute is named "${name}"`,
        );
      }
      if (name in into) {
        diag(at, `"${name}" is declared more than once; the later one is skipped`);
        continue;
      }
      into[name] = fieldType(spec);
    }
  }

  function contentType(content: Content, at: string): TypeRef {
    const meta: Obj = {};
    if (content.description !== undefined) meta.description = content.description;
    const extra: Obj = {};
    if (content.mixed) extra.mixed = true;
    if (content.any !== undefined) extra.any = content.any;
    if (content.anyAttribute !== undefined) extra.anyAttribute = content.anyAttribute;
    if (content.extendsKey !== undefined) extra.extends = content.extendsKey;
    const finish = (type: TypeRef): TypeRef => withXsd(withMeta(type, meta), extra);
    if (content.text !== undefined) {
      if (content.attributes.length === 0) return finish(content.text);
      const fields: Record<string, TypeRef> = {};
      const attrSpecs = content.attributes;
      const valueName = attrSpecs.some((a) => a.name === "value") ? "$value" : "value";
      if (valueName === "$value") {
        diag(at, 'an attribute is named "value"; the text content is field "$value"');
      }
      fields[valueName] = withXsd(content.text, { text: true });
      objectFields(attrSpecs, fields, at, "@");
      return finish(t(types.object(fields)));
    }
    if (content.variants !== undefined) {
      const variants = content.variants.map((v) => {
        const fields: Record<string, TypeRef> = {};
        objectFields(v, fields, at, "@");
        objectFields(content.attributes, fields, at, "@");
        return t(types.object(fields));
      });
      return finish(t(types.union(variants)));
    }
    const fields: Record<string, TypeRef> = {};
    objectFields(content.elements, fields, at, "@");
    objectFields(content.attributes, fields, at, "@");
    return finish(t(types.object(fields)));
  }

  function convertComplexInline(el: XmlElement, at: string): TypeRef {
    return contentType(contentOfEl(el, at), at);
  }

  function convertComplexNamed(entry: Entry): TypeRef {
    return contentType(contentOf(entry), entry.at);
  }

  // ---- assemble ---------------------------------------------------------------------
  const defs: Record<string, TypeRef> = {};
  const keys: Record<string, string> = {};
  for (const entry of typeEntries.values()) {
    const converted = isComplex(entry)
      ? convertComplexNamed(entry)
      : flatSimple(entry.name, entry.at);
    defs[entry.key!] = withMeta(
      withXsd(converted, { namespace: entry.name.ns, name: entry.name.local }),
      { typeName: entry.key },
    );
    keys[entry.clark] = entry.key!;
  }
  for (const entry of elementEntries.values()) {
    if (entry.key === undefined) continue;
    const el = entry.el;
    const inlineComplex = kidOf(el, "complexType");
    const inlineSimple = kidOf(el, "simpleType");
    const type =
      inlineComplex !== undefined
        ? convertComplexInline(inlineComplex, `${entry.at}/complexType`)
        : convertSimple(inlineSimple!, `${entry.at}/simpleType`);
    defs[entry.key] = withMeta(
      withXsd(withDoc(type, el, entry.at), { namespace: entry.name.ns, element: entry.name.local }),
      { typeName: entry.key },
    );
    if (el.attrs.abstract === "true") {
      defs[entry.key] = withXsd(defs[entry.key]!, { abstract: true });
    }
  }
  for (const entry of typeEntries.values()) {
    if (entry.el.attrs.abstract === "true") {
      defs[entry.key!] = withXsd(defs[entry.key!]!, { abstract: true });
    }
    if (entry.el.local === "complexType" && (kidOf(entry.el, "assert") ?? undefined)) {
      diag(entry.at, "assertions (XSD 1.1) are not represented");
    }
  }
  for (const entry of elementEntries.values()) {
    if (kidOf(entry.el, "key") || kidOf(entry.el, "keyref") || kidOf(entry.el, "unique")) {
      diag(entry.at, "identity constraints (key, keyref, unique) are not represented");
    }
  }

  return {
    defs,
    keys,
    diagnostics,
    element: (name) => {
      const entry = elementEntries.get(clark(name));
      return entry === undefined ? undefined : elementValueType(entry);
    },
    type: (name) => {
      if (name.ns === XSD_NS) {
        if (name.local === "anyType" || BUILTINS[name.local] !== undefined)
          return typeRef(name, "");
        return undefined;
      }
      const entry = typeEntries.get(clark(name));
      return entry === undefined ? undefined : t(types.ref(entry.key!));
    },
  };
}
