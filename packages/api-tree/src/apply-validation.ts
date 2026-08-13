// packages/api-tree/src/apply-validation.ts — @rhi-zone/fractal-api-tree
//
// `applyValidation(key, projectedTree)` — the KEYED, call-site-anchored way
// to wire generated validators onto a tree, applied to the PROJECTED tree
// (HTTP's `HttpRoute`, or the `Node` tree itself for CLI/MCP, which have no
// separate projected type) rather than to the raw `api()` `Node` tree the way
// `build.ts`'s `wrapValidators` does.
//
// SETTLED (phase 3): this is now the ONLY validation mechanism — `createFetch`
// (phase 2), `createMcpServer`/`runCli`/`createGraphQLServer` (phase 3) all
// wire validation through `applyValidation`, and `wrapValidators` (build.ts)
// is deleted. See docs/design/routing-and-transforms.md's "Dispatch is not an
// interceptable multi-stage pipeline" section for the full history: an
// earlier `createApplyValidation` (removed in 670e0dd) injected validators
// into a per-method `pipeline.validate` array on `HttpRoute`; a node-level
// `wrapValidators` interlude followed; this mechanism wraps a leaf's HANDLER
// (the same contract `wrapValidators` used), so it carries none of the
// retired stage-array machinery.
//
// Why keyed, and why anchored on the call site: codegen owns a NAMESPACE of
// path -> validator per key, so several independent trees (and several
// independent codegen runs) each register their own set without colliding —
// the key is the disambiguator that `wrapValidators` instead has to encode
// as a `treeId` prefix inside every path (see `extractRouteTypeRefs`'s
// `${treeId}/${path}` keying and `wrapValidators`'s `path` argument). Under
// this mechanism the inner path keys are TREE-RELATIVE (no `treeId` prefix):
//
//   const applyValidation = createApplyValidation(generatedValidators)
//   const routes = applyValidation("books", httpProjection(apiTree))
//
// SHAPE-AGNOSTIC BY CONSTRUCTION: the walk below matches structurally, never
// against an imported route type. `@rhi-zone/fractal-api-tree` cannot import
// `@rhi-zone/fractal-http-api-projector` — the dependency runs the other way
// (http-api-projector depends on api-tree; api-tree lists it only as a
// devDependency), so a structural walk is the only way one mechanism covers
// both projected shapes. Two leaf shapes are recognized at any tree position:
//   - a direct `handler` field (a `Node` leaf), and
//   - a `methods` record whose entries each carry `handler` (an `HttpRoute`
//     leaf — handlers nested one level deeper, under `methods.<VERB>`),
// plus the `children` / `fallback` recursion both shapes share. A position
// carrying both is handled too; neither shape is assumed.

import { err } from "./index.ts";
import { TAG_UNVALIDATED } from "./tags.ts";
import type { GeneratedEntry } from "./build.ts";
import type { ProtocolName } from "./wire-derive.ts";

/** Re-exported for convenience: the generated-entry shape this mechanism
 * consumes is EXACTLY `wrapValidators`' own (build.ts) — one generated
 * validator module can feed either mechanism. Type-only import, so this file
 * pulls in none of build.ts's codegen machinery at runtime. */
export type { GeneratedEntry };

/** Re-exported for convenience — the type of `applyValidation`'s optional
 * third argument. See wire-derive.ts. */
export type { ProtocolName };

/**
 * outer key = the string key passed to `applyValidation(key, tree)`.
 * inner key = the tree-relative path (segments joined with `/`; a fallback
 * segment rendered as `:name` — e.g. `"books/:bookId"`), the same path
 * convention `wrapValidators`/`extractRouteTypeRefs` use, minus the `treeId`
 * prefix (the outer key already scopes one tree).
 *
 * This is the PROTOCOL-BLIND map — a 2-argument `applyValidation(key, tree)`
 * call site's shape, UNCHANGED since phase 1. Phase D retired the 2-arg
 * CODEGEN route (`apply-validation-build.ts` no longer has an extraction/build
 * path that populates this map) — every call site, 2-arg or 3-arg, now
 * compiles through the single staged wire-profile pipeline, with an omitted
 * `protocol` argument sugar for `"identity"` (see `resolveForKey`'s doc
 * comment below). This map stays fully live for HAND-AUTHORED validators
 * built without codegen (as several of this package's own runtime tests do),
 * and takes precedence over an identity-tagged `WireValidatorMap` entry when
 * both are present for the same key. See `WireValidatorMap` for the
 * per-protocol sibling a 3-argument call site (`applyValidation(key, tree,
 * protocol)`) resolves against instead.
 */
