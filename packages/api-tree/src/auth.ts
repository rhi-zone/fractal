// packages/api-tree/src/auth.ts — @rhi-zone/fractal-api-tree/auth
//
// Auth adapter contract — the stable interface a provider package (e.g.
// `@rhi-zone/fractal-auth-oidc`) implements, and every projector consumes
// the SAME way regardless of provider. Two independent adapters, one per
// side of a fractal deployment:
//
//   - `AuthAdapter<TUser>`  (server) — validates an incoming `Request`,
//     producing the authenticated user (or `null`). Wired into ALS via
//     `authLayer` below, exactly the way `context.ts`'s `createContext`
//     wires ANY per-request context value into `PresetOptions.als` — this
//     is the same mechanism, specialized to "the context value is the
//     authenticated user."
//   - `AuthClientAdapter` (client) — manages an access token's lifecycle
//     (fetch/cache/refresh). Wired into the HTTP client via `authExtension`
//     below, an ordinary `ClientExtension` (http-api-projector/extension.ts)
//     with no privileged access — a hand-authored extension could do
//     everything `authExtension` does.
//
// Deliberately NOT importing `ClientExtension`/`Fetch` from
// `http-api-projector`: that package already depends on `api-tree`
// (dependencies, not devDependencies — see its package.json), so an import
// the other way would be a package cycle. Instead, `authExtension` and
// `authMiddleware` return values whose shape structurally matches
// `ClientExtension`/`Fetch` (TypeScript's structural typing accepts them at
// any call site expecting the real type, no cast needed) — the same trick
// `context.ts`'s `CliContextShape`/`McpContextShape` already use for the
// same reason (see that module's doc for the fuller rationale).
//
// Kept intentionally minimal: two methods on the server side (`resolve`,
// optional `guard`), two on the client side (`getToken`, optional
// `onUnauthorized`). Everything provider-specific (JWKS discovery, JWT
// verification, OAuth token-endpoint grants, refresh scheduling) lives in
// the provider package, never here — this module only needs to stay stable
// long enough for provider packages to depend on it without churn.

// ============================================================================
// Server-side contract
// ============================================================================

/**
 * Server-side auth adapter: validates an incoming `Request` and produces the
 * authenticated user, or `null` when the request carries no (or an invalid)
 * credential. Implementations should not throw on a missing/invalid
 * credential — `null` is the "unauthenticated" signal; throwing is reserved
 * for adapter-internal failures (e.g. the JWKS endpoint itself is
 * unreachable) that a caller can't distinguish from "not logged in."
 */
export type AuthAdapter<TUser> = {
  /** Extracts and validates the user from a request — the `als.init` body. */
  readonly resolve: (req: Request) => Promise<TUser | null>;
  /**
   * Optional guard: given the request and the already-`resolve`d user,
   * return a `Response` to short-circuit the request (e.g. `401
   * Unauthorized`) or `undefined`/`void` to let it proceed. Enforced by
   * `authMiddleware` below, not by `authLayer` — `als.init` has no way to
   * produce a `Response`, only a context value (see `AlsConfig` in
   * `./context.ts`), so rejection needs a separate `Fetch`-wrapping layer.
   */
  readonly guard?: (req: Request, user: TUser | null) => Response | void;
};

/**
 * Convert a server `AuthAdapter` into an `als.init` function — drops
 * directly into `PresetOptions.als.init` (http-api-projector/preset.ts),
 * `CliOpts.als.init`, or any other projector's `AlsConfig<Request, T>.init`
 * that hands the raw `Request` through unchanged.
 *
 * ```ts
 * const auth = oidc.server({ issuer, audience });
 * createFetch(tree, { als: { storage: new AsyncLocalStorage(), init: authLayer(auth) } });
 * ```
 *
 * For `als.getStore()` to read the user downstream, `T` in `AlsConfig<Request, T>`
 * must be (or embed) `TUser | null` — pair this with `createContext` (./context.ts)
 * when the per-request context needs MORE than just the user.
 */
export function authLayer<TUser>(adapter: AuthAdapter<TUser>): (req: Request) => Promise<TUser | null> {
  return (req) => adapter.resolve(req);
}

