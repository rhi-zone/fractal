// packages/type-ir/src/from-flow.ts — @rhi-zone/fractal-type-ir/from-flow
//
// Flow (https://flow.org/) source ingester: Flow type-annotation SYNTAX (not
// a resolved/checked type — flow-parser is a parser, not a type checker) ->
// `TypeRef`. Uses `flow-parser`, Facebook's own OCaml Flow parser compiled to
// WASM with a JS-facing `parse(code, options) -> ESTree-ish AST` API — the
// same parser `flow check` itself is built on, so the grammar it accepts is
// authoritative rather than hand-approximated.
//
// Mirrors `from-typescript.ts`'s level of ambition (primitives, literals,
// objects with optional/readonly fields, arrays, tuples, unions incl. string-
// literal unions -> `enum`, discriminated object unions, intersections,
// generics via constraint-extraction, interfaces, index signatures -> `map`)
// but is necessarily syntactic rather than semantic: flow-parser produces an
// AST, not resolved types, so — unlike `from-typescript.ts`, which walks a
// `ts.TypeChecker`-resolved `ts.Type` graph where every generic use site is
// already substituted — a reference to a locally-declared generic alias
// (`ListOf<string>` where `type ListOf<T> = Array<T>`) can't be specialized;
// it lowers to a plain `{ kind: "ref", target: "ListOf" }`, losing the `<string>`
// instantiation. This is a real (documented, not silent) gap versus the TS
// ingester, not an oversight.
//
// Returned as a `TypeRefDocument` (see index.ts) — the same convention
// `from-protobuf.ts`'s `fromProtoText` uses for a source format that declares
// multiple named types in one file: every top-level type/interface/opaque-type
// declaration becomes a `defs` entry keyed by its declared name, `root` is a
// `ref` to the FIRST top-level declaration (or `t(types.unknown)` if the
// source declares none), and every reference to another declared name lowers
// to a `{ kind: "ref", target }` pointing into `defs` — so mutually-recursive
// Flow types round-trip without infinite inlining.
//
// Punts anything genuinely unsupported (conditional/mapped/indexed-access
// types, `typeof` queries, class declarations — Flow classes are VALUE
// declarations, not type declarations, so they're out of scope the same way
// GraphQL executable definitions are out of scope for `from-graphql.ts`) to
// `t(types.unknown, { $comment })` carrying a `$comment` that names the
// unhandled case — self-documenting rather than silently lossy, same
// convention as `from-typescript.ts`'s `puntRef`.

import { parse as parseFlow } from "flow-parser";
import {
  t,
  types,
  typeRefDocument,
  withMeta,
  type TypeRef,
  type TypeRefDocument,
} from "./index.ts";

/** The TypeRef punt: `unknown` tagged with the unhandled case. */
const puntRef = (reason: string): TypeRef =>
  t(types.unknown, { $comment: `TODO(type-ir): unhandled Flow type — ${reason}` });

// ============================================================================
// Minimal structural typing over flow-parser's ESTree-ish AST. flow-parser
// ships no published TS type defs (its README documents the `parse()` call
// signature and options only), so the node shapes below are typed narrowly —
// just the fields this file actually reads — and derived directly from the
// parser's real output (inspected via a throwaway `parse()` call against
// representative Flow source), not guessed from the Flow AST spec docs.
// ============================================================================

interface Node {
  readonly type: string;
}

interface Identifier extends Node {
  readonly type: "Identifier";
  readonly name: string;
}

interface TypeParameterDeclaration extends Node {
  readonly params: readonly {
    readonly name: string;
    readonly bound: { readonly typeAnnotation: TypeNode } | null;
  }[];
}

interface TypeAnnotationNode extends Node {
  readonly typeAnnotation: TypeNode;
}