export type ValidatorMap = Readonly<Record<string, Readonly<Record<string, GeneratedEntry>>>>;

/**
 * The per-(key, path, protocol) sibling of `ValidatorMap` — what a 3-argument
 * `applyValidation(key, tree, protocol)` call site resolves against (see
 * decision 1, docs/design/wire-profiles-and-staged-validation.md's
 * "Implementation trace (phase B)" section, for why this is a SECOND,
 * OPTIONAL map rather than a change to `ValidatorMap`'s own shape: every
 * existing single-argument `createApplyValidation(validatorsByKey)` call site
 * — every already-codegen'd module, every existing test/fixture — keeps
 * compiling and running with ZERO changes, since this map is additive and
 * defaults to `{}`).
 *
 * outer key = the `applyValidation` call site's `key` argument (same as
 * `ValidatorMap`). middle key = the leaf's tree-relative path (same
 * convention). inner key = the protocol named at that call site's third
 * argument — a leaf validated for two protocols under the SAME key would
 * carry two entries here, one per protocol (in practice a leaf normally gets
 * its own key per protocol instead — see decision 1's "one 3-arg call/key
 * per protocol with a different wire shape" — but nothing here assumes that).
 */
export type WireValidatorMap = Readonly<
  Record<string, Readonly<Record<string, Readonly<Partial<Record<ProtocolName, GeneratedEntry>>>>>>
>;

/**
 * The property name a `createApplyValidation` result carries at the TYPE
 * level (never at runtime — it's an optional, never-assigned field). This is
 * how `apply-validation-build.ts`'s call-site scan identifies a genuine
 * `applyValidation(key, tree)` invocation: it asks the checker whether the
 * CALLEE's type has this property, so an unrelated local function that merely
 * happens to be named `applyValidation` is never matched, and a genuine one
 * IS matched no matter what it was renamed to or how many re-export hops sit
 * between the generated module and the call site.
 */
export const APPLY_VALIDATION_BRAND = "__fractalApplyValidation" as const;

/** `createApplyValidation`'s return type — see `APPLY_VALIDATION_BRAND` for
 * why it carries a phantom brand property. Generic in the tree type: the
 * walk is structural, and whatever shape goes in comes back out (a rebuilt
 * value, never the same object). */
export type ApplyValidation = {
  /**
   * `protocol` given (3-arg call): resolves against `WireValidatorMap`, for
   * THIS `(key, path, protocol)` triple. `protocol` omitted (2-arg call):
   * resolves against `ValidatorMap` first (hand-authored maps keep working
   * unchanged), falling back to `WireValidatorMap` tagged `"identity"`
   * otherwise — see `resolveForKey`'s doc comment for why (phase D retired
   * the 2-arg-specific codegen route; an omitted `protocol` is now sugar for
   * `"identity"` at the codegen layer too).
   */
  <T>(key: string, tree: T, protocol?: ProtocolName): T;
  /** Phantom — never present at runtime. See `APPLY_VALIDATION_BRAND`. */
  readonly __fractalApplyValidation?: true;
};

/** A handler in either recognized position — a `Node`'s own `handler`, or an
 * `HttpRoute` method entry's. Deliberately not `Handler` from node.ts: this
 * walk never assumes the value it found came from this package's model. */
type AnyHandler = (input: unknown) => unknown;

