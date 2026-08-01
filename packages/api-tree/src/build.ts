// packages/api-tree/src/build.ts — @rhi-zone/fractal-api-tree
//
// BUILD ORCHESTRATOR: wires the extractor (extract.ts/tree.ts) to the AOT
// validator compiler (@rhi-zone/fractal-type-ir's compile.ts), producing the
// standalone, zero-runtime-dependency validator MODULE SOURCE that
// `wrapValidators` (below) consumes.
//
//   entryFile --extractRouteTypeRefs--> path -> TypeRef
//            --compileValidatorModule--> module source (exports `validators`,
//              `Record<path, { check, errors, parse }>` — see compile.ts)
//
// `buildValidatorModuleSource` is the one-shot "codegen has run" path. Before
// codegen has run at all — first checkout, a freshly scaffolded package — a
// consumer should simply OMIT the `validators` option on `createFetch`/
// `createMcpServer`/`runCli` entirely (all three already treat it as fully
// optional — see each preset's own `opts.validators !== undefined` guard)
// rather than wire an empty placeholder map. `wrapValidators` is LOUD: every
// leaf reachable from the tree it's given must be covered by a generated
// validator entry, or explicitly tagged `meta.tags.unvalidated`, or it throws
// `UnvalidatedLeafError` — see that function's own doc comment below for why.

import * as path from "node:path"
import type ts from "typescript"
import {
  assembleValidatorModule,
  compileDefsBlock,
  compileEntryFragment,
  compileValidatorModule,
  type CompiledEntryFragment,
} from "@rhi-zone/fractal-type-ir"
import { extractRouteTypeRefs } from "./tree.ts"
import { createExtractorProgram, type ShouldShare } from "./extract.ts"
import {
  checkCache,
  computeDefNamesFingerprint,
  computeLeafFingerprint,
  readCarryForwardState,
  writeCacheMetadata,
  type CacheLocationOptions,
  type CachedBuildOutcome,
} from "./cache.ts"
import type { Handler, Node } from "./node.ts"
import { err } from "./index.ts"
import { TAG_UNVALIDATED } from "./tags.ts"

/** One generated entry's public shape — see compile.ts's `compileValidatorModule`. */
export type GeneratedEntry = {
  parse: (value: unknown) => { kind: "ok"; value: unknown } | { kind: "err"; errors: unknown[] }
}

// ============================================================================
// wrapValidators — wires generated validators directly onto a `Node` tree's
// leaf handlers. The single mechanism shared by HTTP (createFetch's
// `validators` option), MCP (`createMcpServer`'s `validators` option), and
// CLI (`runCli`'s `validators` option) — each dispatches off (or, for HTTP,
// projects from) the `Node` tree, so wiring validation onto the `handler`
// itself, before any protocol-specific projection runs, covers all three
// with one generated module. Wraps each leaf's handler so it calls the
// generated `parse()` first (coercion + validation + narrowing in one pass)
// and only invokes the original handler on success.
// ============================================================================

/**
 * Runtime brand for a handler produced by `wrapValidators`'s wrapping — lets
 * a projector (CLI, MCP) tell whether a resolved leaf's validation is
 * already handled by a generated validator, so its own fallback
 * coercion/validation step (`coerceInput`/`validateRequired` in CLI,
 * `validateAgainstSchema` in MCP) can be skipped for that leaf specifically,
 * while still running for leaves `wrapValidators` didn't touch — no matching
 * validator at that path, or `validators` not supplied at all. Same pattern
 * as `route.ts`'s `routeBrand`/`isHttpRoute`.
 */
const wrappedHandlerBrand = new WeakSet<Handler>()

/** True when `handler` was produced by `wrapValidators`'s wrapping — see the brand doc above. */
export function isValidatorWrapped(handler: Handler): boolean {
  return wrappedHandlerBrand.has(handler)
}

