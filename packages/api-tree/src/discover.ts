// Autodetection: a library-level replacement for a hand-maintained
// per-consumer entry-file list.
//
// The pain point this exists to kill: a consumer of `buildWireApplyValidationModuleSource`
// (apply-validation-build.ts) that needs to batch-generate validators across many entry files
// (e.g. the sibling codebase's `apps/web/scripts/codegen-fractal-validators.ts`, one
// entry file per domain slice) has historically hand-maintained a literal
// array of entry-file paths. A new file dropped under the deployment's
// source tree silently gets no validators until someone remembers to add it
// to the list — exactly the class of silent-gap failure `wrapValidators`'s
// own loud-by-default rewrite (build.ts) exists to kill, just one step
// earlier in the pipeline (finding the entry files at all, before any of
// them are even extracted).
//
// The design: recursively scan one or more `roots` for candidate source
// files (the recursive walk itself is the implicit `**/*` glob — no
// separate glob-syntax parser needed), then keep exactly the candidates
// `hasTreeExport` (tree.ts) says actually export an `api()`/`op()` tree at
// their top level. A file dropped anywhere under a scanned root is picked
// up automatically on the next run — no list to remember to update.
//
// `exclude`/`include` are the deliberate, visible escape hatches for the
// cases autodetection alone can't (or shouldn't) resolve on its own:
//   - `exclude` removes an autodetected false positive (a file that
//     genuinely has a tree export, but the consumer wants skipped anyway —
//     e.g. a vacuous/example extraction file).
//   - `include` force-adds a file regardless of what `hasTreeExport` said —
//     either a genuine miss (an export shape detection doesn't recognize)
//     or a hand-pinned entry a consumer wants included on purpose. A
//     `string` include can reach any file (not just one under `roots`) and
//     throws if it doesn't exist — loud, not silent, matching the spirit of
//     `wrapValidators`'s own rewrite: a caller who names a path expects it
//     to be used, and a typo'd override silently doing nothing is exactly
//     the failure class both fixes exist to kill. A `RegExp` include can
//     only select among files the directory scan already found under
//     `roots` (it re-adds a candidate `exclude` removed, or one
//     `hasTreeExport` rejected) — it is not a way to reach outside `roots`
//     entirely, only a literal string can do that.
//   - `include` is applied after `exclude`, so an explicit include always
//     wins over an exclude on the same file — the override is visible in
//     the caller's own options object, not a silent ordering accident.

import * as fs from "node:fs";
import * as path from "node:path";
import type ts from "typescript";
import { createExtractorProgram, groupEntryFilesByConfig } from "./extract.ts";
import { hasTreeExport } from "./tree.ts";

/**
 * One matcher against a candidate's absolute path. A `string` is an exact
 * literal match — the caller must pass what they mean (an absolute path, or
 * one they intend to resolve against `process.cwd()`, see `findEntryFiles`'s
 * doc); there is no implicit relative-to-`roots` resolution magic. A
 * `RegExp` is tested against the candidate's POSIX-normalized absolute path
 * — this is the "grep-style pattern" support this module offers, a real
 * `RegExp` rather than a hand-rolled glob engine (the recursive directory
 * walk already covers the any-depth-wildcard case; a `RegExp` covers
 * everything finer).
 */
export type PathMatcher = string | RegExp;

