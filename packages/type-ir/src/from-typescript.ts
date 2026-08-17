// General-purpose TypeScript compiler-API ingester: `ts.Type` + `ts.TypeChecker`
// → `TypeRef`. Handles primitives, literals, objects (incl. optional/readonly/
// JSDoc-derived meta), arrays, tuples, unions (incl. TS enums, literal unions,
// discriminated object unions), intersections (incl. the branded/opaque-type
// and refinement-tag conventions from `kinds/semantic-strings.ts` /
// `kinds/refinements.ts`), classes (→ `types.instance` + method surface),
// Map/Set, index-signature types (→ `types.map`), generics (constrained type
// parameters), Promise/AsyncIterable unwrapping, and structural sharing (an
// opt-in `SharingRegistry` that extracts reused named types to `defs` instead
// of inlining them at every use site).
//
// This module is the reusable TS-ingestion core: op/route-specific concerns
// (function-signature parameter extraction, `Result<T, E>` unwrapping,
// endpoint JSDoc parsing) belong to `@rhi-zone/fractal-api-tree`'s
// `extract.ts` instead.
//
// Punts anything genuinely unsupported (constructable types, exotic
// conditional/mapped types, …) to `t(types.unknown, { $comment })` carrying a
// `$comment` that names the unhandled case — self-documenting rather than
// silently lossy.

import path from "node:path";
import ts from "typescript";
import { email, uri, uuid } from "./kinds/common.ts";
import { nodeCount, t, types, type TypeRef, type TypeShape } from "./index.ts";

/** The TypeRef punt: `unknown` tagged with the unhandled case. */
const puntRef = (reason: string): TypeRef =>
  t(types.unknown, { $comment: `TODO(type-ir): unhandled type — ${reason}` });

// ============================================================================
// Call budget — a defensive circuit breaker for cases `typeRefFromType`'s
// `seen`-based (identity-keyed) cycle detection cannot catch.
//
// `seen` terminates a hand-authored self-recursive domain type (`type Tree =
// { children: Tree[] }`) because TS caches and reuses the same `ts.Type`
// object for a directly-recursive alias's repeated occurrences, so
// `seen.has(type)` fires almost immediately. It does not terminate a walk
// into certain TS/DOM built-in library types — the Fetch API's
// `Response`/`ReadableStream`/`ReadableStreamReader`/`ReadableStreamBYOBReader`
// family, reachable e.g. via a handler's `Promise<Response>` return type:
// their mutually overloaded, generically self-referential methods resolve to
// a fresh, non-identical `ts.Type` instance on every visit, because TS does
// not guarantee referential stability for repeated generic instantiations
// reached via different call paths. `seen.has(type)` never fires even though
// the walk never terminates, and the walk eventually overflows the native JS
// call stack. A reproduction against a real op's `Promise<Response>` return
// type hit ~3200 `typeRefFromType` calls before `RangeError: Maximum call
// stack size exceeded`, with `seen.size` still under 25 throughout — the
// runaway is breadth across overload sets, not path depth, so a path-depth
// cap over `seen.size` would not catch it.
//
// `budget` is a mutable call counter threaded through every recursive call
// the same way `seen`/`registry` already are: fresh per top-level
// `typeRefFromType` entry (mirrors `seen`'s own "omitted param → fresh Set"
// convention), shared by reference across one whole descent. Across this
// repo's own working slices (domain-auth/forecasting/tax-compliance), the
// largest full-file extraction (every leaf's input and output combined)
// totals a few hundred calls; `MAX_TYPE_REF_CALLS` sits a full order of
// magnitude above that per-leaf, and comfortably below the ~3200-call point
// where the native stack overflows for the pathological case, so it always
// trips and punts gracefully before a `RangeError` would.
// ============================================================================

/** Mutable call-budget for one top-level `typeRefFromType` descent — see the
 * module doc above. */
type Budget = { calls: number };

/** Calls per top-level extraction before `typeRefFromType` punts instead of
 * recursing further — see the module doc above for how this was calibrated. */
const MAX_TYPE_REF_CALLS = 1000;

// ============================================================================
// Structural sharing — an opt-in `SharingRegistry` threaded through
// `typeRefFromType` (and everything it calls) accumulates named-type use
// counts and builds a `defs` map, so a type used in multiple places is
// extracted once and referenced by `{ kind: "ref", target }` everywhere else,
// instead of being inlined (and re-descended) at every use site. Omitting the
// registry (the default for every function here) disables sharing: every
// named type inlines structurally, except true self-recursion, which always
// produces a `ref` regardless of the registry.
// ============================================================================

/** Symbol/alias names that name a structural convention this extractor
 * special-cases (Promise/AsyncIterable unwrapping, CursorPage/OffsetPage/Page
 * pagination, the TS lib's own generic container names), not a "real"
 * user-declared type worth sharing. Excluded from registry-based naming so
 * e.g. `Promise<Foo>`'s outer `Promise` type never becomes a spurious `defs`
 * entry. */
const NON_SHAREABLE_SYMBOL_NAMES = new Set([
  "Promise",
  "AsyncIterable",
  "AsyncGenerator",
  "AsyncIterableIterator",
  "CursorPage",
  "OffsetPage",
  "Page",
  "Array",
  "ReadonlyArray",
  "Map",
  "ReadonlyMap",
  "Set",
  "ReadonlySet",
  "Record",
]);

/** The name a `ts.Type` would be shared under, if it has one worth sharing:
 * a real alias (`type X = …`) or interface/class symbol name — not an
 * anonymous object-literal type (synthesized `__type` symbol), and not one of
 * `NON_SHAREABLE_SYMBOL_NAMES`'s structural-convention names. Restricted to
 * `ts.TypeFlags.Object` (interfaces/object literals/classes) — the shapes
 * `typeRefFromType`'s object branch actually builds `defs`-worthy bodies for;
 * primitive/literal aliases (`type Status = "a" | "b"`) are cheap enough
 * in-line that sharing them isn't worth a `defs` indirection in this v1. */
function shareableTypeName(type: ts.Type): string | undefined {
  if (type.aliasSymbol) {
    return NON_SHAREABLE_SYMBOL_NAMES.has(type.aliasSymbol.name)
      ? undefined
      : type.aliasSymbol.name;
  }
  if (!(type.flags & ts.TypeFlags.Object)) return undefined;
  const symbol = type.symbol;
  const name = symbol?.name;
  if (!name || name === "__type" || NON_SHAREABLE_SYMBOL_NAMES.has(name)) return undefined;
  return name;
}

/** Mutable bookkeeping shared across one whole extraction pass (e.g. every
 * leaf `extractToolTypeRefs`/`extractRouteTypeRefs` walks) — accumulates
 * which `ts.Type`s got which `defs` name, how many times each was referenced,
 * which are self-recursive (must stay shared — see `shouldShare`'s "always
 * share recursive types" rule), and the def bodies themselves. Construct via
 * `createSharingRegistry()`; `finalizeSharedDefs` consumes it after the whole
 * pass to decide, per `defs` entry, whether to keep it shared or inline it
 * back everywhere it's referenced. */
export interface SharingRegistry {
  readonly names: Map<ts.Type, string>;
  readonly usedNames: Set<string>;
  readonly useCounts: Map<string, number>;
  readonly defs: Map<string, TypeRef>;
  readonly recursive: Set<string>;
}

export function createSharingRegistry(): SharingRegistry {
  return {
    names: new Map(),
    usedNames: new Set(),
    useCounts: new Map(),
    defs: new Map(),
    recursive: new Set(),
  };
}

function uniqueRegistryName(registry: SharingRegistry, base: string): string {
  if (!registry.usedNames.has(base)) {
    registry.usedNames.add(base);
    return base;
  }
  let i = 2;
  while (registry.usedNames.has(`${base}_${i}`)) i++;
  const name = `${base}_${i}`;
  registry.usedNames.add(name);
  return name;
}

function bumpUseCount(registry: SharingRegistry, name: string): void {
  registry.useCounts.set(name, (registry.useCounts.get(name) ?? 0) + 1);
}

/** The predicate a caller supplies to decide whether a reused (not
 * self-recursive — those always share, unconditionally) named type is worth
 * extracting to `defs` rather than inlining at every use site. */
export type ShouldShare = (info: {
  node: TypeRef;
  tree: TypeRef;
  useCount: number;
  typeName?: string;
}) => boolean;

