// packages/cli-api-projector/src/cli.ts — @rhi-zone/fractal-cli-api-projector
//
// CLI projection for the function-core tree.
//
// Walks a Node tree along an argv subcommand path, resolving:
//   - Branch children → subcommand prefix segments
//   - `fallback` (wildcard-capture) → the current argv token IS the slug
//     value directly (no separate key segment — same as HTTP: the value
//     itself discriminates, not a tree-authored name)
//   - Leaf children (nodes with handler) → terminal subcommand names
//
// Tag-driven behavior (read directly from the leaf's OWN meta.tags — there is
// no ancestor inheritance; see docs/design/router-model.md — "Tags"):
//   - destructive:true  → io.confirm() before running (skippable via --yes/--force)
//   - readOnly:true     → no confirm
//   - streaming:true    → output each item as a JSONL line (array results)
//   - deprecated:true   → "[DEPRECATED]" marker in command listings + leaf help
//
// Async-generator streaming (see docs/design/middleware-and-caller-context.md
// — "Streaming and Progress"): when a handler returns an `AsyncIterable`
// (detected structurally via `Symbol.asyncIterator`, same as HTTP's
// `isAsyncIterable`), it's streamed incrementally — NOT gated by
// `tags.streaming`/`--jsonl`, which only affect array results. Each yielded
// value is written to stdout as a JSONL line as soon as it's yielded (true
// push streaming, not buffer-then-emit); a `StreamProgress` effect goes to
// stderr as a human-readable `[progress] N% message` line instead; the
// generator's return value is written as the final stdout JSONL line. See
// `streamAsyncIterable` below.
//
// Input field → flag derivation:
//   Named --flags parsed from argv; fallback slug values merged on top
//   (provenance-blind — handler sees one flat input object).
//
// Help: --help at any level prints usage text.
// Output: JSON pretty-printed to io.stdout. Error: thrown CliError (exit code 1).
//
// Design note: runCli throws CliError instead of calling process.exit() directly.
// The caller decides how to handle exit (which lets tests inject without mocking
// process.exit, keeping the test runner alive).
//
// See:
//   packages/api-tree/src/node.ts   — Node, Handler, fallback
//   packages/api-tree/src/tags.ts   — resolveTags
//   packages/api-tree/src/tree.ts — extractToolSchemas, SchemaMap
//   docs/artifacts/fc-op-kinds/projection-cli.md — CLI concept inventory

import { isLeaf } from "@rhi-zone/fractal-api-tree/node";
import { escapeJoin } from "@rhi-zone/fractal-api-tree/path";
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags";
import type { Tags } from "@rhi-zone/fractal-api-tree/tags";
import type { Handler, LeafMeta, Node, SharedMeta } from "@rhi-zone/fractal-api-tree/node";
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree";
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract";
import {
  assemble,
  composeErrorEncoders,
  isCursorPage,
  isOffsetPage,
  isPageShape,
  isResultShape,
  isStreamChunk,
  isStreamProgress,
  matchKind,
} from "@rhi-zone/fractal-api-tree";
import type {
  DetectionOptions,
  EncodingMap,
  ErrorEncoder,
  Page,
  ProjectorStores,
  SourceMap,
  Store,
} from "@rhi-zone/fractal-api-tree";

/**
 * CLI's own store-name fragment: an INERT, plain interface naming the stores
 * this projector builds and the shape each carries. Deliberately NOT a
 * `declare module` augmentation of api-tree's `StoreRegistry` — per
 * docs/design/typed-store-spec.md §3, a projector that augments core makes the
 * type surface depend on which packages are in the compilation rather than on
 * what the deployment composes. A DEPLOYMENT composes this in, once, in its own
 * augmentation file (`interface StoreRegistry extends CliStores {}`); see
 * `HttpStores` in http-api-projector/src/decode.ts for the worked example.
 *
 * Every member is OPTIONAL — per-invocation stores this projector builds when
 * it dispatches. `caller` is NOT declared here: core declares it once
 * (api-tree's `CoreStores`), shared across every projector.
 */
export interface CliStores {
  /** Parsed flags — a repeated flag collects into an array, a valueless flag is `true`. */
  flag?: Store;
  /** Positional/slug params matched against the command path. */
  path?: Store;
  /** The process environment (`process.env`). */
  env?: Store;
}

/**
 * The full per-invocation store bag a CLI dispatch builds and threads through
 * middleware: the shared `Stores` (core's `caller`, plus whatever service
 * stores the deployment registered) intersected with CLI's own fragment. The
 * intersection is what lets this package build and read `flag`/`path`/`env`
 * without its own ambient augmentation — see `HttpStoreBag`'s doc.
 */
export type CliStoreBag = ProjectorStores & CliStores;

import type { AlsConfig } from "@rhi-zone/fractal-api-tree/context";
import { generateCompletions, isShellName } from "./completions.ts";

// ============================================================================
// CliError — thrown instead of process.exit()
// ============================================================================

/**
 * Thrown by runCli on error or abort. `exitCode` is the intended process exit
 * code (1 for errors). The caller (a real main() or test harness) handles it.
 */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

// ============================================================================
// Structured error types — composable error-to-transport mapping
//
// A handler's `Result.err(E)` value is transport-agnostic (e.g.
// `{ kind: "notFound", message: "Book not found" }`). `CliOpts.errorEncoder`
// maps `E` to a `CliErrorResponse` (exit code + message) — mirrors HTTP's
// `HttpErrorEncoder` (packages/http-api-projector/src/route.ts) and MCP's
// `McpErrorEncoder` (packages/mcp-api-projector/src/server.ts). Returning
// `undefined` (including when `errorEncoder` itself is omitted) falls back
// to the existing default: exit 1, `Error: ${JSON.stringify(error)}`.
// ============================================================================

/** An error encoder's CLI-specific target shape — exit code + message. */
export type CliErrorResponse = {
  readonly exitCode: number;
  readonly message: string;
};

/** `ErrorEncoder<E, CliErrorResponse>` — maps a handler's error value to a CLI exit/message. */
export type CliErrorEncoder<E = unknown> = ErrorEncoder<E, CliErrorResponse>;

/**
 * Pre-built `CliErrorEncoder`: maps error `kind` values to an exit code
 * and/or message, e.g. `cliErrors({ notFound: { exit: 2, message: "not
 * found" } })`. `exit` defaults to `1` (the existing default exit code) and
 * `message` defaults to `Error: ${JSON.stringify(error)}` (the existing
 * default message) when omitted for a matched kind — so a mapping entry can
 * override just the exit code, just the message, or both. Internally a
 * `composeErrorEncoders` over one `matchKind` per mapping entry — first
 * match wins (object key order).
 */
export function cliErrors<E = unknown>(
  mapping: Record<string, { exit?: number; message?: string }>,
): CliErrorEncoder<E> {
  const encoders = Object.entries(mapping).map(([kind, override]) =>
    matchKind<{ exit?: number; message?: string }>(kind, override),
  );
  const composed = composeErrorEncoders(...encoders);
  return (error) => {
    const matched = composed(error);
    if (matched === undefined) return undefined;
    return {
      exitCode: matched.exit ?? 1,
      message: matched.message ?? `Error: ${JSON.stringify(error)}`,
    };
  };
}

// ============================================================================
// Injectable IO interface
// ============================================================================

/**
 * Injectable IO interface for testability.
 *
 * All writes go through stdout/stderr; confirm() handles destructive prompts.
 * Defaults: process.stdout, process.stderr, readline-based confirm.
 */