/**
 * Wrap one leaf handler: `entry.parse(input)` first — `ok` calls `handler`
 * with the parsed (coerced, validated, narrowed) value; `err` returns a
 * `Result` `{kind:"err", error: ValidationError[]}` (this package's own
 * `Result<T,E>` — see index.ts's `ok`/`err`/`isResultShape`) instead of ever
 * reaching `handler`.
 *
 * Deliberately a returned Result, not a thrown error class: an error class
 * can't be exhaustively matched (no discriminated union over `instanceof`)
 * and `instanceof` itself breaks across realms/bundles — a dispatcher
 * (`runRoute` for HTTP, `runCli` for CLI, the MCP tool-call handler) checks
 * the return value's `kind` instead of wrapping the call in a catch block.
 * The wrapped handler's static return type stays the erased `Handler`
 * (default `any`/`any`), so returning a `Result` here doesn't require
 * threading a new generic through `Node`/`op`/`api`.
 */
function wrapHandler(handler: Handler, entry: GeneratedEntry): Handler {
  const wrapped: Handler = async (input: unknown) => {
    const result = entry.parse(input)
    if (result.kind === "err") return err(result.errors)
    return handler(result.value)
  }
  wrappedHandlerBrand.add(wrapped)
  return wrapped
}

/**
 * True when `node` is a leaf (`node.handler !== undefined`) explicitly
 * tagged `meta.tags.unvalidated === true` — see `TAG_UNVALIDATED`'s own doc
 * comment (tags.ts) for what this opts a leaf out of.
 */
function isTaggedUnvalidated(node: Node): boolean {
  const tags = (node.meta as { tags?: Record<string, boolean | undefined> }).tags
  return tags?.[TAG_UNVALIDATED] === true
}

/**
 * Walk `node`, collecting the `"/"`-joined path of every leaf that has
 * neither a matching entry in `validators` nor `meta.tags.unvalidated` —
 * mirrors `wrapValidators`'s own walk/path-joining convention exactly (same
 * `path` accumulation, same `:name` rendering for a fallback segment) so the
 * paths it reports are exactly the keys a generated validator module (or an
 * `unvalidated` tag) would need to cover.
 */
function collectUnvalidatedLeaves(
  node: Node,
  validators: Readonly<Record<string, GeneratedEntry>>,
  path: readonly string[],
  out: string[],
): void {
  if (node.handler !== undefined) {
    const key = path.join("/")
    if (validators[key] === undefined && !isTaggedUnvalidated(node)) out.push(key)
  }
  if (node.children !== undefined) {
    for (const [key, child] of Object.entries(node.children)) {
      collectUnvalidatedLeaves(child, validators, [...path, key], out)
    }
  }
  if (node.fallback !== undefined) {
    collectUnvalidatedLeaves(
      node.fallback.subtree,
      validators,
      [...path, `:${node.fallback.name}`],
      out,
    )
  }
}

/**
 * Thrown by `wrapValidators` when one or more leaves in the tree it was
 * given have neither a matching `validators` entry nor a
 * `meta.tags.unvalidated` opt-out — see `wrapValidators`'s own doc comment.
 * `paths` carries every offending leaf's `"/"`-joined route path (not just
 * the first one found), matching `message`'s one-per-line listing.
 */
export class UnvalidatedLeafError extends Error {
  readonly paths: readonly string[]
  constructor(paths: readonly string[]) {
    super(
      `wrapValidators: the following leaves have no matching generated validator ` +
        `entry and aren't tagged unvalidated:\n${paths.join("\n")}\n\n` +
        `Fix by either adding a validator entry for each path (re-run codegen — ` +
        `see @rhi-zone/fractal-api-tree's build/watch/check CLI), or tagging the ` +
        `leaf to opt it out explicitly: op(fn, { tags: { unvalidated: true } }).`,
    )
    this.name = "UnvalidatedLeafError"
    this.paths = paths
  }
}