/** Default heuristic: share when a type is both reused (appears more than
 * once) AND big enough that duplicating its structure at every use site would
 * actually cost something (`nodeCount > 5` — small types like `{ id: string
 * }` are cheap enough inlined that a `defs` indirection isn't worth it even
 * when reused). */
export const defaultShouldShare: ShouldShare = (info) =>
  info.useCount > 1 && nodeCount(info.node) > 5;

/** Duck-types `v` as a `TypeRef` — mirrors type-ir's own private `isTypeRef`
 * (not exported, so re-derived locally); every `TypeRef` carries `shape.kind`
 * + `meta`, which no other value nested inside a `TypeShape` does. */
function isTypeRefLike(v: unknown): v is TypeRef {
  if (typeof v !== "object" || v === null) return false;
  const shape = (v as { shape?: unknown }).shape;
  return (
    "meta" in v &&
    typeof shape === "object" &&
    shape !== null &&
    typeof (shape as { kind?: unknown }).kind === "string"
  );
}

/** Rebuild a shape with every immediate TypeRef child replaced via `fn` —
 * the reconstruct-not-just-collect counterpart to type-ir's `childTypeRefs`
 * (same generic-over-kind walk: a bare TypeRef field, an array of TypeRef or
 * `{ name, type: TypeRef }`, or a `Record<string, TypeRef>`). Used by
 * `finalizeSharedDefs` to rewrite `ref` nodes after deciding which shared
 * defs to keep vs. inline. */
function mapTypeRefChildren(shape: TypeShape, fn: (ref: TypeRef) => TypeRef): TypeShape {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (isTypeRefLike(value)) {
      out[key] = fn(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (isTypeRefLike(item)) return fn(item);
        if (
          typeof item === "object" &&
          item !== null &&
          isTypeRefLike((item as { type?: unknown }).type)
        ) {
          return { ...(item as object), type: fn((item as { type: TypeRef }).type) };
        }
        return item;
      });
    } else if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>);
      out[key] =
        entries.length > 0 && entries.every(([, v]) => isTypeRefLike(v))
          ? Object.fromEntries(entries.map(([k, v]) => [k, fn(v as TypeRef)]))
          : value;
    } else {
      out[key] = value;
    }
  }
  return out as TypeShape;
}

/** Rewrite every `ref` node in `ref`'s subtree via `replace` — `replace(target)`
 * returns the def body to inline in place of the ref (recursively substituted
 * further, so a chain of demoted refs fully resolves), or `undefined` to leave
 * the ref as-is (a kept shared def, or a target `replace` doesn't know about).
 * Terminates even on defs that reference each other, because `replace` never
 * returns a body for a name flagged recursive (see `finalizeSharedDefs`) —
 * the one case where re-expanding could recurse forever. */
function substituteRefs(ref: TypeRef, replace: (target: string) => TypeRef | undefined): TypeRef {
  if (ref.shape.kind === "ref") {
    const target = (ref.shape as TypeShape & { kind: "ref"; target: string }).target;
    const replacement = replace(target);
    if (replacement !== undefined) return substituteRefs(replacement, replace);
    return ref;
  }
  return t(
    mapTypeRefChildren(ref.shape, (child) => substituteRefs(child, replace)),
    ref.meta,
  );
}

/**
 * Decide, per `SharingRegistry` entry, whether to keep it in `defs` (shared)
 * or inline it back everywhere it's referenced — run once, after the whole
 * extraction pass (every leaf a caller cares about) has populated `registry`
 * via `typeRefFromType`/callers that thread `registry` through.
 *
 * Every named type encountered during extraction is unconditionally shared
 * at extraction time (see `typeRefFromType`'s registry branch), because final
 * counts aren't known until the whole pass finishes — "share everything,
 * then demote" is the only single-pass-generation option that still lets
 * `shouldShare` see accurate `useCount`s. This function is that demotion
 * pass: self-recursive names (`registry.recursive`) are always kept, since a
 * recursive type has nowhere finite to inline to; everything else is kept
 * only if `shouldShare` (default: `defaultShouldShare`) says so, and demoted
 * names are substituted back into every remaining ref (roots and kept defs
 * alike) via `substituteRefs`.
 *
 * `roots` is every top-level TypeRef the caller extracted (e.g. one entry per
 * tool/route), keyed however the caller likes — the keys are preserved on the
 * returned `roots`; only the TypeRefs themselves are rewritten.
 */
export function finalizeSharedDefs(
  registry: SharingRegistry,
  roots: Record<string, TypeRef>,
  shouldShare: ShouldShare = defaultShouldShare,
): { roots: Record<string, TypeRef>; defs: Record<string, TypeRef> } {
  const kept = new Set<string>();
  for (const [name, body] of registry.defs) {
    if (registry.recursive.has(name)) {
      kept.add(name);
      continue;
    }
    const useCount = registry.useCounts.get(name) ?? 0;
    if (shouldShare({ node: body, tree: body, useCount, typeName: name })) kept.add(name);
  }

  const replace = (target: string): TypeRef | undefined =>
    kept.has(target) ? undefined : registry.defs.get(target);

  const defs: Record<string, TypeRef> = {};
  for (const name of kept) defs[name] = substituteRefs(registry.defs.get(name)!, replace);

  const finalRoots: Record<string, TypeRef> = {};
  for (const [name, ref] of Object.entries(roots)) finalRoots[name] = substituteRefs(ref, replace);

  return { roots: finalRoots, defs };
}

/**
 * Lower a call signature to a `types.function` TypeRef: ordered params (name +
 * type), return type, and — when the signature carries an explicit/implicit
 * `this` parameter (e.g. a class method, where it resolves to
 * `types.instance(className, source)`) — `thisType`. Free functions with no
 * `this` parameter omit it.
 */
function functionRefFromSignature(
  sig: ts.Signature,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  registry: SharingRegistry | undefined,
  budget: Budget,
): TypeRef {
  const params = sig.getParameters().map((param) => ({
    name: param.name,
    type: typeRefFromType(
      checker.getTypeOfSymbolAtLocation(param, loc),
      checker,
      loc,
      seen,
      registry,
      budget,
    ),
  }));
  const returnType = typeRefFromType(sig.getReturnType(), checker, loc, seen, registry, budget);
  const thisParam = sig.thisParameter;
  const thisType = thisParam
    ? typeRefFromType(
        checker.getTypeOfSymbolAtLocation(thisParam, loc),
        checker,
        loc,
        seen,
        registry,
        budget,
      )
    : undefined;
  return t(types.function(params, returnType, thisType));
}

/**
 * Lower all call signatures of a callable type to `types.function` TypeRefs.
 * TypeScript represents an overloaded function as an intersection of its call
 * signatures (`((A) => X) & ((B) => Y)`), so more than one signature wraps as
 * `types.intersection([fn1, fn2, …])` — one member per overload. A single
 * signature (the common case) produces a bare `types.function(...)`, no
 * intersection wrapper. `seen` is shared across all signatures of the same
 * overload set (they're siblings on the same type-position, not a recursion
 * chain, but sharing avoids re-descending a type already seen via another
 * overload).
 */
function functionRefFromSignatures(
  sigs: readonly ts.Signature[],
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  registry: SharingRegistry | undefined,
  budget: Budget,
): TypeRef {
  const refs = sigs.map((sig) =>
    functionRefFromSignature(sig, checker, loc, seen, registry, budget),
  );
  return refs.length === 1 ? refs[0]! : t(types.intersection(refs));
}

/**
 * Lower a class method's call signature to a `types.method` TypeRef (not
 * `types.function` — a method belongs to the class's contract, not a
 * standalone callable; see type-ir's TypeKinds.method doc comment).
 * `thisType` is always the class's own `types.instance` ref, passed in
 * explicitly rather than read off `sig.thisParameter` — a method's `this` is
 * always its declaring class, whether or not the signature carries an
 * explicit `this` parameter.
 */
function methodRefFromSignature(
  sig: ts.Signature,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  thisType: TypeRef,
  registry: SharingRegistry | undefined,
  budget: Budget,
): TypeRef {
  const params = sig.getParameters().map((param) => ({
    name: param.name,
    type: typeRefFromType(
      checker.getTypeOfSymbolAtLocation(param, loc),
      checker,
      loc,
      seen,
      registry,
      budget,
    ),
  }));
  const returnType = typeRefFromType(sig.getReturnType(), checker, loc, seen, registry, budget);
  return t(types.method(params, returnType, thisType));
}

