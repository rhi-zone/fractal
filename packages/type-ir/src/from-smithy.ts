// Smithy 2.0 JSON AST (the `smithy build` "model" projection output) ->
// TypeRef. Data shapes only: simple shapes, list/set/map, structure, union,
// enum, intEnum. Service, resource and operation shapes are not types; the
// API-level importer (api-tree's from-smithy.ts) reads them straight from the
// model and uses this module for every type they mention.
//
// Naming: every data shape becomes a named entry in `defs` and every member
// target that is not a prelude shape becomes `{ kind: "ref", target }`. A def
// is keyed by its bare shape name, or by `namespace.Name` when two namespaces
// declare the same bare name (a Smithy shape id's `#` is not usable in
// `#/$defs/...` pointers). `keys` maps each absolute shape id to its def key.
//
// Members: a structure member is an object field named exactly as the member;
// it is `meta.optional` unless it carries `@required`. `@jsonName` is kept as
// `meta.jsonName` (the field key stays the member name).
//
// Unions: a Smithy union is tagged, so each variant is an object with exactly
// one required field named after the member (`{ "tag": value }`, the JSON
// shape of restJson1/awsJson).
//
// Traits: the ones with a type-ir meta equivalent are mapped (documentation,
// title, deprecated, default, length, range, pattern, jsonName, uniqueItems,
// sparse); every other trait is kept verbatim under
// `meta.smithy.traits[traitShapeId]`. `@timestampFormat` is one of those: a
// timestamp is the domain type `datetime`, its wire format is a protocol
// concern.
//
// Spec references: Smithy 2.0 specification: JSON AST (§ "JSON AST"), Shapes
// (§ "Simple types", "Aggregate types", "Enum", "IntEnum", "Mixins"),
// Prelude (smithy.api# shapes), and the traits @required, @default,
// @documentation, @title, @deprecated, @jsonName, @length, @range, @pattern,
// @sparse, @uniqueItems, @enumValue, @enum (1.0 model form), @trait, @mixin.

import { t, types, type TypeRef } from "./index.ts";
import { bytes, datetime, float32, float64, int16, int32, int64, int8 } from "./kinds/common.ts";

export type SmithyTraits = Readonly<Record<string, unknown>>;

export type SmithyMember = {
  readonly target: string;
  readonly traits?: SmithyTraits;
};

export type SmithyShape = {
  readonly type: string;
  readonly traits?: SmithyTraits;
  readonly members?: Readonly<Record<string, SmithyMember>>;
  readonly member?: SmithyMember;
  readonly key?: SmithyMember;
  readonly value?: SmithyMember;
  readonly mixins?: readonly { readonly target: string }[];
  readonly [other: string]: unknown;
};

export type SmithyModel = {
  readonly smithy?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly shapes?: Readonly<Record<string, SmithyShape>>;
};

/** Something in the model that could not be represented faithfully. `at` is an absolute shape id (`ns#Shape`, or `ns#Shape$member`). */
export type SmithyDiagnostic = { readonly at: string; readonly message: string };

export type SmithyTypes = {
  /** Every data shape, keyed by its def key (see `keys`). */
  readonly defs: Readonly<Record<string, TypeRef>>;
  /** Absolute shape id -> def key, for every shape in `defs`. */
  readonly keys: Readonly<Record<string, string>>;
  readonly diagnostics: readonly SmithyDiagnostic[];
  /** The shape with this id, or `undefined` if the model has none (prelude shapes are not in the model). */
  shape(id: string): SmithyShape | undefined;
  /** The Smithy shape type of `id` (`"structure"`, `"string"`, ...), prelude shapes included. */
  typeOf(id: string): string | undefined;
  /** A structure/union/enum's members with mixin members resolved: mixin members first (in mixin order), then local ones, with a local member's traits layered over the inherited one. */
  members(id: string): Readonly<Record<string, SmithyMember>>;
  /** A member as a type: its target (inline for prelude shapes, else a `ref`) with the member's trait meta applied. */
  memberType(member: SmithyMember, at: string): TypeRef;
  /** A structure's members as named object fields (`optional` unless `@required`). */
  fields(id: string): Record<string, TypeRef>;
};

export const SMITHY_PRELUDE = "smithy.api#";