interface ObjectTypeProperty extends Node {
  readonly type: "ObjectTypeProperty";
  readonly key: Identifier | { readonly type: "StringLiteral"; readonly value: string };
  readonly value: TypeNode;
  readonly method: boolean;
  readonly optional: boolean;
  readonly variance: { readonly kind: "plus" | "minus" } | null;
}

interface ObjectTypeIndexer extends Node {
  readonly type: "ObjectTypeIndexer";
  readonly key: TypeNode;
  readonly value: TypeNode;
}

interface ObjectTypeCallProperty extends Node {
  readonly type: "ObjectTypeCallProperty";
  readonly value: TypeNode;
}

interface ObjectTypeAnnotation extends Node {
  readonly type: "ObjectTypeAnnotation";
  readonly properties: readonly ObjectTypeProperty[];
  readonly indexers: readonly ObjectTypeIndexer[];
  readonly callProperties: readonly ObjectTypeCallProperty[];
  readonly exact: boolean;
}

interface FunctionTypeParam extends Node {
  readonly name: Identifier | null;
  readonly typeAnnotation: TypeNode;
}

interface FunctionTypeAnnotation extends Node {
  readonly type: "FunctionTypeAnnotation";
  readonly params: readonly FunctionTypeParam[];
  readonly this: { readonly typeAnnotation: TypeNode } | null;
  readonly returnType: TypeNode;
}

interface GenericTypeAnnotation extends Node {
  readonly type: "GenericTypeAnnotation";
  readonly id: Identifier | { readonly type: "QualifiedTypeIdentifier"; readonly id: Identifier };
  readonly typeParameters: { readonly params: readonly TypeNode[] } | null;
}

type TypeNode = Node;

interface TypeAliasLike extends Node {
  readonly id: Identifier;
  readonly typeParameters: TypeParameterDeclaration | null;
}

interface InterfaceLike extends TypeAliasLike {
  readonly body: ObjectTypeAnnotation;
  readonly extends: readonly { readonly id: Identifier; readonly typeParameters: unknown }[];
}

// ============================================================================
// Generic-scope handling — mirrors `from-typescript.ts`'s type-parameter
// constraint extraction: a reference to the CURRENT alias/interface's own
// type parameter lowers to its `extends` bound (recursively converted, tagged
// `meta.generic: true`), or `unknown` with a descriptive comment when
// unconstrained. `TypeScope` maps a type-parameter name to its already-
// converted bound (or `undefined` for an unconstrained parameter), scoped to
// one alias/interface declaration at a time (Flow has no nested generic
// scopes worth threading further — a type alias's own body is the only place
// its parameters are visible).
// ============================================================================

type TypeScope = ReadonlyMap<string, TypeRef | undefined>;

function scopeFromTypeParameters(
  decl: TypeParameterDeclaration | null,
  declared: ReadonlySet<string>,
): TypeScope {
  const scope = new Map<string, TypeRef | undefined>();
  if (!decl) return scope;
  for (const param of decl.params) {
    const bound = param.bound
      ? convertType(param.bound.typeAnnotation, declared, scope)
      : undefined;
    scope.set(param.name, bound);
  }
  return scope;
}

// ============================================================================
// Object-type conversion — shared by `TypeAlias`/`DeclareTypeAlias` bodies,
// `InterfaceDeclaration`/`DeclareInterface` bodies, and any inline
// `ObjectTypeAnnotation` nested in a field/union/etc.
// ============================================================================

function keyName(key: ObjectTypeProperty["key"]): string {
  return key.type === "Identifier" ? key.name : key.value;
}

function convertFunctionType(
  node: FunctionTypeAnnotation,
  declared: ReadonlySet<string>,
  scope: TypeScope,
): TypeRef {
  const params = node.params.map((p, i) => ({
    name: p.name?.name ?? `arg${i}`,
    type: convertType(p.typeAnnotation, declared, scope),
  }));
  const returnType = convertType(node.returnType, declared, scope);
  const thisType = node.this ? convertType(node.this.typeAnnotation, declared, scope) : undefined;
  return t(types.function(params, returnType, thisType));
}