/**
 * Wrap one handler: run `entry.parse(input, hooks)` first — `ok` calls the
 * original handler with the parsed (coerced, validated, narrowed) value,
 * `err` returns this package's `Result` error (`err(errors)`, index.ts)
 * without the handler ever running. Identical contract to `build.ts`'s
 * `wrapHandler`, and deliberately so: a dispatcher already checks a returned
 * `Result`'s `kind` (see that function's doc comment for why a returned
 * Result beats a thrown error class here).
 *
 * `hooks` (see `resolveHooks` below) is `undefined` whenever this leaf has no
 * function-form `encodingMap` entries — the overwhelmingly common case —
 * so `entry.parse(input)` (one argument) is what actually runs there; a
 * `GeneratedEntry.parse` with no hook fields never even looks at its second
 * parameter, so passing `undefined` explicitly vs. omitting it is behaviorally
 * identical, this just avoids a redundant `hooks === undefined` branch here.
 */
function wrapHandler(
  handler: AnyHandler,
  entry: GeneratedEntry,
  hooks: Readonly<Record<string, (w: unknown) => unknown>> | undefined,
): AnyHandler {
  const wrapped: AnyHandler = async (input: unknown) => {
    const result = entry.parse(input, hooks);
    if (result.kind === "err") return err(result.errors);
    return handler(result.value);
  };
  return wrapped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every function-VALUED `meta.<protocol>.encodingMap` entry on a leaf's own
 * `meta` — the runtime counterpart of `tree.ts`'s static
 * `readMetaEncodingMapFunctionFields` (which only detects EXISTENCE, off a
 * TYPE, at codegen time). This is the real, closed-over decoder VALUE, read
 * off the actual running tree at WRAP time — the function itself never moved
 * through codegen (see `build.ts`'s `GeneratedEntry` doc comment: "no
 * inlining, no source re-emission"). A string-valued `encodingMap` entry
 * (base-profile-name override, already fused into the generated fragment at
 * codegen time) is not a function and is correctly skipped here — it has no
 * hook to supply, the fragment already decodes that field itself.
 */
function readEncodingMapHooks(
  meta: unknown,
  protocol: ProtocolName,
): ReadonlyMap<string, (w: unknown) => unknown> {
  const out = new Map<string, (w: unknown) => unknown>();
  if (!isRecord(meta)) return out;
  const ns = meta[protocol];
  if (!isRecord(ns)) return out;
  const encodingMap = ns["encodingMap"];
  if (!isRecord(encodingMap)) return out;
  for (const [field, value] of Object.entries(encodingMap)) {
    if (typeof value === "function") out.set(field, value as (w: unknown) => unknown);
  }
  return out;
}

/**
 * Resolve the hooks map to pass into `entry.parse` for one leaf position,
 * enforcing the two-directional stale-module contract (decision 5, docs/
 * design/wire-profiles-and-staged-validation.md's implementation-trace
 * addendum for this phase) — LOUD in both directions, on the theory that a
 * silent mismatch here means either an outright missing decoder (a request
 * would crash or decode wrong later, invisibly) or a decoder that was
 * authored but never actually wired in (the exact class of "ran the wrong
 * decode silently" bug the design doc's own loud-by-default posture exists
 * to prevent):
 *
 *   (a) `entry.hookFields` names a field, but the real tree's meta has no
 *       function there — codegen ran against an `encodingMap` that no longer
 *       matches this tree (a stale generated module, or `meta` built without
 *       the override at all). Thrown eagerly, at WRAP time, not deferred to
 *       the first request that happens to hit this field.
 *   (b) The real tree's meta HAS a function-valued `encodingMap` entry for a
 *       field `entry.hookFields` does NOT list — codegen ran BEFORE this
 *       override was authored (or codegen simply wasn't re-run since). Left
 *       unhandled, this field would silently fall through to the fragment's
 *       FUSED default decode for that field instead of the user's own
 *       decoder — the wrong decode, run silently, exactly what this
 *       mechanism exists to never do. Thrown for the same reason as (a).
 *
 * Returns `undefined` (not an empty map) when there is nothing to hook —
 * `wrapHandler` then calls `entry.parse(input)` with no second argument,
 * the same call shape every pre-existing (non-hook) leaf already gets.
 */
function resolveHooks(
  leafPath: string,
  entry: GeneratedEntry,
  meta: unknown,
  protocol: ProtocolName | undefined,
): Readonly<Record<string, (w: unknown) => unknown>> | undefined {
  const declared = entry.hookFields ?? [];
  if (protocol === undefined) {
    // A 2-arg `applyValidation(key, tree)` call never derives hook fields at
    // all (see `apply-validation-build.ts`'s extraction: the http/cli-only
    // meta read that produces `hookFields` only runs for a LITERAL 3-arg
    // protocol) — a non-empty `declared` here would itself be the stale-
    // module signal, just with no real protocol namespace to check against.
    if (declared.length > 0) {
      throw new Error(
        `applyValidation: leaf ${JSON.stringify(leafPath)}'s generated entry expects hook fields ` +
          `${JSON.stringify(declared)}, but this leaf was wired with no explicit protocol. Custom-decoder ` +
          `hooks require a 3-arg applyValidation(key, tree, protocol) call — stale generated module?`,
      );
    }
    return undefined;
  }
  const actual = readEncodingMapHooks(meta, protocol);
  const declaredSet = new Set(declared);
  for (const field of declaredSet) {
    if (!actual.has(field)) {
      throw new Error(
        `applyValidation: leaf ${JSON.stringify(leafPath)}'s generated entry expects a decoder hook for field ` +
          `${JSON.stringify(field)} (protocol ${JSON.stringify(protocol)}), but meta.${protocol}.encodingMap.${field} ` +
          `is not a function on the running tree. Stale generated module (re-run codegen) or the override was ` +
          `removed/renamed after the last codegen run.`,
      );
    }
  }
  for (const field of actual.keys()) {
    if (!declaredSet.has(field)) {
      throw new Error(
        `applyValidation: leaf ${JSON.stringify(leafPath)} has a function-valued ` +
          `meta.${protocol}.encodingMap.${field}, but its generated entry does not expect a hook for that field ` +
          `(hookFields: ${JSON.stringify(declared)}). Stale generated module — re-run codegen after authoring or ` +
          `changing this decoder, or the fused default for that field will run instead of this decoder.`,
      );
    }
  }
  if (actual.size === 0) return undefined;
  return Object.fromEntries(actual);
}

/** True when `meta` (a node's, or an `HttpRoute` method entry's) is tagged
 * `tags.unvalidated === true` — see `TAG_UNVALIDATED` (tags.ts). */
function isTaggedUnvalidated(meta: unknown): boolean {
  if (!isRecord(meta)) return false;
  const tags = meta["tags"];
  return isRecord(tags) && tags[TAG_UNVALIDATED] === true;
}

/** The fallback segment's rendering in a path key — `:name`, matching
 * `wrapValidators`/`extractRouteTypeRefs`. */
function fallbackSegment(fallback: Record<string, unknown>): string | undefined {
  const name = fallback["name"];
  return typeof name === "string" ? `:${name}` : undefined;
}

/**
 * The structural walk both `injectValidators` and `collectUncoveredLeaves`
 * share: visit this position, then recurse into `children` and
 * `fallback.subtree`. `visit` returns the (possibly rewritten) shallow copy
 * of this position; the recursion writes `children`/`fallback` back onto it.
 *
 * Every position is rebuilt as a shallow copy with unrecognized fields
 * preserved verbatim — an `HttpRoute` method entry's `sources`, a node's
 * `meta`, anything a projector added — so this never has to know the full
 * shape of what it's walking.
 */
function rewriteTree(
  node: unknown,
  path: readonly string[],
  visit: (node: Record<string, unknown>, path: readonly string[]) => Record<string, unknown>,
): unknown {
  if (!isRecord(node)) return node;
  const out = visit(node, path);
  const children = node["children"];
  if (isRecord(children)) {
    out["children"] = Object.fromEntries(
      Object.entries(children).map(([key, child]) => [
        key,
        rewriteTree(child, [...path, key], visit),
      ]),
    );
  }
  const fallback = node["fallback"];
  if (isRecord(fallback)) {
    const segment = fallbackSegment(fallback);
    if (segment !== undefined) {
      out["fallback"] = {
        ...fallback,
        subtree: rewriteTree(fallback["subtree"], [...path, segment], visit),
      };
    }
  }
  return out;
}

/**
 * Read-only sibling of `rewriteTree` — same structural recursion, no rebuild.
 */
function walkTreePositions(
  node: unknown,
  path: readonly string[],
  visit: (node: Record<string, unknown>, path: readonly string[]) => void,
): void {
  if (!isRecord(node)) return;
  visit(node, path);
  const children = node["children"];
  if (isRecord(children)) {
    for (const [key, child] of Object.entries(children))
      walkTreePositions(child, [...path, key], visit);
  }
  const fallback = node["fallback"];
  if (isRecord(fallback)) {
    const segment = fallbackSegment(fallback);
    if (segment !== undefined) walkTreePositions(fallback["subtree"], [...path, segment], visit);
  }
}

/**
 * Wire `forKey`'s entries onto every matching position of `tree`.
 *
 * A position's validator is looked up by its own path — NOT per HTTP method:
 * an `HttpRoute` position's methods all sit at the same tree path, and all
 * project from the same `Node` leaf, so they share one generated validator
 * (the same one a `Node`-shaped tree would get at that path). This matches
 * the removed `injectValidators` (ad8b921), which likewise applied one
 * path-keyed validator to every method entry at the position.
 */
/**
 * `protocol` (the LITERAL argument `applyValidation(key, tree, protocol?)`
 * was called with — not the codegen-side "omitted means identity" sugar) is
 * threaded through so `resolveHooks` knows which `meta.<protocol>` namespace
 * to read a leaf's function-form `encodingMap` entries off of. A raw `Node`
 * leaf's hooks come off its own `meta`; an `HttpRoute` position's methods
 * each carry their OWN `meta` (that's where an HttpRoute keeps leaf meta —
 * see `collectUncoveredLeaves`'s doc comment for the same fact), so each
 * method entry is resolved independently even though they all share one
 * `entry`/`hookFields` (one path, one generated validator, per
 * `injectValidators`'s own top doc comment).
 */
function injectValidators(
  tree: unknown,
  forKey: Readonly<Record<string, GeneratedEntry>>,
  protocol: ProtocolName | undefined,
): unknown {
  return rewriteTree(tree, [], (node, path) => {
    const entry = forKey[path.join("/")];
    const out: Record<string, unknown> = { ...node };
    if (entry === undefined) return out;
    const leafPath = path.join("/");
    if (typeof node["handler"] === "function") {
      const hooks = resolveHooks(leafPath, entry, node["meta"], protocol);
      out["handler"] = wrapHandler(node["handler"] as AnyHandler, entry, hooks);
    }
    const methods = node["methods"];
    if (isRecord(methods)) {
      out["methods"] = Object.fromEntries(
        Object.entries(methods).map(([verb, methodEntry]) => {
          if (!isRecord(methodEntry) || typeof methodEntry["handler"] !== "function")
            return [verb, methodEntry];
          const hooks = resolveHooks(`${leafPath}[${verb}]`, entry, methodEntry["meta"], protocol);
          return [
            verb,
            {
              ...methodEntry,
              handler: wrapHandler(methodEntry["handler"] as AnyHandler, entry, hooks),
            },
          ];
        }),
      );
    }
    return out;
  });
}

/** Flatten `wireValidators[key]` (path -> protocol -> entry) down to the
 * flat `path -> entry` shape `injectValidators`/`collectUncoveredLeaves`
 * already know how to walk, keeping only the entries for `protocol` — the
 * bridge that lets a 3-arg call reuse both functions completely unchanged. */
function flattenWireForKey(
  forKey:
    | Readonly<Record<string, Readonly<Partial<Record<ProtocolName, GeneratedEntry>>>>>
    | undefined,
  protocol: ProtocolName,
): Readonly<Record<string, GeneratedEntry>> | undefined {
  if (forKey === undefined) return undefined;
  const flat: Record<string, GeneratedEntry> = {};
  for (const [leafPath, byProtocol] of Object.entries(forKey)) {
    const entry = byProtocol[protocol];
    if (entry !== undefined) flat[leafPath] = entry;
  }
  return flat;
}

/**
 * Decision A (phase D retirement of the 2-arg codegen route, see
 * docs/design/wire-profiles-and-staged-validation.md): a 2-arg call —
 * `protocol` omitted — resolves against `validators[key]` (the legacy,
 * hand-authored `ValidatorMap`) FIRST, for backward compatibility with any
 * caller that builds `createApplyValidation` from a hand-rolled map directly
 * (as several of this package's own runtime tests do, independent of
 * codegen). When that's absent, it falls back to `wireValidators[key]`
 * tagged `"identity"` — because codegen (`apply-validation-build.ts`) no
 * longer has a 2-arg-specific extraction/build path at all: EVERY call site,
 * 2-arg or 3-arg, is now compiled through the single staged wire-profile
 * pipeline, with an omitted third argument treated as sugar for the explicit
 * `"identity"` protocol (the design doc's own framing: "the identity profile
 * is `validateEncoding` reduced to a trivial check plus the full
 * `validateConstraints` pass — i.e. what today's check/errors/parse do for an
 * in-process, already-typed value with no wire in between"). This keeps every
 * existing 2-arg call site — including every hand-authored-map test — working
 * unchanged, while giving a 2-arg call site real generated coverage again
 * once codegen has run.
 */
function resolveForKey(
  key: string,
  protocol: ProtocolName | undefined,
  validators: ValidatorMap,
  wireValidators: WireValidatorMap,
): Readonly<Record<string, GeneratedEntry>> | undefined {
  if (protocol !== undefined) return flattenWireForKey(wireValidators[key], protocol);
  return validators[key] ?? flattenWireForKey(wireValidators[key], "identity");
}

/**
 * Build an `applyValidation(key, tree, protocol?)` rewriter over a fixed
 * `ValidatorMap` (2-arg calls) plus an optional `WireValidatorMap` (3-arg
 * calls) — see `ApplyValidation`'s doc comment for the split.
 *
 * - `key` not present in the relevant map → `tree` is returned unchanged.
 *   This is the PASS-THROUGH / pre-codegen case: a freshly scaffolded
 *   project's stub generated module is `createApplyValidation({})` (see
 *   `applyValidationStubSource`, apply-validation-build.ts), so the consumer's
 *   one import compiles and runs before codegen has ever produced validators.
 *   Deliberately SILENT — coverage is enforced by codegen and by the explicit
 *   `assertValidationCoverage` build-mode check below, never by the stub.
 * - Otherwise the tree is walked structurally and every leaf whose path
 *   matches an entry gets its handler(s) wrapped (see `injectValidators`).
 * - Each `key` may be used at most once per returned function, regardless of
 *   `protocol` — a second `applyValidation(sameKey, …)` throws, catching
 *   double registration of one generated set (codegen run twice, two trees
 *   claiming one key). Mirrors the removed runtime's `usedKeys` Set
 *   (ad8b921). A tree shared across two protocols with different wire shapes
 *   needs its OWN key per protocol (decision 1) — `usedKeys` staying
 *   key-only, not key+protocol, is exactly what makes reusing one key twice
 *   under two different protocols an error rather than a silent last-wins.
 *
 * Never mutates `tree`; always returns a freshly rebuilt structure.
 */
export function createApplyValidation(
  validators: ValidatorMap,
  wireValidators: WireValidatorMap = {},
): ApplyValidation {
  const usedKeys = new Set<string>();
  const applyValidation = <T>(key: string, tree: T, protocol?: ProtocolName): T => {
    if (usedKeys.has(key)) {
      throw new Error(`applyValidation: key ${JSON.stringify(key)} has already been used`);
    }
    usedKeys.add(key);
    const forKey = resolveForKey(key, protocol, validators, wireValidators);
    if (forKey === undefined) return tree;
    return injectValidators(tree, forKey, protocol) as T;
  };
  return applyValidation;
}

/**
 * Thrown by `assertValidationCoverage` when one or more leaves of the tree
 * have neither a matching validator entry under `key` nor a
 * `meta.tags.unvalidated` opt-out. Mirrors `build.ts`'s `UnvalidatedLeafError`
 * in shape (`paths` carries EVERY offending path, not just the first) and in
 * remediation messaging; a separate class because phase 1 does not touch
 * build.ts and because the message names this mechanism's own remediation
 * (a `key`-scoped codegen run).
 */
export class UncoveredLeafError extends Error {
  readonly key: string;
  readonly paths: readonly string[];
  constructor(key: string, paths: readonly string[]) {
    super(
      `applyValidation: under key ${JSON.stringify(key)}, the following leaves have no ` +
        `matching generated validator entry and aren't tagged unvalidated:\n${paths.join("\n")}\n\n` +
        `Fix by either regenerating this key's validators (re-run codegen — see ` +
        `@rhi-zone/fractal-api-tree's build/watch/check CLI), or tagging the leaf to ` +
        `opt it out explicitly: op(fn, { tags: { unvalidated: true } }).`,
    );
    this.name = "UncoveredLeafError";
    this.key = key;
    this.paths = paths;
  }
}

/**
 * Every leaf path in `tree` that is neither covered by `forKey` nor tagged
 * `meta.tags.unvalidated`. Both leaf shapes are checked:
 *   - a direct `handler` — the position's own `meta` carries the tag;
 *   - a `methods` record — each entry carries its OWN `meta` (that's where an
 *     `HttpRoute` keeps leaf meta), so a position counts as opted out only
 *     when every handler-bearing method entry is tagged (or the position's own
 *     `meta` is). A position is reported ONCE, by path: methods at one
 *     position share one validator (see `injectValidators`).
 */
function collectUncoveredLeaves(
  tree: unknown,
  forKey: Readonly<Record<string, GeneratedEntry>>,
): string[] {
  const out: string[] = [];
  walkTreePositions(tree, [], (node, path) => {
    const key = path.join("/");
    if (forKey[key] !== undefined) return;
    if (isTaggedUnvalidated(node["meta"])) return;
    if (typeof node["handler"] === "function") {
      out.push(key);
      return;
    }
    const methods = node["methods"];
    if (!isRecord(methods)) return;
    const handlerEntries = Object.values(methods).filter(
      (entry) => isRecord(entry) && typeof entry["handler"] === "function",
    );
    if (handlerEntries.length === 0) return;
    const allTagged = handlerEntries.every(
      (entry) => isRecord(entry) && isTaggedUnvalidated(entry["meta"]),
    );
    if (!allTagged) out.push(key);
  });
  return out;
}

/**
 * LOUD build-mode coverage check: throws `UncoveredLeafError` listing EVERY
 * leaf of `tree` that `validators[key]` doesn't cover and that isn't tagged
 * `meta.tags.unvalidated` — the same total-coverage guarantee `wrapValidators`
 * enforces inline, kept as a separate, explicitly-called function here so the
 * pass-through stub (`createApplyValidation({})`) stays silently permissive
 * pre-codegen. An unknown `key` means "nothing generated for this tree", so
 * every leaf is uncovered — that is exactly what a build-mode caller wants to
 * hear, and exactly what the stub must NOT say at runtime.
 */
export function assertValidationCoverage(
  key: string,
  tree: unknown,
  validators: ValidatorMap,
  options?: { readonly protocol?: ProtocolName; readonly wireValidators?: WireValidatorMap },
): void {
  const forKey =
    resolveForKey(key, options?.protocol, validators, options?.wireValidators ?? {}) ?? {};
  const uncovered = collectUncoveredLeaves(tree, forKey);
  if (uncovered.length > 0) throw new UncoveredLeafError(key, uncovered);
}