/**
 * Lower all call signatures of a class method (overloads) to `types.method`
 * TypeRefs, wrapped in `types.intersection` when there's more than one — same
 * overload-as-intersection convention as `functionRefFromSignatures`, applied
 * to the method kind instead of the standalone-function kind.
 */
function methodRefFromSignatures(
  sigs: readonly ts.Signature[],
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  thisType: TypeRef,
  registry: SharingRegistry | undefined,
  budget: Budget,
): TypeRef {
  const refs = sigs.map((sig) =>
    methodRefFromSignature(sig, checker, loc, seen, thisType, registry, budget),
  );
  return refs.length === 1 ? refs[0]! : t(types.intersection(refs));
}

/**
 * A class's method surface as a `Record<name, TypeRef>` (each a
 * `types.method`), for building a `types.interface` alongside the class's
 * `types.instance`. A property counts as a method when its own declaration is
 * a `ts.MethodDeclaration`, OR — for arrow-function class properties (`foo =
 * (x: number) => void`, declared as a `PropertyDeclaration`, not a
 * `MethodDeclaration`) — when its resolved type carries a call signature.
 * Private/protected members are skipped (the method surface is public API,
 * same convention as the object-field extraction loop below).
 */
function methodsFromClassType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  thisType: TypeRef,
  registry: SharingRegistry | undefined,
  budget: Budget,
): Record<string, TypeRef> {
  const methods: Record<string, TypeRef> = {};
  for (const prop of checker.getPropertiesOfType(type)) {
    if (isPrivateOrProtected(prop)) continue;
    if (isSymbolKeyedProp(prop)) continue;
    const isMethodDecl = (prop.declarations ?? []).some(ts.isMethodDeclaration);
    const propType = checker.getTypeOfSymbolAtLocation(prop, loc);
    const sigs = checker.getSignaturesOfType(propType, ts.SignatureKind.Call);
    if (!isMethodDecl && sigs.length === 0) continue;
    if (sigs.length === 0) continue;
    methods[prop.name] = methodRefFromSignatures(
      sigs,
      checker,
      loc,
      seen,
      thisType,
      registry,
      budget,
    );
  }
  return methods;
}

/**
 * True for a symbol-keyed property (`escapedName` starting `__@`, TS's
 * internal spelling for a `unique symbol`-keyed member — see
 * `isRefinementTagProp`'s doc comment below for the same prefix check used
 * to recognize a specific symbol-keyed marker). General filter: every
 * symbol-keyed property — brand/refinement tags, well-known Symbols
 * (`Symbol.iterator`/`Symbol.dispose`/`Symbol.asyncIterator`/
 * `Symbol.toStringTag`/…), or any other `unique symbol` key — is excluded
 * from the plain object-field/method-surface walk below.
 *
 * Two independent reasons, either alone sufficient:
 *   1. A JSON payload can never carry a symbol key, so a symbol-keyed
 *      property is never part of the shape an AOT validator checks against
 *      real decoded input, regardless of what type declares it.
 *   2. `prop.name` for a well-known-Symbol-keyed property is TS's own
 *      internal synthetic spelling (`"__@iterator@8"`,
 *      `"__@dispose@46197"`, …), not a usable property name at all: it
 *      contains `@`, so a codegen consumer emitting it as a bare object-type
 *      field name (`{ __@iterator@8: … }`) produces a TypeScript syntax
 *      error, not just a semantically-useless field. This is reachable via
 *      TS/DOM builtin types now that the call-budget circuit breaker (above)
 *      lets extraction terminate into their structure instead of
 *      overflowing the stack before ever reaching this loop — `Uint8Array`'s
 *      `[Symbol.iterator]`/`[Symbol.toStringTag]`, `ReadableStream`'s
 *      `[Symbol.dispose]`, etc.
 *
 * Brand/refinement-tag symbol-keyed properties never reach this loop in the
 * first place — they're consumed by `typeRefFromBrandedIntersection` before
 * the intersection's base type's own properties are walked here — but this
 * filter is correct and needed independently of that, for every other
 * symbol-keyed property no intersection classification consumes.
 */
function isSymbolKeyedProp(prop: ts.Symbol): boolean {
  return prop.escapedName.toString().startsWith("__@");
}

/** True for symbols with at least one private/protected declaration. */
function isPrivateOrProtected(prop: ts.Symbol): boolean {
  return (prop.declarations ?? []).some((decl) => {
    const mods = ts.getCombinedModifierFlags(decl as ts.Declaration & { kind: ts.SyntaxKind });
    return (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
  });
}

/** True for symbols with at least one `readonly`-modified declaration. */
function isReadonly(prop: ts.Symbol): boolean {
  return (prop.declarations ?? []).some((decl) => {
    const mods = ts.getCombinedModifierFlags(decl as ts.Declaration & { kind: ts.SyntaxKind });
    return (mods & ts.ModifierFlags.Readonly) !== 0;
  });
}

/**
 * A property symbol's own JSDoc comment (the `/** … *\/` text, excluding
 * `@tag` lines), flattened to a single trimmed string. Uses
 * `Symbol.getDocumentationComment`, the TS compiler API's dedicated
 * accessor for a symbol's doc comment.
 */
function propertyDescriptionOf(prop: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  const text = ts.displayPartsToString(prop.getDocumentationComment(checker)).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * A property symbol's `@default` JSDoc tag value, if present. The tag text
 * is parsed as JSON first (`@default 10` → `10`, `@default true` → `true`,
 * `@default "x"` → `"x"`) so numeric/boolean defaults come through typed;
 * text that isn't valid JSON (`@default someValue`) is kept as a raw string.
 */
function propertyDefaultOf(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
): string | number | boolean | undefined {
  for (const tag of prop.getJsDocTags(checker)) {
    if (tag.name !== "default") continue;
    const text = tag.text ? ts.displayPartsToString(tag.text).trim() : "";
    if (text.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
        return parsed;
      }
      return text;
    } catch {
      return text;
    }
  }
  return undefined;
}

/**
 * JSDoc tag names carrying a refinement constraint, split by how their raw
 * tag text is parsed. Numeric tags (`@minLength 2`) parse via `Number(...)`;
 * string tags (`@pattern "^[a-z]+$"`/`@format email`) keep the raw text with
 * one layer of surrounding quotes stripped, if present. These are exactly
 * the meta keys `compile.ts` already validates and every projector
 * (json-schema, effect-schema, sql, …) already reads — see
 * `packages/type-ir/src/compile.ts` and `packages/type-ir/src/sql.ts`'s
 * shared refinement-key comment.
 */
const NUMERIC_REFINEMENT_TAGS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const STRING_REFINEMENT_TAGS = new Set(["pattern", "format"]);

/** Strip one layer of matching surrounding quotes (`"…"` or `'…'`), if present. */
function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * A property symbol's refinement-related JSDoc tags (`@minLength`/
 * `@maxLength`/`@pattern`/`@format`/`@minimum`/`@maximum`/
 * `@exclusiveMinimum`/`@exclusiveMaximum`/`@multipleOf`), read the same way
 * as `@default` in `propertyDefaultOf` above: `Symbol.getJsDocTags`, one meta
 * entry per recognized tag present on the property. Numeric tags with
 * non-numeric/empty text are skipped rather than producing `NaN` in the meta
 * bag. Unrecognized tag names are ignored — this reads only the refinement
 * vocabulary `compile.ts` already validates, nothing broader.
 */
function propertyRefinementMetaOf(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const tag of prop.getJsDocTags(checker)) {
    const text = tag.text ? ts.displayPartsToString(tag.text).trim() : "";
    if (text.length === 0) continue;
    if (NUMERIC_REFINEMENT_TAGS.has(tag.name)) {
      const n = Number(text);
      if (!Number.isNaN(n)) meta[tag.name] = n;
    } else if (STRING_REFINEMENT_TAGS.has(tag.name)) {
      meta[tag.name] = unquote(text);
    }
  }
  return meta;
}

/** Property names conventionally used to tag a branded/opaque type. */
const BRAND_PROP_NAMES = ["__brand", "__tag", "_brand", "_tag"];

/**
 * Brand names (matched case-insensitively — `"UUID"`/`"Uuid"`/`"uuid"` all
 * hit the same entry) that promote to a real IR kind instead of degrading to
 * `t(types.string, { brand: "..." })`. See `promoteBrand` below and
 * type-ir's `kinds/semantic-strings.ts` (source of the canonical
 * `Uuid`/`Uri`/`Email` brand types a consumer authors against).
 */