/**
 * Convert an `ObjectTypeAnnotation` to a TypeRef. Three shapes, checked in
 * order (mirrors `from-typescript.ts`'s object-type branch ordering — pure
 * index signature vs. own fields vs. callable):
 *   - no properties, one-or-more indexers -> `types.map(key, value)` (a
 *     `{ [k: string]: V }`-only object has no fields of its own to speak of).
 *   - no properties, no indexers, one-or-more call properties -> callable ->
 *     `types.function` (single signature) or `types.intersection` of
 *     `types.function`s (overloaded call properties).
 *   - otherwise -> `types.object(fields)`, `meta.exact: false` when the
 *     source used Flow's inexact `{ ... }` form (default in modern Flow
 *     syntax) — `meta.exact` omitted (implicitly `true` per `flow-native.ts`'s
 *     own read of this same convention) when the source used the exact
 *     `{| ... |}` form. A trailing indexer alongside real fields carries over
 *     as `meta.additionalPropertyType`, the same "mixed record+dict shape"
 *     convention `from-json-corpus.ts` uses (see index.ts's `TypeRef` doc
 *     comment).
 */
function convertObjectType(
  node: ObjectTypeAnnotation,
  declared: ReadonlySet<string>,
  scope: TypeScope,
): TypeRef {
  if (node.properties.length === 0 && node.indexers.length > 0) {
    const [indexer] = node.indexers;
    return t(
      types.map(
        convertType(indexer!.key, declared, scope),
        convertType(indexer!.value, declared, scope),
      ),
    );
  }

  if (
    node.properties.length === 0 &&
    node.indexers.length === 0 &&
    node.callProperties.length > 0
  ) {
    const refs = node.callProperties.map((cp) =>
      convertFunctionType(cp.value as unknown as FunctionTypeAnnotation, declared, scope),
    );
    return refs.length === 1 ? refs[0]! : t(types.intersection(refs));
  }

  const fields: Record<string, TypeRef> = {};
  for (const prop of node.properties) {
    const name = keyName(prop.key);
    const valueRef = prop.method
      ? convertFunctionType(prop.value as unknown as FunctionTypeAnnotation, declared, scope)
      : convertType(prop.value, declared, scope);
    const extraMeta: Record<string, unknown> = {};
    if (prop.optional) extraMeta.optional = true;
    if (prop.variance?.kind === "plus") extraMeta.readonly = true;
    fields[name] =
      Object.keys(extraMeta).length > 0
        ? t(valueRef.shape, { ...valueRef.meta, ...extraMeta })
        : valueRef;
  }

  const meta: Record<string, unknown> = {};
  if (!node.exact) meta.exact = false;
  if (node.indexers.length > 0) {
    meta.additionalPropertyType = convertType(node.indexers[0]!.value, declared, scope);
  }
  return t(types.object(fields), meta);
}

// ============================================================================
// Union conversion
// ============================================================================

function isStringLiteralNode(n: TypeNode): boolean {
  return n.type === "StringLiteralTypeAnnotation";
}

/** The shared-discriminator-field detection `from-typescript.ts` runs over a
 * union's object-like members — same rationale (discriminator-aware
 * projectors read `meta.discriminator`), re-derived here syntactically since
 * there's no resolved `ts.Type` to query field types off of. Only literal-
 * typed fields (string/number/boolean literal annotations) count as
 * discriminator candidates. */
