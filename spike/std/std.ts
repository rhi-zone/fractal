// spike/std — the web-framework model where the ONLY framework type is the
// handler, and it is literally the web standard:
//
//   (req: Request) => Response | undefined | Promise<Response | undefined>
//
// `Request`/`Response` are the WHATWG globals. `undefined` means "not mine —
// pass to the next handler". Combinators are plain functions returning a
// Handler. "How much path is consumed" lives in the Request's own URL: we
// rewrite the URL (advance past consumed segments) when descending, so there
// is no ctx object, no router type, no side channel.

// `Handler<P>` is parameterized by its captured path params. The params ride as
// a TYPED FIELD on the standard `Request` (itty-router-style runtime, iron-style
// typing — NO separate Ctx wrapper). `P` defaults to `{}` so a paramless handler
// is just `Handler`. Because `Request & { params: P }` is a SUBtype of `Request`,
// a plain `(req: Request) => Response` is contravariantly assignable to `Handler`
// AND to any `Handler<P>` — a plain web handler IS a Handler (requirement 1).
export type Handler<P = {}> = (
  req: Request & { params: P },
) => Response | undefined | Promise<Response | undefined>;

/** The runtime carrier: a real `Request` with a `params` own-property. */
export type ReqWithParams<P> = Request & { params: P };

/** Attach (or re-attach) a `params` own-property to a Request, in place. Returns
 *  the SAME Request, retyped — it stays a real Request (json()/headers/method). */
function withParams<P>(req: Request, params: P): ReqWithParams<P> {
  (req as ReqWithParams<P>).params = params;
  return req as ReqWithParams<P>;
}

// Closed verb union: a typo like "GETT" is a COMPILE ERROR in `methods`.
export type Method =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

// --- path consumption, read straight off the Request's URL -----------------

/** Remaining (unconsumed) path segments: pathname split on "/", empties dropped. */
export function segments(req: Request): string[] {
  return new URL(req.url).pathname.split("/").filter((s) => s !== "");
}

/** Clone `req` with its pathname replaced by `segs` (method/headers/body kept).
 *  `new Request(url, req)` drops custom own-properties, so we re-attach `params`
 *  (carried from the source Request, defaulting to `{}`) to keep it a typed Req. */
function withSegments<P>(req: Request, segs: string[]): ReqWithParams<P> {
  const url = new URL(req.url);
  url.pathname = "/" + segs.join("/");
  const params = (req as Partial<ReqWithParams<P>>).params ?? ({} as P);
  return withParams(new Request(url, req), params);
}

/**
 * The URL-advancing primitive, exposed for dynamic segments. A handler that
 * reads a dynamic value (e.g. an id via `segments(req)[0]`) calls `rest(req)`
 * to get a Request advanced past that one segment, then delegates the remaining
 * path to an inner handler. This is NOT a param/capture combinator: it carries
 * no value, takes no pattern, and reads nothing — it only advances the URL
 * (rule 5), while the id is still read directly off the Request (rule 4).
 */
export function rest<P>(req: ReqWithParams<P>): ReqWithParams<P> {
  return withSegments(req, segments(req).slice(1));
}

// --- combinators (plain functions returning a Handler) ---------------------

/**
 * Dispatch on the first not-yet-consumed path segment. Keys are literal
 * segment names. If the first remaining segment is a key, call that handler
 * with a Request advanced past that segment; otherwise return undefined.
 */
export function path<P = {}>(routes: Record<string, Handler<P>>): Handler<P> {
  return (req) => {
    const segs = segments(req);
    const head = segs[0];
    if (head === undefined) return undefined;
    const next = routes[head];
    if (next === undefined) return undefined;
    return next(withSegments<P>(req, segs.slice(1)));
  };
}

/**
 * Consume a literal prefix segment, then delegate to `inner`. Convenience over
 * `path` for a single fixed prefix. Same URL-advancing mechanism.
 */
export function mount<P = {}>(prefix: string, inner: Handler<P>): Handler<P> {
  return path<P>({ [prefix]: inner });
}

/**
 * Capture a dynamic path segment as a TYPED param and DISCHARGE it. `param(name,
 * child)` reads the first remaining segment, binds it into `req.params[name]`,
 * advances the URL past it, and delegates to `child`. The child is parameterized
 * by `Q` (its full captured-param object, which must include `name`); the result
 * is `Handler<Omit<Q, name>>` — the captured key is removed from the obligation.
 *
 * The signature infers the child's WHOLE param object `Q` and removes `K` via
 * `Omit` (rather than `Handler<P & Record<K,string>> -> Handler<P>`, which fails
 * inference: TS cannot split a `P & Record<K,string>` intersection back into `P`,
 * so it binds `P` to the whole thing and discharges nothing). `Omit` is the
 * minimal fix and composes: `param("id", param("postId", gc))` discharges both.
 */
export function param<K extends string, Q extends Record<K, string>>(
  name: K,
  child: Handler<Q>,
): Handler<Omit<Q, K>> {
  return (req) => {
    const value = segments(req)[0];
    if (value === undefined) return undefined;
    // bind the captured value into params, then advance the URL past the segment.
    const bound = { ...(req.params as object), [name]: value } as Q;
    const advanced = withSegments<Q>(req, segments(req).slice(1));
    advanced.params = bound;
    return child(advanced);
  };
}

/**
 * Method dispatch. Only fires when the path is FULLY consumed.
 *   - segment remaining          -> undefined (not mine)
 *   - consumed + method in table -> call it
 *   - consumed + method missing  -> 405 with `Allow` header
 *   - HEAD with GET present      -> run GET, return its response with null body
 *   - OPTIONS (if not in table)  -> 204 + Allow
 */
export function methods<P = {}>(
  table: Partial<Record<Method, Handler<P>>>,
): Handler<P> {
  const verbs = Object.keys(table) as Method[];
  const allow = verbs.join(", ");
  return async (req) => {
    if (segments(req).length > 0) return undefined; // path not fully consumed
    const method = req.method as Method;

    const direct = table[method];
    if (direct !== undefined) return direct(req);

    if (method === "HEAD" && table.GET !== undefined) {
      const res = await table.GET(req);
      if (res === undefined) return undefined;
      return new Response(null, res);
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: allow } });
    }

    return new Response(`Method Not Allowed`, {
      status: 405,
      headers: { Allow: allow },
    });
  };
}

/** Try each handler in order; first non-undefined wins; else undefined. */
export function choice<P = {}>(...handlers: Handler<P>[]): Handler<P> {
  return async (req) => {
    for (const h of handlers) {
      const res = await h(req);
      if (res !== undefined) return res;
    }
    return undefined;
  };
}

// --- response builders (plain functions returning real Response objects) ----

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

// --- the one adapter -------------------------------------------------------

/** Run `app`; a final `undefined` becomes a 404. Runtime-agnostic. The root only
 *  accepts a FULLY-DISCHARGED `Handler<{}>`: an app that reads `req.params.id`
 *  without a `param("id", …)` discharging it is `Handler<{id:string}>` and FAILS
 *  to compile here (requirement 4). Initializes `params` to `{}` for the root. */
export function toFetch(app: Handler<{}>): (req: Request) => Promise<Response> {
  return async (req) => (await app(withParams(req, {}))) ?? notFound();
}
