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

export type Handler = (
  req: Request,
) => Response | undefined | Promise<Response | undefined>;

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

/** Clone `req` with its pathname replaced by `segs` (method/headers/body kept). */
function withSegments(req: Request, segs: string[]): Request {
  const url = new URL(req.url);
  url.pathname = "/" + segs.join("/");
  return new Request(url, req);
}

/**
 * The URL-advancing primitive, exposed for dynamic segments. A handler that
 * reads a dynamic value (e.g. an id via `segments(req)[0]`) calls `rest(req)`
 * to get a Request advanced past that one segment, then delegates the remaining
 * path to an inner handler. This is NOT a param/capture combinator: it carries
 * no value, takes no pattern, and reads nothing — it only advances the URL
 * (rule 5), while the id is still read directly off the Request (rule 4).
 */
export function rest(req: Request): Request {
  return withSegments(req, segments(req).slice(1));
}

// --- combinators (plain functions returning a Handler) ---------------------

/**
 * Dispatch on the first not-yet-consumed path segment. Keys are literal
 * segment names. If the first remaining segment is a key, call that handler
 * with a Request advanced past that segment; otherwise return undefined.
 */
export function path(routes: Record<string, Handler>): Handler {
  return (req) => {
    const segs = segments(req);
    const head = segs[0];
    if (head === undefined) return undefined;
    const next = routes[head];
    if (next === undefined) return undefined;
    return next(withSegments(req, segs.slice(1)));
  };
}

/**
 * Consume a literal prefix segment, then delegate to `inner`. Convenience over
 * `path` for a single fixed prefix. Same URL-advancing mechanism.
 */
export function mount(prefix: string, inner: Handler): Handler {
  return path({ [prefix]: inner });
}

/**
 * Method dispatch. Only fires when the path is FULLY consumed.
 *   - segment remaining          -> undefined (not mine)
 *   - consumed + method in table -> call it
 *   - consumed + method missing  -> 405 with `Allow` header
 *   - HEAD with GET present      -> run GET, return its response with null body
 *   - OPTIONS (if not in table)  -> 204 + Allow
 */
export function methods(table: Partial<Record<Method, Handler>>): Handler {
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
export function choice(...handlers: Handler[]): Handler {
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

/** Run `app`; a final `undefined` becomes a 404. Runtime-agnostic. */
export function toFetch(app: Handler): (req: Request) => Promise<Response> {
  return async (req) => (await app(req)) ?? notFound();
}