function findDiscriminator(members: readonly ObjectTypeAnnotation[]): string | undefined {
  const [first] = members;
  if (!first) return undefined;
  const fieldNameSets = members.map((m) => new Set(m.properties.map((p) => keyName(p.key))));
  const sharedNames = [...fieldNameSets[0]!].filter((name) =>
    fieldNameSets.every((names) => names.has(name)),
  );

  for (const name of sharedNames) {
    const seenValues = new Set<unknown>();
    const distinctLiteralOnEveryVariant = members.every((m) => {
      const prop = m.properties.find((p) => keyName(p.key) === name);
      if (!prop) return false;
      const v = prop.value;
      const literal =
        v.type === "StringLiteralTypeAnnotation" ||
        v.type === "NumberLiteralTypeAnnotation" ||
        v.type === "BooleanLiteralTypeAnnotation"
          ? (v as unknown as { value: string | number | boolean }).value
          : undefined;
      if (literal === undefined || seenValues.has(literal)) return false;
      seenValues.add(literal);
      return true;
    });
    if (distinctLiteralOnEveryVariant) return name;
  }
  return undefined;
}

function convertUnion(
  node: { readonly types: readonly TypeNode[] },
  declared: ReadonlySet<string>,
  scope: TypeScope,
): TypeRef {
  const members = node.types;

  if (members.every(isStringLiteralNode)) {
    return t(types.enum(members.map((m) => (m as unknown as { value: string }).value)));
  }

  const isObjectLikeMember = (m: TypeNode): m is ObjectTypeAnnotation =>
    m.type === "ObjectTypeAnnotation";
  if (members.length > 0 && members.every(isObjectLikeMember)) {
    const objectMembers = members as unknown as ObjectTypeAnnotation[];
    const discriminator = findDiscriminator(objectMembers);
    const variants = objectMembers.map((m) => convertObjectType(m, declared, scope));
    return t(types.union(variants), discriminator ? { discriminator } : {});
  }

  return t(types.union(members.map((m) => convertType(m, declared, scope))));
}

// ============================================================================
// Generic-reference conversion — built-in container names Flow's global
// environment provides (`Array<T>`/`$ReadOnlyArray<T>`, `Map<K,V>`,
// `Set<T>`/`$ReadOnlySet<T>`, `Promise<T>`), otherwise a reference to a
// locally-declared name (`ref`, type arguments dropped — see this file's top
// doc comment) or an unresolved name (`unknown` with a naming comment, same
// honest-degrade `from-graphql.ts`'s `convertNamedType` uses for an
// undeclared custom scalar).
// ============================================================================

const BUILTIN_CONTAINERS = new Set([
  "Array",
  "$ReadOnlyArray",
  "Set",
  "$ReadOnlySet",
  "Map",
  "$ReadOnlyMap",
  "Promise",
]);

function convertGeneric(
  node: GenericTypeAnnotation,
  declared: ReadonlySet<string>,
  scope: TypeScope,
): TypeRef {
  if (node.id.type === "QualifiedTypeIdentifier") {
    return puntRef(`qualified type reference (${node.id.id.name})`);
  }
  const name = node.id.name;
  const args = node.typeParameters?.params ?? [];

  if (scope.has(name)) {
    const bound = scope.get(name);
    if (bound) return t(bound.shape, { ...bound.meta, generic: true });
    return t(types.unknown, {
      $comment: `unconstrained generic type parameter (${name}) — no bound to extract`,
    });
  }

  if (BUILTIN_CONTAINERS.has(name)) {
    if (
      name === "Array" ||
      name === "$ReadOnlyArray" ||
      name === "Set" ||
      name === "$ReadOnlySet"
    ) {
      const [elem] = args;
      return t(
        types.array(
          elem ? convertType(elem, declared, scope) : puntRef(`unknown element of ${name}`),
        ),
      );
    }
    if (name === "Map" || name === "$ReadOnlyMap") {
      const [key, value] = args;
      return t(
        types.map(
          key ? convertType(key, declared, scope) : puntRef("unknown map key"),
          value ? convertType(value, declared, scope) : puntRef("unknown map value"),
        ),
      );
    }
    // Promise<T> unwraps to T — same convention as from-typescript.ts's
    // Promise handling.
    const [inner] = args;
    return inner
      ? convertType(inner, declared, scope)
      : t(types.unknown, { $comment: "Promise with no type argument" });
  }

  if (declared.has(name)) return t(types.ref(name));

  return t(types.unknown, { $comment: `unresolved type reference: ${name}` });
}