const TRAIT = {
  required: `${SMITHY_PRELUDE}required`,
  default: `${SMITHY_PRELUDE}default`,
  documentation: `${SMITHY_PRELUDE}documentation`,
  title: `${SMITHY_PRELUDE}title`,
  deprecated: `${SMITHY_PRELUDE}deprecated`,
  jsonName: `${SMITHY_PRELUDE}jsonName`,
  length: `${SMITHY_PRELUDE}length`,
  range: `${SMITHY_PRELUDE}range`,
  pattern: `${SMITHY_PRELUDE}pattern`,
  sparse: `${SMITHY_PRELUDE}sparse`,
  uniqueItems: `${SMITHY_PRELUDE}uniqueItems`,
  enumValue: `${SMITHY_PRELUDE}enumValue`,
  enum: `${SMITHY_PRELUDE}enum`,
  trait: `${SMITHY_PRELUDE}trait`,
  mixin: `${SMITHY_PRELUDE}mixin`,
  input: `${SMITHY_PRELUDE}input`,
  output: `${SMITHY_PRELUDE}output`,
} as const;

// Traits that are structural markers or are applied by the aggregate's own
// converter, so they never appear in `meta.smithy.traits`.
const STRUCTURAL: ReadonlySet<string> = new Set([
  TRAIT.required,
  TRAIT.sparse,
  TRAIT.enumValue,
  TRAIT.enum,
  TRAIT.mixin,
  TRAIT.input,
  TRAIT.output,
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const withMeta = (ref: TypeRef, extra: Obj): TypeRef =>
  Object.keys(extra).length === 0 ? ref : { shape: ref.shape, meta: { ...ref.meta, ...extra } };

// Prelude shapes usable as member targets. `Primitive*` are the pre-2.0 spellings of the same types with a zero default.
const PRELUDE: Readonly<Record<string, { type: string; make: () => TypeRef }>> = {
  String: { type: "string", make: () => t(types.string) },
  Blob: { type: "blob", make: () => bytes() },
  Boolean: { type: "boolean", make: () => t(types.boolean) },
  PrimitiveBoolean: { type: "boolean", make: () => t(types.boolean) },
  Byte: { type: "byte", make: () => int8() },
  PrimitiveByte: { type: "byte", make: () => int8() },
  Short: { type: "short", make: () => int16() },
  PrimitiveShort: { type: "short", make: () => int16() },
  Integer: { type: "integer", make: () => int32() },
  PrimitiveInteger: { type: "integer", make: () => int32() },
  Long: { type: "long", make: () => int64() },
  PrimitiveLong: { type: "long", make: () => int64() },
  Float: { type: "float", make: () => float32() },
  PrimitiveFloat: { type: "float", make: () => float32() },
  Double: { type: "double", make: () => float64() },
  PrimitiveDouble: { type: "double", make: () => float64() },
  BigInteger: { type: "bigInteger", make: () => t(types.integer, { format: "bigint" }) },
  BigDecimal: { type: "bigDecimal", make: () => t(types.number, { format: "bigdecimal" }) },
  Timestamp: { type: "timestamp", make: () => datetime() },
  Document: { type: "document", make: () => t(types.unknown) },
  Unit: { type: "structure", make: () => t(types.object({})) },
};

const preludeEntry = (id: string): { type: string; make: () => TypeRef } | undefined =>
  id.startsWith(SMITHY_PRELUDE) ? PRELUDE[id.slice(SMITHY_PRELUDE.length)] : undefined;

const SIMPLE: Readonly<Record<string, () => TypeRef>> = {
  string: () => t(types.string),
  blob: () => bytes(),
  boolean: () => t(types.boolean),
  byte: () => int8(),
  short: () => int16(),
  integer: () => int32(),
  long: () => int64(),
  float: () => float32(),
  double: () => float64(),
  bigInteger: () => t(types.integer, { format: "bigint" }),
  bigDecimal: () => t(types.number, { format: "bigdecimal" }),
  timestamp: () => datetime(),
  document: () => t(types.unknown),
};

const NOT_DATA: ReadonlySet<string> = new Set(["service", "resource", "operation"]);

type LengthKind = "string" | "list" | "map" | "number" | "other";

const lengthKindOf = (smithyType: string | undefined): LengthKind => {
  switch (smithyType) {
    case "string":
    case "enum":
    case "blob":
      return "string";
    case "list":
    case "set":
      return "list";
    case "map":
      return "map";
    case "byte":
    case "short":
    case "integer":
    case "long":
    case "float":
    case "double":
    case "bigInteger":
    case "bigDecimal":
    case "intEnum":
      return "number";
    default:
      return "other";
  }
};

const LENGTH_KEYS: Record<LengthKind, readonly [string, string] | undefined> = {
  string: ["minLength", "maxLength"],
  list: ["minItems", "maxItems"],
  map: ["minProperties", "maxProperties"],
  number: undefined,
  other: undefined,
};

/** `meta` for a shape's or member's traits, with every trait that has no mapped equivalent kept verbatim under `meta.smithy.traits`. `extra` traits are consumed by the caller. */
function traitMeta(
  traits: SmithyTraits | undefined,
  kind: LengthKind,
  extra: ReadonlySet<string> = new Set(),
): Obj {
  const meta: Obj = {};
  const smithy: Obj = {};
  const rest: Obj = {};
  for (const [id, value] of Object.entries(traits ?? {})) {
    if (STRUCTURAL.has(id) || extra.has(id)) continue;
    switch (id) {
      case TRAIT.documentation:
        if (typeof value === "string") meta.description = value;
        else rest[id] = value;
        break;
      case TRAIT.title:
        if (typeof value === "string") meta.title = value;
        else rest[id] = value;
        break;
      case TRAIT.deprecated:
        meta.deprecated = true;
        if (isObj(value) && typeof value.message === "string")
          meta.deprecatedReason = value.message;
        if (isObj(value) && typeof value.since === "string") smithy.deprecatedSince = value.since;
        break;
      case TRAIT.jsonName:
        if (typeof value === "string") meta.jsonName = value;
        else rest[id] = value;
        break;
      case TRAIT.default:
        if (value === null) rest[id] = value;
        else meta.default = value;
        break;
      case TRAIT.pattern:
        if (typeof value === "string") meta.pattern = value;
        else rest[id] = value;
        break;
      case TRAIT.uniqueItems:
        meta.uniqueItems = true;
        break;
      case TRAIT.length: {
        const keys = LENGTH_KEYS[kind];
        if (keys === undefined || !isObj(value)) {
          rest[id] = value;
          break;
        }
        if (typeof value.min === "number") meta[keys[0]] = value.min;
        if (typeof value.max === "number") meta[keys[1]] = value.max;
        break;
      }
      case TRAIT.range:
        if (kind !== "number" || !isObj(value)) {
          rest[id] = value;
          break;
        }
        if (typeof value.min === "number") meta.minimum = value.min;
        if (typeof value.max === "number") meta.maximum = value.max;
        break;
      default:
        rest[id] = value;
    }
  }
  if (Object.keys(rest).length > 0) smithy.traits = rest;
  if (Object.keys(smithy).length > 0) meta.smithy = smithy;
  return meta;
}

const mergeSmithy = (meta: Obj, extra: Obj): Obj => {
  if (Object.keys(extra).length === 0) return meta;
  return { ...meta, smithy: { ...(isObj(meta.smithy) ? meta.smithy : {}), ...extra } };
};

/** The bare name of an absolute shape id (`ns#Name` -> `Name`). */
export const smithyShapeName = (id: string): string => id.slice(id.indexOf("#") + 1);

export function fromSmithy(model: SmithyModel): SmithyTypes {
  const shapes = model.shapes ?? {};
  const diagnostics: SmithyDiagnostic[] = [];

  const isData = (shape: SmithyShape): boolean =>
    !NOT_DATA.has(shape.type) && shape.traits?.[TRAIT.trait] === undefined;

  const dataIds = Object.keys(shapes).filter((id) => isData(shapes[id]!));
  const bareCount = new Map<string, number>();
  for (const id of dataIds) {
    const bare = smithyShapeName(id);
    bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
  }
  const keys: Record<string, string> = {};
  for (const id of dataIds) {
    const bare = smithyShapeName(id);
    keys[id] = (bareCount.get(bare) ?? 0) > 1 ? id.replace("#", ".") : bare;
  }

  const typeOf = (id: string): string | undefined => shapes[id]?.type ?? preludeEntry(id)?.type;

  const members = (
    id: string,
    seen: ReadonlySet<string> = new Set(),
  ): Record<string, SmithyMember> => {
    const shape = shapes[id];
    const out: Record<string, SmithyMember> = {};
    if (shape === undefined || seen.has(id)) return out;
    const nextSeen = new Set(seen).add(id);
    for (const mixin of shape.mixins ?? []) Object.assign(out, members(mixin.target, nextSeen));
    for (const [name, local] of Object.entries(shape.members ?? {})) {
      const inherited = out[name];
      out[name] =
        inherited === undefined
          ? local
          : {
              target: local.target,
              traits: { ...inherited.traits, ...local.traits },
            };
    }
    return out;
  };

  const targetType = (target: string, at: string): TypeRef => {
    const prelude = preludeEntry(target);
    if (prelude !== undefined) return prelude.make();
    const key = keys[target];
    if (key !== undefined) return t(types.ref(key));
    diagnostics.push({ at, message: `target "${target}" is not a data shape in the model` });
    return t(types.ref(smithyShapeName(target)));
  };

  const memberType = (member: SmithyMember, at: string): TypeRef =>
    withMeta(
      targetType(member.target, at),
      traitMeta(member.traits, lengthKindOf(typeOf(member.target))),
    );

  const fields = (id: string): Record<string, TypeRef> => {
    const out: Record<string, TypeRef> = {};
    for (const [name, member] of Object.entries(members(id))) {
      const ref = memberType(member, `${id}$${name}`);
      out[name] =
        member.traits?.[TRAIT.required] === undefined ? withMeta(ref, { optional: true }) : ref;
    }
    return out;
  };

  const element = (member: SmithyMember, sparse: boolean, at: string): TypeRef => {
    const ref = memberType(member, at);
    return sparse ? withMeta(ref, { nullable: true }) : ref;
  };

  const convert = (id: string, shape: SmithyShape): TypeRef | undefined => {
    const traits = shape.traits;
    const kind = lengthKindOf(shape.type);
    const meta = mergeSmithy(traitMeta(traits, kind), { id });
    const simple = SIMPLE[shape.type];
    if (simple !== undefined) {
      const legacyEnum = shape.type === "string" ? traits?.[TRAIT.enum] : undefined;
      if (Array.isArray(legacyEnum)) {
        const entries = legacyEnum.filter(
          (e): e is Obj & { value: string } => isObj(e) && typeof e.value === "string",
        );
        const named = entries.filter((e) => typeof e.name === "string");
        return t(
          types.enum(entries.map((e) => e.value)),
          named.length > 0
            ? mergeSmithy(meta, {
                enumMembers: Object.fromEntries(named.map((e) => [e.name as string, e.value])),
              })
            : meta,
        );
      }
      return withMeta(simple(), meta);
    }
    switch (shape.type) {
      case "list":
      case "set": {
        if (shape.member === undefined) break;
        const sparse = traits?.[TRAIT.sparse] !== undefined;
        return t(
          types.array(element(shape.member, sparse, `${id}$member`)),
          shape.type === "set" ? { ...meta, uniqueItems: true } : meta,
        );
      }
      case "map": {
        if (shape.key === undefined || shape.value === undefined) break;
        const sparse = traits?.[TRAIT.sparse] !== undefined;
        return t(
          types.map(
            memberType(shape.key, `${id}$key`),
            element(shape.value, sparse, `${id}$value`),
          ),
          meta,
        );
      }
      case "structure":
        return t(types.object(fields(id)), meta);
      case "union": {
        const variants = Object.entries(members(id)).map(([name, member]) =>
          t(types.object({ [name]: memberType(member, `${id}$${name}`) })),
        );
        return t(types.union(variants), meta);
      }
      case "enum": {
        const entries = Object.entries(members(id));
        const values = entries.map(([name, m]) => {
          const v = m.traits?.[TRAIT.enumValue];
          return typeof v === "string" ? v : name;
        });
        const details: Obj = {};
        entries.forEach(([name, m], i) => {
          const info = traitMeta(m.traits, "other");
          if (values[i] !== name || Object.keys(info).length > 0) {
            details[name] = { value: values[i], ...info };
          }
        });
        return t(
          types.enum(values),
          Object.keys(details).length > 0 ? mergeSmithy(meta, { enumMembers: details }) : meta,
        );
      }
      case "intEnum": {
        const variants: TypeRef[] = [];
        for (const [name, m] of Object.entries(members(id))) {
          const v = m.traits?.[TRAIT.enumValue];
          if (typeof v !== "number") {
            diagnostics.push({
              at: `${id}$${name}`,
              message: "intEnum member has no integer @enumValue; skipped",
            });
            continue;
          }
          variants.push(t(types.literal(v), mergeSmithy(traitMeta(m.traits, "other"), { name })));
        }
        return t(types.union(variants), meta);
      }
    }
    diagnostics.push({ at: id, message: `shape type "${shape.type}" could not be converted` });
    return undefined;
  };

  const defs: Record<string, TypeRef> = {};
  for (const id of dataIds) {
    const ref = convert(id, shapes[id]!);
    if (ref !== undefined) defs[keys[id]!] = withMeta(ref, { typeName: keys[id] });
  }

  return {
    defs,
    keys,
    diagnostics,
    shape: (id) => shapes[id],
    typeOf,
    members: (id) => members(id),
    memberType,
    fields,
  };
}
