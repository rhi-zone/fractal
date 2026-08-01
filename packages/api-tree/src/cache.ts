// packages/api-tree/src/cache.ts — @rhi-zone/fractal-api-tree
//
// CONTENT-ADDRESSED INCREMENTAL-BUILD CACHE for the extract/codegen pipeline
// (build.ts's `buildValidatorModuleSource`, schema-build.ts's
// `buildSchemaModuleSource`, wired into cli.ts's build/watch/check commands).
// Replaces cli.ts's prior `isUpToDate` (output mtime > entry mtime) — that
// check only looked at the ENTRY file's own mtime, ignored every transitive
// file the extractor actually reads (so editing an imported kernel type
// never invalidated a generated module), and wasn't content-addressed at all
// (a `touch`-without-edit falsely invalidated; a revert-to-identical-content
// falsely stayed "stale" until mtime happened to line up).
//
// ============================================================================
// Key-granularity decision (open call, resolved) — READ THIS before changing
// how `writeCacheMetadata` gets its file list.
// ============================================================================
//
// The precise cache key for one entry file is "this entry file's content +
// every source file its extraction actually reads, transitively". The
// PRECISE way to get that list is a fresh single-root `ts.Program` over just
// that entry — `program.getSourceFiles()` on a single-root Program IS
// exactly that entry's transitive closure, no extra tracking needed.
//
// But a batch caller (the sibling codebase's `codegen-fractal-validators.ts`) builds ONE
// shared multi-root Program across many entries specifically to avoid
// paying a fresh Program's multi-GB cost per entry (see build.ts's
// `buildValidatorModuleSource` doc comment for the measured before/after).
// Recomputing a precise per-entry closure from that shared Program would
// require either (a) building a second, throwaway single-root Program per
// entry just to enumerate its files — defeats the whole point of sharing —
// or (b) walking each root's `resolvedModules`/import graph by hand to
// derive per-entry reachability from the shared Program's already-parsed
// files. (b) is possible (`ts.Program` exposes `getSourceFile(name)` and each
// `ts.SourceFile` carries `.resolvedModules`), but is real additional
// complexity — a second graph-walk implementation to keep correct alongside
// the extractor's own traversal — for a caching layer whose entire job is to
// be cheap and boring.
//
// DECISION: this module hashes `program.getSourceFiles()` UNCHANGED —
// whichever Program the caller used to build. For the single-entry path
// (`writeValidatorModule`, the CLI's `build`/`check`/`watch` commands — none
// of which share a Program across entries), that Program is a fresh
// single-root one, so the resulting file set IS the precise per-entry
// closure: no precision lost. For a batch caller that passes an externally
// shared multi-root Program, the resulting file set is the whole batch's
// UNION closure, applied identically to every entry in the batch — the
// documented coarse fallback the task brief names explicitly ("hashing the
// whole shared Program's file set as one key shared by every entry in the
// batch, trading precision for simplicity — invalidates everything on any
// change but is trivially correct and cheap"). Chosen over (b) because: the
// batch caller ALREADY re-derives its shared Program's root set from
// scratch on every invocation regardless of caching (see
// `codegen-fractal-validators.ts`'s `findEntryFiles` + `createExtractorProgram`
// call, both unconditional), so a change anywhere in that shared closure was
// already going to force a full re-parse of the whole batch to even LOOK for
// what changed — the coarse key doesn't cost the batch caller a real
// incremental-rebuild opportunity it could otherwise have had; it costs it
// only the (already-fresh) per-entry regeneration once the shared Program
// is rebuilt. Precise per-entry keys inside a shared batch remain future
// work if a caller's batch grows large enough that "any file anywhere in the
// closure invalidates everything" starts mattering in practice — nothing
// here forecloses adding it later, since `withCache` below takes a
// caller-supplied Program either way.
//
// One correctness note this key shape depends on: a file's identity is its
// resolved path. Adding a NEW file to an entry's closure (a fresh import)
// changes the file that added the import (its content changed), which is
// already tracked — so the new file's absence from `files.length` before
// isn't a blind spot: the edit that introduced it always shows up as a
// changed-content hash on some file already in (or about to reenter) the
// closure. The only thing this key CANNOT detect is a change to something
// outside file content entirely (compiler options embedded in tsconfig.json
// resolution, environment) — out of scope here; `tsVersion`/`typeIrVersion`
// below cover the toolchain half of that, which is what the task asked for.
//
// ============================================================================

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import ts from "typescript"

