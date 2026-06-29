// packages/http/src/index.ts — @rhi-zone/fractal-http
//
// A library of plain functions that render the protocol-neutral routing tree
// (from @rhi-zone/fractal-core) to a runtime dispatcher over a WHATWG `Request`,
// plus the encoders that turn a handler's `Result<T, E>` into a `Response`.
//
// Salvaged from the previous http package (rebuilt over the NEW tree, not the
// retired `.meta` walk): the `toFetch` HTTP-correctness BEHAVIOUR — 404 (no path
// match), 405 + an `Allow` header (path matches, verb doesn't, verbs unioned
// across every matching pattern), auto-HEAD-from-GET, OPTIONS → 204 + `Allow` —
// and the JSON / text response builders that become the per-construct encoders.
// The runtime adapters (`serveBun` / `serveNode`) are unchanged in ./adapter.

import {
  collect,
  match,
  toRuntime,
  type Method,
  type Node,
  type Result,
  type RuntimeNode,
  type RuntimeRouteNode,
  type Schema,
} from "@rhi-zone/fractal-core";

// ============================================================================
// Response builders / encoders — plain functions returning real Responses
// ============================================================================

export function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function text(body: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
  }
  return new Response(body, { ...init, headers });
}

export function notFound(body = "Not Found"): Response {
  return new Response(body, { status: 404 });
}

/** A 400 for an input-validation failure (a failing leaf producer). */
export function badRequest(detail: unknown): Response {
  return json({ error: "BAD_REQUEST", detail }, { status: 400 });
}

// ============================================================================
// Encoders: Result<T, E> => Response. Both are overridable defaults.
// ============================================================================

export type EncodeOk = (value: unknown) => Response;
export type EncodeErr = (error: unknown) => Response;

/** Default success encoder: JSON 200. */
export const encodeOk: EncodeOk = (value) => json(value);

/** Default error encoder: a plain `E => Response`. If the error carries a
 *  numeric `status`, honour it (so a capability can short-circuit with e.g.
 *  `err({ status: 401, error: "unauthorized" })`); otherwise 500. */
export const encodeErr: EncodeErr = (error) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    return json(error, { status });
  }
  return json({ error: "INTERNAL", detail: String(error) }, { status: 500 });
};

export interface ToFetchOptions {
  readonly encodeOk?: EncodeOk;
  readonly encodeErr?: EncodeErr;
}

// ============================================================================
// Render the tree to a flat route table (structure only — no producers run).
//
// One Entry per (path-pattern, verb). Capability producers and the leaf route
// are carried for execution, but matching/Allow are computed WITHOUT running
// any producer — so an OPTIONS preflight or a 405 never triggers auth.
// ============================================================================

export type PatternSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

interface GroupRef {
  readonly key: string;
  readonly produce: (
    req: Request,
  ) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;
}

interface Entry {
  readonly pattern: readonly PatternSegment[];
  readonly method: Method;
  readonly groups: readonly GroupRef[];
  readonly route: RuntimeRouteNode;
}

function buildTable(root: RuntimeNode): Entry[] {
  const out: Entry[] = [];
  walk(root, [], [], out);
  return out;
}

function walk(
  node: RuntimeNode,
  pattern: PatternSegment[],
  groups: GroupRef[],
  out: Entry[],
): void {
  switch (node.kind) {
    case "path":
      for (const seg of Object.keys(node.routes)) {
        walk(
          node.routes[seg]!,
          [...pattern, { kind: "literal", value: seg }],
          groups,
          out,
        );
      }
      return;
    case "param":
      walk(
        node.child,
        [...pattern, { kind: "param", name: node.name }],
        groups,
        out,
      );
      return;
    case "group":
      walk(node.child, pattern, [...groups, { key: node.key, produce: node.produce }], out);
      return;
    case "methods":
      for (const m of Object.keys(node.table) as Method[]) {
        const child = node.table[m]!;
        if (child.kind === "route") {
          out.push({ pattern: [...pattern], method: m, groups: [...groups], route: child });
        }
      }
      return;
    case "route":
      // A bare leaf reached without a `methods` verb split: serve it as GET.
      out.push({ pattern: [...pattern], method: "GET", groups: [...groups], route: node });
      return;
  }
}

