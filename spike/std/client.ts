// The typed client, derived flat from `.meta`.
//
// `Client<App>` walks the app's `.meta` data tree and produces a path-keyed
// callable surface:  client["/users/{id}"].get({ params })  /  .post({ body }).
//
// Ported in spirit from spike/iron/client.ts: the dominant fan-out — a
// `path(record)` of N resources or a `choice(...)` of N endpoints — is handled
// by a single flat mapped type over the record's keys or the alt union, not an
// N-deep recursive instantiation chain. Recursion depth equals path nesting
// depth (~2-4), never route count, which keeps tsc roughly linear and avoids
// the TS2589 / quadratic blow-up that affects Hono `hc` and Eden treaty.
//
// Only `Handler` (for the app) and the data-descriptor meta shapes from meta.ts
// are referenced — no Route/Router/Node type.

import type { Handler } from "./std.ts";
import type {
  ChoiceMeta,
  MethodsMeta,
  ParamMeta,
  PathMeta,
  PrefixMeta,
  Reflected,
} from "./meta.ts";

// ============================================================================
// Type-level walk → a flat record of { "/path" : { method : sig } }.
//
//  - MethodsMeta  → one entry at the accumulated key, one prop per verb.
//  - PathMeta     → a flat map over the record's keys (not recursive in N);
//                   each key appends a literal segment and walks its inner meta.
//  - PrefixMeta   → append the literal prefix, walk inner.
//  - ParamMeta    → append "/{name}", record the param type, walk inner.
//  - ChoiceMeta   → a flat map over the alt union (Alts[number]); merge entries.
// ============================================================================

type NormKey<K extends string> = K extends "" ? "/" : K;

// the params accumulated along the path so far (a small record threaded down).
type Walk<Meta, Pre extends string, P> =
  Meta extends MethodsMeta<infer Verbs, infer IO>
    ? MethodsEntry<Pre, Verbs, IO, P>
    : Meta extends PathMeta<infer R>
      ? FlatPath<R, Pre, P>
      : Meta extends PrefixMeta<infer Pfx, infer Rest>
        ? Walk<Rest, `${Pre}/${Pfx}`, P>
        : Meta extends ParamMeta<infer N, infer T, infer Rest>
          ? Walk<Rest, `${Pre}/{${N}}`, P & { readonly [K in N]: T }>
          : Meta extends ChoiceMeta<infer Alts>
            ? FlatChoice<Alts[number], Pre, P>
            : Record<never, never>;

// one endpoint (a methods node) → { "/key": { verb: sig } }.
type MethodsEntry<
  Pre extends string,
  Verbs extends string,
  IO extends Record<string, { i: unknown; o: unknown }>,
  P,
> = {
  readonly [Key in Pre as NormKey<Key>]: VerbRec<Verbs, IO, P>;
};

// A flat map over a path record's keys — one mapped-type pass with `as` key-
// remapping (the iron move), not an N-way union+intersection. This is the
// load-bearing scale decision: the dominant shape — a `path` of N resources,
// each a `methods` leaf or a `param→methods` route — maps one record key to
// one structural key in a single mapped type, exactly like a flat route table.
// Each entry's key and value are computed locally (EntryKey/EntryVal) so the
// pass never forms a length-N intersection, which is what makes
// UnionToIntersection-of-N quadratic.
//
// Nested children (a `path`/`choice` under a key, which split one key into
// many) are the only case that recurses and intersects — and nesting depth,
// not route count, bounds that. A flat app pays zero intersection cost.
type FlatPath<R extends Record<string, unknown>, Pre extends string, P> = {
  readonly [K in keyof R & string as EntryKey<R[K], `${Pre}/${K}`>]: EntryVal<R[K], P>;
} & NestedPath<R, Pre, P>;

// the structural key a single record entry contributes (leaf/param fast path).
type EntryKey<Child, Pre extends string> =
  Child extends MethodsMeta<string, Record<string, { i: unknown; o: unknown }>>
    ? NormKey<Pre>
    : Child extends ParamMeta<
          infer N,
          unknown,
          MethodsMeta<string, Record<string, { i: unknown; o: unknown }>>
        >
      ? NormKey<`${Pre}/{${N}}`>
      : never; // nested → handled by NestedPath, excluded from the fast map

// the value (the per-verb sig record) for a leaf/param entry.
type EntryVal<Child, P> =
  Child extends MethodsMeta<infer Verbs, infer IO>
    ? VerbRec<Verbs, IO, P>
    : Child extends ParamMeta<infer N, infer T, MethodsMeta<infer Verbs, infer IO>>
      ? VerbRec<Verbs, IO, P & { readonly [K in N]: T }>
      : never;

// the only entries that need the slow recurse+intersect path: a record key whose
// child is itself a `path`/`choice`/`prefix`/`param→non-methods` (splits 1→many).
type NestedPath<R extends Record<string, unknown>, Pre extends string, P> = UnionToIntersection<
  {
    readonly [K in keyof R & string]: R[K] extends
      | MethodsMeta<string, Record<string, { i: unknown; o: unknown }>>
      | ParamMeta<string, unknown, MethodsMeta<string, Record<string, { i: unknown; o: unknown }>>>
      ? never // leaf/param fast-path handled above
      : Walk<R[K], `${Pre}/${K}`, P>;
  }[keyof R & string]