/**
 * Walk `node`, wiring each leaf's handler through its generated validator's
 * `parse()` before the original handler runs — see the module doc above for
 * why this lives at the `Node` level rather than on any one protocol's own
 * route/dispatch tree.
 *
 * Keyed the same way `extractRouteTypeRefs` (tree.ts) keys its map: `"/"`-
 * joined path segments, with a `fallback` segment rendered as `:name` (e.g.
 * `"books/:bookId"`) — so a validator module built by
 * `buildValidatorModuleSource` plugs into `wrapValidators` with no re-keying.
 *
 * LOUD by design: before wrapping anything, `wrapValidators` walks the WHOLE
 * tree and collects every leaf whose path has no matching entry in
 * `validators` AND isn't tagged `meta.tags.unvalidated === true` (see
 * `TAG_UNVALIDATED`, tags.ts). If that list is non-empty, it throws
 * `UnvalidatedLeafError` (all offending paths at once, not just the first) —
 * a silently-unvalidated leaf is exactly the failure class this check exists
 * to kill; a caller who genuinely wants a leaf to go unvalidated says so
 * explicitly via the tag. Only once every leaf is accounted for does
 * `wrapValidators` proceed: a leaf with a matching entry gets its handler
 * wrapped via `wrapHandler`; a leaf tagged `unvalidated` keeps its original
 * handler, untouched.
 *
 * Never mutates `node`; always returns a fresh tree (on success — a thrown
 * `UnvalidatedLeafError` returns nothing, the input is left untouched either
 * way).
 */
export function wrapValidators(
  node: Node,
  validators: Readonly<Record<string, GeneratedEntry>>,
  path: readonly string[] = [],
): Node {
  const offending: string[] = []
  collectUnvalidatedLeaves(node, validators, path, offending)
  if (offending.length > 0) throw new UnvalidatedLeafError(offending)
  return wrapValidatorsUnchecked(node, validators, path)
}

/** The actual wrap-and-rebuild walk, run only once `wrapValidators`'s loud
 * coverage check has passed — split out so the check runs exactly once, at
 * the root call, rather than re-walking (and re-throwing on) every
 * recursive descent. */
