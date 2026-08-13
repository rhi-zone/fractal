// Per-entry module-graph reachability over an already-built `ts.Program` —
// the "(b)" option cache.ts's key-granularity decision doc named and
// deferred: "walking each root's resolvedModules/import graph by hand to
// derive per-entry reachability from the shared Program's already-parsed
// files". Exists so a caller sharing one multi-root `ts.Program` across many
// entries (the sibling codebase's `codegen-fractal-validators.ts` — 17 slices, one
// `ts.Program`) can still record each entry's own precise transitive-import
// closure as its cache key, instead of the whole shared Program's file set
// applied identically to every entry (cache.ts's previous coarse fallback —
// see git history on that file's key-granularity doc block for the
// superseded design and why it was chosen as an interim step).
//
// ============================================================================
// How the walk works
// ============================================================================
//
// A `ts.Program` doesn't expose a public per-file "what does this file
// import" API (no public `resolvedModules` on `ts.SourceFile` in this
// TypeScript version — that map lives inside the Program's own closure
// state). What is available, and has been a stable (if formally internal)
// field across many TypeScript versions, is `ts.SourceFile.imports`: a
// `readonly StringLiteralLike[]` the parser itself populates with every
// module-specifier string literal it saw while parsing the file — `import`
// declarations (type-only included: `import type {X} from "..."` still
// parses as an `ImportDeclaration`, so its specifier lands in `imports` the
// same as a value import), `export ... from` re-exports, `import(...)`
// dynamic-import calls, and `require(...)` calls. This is exactly "TS gives
// you resolved module imports per file" — we don't hand-roll an AST walker
// to find import statements; TS already did that during parsing and kept
// the result. (Verified present at runtime against this repo's pinned
// TypeScript 6.0.3 — `(sourceFile as any).imports` — even though it isn't
// declared in `typescript.d.ts`'s public `SourceFile` interface.)
//
// Each specifier is then resolved to a file path via `ts.resolveModuleName`
// — the same public resolver TypeScript's own Program construction uses —
// against a single shared `ts.ModuleResolutionCache` so repeated specifiers
// (react, kernel types, etc., imported from dozens of files) don't pay
// redundant filesystem probing. A specifier that fails to resolve (a bare
// ambient/global module, a non-TS asset the loader handles some other way)
// is simply skipped — it can't be a source-file dependency edge if there's
// no source file to point at.
//
// The per-file "direct dependencies" result is memoized once, globally
// across every entry's walk (not per-entry) — the module graph is walked
// once regardless of how many entries share it, and each entry's closure is
// just a BFS over that shared, memoized edge set starting from a different
// root. This is what makes computing closures for all N entries cost O(files
// in the union closure), not O(N × files) — the same sharing rationale
// `createExtractorProgram`'s own doc comment gives for building one Program
// instead of N.
//
// ============================================================================
// What this correctly captures (and what it doesn't)
// ============================================================================
//
// Captured: any file reachable from an entry via `import`/`import
// type`/`export ... from`/dynamic `import()`/`require()`, at any depth,
// including declaration (`.d.ts`) files and files inside `node_modules` —
// the same files a fresh single-root `ts.Program` over that one entry would
// include in `getSourceFiles()`. A file reachable from multiple entries
// (shared kernel/support types, a common utility module) appears in every
// one of those entries' closures — invalidating every dependent entry when
// it changes, and no others, which is the whole point of computing this
// per-entry rather than once for the whole batch.
//
// Not captured: triple-slash reference directives (`/// <reference path=…
// />` / `<reference types=… />`) and ambient ("global") declarations only
// when a file reaches them without syntactic sight of any of the traversal
// edges above — e.g. relying purely on tsconfig `types`/`include` to pull in
// an ambient `.d.ts` that nothing ever imports. None of this monorepo's source uses
// triple-slash directives (verified: no `/// <reference` occurrences under
// `packages/`), and every ambient ".d.ts" the sibling codebase's codegen pipeline
// depends on is reached through a real import somewhere in the closure — so
// this gap is real but doesn't currently cost precision for this package's
// own callers. Flagged here rather than silently assumed away; extending the
// walk to also follow `sourceFile.referencedFiles`/`typeReferenceDirectives`
// (both public `FileReference[]` fields, resolvable via
// `ts.resolveTypeReferenceDirective`) is straightforward future work if a
// caller's project ever depends on triple-slash-only reachability.

import * as path from "node:path";
import ts from "typescript";
import { isTsBuiltinLibFile } from "./cache.ts";

/** `ts.SourceFile.imports` isn't declared on the public `SourceFile`
 * interface in this TypeScript version, but is populated by the parser at
 * runtime (verified against the pinned 6.0.3) — see this module's doc above.
 * Narrow, single-purpose cast kept in one place so an eventual TypeScript
 * upgrade that removes or renames the field fails here (empty specifier
 * list -> empty closures -> every entry's cache permanently misses, loudly
 * visible as "always rebuilds") rather than silently miscompiling elsewhere. */
