// Content-addressed incremental-build cache for the extract/codegen pipeline
// (apply-validation-build.ts's `buildWireApplyValidationModuleSource`,
// schema-build.ts's `buildSchemaModuleSource`, wired into cli.ts's
// build/watch/check commands).
// The cache key is content, not mtime: an entry is a hit only when the entry
// file's own content and the content of every transitive file the extractor
// reads are unchanged from the last successful build, and the output file's
// bytes still match what was last written. A `touch`-without-edit resolves
// to a hit; a revert to identical content resolves to a hit regardless of
// mtime.
//
// v3 (docs/design/ir-keyed-cache-spec.md): the cache unit is a LEAF's
// type-IR fingerprint, not a file. Everything below this point (file-closure
// hashing, mtime+size tiering, `reachability.ts`'s per-entry closures) is
// Tier 1 — a cheap "could anything have changed" file-content gate. Tier 2
// (the "Tier 2 primitives" section further down this file, plus
// apply-validation-build.ts's/schema-build.ts's incremental build
// orchestration) narrows a Tier-1 miss
// down to which leaves actually changed. Read that spec before changing
// either tier.
//
// ============================================================================
// Cache key granularity
// ============================================================================
//
// The precise cache key for one entry file is "this entry file's content +
// every source file its extraction actually reads, transitively". For a
// fresh single-root `ts.Program` built over just that entry,
// `program.getSourceFiles()` IS exactly that closure, with no extra
// tracking needed — this is the path the CLI's single-entry `build`/`check`/
// `watch` commands use, each with its own fresh Program.
//
// A batch caller (the sibling codebase's `codegen-fractal-validators.ts`) instead builds
// ONE shared multi-root Program across many entries, to avoid paying a
// fresh Program's multi-GB cost per entry (see
// `@rhi-zone/fractal-type-ir/from-typescript`'s doc comment for the measured
// numbers).
// `program.getSourceFiles()` on that shared Program is the whole batch's
// union closure, not any one entry's own closure — recording it unfiltered
// against every entry means touching one slice's source invalidates every
// tracked artifact in the batch, not just the entries that actually reach
// the touched file.
//
// `reachability.ts`'s `computeEntryClosures` computes each entry's own
// closure against a shared Program directly: a per-entry module-graph walk
// starting from `ts.SourceFile.imports` (already populated by TypeScript's
// own parser, so no hand-rolled import-statement AST walker is needed) and
// `ts.resolveModuleName` against a shared `ts.ModuleResolutionCache`,
// memoized once across the whole batch so computing every entry's closure
// costs O(files in the union), not O(entries × files). `writeCacheMetadata`
// below accepts an optional `reachable` file-path set; when given, only
// files in that set are hashed and recorded, giving a shared-Program batch
// caller the same per-entry precision a fresh single-root Program gets for
// free. Omitting `reachable` records the whole Program's file set — for a
// fresh single-root Program (the CLI's single-entry callers) that's already
// identical to the precise closure, so those callers have no need to pass it.
//
// One correctness note this key shape depends on: a file's identity is its
// resolved path. Adding a new file to an entry's closure (a fresh import)
// changes the file that added the import (its content changed), which is
// already tracked — so the new file's absence from the recorded file set
// before isn't a blind spot: the edit that introduced it always shows up as
// a changed-content hash on some file already in (or about to reenter) the
// closure. The only thing this key can't detect from the tracked file set
// alone is a change to something outside file content entirely (environment,
// toolchain) — `tsVersion`/`typeIrVersion` below cover the toolchain half of
// that. Compiler options resolved from tsconfig.json (`paths`, `strict`,
// `exactOptionalPropertyTypes`, …) are NOT file content in this sense — the
// entry file's own content is unchanged even when its resolved options move
// — so they're fingerprinted separately, as `compilerOptionsHash` below:
// sha256 of the exact `ts.CompilerOptions` object `createExtractorProgram`
// hands `ts.createProgram` (`loadCompilerOptionsForFile`,
// `@rhi-zone/fractal-type-ir/from-typescript`), tracked with the same
// conceptual treatment as a tracked source file's content hash
// (docs/current/repo-audit-2026-08-20.md §2.2).
//
// ============================================================================
// Warm-check cost — read this before changing how `checkCache` re-validates
// the recorded closure.
// ============================================================================
//
// `checkCache` never builds a `ts.Program` — it only ever re-reads the file
// list `writeCacheMetadata` recorded last time. For a caller that shares one
// Program across many entries (the sibling codebase's batch codegen script — see the
// cache-key-granularity section above), that recorded list is the whole
// shared closure, duplicated per entry: 17 slices × ~4,548 files each
// (measured against this monorepo's `apps/web` checkout, 2026-08-02) is
// 77,316 tracked-file entries for the validator artifacts alone, another
// 77,316 for the schema artifacts. Reading and sha256-hashing the full
// content of every one of those on every warm run measured at ~52ms per
// 4,548-file entry × 34 entries ≈ 1.5-1.8s wall time — most of that cost
// spent deciding that nothing changed.
//
// The check is tiered to avoid that cost. `writeCacheMetadata` records each
// file's `size` + `mtimeMs` alongside its content hash. `checkCache` first
// compares the current `fs.statSync` size/mtime against the recorded pair —
// a `stat`, no file content read at all — and only falls back to reading +
// hashing a file's content when that cheap pair doesn't match (a real edit,
// or an unrelated touch/checkout that changed mtime without changing
// content; the content-hash fallback tells the two apart so a
// `touch`-without-edit still resolves to a hit, matching this cache's
// touch-tolerance guarantee). Measured against the same fixture set:
// stat-only re-validation of one 4,548-file entry drops from ~52ms to
// ~5ms — roughly 10x — so a fully warm 34-entry run's file-re-validation
// cost drops from ~1.5-1.8s to well under 200ms. mtime+size (not mtime
// alone, not size alone) is the standard cheap-invalidation-signal pair
// (make/Bazel/Nix all use it): either one alone under-detects real edits
// that happen to preserve the other (a same-size edit; a rewrite that lands
// on the same mtime tick under coarse filesystem timestamp resolution) — a
// false stat-level miss just costs one content hash (still correct, just
// not free), so there's no correctness reason to trust either signal alone;
// querying both from the same single `fs.statSync` call costs nothing extra.
//
// ============================================================================

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import ts from "typescript";
import { loadCompilerOptionsForFile } from "@rhi-zone/fractal-type-ir/from-typescript";

