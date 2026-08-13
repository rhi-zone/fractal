// packages/api-tree/src/wire-derive.ts — @rhi-zone/fractal-api-tree
//
// Protocol -> wire-profile derivation, computed PER LEAF at codegen time from
// that leaf's own declared meta (`sourceMap`, and for HTTP, `method`/`verb`)
// plus its tree-relative path's fallback-segment names — the mechanism
// `docs/design/wire-profiles-and-staged-validation.md`'s "Wire profiles are a
// type-ir mechanism" section calls for ("Protocol default encoding tables:
// flag store `string | string[] | true`, env/query strings, body json+dates,
// mcp/graphql argument stores identity+json-dates").
//
// See docs/design/wire-profiles-and-staged-validation.md's "Implementation
// trace (phase B)" section for the full derivation write-up. That section's
// original phase-B trace flagged this module's HTTP branch reading LOCAL,
// pre-projection path segments only as a "known limitation" relative to a
// runtime that resolved `moveTo`-relocated leaves' path binding against their
// FINAL mounted position — that runtime no longer exists: moveTo is now
// purely an address transform, and a leaf's field<->store binding is defined
// to be a pure function of its own authored (pre-moveTo) declarations (see
// http-api-projector's route.ts, `Sources.authoredPathParams`). Local,
// pre-projection path segments are exactly that authored set, so this
// module's HTTP branch was already computing the CORRECT thing, under the
// new definition, without needing any change — see that section's dated note
// for the supersession.

import {
  argvProfile,
  identityProfile,
  jsonProfile,
  queryProfile,
  type WireProfile,
} from "@rhi-zone/fractal-type-ir";

/** The five wire protocols wire-profile derivation knows about, plus
 * `"identity"` for an in-process/already-typed value with no wire in
 * between (the strict posture `check`/`errors`/`parse` have always assumed —
 * see compile.ts's `identityProfile` doc comment). Re-exported by
 * `apply-validation.ts` as the third `applyValidation` argument's type. */
export type ProtocolName = "http" | "cli" | "mcp" | "graphql" | "jsonrpc" | "identity";

/** A minimal `ParamSource`-shaped override — deliberately NOT imported from
 * `input.ts`'s `ParamSource` (this module only reads `store`/`key`
 * structurally, and importing the full type would pull codegen into a
 * runtime-shape dependency it doesn't otherwise need). */
export type FieldSource = { readonly store: string; readonly key?: string };

/** A leaf's per-protocol `sourceMap` override, field name -> source. */
export type FieldSourceMap = Readonly<Record<string, FieldSource>>;

/**
 * The result of deriving a leaf's wire profile for one protocol:
 *   - `{ profile }` for the protocols whose encoding is uniform across every
 *     field (`identity`, `mcp`/`graphql`/`jsonrpc`, all base-json-typed) —
 *     callers should use `compileWireEntryFragment` directly for these, never
 *     the composite compiler path.
 *   - `{ fieldProfiles, defaultProfile }` for the protocols whose encoding is
 *     genuinely per-field (`cli`, `http`) — callers pass this straight to
 *     `compileWireEntryFragmentComposite`. `fieldProfiles` carries entries
 *     ONLY for fields this derivation has specific information about (a path-
 *     segment name match, or an explicit `sourceMap` override) — every other
 *     field falls through to `defaultProfile`, computed from the protocol's
 *     default/primary store. Because a leaf's full field-name set isn't known
 *     to this function (only `sourceMap`'s own keys and the path-param names
 *     are), `fieldProfiles` is deliberately a PARTIAL map, not a per-field
 *     entry for every field on the leaf — `compileWireEntryFragmentComposite`
 *     already resolves an absent field via `fieldProfiles[name] ??
 *     defaultProfile`.
 */
export type FieldProfileDerivation =
  | {
      readonly fieldProfiles: Readonly<Record<string, WireProfile>>;
      readonly defaultProfile: WireProfile;
    }
  | { readonly profile: WireProfile };