export type CliIO = {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  confirm(prompt: string): Promise<boolean>;
};

// ============================================================================
// Options
// ============================================================================

export type CliOpts<T = unknown> = {
  /**
   * Pre-computed schema map (from extractToolSchemas). Used for HELP TEXT
   * generation only (`buildHelp`/`buildLeafHelp`) and for generated shell
   * completions (`generateCompletions`, ./completions.ts) — it derives
   * per-field flag names/types/required-ness for display. It is NOT
   * consulted for decode/validation/defaults: that's the generated wire
   * validator's job now (see `rewriters` below). When `schemas` is absent,
   * help text just can't list per-field flags for a leaf; dispatch itself is
   * unaffected.
   */
  readonly schemas?: SchemaMap;
  /**
   * Program name used in usage/help text and generated completion scripts.
   * Defaults to "cli".
   */
  readonly programName?: string;
  /**
   * Program version string, printed (and returned from) on `--version`/`-V`.
   * When absent, `--version` falls through to a CliError — there's nothing
   * to print.
   */
  readonly version?: string;
  /**
   * Additional `Node => Node` passes, applied in array order, to `rootNode`
   * before dispatch — CLI's counterpart to HTTP's `PresetOptions.rewriters`
   * (`packages/http-api-projector/src/preset.ts`). This is also where
   * generated VALIDATION wires in, via `applyValidation(key, tree)`
   * (`@rhi-zone/fractal-api-tree/apply-validation`) — there is no dedicated
   * `validators` option (removed, phase 3): `applyValidation`'s call site
   * must live in the CONSUMER's own entry file for codegen to anchor on it
   * (see that module's doc comment), so `runCli` itself can never own the
   * call.
   *
   * ```ts
   * import { applyValidation } from "./generated/apply-validation.ts"
   * await runCli(node, argv, io, {
   *   rewriters: [(tree) => applyValidation("books", tree)],
   * })
   * ```
   *
   * Unlike HTTP's `HttpRoute` projection, CLI dispatches directly off the
   * `Node` tree it's given — there is no separate "projected" shape for
   * `rewriters` to run after, so a rewrite here applies to `rootNode`
   * itself, before any subcommand resolution.
   *
   * This is also where a leaf's decode+validate actually comes from, now
   * that there is no local fallback: pass `"cli"` as `applyValidation`'s
   * third argument to opt a tree into wire-profile-driven staged decode +
   * validation for CLI's argv wire shape (`string | string[] | true`,
   * per-field derived via `@rhi-zone/fractal-api-tree/wire-derive`'s
   * `deriveFieldProfiles`):
   *
   * ```ts
   * import { applyValidation } from "./generated/apply-validation.ts"
   * await runCli(node, argv, io, {
   *   rewriters: [(tree) => applyValidation("books", tree, "cli")],
   * })
   * ```
   *
   * A leaf with no matching generated validator entry — because no
   * `applyValidation` rewriter names it, or because codegen hasn't run yet
   * for this tree (`createApplyValidation`'s stub is pass-through by
   * design) — gets the raw assembled wire input (see `buildInput`) passed
   * straight to its handler: no decode, no coercion, no defaults-fill, no
   * required-field check. There is no other path; that fallback was deleted
   * (see docs/design/wire-profiles-and-staged-validation.md, "What goes
   * away").
   */
  readonly rewriters?: ReadonlyArray<(tree: Node) => Node>;
  /**
   * Wrap the handler call so it runs inside its own `AsyncLocalStorage`
   * context. `init` computes the per-invocation context value from
   * CLI-specific dispatch context (see `CliAlsContext`). Mirrors HTTP's
   * `PresetOptions.als` (`packages/http-api-projector/src/preset.ts`). ALS is
   * the INNERMOST wrapper — closer to the handler than `opts.middleware` —
   * so the store is active only while `target.handler` (and anything it
   * calls, transitively) runs; a `CliMiddleware`'s own code, before or after
   * calling `next`, is NOT itself inside the ALS context — Node's
   * `AsyncLocalStorage` doesn't propagate back out through an `await`'d call
   * once it settles. A middleware that needs cross-cutting context should
   * read it from `stores` (the second parameter every `CliMiddleware`
   * receives), or read the ALS store from code it invokes synchronously
   * inside `next`. Absent by default (no ALS wrapping).
   */
  readonly als?: AlsConfig<CliAlsContext, T>;
  /**
   * Around-hooks wrapping the handler call — `F => F` where
   * `F = (input, stores) => result` (see
   * docs/design/middleware-and-caller-context.md). Composes like an onion:
   * the first entry in the array is the OUTERMOST wrapper (it sees the call
   * first and last), matching HTTP's layer composition
   * (`packages/http-api-projector/src/layers.ts`). `stores` is the raw
   * pre-assembly stores built for input assembly (see `buildInput`) — the
   * vehicle for cross-cutting concerns (caller identity, audit, ...); the
   * handler itself never sees `stores`.
   *
   * When omitted (or empty), the handler is called directly — zero overhead.
   */
  readonly middleware?: readonly CliMiddleware[];
  /**
   * Opt-in configuration for the structural sniffing `runCli` applies to a
   * handler's return value — `result` gates `Result`-shape
   * (`{kind:"ok"|"err"}`) unwrapping, `streaming` gates `AsyncIterable`
   * detection (and, transitively, `StreamEffect` tag interpretation on its
   * yields via `streamAsyncIterable`). Both default to `true` — existing
   * behavior — when `detection` itself, or either field, is omitted.
   * Disable one when a handler legitimately returns/yields data shaped like
   * one of these DUs and it must NOT be reinterpreted as the transport
   * protocol (see `docs/design/middleware-and-caller-context.md`'s
   * "Streaming and Progress" section, and `DetectionOptions`'s own doc,
   * `@rhi-zone/fractal-api-tree`). Mirrors HTTP's `PresetOptions.detection`
   * (`packages/http-api-projector/src/preset.ts`) and MCP's
   * `CreateMcpServerOptions.detection`.
   */
  readonly detection?: DetectionOptions;
  /**
   * Maps a handler's `Result.err(E)` error value to a `CliErrorResponse`
   * (exit code + message) — see `CliErrorEncoder`/`cliErrors` above. Called
   * from `runCli` when `detection.result` is on (default `true`) and a
   * handler returns `{kind:"err", error}`. Returning `undefined` (including
   * when `errorEncoder` itself is omitted) falls back to the existing
   * default: exit 1, `Error: ${JSON.stringify(error)}`. Compose several
   * encoders with `composeErrorEncoders` (`@rhi-zone/fractal-api-tree`) —
   * first match wins. Mirrors HTTP's `PresetOptions.errorEncoder`
   * (`packages/http-api-projector/src/preset.ts`) and MCP's
   * `CreateMcpServerOptions.errorEncoder`
   * (`packages/mcp-api-projector/src/server.ts`).
   */
  readonly errorEncoder?: CliErrorEncoder;
};

// ============================================================================
// Middleware — around-hooks wrapping the handler call
//
// Middleware is F => F, where F = (input, stores) => result — see
// docs/design/middleware-and-caller-context.md. `input` is the assembled,
// validated domain arguments (same shape the handler receives); `stores` is
// the raw pre-assembly stores built by `buildInput`. The handler itself is
// `(input) => result` — it never receives `stores`; that's structural (see
// the `(input, _stores) => handler(input)` base in `runCli`), not a
// convention to remember.
// ============================================================================