const BRAND_KIND_CTORS: Record<string, (meta?: Record<string, unknown>) => TypeRef> = {
  uuid,
  uri,
  email,
};

/**
 * Promote a recognized brand to its IR kind, e.g. `string & { __brand: "uuid" }`
 * → `types.uuid` instead of `t(types.string, { brand: "uuid" })`. Only
 * applies when the base shape is `string` — every current brand-promotable
 * kind (uuid/uri/email) subtypes `string`, so a brand recognized over a
 * non-string base (a mismatched or unrelated tag reuse) is left as an
 * ordinary `meta.brand` annotation on its own base shape, never coerced.
 * Returns `undefined` for an unrecognized brand name, letting the caller
 * fall through to the plain `meta.brand` behavior.
 */
function promoteBrand(baseRef: TypeRef, brandValue: string): TypeRef | undefined {
  if (baseRef.shape.kind !== "string") return undefined;
  const ctor = BRAND_KIND_CTORS[brandValue.toLowerCase()];
  if (!ctor) return undefined;
  return ctor(baseRef.meta);
}

/**
 * Derive a brand name from a `unique symbol`-keyed brand property, e.g.
 * `declare const LocationIdBrand: unique symbol; type LocationId = string &
 * { readonly [LocationIdBrand]: never }`.
 *
 * Unlike the string-literal-tag pattern (`{ readonly __brand: "LocationId" }`),
 * there is no literal value to read — the symbol IS the tag, and the property's
 * value type is typically `never`. The brand name is instead read off the
 * `unique symbol` declaration's own identifier (`LocationIdBrand`), with a
 * trailing `Brand` suffix stripped for consistency with the string-literal-tag
 * convention (whose tag values are bare names like `"LocationId"`, not
 * `"LocationIdBrand"`). Returns `undefined` if the property isn't a computed
 * property name, or its expression doesn't resolve to a named symbol.
 */
function brandNameFromSymbolKeyedProp(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
): string | undefined {
  const decl = prop.declarations?.[0];
  if (!decl) return undefined;
  const nameNode = (decl as ts.NamedDeclaration).name;
  if (!nameNode || !ts.isComputedPropertyName(nameNode)) return undefined;
  const sym = checker.getSymbolAtLocation(nameNode.expression);
  if (!sym?.name) return undefined;
  return sym.name.endsWith("Brand") ? sym.name.slice(0, -"Brand".length) : sym.name;
}

/**
 * Extract a literal's runtime value (string/number/boolean) from a resolved
 * `ts.Type`, or `undefined` if `type` isn't a literal. Booleans don't carry
 * `.value` on `ts.LiteralType` — they're read via `intrinsicName` instead
 * (mirrors the top-of-`typeRefFromType` literal handling).
 */
function literalValueOf(type: ts.Type): string | number | boolean | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral) return (type as ts.LiteralType).value as string;
  if (type.flags & ts.TypeFlags.NumberLiteral) return (type as ts.LiteralType).value as number;
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true";
  }
  return undefined;
}

/**
 * True for a symbol-keyed property (`escapedName` starting `__@`, TS's
 * internal spelling for a `unique symbol`-keyed member) whose `unique
 * symbol` declaration is specifically named `RefinementTag` — the shared
 * marker every refinement-tag type in `kinds/refinements.ts` carries its
 * value under. Mirrors `brandNameFromSymbolKeyedProp`'s "read the tag off
 * the symbol declaration's own identifier" move, but confirms identity (is
 * this the refinement marker, as opposed to a brand's `BrandTag` or some
 * unrelated symbol-keyed member?) rather than deriving a brand name from it.
 * Declared ahead of `classifyIntersectionConstituent` so that function can
 * skip refinement-tag props instead of misreading one as an (unrecognized)
 * brand: `RefinementTag`'s value type is a literal-bearing object, not a
 * plain string literal or `never`, so left unchecked it would otherwise fall
 * into `brandNameFromSymbolKeyedProp`'s "no literal value" branch and read
 * the symbol's own name (`"RefinementTag"`) as a bogus brand.
 */
function isRefinementTagProp(prop: ts.Symbol, checker: ts.TypeChecker): boolean {
  if (!prop.escapedName.toString().startsWith("__@")) return false;
  const decl = prop.declarations?.[0];
  if (!decl) return false;
  const nameNode = (decl as ts.NamedDeclaration).name;
  if (!nameNode || !ts.isComputedPropertyName(nameNode)) return false;
  const sym = checker.getSymbolAtLocation(nameNode.expression);
  return sym?.name === "RefinementTag";
}

/** The meta keys a refinement tag's value-object properties are read from — see `kinds/refinements.ts`. */
const REFINEMENT_KEYS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;

/**
 * Read a single intersection constituent's refinement contribution, if it's
 * one of the branded refinement-tag types from `kinds/refinements.ts`
 * (`MinLength<2>`, `Pattern<"^[a-z]+$">`, …). Each such type compiles to
 * `{ readonly [RefinementTag]: { <key>: <literal> } }` — a `unique
 * symbol`-keyed property (phantom, structurally inaccessible at runtime —
 * same shape as a symbol-keyed brand, see `brandNameFromSymbolKeyedProp`'s
 * doc comment) whose value is itself typed as a literal-bearing object.
 * Reads the literal value off every key in `REFINEMENT_KEYS` present on that
 * inner object type. Returns `undefined` when the constituent carries no
 * `RefinementTag`-keyed property, or when it does but no recognized key on
 * it resolves to a literal — i.e. this constituent isn't a refinement tag
 * at all.
 */
