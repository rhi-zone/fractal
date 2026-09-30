// ApiDescription: a whole API (its operations, their addresses, their types,
// their projection metadata) as plain JSON-serializable data. This is the
// target every `from-<format>.ts` importer produces and the input `lower()`
// (lower.ts) turns into a `Node` tree plus the precomputed type maps the
// projectors accept.
//
// Invariants:
//   - Every value here is plain data: no functions, no class instances, no
//     cycles. `JSON.parse(JSON.stringify(api))` is the identity.
//   - An operation's `address` ends in a `static` segment (the operation's
//     own key). Earlier segments are its grouping path; a `param` segment is
//     a named wildcard position (lowered to a `Node.fallback`).
//   - `input` is the operation's named-params object (an `object`-kind
//     TypeRef, possibly empty). `output` is the success value; absent means
//     unknown, `void` means "no value".
//   - `meta` is the same open bag an authored `op()` leaf carries
//     (`http`, `openapi`, `graphql`, `jsonrpc`, `mcp`, `cli`, `tags`,
//     `description`, ...). Domain data (types) never lives in `meta`.
//   - `defs` is the named-type registry every `ref` TypeRef in any operation
//     resolves against.

import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { mergeMeta } from "./node.ts";

export type Segment =
  | { readonly kind: "static"; readonly name: string }
  | { readonly kind: "param"; readonly name: string };

export type Operation = {
  readonly address: readonly Segment[];
  readonly input: TypeRef;
  readonly output?: TypeRef;
  readonly meta: Readonly<Record<string, unknown>>;
};

/** Branch-position metadata (a group's description, a projector's segment override, ...) attached at `address`; `[]` is the root. */
export type Group = {
  readonly address: readonly Segment[];
  readonly meta: Readonly<Record<string, unknown>>;
};

export type ApiDescription = {
  readonly operations: readonly Operation[];
  readonly groups: readonly Group[];
  readonly defs: Readonly<Record<string, TypeRef>>;
};

/** Something in the source document an importer could not represent faithfully. `at` locates it in the source (a JSON pointer or a format-native path). */
export type Diagnostic = { readonly at: string; readonly message: string };

export type Imported = {
  readonly api: ApiDescription;
  readonly diagnostics: readonly Diagnostic[];
};

export const segment = {
  static: (name: string): Segment => ({ kind: "static", name }),
  param: (name: string): Segment => ({ kind: "param", name }),
};

/** An empty named-params input. */
export const noInput = (): TypeRef => t(types.object({}));

/** `a` followed by `b`'s operations, groups and defs. A def name present in both must denote the same value, else this throws. */
export function concatApi(a: ApiDescription, b: ApiDescription): ApiDescription {
  const defs: Record<string, TypeRef> = { ...a.defs };
  for (const [name, def] of Object.entries(b.defs)) {
    const existing = defs[name];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(def)) {
      throw new Error(`concatApi: def "${name}" is defined differently in both descriptions`);
    }
    defs[name] = def;
  }
  return {
    operations: [...a.operations, ...b.operations],
    groups: [...a.groups, ...b.groups],
    defs,
  };
}

// ============================================================================
// Transforms. Each is a plain `ApiDescription => ApiDescription` function, so
// they compose with ordinary function composition.
// ============================================================================

/**
 * Replace each operation with zero or more operations. Returning `[]` drops
 * it, `[op, { ...op, address }]` exposes it at a second address, a single
 * operation with a new `address` moves it, and one with new `meta` retags it.
 * Operations keep their relative order.
 */
export function flatMapOperations(
  api: ApiDescription,
  f: (op: Operation) => Operation | readonly Operation[],
): ApiDescription {
  const operations: Operation[] = [];
  for (const op of api.operations) {
    const r = f(op);
    if (Array.isArray(r)) operations.push(...(r as readonly Operation[]));
    else operations.push(r as Operation);
  }
  return { ...api, operations };
}

/** Same as `flatMapOperations`, over groups. */
export function flatMapGroups(
  api: ApiDescription,
  f: (group: Group) => Group | readonly Group[],
): ApiDescription {
  const groups: Group[] = [];
  for (const g of api.groups) {
    const r = f(g);
    if (Array.isArray(r)) groups.push(...(r as readonly Group[]));
    else groups.push(r as Group);
  }
  return { ...api, groups };
}

/** Deep-merge `meta` (with `mergeMeta` semantics: later wins per key, arrays concatenate) into every operation `where` accepts. */
export function patchOperations(
  api: ApiDescription,
  where: (op: Operation) => boolean,
  meta: Readonly<Record<string, unknown>>,
): ApiDescription {
  return flatMapOperations(api, (op) =>
    where(op) ? { ...op, meta: mergeMeta(op.meta, meta) as Record<string, unknown> } : op,
  );
}

/** Deep-merge `meta` into the group at `address`, adding the group when none exists there yet. */
export function patchGroup(
  api: ApiDescription,
  address: readonly Segment[],
  meta: Readonly<Record<string, unknown>>,
): ApiDescription {
  const key = addressKey(address);
  let found = false;
  const groups = api.groups.map((g) => {
    if (addressKey(g.address) !== key) return g;
    found = true;
    return { ...g, meta: mergeMeta(g.meta, meta) as Record<string, unknown> };
  });
  if (!found) groups.push({ address, meta });
  return { ...api, groups };
}

/** A stable string identity for an address: static segments by name, param segments as `{name}`, joined with `/`. Two addresses denote the same position iff their keys are equal. */
export function addressKey(address: readonly Segment[]): string {
  return address
    .map((s) =>
      s.kind === "static"
        ? s.name.replaceAll("\\", "\\\\").replaceAll("/", "\\/").replaceAll("{", "\\{")
        : `{${s.name}}`,
    )
    .join("/");
}