/**
 * A CLI middleware wraps the handler-invoking function `next` (itself
 * `F => F`, see module doc above). Middleware compose like HTTP layers:
 * `runCli` applies `opts.middleware` outermost-first (see `CliOpts`).
 */
export type CliMiddleware = (
  next: (input: Record<string, unknown>, stores: CliStoreBag) => unknown | Promise<unknown>,
) => (input: Record<string, unknown>, stores: CliStoreBag) => unknown | Promise<unknown>;

/**
 * Compose `middleware` around `base`, first entry outermost — `middleware[0]`
 * wraps `middleware[1]` wraps ... wraps `base`. An empty array returns `base`
 * unchanged (identity — no wrapping overhead).
 */
function composeMiddleware(
  middleware: readonly CliMiddleware[],
  base: (input: Record<string, unknown>, stores: CliStoreBag) => unknown | Promise<unknown>,
): (input: Record<string, unknown>, stores: CliStoreBag) => unknown | Promise<unknown> {
  let wrapped = base;
  for (let i = middleware.length - 1; i >= 0; i--) {
    wrapped = middleware[i]!(wrapped);
  }
  return wrapped;
}

// ============================================================================
// ALS dispatch context — separate from CliMiddleware's (input, stores). ALS
// is a side channel (see docs/design/middleware-and-caller-context.md); this
// is dispatch metadata for `CliOpts.als`'s `init`, not a context bag threaded
// through middleware.
// ============================================================================

/** Dispatch context `CliOpts.als`'s `init` receives. */
export type CliAlsContext = {
  readonly meta: LeafMeta;
  readonly io: CliIO;
  readonly slugs: Record<string, string>;
  readonly leafName: string;
};

// ============================================================================
// CLI meta extraction
// ============================================================================

/**
 * `meta.cli` open bag — per-projection overrides for CLI subcommand
 * generation, split by role (docs/design/meta-role-split-spec.md §2/§4).
 * Standard keys are typed; any other key passes through untouched (open
 * bag, not a fixed schema) at BOTH roles.
 */

/** `meta.cli` fields valid at BOTH leaf and branch position. */
export type CliSharedMetaProperties = {
  /** Hides this leaf/branch from generated help text (`buildHelp`) without removing it from dispatch. */
  readonly hidden?: boolean;
  readonly [key: string]: unknown;
};

/** Wraps `CliSharedMetaProperties` under the `cli` key — extend `SharedMeta` with this in a deployment's augmentation file. */
export type CliSharedMeta = {
  readonly cli?: CliSharedMetaProperties;
};

/** `meta.cli` fields valid at LEAF position only. */
export type CliLeafMetaProperties = CliSharedMetaProperties & {
  readonly name?: string;
  readonly alias?: string;
  /**
   * Per-param source overrides for this leaf's input assembly (see
   * `packages/api-tree/src/input.ts`). Lets a tree author pull a field from
   * a store other than the CLI's default ("flag") — e.g.
   * `{ apiKey: { store: "env", key: "API_KEY" } }` to require an environment
   * variable instead of a `--api-key` flag. Params not listed here still
   * resolve via the normal flag/slug convention.
   */
  readonly sourceMap?: SourceMap;
  /**
   * Keyed partial contribution — per-field wire-encoding overrides layered
   * on top of `sourceMap`'s per-field STORE choice (phase B/E, docs/design/
   * wire-profiles-and-staged-validation.md), mirroring HTTP's own
   * `encodingMap` (`HttpLeafMetaProperties`, http-api-projector's
   * project.ts). Each entry is either a base-profile-name STRING
   * (overriding that field's derived wire profile outright) or a custom
   * decoder FUNCTION run at WRAP time instead of the fused default decode.
   * Declared here structurally (see `EncodingMap`'s own doc comment,
   * api-tree's input.ts) — a function entry's own param/return types are
   * checked separately, against the literal object passed to `op()`, by
   * `MismatchedEncodingMapDecoders`/`CheckedContributions` (api-tree's
   * input.ts/node.ts), not by this declared field type.
   */
  readonly encodingMap?: EncodingMap;
  /**
   * Overrides the input field names `--all-pages` merges the next cursor/
   * offset into, when this leaf's result is page-shaped (`CursorPage<T>`/
   * `OffsetPage<T>`, see `@rhi-zone/fractal-api-tree/page`) — mirrors HTTP's
   * `paginated()` directive (`http-api-projector/src/verbs.ts`). Detection of
   * "is this command paginated at all" is a RUNTIME shape check on the
   * actual result (`isPageShape`), same "conventions over contracts"
   * split every other stream/page convention in this codebase uses — this
   * only overrides which flag name carries the cursor/offset on the NEXT
   * call, when the leaf's own input field doesn't already default to
   * `"cursor"`/`"offset"`.
   */
  readonly paginated?: {
    readonly inputCursorParam?: string;
    readonly inputOffsetParam?: string;
  };
};

/** Wraps `CliLeafMetaProperties` under the `cli` key — extend `LeafMeta` with this in a deployment's augmentation file. */
export type CliLeafMeta = {
  readonly cli?: CliLeafMetaProperties;
};

/**
 * Parse `meta.cli`. Accepts `CliLeafMeta` (the broader of the two roles,
 * since `CliLeafMetaProperties extends CliSharedMetaProperties`) — called
 * on both leaf meta (reading `.name`/`.alias`/`.paginated`/`.sourceMap`)
 * and branch meta (reading only `.hidden`, always via `CliLeafMeta`'s
 * inherited `CliSharedMetaProperties` shape) at different call sites below.
 */
export function getCliMeta(meta: CliLeafMeta): CliLeafMetaProperties {
  const c = meta.cli;
  if (typeof c !== "object" || c === null) return {};
  return c;
}

// ============================================================================
// Resolution: walk the Node tree along argv segments
// ============================================================================

/**
 * Resolved dispatch target: the leaf handler to call, the accumulated slug
 * values from `fallback` traversal, and a SNAPSHOT of the leaf's `meta.cli`
 * fields that dispatch itself needs — the CLI counterpart of mcp/graphql/
 * json-rpc's `Dispatch` type (each built once per leaf, carrying its own
 * already-parsed `sourceMap` rather than re-parsing it at read time). CLI
 * has no separate build-once/dispatch-many projection phase the way those
 * three (and HTTP's `HttpRoute` build) do — a leaf's terminal argv segment
 * can be a `fallback`-captured slug value only known from THIS invocation's
 * own argv, so a `Resolved` can't be precomputed ahead of a specific call
 * the way a whole-tree `Dispatch` map can — but the fields below ARE
 * resolved exactly once, here, at the point `resolveLeaf` finds the leaf,
 * rather than being re-derived from `leafMeta` at whichever later point in
 * `runCli` happens to need them (see `runCli`'s own use of `target.sourceMap`
 * for the read site this snapshot replaces).
 */
type Resolved = {
  readonly handler: Handler;
  readonly slugs: Record<string, string>;
  readonly leafName: string;
  readonly leafMeta: LeafMeta;
  /** Snapshot of `getCliMeta(leafMeta).sourceMap`, resolved once, here. */
  readonly sourceMap: SourceMap;
  /**
   * The path used to look up this leaf's schema in a `SchemaMap`, i.e. the
   * same underscore-joined segments `extractToolSchemas` (packages/api-tree/
   * src/tree.ts) produces: fallback segments are named by `fallback.name`
   * (e.g. "bookId"), NOT by the runtime slug value the user typed on argv.
   * Distinct from the raw argv path segments, which contain the literal
   * slug value at that position.
   */
  readonly schemaPath: string[];
};