/** sha256 of a string, hex-encoded — the one hash primitive this module uses
 * throughout (entry/dependency file content, output content). */
function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Hash a file's current on-disk content, or `undefined` if it can't be read
 * (removed, permissions, …) — treated as "definitely stale" by every caller. */
function hashFile(filePath: string): string | undefined {
  try {
    return sha256(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/** `{ size, mtimeMs }` for `filePath`, or `undefined` if it can't be stat'd
 * (removed, permissions, …) — the cheap signal `checkCache`'s fast path
 * compares against the recorded value before ever reading a file's content. */
function statFile(
  filePath: string,
): { readonly size: number; readonly mtimeMs: number } | undefined {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Walk up from a resolved module entry point to the nearest `package.json`
 * whose `name` matches `pkgName`, and return its `version`. Robust to a
 * package's `exports` map not exposing `package.json` as a subpath (common
 * in this monorepo's packages) — `require.resolve` still gives a real file
 * inside the package, and every real package's own manifest lives somewhere
 * above that file in the directory tree.
 *
 * `fromFile` anchors the module resolution — resolved as if `require` were
 * called from `fromFile`'s own directory, NOT from this module's (cache.ts's)
 * location. That distinction matters for exactly one real layout: a consumer
 * whose only `node_modules/@rhi-zone/*` symlinks live alongside its own
 * source (e.g. `apps/web/node_modules/@rhi-zone/`), not hoisted to a root
 * `node_modules` this package's own `dist/cache.js` can see by walking up
 * from ITS location. `require.resolve` follows symlinks to their real path
 * before searching `node_modules` upward, so resolving from cache.js's own
 * location walks up the dependency's real checkout, not the consumer's
 * install tree — a real checkout that may never have had its own
 * `node_modules` installed at all (see
 * docs/current/repo-audit-2026-08-20.md §1.1/§1.5). Resolving from
 * `fromFile` (the entry file actually being extracted, always somewhere
 * inside the consumer's own source tree) walks up the consumer's own
 * `node_modules` chain instead, which is where a sibling `@rhi-zone/*`
 * package is actually reachable from.
 *
 * Returns `"unknown"` if resolution fails entirely (package not installed
 * under this name in whatever `node_modules`/workspace-link layout the
 * caller runs under) — a stable-but-not-invalidating value, since a caller
 * lacking the package at all can't be codegenning against it either.
 */
function resolvePackageVersion(pkgName: string, fromFile: string): string {
  try {
    const fromRequire = createRequire(path.resolve(fromFile));
    const entry = fromRequire.resolve(pkgName);
    let dir = path.dirname(entry);
    for (;;) {
      const pkgJsonPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === pkgName) return pkg.version ?? "0.0.0";
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

/** True for one of TypeScript's own bundled ambient lib files
 * (`lib.es5.d.ts`, `lib.dom.d.ts`, …) — excluded from the tracked per-file
 * closure below because `tsVersion` already covers them as one signal; that
 * keeps the tracked file set (and so every cache-hit's re-hash cost) scoped
 * to the caller's own project + dependencies, not TypeScript's entire
 * bundled standard library on every check. Mirrors extract.ts's
 * `isTsBuiltinLibFile` (not imported from there — that one is a private
 * extraction-time helper; this is a build-cache-time concern with its own,
 * looser correctness bar: false negatives here just mean "track one file
 * that turns out not to matter", never wrong output). */
export function isTsBuiltinLibFile(fileName: string): boolean {
  return /[\\/]typescript[\\/]lib[\\/]lib\.[a-z0-9.]+\.d\.ts$/i.test(fileName);
}

/** sha256 of `entryFile`'s resolved `ts.CompilerOptions` — the same object
 * `createExtractorProgram` hands `ts.createProgram`
 * (`loadCompilerOptionsForFile`, `@rhi-zone/fractal-type-ir/from-typescript`),
 * so this fingerprint is guaranteed to move exactly when the options a real
 * build would actually use move: a `paths`/`strict`/
 * `exactOptionalPropertyTypes`/… edit anywhere in `entryFile`'s tsconfig.json
 * or its `extends` chain changes the resolved object, whether or not the edit
 * touches a file already in the tracked source-file closure — see the
 * cache-key-granularity doc block above and
 * docs/current/repo-audit-2026-08-20.md §2.2. `JSON.stringify` (not a
 * hand-rolled sorted-keys canonicalizer) is sufficient: `ts.CompilerOptions`
 * as returned by `parseJsonConfigFileContent` is a plain, deterministic
 * function of the same tsconfig content — no encounter-order-dependent
 * allocation to worry about, unlike a `Map`/`Set`-shaped value. */
function computeCompilerOptionsFingerprint(entryFile: string): string {
  return sha256(JSON.stringify(loadCompilerOptionsForFile(entryFile)));
}

// ============================================================================
// Cache file location
// ============================================================================

/** Where a cache-check/-write for `outFile` looks for its metadata —
 * explicit `cacheFile` wins outright; else `cacheDir` joined with a name
 * derived from `outFile`'s own basename; else, by default, a sibling of
 * `outFile` itself (`<outFile>.cache.json`). Configurable rather than
 * hardcoded to one path so a caller with its own generated-output layout
 * (the sibling codebase's `_generated/fractal-validators/`, a future
 * `_generated/fractal-schemas/`, or an entirely different consumer) can
 * choose where cache metadata lives — e.g. alongside the output for
 * grep-ability, or pooled in one `.cache/` directory kept out of the
 * generated-output tree entirely. */
export type CacheLocationOptions = {
  readonly cacheFile?: string;
  readonly cacheDir?: string;
  /** Opaque fingerprint of any build-option state that affects the emitted
   * artifact but isn't already covered by the tracked file closure or the
   * toolchain-version signals (`tsVersion`/`typeIrVersion`/`apiTreeVersion`)
   * — e.g. a `--tree-id`, a `runtimeImport` string, a `shouldShare`
   * predicate's identity. Folded into both `checkCache`'s hit/miss decision
   * and `readCarryForwardState`'s carry-forward eligibility, so a caller-
   * option change (a different `--tree-id`, a changed `runtimeImport`) is a
   * real miss instead of silently serving another option's artifact — see
   * docs/current/repo-audit-2026-08-20.md §1.3 ("builder options are not
   * part of the cache key at all") and §4. Compute however suits the
   * caller's own options shape (string concatenation, a hash — anything
   * stable across runs with the same effective options); omit (or leave `""`)
   * when the caller has no such option state to guard, which preserves the
   * pre-existing behavior exactly. */
  readonly buildOptionsKey?: string;
};

function resolveCacheFile(outFile: string, opts?: CacheLocationOptions): string {
  if (opts?.cacheFile !== undefined) return opts.cacheFile;
  if (opts?.cacheDir !== undefined)
    return path.join(opts.cacheDir, `${path.basename(outFile)}.cache.json`);
  return `${outFile}.cache.json`;
}

// ============================================================================
// Cache metadata shape
// ============================================================================

/** One tracked file's recorded state: its content hash (the ground truth) plus
 * the cheap `size`/`mtimeMs` pair `checkCache`'s fast path compares against
 * before ever reading the file's content — see the warm-check-cost doc block
 * above. */
type TrackedFileEntry = {
  readonly hash: string;
  readonly size: number;
  readonly mtimeMs: number;
};

// ============================================================================
// v3 — IR-keyed cache (leaf-level Tier 2), see
// docs/design/ir-keyed-cache-spec.md. Tier 1 (this file's existing
// file-closure gate, unchanged mechanism) answers "could anything possibly
// have moved"; Tier 2 (build.ts/schema-build.ts, using the fingerprint/
// carry-forward primitives below) answers "did any LEAF's resolved type
// actually change" and re-emits only those leaves' generated code. `files`
// keeps its v2 role exactly (Tier 1's whole-closure gate); `leafFingerprints`/
// `bundleFingerprint`/`defNamesFingerprint`/`leafArtifacts` are new, v3-only.
// ============================================================================

type CacheFileShape = {
  readonly version: 3;
  readonly tsVersion: string;
  readonly typeIrVersion: string;
  /** `@rhi-zone/fractal-api-tree`'s own resolved version — gates a
   * fractal-internal codegen-logic change the same way `typeIrVersion` gates
   * a `fractal-type-ir` upgrade. Without this, a change to THIS package's own
   * extraction/codegen (the `.js` that actually emits the artifact, not just
   * the type surface `files` already fingerprints via tracked `.d.ts`s) was
   * invisible to every cache check — see
   * docs/current/repo-audit-2026-08-20.md §1.1/§2.1. Resolved the same way
   * `typeIrVersion` is (see `resolvePackageVersion`'s doc comment). */
  readonly apiTreeVersion: string;
  /** sha256 of `entryFile`'s resolved `ts.CompilerOptions` — see
   * `computeCompilerOptionsFingerprint`'s doc comment and
   * docs/current/repo-audit-2026-08-20.md §2.2 ("tsconfig / compilerOptions
   * are not tracked"). Gated the same way as the tracked file closure: a
   * mismatch is a Tier-1 miss, and (via `toolchainMatches`) also disqualifies
   * every leaf's Tier-2 carry-forward, since a changed `strict`/
   * `exactOptionalPropertyTypes`/… can change what ANY leaf's extraction
   * produces, not just leaves whose own fingerprint moved — same reasoning as
   * `tsVersion`/`typeIrVersion`. */
  readonly compilerOptionsHash: string;
  /** Opaque caller-computed fingerprint of build options not already covered
   * by the tracked file closure or the toolchain-version signals above (a
   * `--tree-id`, a `runtimeImport`, a `shouldShare` predicate's identity) —
   * see `CacheLocationOptions.buildOptionsKey`'s doc comment and
   * docs/current/repo-audit-2026-08-20.md §1.3/§4. `""` for a caller with
   * nothing to key on (preserves old behavior). */
  readonly buildOptionsKey: string;
  readonly entryFile: string;
  /** Absolute file path -> recorded state, as of the last successful build —
   * the entry file itself is included under its own path, so an edit to the
   * entry file is caught the same way as an edit to anything it transitively
   * imports. Tier 1 only — see the module doc above. */
  readonly files: Record<string, TrackedFileEntry>;
  /** Tier 2: one fingerprint per leaf (keyed however the caller's own
   * extraction keys leaves — a route path for the validator artifact, an MCP
   * tool name for the schema artifact), a sha256 of that leaf's canonicalized
   * resolved input/output IR — see `computeLeafFingerprint`. Empty for a
   * caller that never engages Tier 2 (e.g. cli.ts's single-shot build/watch/
   * check, which still writes valid v3 metadata but gets no leaf-level
   * carry-forward — Tier 1 alone still works unchanged for it). */
  readonly leafFingerprints: Record<string, string>;
  /** Rollup over `leafFingerprints`, sorted by leaf key (see
   * `computeBundleFingerprint`) — lets a Tier-2 caller decide "does this
   * bundle's output need rewriting at all" in one comparison instead of
   * walking every leaf. */
  readonly bundleFingerprint: string;
  /** Fingerprint of the SET of shared/recursive def names in scope for this
   * entry's compile (structural sharing, `shouldShare` — see
   * from-typescript.ts's `finalizeSharedDefs`), sorted. A leaf's own
   * generated code depends on which def NAMES are callable (a `ref` node
   * either resolves to a call or passes through), not on the def bodies
   * themselves — so this is the second half of a leaf's carry-forward safety
   * check alongside its own `leafFingerprints` entry (see
   * `compileEntryFragment`'s doc comment, type-ir/compile.ts). Empty string
   * for a caller with no sharing/defs concept (the schema artifact, which has
   * no `ref`/`defs` machinery at all).
   */
  readonly defNamesFingerprint: string;
  /** Per-leaf carried-forward artifact — opaque to this module (a caller-
   * defined JSON value: a compiled validator fragment + its type-import, or a
   * derived JSON-Schema value). Reused verbatim by a Tier-2 caller for any
   * leaf whose CURRENT fingerprint (+ `defNamesFingerprint`, for callers that
   * use it) still matches what's recorded here — never interpreted or
   * validated by cache.ts itself, only stored/returned. */
  readonly leafArtifacts: Record<string, unknown>;
  /** sha256 of the exact bytes written to `outFile` on the last successful
   * build — lets `checkCache` also catch the case where nothing in the
   * INPUT closure changed but `outFile` itself was hand-edited (or clobbered
   * by something else) after the fact; a cache "hit" is a claim about the
   * output too, not just the inputs. */
  readonly outputHash: string;
};

/** `CacheFileShape`, exported read-only for Tier-2 callers that need the
 * carry-forward fields (`leafFingerprints`/`leafArtifacts`/
 * `defNamesFingerprint`) — see `readCarryForwardState`. */
export type CacheFileShapeV3 = CacheFileShape;

export type CacheCheckResult =
  | { readonly hit: true }
  | { readonly hit: false; readonly reason: string };

/** Parse `cacheFile`'s JSON, or `undefined` if missing/unreadable —
 * shared by `checkCache` (Tier 1) and `readCarryForwardState` (Tier 2), so
 * the two never drift on how a cache file is located/parsed. */
function readMeta(outFile: string, opts?: CacheLocationOptions): CacheFileShape | undefined {
  const cacheFile = resolveCacheFile(outFile, opts);
  if (!fs.existsSync(cacheFile)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as CacheFileShape;
  } catch {
    return undefined;
  }
}

/** True when `meta` is a v3 record whose toolchain identity (format version,
 * entry file, TypeScript version, fractal-type-ir version) matches the
 * current run — the bar `readCarryForwardState` uses to decide whether
 * `meta`'s per-leaf data is even worth comparing fingerprints against. Checks
 * only the toolchain signals, not `outputHash`/tracked-file state: a leaf's
 * carry-forward safety comes from fingerprint equality alone (see
 * `compileEntryFragment`'s doc comment, type-ir/compile.ts), not from why an
 * outer cache tier hit or missed, so an output file hand-edited outside the
 * pipeline, or one tracked source file changed, doesn't invalidate every
 * other leaf's still-fingerprint-matching carried-forward artifact. A
 * toolchain change, in contrast, can change what any leaf's codegen produces
 * (a `fractal-type-ir` upgrade can change `compile.ts`'s own templates), so
 * that specifically disqualifies every leaf's carry-forward, not just the
 * ones whose fingerprint changed. */
function toolchainMatches(
  meta: CacheFileShape,
  entryFile: string,
  opts?: CacheLocationOptions,
): boolean {
  return (
    meta.version === 3 &&
    meta.entryFile === path.resolve(entryFile) &&
    meta.tsVersion === ts.version &&
    meta.typeIrVersion === resolvePackageVersion("@rhi-zone/fractal-type-ir", entryFile) &&
    meta.apiTreeVersion === resolvePackageVersion("@rhi-zone/fractal-api-tree", entryFile) &&
    meta.compilerOptionsHash === computeCompilerOptionsFingerprint(entryFile) &&
    meta.buildOptionsKey === (opts?.buildOptionsKey ?? "")
  );
}

/**
 * Cheap validity check: no `ts.Program` construction, just re-reading (and
 * re-hashing) the specific files the LAST successful build recorded as its
 * closure, plus the two toolchain-version signals. This is what makes a
 * cache hit fast — the whole point of caching here is to skip the
 * multi-GB `ts.Program` build entirely when nothing changed, so this check
 * must never itself require building one.
 *
 * Tier 1 only (see this file's IR-keyed-cache module doc above): answers
 * "could anything possibly have changed", never "what changed" — a `hit:
 * false` here means "fall through to Tier 2", not "re-emit everything". A
 * caller wanting Tier 2's leaf-level carry-forward data on a miss calls
 * `readCarryForwardState` separately (see that function's doc comment for
 * why it's decoupled from this check's hit/miss outcome).
 */
export function checkCache(
  entryFile: string,
  outFile: string,
  opts?: CacheLocationOptions,
): CacheCheckResult {
  if (!fs.existsSync(outFile)) return { hit: false, reason: "output missing" };
  const meta = readMeta(outFile, opts);
  if (meta === undefined) {
    return {
      hit: false,
      reason: fs.existsSync(resolveCacheFile(outFile, opts))
        ? "cache metadata unreadable"
        : "no cache metadata",
    };
  }
  if (meta.version !== 3) return { hit: false, reason: "cache format version changed" };
  if (meta.entryFile !== path.resolve(entryFile))
    return { hit: false, reason: "entry file path changed" };
  if (meta.tsVersion !== ts.version) return { hit: false, reason: "typescript version changed" };

  const typeIrVersion = resolvePackageVersion("@rhi-zone/fractal-type-ir", entryFile);
  if (meta.typeIrVersion !== typeIrVersion)
    return { hit: false, reason: "fractal-type-ir version changed" };

  const apiTreeVersion = resolvePackageVersion("@rhi-zone/fractal-api-tree", entryFile);
  if (meta.apiTreeVersion !== apiTreeVersion)
    return { hit: false, reason: "fractal-api-tree version changed" };

  const compilerOptionsHash = computeCompilerOptionsFingerprint(entryFile);
  if (meta.compilerOptionsHash !== compilerOptionsHash)
    return { hit: false, reason: "tsconfig/compilerOptions changed" };

  if (meta.buildOptionsKey !== (opts?.buildOptionsKey ?? ""))
    return { hit: false, reason: "build options changed" };

  const outputHash = hashFile(outFile);
  if (outputHash !== meta.outputHash) {
    return { hit: false, reason: "output file changed outside codegen" };
  }

  // Tiered re-validation — see the warm-check-cost doc block above. Fast
  // path first (stat only, no content read): a file whose size AND mtime
  // both still match what was recorded is assumed unchanged. Only a
  // size/mtime mismatch falls back to actually reading + hashing that one
  // file's content, so a `touch`-without-edit (or a checkout that bumps
  // mtimes without changing bytes) still resolves to a hit rather than a
  // false miss.
  for (const [file, recorded] of Object.entries(meta.files)) {
    const stat = statFile(file);
    if (stat === undefined) return { hit: false, reason: `tracked file missing: ${file}` };
    if (stat.size === recorded.size && stat.mtimeMs === recorded.mtimeMs) continue;
    const current = hashFile(file);
    if (current === undefined) return { hit: false, reason: `tracked file missing: ${file}` };
    if (current !== recorded.hash) return { hit: false, reason: `tracked file changed: ${file}` };
  }

  return { hit: true };
}

/**
 * Record cache metadata after a successful build: by default, `program`'s
 * current source-file set — the precise per-entry closure for a fresh
 * single-root Program, or the whole batch's union closure for an externally
 * shared multi-root one (see the key-granularity doc block above) — plus
 * the toolchain-version signals and the exact bytes written to `outFile`.
 *
 * Pass `reachable` (a set of resolved absolute file paths — see
 * `reachability.ts`'s `computeEntryClosures`) to record only THAT file set
 * instead: the precise per-entry closure even when `program` is a shared
 * multi-root Program spanning many entries. Every path in `reachable` must
 * name a file `program` actually has parsed (i.e. must appear in
 * `program.getSourceFiles()`) — a path that doesn't is silently skipped
 * (not an error: `computeEntryClosures` is derived from the same Program by
 * construction, so a mismatch here would mean a caller passed a
 * `reachable` set computed against a DIFFERENT Program than `program`,
 * which is a caller bug worth surfacing as "this file never got tracked",
 * not a thrown exception at write time).
 *
 * Uses each source file's already-parsed in-memory text
 * (`sourceFile.getFullText()`) rather than re-reading from disk — the
 * Program already paid that I/O, no reason to pay it twice.
 *
 * `leafData`, when given, records Tier 2's per-leaf state (see this file's
 * IR-keyed-cache module doc above) alongside Tier 1's file closure — a
 * caller that never engages Tier 2 (cli.ts's single-shot build/watch/check)
 * omits it and gets empty `leafFingerprints`/`leafArtifacts` + an empty
 * `bundleFingerprint`/`defNamesFingerprint`: still valid v3 metadata (Tier 1
 * keeps working exactly as before), just with no leaf-level carry-forward
 * data for a future Tier-2 caller to use.
 */
export function writeCacheMetadata(
  entryFile: string,
  outFile: string,
  program: ts.Program,
  writtenContent: string,
  opts?: CacheLocationOptions,
  reachable?: ReadonlySet<string>,
  leafData?: {
    readonly leafFingerprints: Readonly<Record<string, string>>;
    readonly leafArtifacts: Readonly<Record<string, unknown>>;
    readonly defNamesFingerprint?: string;
  },
): void {
  const files: Record<string, TrackedFileEntry> = {};
  const sourceFiles =
    reachable === undefined
      ? program.getSourceFiles()
      : program
          .getSourceFiles()
          .filter((sourceFile) => reachable.has(path.resolve(sourceFile.fileName)));
  if (reachable !== undefined) {
    // A `reachable` path absent from `program.getSourceFiles()` silently
    // drops out of tracking (see this function's doc comment above) — that's
    // intentionally not a thrown exception (the mismatch is expected to be
    // rare and the build itself should still succeed), but staying silent
    // about it meant the symptom (permanent stale hits for edits to the
    // untracked file) was invisible until a wrong artifact shipped — see
    // docs/current/repo-audit-2026-08-20.md §2.3. Surface it instead.
    const present = new Set(
      program.getSourceFiles().map((sourceFile) => path.resolve(sourceFile.fileName)),
    );
    const untracked = [...reachable].filter((file) => !present.has(path.resolve(file)));
    if (untracked.length > 0) {
      process.stderr.write(
        `warning: writeCacheMetadata — ${untracked.length} path(s) in \`reachable\` are not in \`program\`'s parsed source files and will never be tracked (likely \`reachable\` computed against a different Program than \`program\`): ${untracked.slice(0, 5).join(", ")}${untracked.length > 5 ? `, … (${untracked.length - 5} more)` : ""}\n`,
      );
    }
  }
  for (const sourceFile of sourceFiles) {
    if (isTsBuiltinLibFile(sourceFile.fileName)) continue;
    // `size`/`mtimeMs` come from a fresh `fs.statSync`, not the Program's
    // already-parsed text — the Program doesn't carry filesystem metadata,
    // only content. This stat is paid once per file, only on an actual
    // build (never on the warm `checkCache` path), so it doesn't reintroduce
    // the cost this cache exists to avoid.
    const stat = statFile(sourceFile.fileName);
    files[sourceFile.fileName] = {
      hash: sha256(sourceFile.getFullText()),
      size: stat?.size ?? -1,
      mtimeMs: stat?.mtimeMs ?? -1,
    };
  }
  const leafFingerprints = leafData?.leafFingerprints ?? {};
  const meta: CacheFileShape = {
    version: 3,
    tsVersion: ts.version,
    typeIrVersion: resolvePackageVersion("@rhi-zone/fractal-type-ir", entryFile),
    apiTreeVersion: resolvePackageVersion("@rhi-zone/fractal-api-tree", entryFile),
    compilerOptionsHash: computeCompilerOptionsFingerprint(entryFile),
    buildOptionsKey: opts?.buildOptionsKey ?? "",
    entryFile: path.resolve(entryFile),
    files,
    leafFingerprints,
    bundleFingerprint: computeBundleFingerprint(leafFingerprints),
    defNamesFingerprint: leafData?.defNamesFingerprint ?? "",
    leafArtifacts: leafData?.leafArtifacts ?? {},
    outputHash: sha256(writtenContent),
  };
  const cacheFile = resolveCacheFile(outFile, opts);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(meta));
}

// ============================================================================
// Tier 2 primitives — leaf fingerprinting + carry-forward read. See this
// file's IR-keyed-cache module doc above for the two-tier design.
// ============================================================================

/** Deep-clone `value` (a plain JSON-shaped tree — objects/arrays/primitives,
 * exactly what a `TypeRef` is), relativizing every string found under a
 * `declarationFile` key against `rootDir` — POSIX-separated, so the result is
 * identical regardless of host OS or which absolute checkout path produced
 * it. General over WHERE in the tree `declarationFile` appears (any object's
 * own key, at any nesting depth — a leaf's own top-level meta, a nested
 * field's meta, a shared `defs` entry's meta), not narrowed to one TypeRef
 * shape kind, so a new shape kind that later carries `declarationFile` is
 * covered automatically. Values that aren't already absolute paths (already
 * relative, or simply not a path) round-trip through `path.relative`
 * unharmed in practice for this codebase's actual producer
 * (`extract.ts`'s `typeProvenanceOf`, which always reads
 * `decl.getSourceFile().fileName` — always absolute, by construction of
 * `ts.Program`), so no separate "is this even a path" guard is needed. */
function canonicalizeForFingerprint(value: unknown, rootDir: string): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeForFingerprint(item, rootDir));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        key === "declarationFile" && typeof v === "string"
          ? path.relative(rootDir, v).split(path.sep).join("/")
          : canonicalizeForFingerprint(v, rootDir);
    }
    return out;
  }
  return value;
}

/**
 * Fingerprint one leaf's extracted IR: sha256 of the canonical-JSON
 * serialization of `leaf` (typically `{ input: TypeRef, output?: TypeRef }`,
 * exactly what `tree.ts`'s `extractRouteTypeRefs`/`extractToolTypeRefs`
 * already produce per leaf — this function doesn't care about the exact
 * shape, only that it's JSON-serializable), canonicalized against
 * `path.dirname(entryFile)` so any `declarationFile` absolute path inside it
 * becomes a checkout-relative path (see `canonicalizeForFingerprint`) —
 * portable across two checkouts of the same repo at different absolute
 * locations, per docs/design/ir-keyed-cache-spec.md §6's determinism finding.
 *
 * `JSON.stringify` (not a hand-rolled sorted-keys canonicalizer) is
 * sufficient here — see the spec's §6 finding: a `TypeRef`'s own key order is
 * derived from source declaration order (deterministic per source text, not
 * per-run allocation), confirmed byte-stable across two independent
 * `ts.Program` builds over identical source, including the structural-
 * sharing/`defs` path (`uniqueRegistryName` is base-name-derived, not an
 * encounter-order counter).
 */
export function computeLeafFingerprint(entryFile: string, leaf: unknown): string {
  const rootDir = path.dirname(path.resolve(entryFile));
  return sha256(JSON.stringify(canonicalizeForFingerprint(leaf, rootDir)));
}

/** Rollup over every leaf's fingerprint, sorted by leaf key (not encounter
 * order) so the rollup itself doesn't depend on extraction visiting leaves in
 * a stable order — see docs/design/ir-keyed-cache-spec.md §3. */
export function computeBundleFingerprint(
  leafFingerprints: Readonly<Record<string, string>>,
): string {
  const sorted = Object.keys(leafFingerprints).sort();
  return sha256(sorted.map((key) => leafFingerprints[key]).join(""));
}

/** Fingerprint of a SET of def names (structural sharing's shared/recursive
 * names in scope for one entry's compile), sorted — see `CacheFileShape`'s
 * `defNamesFingerprint` doc comment for why this, not the defs' own bodies,
 * is what a leaf's carry-forward safety depends on. */
export function computeDefNamesFingerprint(
  defNames: ReadonlySet<string> | readonly string[],
): string {
  return sha256([...defNames].sort().join(","));
}

/**
 * Read the prior v3 cache metadata's Tier-2 state — `leafFingerprints`,
 * `leafArtifacts`, `defNamesFingerprint` — for a Tier-2 caller to diff
 * against freshly-computed fingerprints, or `undefined` if there's nothing
 * TRUSTWORTHY to diff against (no cache file, unreadable, wrong format
 * version, or a toolchain signal changed — see `toolchainMatches`).
 *
 * Independent of `checkCache`'s Tier-1 hit/miss outcome (and of
 * `outputHash`): a leaf's carry-forward safety is proven by fingerprint
 * equality alone (see `compileEntryFragment`'s doc comment, type-ir/
 * compile.ts). A Tier-1 miss (some tracked file's content changed) or an
 * `outputHash` mismatch (the output file was hand-edited) says nothing about
 * whether any individual leaf's resolved type actually moved, so neither
 * disqualifies carry-forward on its own. Only a toolchain change
 * (`toolchainMatches`) disqualifies every leaf at once, because that can
 * change what any leaf's codegen produces, not just the ones whose
 * fingerprint changed.
 */
export function readCarryForwardState(
  entryFile: string,
  outFile: string,
  opts?: CacheLocationOptions,
): Pick<CacheFileShape, "leafFingerprints" | "leafArtifacts" | "defNamesFingerprint"> | undefined {
  const meta = readMeta(outFile, opts);
  if (meta === undefined || !toolchainMatches(meta, entryFile, opts)) return undefined;
  return {
    leafFingerprints: meta.leafFingerprints,
    leafArtifacts: meta.leafArtifacts,
    defNamesFingerprint: meta.defNamesFingerprint,
  };
}

// ============================================================================
// withCache — a reference implementation of the checkCache -> build ->
// writeCacheMetadata orchestration below, NOT currently called by
// schema-build.ts, apply-validation-build.ts, or cli.ts — each hand-inlines
// this exact sequence instead (see docs/current/repo-audit-2026-08-20.md
// §2.4). Kept as the orchestration's single documented contract (and what
// docs/design/ir-keyed-cache-spec.md describes) for a future caller that
// wants it directly; a caller with its own header-prepending/write
// convention still needs to satisfy the same "write those exact same bytes"
// contract documented below whether or not it calls this function.
// ============================================================================

export type CachedBuildOutcome<T> =
  | { readonly status: "hit" }
  | { readonly status: "built"; readonly result: T; readonly program: ts.Program };

/**
 * Run `build(program)` only when the cache misses (or `options.force` is
 * set); on a hit, skip both the Program construction AND `build` entirely —
 * returning `{status:"hit"}` with no further work. On a build, `program`
 * defaults to `createExtractorProgram(entryFile)` (a fresh single-root
 * Program, giving `writeCacheMetadata` a precise per-entry closure) unless
 * the caller passes one in (a batch caller's shared multi-root Program —
 * see the key-granularity decision above).
 *
 * `build` must return the exact string that gets (or will get) written to
 * `outFile` — `withCache` doesn't write `outFile` itself (a caller may have
 * its own header-prepending/write convention to preserve — see cli.ts's
 * `withHeader`), it only needs the final bytes to compute `outputHash` for
 * next time. Callers MUST
 * write `outFile` themselves before (or immediately after) calling
 * `writeCacheMetadata` — `withCache` calls it automatically right after a
 * successful `build`, keyed to whatever bytes `build` returned, so as long
 * as the caller writes those exact same bytes to `outFile`, cache and disk
 * stay consistent.
 *
 * `options.reachable`, when given, is passed straight through to
 * `writeCacheMetadata` — a batch caller sharing one multi-root `program`
 * across many entries (see `reachability.ts`'s `computeEntryClosures`) uses
 * this to record each entry's own precise closure instead of the whole
 * shared Program's file set. Irrelevant (and safe to omit) for the
 * single-Program-per-entry callers this package's own CLI uses.
 */
export function withCache<T extends string>(
  entryFile: string,
  outFile: string,
  build: (program: ts.Program) => T,
  options: {
    readonly program?: ts.Program;
    readonly force?: boolean;
    readonly createProgram: (entryFile: string) => ts.Program;
    readonly reachable?: ReadonlySet<string>;
  } & CacheLocationOptions,
): CachedBuildOutcome<T> {
  if (!options.force) {
    const check = checkCache(entryFile, outFile, options);
    if (check.hit) return { status: "hit" };
  }
  const program = options.program ?? options.createProgram(entryFile);
  const result = build(program);
  writeCacheMetadata(entryFile, outFile, program, result, options, options.reachable);
  return { status: "built", result, program };
}