>;

// A flat map over the choice alt union — one mapped-type pass over
// `Alts[number]`, keyed by each alt. This is the load-bearing move: a choice
// of N endpoints is a single distribution over the union, not an N-deep
// recursive fold, which is what trips TS2589.
type FlatChoice<Alt, Pre extends string, P> = UnionToIntersection<
  Alt extends unknown ? Walk<Alt, Pre, P> : never
>;

// per-verb signature record for one endpoint.
type VerbRec<Verbs extends string, IO extends Record<string, { i: unknown; o: unknown }>, P> = {
  readonly [V in Verbs as Lowercase<V>]: Sig<
    P,
    V extends keyof IO ? IO[V]["i"] : never,
    V extends keyof IO ? IO[V]["o"] : unknown
  >;
};

// ---- call signature for one endpoint ---------------------------------------
type HasKeys<T> = keyof T extends never ? false : true;
type Args<P, I> = (HasKeys<P> extends true ? { readonly params: P } : Record<never, never>) &
  ([I] extends [never] ? Record<never, never> : { readonly body: I });
type Sig<P, I, O> = keyof Args<P, I> extends never
  ? () => Promise<Awaited<O>>
  : (args: Args<P, I>) => Promise<Awaited<O>>;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/** The typed client surface, derived by walking the app's `.meta` tree. */
export type Client<App> =
  App extends Reflected<infer M> ? Walk<M, "", Record<never, never>> : never;

// ============================================================================
// Runtime — mirrors the type walk over the meta data, building the surface.
// Each leaf method builds a Request and dispatches through the same app
// handler (in-process transport): server-identical results, one code path,
// no network.
// ============================================================================

/** A transport: given a synthesized Request, return a Response. The in-process
 *  one just calls the app handler in memory. Swap for a fetch-based one to hit a
 *  remote server with the identical typed surface. */
export type Transport = (req: Request) => Promise<Response>;

/** In-process transport: runs the same app handler in memory; a final `undefined`
 *  becomes a 404 (mirrors `toFetch`). */
export function inProcess(app: Handler<{}>): Transport {
  return async (req) => {
    // initialize the root params to `{}` (mirrors `toFetch`) — the app is the
    // fully-discharged root, so it carries no outstanding param obligation.
    (req as Request & { params: {} }).params = {};
    return (
      (await app(req as Request & { params: {} })) ?? new Response("Not Found", { status: 404 })
    );
  };
}

/** Build the typed client. `transport` defaults to in-process over `app`. */
export function client<App extends Reflected<unknown>>(
  app: App,
  transport: Transport = inProcess(app),
): Client<App> {
  const surface: Record<string, Record<string, unknown>> = {};
  build((app as { meta: unknown }).meta, "", surface, transport);
  return surface as Client<App>;
}

function build(
  meta: unknown,
  pre: string,
  surface: Record<string, Record<string, unknown>>,
  transport: Transport,
): void {
  if (typeof meta !== "object" || meta === null) return;
  const m = meta as { tag?: string };
  switch (m.tag) {
    case "methods": {
      const mm = meta as MethodsMeta<string, never>;
      const key = pre === "" ? "/" : pre;
      const bucket = (surface[key] ??= {});
      for (const verb of mm.verbs) {
        bucket[verb.toLowerCase()] = async (args?: {
          params?: Record<string, string>;
          body?: unknown;
        }) => {
          const p = fillPath(key, args?.params ?? {});
          const init: RequestInit = { method: verb };
          if (args?.body !== undefined) {
            init.body = JSON.stringify(args.body);
            init.headers = { "Content-Type": "application/json" };
          }
          const res = await transport(new Request(`http://local${p}`, init));
          // 204/empty bodies (e.g. auto-HEAD) → undefined; else parse JSON/text.
          const ct = res.headers.get("Content-Type") ?? "";
          if (res.status === 204) return undefined;
          return ct.includes("application/json") ? res.json() : res.text();
        };
      }
      return;
    }
    case "path": {
      const pm = meta as PathMeta<Record<string, unknown>>;
      for (const k of Object.keys(pm.routes)) {
        build(pm.routes[k], `${pre}/${k}`, surface, transport);
      }
      return;
    }
    case "prefix": {
      const pm = meta as PrefixMeta<string, unknown>;
      build(pm.rest, `${pre}/${pm.pre}`, surface, transport);
      return;
    }
    case "param": {
      const pm = meta as ParamMeta<string, unknown, unknown>;
      build(pm.rest, `${pre}/{${pm.name}}`, surface, transport);
      return;
    }
    case "choice": {
      for (const alt of (meta as ChoiceMeta<readonly unknown[]>).alts) {
        build(alt, pre, surface, transport);
      }
      return;
    }
  }
}

// substitute {name} placeholders in the structural key with concrete params.
function fillPath(key: string, params: Record<string, string>): string {
  return key.replace(/\{([^}]+)\}/g, (_, n: string) => params[n] ?? "");
}