function wrapValidatorsUnchecked(
  node: Node,
  validators: Readonly<Record<string, GeneratedEntry>>,
  path: readonly string[],
): Node {
  const entry = validators[path.join("/")]
  const handler = node.handler !== undefined
    ? (entry !== undefined ? wrapHandler(node.handler, entry) : node.handler)
    : undefined
  const children = node.children !== undefined
    ? Object.fromEntries(
        Object.entries(node.children).map(([key, child]) => [
          key,
          wrapValidatorsUnchecked(child, validators, [...path, key]),
        ]),
      )
    : undefined
  const fallback = node.fallback !== undefined
    ? {
        name: node.fallback.name,
        subtree: wrapValidatorsUnchecked(
          node.fallback.subtree,
          validators,
          [...path, `:${node.fallback.name}`],
        ),
      }
    : undefined
  return {
    ...(handler !== undefined ? { handler } : {}),
    ...(children !== undefined ? { children } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    meta: node.meta,
  }
}

/**
 * Turn an extracted type's absolute `declarationFile` into the `import type`
 * module specifier the generated module at `outFile` should use to reach it
 * — a relative path from `outFile`'s directory, POSIX-separated (module
 * specifiers use `/` regardless of host OS), keeping the `.ts` extension
 * (the project's own convention — see this repo's `tsconfig.json`
 * `allowImportingTsExtensions`, and e.g. `tree.ts`'s own `from
 * "./generated/validators.ts"` import).
 */
function relativeImportSpecifier(outFile: string, declarationFile: string): string {
  const rel = path.relative(path.dirname(outFile), declarationFile).split(path.sep).join("/")
  return rel.startsWith(".") ? rel : `./${rel}`
}

/**
 * Extract every leaf op's input type from `entryFile` and compile it into a
 * standalone validator module source string — `export const validators:
 * Record<routePath, { check, errors, parse }>`. Pass the imported
 * `validators` map straight to `wrapValidators` (this file) — no adaptation
 * needed, the generated `{ check, errors, parse }` shape already matches
 * `GeneratedEntry`.
 *
 * `outFile`, when given, anchors `import type` specifiers for handler
 * parameter types that are NAMED (alias/interface) rather than inline —
 * see `compileValidatorModule`'s `resolveImport` option and
 * `extract.ts`'s `typeRefFromFunctionNode` (the source of
 * `meta.typeName`/`meta.declarationFile`). Without it, every parameter type
 * inlines its structural TypeScript rendering instead — still typed, just
 * without an import.
 *
 * `shouldShare`, when given, opts into structural sharing across every
 * route's input type (see `extractRouteTypeRefs`'s `options.shouldShare` and
 * type-ir's `SharingRegistry`/`ShouldShare`) — a type reused across routes
 * (or self-recursive) compiles to ONE generated validator function, called
 * from every `ref` site, instead of being re-inlined (and, for a truly
 * recursive type, infinitely re-descended) at each one. Omitted, this is
 * exactly the prior behavior: every route's input inlines its full structure
 * independently, no `defs`.
 *
 * `program`, when given, reuses a pre-built `ts.Program` instead of building
 * a fresh single-root one over `entryFile` — pass a Program built via
 * `createExtractorProgram`'s multi-root form (`@rhi-zone/fractal-type-ir`)
 * over ALL the entry files a batch caller is about to build, so the
 * transitive-import parse+bind cost (a `ts.Program`'s dominant memory cost,
 * often multiple GB for a real app's dependency closure) is paid ONCE for
 * the whole batch instead of once per entry file. A sequential loop that
 * calls this function once per file WITHOUT passing a shared `program`
 * builds a fresh multi-GB `ts.Program` on every call in the same process —
 * `the sibling codebase`'s 16-slice validator codegen script did exactly this and
 * accumulated to 20+GB RSS before the caller was fixed to build and pass one
 * shared Program across the batch (see `createExtractorProgram`'s doc
 * comment in type-ir for the measured before/after).
 */
export function buildValidatorModuleSource(
  entryFile: string,
  outFile?: string,
  shouldShare?: ShouldShare,
  program?: ts.Program,
): string {
  const resolveImportOpt =
    outFile === undefined
      ? {}
      : { resolveImport: (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile) }
  const programOpt = program === undefined ? {} : { program }
  if (shouldShare === undefined) {
    const typeRefs = extractRouteTypeRefs(entryFile, programOpt)
    const entries = Object.entries(typeRefs).map(([name, info]) => ({ name, ref: info.input }))
    return compileValidatorModule(entries, resolveImportOpt)
  }
  const { types, defs } = extractRouteTypeRefs(entryFile, { shouldShare, ...programOpt })
  const entries = Object.entries(types).map(([name, info]) => ({ name, ref: info.input }))
  return compileValidatorModule(entries, { ...resolveImportOpt, defs })
}

/**
 * Build the validator module for `entryFile` and write it to `outFile`.
 */
export async function writeValidatorModule(entryFile: string, outFile: string): Promise<void> {
  await Bun.write(outFile, buildValidatorModuleSource(entryFile, outFile))
}

// ============================================================================
// Tier 2 — leaf-level incremental build. See
// docs/design/ir-keyed-cache-spec.md and cache.ts's IR-keyed-cache module
// doc. Runs only after a Tier-1 miss (cache.ts's `checkCache`): re-extracts
// every leaf (extraction is always precise — there's no cheaper way to know
// a leaf's fingerprint than deriving it, spec §3) but recompiles ONLY the
// leaves whose fingerprint actually changed, carrying forward every other
// leaf's previously-compiled fragment verbatim.
// ============================================================================

/** One leaf's carried-forward Tier-2 state — a `CompiledEntryFragment`
 * (type-ir/compile.ts) stored opaquely in cache.ts's `leafArtifacts`. Narrowed
 * from `unknown` by `isCompiledFragment` before reuse — a cache file is
 * untrusted input (hand-edited, or written by a different `fractal-type-ir`
 * version whose fragment shape moved, though `toolchainMatches`,cache.ts,
 * already guards the latter case at the whole-entry level). */
function isCompiledFragment(v: unknown): v is CompiledEntryFragment {
  return typeof v === "object" && v !== null && typeof (v as { code?: unknown }).code === "string"
}

export type ValidatorIncrementalResult = {
  /** The complete, freshly-assembled module source (no header — same
   * convention as `buildValidatorModuleSource`; a caller that prepends a
   * generated-file header does so on this string, same as today). */
  readonly source: string
  /** Every leaf's CURRENT fingerprint — write this to Tier 2's cache record
   * (`writeCacheMetadata`'s `leafData.leafFingerprints`) regardless of
   * whether that leaf's code actually changed (§2 step 4: Tier 1's/Tier 2's
   * records are rewritten to the new state on every Tier-2 run). */
  readonly leafFingerprints: Record<string, string>
  /** Every leaf's compiled fragment — carried-forward ones included verbatim,
   * changed ones freshly compiled — ready to write back as the next run's
   * carry-forward source. */
  readonly leafArtifacts: Record<string, CompiledEntryFragment>
  /** Fingerprint of the def-NAME set in scope for this compile (see cache.ts's
   * `defNamesFingerprint` doc comment) — write this alongside
   * `leafFingerprints`. */
  readonly defNamesFingerprint: string
  /** Leaf keys (route paths) whose fragment was actually RECOMPILED this run
   * — everything else in `leafArtifacts` was carried forward unchanged. For
   * tests/observability; not needed for correctness. */
  readonly changedLeaves: readonly string[]
}

/** Prior Tier-2 state for one entry — exactly `readCarryForwardState`'s
 * return shape (cache.ts), re-declared here as a named type so this file
 * doesn't need to import it just to name a parameter. */
export type ValidatorCarryForwardState = {
  readonly leafFingerprints: Readonly<Record<string, string>>
  readonly leafArtifacts: Readonly<Record<string, unknown>>
  readonly defNamesFingerprint: string
}

/**
 * `buildValidatorModuleSource`'s Tier-2 sibling: same extraction
 * (`extractRouteTypeRefs`), same `compileEntryFragment`/`compileDefsBlock`/
 * `assembleValidatorModule` codegen `compileValidatorModule` itself uses
 * internally (type-ir/compile.ts) — the ONLY difference is that a leaf whose
 * fingerprint matches `prior.leafFingerprints` (AND whose current def-name
 * set fingerprint matches `prior.defNamesFingerprint` — see
 * `compileEntryFragment`'s doc comment, type-ir/compile.ts, for why both are
 * needed) reuses `prior.leafArtifacts`'s fragment VERBATIM instead of
 * recompiling — see this file's Tier-2 module doc above.
 *
 * `prior` is `undefined` for a first build (nothing to carry forward — every
 * leaf compiles fresh, identical to a full `buildValidatorModuleSource` call
 * modulo cosmetic formatting; see `assembleValidatorModule`'s doc comment).
 */
export function buildValidatorModuleSourceIncremental(
  entryFile: string,
  outFile: string | undefined,
  shouldShare: ShouldShare | undefined,
  program: ts.Program | undefined,
  prior: ValidatorCarryForwardState | undefined,
): ValidatorIncrementalResult {
  const resolveImport =
    outFile === undefined ? undefined : (declarationFile: string) => relativeImportSpecifier(outFile, declarationFile)
  const programOpt = program === undefined ? {} : { program }

  const { types, defs } =
    shouldShare === undefined
      ? { types: extractRouteTypeRefs(entryFile, programOpt), defs: {} }
      : extractRouteTypeRefs(entryFile, { shouldShare, ...programOpt })

  const defsBlock = compileDefsBlock(defs)
  const defNamesFingerprint = computeDefNamesFingerprint(defsBlock.defNames)
  const defNamesUnchanged = prior !== undefined && prior.defNamesFingerprint === defNamesFingerprint

  const leafFingerprints: Record<string, string> = {}
  const leafArtifacts: Record<string, CompiledEntryFragment> = {}
  const changedLeaves: string[] = []
  const entries = Object.entries(types).map(([name, info]) => ({ name, ref: info.input }))

  for (const { name, ref } of entries) {
    const fingerprint = computeLeafFingerprint(entryFile, { input: ref })
    leafFingerprints[name] = fingerprint

    const priorArtifact = prior?.leafArtifacts[name]
    const reusable =
      defNamesUnchanged && prior !== undefined && prior.leafFingerprints[name] === fingerprint && isCompiledFragment(priorArtifact)

    if (reusable && priorArtifact !== undefined && isCompiledFragment(priorArtifact)) {
      leafArtifacts[name] = priorArtifact
    } else {
      leafArtifacts[name] = compileEntryFragment(ref, resolveImport, defsBlock.defNames)
      changedLeaves.push(name)
    }
  }

  const source = assembleValidatorModule(entries, leafArtifacts, defsBlock.lines)
  return { source, leafFingerprints, leafArtifacts, defNamesFingerprint, changedLeaves }
}

// ============================================================================
// Cached variants — see cache.ts's module doc for the content-addressed
// caching design (key granularity, toolchain-version signal, cache-file
// location) this wraps `buildValidatorModuleSourceIncremental`/
// `writeValidatorModule` with. A Tier-1 HIT skips the `ts.Program`
// construction AND the extraction/compile walk entirely; a Tier-1 MISS falls
// through to Tier 2 (above), which still skips recompiling any leaf whose
// fingerprint didn't move.
// ============================================================================

/**
 * `buildValidatorModuleSource`, cached: skips the build (and the `program`
 * construction it would otherwise need) when nothing the last successful
 * build for `outFile` depended on has changed (Tier 1) — and, on a Tier-1
 * miss, recompiles only the leaves whose IR fingerprint actually changed
 * (Tier 2) — see `buildValidatorModuleSourceIncremental` above.
 * `options.program`, when given, is used only on an actual build (a cache
 * hit never touches it) — same batch-sharing use as
 * `buildValidatorModuleSource`'s own `program` parameter. `options.force`
 * bypasses the cache unconditionally, same as the CLI's `--force`.
 */
export function buildValidatorModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly shouldShare?: ShouldShare
    readonly program?: ts.Program
    readonly force?: boolean
    readonly reachable?: ReadonlySet<string>
  } & CacheLocationOptions,
): CachedBuildOutcome<string> {
  if (!options?.force) {
    const check = checkCache(entryFile, outFile, options)
    if (check.hit) return { status: "hit" }
  }
  const program = options?.program ?? createExtractorProgram(entryFile)
  const prior = readCarryForwardState(entryFile, outFile, options)
  const built = buildValidatorModuleSourceIncremental(entryFile, outFile, options?.shouldShare, program, prior)
  writeCacheMetadata(entryFile, outFile, program, built.source, options, options?.reachable, {
    leafFingerprints: built.leafFingerprints,
    leafArtifacts: built.leafArtifacts,
    defNamesFingerprint: built.defNamesFingerprint,
  })
  return { status: "built", result: built.source, program }
}

/**
 * `writeValidatorModule`, cached: only writes `outFile` (and updates cache
 * metadata) when `buildValidatorModuleCached` actually built something. On a
 * cache hit, `outFile` is left untouched (it's already correct) and no write
 * happens at all.
 */
export async function writeValidatorModuleCached(
  entryFile: string,
  outFile: string,
  options?: {
    readonly shouldShare?: ShouldShare
    readonly program?: ts.Program
    readonly force?: boolean
    readonly reachable?: ReadonlySet<string>
  } & CacheLocationOptions,
): Promise<CachedBuildOutcome<string>> {
  const outcome = buildValidatorModuleCached(entryFile, outFile, options)
  if (outcome.status === "built") await Bun.write(outFile, outcome.result)
  return outcome
}