/** Options for `findEntryFiles` — see the module doc above for the overall design. */
export type FindEntryFilesOptions = {
  /**
   * One or more directories to scan recursively for candidate entry files.
   * Default skip: any directory named `node_modules`, `dist`, or `.git`,
   * and any dotfile/dotdir (name starting with `.`). Default file filter:
   * `extensions` (below, default `[".ts"]`), always excluding `.d.ts` files
   * and files ending `.test.ts`/`.spec.ts` regardless of `extensions`.
   */
  readonly roots: string | readonly string[];
  /**
   * Matchers that force-add files regardless of `hasTreeExport` autodetection
   * — applied after `exclude`, so an explicit include always wins over an
   * exclude on the same file (the deliberate, visible override). A `string`
   * matcher is a literal path to force in: resolved (relative strings
   * against `process.cwd()`), and throws if the file doesn't exist — a
   * `string` include can reach any file, not just one under `roots`. A
   * `RegExp` matcher is tested against the same scanned-candidate set
   * `exclude` draws from (every file the directory scan under `roots`
   * found, independent of whether `hasTreeExport` accepted or rejected it)
   * — it can only pull in / additionally select among files the scan
   * already found, never reach outside `roots` entirely. `include` does
   * not require `hasTreeExport` to be true for either matcher kind — it's a
   * deliberate bypass of detection, for a file whose export shape detection
   * doesn't recognize, or to hand-pin an entry.
   */
  readonly include?: readonly PathMatcher[];
  /**
   * Matchers applied against the autodetected candidate set (files found by
   * scanning `roots` that also pass `hasTreeExport`) — a match removes that
   * file from the result. Use this for something like a vacuous-extraction
   * file a consumer wants to skip even though it technically has a tree
   * export. See `include` above for the override ordering.
   */
  readonly exclude?: readonly PathMatcher[];
  /** Override the default `[".ts"]` extension filter. `.d.ts` files and
   * `.test.ts`/`.spec.ts` files are always excluded regardless of this. */
  readonly extensions?: readonly string[];
  /**
   * Reuse an already-built `ts.Program` for the `hasTreeExport` detection
   * pass instead of building a fresh one over the scanned candidates —
   * mirrors `buildWireApplyValidationModuleSource`'s own `program` option
   * (apply-validation-build.ts)
   * and the multi-GB-Program-reuse rationale documented there and in
   * `createExtractorProgram`'s own doc comment
   * (`@rhi-zone/fractal-type-ir/from-typescript`): a `ts.Program`'s dominant
   * cost is parsing+binding its transitive import closure, which is nearly
   * the same whether rooted at one file or many siblings under the same
   * project — so a batch caller should build one Program up front and pass
   * it here (and again into `buildWireApplyValidationModuleSource` for the actual
   * codegen pass) rather than paying that cost once per candidate.
   *
   * Only meaningful when every scanned candidate belongs to ONE
   * `tsconfig.json` region — a `ts.Program` has a single `CompilerOptions`
   * bag for all its roots, so there is no such thing as one Program that is
   * correct for candidates spanning two projects (see
   * `createExtractorProgram`'s doc comment). When the scan crosses a region
   * boundary this option is rejected with an error naming the regions,
   * rather than silently applying one project's `paths` to another
   * project's files.
   *
   * If omitted, `findEntryFiles` partitions the candidates itself
   * (`groupEntryFilesByConfig`) and builds one Program per region, one at a
   * time — the common case for a scan rooted at a monorepo, where every
   * package carries its own config.
   */
  readonly program?: ts.Program;
};

/** Directory names always skipped during the recursive scan. */
const SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

/** POSIX-normalize an absolute path for `RegExp` matching (Windows path
 * separators would otherwise make a `RegExp` pattern written with `/`
 * silently never match). */
function toPosix(absPath: string): string {
  return absPath.split(path.sep).join("/");
}

/** True when `name` (a single path segment) should never be descended into
 * / considered — `node_modules`/`dist`/`.git`, or any dotfile/dotdir. */
function isSkippedName(name: string): boolean {
  return SKIPPED_DIR_NAMES.has(name) || name.startsWith(".");
}

/** True when `fileName` (a bare basename) passes the extension/suffix
 * filter — one of `extensions`, but never a `.d.ts`, `.test.ts`, or
 * `.spec.ts` file regardless. */
function matchesExtension(fileName: string, extensions: readonly string[]): boolean {
  if (fileName.endsWith(".d.ts")) return false;
  if (fileName.endsWith(".test.ts") || fileName.endsWith(".spec.ts")) return false;
  return extensions.some((ext) => fileName.endsWith(ext));
}

/** Recursively scan `root` for files passing the skip-dir/extension filters. */
function scanDir(root: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const entries = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (isSkippedName(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...scanDir(full, extensions));
    } else if (entry.isFile() && matchesExtension(entry.name, extensions)) {
      out.push(full);
    }
  }
  return out;
}

/** True when `matcher` matches `absPath` — a `string` matches by exact
 * (resolved) equality, a `RegExp` by `.test()` against the POSIX form. */