// ============================================================================
// Core dispatch
// ============================================================================

function convertType(node: TypeNode, declared: ReadonlySet<string>, scope: TypeScope): TypeRef {
  switch (node.type) {
    case "StringTypeAnnotation":
      return t(types.string);
    case "NumberTypeAnnotation":
      return t(types.number);
    case "BooleanTypeAnnotation":
      return t(types.boolean);
    case "VoidTypeAnnotation":
      return t(types.void);
    case "NullLiteralTypeAnnotation":
      return t(types.null);
    // Flow's top type (`mixed` accepts any value, nothing is assignable
    // FROM it without a refinement) maps to the IR's own top, `unknown` —
    // same role TypeScript's `unknown` plays for from-typescript.ts.
    case "MixedTypeAnnotation":
      return t(types.unknown);
    // Flow's bottom type — no value inhabits it.
    case "EmptyTypeAnnotation":
      return t(types.never);
    // `any` is Flow's UNCHECKED escape hatch (unlike `mixed`, which is
    // checked) — degrades to `unknown` same as `mixed`, but tagged so the
    // distinction isn't silently lost.
    case "AnyTypeAnnotation":
      return t(types.unknown, { $comment: "Flow 'any' (unchecked) — degraded to unknown" });
    case "StringLiteralTypeAnnotation":
      return t(types.literal((node as unknown as { value: string }).value));
    case "NumberLiteralTypeAnnotation":
      return t(types.literal((node as unknown as { value: number }).value));
    case "BooleanLiteralTypeAnnotation":
      return t(types.literal((node as unknown as { value: boolean }).value));
    case "NullableTypeAnnotation":
      return withMeta(
        convertType((node as unknown as TypeAnnotationNode).typeAnnotation, declared, scope),
        { nullable: true },
      );
    case "ArrayTypeAnnotation":
      return t(
        types.array(
          convertType((node as unknown as { elementType: TypeNode }).elementType, declared, scope),
        ),
      );
    case "TupleTypeAnnotation":
      return t(
        types.tuple(
          (node as unknown as { elementTypes: readonly TypeNode[] }).elementTypes.map((el) =>
            convertType(el, declared, scope),
          ),
        ),
      );
    case "UnionTypeAnnotation":
      return convertUnion(node as unknown as { types: readonly TypeNode[] }, declared, scope);
    case "IntersectionTypeAnnotation":
      return t(
        types.intersection(
          (node as unknown as { types: readonly TypeNode[] }).types.map((m) =>
            convertType(m, declared, scope),
          ),
        ),
      );
    case "ObjectTypeAnnotation":
      return convertObjectType(node as unknown as ObjectTypeAnnotation, declared, scope);
    case "FunctionTypeAnnotation":
      return convertFunctionType(node as unknown as FunctionTypeAnnotation, declared, scope);
    case "GenericTypeAnnotation":
      return convertGeneric(node as unknown as GenericTypeAnnotation, declared, scope);
    default:
      return puntRef(`unsupported (${node.type})`);
  }
}

// ============================================================================
// Top-level declarations
// ============================================================================

/** Unwrap `export type X = ...` / `declare export type X = ...` / plain
 * declarations down to the underlying type/interface/opaque-type
 * declaration, or `undefined` for a statement with no type-system meaning
 * (value declarations, imports, statements, …) — same role
 * `from-graphql.ts`'s definition-kind `switch` plays, but Flow's export
 * wrapping means the declaration of interest isn't always a direct
 * `Program.body` entry.
 */
