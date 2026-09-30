// GraphQL SDL (a type-system document) -> ApiDescription.
//
// Operations: every field of a root operation type (Query, Mutation,
// Subscription) is one operation. Root types are those a `schema { ... }`
// definition (plus any `extend schema`) names; a document with no schema
// definition uses the types named Query, Mutation and Subscription where
// declared (GraphQL spec, October 2021, § "Root Operation Types", § "Schema
// Extension").
//
// Addressing: an operation's address is `[fieldName]`, the shape the graphql
// projector reads back as a root field of the matching operation type
// (`meta.graphql.operation` picks the type, `meta.graphql.name` is the exact
// field name). Root fields of different operation types may share a name
// (§ "Objects" only constrains names within one type) but addresses may not,
// so a name already taken by an earlier operation (Query first, then Mutation,
// then Subscription) is addressed `[operationType, fieldName]`; the exact name
// still lives in `meta.graphql.name`, so it projects back under the same name.
//
// Input: the field's arguments (§ "Field Arguments"), one named param each.
// A nullable argument is also `optional`, since it may be omitted.
//
// Output: the field's return type; a Subscription field's is a `stream` of it
// (§ "Subscription").
//
// Meta: `readOnly` on queries, `streaming` on subscriptions, `deprecated` from
// `@deprecated` (§ "@deprecated") with its `reason` as
// `graphql.deprecatedReason`, the field description as `description`, and any
// other directive applied to the field verbatim under `graphql.directives`.
//
// Types: every other definition goes through type-ir's `fromGraphql` into
// `defs`. Type extensions are merged into their definitions first (§ "Type
// System Extensions"); a root type is left out of `defs` unless a remaining
// type or operation references it.
//
// Not represented (each reported in `diagnostics` where it applies):
// descriptions, interfaces and directives on a root type itself, enum value
// descriptions and directives, executable definitions, duplicate definitions
// and conflicting extensions. Directive definitions and the schema's own
// description and directives are kept under the root group's `meta.graphql`.
//
// A document that does not parse as GraphQL throws the parser's error.

import {
  Kind,
  parse,
  print,
  valueFromASTUntyped,
  type DirectiveNode,
  type DocumentNode,
  type FieldDefinitionNode,
  type ObjectTypeDefinitionNode,
} from "graphql";
import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { fromGraphql } from "@rhi-zone/fractal-type-ir/from-graphql";
import {
  noInput,
  type Diagnostic,
  type Group,
  type Imported,
  type Operation,
} from "./api-description.ts";
import { addressKey } from "./api-description.ts";
import { reachableDefs } from "./lower.ts";

type Obj = Record<string, unknown>;

const ROOT_KINDS = ["query", "mutation", "subscription"] as const;
type RootKind = (typeof ROOT_KINDS)[number];

const DEFAULT_ROOT_TYPE: Readonly<Record<RootKind, string>> = {
  query: "Query",
  mutation: "Mutation",
  subscription: "Subscription",
};

const EXTENSION_TO_DEFINITION: Readonly<Record<string, string>> = {
  [Kind.SCALAR_TYPE_EXTENSION]: Kind.SCALAR_TYPE_DEFINITION,
  [Kind.OBJECT_TYPE_EXTENSION]: Kind.OBJECT_TYPE_DEFINITION,
  [Kind.INTERFACE_TYPE_EXTENSION]: Kind.INTERFACE_TYPE_DEFINITION,
  [Kind.UNION_TYPE_EXTENSION]: Kind.UNION_TYPE_DEFINITION,
  [Kind.ENUM_TYPE_EXTENSION]: Kind.ENUM_TYPE_DEFINITION,
  [Kind.INPUT_OBJECT_TYPE_EXTENSION]: Kind.INPUT_OBJECT_TYPE_DEFINITION,
};

const TYPE_DEFINITION_KINDS: ReadonlySet<string> = new Set(Object.values(EXTENSION_TO_DEFINITION));

// Keyed lists a type extension appends to its definition; `fields` and
// `values` are unique by name.
const NAMED_LISTS = ["fields", "values"] as const;
const APPENDED_LISTS = ["directives", "interfaces", "types"] as const;

const nameOf = (node: Obj): string => (node.name as { value: string }).value;

