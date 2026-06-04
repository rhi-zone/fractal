// spike/iron/client.ts — typed client projection. Walks the `.meta` DATA tree.
//
// client(app) → a typed surface keyed by structural path ("/users/{id}") then
// by lowercased method, with call signatures derived from the meta tree:
//   - path params (from a route's `param` segments) → typed `params`
//   - validated body (from EndMeta.__i)             → typed `body`
//   - handler output (from EndMeta.__o)             → typed return
// In-process transport: each call builds a Request and feeds it to the SAME app
// handler (server-identical results, one code path).
//
// The client TYPE walks the meta tree. No `Route`/`Router` type is referenced —
// only `Handler` (for the app) + the DATA-descriptor meta shapes. Zero casts in
// the public type surface.

import type { Handler } from "./core.ts"
import {
  type Ctx,
  type Reply,
  toHandler,
  type ParamMeta,
  type LitMeta,
  type EndMeta,
  type ChoiceMeta,
  type PrefixMeta,
} from "./http.ts"

// ============================================================================
// TYPE-LEVEL walk → a flat record of { path → { method → sig } }. A ChoiceMeta
// branches; an EndMeta emits one keyed entry (key folded from its segs tuple);
// a PrefixMeta prepends literal segments. Recursion depth = path depth + alts —
// linear in route count, never N^2.
// ============================================================================

// fold a segment tuple into the structural key ("/users/{id}") + params record.
type KeyOf<Segs extends readonly unknown[], K extends string = ""> = Segs extends readonly [
  infer H,
  ...infer R,
]
  ? H extends LitMeta<infer V>
    ? KeyOf<R, `${K}/${V}`>
    : H extends ParamMeta<infer N, unknown>
      ? KeyOf<R, `${K}/{${N}}`>
      : K
  : NormKey<K>
type NormKey<K extends string> = K extends "" ? "/" : K

type ParamsOf<Segs extends readonly unknown[]> = {
  readonly [S in Extract<Segs[number], ParamMeta<string, unknown>> as S["name"]]: S extends ParamMeta<
    string,
    infer T
  >
    ? T
    : never
}

// Walk the meta tree. The dominant fan-out — a `choice` of N endpoints — is a
// SINGLE flat mapped type over the alt UNION (`Alts[number]`), keyed by each
// alt's structural path, NOT a length-N recursive fold. This is the load-
// bearing scale move: the cost is one mapped-type pass over N members, like a
// flat route table — never an N-deep instantiation chain (which trips TS2589).
type Walk<Meta, Pre extends string> = Meta extends ChoiceMeta<infer Alts>
  ? FlatChoice<Alts[number], Pre>
  : Meta extends PrefixMeta<infer Pre2, infer R>
    ? Walk<R, `${Pre}${PreKey<Pre2>}`>
    : Meta extends EndMeta<infer Segs, infer M, infer I, infer O>
      ? EndEntry<Pre, Segs, M, I, O>
      : Record<never, never>

// one endpoint's contribution: { "/path": { method: sig } }.
type EndEntry<Pre extends string, Segs extends readonly unknown[], M extends string, I, O> = {
  readonly [Key in `${Pre}${KeyOf<Segs>}` as NormKey<Key>]: {
    readonly [Mm in M as Lowercase<Mm>]: Sig<ParamsOf<Segs>, I, O>
  }
}

// flat-map the choice alt UNION → one keyed record. A single mapped-type pass:
// key each EndMeta alt by its structural path, value = its { method: sig }.
// (A choice of plain endpoints — the dominant case — never recurses in N. A
// nested prefix/choice alt recurses via Walk at bounded NESTING depth, not N.)
type FlatChoice<Alt, Pre extends string> = {
  readonly [A in Extract<Alt, EndMeta<readonly unknown[], string, unknown, unknown>> as AltKey<
    A,
    Pre
  >]: A extends EndMeta<infer Segs, infer M, infer I, infer O>
    ? { readonly [Mm in M as Lowercase<Mm>]: Sig<ParamsOf<Segs>, I, O> }
    : never
} & UnionToIntersection<
  Alt extends PrefixMeta<infer Pre2, infer R> ? Walk<R, `${Pre}${PreKey<Pre2>}`> : Record<never, never>