/** CLI store -> leaf encoding. All three (`flag`/`path`/`env`) map to
 * `argvProfile`-style encoding today — argv is uniform — but this is still a
 * per-store TABLE, not a shortcut straight to `argvProfile`, so a future CLI
 * store with a genuinely different encoding only needs an entry here (falls
 * back to `argvProfile` for any unrecognized/future store name, e.g. `caller`
 * — see `CliStoreName`, cli-api-projector/src/source.ts). */
function cliStoreEncoding(_store: string): WireProfile {
  return argvProfile;
}

/** HTTP store -> leaf encoding: `body` is typed JSON (dates need an ISO-
 * string coercion, everything else arrives already typed) — `jsonProfile`.
 * `path`/`query`/`header` are always strings — `queryProfile` (numeric-
 * string/strict-bool-string/ISO-date-string coercion). See
 * `HttpStoreRegistry` (http-api-projector/src/decode.ts) for the store name
 * set this mirrors. */
function httpStoreEncoding(store: string): WireProfile {
  return store === "body" ? jsonProfile : queryProfile;
}

/**
 * Reimplementation of `http-api-projector/src/decode.ts`'s
 * `primaryStoreForMethod` — api-tree cannot depend on http-api-projector (the
 * dependency runs the other way), so this mirrors that function's exact
 * switch rather than importing it. GET/HEAD/DELETE read from the query
 * string by default; every other method (POST/PUT/PATCH/...) defaults to the
 * JSON body.
 */
function primaryStoreForMethod(method: string): "query" | "body" {
  switch (method) {
    case "GET":
    case "HEAD":
    case "DELETE":
      return "query";
    default:
      return "body";
  }
}

/**
 * Derive a leaf's wire-profile assignment for `protocol`, from that leaf's
 * own `sourceMap` (may be `undefined` — no overrides declared), HTTP
 * `method` (ignored for every other protocol), and the leaf's own tree-
 * relative path's fallback-segment names (the `:name` convention
 * `apply-validation.ts`'s `fallbackSegment`/`apply-validation-build.ts`'s
 * tree walk already use) — a field whose name matches one of these defaults
 * to the `"path"` store instead of the protocol's usual default store,
 * mirroring `cli.ts`'s own `assemble(stores, paramNames, sourceMap, "flag",
 * Object.keys(slugs))` call and `http-api-projector`'s own path-slug
 * convention.
 *
 * HTTP-only note: the path-param-name set passed in here is this leaf's own
 * LOCAL tree-relative path segments, computed PRE-projection (`http.moveTo`
 * runs later, over the projected `HttpRoute` tree, and is purely an address
 * transform — it does not relocate or change which path segments a leaf
 * AUTHORED itself under). This is exactly `http-api-projector`'s own
 * `authoredPathParams` definition (route.ts), so this derivation is correct
 * for every leaf, `moveTo` or not — not an approximation of anything. This
 * used to be documented as a known limitation relative to an OLDER runtime
 * behavior where a `moveTo`-relocated leaf's path binding was resolved
 * against wherever it ended up (see docs/design/
 * wire-profiles-and-staged-validation.md's dated supersession note in its
 * phase-B trace); that runtime behavior is gone, and local-authored-path-only
 * is now the actual definition of path-sourced binding, not a stand-in for it.
 */
export function deriveFieldProfiles(
  protocol: ProtocolName,
  sourceMap: FieldSourceMap | undefined,
  method: string | undefined,
  pathParamNames: ReadonlySet<string> | readonly string[],
): FieldProfileDerivation {
  if (protocol === "identity") return { profile: identityProfile };
  if (protocol === "mcp" || protocol === "graphql" || protocol === "jsonrpc")
    return { profile: jsonProfile };

  const pathNames = pathParamNames instanceof Set ? pathParamNames : new Set(pathParamNames);
  const storeEncoding = protocol === "cli" ? cliStoreEncoding : httpStoreEncoding;
  const fieldProfiles: Record<string, WireProfile> = {};
  for (const name of pathNames) fieldProfiles[name] = storeEncoding("path");
  for (const [field, source] of Object.entries(sourceMap ?? {}))
    fieldProfiles[field] = storeEncoding(source.store);

  const defaultStore = protocol === "cli" ? "flag" : primaryStoreForMethod(method ?? "GET");
  return { fieldProfiles, defaultProfile: storeEncoding(defaultStore) };
}