function directiveToJs(d: DirectiveNode): { name: string; args: Obj } {
  const args: Obj = {};
  for (const a of d.arguments ?? []) args[a.name.value] = valueFromASTUntyped(a.value);
  return { name: d.name.value, args };
}

/** `@deprecated` (§ "@deprecated") split from the field's other directives. */
function splitDirectives(directives: readonly DirectiveNode[] | undefined): {
  deprecated: boolean;
  reason?: string;
  rest: { name: string; args: Obj }[];
} {
  let deprecated = false;
  let reason: string | undefined;
  const rest: { name: string; args: Obj }[] = [];
  for (const d of directives ?? []) {
    const js = directiveToJs(d);
    if (js.name === "deprecated") {
      deprecated = true;
      if (typeof js.args.reason === "string") reason = js.args.reason;
    } else rest.push(js);
  }
  return { deprecated, ...(reason !== undefined ? { reason } : {}), rest };
}

/** Field-position meta `fromGraphql` merges into a zero-argument field's type. */
const FIELD_META_KEYS = ["description", "deprecated", "deprecatedReason", "directives"];

function withoutFieldMeta(ref: TypeRef): TypeRef {
  const meta: Obj = {};
  for (const [k, v] of Object.entries(ref.meta)) if (!FIELD_META_KEYS.includes(k)) meta[k] = v;
  return { shape: ref.shape, meta };
}

/** Merge `extension` into `base` (§ "Type System Extensions"): list members append, a member name already present is reported and skipped. */
function mergeExtension(base: Obj, extension: Obj, at: string, diagnostics: Diagnostic[]): Obj {
  const merged: Obj = { ...base };
  for (const key of APPENDED_LISTS) {
    if (Array.isArray(extension[key])) {
      merged[key] = [...((base[key] as unknown[] | undefined) ?? []), ...extension[key]];
    }
  }
  for (const key of NAMED_LISTS) {
    if (!Array.isArray(extension[key])) continue;
    const list = [...((base[key] as Obj[] | undefined) ?? [])];
    const seen = new Set(list.map(nameOf));
    for (const member of extension[key] as Obj[]) {
      const name = nameOf(member);
      if (seen.has(name)) {
        diagnostics.push({
          at: `${at}.${name}`,
          message: "extension redeclares an existing member; the extension's is skipped",
        });
        continue;
      }
      seen.add(name);
      list.push(member);
    }
    merged[key] = list;
  }
  return merged;
}