function refinementMetaOfConstituent(
  constituent: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): Record<string, unknown> | undefined {
  const tagProp = checker
    .getPropertiesOfType(constituent)
    .find((p) => isRefinementTagProp(p, checker));
  if (!tagProp) return undefined;
  const tagType = checker.getTypeOfSymbolAtLocation(tagProp, loc);
  if ((tagType.flags & ts.TypeFlags.Object) === 0) return undefined;

  const meta: Record<string, unknown> = {};
  for (const key of REFINEMENT_KEYS) {
    const prop = tagType.getProperty(key);
    if (!prop) continue;
    const value = literalValueOf(checker.getTypeOfSymbolAtLocation(prop, loc));
    if (value !== undefined) meta[key] = value;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * How a single intersection constituent classifies for
 * `typeRefFromBrandedIntersection` below: a refinement-tag value-object
 * (contributes meta entries), a brand tag (contributes a brand name), or
 * neither — a genuine base-shape constituent.
 */
type IntersectionConstituentKind =
  | { kind: "refinement"; meta: Record<string, unknown> }
  | { kind: "brand"; value: string }
  | { kind: "base" };

/**
 * Classify one constituent of an intersection as a refinement tag, a brand
 * tag, or a base-shape constituent — the per-constituent building block
 * `typeRefFromBrandedIntersection` walks the whole intersection with.
 *
 * Refinement check runs first, via `refinementMetaOfConstituent`. Brand
 * detection examines a single constituent: only object-flagged constituents
 * are examined (a primitive constituent — `string`, `number`, … — carries
 * its own symbol-keyed properties, e.g. `Symbol.iterator`, that would
 * otherwise spuriously match), and a refinement-tag property is skipped so
 * it isn't misread as an (unrecognized) brand. Named tags (`__brand`/`__tag`/
 * …) and shared-symbol tags carry the brand name as a string-literal
 * property value; a symbol-keyed tag with no literal value (typically
 * `never`) falls back to the `unique symbol` declaration's own identifier.
 */
function classifyIntersectionConstituent(
  constituent: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
): IntersectionConstituentKind {
  const refinementMeta = refinementMetaOfConstituent(constituent, checker, loc);
  if (refinementMeta) return { kind: "refinement", meta: refinementMeta };

  if (constituent.flags & ts.TypeFlags.Object) {
    for (const prop of checker.getPropertiesOfType(constituent)) {
      const isSymbolKeyed = prop.escapedName.toString().startsWith("__@");
      const isNamedBrand = BRAND_PROP_NAMES.includes(prop.name);
      if (!isSymbolKeyed && !isNamedBrand) continue;
      if (isSymbolKeyed && isRefinementTagProp(prop, checker)) continue;

      const propType = checker.getTypeOfSymbolAtLocation(prop, loc);
      const brandValue =
        propType.flags & ts.TypeFlags.StringLiteral
          ? ((propType as ts.LiteralType).value as string)
          : isSymbolKeyed
            ? brandNameFromSymbolKeyedProp(prop, checker)
            : undefined;
      if (brandValue !== undefined) return { kind: "brand", value: brandValue };
    }
  }

  return { kind: "base" };
}

/**
 * Detect a brand tag and/or one-or-more refinement tags intersected with a
 * single base type — e.g. `string & { __brand: "LocationId" }`, `string &
 * MinLength<2> & MaxLength<100>`, or both combined, `Email & MinLength<5>`
 * (which itself expands to `string & { [BrandTag]: "email" } &
 * { [RefinementTag]: { minLength: 5 } }`, three constituents). Any
 * combination of base type, brand tag, and refinement tags in a single
 * intersection collapses here, whether brand-only, refinement-only, or both
 * together.
 *
 * Walks every constituent via `classifyIntersectionConstituent`: refinement
 * tags merge their value objects into one meta bag; a brand tag's name is
 * recorded (first one found wins — a second brand-shaped constituent is
 * treated as an unrecognized base rather than silently dropped, so it makes
 * the base count ambiguous and the whole intersection falls through instead
 * of guessing which brand is real); everything else is a candidate base
 * type. Returns `undefined` — falling through to plain structural
 * `types.intersection` handling — when there's no brand and no refinement
 * (nothing recognized here) or when more than one constituent is left over
 * as a base (an ambiguous/genuine structural intersection, e.g. a mixin
 * pattern that happens to carry no brand or refinement tag at all).
 *
 * When recognized: the base type is extracted recursively; a brand promotes
 * via `promoteBrand` (known kind name over a `string` base) or falls back to
 * plain `meta.brand`; refinement meta merges on top of whichever of those
 * produced the working TypeRef, so brand promotion and refinement meta
 * compose (`Email & MinLength<5>` → `t(types.email, { minLength: 5 })`).
 */
function typeRefFromBrandedIntersection(
  type: ts.IntersectionType,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  registry: SharingRegistry | undefined,
  budget: Budget,
): TypeRef | undefined {
  const bases: ts.Type[] = [];
  const refinementMeta: Record<string, unknown> = {};
  let brandValue: string | undefined;

  for (const constituent of type.types) {
    const classified = classifyIntersectionConstituent(constituent, checker, loc);
    if (classified.kind === "refinement") {
      Object.assign(refinementMeta, classified.meta);
    } else if (classified.kind === "brand" && brandValue === undefined) {
      brandValue = classified.value;
    } else {
      bases.push(constituent);
    }
  }

  if (brandValue === undefined && Object.keys(refinementMeta).length === 0) return undefined;
  if (bases.length !== 1) return undefined;

  const nextSeen = new Set(seen).add(type);
  const baseRef = typeRefFromType(bases[0]!, checker, loc, nextSeen, registry, budget);

  const branded =
    brandValue !== undefined
      ? (promoteBrand(baseRef, brandValue) ??
        t(baseRef.shape, { ...baseRef.meta, brand: brandValue }))
      : baseRef;

  return Object.keys(refinementMeta).length > 0
    ? t(branded.shape, { ...branded.meta, ...refinementMeta })
    : branded;
}

/**
 * Lower a resolved `ts.Type` to a TypeRef.
 *
 * Handles the obvious cases; punts everything else to `t(types.unknown, …)`
 * carrying a `$comment` naming the case. `loc` anchors symbol-type resolution.
 *
 * `seen` tracks the chain of object-like types currently being descended
 * (ancestors on this recursion path only — siblings don't share it). Re-entering
 * a type already on the path means the type is recursive; it lowers to
 * `t(types.ref(name))` when a name is recoverable, else punts.
 *
 * `registry` is optional; every existing caller omits it, which disables
 * structural sharing entirely (see the "Structural sharing" section above).
 * Supplying it opts into sharing: a named type (`shareableTypeName`) is
 * extracted to `registry.defs` under a unique name on first encounter and
 * returned as `{ kind: "ref", target: name }` on every encounter, first or
 * not — including nested occurrences (a field typed `Address` shares just as
 * readily as the op's own top-level input type). `finalizeSharedDefs` runs
 * after the whole extraction pass (every leaf, not just one) to decide which
 * shared names are worth keeping shared (per the caller's `ShouldShare`
 * predicate) versus inlining back — self-recursive names are never inlined,
 * everything else is a genuine choice.
 */
export function typeRefFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type> = new Set(),
  registry?: SharingRegistry,
  budget: Budget = { calls: 0 },
): TypeRef {
  budget.calls++;
  if (budget.calls > MAX_TYPE_REF_CALLS) {
    return puntRef(
      "extraction call budget exceeded — likely reached a generically self-referential " +
        "TS/DOM built-in library type (e.g. Response/ReadableStream/ReadableStreamReader) " +
        "whose mutually overloaded methods resolve to fresh, non-identical ts.Type " +
        "instances on every visit, so seen-based identity cycle detection never fires",
    );
  }
  if (seen.has(type)) {
    const registered = registry?.names.get(type);
    const typeName = registered ?? type.aliasSymbol?.name ?? type.symbol?.name;
    if (registry && typeName) {
      registry.recursive.add(typeName);
      bumpUseCount(registry, typeName);
    }
    return typeName ? t(types.ref(typeName)) : puntRef("recursive type");
  }

  if (registry) {
    const shareName = shareableTypeName(type);
    if (shareName) {
      const existing = registry.names.get(type);
      if (existing !== undefined) {
        bumpUseCount(registry, existing);
        return t(types.ref(existing));
      }
      const assignedName = uniqueRegistryName(registry, shareName);
      registry.names.set(type, assignedName);
      bumpUseCount(registry, assignedName);
      const nextSeen = new Set(seen).add(type);
      const bodyRef = typeRefFromTypeStructural(type, checker, loc, nextSeen, registry, budget);
      registry.defs.set(assignedName, bodyRef);
      return t(types.ref(assignedName));
    }
  }

  return typeRefFromTypeStructural(type, checker, loc, seen, registry, budget);
}

function typeRefFromTypeStructural(
  type: ts.Type,
  checker: ts.TypeChecker,
  loc: ts.Node,
  seen: Set<ts.Type>,
  registry: SharingRegistry | undefined,
  budget: Budget,
): TypeRef {
  const flags = type.flags;

  // ── Literals (checked before the widening StringLike/NumberLike/BooleanLike
  //    checks below, else `"active"` widens to plain `string`) ───────────────
  if (flags & ts.TypeFlags.StringLiteral) {
    return t(types.literal((type as ts.LiteralType).value as string));
  }
  if (flags & ts.TypeFlags.NumberLiteral) {
    return t(types.literal((type as ts.LiteralType).value as number));
  }
  if (flags & ts.TypeFlags.BooleanLiteral) {
    const isTrue = (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true";
    return t(types.literal(isTrue));
  }

  // ── Primitives ────────────────────────────────────────────────────────────
  if (flags & ts.TypeFlags.StringLike) return t(types.string);
  if (flags & ts.TypeFlags.NumberLike) return t(types.number);
  if (flags & ts.TypeFlags.BooleanLike) return t(types.boolean);
  // `void` is reachable here via a callable's return type
  // (`functionRefFromSignature`); object/param extraction never produces it
  // directly.
  if (flags & ts.TypeFlags.Void) return t(types.void);
  if (flags & ts.TypeFlags.Null) return t(types.null);

  // ── Page<T>/CursorPage<T>/OffsetPage<T> (an api-tree pagination
  //    convention: a handler returning one of these shapes signals "this
  //    endpoint is paginated," the same convention role AsyncIterable plays
  //    for `stream` — see the Object-types section below). Checked here,
  //    before the tuple/array/union branches, via `aliasSymbol`: the alias
  //    name survives regardless of whether the aliased type resolves
  //    structurally to a plain object (`CursorPage<T>`/`OffsetPage<T>`) or a
  //    union (`Page<T> = CursorPage<T> | OffsetPage<T>`), and checking it
  //    early (rather than only inside the object-types branch) is what
  //    catches the union case before `type.isUnion()` below claims it first
  //    and flattens it to a structural `union` TypeRef, losing the
  //    pagination signal. `CursorPage`/`OffsetPage` resolve to their own
  //    literal style directly; the general `Page<T>` alias is ambiguous
  //    between the two (a handler typed with the reader-facing union, not
  //    one concrete variant) and defaults to `"cursor"`, the more common
  //    convention of the two. ──────────
  if (
    type.aliasSymbol &&
    (type.aliasSymbol.name === "CursorPage" ||
      type.aliasSymbol.name === "OffsetPage" ||
      type.aliasSymbol.name === "Page")
  ) {
    const nextSeen = new Set(seen).add(type);
    const [elem] = type.aliasTypeArguments ?? [];
    const style = type.aliasSymbol.name === "OffsetPage" ? "offset" : "cursor";
    return t(
      types.page(
        elem
          ? typeRefFromType(elem, checker, loc, nextSeen, registry, budget)
          : puntRef("unknown page element"),
        style,
      ),
    );
  }

  // ── Tuples (checked before isArrayType — tuples fail that check and would
  //    otherwise fall through to the object branch as `{"0":…,"1":…,"length":…}`) ──
  if (checker.isTupleType(type)) {
    const nextSeen = new Set(seen).add(type);
    const elements = checker.getTypeArguments(type as ts.TypeReference);
    return t(
      types.tuple(
        elements.map((el) => typeRefFromType(el, checker, loc, nextSeen, registry, budget)),
      ),
    );
  }

  // ── Arrays (T[] / Array<T>) ───────────────────────────────────────────────
  if (checker.isArrayType(type)) {
    const nextSeen = new Set(seen).add(type);
    const [elem] = checker.getTypeArguments(type as ts.TypeReference);
    return t(
      types.array(
        elem
          ? typeRefFromType(elem, checker, loc, nextSeen, registry, budget)
          : puntRef("unknown array element"),
      ),
    );
  }

  // ── Unions: TS enums + literal unions lower to enum/literal-union shapes;
  //    everything else genuinely structural still punts ─────────────────────
  //
  // (optional `| undefined` is stripped upstream, so a surviving union here is
  // either a TS enum (which the checker resolves to a union of its member
  // literals), a hand-written literal union (`"a" | "b"`), or a genuine union
  // of non-literal types.)
  if (type.isUnion()) {
    const members = type.types;

    // `true | false` collapses to the intrinsic `boolean` type before this
    // point (TS's `getUnionType` singleton-izes it, so `flags & BooleanLike`
    // above already catches it) — this check is a defensive backstop in case
    // a differently-constructed union of the two boolean literals reaches here.
    if (
      members.length === 2 &&
      members.every((m) => (m.flags & ts.TypeFlags.BooleanLiteral) !== 0)
    ) {
      const names = new Set(
        members.map((m) => (m as ts.Type & { intrinsicName?: string }).intrinsicName),
      );
      if (names.has("true") && names.has("false")) return t(types.boolean);
    }

    const allStringLiteral = members.every((m) => (m.flags & ts.TypeFlags.StringLiteral) !== 0);
    if (allStringLiteral) {
      return t(types.enum(members.map((m) => (m as ts.LiteralType).value as string)));
    }

    const isLiteralMember = (m: ts.Type): boolean =>
      (m.flags &
        (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)) !==
      0;

    // All-number-literal (numeric TS enums) and mixed-literal unions both
    // lower the same way: a union of `types.literal(...)` TypeRefs — the IR's
    // `enum` kind is `readonly string[]` only, so numeric/mixed cases use
    // `types.union` of literals instead.
    if (members.every(isLiteralMember)) {
      return t(
        types.union(members.map((m) => typeRefFromType(m, checker, loc, seen, registry, budget))),
      );
    }

    // ── Object-like unions: lower to `types.union([...variants])`, each
    //    variant a full object TypeRef. When every variant shares a field
    //    name whose value is a distinct literal, that field is the
    //    discriminator — recorded as `meta.discriminator` (open metadata bag,
    //    see the design-philosophy doc: open metadata over fixed schema).
    //    Discriminator-aware projectors (OpenAPI 3.0's native
    //    `discriminator`, Zod's `discriminatedUnion`, Valibot's `variant`)
    //    read it; others ignore it and just emit a plain union. A union with
    //    no shared discriminator field still lowers this way (no
    //    `meta.discriminator`) — only a union with a non-object-like variant
    //    (primitive, array, callable, …) genuinely punts below.
    const isObjectLikeMember = (m: ts.Type): boolean =>
      !m.isUnion() &&
      !m.isIntersection() &&
      (m.flags & ts.TypeFlags.Object) !== 0 &&
      !checker.isArrayType(m) &&
      !checker.isTupleType(m) &&
      checker.getSignaturesOfType(m, ts.SignatureKind.Call).length === 0 &&
      checker.getSignaturesOfType(m, ts.SignatureKind.Construct).length === 0;

    if (members.every(isObjectLikeMember)) {
      const nextSeen = new Set(seen).add(type);

      const fieldNameSets = members.map(
        (m) => new Set(checker.getPropertiesOfType(m).map((p) => p.name)),
      );
      const [firstNames] = fieldNameSets;
      const sharedNames = firstNames
        ? [...firstNames].filter((name) => fieldNameSets.every((names) => names.has(name)))
        : [];

      let discriminator: string | undefined;
      for (const name of sharedNames) {
        const seenValues = new Set<string | number | boolean>();
        const distinctLiteralOnEveryVariant = members.every((m) => {
          const prop = m.getProperty(name);
          if (!prop) return false;
          const value = literalValueOf(checker.getTypeOfSymbolAtLocation(prop, loc));
          if (value === undefined || seenValues.has(value)) return false;
          seenValues.add(value);
          return true;
        });
        if (distinctLiteralOnEveryVariant) {
          discriminator = name;
          break;
        }
      }

      const variants = members.map((m) =>
        typeRefFromType(m, checker, loc, nextSeen, registry, budget),
      );
      return t(types.union(variants), discriminator ? { discriminator } : {});
    }

    return puntRef(`union (${checker.typeToString(type)})`);
  }

  // ── Intersections: detect the branded/opaque and/or refinement-tag
  //    pattern (any combination, single base only), else lower structurally ──
  //
  // `type LocationId = string & { readonly __brand: "LocationId" }` compiles to
  // an IntersectionType of a primitive constituent and an object constituent
  // whose sole property is a brand tag (`__brand`/`__tag`/`_brand`/`_tag`, or a
  // unique symbol key); `string & MinLength<2> & MaxLength<100>` compiles to a
  // primitive constituent plus one or more `{ [RefinementTag]: {...} }`
  // constituents; `Email & MinLength<5>` combines both (three constituents:
  // base + brand tag + refinement tag). `typeRefFromBrandedIntersection`
  // walks all constituents and recognizes any of these combinations, so long
  // as exactly one constituent is left over as the base. When a brand is
  // recognized, and the brand name (case-insensitively) matches a known
  // semantic-string kind (`uuid`/`uri`/`email` — see `promoteBrand`/
  // `BRAND_KIND_CTORS` above and type-ir's `kinds/semantic-strings.ts`), it
  // lowers directly to that kind (`types.uuid`/`types.uri`/`types.email`)
  // instead of the primitive; any other brand name lowers to the base's
  // TypeRef with `meta.brand` set to the tag's literal string value — an
  // open-metadata-bag annotation that brand-aware projectors (zod,
  // typescript, valibot) read and others ignore. Refinement tags merge their
  // value-object keys into the same meta bag, composing with a recognized
  // brand or plain base alike.
  //
  // Anything else intersecting is a genuine structural intersection — the
  // mixin pattern (`HasId & HasTimestamps & UserFields`), or an intersection
  // with more than one leftover base (ambiguous). Each constituent is
  // extracted recursively and carried as `types.intersection(members)`;
  // projectors that can represent it natively (JSON Schema's `allOf`,
  // TypeScript's `&`, Zod's `z.intersection`, …) do, and the rest fall back to
  // their first member (lossy but safe — see each projector's handler).
  if (type.isIntersection()) {
    const branded = typeRefFromBrandedIntersection(type, checker, loc, seen, registry, budget);
    if (branded) return branded;
    const nextSeen = new Set(seen).add(type);
    const members = type.types.map((member) =>
      typeRefFromType(member, checker, loc, nextSeen, registry, budget),
    );
    return t(types.intersection(members));
  }

  // ── Object types: primitive/optional/array/nested fields ──────────────────
  if (flags & ts.TypeFlags.Object) {
    // Callable types (arrow/function-typed values, callback params, method
    // fields) lower to `types.function` — a real type-position shape, not a
    // punt. Constructable types (`new (...) => T`) have no IR representation
    // yet and still punt.
    const callSigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (callSigs.length > 0) {
      return functionRefFromSignatures(callSigs, checker, loc, seen, registry, budget);
    }
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) {
      return puntRef(`constructable (${checker.typeToString(type)})`);
    }

    const nextSeen = new Set(seen).add(type);

    // Promise<T> in field position: unwrap to T, same as the return-type path.
    if (type.symbol?.name === "Promise") {
      const [inner] = checker.getTypeArguments(type as ts.TypeReference);
      if (inner) return typeRefFromType(inner, checker, loc, nextSeen, registry, budget);
    }

    // AsyncIterable<T>/AsyncGenerator<T, TReturn, TNext>/AsyncIterableIterator<T>
    // (the return type of an `async function*`) all describe an
    // asynchronously-produced sequence of `T` — lower to `types.stream(T)`,
    // checked before the general object-type extraction below (same
    // early-unwrap treatment as `Promise<T>` above, so `Promise<AsyncIterable<T>>`
    // resolves correctly too: the Promise unwrap at the call site — either
    // this branch on a re-entrant field-position call, or the caller's own
    // Promise-stripping — runs first, then this branch catches the
    // AsyncIterable underneath). Only the first type argument (the yielded
    // type) is captured; `AsyncGenerator`'s `TReturn`/`TNext` have no IR
    // slot, same as `Promise<T>`'s handling above only keeping the resolved
    // value type.
    if (
      type.symbol &&
      (type.symbol.name === "AsyncIterable" ||
        type.symbol.name === "AsyncGenerator" ||
        type.symbol.name === "AsyncIterableIterator")
    ) {
      const [elem] = checker.getTypeArguments(type as ts.TypeReference);
      return t(
        types.stream(
          elem
            ? typeRefFromType(elem, checker, loc, nextSeen, registry, budget)
            : puntRef("unknown stream element"),
        ),
      );
    }

    // Set<T>/ReadonlySet<T>: checked before the general object-type properties
    // loop below for the same reason Array<T>/Tuple are special-cased earlier
    // in this function (before the Object-flag branch even starts) — Set<T>'s
    // OWN interface methods are themselves self-referential
    // (`forEach(callback: (value: T, value2: T, set: Set<T>) => void): void`,
    // whose third parameter's type resolves to the same cached `Set<T>` type
    // object as the outer type being extracted). Left unhandled, walking
    // Set<T>'s public method surface as a plain object would re-enter that
    // identical `Set<T>` type via `forEach`'s `set` parameter (or similarly
    // through other methods); the `seen` check's recursive-type fallback
    // (`type.symbol?.name`) would then name the match after the container —
    // `ref("Set")` — since `Set<T>` itself is never a named/registered type,
    // producing a dangling ref no `defs` entry ever resolves. This is the
    // container-mediated-recursion failure the array/generic-wrapper case
    // above is exempt from purely because `checker.isArrayType`/tuple checks
    // return before ever reaching this properties walk. Lowers to
    // `types.array(T)` — a Set serializes the same way an Array does (an
    // ordered sequence of elements) and type-ir has no dedicated `set` kind.
    if (type.symbol && (type.symbol.name === "Set" || type.symbol.name === "ReadonlySet")) {
      const [elem] = checker.getTypeArguments(type as ts.TypeReference);
      return t(
        types.array(
          elem
            ? typeRefFromType(elem, checker, loc, nextSeen, registry, budget)
            : puntRef("unknown set element"),
        ),
      );
    }

    // Map<K, V>/ReadonlyMap<K, V>: same rationale as Set<T> immediately above
    // — Map's own interface methods are self-referential (`set(key, value):
    // Map<K, V>`, `forEach(callback: (value: V, key: K, map: Map<K, V>) =>
    // void)`, …), so left unhandled they would recurse back into the
    // (unnamed, unregistered) `Map<K, V>` type itself via those methods'
    // parameter/return positions and emit a dangling `ref("Map")`. Lowers
    // directly to `types.map(K, V)` — the same IR kind already used for
    // plain index-signature types (`Record<K, V>`/`{ [k: string]: V }`)
    // immediately below.
    if (type.symbol && (type.symbol.name === "Map" || type.symbol.name === "ReadonlyMap")) {
      const [key, value] = checker.getTypeArguments(type as ts.TypeReference);
      return t(
        types.map(
          key
            ? typeRefFromType(key, checker, loc, nextSeen, registry, budget)
            : puntRef("unknown map key"),
          value
            ? typeRefFromType(value, checker, loc, nextSeen, registry, budget)
            : puntRef("unknown map value"),
        ),
      );
    }

    // File/Blob: the Web `File`/`Blob` binary-upload types — checked before
    // the general properties walk below, same name-based special-casing
    // style as Promise/AsyncIterable/Set/Map above. A multipart POST body
    // decodes a file field into a real runtime `File` instance
    // (`@rhi-zone/fractal-http-api-projector/decode.ts`'s
    // `parseRequestBody`), never JSON data, so there is no meaningful
    // structural JSON validation for it. The DOM lib's own declared
    // `File`/`Blob` member surface (`webkitRelativePath: string`,
    // `arrayBuffer(): Promise<ArrayBuffer>`, `slice(...): Blob`, …) also
    // does not reliably match every JS runtime's actual implementation —
    // Bun's own `File`, for instance, has no `webkitRelativePath` property
    // (`"webkitRelativePath" in new File([], "x")` is `false` on Bun) — so a
    // check/parse function built from that structural surface rejects every
    // real multipart-decoded `File` (`check` fails on the missing property),
    // and a parse-mode caller would silently reconstruct a `{}`-shaped
    // non-File value from it. This surfaced in a multipart resource-upload
    // leaf (the sibling codebase's `curriculum` slice), whose generated validator
    // rejected every real upload with `file.webkitRelativePath: missing`.
    // Lowered to `types.unknown` directly — the same opaque, always-passes,
    // pass-through treatment a genuinely non-JSON-representable field
    // already gets elsewhere (e.g. a hand-typed `condition?: unknown`
    // field). This is an intentional, recognized case, not the generic
    // unhandled-type punt path.
    if (type.symbol && (type.symbol.name === "File" || type.symbol.name === "Blob")) {
      return t(types.unknown, {
        $comment: "binary upload type (File/Blob) — not structurally validated",
      });
    }

    const properties = checker.getPropertiesOfType(type);

    // Pure index-signature types (Record<K,V>, `{ [key: string]: V }`) have no
    // own properties; this routes them to `types.map` instead of the empty
    // `types.object({})` the properties-only path would otherwise produce.
    const stringIndex = type.getStringIndexType();
    const numberIndex = type.getNumberIndexType();
    if (properties.length === 0 && (stringIndex || numberIndex)) {
      const valueType = stringIndex ?? numberIndex!;
      const keyRef = stringIndex ? t(types.string) : t(types.number);
      return t(
        types.map(keyRef, typeRefFromType(valueType, checker, loc, nextSeen, registry, budget)),
      );
    }

    // Class instances: a symbol with a ts.ClassDeclaration among its
    // declarations is a class, not a plain object literal type — lower to
    // `types.instance`, purely nominal (class name + declaring file), so
    // identity survives extraction instead of the class being flattened into
    // a bag of public fields (which would discard its methods and misrepresent
    // it as plain data). No need to walk `properties` for this case.
    const classDecl = type.symbol?.declarations?.find(ts.isClassDeclaration);
    if (classDecl && type.symbol) {
      const instanceRef = t(types.instance(type.symbol.name, classDecl.getSourceFile().fileName));

      // The class's method surface, if any, is its other half (see
      // TypeKinds.instance's doc comment in index.ts: "a class's fields are
      // only half its surface — methods are the other half"). There's no
      // separate multi-declaration output channel here (extraction yields
      // one TypeRef per type), so the `interface` TypeRef rides along as
      // `meta.interface` — an open-metadata-bag attachment rather than a new
      // return shape. `instance` itself stays purely nominal; nothing here
      // adds fields to it.
      const methods = methodsFromClassType(
        type,
        checker,
        loc,
        nextSeen,
        instanceRef,
        registry,
        budget,
      );
      if (Object.keys(methods).length > 0) {
        return t(instanceRef.shape, {
          ...instanceRef.meta,
          interface: t(types.interface(methods)),
        });
      }
      return instanceRef;
    }

    const fields: Record<string, TypeRef> = {};

    for (const prop of properties) {
      // Skip private/protected members — internal state isn't part of the
      // public data shape. (Classes themselves are handled above and never
      // reach this loop — this guards structural types that still carry
      // private/protected member symbols.)
      if (isPrivateOrProtected(prop)) continue;
      // Skip symbol-keyed members (well-known Symbols, brand/refinement
      // tags not already consumed by `typeRefFromBrandedIntersection`) —
      // see `isSymbolKeyedProp`'s doc comment for why this is correct
      // (never JSON-representable) and necessary (TS's own synthetic name
      // for these isn't valid to emit as a bare object-type field name).
      if (isSymbolKeyedProp(prop)) continue;

      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
      const readonly = isReadonly(prop);
      // Strip `| undefined` so `field?: string` lowers as a plain string —
      // except for `unknown`/`any` fields, which skip this narrowing (see
      // `packages/api-tree/src/extract.test.ts` for the regression coverage).
      //
      // `ts.Type#getNonNullableType()` applied to a field typed `unknown`
      // (or `any`) does not return `unknown` unchanged: it returns a type
      // flagged `TypeFlags.Object` with zero own properties, TS's internal
      // approximation of "unknown minus null/undefined" as the structural
      // empty-object type `{}`. Narrowing an `unknown` field this way makes
      // it lower to `types.object({})` instead of `types.unknown`, which is
      // unsafe rather than merely imprecise: `compile.ts`'s `objectValidate`
      // parse mode reconstructs its output using only the shape's own
      // declared fields, so a validator generated from `{}` discards the
      // real value and replaces it with `{}` — e.g. a real `Expr` condition
      // submitted to a wired endpoint gets silently wiped before the
      // handler ever sees it. `unknown`/`any` are already maximally
      // permissive, with nothing meaningful to strip a `| undefined` from,
      // so the non-nullable narrowing is skipped for them: the original
      // type (still `Unknown`/`Any`-flagged) passes into the recursive
      // `typeRefFromType` call below, which lowers it to `types.unknown`
      // via the ordinary punt path.
      const rawPropType = checker.getTypeOfSymbolAtLocation(prop, loc);
      const propType =
        (rawPropType.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0
          ? rawPropType
          : rawPropType.getNonNullableType();

      // Method-shaped fields (call signature) lower to `types.function` —
      // e.g. `callback: (x: number) => void` — same as any other callable
      // type position (see the call-signature branch above).
      const fieldRef = typeRefFromType(propType, checker, loc, nextSeen, registry, budget);

      // Per-field JSDoc: `/** … */` above a property → `meta.description`;
      // `@default` tag → `meta.default`. Both flow through the type-ir
      // json-schema projector's `withMeta` unchanged, surfacing in CLI
      // --help, OpenAPI specs, and MCP tool schemas.
      const description = propertyDescriptionOf(prop, checker);
      const defaultValue = propertyDefaultOf(prop, checker);
      const refinementMeta = propertyRefinementMetaOf(prop, checker);

      const extraMeta: Record<string, unknown> = { ...refinementMeta };
      if (optional) extraMeta.optional = true;
      if (readonly) extraMeta.readonly = true;
      if (description !== undefined) extraMeta.description = description;
      if (defaultValue !== undefined) extraMeta.default = defaultValue;

      fields[prop.name] =
        Object.keys(extraMeta).length > 0
          ? t(fieldRef.shape, { ...fieldRef.meta, ...extraMeta })
          : fieldRef;
    }

    return t(types.object(fields));
  }

  // ── Generic type parameters: extract the constraint, not the unresolved
  //    parameter itself. `T extends Searchable` guarantees the caller's `T`
  //    is at least shaped like `Searchable` — that's real information worth
  //    keeping instead of punting to `unknown`. `T extends string` likewise
  //    extracts `string`. An unconstrained `T` truly has no information to
  //    extract (its only guarantee is "anything"), so it stays `unknown`,
  //    with a descriptive comment naming the case instead of the generic
  //    "unsupported" punt message. Only the `extends` clause is read; a type
  //    parameter's default (`T = string`) describes what the caller may
  //    omit, not what the type guarantees, so `getDefault()` is deliberately
  //    not consulted.
  //    The constraint is lowered recursively — `T extends Record<string, V>`
  //    or `T extends OtherGeneric` both fall through this same path, so a
  //    constrained-generic constraint referencing another type parameter (or
  //    a named interface/object) resolves through the normal machinery
  //    above, `seen` included. A constraint too exotic to lower structurally
  //    (e.g. involving a conditional type) punts gracefully via the same
  //    recursive call, same as any other unhandled type.
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    if (constraint) {
      const nextSeen = new Set(seen).add(type);
      const constraintRef = typeRefFromType(constraint, checker, loc, nextSeen, registry, budget);
      return t(constraintRef.shape, { ...constraintRef.meta, generic: true });
    }
    return t(types.unknown, {
      $comment: `unconstrained generic type parameter (${checker.typeToString(type)}) — no bound to extract`,
    });
  }

  // ── Everything else (unknown, any, branded, conditional types, …) ─────────
  return puntRef(`unsupported (${checker.typeToString(type)})`);
}

/** Reasonable defaults for a build-time (not editor/language-service)
 * extraction pass, used only when `entryFile` has no discoverable
 * `tsconfig.json` — e.g. a bare fixture file outside any project. */
const FALLBACK_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
};

