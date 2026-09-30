// lower(): ApiDescription (plain data) -> a `Node` tree every projector
// walks, plus the operations' types keyed by handler identity. `schemaMap`/
// `typeRefMap` then re-key those types into whichever key convention a given
// projector reads, by walking the (possibly further transformed) tree, so a
// `Node => Node` transform applied after lowering keeps every type attached
// to its operation as long as it keeps the leaf's handler.
//
// Invariants:
//   - Each operation gets its own handler function; handler identity is the
//     operation's identity from here on.
//   - A position holds at most one leaf, and a leaf never also has children
//     or a fallback. A static key and a param segment may share a parent
//     (static children win at dispatch, per `Node`).
//   - Two param segments at the same position must share a name, since a
//     `Node` position has exactly one `fallback`.

import type { TypeRef } from "@rhi-zone/fractal-type-ir";
import { toJsonSchema } from "@rhi-zone/fractal-type-ir/json-schema";
import type { ApiDescription, Operation, Segment } from "./api-description.ts";
import { addressKey } from "./api-description.ts";
import type { JsonSchema } from "./extract.ts";
import { isLeaf, readMetaBag, type Handler, type Node } from "./node.ts";
import { escapeJoin } from "./path.ts";
import type { SchemaMap, ToolTypeInfo, TypeRefMap } from "./tree.ts";

export type Lowered = {
  readonly tree: Node;
  readonly types: ReadonlyMap<Handler, ToolTypeInfo>;
  readonly defs: Readonly<Record<string, TypeRef>>;
};

export type LowerOptions = {
  /** The handler for `op`. Defaults to one that throws `UnboundOperationError`. Must return a distinct function per call. */
  readonly bind?: (op: Operation) => Handler;
};

export class UnboundOperationError extends Error {
  constructor(readonly address: string) {
    super(`operation "${address}" has no implementation bound to it`);
    this.name = "UnboundOperationError";
  }
}

type Draft = {
  handler?: Handler;
  meta: Record<string, unknown>;
  children: Map<string, Draft>;
  fallback?: { name: string; subtree: Draft };
};

const draft = (): Draft => ({ meta: {}, children: new Map() });

function descend(root: Draft, address: readonly Segment[], at: string): Draft {
  let cur = root;
  for (const seg of address) {
    if (cur.handler !== undefined) {
      throw new Error(`lower: "${at}" descends through operation position`);
    }
    if (seg.kind === "static") {
      let next = cur.children.get(seg.name);
      if (next === undefined) {
        next = draft();
        cur.children.set(seg.name, next);
      }
      cur = next;
    } else {
      if (cur.fallback === undefined) cur.fallback = { name: seg.name, subtree: draft() };
      else if (cur.fallback.name !== seg.name) {
        throw new Error(
          `lower: "${at}" names a param "${seg.name}" where another address already names "${cur.fallback.name}"`,
        );
      }
      cur = cur.fallback.subtree;
    }
  }
  return cur;
}

function freeze(d: Draft): Node {
  const children =
    d.children.size > 0
      ? Object.fromEntries([...d.children].map(([k, v]) => [k, freeze(v)]))
      : undefined;
  return {
    ...(d.handler !== undefined ? { handler: d.handler } : {}),
    ...(children !== undefined ? { children } : {}),
    ...(d.fallback !== undefined
      ? { fallback: { name: d.fallback.name, subtree: freeze(d.fallback.subtree) } }
      : {}),
    meta: d.meta,
  };
}