export function fromGraphqlSchema(sdl: string): Imported {
  const document = parse(sdl);
  const diagnostics: Diagnostic[] = [];

  let schemaDefinition: Obj | undefined;
  const schemaExtensions: Obj[] = [];
  const directiveDefinitions: string[] = [];
  const typeDefs = new Map<string, Obj>();
  const extensions: Obj[] = [];

  for (const node of document.definitions) {
    const def = node as unknown as Obj;
    const kind = node.kind as string;
    if (kind === Kind.SCHEMA_DEFINITION) {
      if (schemaDefinition === undefined) schemaDefinition = def;
      else diagnostics.push({ at: "schema", message: "second schema definition; skipped" });
    } else if (kind === Kind.SCHEMA_EXTENSION) {
      schemaExtensions.push(def);
    } else if (kind === Kind.DIRECTIVE_DEFINITION) {
      directiveDefinitions.push(print(node));
    } else if (TYPE_DEFINITION_KINDS.has(kind)) {
      const name = nameOf(def);
      if (typeDefs.has(name)) {
        diagnostics.push({
          at: name,
          message: "type is defined more than once; the first is kept",
        });
      } else typeDefs.set(name, def);
    } else if (kind in EXTENSION_TO_DEFINITION) {
      extensions.push(def);
    } else {
      const name = "name" in def && def.name !== undefined ? nameOf(def) : undefined;
      const label = kind === Kind.OPERATION_DEFINITION ? String(def.operation) : "fragment";
      diagnostics.push({
        at: name !== undefined ? `${label} ${name}` : label,
        message: "executable definitions are not part of a schema; skipped",
      });
    }
  }

  for (const ext of extensions) {
    const name = nameOf(ext);
    const definitionKind = EXTENSION_TO_DEFINITION[ext.kind as string]!;
    const base = typeDefs.get(name);
    if (base === undefined) {
      diagnostics.push({
        at: name,
        message: "extension has no definition in this document; treated as the definition",
      });
      typeDefs.set(name, { ...ext, kind: definitionKind });
    } else if (base.kind !== definitionKind) {
      diagnostics.push({
        at: name,
        message: `extension is a ${String(ext.kind)} but the type is a ${String(base.kind)}; skipped`,
      });
    } else {
      typeDefs.set(name, mergeExtension(base, ext, name, diagnostics));
    }
  }

  // Root operation types.
  const rootTypeName: Partial<Record<RootKind, string>> = {};
  const declareRoot = (kind: RootKind, name: string, at: string): void => {
    const existing = rootTypeName[kind];
    if (existing === undefined) rootTypeName[kind] = name;
    else if (existing !== name) {
      diagnostics.push({
        at,
        message: `${kind} root type is already "${existing}"; "${name}" is skipped`,
      });
    }
  };
  for (const [nodes, at] of [
    [schemaDefinition === undefined ? [] : [schemaDefinition], "schema"],
    [schemaExtensions, "extend schema"],
  ] as const) {
    for (const s of nodes) {
      for (const o of (s.operationTypes as {
        operation: string;
        type: { name: { value: string } };
      }[]) ?? []) {
        declareRoot(String(o.operation) as RootKind, o.type.name.value, at);
      }
    }
  }
  if (schemaDefinition === undefined) {
    for (const kind of ROOT_KINDS) {
      if (rootTypeName[kind] === undefined && typeDefs.has(DEFAULT_ROOT_TYPE[kind])) {
        rootTypeName[kind] = DEFAULT_ROOT_TYPE[kind];
      }
    }
  }

  const usedRootTypes = new Map<string, RootKind>();
  const rootFields: { kind: RootKind; typeName: string; fields: readonly FieldDefinitionNode[] }[] =
    [];
  for (const kind of ROOT_KINDS) {
    const typeName = rootTypeName[kind];
    if (typeName === undefined) continue;
    const def = typeDefs.get(typeName);
    if (def === undefined || def.kind !== Kind.OBJECT_TYPE_DEFINITION) {
      diagnostics.push({
        at: typeName,
        message: `${kind} root type is not declared as an object type; its operations are skipped`,
      });
      continue;
    }
    const other = usedRootTypes.get(typeName);
    if (other !== undefined) {
      diagnostics.push({
        at: typeName,
        message: `already the ${other} root type; root types must be distinct, so no ${kind} operations are read from it`,
      });
      continue;
    }
    usedRootTypes.set(typeName, kind);
    const node = def as unknown as ObjectTypeDefinitionNode;
    for (const [what, present] of [
      ["description", node.description !== undefined],
      ["interfaces", (node.interfaces ?? []).length > 0],
      ["directives", (node.directives ?? []).length > 0],
    ] as const) {
      if (present) {
        diagnostics.push({ at: typeName, message: `root type ${what} are not represented` });
      }
    }
    rootFields.push({ kind, typeName, fields: node.fields ?? [] });
  }

  for (const def of typeDefs.values()) {
    if (def.kind !== Kind.ENUM_TYPE_DEFINITION) continue;
    for (const value of (def.values as Obj[] | undefined) ?? []) {
      if (value.description !== undefined || ((value.directives as unknown[]) ?? []).length > 0) {
        diagnostics.push({
          at: `${nameOf(def)}.${nameOf(value)}`,
          message: "enum value description and directives are not represented",
        });
      }
    }
  }

  const typeDocument = {
    kind: Kind.DOCUMENT,
    definitions: [...typeDefs.values()],
  } as unknown as DocumentNode;
  const allTypes = fromGraphql(print(typeDocument));

  const operations: Operation[] = [];
  const leafKeys = new Set<string>();
  const groupHeads = new Set<string>();
  const place = (kind: RootKind, name: string, at: string): string[] => {
    const candidates = [[name], [kind, name], [`${kind}_${name}`]];
    for (const [i, address] of candidates.entries()) {
      const key = addressKey(address.map((n) => ({ kind: "static", name: n })));
      const head = addressKey([{ kind: "static", name: address[0]! }]);
      const conflict =
        leafKeys.has(key) || (address.length === 1 ? groupHeads.has(key) : leafKeys.has(head));
      if (conflict) continue;
      leafKeys.add(key);
      if (address.length > 1) groupHeads.add(head);
      if (i > 0) {
        diagnostics.push({
          at,
          message: `field name "${name}" is already an operation address; addressed ${address.join("/")} (meta.graphql.name keeps the exact name)`,
        });
      }
      return address;
    }
    throw new Error(`fromGraphqlSchema: no free address for ${at}`);
  };

  for (const { kind, typeName, fields } of rootFields) {
    const typeRef = allTypes[typeName];
    const fieldRefs = typeRef?.shape.kind === "object" ? typeRef.shape.fields : {};
    for (const field of fields) {
      const name = field.name.value;
      const at = `${typeName}.${name}`;
      const fieldRef = fieldRefs[name];
      if (fieldRef === undefined) {
        diagnostics.push({ at, message: "field could not be read; skipped" });
        continue;
      }

      const params = fieldRef.shape.kind === "method" ? fieldRef.shape.params : [];
      const returned =
        fieldRef.shape.kind === "method" ? fieldRef.shape.returnType : withoutFieldMeta(fieldRef);

      const inputFields: Record<string, TypeRef> = {};
      for (const p of params) {
        inputFields[p.name] =
          p.type.meta.nullable === true ? withMeta(p.type, { optional: true }) : p.type;
      }

      const output: TypeRef =
        kind === "subscription"
          ? t(
              types.stream(returned),
              returned.meta.nullable === true ? { nullable: true } : undefined,
            )
          : returned;

      const { deprecated, reason, rest } = splitDirectives(field.directives);
      const tags: Obj = {};
      if (kind === "query") tags.readOnly = true;
      if (kind === "subscription") tags.streaming = true;
      if (deprecated) tags.deprecated = true;
      const graphql: Obj = { operation: kind, name };
      if (reason !== undefined) graphql.deprecatedReason = reason;
      if (rest.length > 0) graphql.directives = rest;

      operations.push({
        address: place(kind, name, at).map((n) => ({ kind: "static", name: n })),
        input: Object.keys(inputFields).length > 0 ? t(types.object(inputFields)) : noInput(),
        output,
        meta: {
          ...(field.description !== undefined ? { description: field.description.value } : {}),
          tags,
          graphql,
        },
      });
    }
  }

  // A root type stays a def only when something that remains refers to it.
  const rootNames = new Set(usedRootTypes.keys());
  const defs: Record<string, TypeRef> = {};
  for (const [name, ref] of Object.entries(allTypes)) if (!rootNames.has(name)) defs[name] = ref;
  const reachable = reachableDefs(
    [
      ...operations.flatMap((o) => [o.input, ...(o.output !== undefined ? [o.output] : [])]),
      ...Object.values(defs),
    ],
    allTypes,
  );
  for (const name of rootNames) if (reachable.has(name)) defs[name] = allTypes[name]!;

  const graphqlRoot: Obj = {};
  const rootTypes: Obj = {};
  for (const kind of ROOT_KINDS) {
    const name = rootTypeName[kind];
    if (name !== undefined && name !== DEFAULT_ROOT_TYPE[kind]) rootTypes[kind] = name;
  }
  if (Object.keys(rootTypes).length > 0) graphqlRoot.rootTypes = rootTypes;
  const schemaDirectives = [schemaDefinition, ...schemaExtensions].flatMap((s) =>
    ((s?.directives as DirectiveNode[] | undefined) ?? []).map(directiveToJs),
  );
  if (schemaDirectives.length > 0) graphqlRoot.schemaDirectives = schemaDirectives;
  if (directiveDefinitions.length > 0) graphqlRoot.directiveDefinitions = directiveDefinitions;
  const rootMeta: Obj = {};
  const schemaDescription = (schemaDefinition?.description as { value: string } | undefined)?.value;
  if (schemaDescription !== undefined) rootMeta.description = schemaDescription;
  if (Object.keys(graphqlRoot).length > 0) rootMeta.graphql = graphqlRoot;
  const groups: Group[] = Object.keys(rootMeta).length > 0 ? [{ address: [], meta: rootMeta }] : [];

  return { api: { operations, groups, defs }, diagnostics };
}