/**
 * Convert a server `AuthAdapter`'s `guard` into a `Fetch => Fetch` layer —
 * drops directly into `PresetOptions.middleware` (http-api-projector/
 * preset.ts) or any other `(inner: (req: Request) => Promise<Response>) =>
 * (req: Request) => Promise<Response>` middleware slot. Re-runs
 * `adapter.resolve` independently of whatever `als.init` (via `authLayer`)
 * also runs for the same request — the two are separate hooks with no
 * shared cache, so a `resolve` that does real work (a network call, a slow
 * hash) should memoize itself if both are used together. The OIDC adapter's
 * `resolve` is local JWT verification against an already-cached JWKS key
 * set (see `@rhi-zone/fractal-auth-oidc`), so the duplicate call is cheap
 * in the common case. A no-op (returns `inner` unchanged) when the adapter
 * has no `guard`.
 *
 * ```ts
 * createFetch(tree, {
 *   als: { storage, init: authLayer(auth) },
 *   middleware: [authMiddleware(auth)],
 * });
 * ```
 */
export function authMiddleware<TUser>(
  adapter: AuthAdapter<TUser>,
): (inner: (req: Request) => Promise<Response>) => (req: Request) => Promise<Response> {
  if (adapter.guard === undefined) return (inner) => inner;
  const guard = adapter.guard;
  return (inner) => async (req) => {
    const user = await adapter.resolve(req);
    const rejected = guard(req, user);
    if (rejected !== undefined) return rejected;
    return inner(req);
  };
}

// ============================================================================
// Client-side contract
// ============================================================================

/**
 * Client-side auth adapter: manages an access token's lifecycle. `getToken`
 * is called before every outgoing request; `onUnauthorized` (optional) is
 * called on a `401` response, as one last chance to refresh and retry
 * before the caller sees the failure.
 */
export type AuthClientAdapter = {
  /** Current access token, refreshing first if the adapter knows it's expired. `null` when unauthenticated. */
  readonly getToken: () => Promise<string | null>;
  /**
   * Called when a request comes back `401`. Return `true` to retry the
   * SAME request once, with a freshly-fetched token (`getToken` is called
   * again before the retry); return `false` (or omit this hook entirely)
   * to let the `401` pass through to the caller unchanged.
   */
  readonly onUnauthorized?: () => Promise<boolean>;
};

/** Structural mirror of http-api-projector's `FetchImpl` — see module doc. */
type FetchImplShape = (req: Request) => Promise<Response>;

/**
 * Structural mirror of http-api-projector's `ClientExtension` — only the
 * fields `authExtension` populates. See module doc for why this isn't
 * imported from `http-api-projector` directly.
 */
type ClientExtensionShape = {
  readonly name: string;
  readonly wrapFetch: (inner: FetchImplShape) => FetchImplShape;
};

function withAuthHeader(req: Request, token: string): Request {
  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(req, { headers });
}

/**
 * Convert a client `AuthClientAdapter` into a fractal `ClientExtension` —
 * drops directly into `ClientOptions.extensions` (http-api-projector/
 * client.ts) or `CodegenOptions.extensions`. Injects `Authorization: Bearer
 * <token>` on every outgoing request; on a `401` response, gives the
 * adapter's `onUnauthorized` hook one chance to refresh, then retries the
 * SAME request once with the refreshed token.
 *
 * Runtime-only (no `codegen` hook) — token refresh is inherently stateful
 * (it needs to call back into live adapter state), the same reasoning
 * `extensions/interceptors.ts` documents for why its hooks are runtime-only.
 *
 * ```ts
 * const clientAuth = oidc.client({ tokenEndpoint, clientId, clientSecret });
 * createClient(node, { baseUrl, extensions: [authExtension(clientAuth)] });
 * ```
 */
export function authExtension(adapter: AuthClientAdapter): ClientExtensionShape {
  const wrapFetch = (inner: FetchImplShape): FetchImplShape => {
    return async (req: Request): Promise<Response> => {
      // Cloned BEFORE the first send — a `Request` body can only be read
      // once, so a retry needs its own untouched copy.
      const retryReq = req.clone();

      const token = await adapter.getToken();
      const firstReq = token !== null ? withAuthHeader(req, token) : req;
      const res = await inner(firstReq);

      if (res.status !== 401 || adapter.onUnauthorized === undefined) return res;

      const shouldRetry = await adapter.onUnauthorized();
      if (!shouldRetry) return res;

      const freshToken = await adapter.getToken();
      const secondReq = freshToken !== null ? withAuthHeader(retryReq, freshToken) : retryReq;
      return inner(secondReq);
    };
  };

  return { name: "auth", wrapFetch };
}