export function lower(api: ApiDescription, opts: LowerOptions = {}): Lowered {
  const root = draft();
  const typeMap = new Map<Handler, ToolTypeInfo>();

  for (const g of api.groups) {
    const node = descend(root, g.address, addressKey(g.address));
    Object.assign(node.meta, g.meta);
  }

  for (const op of api.operations) {
    const at = addressKey(op.address);
    const last = op.address[op.address.length - 1];
    if (last === undefined || last.kind !== "static") {
      throw new Error(`lower: operation address "${at}" must end in a static segment`);
    }
    const node = descend(root, op.address, at);
    if (node.handler !== undefined) {
      throw new Error(`lower: two operations share the address "${at}"`);
    }
    if (node.children.size > 0 || node.fallback !== undefined) {
      throw new Error(`lower: operation address "${at}" is also a group with children`);
    }
    const handler =
      opts.bind?.(op) ??
      ((): never => {
        throw new UnboundOperationError(at);
      });
    if (typeMap.has(handler)) {
      throw new Error(`lower: bind returned the same handler for "${at}" and another operation`);
    }
    node.handler = handler;
    Object.assign(node.meta, op.meta);
    const description = typeof op.meta.description === "string" ? op.meta.description : undefined;
    typeMap.set(handler, {
      input: op.input,
      ...(op.output !== undefined ? { output: op.output } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }

  return { tree: freeze(root), types: typeMap, defs: api.defs };
}

// ============================================================================
// Re-keying for projectors.
// ============================================================================

/**
 * How a leaf's tree position becomes a map key: child keys, with each
 * fallback rendered by `fallbackSegment(name)`, joined by `delimiter`. With
 * `namespace` set, a branch's `meta[namespace].segment` string replaces its
 * key and a leaf's `meta[namespace].name` string replaces its whole key, the
 * same overrides `walkNamedTree` callers (mcp, json-rpc) resolve names with.
 */
export type KeyConvention = {
  readonly delimiter: string;
  readonly fallbackSegment: (name: string) => string;
  readonly namespace?: string;
};

/** `a/b/:id/c`: the key `extractRouteSchemas`/`toOpenApi`'s schema lookup use (without a tree-id prefix). */
export const routeKeys: KeyConvention = { delimiter: "/", fallbackSegment: (n) => `:${n}` };

/** `a_b_id_c`: the key `extractToolSchemas`, http `generateClient`, cli and mcp (absent `meta.mcp` overrides) use. */
export const nameKeys: KeyConvention = { delimiter: "_", fallbackSegment: (n) => n };

/** Every leaf's handler with its key under `convention`. */
export function leafKeys(tree: Node, convention: KeyConvention): Map<Handler, string> {
  const out = new Map<Handler, string>();
  const override = (n: Node, field: "name" | "segment"): string | undefined => {
    if (convention.namespace === undefined) return undefined;
    const v = readMetaBag<Record<string, unknown>>(n.meta[convention.namespace])[field];
    return typeof v === "string" ? v : undefined;
  };
  const leaf = (n: Node, segs: readonly string[]): void => {
    out.set(n.handler!, override(n, "name") ?? escapeJoin(segs, convention.delimiter));
  };
  const walk = (n: Node, segs: readonly string[]): void => {
    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) leaf(child, [...segs, key]);
      else walk(child, [...segs, override(child, "segment") ?? key]);
    }
    if (n.fallback !== undefined) {
      const next = [...segs, convention.fallbackSegment(n.fallback.name)];
      const sub = n.fallback.subtree;
      if (isLeaf(sub)) leaf(sub, next);
      else walk(sub, next);
    }
  };
  walk(tree, []);
  return out;
}

/** The operations' TypeRefs keyed by `convention` over `tree` (defaults to `lowered.tree`). Leaves whose handler `lowered` doesn't know are skipped. */
export function typeRefMap(
  lowered: Lowered,
  convention: KeyConvention,
  tree: Node = lowered.tree,
): TypeRefMap {
  const out: TypeRefMap = {};
  for (const [handler, key] of leafKeys(tree, convention)) {
    const info = lowered.types.get(handler);
    if (info !== undefined) out[key] = info;
  }
  return out;
}

/** Names of every def reachable from `roots` through `ref`s, transitively. */
export function reachableDefs(
  roots: readonly TypeRef[],
  defs: Readonly<Record<string, TypeRef>>,
): Set<string> {
  const seen = new Set<string>();
  const stack: unknown[] = [...roots];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== "object" || v === null) continue;
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    const shape = (v as { shape?: { kind?: unknown; target?: unknown } }).shape;
    if (shape?.kind === "ref" && typeof shape.target === "string" && !seen.has(shape.target)) {
      seen.add(shape.target);
      const def = defs[shape.target];
      if (def !== undefined) stack.push(def);
    }
    for (const child of Object.values(v as Record<string, unknown>)) stack.push(child);
  }
  return seen;
}

/** `ref` as a self-contained JSON Schema: the defs it reaches go under `$defs`, which its `#/$defs/NAME` refs resolve against. */
export function toSelfContainedJsonSchema(
  ref: TypeRef,
  defs: Readonly<Record<string, TypeRef>>,
): JsonSchema {
  const schema = toJsonSchema(ref) as JsonSchema;
  const names = [...reachableDefs([ref], defs)].filter((n) => defs[n] !== undefined).sort();
  if (names.length === 0) return schema;
  const $defs: Record<string, unknown> = {};
  for (const n of names) $defs[n] = toJsonSchema(defs[n]!);
  return { ...schema, $defs } as JsonSchema;
}

/** The operations' JSON Schemas keyed by `convention` over `tree` (defaults to `lowered.tree`): the `SchemaMap` shape openapi, http codegen, cli and mcp take. */
export function schemaMap(
  lowered: Lowered,
  convention: KeyConvention,
  tree: Node = lowered.tree,
): SchemaMap {
  const out: SchemaMap = {};
  for (const [key, info] of Object.entries(typeRefMap(lowered, convention, tree))) {
    out[key] = {
      inputSchema: toSelfContainedJsonSchema(info.input, lowered.defs),
      ...(info.output !== undefined
        ? { outputSchema: toSelfContainedJsonSchema(info.output, lowered.defs) }
        : {}),
      ...(info.description !== undefined ? { description: info.description } : {}),
    };
  }
  return out;
}