function unwrapDeclaration(node: TypeNode): TypeNode | undefined {
  if (node.type === "ExportNamedDeclaration" || node.type === "DeclareExportDeclaration") {
    const inner = (node as unknown as { declaration: TypeNode | null }).declaration;
    return inner ?? undefined;
  }
  return node;
}

const TYPE_DECLARATION_KINDS = new Set([
  "TypeAlias",
  "DeclareTypeAlias",
  "InterfaceDeclaration",
  "DeclareInterface",
  "OpaqueType",
  "DeclareOpaqueType",
]);

function declarationsOf(program: { readonly body: readonly TypeNode[] }): TypeAliasLike[] {
  const decls: TypeAliasLike[] = [];
  for (const stmt of program.body) {
    const unwrapped = unwrapDeclaration(stmt);
    if (unwrapped && TYPE_DECLARATION_KINDS.has(unwrapped.type)) {
      decls.push(unwrapped as unknown as TypeAliasLike);
    }
  }
  return decls;
}

function convertInterfaceLike(node: InterfaceLike, declared: ReadonlySet<string>): TypeRef {
  const scope = scopeFromTypeParameters(node.typeParameters, declared);
  const ownBody = convertObjectType(node.body, declared, scope);
  if (node.extends.length === 0) return ownBody;

  const baseRefs = node.extends.map((e): TypeRef =>
    declared.has(e.id.name)
      ? t(types.ref(e.id.name))
      : puntRef(`unresolved interface base: ${e.id.name}`),
  );
  return t(types.intersection([...baseRefs, ownBody]));
}

function convertDeclaration(node: TypeAliasLike, declared: ReadonlySet<string>): TypeRef {
  switch (node.type) {
    case "TypeAlias":
    case "DeclareTypeAlias": {
      const scope = scopeFromTypeParameters(node.typeParameters, declared);
      return convertType((node as unknown as { right: TypeNode }).right, declared, scope);
    }
    case "InterfaceDeclaration":
    case "DeclareInterface":
      return convertInterfaceLike(node as unknown as InterfaceLike, declared);
    case "OpaqueType":
    case "DeclareOpaqueType": {
      const scope = scopeFromTypeParameters(node.typeParameters, declared);
      const opaque = node as unknown as { impltype: TypeNode | null; supertype: TypeNode | null };
      // `impltype` (the type's real, module-private definition) is preferred
      // when present; `supertype` (its public upper bound, e.g. `opaque type
      // X: string = ...`) is the fallback for a `declare opaque type` with no
      // accessible implementation at all — same "best available structural
      // approximation" spirit as from-typescript.ts's generic-constraint
      // extraction.
      const underlying = opaque.impltype ?? opaque.supertype;
      const base = underlying
        ? convertType(underlying, declared, scope)
        : puntRef("opaque type with no accessible implementation");
      return t(base.shape, { ...base.meta, opaque: true });
    }
    default:
      return puntRef(`unsupported top-level declaration (${node.type})`);
  }
}

/**
 * Parse Flow source and lower every top-level type/interface/opaque-type
 * declaration to a `TypeRefDocument`: `defs` keyed by declared name, `root`
 * a `ref` to the first declaration in source order (or `t(types.unknown)` if
 * the source declares no types at all — e.g. a file of pure value code).
 * Non-type-system statements (value declarations, imports, classes, …) are
 * ignored, same "only type shapes" scope `from-graphql.ts`'s `fromGraphql`
 * documents for its own non-type-system SDL definitions.
 */
export function fromFlow(source: string): TypeRefDocument {
  const ast = parseFlow(source, { types: true }) as { body: readonly TypeNode[] };
  const decls = declarationsOf(ast);
  const declared = new Set(decls.map((d) => d.id.name));

  const defs: Record<string, TypeRef> = {};
  for (const decl of decls) defs[decl.id.name] = convertDeclaration(decl, declared);

  const root = decls.length > 0 ? t(types.ref(decls[0]!.id.name)) : t(types.unknown);
  return typeRefDocument(root, defs);
}