/**
 * Load the `CompilerOptions` a normal `tsc` invocation would use for
 * `entryFile` — walking up from its directory to find the nearest
 * `tsconfig.json` (via `ts.findConfigFile`, exactly how `tsc`/editors locate
 * a loose file's project) and resolving its full `extends` chain (via
 * `ts.parseJsonConfigFileContent`), so `paths`/`baseUrl`-based module
 * resolution — including workspace `paths` remaps — behaves identically to
 * the file's own project instead of silently diverging via a hard-coded
 * options bag. Generalizes beyond this monorepo: any consumer's own
 * `tsconfig.json` is picked up the same way.
 *
 * `noEmit`/`skipLibCheck` are forced regardless of what the discovered
 * config says, since extraction is always a read-only, single-file analysis
 * pass — never a transformer, and never needs a fully-checked lib surface —
 * even when `entryFile` happens to live under a `tsconfig.build.json`-style
 * project where the plain `tsconfig.json` sets `noEmit: false` for `tsc -b`.
 * (`findConfigFile`'s default `searchName` is `"tsconfig.json"`, so a sibling
 * `tsconfig.build.json` is never what gets picked up in the first place.)
 */
function loadCompilerOptionsForFile(entryFile: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(path.dirname(entryFile), ts.sys.fileExists);
  if (!configPath) return FALLBACK_COMPILER_OPTIONS;

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) return FALLBACK_COMPILER_OPTIONS;

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length > 0) return FALLBACK_COMPILER_OPTIONS;

  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