function moduleSpecifiersOf(sourceFile: ts.SourceFile): readonly string[] {
  const withImports = sourceFile as unknown as { imports?: readonly ts.StringLiteralLike[] };
  return (withImports.imports ?? []).map((specifier) => specifier.text);
}

/** Resolve every module specifier `sourceFile` references to an absolute
 * source-file path, via the same public `ts.resolveModuleName` resolver
 * TypeScript's own Program construction uses. Resolution failures (ambient
 * modules, non-TS assets) are skipped, not thrown — they cannot be graph
 * edges to another source file if resolution names none. */
function directDependenciesOf(
  sourceFile: ts.SourceFile,
  compilerOptions: ts.CompilerOptions,
  moduleCache: ts.ModuleResolutionCache,
): readonly string[] {
  const deps: string[] = [];
  for (const specifier of moduleSpecifiersOf(sourceFile)) {
    const resolved = ts.resolveModuleName(
      specifier,
      sourceFile.fileName,
      compilerOptions,
      ts.sys,
      moduleCache,
    );
    const resolvedFileName = resolved.resolvedModule?.resolvedFileName;
    if (resolvedFileName !== undefined) deps.push(path.resolve(resolvedFileName));
  }
  return deps;
}

/**
 * Compute each of `entryFiles`' own transitive module-graph closure (the
 * entry file itself plus every source file reachable from it via
 * import/export/dynamic-import/require, transitively) from `program` —
 * whether `program` is a fresh single-root Program (in which case the
 * closure is `program.getSourceFiles()`, computed here just as cheaply) or,
 * the case this function exists for, one shared multi-root Program spanning
 * many entries.
 *
 * Returns a map from each entry's resolved absolute path (`path.resolve`,
 * matching cache.ts's own `entryFile` normalization convention) to the set
 * of resolved absolute paths in its closure. TypeScript's own bundled
 * `lib.*.d.ts` files are excluded from every closure (mirrors cache.ts's
 * `writeCacheMetadata`, which has always excluded them — see
 * `isTsBuiltinLibFile`'s doc comment) since the toolchain-version signal
 * already covers them as one check, not a per-file one.
 *
 * The module graph is walked once, globally memoized by file path, and
 * every entry's closure is a BFS over that shared memo — see this module's
 * doc comment for why that keeps the total cost O(files in the union
 * closure) rather than O(entries × files).
 */
export function computeEntryClosures(
  entryFiles: readonly string[],
  program: ts.Program,
): ReadonlyMap<string, ReadonlySet<string>> {
  const compilerOptions = program.getCompilerOptions();
  const moduleCache = ts.createModuleResolutionCache(
    program.getCurrentDirectory(),
    (fileName) => fileName,
    compilerOptions,
  );

  const byPath = new Map<string, ts.SourceFile>();
  for (const sourceFile of program.getSourceFiles()) {
    byPath.set(path.resolve(sourceFile.fileName), sourceFile);
  }

  // Direct-dependency memo, shared across every entry's BFS below — a file
  // imported by more than one entry (or reached at more than one depth
  // within one entry's own graph) has its specifiers resolved exactly once.
  const directDepsMemo = new Map<string, readonly string[]>();
  function directDeps(resolvedPath: string): readonly string[] {
    const cached = directDepsMemo.get(resolvedPath);
    if (cached !== undefined) return cached;
    const sourceFile = byPath.get(resolvedPath);
    const deps =
      sourceFile === undefined
        ? []
        : directDependenciesOf(sourceFile, compilerOptions, moduleCache);
    directDepsMemo.set(resolvedPath, deps);
    return deps;
  }

  const closures = new Map<string, ReadonlySet<string>>();
  for (const entryFile of entryFiles) {
    const resolvedEntry = path.resolve(entryFile);
    const closure = new Set<string>();
    const stack = [resolvedEntry];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (closure.has(current) || isTsBuiltinLibFile(current)) continue;
      closure.add(current);
      for (const dep of directDeps(current)) {
        if (!closure.has(dep)) stack.push(dep);
      }
    }
    closures.set(resolvedEntry, closure);
  }
  return closures;
}

/**
 * Given `closures` (as returned by `computeEntryClosures`) and one
 * `touchedFile`, return the set of entry-file paths (resolved, matching
 * `closures`' own keys) whose closure actually reaches it — the
 * touched-file -> affected-entry mapping a batch caller's invalidation
 * decision reduces to: an entry not in the returned set provably cannot
 * have its extraction output change from this file's edit, since nothing it
 * reads transitively includes it.
 */
export function affectedEntries(
  closures: ReadonlyMap<string, ReadonlySet<string>>,
  touchedFile: string,
): ReadonlySet<string> {
  const resolvedTouched = path.resolve(touchedFile);
  const affected = new Set<string>();
  for (const [entry, closure] of closures) {
    if (closure.has(resolvedTouched)) affected.add(entry);
  }
  return affected;
}