/**
 * Find a leaf child of `children` whose `meta.cli.alias` equals `head`.
 * Returns the child's canonical key (NOT the alias) alongside the node —
 * schema lookups and help text key off the canonical name, so an alias is
 * purely an alternate invocation spelling, never a rename.
 */
function findLeafByAlias(children: Record<string, Node>, head: string): [string, Node] | undefined {
  for (const [key, child] of Object.entries(children)) {
    if (isLeaf(child) && getCliMeta(child.meta as CliLeafMeta).alias === head) return [key, child];
  }
  return undefined;
}

/**
 * Walk the node tree along argv segments, resolving:
 *
 *   Static child (no handler) → consume segment, recurse
 *   No static match + `fallback` present → consume current segment as the
 *     slug value directly, bind it as `fallback.name`, recurse into subtree
 *   Leaf child (has handler) at tail → terminal; return resolved
 *
 * A leaf child's `meta.cli.alias` (see `CliMeta`) is also accepted at the
 * terminal position — `head` may name either the leaf's own key or its
 * alias. The resolved `leafName`/`schemaPath` always use the canonical key.
 *
 * Returns null if no matching path is found.
 */
function resolveLeaf(
  n: Node,
  segments: string[],
  slugs: Record<string, string>,
  schemaPath: string[] = [],
): Resolved | null {
  if (segments.length === 0) return null;
  const [head, ...tail] = segments;
  if (head === undefined) return null;

  const children = n.children ?? {};

  // Terminal: head should name a leaf child, by its own key or its alias
  if (tail.length === 0) {
    const direct = children[head];
    const [key, child] =
      direct !== undefined
        ? [head, direct]
        : (findLeafByAlias(children, head) ?? [head, undefined]);
    if (child !== undefined && isLeaf(child)) {
      return {
        handler: child.handler!,
        slugs,
        leafName: key,
        leafMeta: child.meta,
        sourceMap: getCliMeta(child.meta as CliLeafMeta).sourceMap ?? {},
        schemaPath: [...schemaPath, key],
      };
    }

    // No static/alias match at the terminal segment — if `head` isn't a
    // literal key at all, it may BE the fallback-captured slug value, with
    // the fallback subtree itself a bare leaf (`op()`, no further
    // subcommand). The Node model allows this (see api-tree/node.ts's doc);
    // without this check `head` is a dead end even though a real handler
    // sits at `fallback.subtree` — same blind spot as the listing walks
    // above (api-tree/tree.ts's `walkNodeType` fix, aa28952), just on the
    // dispatch side: `head` IS the slug value directly (no separate key
    // segment), matching the non-terminal fallback branch below.
    if (n.fallback !== undefined && isLeaf(n.fallback.subtree)) {
      return {
        handler: n.fallback.subtree.handler!,
        slugs: { ...slugs, [n.fallback.name]: head },
        leafName: n.fallback.name,
        leafMeta: n.fallback.subtree.meta,
        sourceMap: getCliMeta(n.fallback.subtree.meta as CliLeafMeta).sourceMap ?? {},
        schemaPath: [...schemaPath, n.fallback.name],
      };
    }

    return null;
  }

  // Non-terminal: try a static child first (static children always win)
  const staticChild = children[head];
  if (staticChild !== undefined) {
    if (!isLeaf(staticChild)) {
      return resolveLeaf(staticChild, tail, slugs, [...schemaPath, head]);
    }
    // A leaf child at non-tail is a dead-end (a leaf has no children to recurse into)
    return null;
  }

  // No static match — fall back to the wildcard-capture subtree, if any.
  // `head` IS the slug value directly (no separate key segment); the
  // schema path instead records `fallback.name`, matching how
  // extractToolSchemas names the fallback subtree's tools.
  if (n.fallback !== undefined) {
    return resolveLeaf(n.fallback.subtree, tail, { ...slugs, [n.fallback.name]: head }, [
      ...schemaPath,
      n.fallback.name,
    ]);
  }

  return null;
}

// ============================================================================
// Help text generation
// ============================================================================

function descriptionFrom(meta: SharedMeta & CliLeafMeta): string | undefined {
  if (typeof meta.description === "string") return meta.description;
  const cliMeta = getCliMeta(meta);
  if (typeof cliMeta.description === "string") return cliMeta.description;
  return undefined;
}

function buildHelp(n: Node, path: string[], programName: string): string {
  const lines: string[] = [];
  const cmd = [programName, ...path].join(" ");

  const desc = descriptionFrom(n.meta);
  if (desc !== undefined) lines.push(desc, "");

  lines.push(`Usage: ${cmd} <subcommand> [options]`, "");

  const children = n.children ?? {};

  // List leaf children (callables)
  const leafEntries = Object.entries(children).filter(([, child]) => isLeaf(child));
  if (leafEntries.length > 0) {
    lines.push("Commands:");
    for (const [key, child] of leafEntries) {
      const cliMeta = getCliMeta(child.meta as CliLeafMeta);
      if (cliMeta.hidden === true) continue;
      const leafDesc = descriptionFrom(child.meta);
      const leafName = typeof cliMeta.name === "string" ? cliMeta.name : key;
      const aliasSuffix = typeof cliMeta.alias === "string" ? ` (alias: ${cliMeta.alias})` : "";
      const deprecatedPrefix =
        resolveTags((child.meta.tags ?? {}) as Tags).deprecated === true ? "[DEPRECATED] " : "";
      lines.push(
        `  ${deprecatedPrefix}${leafName}${aliasSuffix}${leafDesc !== undefined ? `  — ${leafDesc}` : ""}`,
      );
    }
  }

  // List branch children
  const nonLeafEntries = Object.entries(children).filter(([, child]) => !isLeaf(child));
  if (nonLeafEntries.length > 0 || n.fallback !== undefined) {
    if (leafEntries.length > 0) lines.push("");
    lines.push("Subcommand groups:");
    for (const [key, child] of nonLeafEntries) {
      const cliMeta = getCliMeta(child.meta as CliLeafMeta);
      if (cliMeta.hidden === true) continue;
      const childDesc = descriptionFrom(child.meta);
      lines.push(`  ${key}${childDesc !== undefined ? `  — ${childDesc}` : ""}`);
    }
    if (n.fallback !== undefined) {
      const cliMeta = getCliMeta(n.fallback.subtree.meta as CliLeafMeta);
      if (cliMeta.hidden !== true) {
        lines.push(`  <${n.fallback.name}>  — parameterized group`);
      }
    }
  }

  lines.push("");
  lines.push("Global flags:");
  lines.push("  --help        Show this help text");
  lines.push("  --version, -V  Print the program version");
  lines.push("  --json        Output result as JSON (default)");
  lines.push("  --yes, --force  Skip confirmation prompts for destructive ops");
  lines.push("");
  lines.push(`Run '${cmd} completions <bash|zsh|fish>' to print a shell completion script.`);

  return lines.join("\n") + "\n";
}