// ============================================================================
// toFetch — render a Node tree to a WHATWG fetch handler.
// ============================================================================

export function toFetch(
  root: Node<{}>,
  options: ToFetchOptions = {},
): (req: Request) => Promise<Response> {
  const table = buildTable(toRuntime(root));
  const okEnc = options.encodeOk ?? encodeOk;
  const errEnc = options.encodeErr ?? encodeErr;

  return async (req) => {
    const segs = pathSegments(req.url);
    const pathMatches = table.filter((e) => patternMatches(e.pattern, segs));
    if (pathMatches.length === 0) return notFound(); // path doesn't exist → 404

    const method = req.method as Method;

    const exec = async (m: Method): Promise<Response | undefined> => {
      const entry = pathMatches.find((e) => e.method === m);
      if (entry === undefined) return undefined;
      return executeEntry(entry, segs, req, okEnc, errEnc);
    };

    const direct = await exec(method);
    if (direct !== undefined) return direct;

    // Path matched but this verb did not — project the correctness response.
    const verbs = new Set(pathMatches.map((e) => e.method));

    if (method === "HEAD" && verbs.has("GET")) {
      const res = await exec("GET");
      if (res !== undefined) return new Response(null, res); // strip body, keep status/headers
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: allowHeader(verbs) } });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: allowHeader(verbs) },
    });
  };
}

async function executeEntry(
  entry: Entry,
  segs: readonly string[],
  req: Request,
  okEnc: EncodeOk,
  errEnc: EncodeErr,
): Promise<Response> {
  // Bind path-params from the matched segments.
  const ctx: Record<string, unknown> = {};
  entry.pattern.forEach((p, i) => {
    if (p.kind === "param") ctx[p.name] = segs[i];
  });

  // Run capability producers in order; a failure short-circuits via encodeErr.
  for (const g of entry.groups) {
    const produced = await g.produce(req);
    if (!produced.ok) return errEnc(produced.error);
    ctx[g.key] = produced.value;
  }

  const route = entry.route;
  const opts: Record<string, unknown> = { ...ctx };

  // Leaf query producers (the applicative `collect` over the field schemas).
  // A failing producer → 400.
  if (route.query !== undefined) {
    const url = new URL(req.url);
    const queryDefs = route.query;
    const producers: Record<
      string,
      (p: URLSearchParams) => Result<unknown, unknown>
    > = {};
    for (const k of Object.keys(queryDefs)) {
      const schema: Schema<unknown> = queryDefs[k]!;
      producers[k] = (p) => schema.parse(p.get(k));
    }
    const collected = collect<URLSearchParams, unknown, typeof producers>(
      producers,
    )(url.searchParams);
    if (!collected.ok) return badRequest(collected.error);
    Object.assign(opts, collected.value);
  }

  // Leaf body producer. A failing producer (bad JSON / schema mismatch) → 400.
  if (route.body !== undefined) {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return badRequest({ message: "invalid JSON body" });
    }
    const parsed = route.body.parse(raw);
    if (!parsed.ok) return badRequest(parsed.error);
    opts["body"] = parsed.value;
  }

  const result = await route.handler(opts);
  return match(result, { ok: okEnc, err: errEnc });
}

// ============================================================================
// Path matching helpers
// ============================================================================

/** A request URL's path segments (split on "/", empties dropped). */
export function pathSegments(url: string): string[] {
  return new URL(url).pathname.split("/").filter((s) => s !== "");
}

/** Does a route `pattern` match a request's path `segs`? Literal segments match
 *  by exact name; param segments match any one segment; lengths must be equal. */
export function patternMatches(
  pattern: readonly PatternSegment[],
  segs: readonly string[],
): boolean {
  if (pattern.length !== segs.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p.kind === "literal" && p.value !== segs[i]) return false;
  }
  return true;
}

/** A sorted `Allow` value: the declared verbs, plus HEAD when GET is present and
 *  OPTIONS always (both auto-served by `toFetch`). */
function allowHeader(verbs: ReadonlySet<Method>): string {
  const all = new Set<Method>(verbs);
  if (all.has("GET")) all.add("HEAD");
  all.add("OPTIONS");
  return [...all].sort().join(", ");
}