>

// the structural key an EndMeta alt contributes.
type AltKey<A, Pre extends string> = A extends EndMeta<infer Segs, string, unknown, unknown>
  ? NormKey<`${Pre}${KeyOf<Segs>}`>
  : never

type PreKey<Pre extends readonly unknown[], K extends string = ""> = Pre extends readonly [
  infer H extends string,
  ...infer R extends readonly string[],
]
  ? PreKey<R, `${K}/${H}`>
  : K

// the call signature for one endpoint: params (if any) + body (if any) → output.
type HasKeys<T> = keyof T extends never ? false : true
// EndMeta.__o already carries the reply BODY type (not the Reply wrapper).
type BodyOut<O> = Awaited<O>
type Args<P, I> = (HasKeys<P> extends true ? { readonly params: P } : Record<never, never>) &
  ([I] extends [never] ? Record<never, never> : { readonly body: I })
type Sig<P, I, O> = keyof Args<P, I> extends never
  ? () => Promise<BodyOut<O>>
  : (args: Args<P, I>) => Promise<BodyOut<O>>

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never

/** The typed client surface, derived by walking the app's `.meta` tree. */
export type Client<App> = App extends Handler<Ctx<unknown>, unknown, infer M>
  ? Walk<M, "">
  : never

// ============================================================================
// RUNTIME — mirror the type walk over the meta DATA, building the surface. Each
// leaf method builds a Request and dispatches through the SAME app handler.
// ============================================================================

export function client<App extends Handler<Ctx<unknown>, Reply | null, unknown>>(
  app: App,
): Client<App> {
  const dispatch = toHandler(app)
  const surface: Record<string, Record<string, unknown>> = {}
  build(app.meta, "", surface, dispatch)
  return surface as Client<App>
}

function build(
  meta: unknown,
  pre: string,
  surface: Record<string, Record<string, unknown>>,
  dispatch: (req: Request) => Promise<Response>,
): void {
  if (typeof meta !== "object" || meta === null) return
  const m = meta as { tag?: string }
  if (m.tag === "end") {
    const end = meta as EndMeta<
      readonly (LitMeta<string> | ParamMeta<string, unknown>)[],
      string,
      unknown,
      unknown
    >
    const k = keyFor(pre, end.segs)
    const method = end.method
    ;(surface[k] ??= {})[method.toLowerCase()] = async (args?: {
      params?: Record<string, string>
      body?: unknown
    }) => {
      const p = fillPath(k, args?.params ?? {})
      const init: RequestInit = { method }
      if (args?.body !== undefined) {
        init.body = JSON.stringify(args.body)
        init.headers = { "content-type": "application/json" }
      }
      const res = await dispatch(new Request(`http://local${p}`, init))
      return res.json()
    }
    return
  }
  if (m.tag === "prefix") {
    const pm = meta as PrefixMeta<readonly string[], unknown>
    build(pm.rest, pre + pm.pre.map((s) => `/${s}`).join(""), surface, dispatch)
    return
  }
  if (m.tag === "choice") {
    for (const alt of (meta as ChoiceMeta<readonly unknown[]>).alts) build(alt, pre, surface, dispatch)
  }
}

function keyFor(
  pre: string,
  segs: readonly (LitMeta<string> | ParamMeta<string, unknown>)[],
): string {
  let k = pre
  for (const s of segs) k += s.tag === "lit" ? `/${s.value}` : `/{${s.name}}`
  return k === "" ? "/" : k
}

// substitute {name} placeholders in the structural key with concrete params.
function fillPath(key: string, params: Record<string, string>): string {
  return key.replace(/\{([^}]+)\}/g, (_, n: string) => params[n] ?? "")
}