function buildLeafHelp(
  resolved: Resolved,
  path: string[],
  programName: string,
  schemas: SchemaMap,
): string {
  const lines: string[] = [];
  const cmd = [programName, ...path].join(" ");
  const desc = descriptionFrom(resolved.leafMeta);
  if (desc !== undefined) lines.push(desc, "");
  lines.push(`Usage: ${cmd} [options]`, "");

  const tags = resolveTags((resolved.leafMeta.tags ?? {}) as Tags);
  if (tags.deprecated === true)
    lines.push("  [DEPRECATED] This operation is deprecated and may be removed.", "");
  if (tags.destructive === true)
    lines.push(
      "  This operation is destructive and irreversible. Requires --yes/--force to skip confirmation.",
      "",
    );
  if (tags.readOnly === true) lines.push("  This operation is read-only.", "");
  if (tags.streaming === true)
    lines.push("  This operation streams results (one JSON object per line).", "");

  // Derive flags from schema — schemaPath uses fallback.name (e.g. "bookId"),
  // not the runtime slug value, matching extractToolSchemas' key convention.
  // escape-joined (@rhi-zone/fractal-api-tree/path) so a schema-path segment
  // containing "_" can't derive the same lookup key as a different, deeper
  // tree position — same fix as completions.ts's `schemaKeyFor`, and the
  // trailing dash normalization is preserved unchanged (see that function's
  // doc comment for why it's safe to apply after escaping).
  const schemaName = escapeJoin(resolved.schemaPath, "_").replace(/-/g, "_");
  const toolSchema = schemas[schemaName];

  lines.push("Options:");
  lines.push("  --help        Show this help text");
  lines.push("  --yes, --force  Skip confirm for destructive ops");
  lines.push("  --json        Output as JSON (default)");

  if (toolSchema?.inputSchema.properties !== undefined) {
    const props = toolSchema.inputSchema.properties;
    const required = toolSchema.inputSchema.required ?? [];
    for (const [field, fieldSchema] of Object.entries(props)) {
      const isRequired = required.includes(field);
      // `extractToolSchemas` (packages/api-tree/src/extract.ts) populates
      // per-field `description` from each property's leading JSDoc comment.
      const fsDesc = fieldSchema.description;
      const req = isRequired ? " (required)" : " (optional)";
      const typeHint = describeFieldType(fieldSchema);
      lines.push(
        `  --${field}${typeHint !== undefined ? `  <${typeHint}>` : ""}${fsDesc !== undefined ? `  ${fsDesc}` : ""}${req}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

/** Short human-readable type hint for a field's help line, e.g. "number" or "enum: a|b|c". */
function describeFieldType(fieldSchema: JsonSchema): string | undefined {
  if (fieldSchema.enum !== undefined) return `enum: ${fieldSchema.enum.join("|")}`;
  if (fieldSchema.type === "array") {
    const items = fieldSchema.items;
    if (items !== undefined && items !== false) {
      const itemType = describeFieldType(items);
      if (itemType !== undefined) return `${itemType}[]`;
    }
    return "array";
  }
  return fieldSchema.type;
}

// ============================================================================
// Argv parsing
// ============================================================================

type ParsedArgv = {
  flags: Record<string, string | string[] | true>;
  help: boolean;
  version: boolean;
  yes: boolean;
  json: boolean;
  jsonl: boolean;
  allPages: boolean;
};

/**
 * Parse named --flags from argv into a flat object.
 * Boolean flags (no following value, or next arg starts with --) → true.
 * Repeated flags → array.
 * Extracts: --help, --version/-V, --yes/--force, --json, --jsonl, --all-pages.
 */
function parseFlags(argv: string[]): ParsedArgv {
  const flags: Record<string, string | string[] | true> = {};
  let help = false;
  let version = false;
  let yes = false;
  let json = false;
  let jsonl = false;
  let allPages = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i++;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      i++;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      version = true;
      i++;
      continue;
    }
    if (arg === "--yes" || arg === "--force" || arg === "-y") {
      yes = true;
      i++;
      continue;
    }
    if (arg === "--json") {
      json = true;
      i++;
      continue;
    }
    if (arg === "--jsonl") {
      jsonl = true;
      i++;
      continue;
    }
    if (arg === "--all-pages") {
      allPages = true;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        // Boolean flag
        flags[key] = true;
        i++;
      } else {
        // Key-value flag; handle repeated
        const existing = flags[key];
        if (existing === undefined) {
          flags[key] = next;
        } else if (Array.isArray(existing)) {
          existing.push(next);
        } else if (typeof existing === "string") {
          flags[key] = [existing, next];
        }
        i += 2;
      }
      continue;
    }

    // Ignore non-flag args in the rest (path segments are already separated)
    i++;
  }

  return { flags, help, version, yes, json: json || !jsonl, jsonl, allPages };
}

// ============================================================================
// Build handler input from parsed flags + slugs
// ============================================================================

/**
 * Assemble the handler's input bag from the CLI's named stores, via the
 * shared resolution pipeline (`packages/api-tree/src/input.ts`).
 *
 * Stores:
 *   - "flag": parsed --flags (parseFlags result)
 *   - "path": accumulated `fallback`-captured slug values — named "path" (not
 *     "slug") because `assemble`'s `pathParamNames` resolution is hardcoded to
 *     read from a store literally named "path" (see input.ts)
 *   - "env":  process.env — new capability, reachable only via `sourceMap`
 *     (no implicit convention pulls a field from the environment)
 *
 * Primary store is "flag" (unmarked params default to a CLI flag). Slug
 * keys are passed as `pathParamNames` so they always win over a same-named
 * flag — matching the prior hardcoded merge order (slugs overlay flags).
 *
 * `paramNames` is the union of every key any store could produce: flag
 * keys, slug keys, and any name declared in `sourceMap` (so a field pulled
 * purely from an override — e.g. `apiKey` from "env" with no `--api-key`
 * flag — is still assembled even though it never appears in `flags`). This
 * keeps schema-less trees (no fixed field list) working exactly as before:
 * with an empty `sourceMap`, this reduces to the old flags+slugs merge.
 *
 * Returns the `stores` alongside the assembled `input` bag — `stores` is
 * threaded into `CliMiddleware` (see above), which sees both the assembled
 * input AND the raw pre-assembly stores; the handler itself only ever sees
 * `input`.
 *
 * `caller` is populated from OS-level identity — `caller.user` returns
 * `process.env.USER` (falling back to `USERNAME`, set on Windows), the CLI's
 * closest analog to HTTP's auth headers / MCP's `authInfo`. Anything richer
 * (a config-file identity, a stored auth token) is the consumer's job to
 * layer on top — see docs/design/middleware-and-caller-context.md.
 */
function buildInput(
  flags: Record<string, string | string[] | true>,
  slugs: Record<string, string>,
  sourceMap: SourceMap,
): { readonly input: Record<string, unknown>; readonly stores: CliStoreBag } {
  const caller: Record<string, unknown> = {
    user: process.env.USER ?? process.env.USERNAME,
  };
  const stores: CliStoreBag = {
    flag: flags,
    path: slugs,
    env: process.env as Record<string, unknown>,
    caller,
  };

  const paramNames = [
    ...new Set([...Object.keys(flags), ...Object.keys(slugs), ...Object.keys(sourceMap)]),
  ];

  return { input: assemble(stores, paramNames, sourceMap, "flag", Object.keys(slugs)), stores };
}

// ============================================================================
// Levenshtein distance — used by `suggestCommand` (below) for "did you mean"
// unknown-subcommand hints. No decode/coercion runs in this package anymore —
// that's the generated wire validator's job now, wired via
// `applyValidation(key, tree, "cli")` (see `CliOpts.rewriters`'s doc comment).
// ============================================================================

/** Levenshtein edit distance. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    dp.push(row);
  }
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

// ============================================================================
// Default IO (process-backed)
// ============================================================================

const defaultIO: CliIO = {
  stdout: { write: (s: string) => process.stdout.write(s) },
  stderr: { write: (s: string) => process.stderr.write(s) },
  confirm: async (_prompt: string): Promise<boolean> => false,
};

// ============================================================================
// runCli — public API
// ============================================================================

/**
 * Dispatch a Node tree from argv.
 *
 * argv should be the arguments AFTER the program name (i.e. process.argv.slice(2)).
 * Leading non-flag tokens are consumed as the subcommand path; remaining
 * --flags are parsed as handler input fields.
 *
 * Throws CliError (with exitCode) instead of calling process.exit() directly —
 * the caller (a real main() entry point) is responsible for actually exiting.
 * This keeps bun test alive when errors occur.
 *
 * @param rootNode - The root Node to dispatch into. Passed through
 *   `opts.rewriters` first, in array order (see `CliOpts.rewriters`).
 * @param argv - Arguments after program name.
 * @param io   - Injectable IO (stdout, stderr, confirm). Defaults to process streams.
 * @param opts - Options: schemas map from codegen.
 */
export async function runCli<T = unknown>(
  rootNode: Node,
  argv: string[],
  io: Partial<CliIO> = {},
  opts: CliOpts<T> = {},
): Promise<void> {
  const ioResolved: CliIO = { ...defaultIO, ...io };
  const schemas: SchemaMap = opts.schemas ?? {};
  const programName = opts.programName ?? "cli";
  // Apply any consumer-supplied Node => Node rewriters BEFORE any dispatch —
  // see `CliOpts.rewriters`. This is where generated validation wires in
  // (`applyValidation`), same integration point HTTP's `PresetOptions.
  // rewriters` provides.
  let n = rootNode;
  for (const rewrite of opts.rewriters ?? []) n = rewrite(n);

  // Split argv into subcommand-path segments vs flag tokens.
  // Strategy: consume leading non-flag tokens as path segments; everything
  // after the first --flag is treated as flag argv.
  const pathSegments: string[] = [];
  const flagArgv: string[] = [];
  let seenFlag = false;
  for (const arg of argv) {
    if (seenFlag || arg.startsWith("-")) {
      seenFlag = true;
      flagArgv.push(arg);
    } else {
      pathSegments.push(arg);
    }
  }

  // `completions <shell>` — a reserved top-level command (not part of the
  // authored tree) that prints a static shell completion script derived from
  // the tree structure + schemas. See ./completions.ts.
  if (pathSegments[0] === "completions") {
    const shellArg = pathSegments[1];
    if (!isShellName(shellArg)) {
      ioResolved.stderr.write(`Usage: ${programName} completions <bash|zsh|fish>\n`);
      throw new CliError("Unknown or missing shell for completions", 1);
    }
    ioResolved.stdout.write(generateCompletions(shellArg, n, schemas, programName));
    return;
  }

  const { flags, help, version, yes, json: _json, jsonl, allPages } = parseFlags(flagArgv);

  // --version — print the configured program version and return. Takes
  // priority over subcommand resolution (mirrors --help), since it's a
  // program-level query, not a subcommand-scoped one.
  if (version) {
    if (opts.version === undefined) {
      ioResolved.stderr.write("No version configured for this program.\n");
      throw new CliError("No version configured", 1);
    }
    ioResolved.stdout.write(opts.version + "\n");
    return;
  }

  // No subcommand args — show root help
  if (pathSegments.length === 0) {
    if (help) {
      ioResolved.stdout.write(buildHelp(n, [], programName));
      return;
    }
    ioResolved.stderr.write(
      `Usage: ${programName} <subcommand> [options]\nRun with --help for usage.\n`,
    );
    throw new CliError("No subcommand provided", 1);
  }

  // --help requested — show help for the subcommand path
  if (help) {
    // Try to resolve to a leaf first
    const target = resolveLeaf(n, pathSegments, {});
    if (target !== null) {
      ioResolved.stdout.write(buildLeafHelp(target, pathSegments, programName, schemas));
      return;
    }
    // Otherwise walk to a branch child for group help
    let cursor: Node = n;
    let depth = 0;
    for (const seg of pathSegments) {
      const child = (cursor.children ?? {})[seg];
      if (child !== undefined && !isLeaf(child)) {
        cursor = child;
        depth++;
      } else {
        break;
      }
    }
    ioResolved.stdout.write(buildHelp(cursor, pathSegments.slice(0, depth), programName));
    return;
  }

  // Resolve the leaf handler
  const target = resolveLeaf(n, pathSegments, {});
  if (target === null) {
    const typed = pathSegments.join(" ");
    const suggestion = suggestCommand(n, pathSegments);
    const hint = suggestion !== undefined ? ` Did you mean "${suggestion}"?` : "";
    ioResolved.stderr.write(`Unknown command: "${typed}".${hint}\nRun with --help for usage.\n`);
    throw new CliError(`Unknown command: "${typed}".${hint}`, 1);
  }

  // Tags are read directly from the leaf's own meta — no ancestor inheritance.
  const tags = resolveTags((target.leafMeta.tags ?? {}) as Tags);

  // Confirm for destructive ops (unless --yes/--force)
  if (tags.destructive === true && !yes) {
    const ok = await ioResolved.confirm("This operation is destructive and irreversible. Proceed?");
    if (!ok) {
      ioResolved.stderr.write("Aborted.\n");
      throw new CliError("Aborted by user", 1);
    }
  }

  // Build input: flags + slugs (provenance-blind merge) via the shared
  // resolution pipeline. Snapshot-at-resolution, not a live re-read:
  // `target.sourceMap` was already resolved once, inside `resolveLeaf`, at
  // the point this leaf was found — see `Resolved`'s doc comment. Matches
  // mcp/graphql/json-rpc's `Dispatch.sourceMap` (each populated once when the
  // dispatch table is built) and HTTP's `meta.http.sourceMap` (resolved once
  // when the `HttpRoute` tree is built) — CLI's own minimal equivalent of a
  // projection-time snapshot, given CLI has no separate build-once/
  // dispatch-many phase (see `Resolved`'s doc for why).
  //
  // No local decode/coercion/defaults/required-field step runs here anymore
  // — that fallback was deleted (see docs/design/
  // wire-profiles-and-staged-validation.md, "What goes away"). If this
  // leaf's tree was passed through `applyValidation(key, tree, "cli")` (see
  // `CliOpts.rewriters`), `target.handler` is ALREADY wrapped to decode +
  // validate `rawInput` before running; if not (no rewriter names this leaf,
  // or codegen hasn't run yet), `rawInput` — raw wire values, `string |
  // string[] | true` per flag, exactly as `parseFlags`/`buildInput` produced
  // them — reaches the handler completely unvalidated.
  const { input: rawInput, stores } = buildInput(flags, target.slugs, target.sourceMap);
  const input: Record<string, unknown> = rawInput;

  // Call handler — wrapped (innermost-first) by ALS (see CliOpts.als), then
  // by any configured middleware (outermost-first; see CliOpts.middleware).
  // With neither configured, `callHandler` is just `target.handler` itself
  // (zero overhead).
  const alsContext: CliAlsContext = {
    meta: target.leafMeta,
    io: ioResolved,
    slugs: target.slugs,
    leafName: target.leafName,
  };
  const alsHandler =
    opts.als !== undefined
      ? (input: Record<string, unknown>) => {
          const store = opts.als!.init(alsContext);
          return store instanceof Promise
            ? store.then((resolved) => opts.als!.storage.run(resolved, () => target.handler(input)))
            : opts.als!.storage.run(store, () => target.handler(input));
        }
      : target.handler;
  // Bridge the plain handler `(input) => result` into `F => F`'s base case
  // `(input, stores) => handler(input)` — the handler never sees `stores`,
  // structurally (see CliMiddleware's module doc above).
  const base = (input: Record<string, unknown>, _stores: CliStoreBag) => alsHandler(input);
  const middleware = opts.middleware ?? [];
  const callHandler = middleware.length === 0 ? base : composeMiddleware(middleware, base);

  let result: unknown;
  try {
    result = await Promise.resolve(callHandler(input, stores));
  } catch {
    // Thrown errors are never surfaced verbatim to the end user — matching
    // HTTP's `runRoute` (route.ts), which already collapses a thrown error
    // to a generic "internal server error" 500 rather than leaking
    // `err.message`. A handler's thrown message can carry internals (stack
    // frames, file paths, driver-specific SQL text, ...) that weren't meant
    // for a CLI consumer; a handler that WANTS to communicate a specific,
    // user-facing failure should return an `err(...)` Result instead (see
    // the Result-unwrapping check below), which IS surfaced verbatim — that
    // is the intentional, opt-in error-reporting channel.
    ioResolved.stderr.write("Error: internal error\n");
    throw new CliError("internal error", 1);
  }

  // Opt-in return-value detection — see CliOpts.detection. Both default to
  // `true`, matching every prior release's unconditional behavior.
  const detectStreaming = opts.detection?.streaming ?? true;
  const detectResult = opts.detection?.result ?? true;

  // Streaming: an async-iterable result (e.g. an async generator handler) is
  // streamed incrementally — one JSONL line written to stdout per yield, as
  // it's yielded, not buffered — instead of going through Result-unwrapping
  // and the buffer-then-emit output paths below. Checked before
  // Result-unwrapping, matching HTTP's `runRoute` (route.ts): neither a
  // Result nor a plain value is an async iterable, so there's no ambiguity.
  // Not gated by `tags.streaming`/`--jsonl` — mirroring HTTP's
  // `isAsyncIterable(output)` check, which also isn't gated by a per-route
  // flag: a handler that returns an async iterable IS the signal to stream,
  // on every projector. IS gated by `detectStreaming` (`CliOpts.detection`)
  // — with detection disabled, an async-iterable result falls through to
  // the plain-value output path below instead.
  if (detectStreaming && isAsyncIterable(result)) {
    await streamAsyncIterable(result, ioResolved);
    return;
  }

  // Result unwrapping: applied whenever `detectResult` is on (matching
  // HTTP's `runRoute`, route.ts) — any handler returning
  // `{kind:"err", error}` gets proper CLI error handling, including a
  // generated validator's own rejection (wrapHandler, api-tree's
  // apply-validation.ts, returns `err(errors)` on a failed `parse()`,
  // exactly this shape). A `kind:"ok"` Result is unwrapped to its `.value`
  // before being printed, so an ordinary handler that happens to return this
  // package's own `Result<T,E>` shape (see @rhi-zone/fractal-api-tree's
  // `ok`/`err`) is treated the same way regardless of validator wiring.
  if (detectResult && isResultShape(result)) {
    if (result.kind === "err") {
      const encoded = opts.errorEncoder?.(result.error);
      const msg = encoded?.message ?? `Error: ${JSON.stringify(result.error)}`;
      const exitCode = encoded?.exitCode ?? 1;
      ioResolved.stderr.write(`${msg}\n`);
      throw new CliError(msg, exitCode);
    }
    result = result.value;
  }

  // Pagination: a page-shaped result (`CursorPage<T>`/`OffsetPage<T>`, see
  // `@rhi-zone/fractal-api-tree/page`) — runtime shape check on the actual
  // result, same "conventions over contracts" split `isAsyncIterable`/
  // streaming uses above. `--all-pages` walks every following page by
  // re-invoking the handler in-process with the next cursor/offset merged
  // into `input` (CLI's own counterpart to HTTP's client-side `pagination()`
  // extension, which does the same walk over `fetch` instead of a direct
  // call), streaming every item as a JSONL line as it's fetched. Without
  // `--all-pages`, the current page still prints through the normal Output
  // path below unchanged; a `# more results available` hint goes to stderr
  // when there IS a next page, so a human knows how to continue (a machine
  // consumer already has `cursor`/`offset`+`hasMore` in the JSON body).
  if (isPageShape(result)) {
    const paginatedMeta = getCliMeta(target.leafMeta as CliLeafMeta).paginated;
    if (allPages) {
      await streamAllPages(
        result,
        input,
        callHandler,
        stores,
        detectResult,
        opts.errorEncoder,
        paginatedMeta,
        ioResolved,
      );
      return;
    }
    writePaginationHint(result, paginatedMeta, ioResolved);
  }

  // Output
  if (tags.streaming === true || jsonl) {
    // Streaming: one JSON line per item. `result` is never an async iterable
    // here (handled above); a page-shaped result streams its `items`, same
    // as an ordinary array — the pagination metadata (`cursor`/`hasMore`)
    // isn't itself a "result item" and is dropped from this output mode
    // (the hint above already surfaced it to stderr).
    if (isPageShape(result)) {
      for (const item of result.items) {
        ioResolved.stdout.write(jsonLine(item));
      }
    } else if (Array.isArray(result)) {
      for (const item of result) {
        ioResolved.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      ioResolved.stdout.write(JSON.stringify(result) + "\n");
    }
  } else {
    // Default: pretty JSON
    if (result === undefined || result === null) {
      ioResolved.stdout.write("null\n");
    } else {
      ioResolved.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === "object" && v !== null && Symbol.asyncIterator in v;
}

/** A JSONL line for one value — `null` for `undefined`/`null` (matching the
 *  non-streaming default output's convention), `JSON.stringify` otherwise. */
function jsonLine(v: unknown): string {
  return (v === undefined || v === null ? "null" : JSON.stringify(v)) + "\n";
}

/**
 * Stream an async-iterable handler result incrementally to `io`, per the
 * async-generator streaming protocol (docs/design/middleware-and-caller-context.md
 * — "Streaming and Progress"): each yielded value is inspected — a
 * `StreamProgress` effect is written to stderr as a human-readable line
 * (`[progress] 25% message`), a `StreamChunk` effect is unwrapped to its
 * `.data` and written as a JSONL line to stdout, and any other yielded value
 * (the untagged-yield fallback — see `isStreamEffect`'s doc) is written to
 * stdout as-is. Uses a manual `.next()` loop (not `for await`), which
 * discards a generator's return value; the return value is written as the
 * final JSONL line to stdout, matching HTTP's `streamAsSse`'s `done` frame.
 * Each line is written as it's produced — true push streaming, not
 * buffer-then-emit.
 */
async function streamAsyncIterable(iterable: AsyncIterable<unknown>, io: CliIO): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      io.stdout.write(jsonLine(step.value));
      return;
    }
    const value: unknown = step.value;
    if (isStreamProgress(value)) {
      const pct =
        value.total !== undefined
          ? `${Math.round((value.progress / value.total) * 100)}%`
          : `${value.progress}%`;
      const message = value.message !== undefined ? ` ${value.message}` : "";
      io.stderr.write(`[progress] ${pct}${message}\n`);
    } else if (isStreamChunk(value)) {
      io.stdout.write(jsonLine(value.data));
    } else {
      io.stdout.write(jsonLine(value));
    }
  }
}

// ============================================================================
// Pagination — `--all-pages` auto-walk + the stderr continuation hint
//
// A page-shaped result (`CursorPage<T>`/`OffsetPage<T>`, api-tree/src/page.ts)
// is detected the same way streaming is: a runtime shape check on the
// handler's actual return value (`isPageShape`), not a static declaration.
// Mirrors `http-api-projector/src/extensions/pagination.ts`'s client-side
// auto-pagination — same cursor/offset advancement algebra, applied to a
// direct in-process handler call instead of a re-issued `fetch`.
// ============================================================================

/** Resolved `{ inputCursorParam, inputOffsetParam }`, defaults matching HTTP's `pagination()` extension. */
function resolvedPaginationParams(meta: CliLeafMetaProperties["paginated"]): {
  cursorParam: string;
  offsetParam: string;
} {
  return {
    cursorParam: meta?.inputCursorParam ?? "cursor",
    offsetParam: meta?.inputOffsetParam ?? "offset",
  };
}

/** The next call's input: `page`'s cursor/offset merged onto `input` under the resolved param names. `undefined` (no next page) returns `input` unchanged — caller only calls this when `page.hasMore` is already known true. */
function nextPageInput(
  input: Record<string, unknown>,
  page: Page<unknown>,
  cursorParam: string,
  offsetParam: string,
): Record<string, unknown> {
  if (isOffsetPage(page)) {
    return { ...input, [offsetParam]: page.offset + page.items.length };
  }
  if (isCursorPage(page) && page.cursor !== undefined) {
    return { ...input, [cursorParam]: page.cursor };
  }
  return input;
}

/**
 * Write a `# more results available ...` hint to stderr when `page.hasMore`
 * — the non-`--all-pages` path's discoverability nudge (the JSON body itself
 * already carries `cursor`/`offset`+`hasMore`, this is purely for a human at
 * a terminal who might not think to look).
 */
function writePaginationHint(
  page: Page<unknown>,
  meta: CliLeafMetaProperties["paginated"],
  io: CliIO,
): void {
  if (!page.hasMore) return;
  const { cursorParam, offsetParam } = resolvedPaginationParams(meta);
  if (isOffsetPage(page)) {
    io.stderr.write(
      `# more results available — pass --${offsetParam} ${page.offset + page.items.length} (or --all-pages) to continue\n`,
    );
  } else if (isCursorPage(page) && page.cursor !== undefined) {
    io.stderr.write(
      `# more results available — pass --${cursorParam} ${page.cursor} (or --all-pages) to continue\n`,
    );
  }
}

/** One page fetch + the same Result-unwrapping `runCli`'s first call already applies — a subsequent page can be an `err` Result exactly like the first. */
async function fetchNextPage(
  callHandler: (input: Record<string, unknown>, stores: CliStoreBag) => unknown | Promise<unknown>,
  input: Record<string, unknown>,
  stores: CliStoreBag,
  detectResult: boolean,
  errorEncoder: CliErrorEncoder | undefined,
  io: CliIO,
): Promise<Page<unknown>> {
  let out: unknown = await Promise.resolve(callHandler(input, stores));
  if (detectResult && isResultShape(out)) {
    if (out.kind === "err") {
      const encoded = errorEncoder?.(out.error);
      const msg = encoded?.message ?? `Error: ${JSON.stringify(out.error)}`;
      const exitCode = encoded?.exitCode ?? 1;
      io.stderr.write(`${msg}\n`);
      throw new CliError(msg, exitCode);
    }
    out = out.value;
  }
  if (!isPageShape(out)) {
    throw new CliError(
      "--all-pages: a subsequent page fetch did not return a page-shaped result",
      1,
    );
  }
  return out;
}

/**
 * `--all-pages`: walk every page from `first` onward, writing each item as a
 * JSONL line to stdout as soon as its page is fetched (push-as-you-go, same
 * convention `streamAsyncIterable` uses for a genuine `AsyncIterable`) —
 * distinct from that function's async-generator draining since this walks a
 * REQUEST/RESPONSE sequence (one handler call per page), not a single
 * already-open stream.
 */
async function streamAllPages(
  first: Page<unknown>,
  input: Record<string, unknown>,
  callHandler: (input: Record<string, unknown>, stores: CliStoreBag) => unknown | Promise<unknown>,
  stores: CliStoreBag,
  detectResult: boolean,
  errorEncoder: CliErrorEncoder | undefined,
  paginatedMeta: CliLeafMetaProperties["paginated"],
  io: CliIO,
): Promise<void> {
  const { cursorParam, offsetParam } = resolvedPaginationParams(paginatedMeta);
  let page = first;
  let currentInput = input;
  for (;;) {
    for (const item of page.items) io.stdout.write(jsonLine(item));
    if (!page.hasMore) return;
    currentInput = nextPageInput(currentInput, page, cursorParam, offsetParam);
    page = await fetchNextPage(callHandler, currentInput, stores, detectResult, errorEncoder, io);
  }
}

// ============================================================================
// Tree walk for listing all leaf nodes (for help / introspection)
// ============================================================================

export type CliCommandEntry = {
  readonly path: string[];
  readonly leafName: string;
  readonly handler: Handler;
  readonly slugs: string[];
};

/**
 * Walk the Node tree and enumerate all reachable leaf nodes with their CLI paths.
 * Useful for generating full help text or testing coverage.
 */
export function walkCliCommands(
  n: Node,
  prefix: string[] = [],
  slugAcc: string[] = [],
): CliCommandEntry[] {
  const out: CliCommandEntry[] = [];

  for (const [key, child] of Object.entries(n.children ?? {})) {
    if (isLeaf(child)) {
      out.push({
        path: prefix,
        leafName: key,
        handler: child.handler!,
        slugs: slugAcc,
      });
    } else {
      out.push(...walkCliCommands(child, [...prefix, key], slugAcc));
    }
  }

  if (n.fallback !== undefined) {
    // The Node model allows `fallback.subtree` to be a bare leaf (`op()`),
    // not just a branch (`api({...})`) — recursing into it unconditionally
    // (`Object.entries(subtree.children ?? {})`) would silently see no
    // children and drop it from the listing entirely. Mirror the
    // ordinary-leaf push above: when the subtree itself is a leaf, push it
    // directly at the CURRENT `prefix` with `leafName = fallback.name` — no
    // extra path segment beyond the fallback's own name (same convention
    // api-tree/tree.ts's `walkNodeType` fix, aa28952, and the other
    // projectors' identical fix use).
    if (isLeaf(n.fallback.subtree)) {
      out.push({
        path: prefix,
        leafName: n.fallback.name,
        handler: n.fallback.subtree.handler!,
        slugs: [...slugAcc, n.fallback.name],
      });
    } else {
      out.push(...walkCliCommands(n.fallback.subtree, prefix, [...slugAcc, n.fallback.name]));
    }
  }

  return out;
}

/**
 * Suggest the closest reachable full command path to what the user typed,
 * by edit distance over the space-joined path strings — same
 * `levenshteinDistance` used for enum near-misses (coerceScalar). Returns
 * undefined when the tree has no leaf commands at all.
 */
function suggestCommand(root: Node, pathSegments: string[]): string | undefined {
  const typed = pathSegments.join(" ");
  const candidates = walkCliCommands(root).map((c) => [...c.path, c.leafName].join(" "));
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const d = levenshteinDistance(typed, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best;
}

// Re-export types for consumers
export type { SchemaMap };
export type { Node, Handler, LeafMeta };