const require = createRequire(import.meta.url)

/** sha256 of a string, hex-encoded — the one hash primitive this module uses
 * throughout (entry/dependency file content, output content). */
function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex")
}

/** Hash a file's current on-disk content, or `undefined` if it can't be read
 * (removed, permissions, …) — treated as "definitely stale" by every caller. */
function hashFile(filePath: string): string | undefined {
  try {
    return sha256(fs.readFileSync(filePath, "utf8"))
  } catch {
    return undefined
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
 * Returns `"unknown"` if resolution fails entirely (package not installed
 * under this name in whatever `node_modules`/workspace-link layout the
 * caller runs under) — a stable-but-not-invalidating value, since a caller
 * lacking the package at all can't be codegenning against it either.
 */
function resolvePackageVersion(pkgName: string): string {
  try {
    const entry = require.resolve(pkgName)
    let dir = path.dirname(entry)
    for (;;) {
      const pkgJsonPath = path.join(dir, "package.json")
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
          name?: string
          version?: string
        }
        if (pkg.name === pkgName) return pkg.version ?? "0.0.0"
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // fall through
  }
  return "unknown"
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
function isTsBuiltinLibFile(fileName: string): boolean {
  return /[\\/]typescript[\\/]lib[\\/]lib\.[a-z0-9.]+\.d\.ts$/i.test(fileName)
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
  readonly cacheFile?: string
  readonly cacheDir?: string
}

function resolveCacheFile(outFile: string, opts?: CacheLocationOptions): string {
  if (opts?.cacheFile !== undefined) return opts.cacheFile
  if (opts?.cacheDir !== undefined) return path.join(opts.cacheDir, `${path.basename(outFile)}.cache.json`)
  return `${outFile}.cache.json`
}

// ============================================================================
// Cache metadata shape
// ============================================================================

type CacheFileShape = {
  readonly version: 1
  readonly tsVersion: string
  readonly typeIrVersion: string
  readonly entryFile: string
  /** Absolute file path -> sha256 of its content, as of the last successful
   * build — the entry file itself is included under its own path, so an
   * edit to the entry file is caught the same way as an edit to anything it
   * transitively imports. */
  readonly files: Record<string, string>
  /** sha256 of the exact bytes written to `outFile` on the last successful
   * build — lets `checkCache` also catch the case where nothing in the
   * INPUT closure changed but `outFile` itself was hand-edited (or clobbered
   * by something else) after the fact; a cache "hit" is a claim about the
   * output too, not just the inputs. */
  readonly outputHash: string
}

export type CacheCheckResult =
  | { readonly hit: true }
  | { readonly hit: false; readonly reason: string }

/**
 * Cheap validity check: no `ts.Program` construction, just re-reading (and
 * re-hashing) the specific files the LAST successful build recorded as its
 * closure, plus the two toolchain-version signals. This is what makes a
 * cache hit fast — the whole point of caching here is to skip the
 * multi-GB `ts.Program` build entirely when nothing changed, so this check
 * must never itself require building one.
 */
export function checkCache(entryFile: string, outFile: string, opts?: CacheLocationOptions): CacheCheckResult {
  if (!fs.existsSync(outFile)) return { hit: false, reason: "output missing" }
  const cacheFile = resolveCacheFile(outFile, opts)
  if (!fs.existsSync(cacheFile)) return { hit: false, reason: "no cache metadata" }

  let meta: CacheFileShape
  try {
    meta = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as CacheFileShape
  } catch {
    return { hit: false, reason: "cache metadata unreadable" }
  }
  if (meta.version !== 1) return { hit: false, reason: "cache format version changed" }
  if (meta.entryFile !== path.resolve(entryFile)) return { hit: false, reason: "entry file path changed" }
  if (meta.tsVersion !== ts.version) return { hit: false, reason: "typescript version changed" }

  const typeIrVersion = resolvePackageVersion("@rhi-zone/fractal-type-ir")
  if (meta.typeIrVersion !== typeIrVersion) return { hit: false, reason: "fractal-type-ir version changed" }

  const outputHash = hashFile(outFile)
  if (outputHash !== meta.outputHash) {
    return { hit: false, reason: "output file changed outside codegen" }
  }

  for (const [file, hash] of Object.entries(meta.files)) {
    const current = hashFile(file)
    if (current === undefined) return { hit: false, reason: `tracked file missing: ${file}` }
    if (current !== hash) return { hit: false, reason: `tracked file changed: ${file}` }
  }

  return { hit: true }
}

/**
 * Record cache metadata after a successful build: `program`'s current
 * source-file set (see the key-granularity decision at the top of this
 * file for what that set precisely means depending on whether `program` is
 * a fresh single-root Program or an externally shared multi-root one) plus
 * the toolchain-version signals and the exact bytes written to `outFile`.
 * Uses each source file's already-parsed in-memory text
 * (`sourceFile.getFullText()`) rather than re-reading from disk — the
 * Program already paid that I/O, no reason to pay it twice.
 */
export function writeCacheMetadata(
  entryFile: string,
  outFile: string,
  program: ts.Program,
  writtenContent: string,
  opts?: CacheLocationOptions,
): void {
  const files: Record<string, string> = {}
  for (const sourceFile of program.getSourceFiles()) {
    if (isTsBuiltinLibFile(sourceFile.fileName)) continue
    files[sourceFile.fileName] = sha256(sourceFile.getFullText())
  }
  const meta: CacheFileShape = {
    version: 1,
    tsVersion: ts.version,
    typeIrVersion: resolvePackageVersion("@rhi-zone/fractal-type-ir"),
    entryFile: path.resolve(entryFile),
    files,
    outputHash: sha256(writtenContent),
  }
  const cacheFile = resolveCacheFile(outFile, opts)
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  fs.writeFileSync(cacheFile, JSON.stringify(meta))
}

// ============================================================================
// withCache — the shared orchestration both build.ts and schema-build.ts use
// ============================================================================

export type CachedBuildOutcome<T> =
  | { readonly status: "hit" }
  | { readonly status: "built"; readonly result: T; readonly program: ts.Program }

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
 * `outFile` — `withCache` doesn't write `outFile` itself (callers already
 * have their own header-prepending/write conventions to preserve — see
 * build.ts's `writeValidatorModule` and cli.ts's `withHeader`), it only
 * needs the final bytes to compute `outputHash` for next time. Callers MUST
 * write `outFile` themselves before (or immediately after) calling
 * `writeCacheMetadata` — `withCache` calls it automatically right after a
 * successful `build`, keyed to whatever bytes `build` returned, so as long
 * as the caller writes those exact same bytes to `outFile`, cache and disk
 * stay consistent.
 */
export function withCache<T extends string>(
  entryFile: string,
  outFile: string,
  build: (program: ts.Program) => T,
  options: {
    readonly program?: ts.Program
    readonly force?: boolean
    readonly createProgram: (entryFile: string) => ts.Program
  } & CacheLocationOptions,
): CachedBuildOutcome<T> {
  if (!options.force) {
    const check = checkCache(entryFile, outFile, options)
    if (check.hit) return { status: "hit" }
  }
  const program = options.program ?? options.createProgram(entryFile)
  const result = build(program)
  writeCacheMetadata(entryFile, outFile, program, result, options)
  return { status: "built", result, program }
}