function matches(matcher: PathMatcher, absPath: string): boolean {
  if (typeof matcher === "string") return path.resolve(matcher) === absPath;
  return matcher.test(toPosix(absPath));
}

/**
 * Run `hasTreeExport` over every scanned candidate, one `tsconfig.json`
 * region at a time.
 *
 * A directory scan is exactly the batch most likely to cross a project
 * boundary — pointed at a monorepo root, or at two package `src` trees, it
 * collects files whose nearest `tsconfig.json` differ, and in this repo every
 * package's config carries its own `paths` remap over a shared base. Building
 * one Program over all of them (what this used to do) resolved every
 * candidate's imports under whichever project the first candidate happened to
 * belong to, so a candidate from any other package had that project's `paths`
 * applied to it instead of its own.
 *
 * Programs are built and used one region at a time rather than all up front:
 * each is a multi-GB object graph, so holding one per region simultaneously
 * would multiply the peak this whole design exists to keep at a single
 * Program (see `groupEntryFilesByConfig`). Within a region the sharing is
 * unchanged — one Program still serves every candidate under that project,
 * which is where the win actually comes from.
 *
 * Candidate order is preserved across the region loop, so the detected set is
 * ordered by the scan, not by which region a file happened to fall into.
 */
function detectTreeExports(
  candidates: readonly string[],
  sharedProgram: ts.Program | undefined,
): string[] {
  if (candidates.length === 0) return [];

  const groups = groupEntryFilesByConfig(candidates);

  if (sharedProgram !== undefined) {
    if (groups.length > 1) {
      const regions = groups
        .map(
          (g) => `  ${g.configPath ?? "(no tsconfig.json found)"}: ${g.entryFiles.length} file(s)`,
        )
        .join("\n");
      throw new Error(
        `findEntryFiles: options.program was supplied, but the scanned candidates span ` +
          `${groups.length} different tsconfig.json regions — one ts.Program cannot be ` +
          `correct for all of them (see createExtractorProgram). Omit options.program to let ` +
          `findEntryFiles build one Program per region, or narrow "roots" to a single ` +
          `project.\n${regions}`,
      );
    }
    return candidates.filter((f) => hasTreeExport(f, sharedProgram));
  }

  const detected = new Set<string>();
  for (const group of groups) {
    const program = createExtractorProgram(group.entryFiles);
    for (const file of group.entryFiles) {
      if (hasTreeExport(file, program)) detected.add(file);
    }
  }
  return candidates.filter((f) => detected.has(f));
}

/**
 * Autodetect a deployment's `api()`/`op()` tree entry files by recursively
 * scanning `options.roots` and keeping the files `hasTreeExport` (tree.ts)
 * confirms actually export a tree — replacing a hand-maintained per-consumer
 * entry-file list (see the module doc above). Returns absolute paths, sorted
 * for determinism.
 *
 * Steps (see the individual option docs above for the exact rules):
 *   1. Recursively scan `roots` for candidate files.
 *   2. Filter to the ones `hasTreeExport` confirms.
 *   3. Remove any `exclude` match.
 *   4. Add any `include` match (string: resolved literal path, throwing if
 *      missing; RegExp: re-drawn from the full scanned-candidate set) — this
 *      step runs after exclude, so include always wins.
 *   5. Dedupe, sort, return.
 */
export function findEntryFiles(options: FindEntryFilesOptions): string[] {
  const roots = Array.isArray(options.roots) ? options.roots : [options.roots as string];
  const extensions = options.extensions ?? [".ts"];

  const candidates = roots.flatMap((root) => scanDir(path.resolve(root), extensions));

  const autodetected = detectTreeExports(candidates, options.program);

  const excluded = new Set(
    autodetected.filter((f) => (options.exclude ?? []).some((m) => matches(m, f))),
  );
  const selected = new Set(autodetected.filter((f) => !excluded.has(f)));

  for (const matcher of options.include ?? []) {
    if (typeof matcher === "string") {
      const resolved = path.resolve(matcher);
      if (!fs.existsSync(resolved)) {
        throw new Error(`findEntryFiles: include path does not exist: ${resolved}`);
      }
      selected.add(resolved);
    } else {
      for (const f of candidates) {
        if (matcher.test(toPosix(f))) selected.add(f);
      }
    }
  }

  return [...selected].sort();
}