/** Create a read-only Program over a single entry file, resolving modules
 * exactly the way `entryFile`'s own `tsconfig.json` (if any) would.
 *
 * Pass multiple entry files (all under the same project) to get one Program
 * rooted at all of them — this matters for batch extraction. A
 * `ts.Program`'s dominant cost is parsing and binding its whole transitive
 * import closure, not the root file count: for a set of entry files that
 * share most of their dependency graph (siblings in one app, e.g.), that
 * closure is nearly the same size whether it's rooted at one file or all of
 * them (measured across one `the sibling codebase` slice's Program, ≈3.3GB peak RSS,
 * versus all 16 slices sharing one Program, also ≈3.3GB peak RSS — the union
 * of their imports barely grew). Building N separate single-root Programs in
 * a sequential batch instead pays that multi-GB parse+bind cost N times, and
 * since each `ts.Program` is a large, long-lived object graph, a
 * long-running batch process can accumulate several of them before the GC
 * reclaims the earlier ones — the failure mode `the sibling codebase`'s 16-slice
 * validator codegen script (`apps/web/scripts/codegen-fractal-validators.ts`)
 * hits without multi-root support, reaching 20+GB RSS and OOM-killing
 * unrelated processes on the host. See `build.ts`'s
 * `buildValidatorModuleSource` `program` parameter for the batch-reuse entry
 * point. */
export function createExtractorProgram(entryFile: string): ts.Program;
export function createExtractorProgram(entryFiles: readonly string[]): ts.Program;
export function createExtractorProgram(entryFile: string | readonly string[]): ts.Program {
  const files = Array.isArray(entryFile) ? entryFile : [entryFile as string];
  if (files.length === 0)
    throw new Error("createExtractorProgram: at least one entry file required");
  return ts.createProgram(files as string[], loadCompilerOptionsForFile(files[0]!));
}
