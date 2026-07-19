// packages/api-tree/src/context.ts — @rhi-zone/fractal-api-tree/context
//
// createContext — one shared `AsyncLocalStorage<T>` plus per-projector
// `{ storage, init }` config objects that plug directly into each
// projector's `als` option (`PresetOptions.als` in http-api-projector,
// `CliOpts.als` in cli-api-projector, `CreateMcpServerOptions.als` in
// mcp-api-projector). Lets a consumer author ONE context type + one
// extractor per surface, instead of wiring three separate
// `AsyncLocalStorage` instances by hand and keeping them in sync.
//
// Lives here (the protocol-neutral base package) rather than in any single
// projector package: cli-api-projector and mcp-api-projector both already
// depend on api-tree (`@rhi-zone/fractal-api-tree`), so api-tree taking a
// REAL dependency on either of them the other way would be a package cycle.
// Instead of importing `CliAlsContext`/`McpAlsContext` (each projector's
// dispatch-context type for `opts.als` — see cli.ts/server.ts; distinct from
// middleware, which no longer receives a context bag, see
// docs/design/middleware-and-caller-context.md) from those packages, this
// module redeclares their shapes structurally (`CliContextShape`/
// `McpContextShape` below) — TypeScript's structural typing makes a value of
// the real `CliAlsContext` assignable wherever `CliContextShape` is expected
// (and vice versa) with no import needed, so there's nothing to keep in sync
// beyond the shape itself, and a consumer who imports the real types still
// gets full type-checking against them at the call site.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Meta } from "./node.ts";

// ============================================================================
// Structural mirrors of the per-projector middleware context shapes
// ============================================================================
//
// Deliberately NOT imported from cli-api-projector / mcp-api-projector (see
// module doc above — would create a package cycle). Kept intentionally
// narrow: only the fields `createContext`'s own extractors need to accept,
// which happen to be the full shape of `CliAlsContext` / `McpAlsContext`
// today. If either grows a field this module doesn't reference, no update is
// needed here — structural typing only checks the fields actually used.

/** Structural mirror of cli-api-projector's `CliAlsContext`. */
export type CliContextShape = {
  readonly meta: Meta;
  readonly io: {
    readonly stdout: { write(s: string): void };
    readonly stderr: { write(s: string): void };
    confirm(prompt: string): Promise<boolean>;
  };
  readonly slugs: Record<string, string>;
  readonly leafName: string;
};

/** Structural mirror of mcp-api-projector's `McpAlsContext`. */
export type McpContextShape = {
  readonly meta: Meta;
  readonly name: string;
  readonly requestType: "tool" | "resource" | "prompt";
};

// ============================================================================
// createContext
// ============================================================================

/** Per-projector `als` config — the exact shape `PresetOptions.als` / `CliOpts.als` / `CreateMcpServerOptions.als` accept. */
export type AlsConfig<Ctx, T> = {
  readonly storage: AsyncLocalStorage<T>;
  readonly init: (context: Ctx) => T;
};

export type ContextBuilder<T> = {
  /** The single `AsyncLocalStorage<T>` instance shared by every provided projector config. */
  readonly storage: AsyncLocalStorage<T>;
  /** `storage.getStore()` — read the current context value from anywhere downstream of an entered projector, or `undefined` outside any of them. */
  readonly getStore: () => T | undefined;
  /** Present iff an `http` extractor was provided — drop directly into `PresetOptions.als`. */
  readonly http?: AlsConfig<Request, T>;
  /** Present iff a `cli` extractor was provided — drop directly into `CliOpts.als`. */
  readonly cli?: AlsConfig<CliContextShape, T>;
  /** Present iff an `mcp` extractor was provided — drop directly into `CreateMcpServerOptions.als`. */
  readonly mcp?: AlsConfig<McpContextShape, T>;
};

/**
 * Build one shared context store plus per-projector `als` configs, from one
 * `T` and one extractor per surface. Only extractors actually supplied
 * produce a config on the result — `http`/`cli`/`mcp` are each present iff
 * their extractor was passed in.
 *
 * ```ts
 * type Ctx = { requestId: string }
 * const context = createContext<Ctx>({
 *   http: (req) => ({ requestId: req.headers.get("x-request-id") ?? crypto.randomUUID() }),
 *   cli: (ctx) => ({ requestId: `cli:${ctx.leafName}` }),
 *   mcp: (ctx) => ({ requestId: `mcp:${ctx.name}` }),
 * })
 *
 * createFetch(tree, { als: context.http })
 * runCli(tree, argv, io, { als: context.cli })
 * createMcpServer(tree, { name, version, als: context.mcp })
 *
 * // anywhere downstream of a dispatched request, from any of the three surfaces:
 * context.getStore()?.requestId
 * ```
 *
 * All three configs share the SAME `AsyncLocalStorage` instance (`.storage`)
 * — `getStore()` returns whichever surface's context is currently active,
 * regardless of which one entered it.
 */
export function createContext<T>(extractors: {
  readonly http?: (req: Request) => T;
  readonly cli?: (context: CliContextShape) => T;
  readonly mcp?: (context: McpContextShape) => T;
}): ContextBuilder<T> {
  const storage = new AsyncLocalStorage<T>();
  const getStore = (): T | undefined => storage.getStore();

  return {
    storage,
    getStore,
    ...(extractors.http !== undefined ? { http: { storage, init: extractors.http } } : {}),
    ...(extractors.cli !== undefined ? { cli: { storage, init: extractors.cli } } : {}),
    ...(extractors.mcp !== undefined ? { mcp: { storage, init: extractors.mcp } } : {}),
  };
}
