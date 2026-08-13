// tooling/comment-approval/cli.ts
//
// CLI entry point: `bun tooling/comment-approval/cli.ts <check|approve> [...]`.
// Owns file discovery (walking the repo / asking git for staged or changed
// files) and manifest I/O; hashing/extraction logic itself lives in
// comments.ts so it stays testable without touching the filesystem or git.
//
// See tooling/comment-approval/README.md for the full design writeup
// (scope, hash semantics, bootstrap strategy, hook/CI wiring).

import { readdir } from "node:fs/promises";
import path from "node:path";
import { extractComments, isSourceFile, type ExtractedComment } from "./comments.ts";
import {
  approveComments,
  isApproved,
  loadManifest,
  saveManifest,
  type Manifest,
} from "./manifest.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const MANIFEST_PATH = path.join(import.meta.dir, "approved-comments.json");

// Directories never worth scanning: dependency trees, build output, VCS/tool
// state, and Nix's direnv cache. `generated` catches codegen output (e.g.
// examples/library-api/src/generated/) — comments in generated code aren't
// authored prose to review, they're whatever the generator template says,
// and re-running codegen would just re-flag them.
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".git", ".direnv", "generated"]);

async function walkSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSourceFiles(full, out);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function gitFiles(args: string[]): Promise<string[]> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isSourceFile(line))
    .map((relPath) => path.join(REPO_ROOT, relPath));
}

async function stagedFiles(): Promise<string[]> {
  return gitFiles(["diff", "--cached", "--name-only", "--diff-filter=ACM"]);
}

/** Files that differ between `base` and the working tree — deliberately
 *  compares against the working tree (no ref on the right side), not
 *  `base...HEAD`, so this also works uncommitted (pre-commit hook context)
 *  and mid-PR (CI, where HEAD already includes range of commits). */
async function changedFiles(base: string): Promise<string[]> {
  return gitFiles(["diff", `${base}`, "--name-only", "--diff-filter=ACM"]);
}

interface Unapproved {
  readonly file: string;
  readonly comment: ExtractedComment;
}

async function findUnapproved(files: readonly string[], manifest: Manifest): Promise<Unapproved[]> {
  const out: Unapproved[] = [];
  for (const file of files) {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) continue; // deleted-then-diffed, nothing to check
    const text = await bunFile.text();
    const comments = await extractComments(text, file);
    for (const comment of comments) {
      if (!isApproved(manifest, comment.hash)) out.push({ file, comment });
    }
  }
  return out;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file);
}

function printUnapproved(unapproved: readonly Unapproved[]): void {
  for (const { file, comment } of unapproved) {
    const preview = comment.normalized.split("\n")[0] ?? "(empty)";
    console.log(`  ${relative(file)}:${comment.line}  ${comment.hash.slice(0, 12)}  ${preview}`);
  }
}

async function resolveScopeFiles(scope: string, scopeArg: string | undefined): Promise<string[]> {
  switch (scope) {
    case "--all":
      return walkSourceFiles(REPO_ROOT);
    case "--staged":
      return stagedFiles();
    case "--diff-base":
      if (!scopeArg) throw new Error("--diff-base requires a git ref argument");
      return changedFiles(scopeArg);
    default:
      throw new Error(`unknown scope flag: ${scope}`);
  }
}

async function cmdCheck(args: string[]): Promise<number> {
  const [flag, flagArg, ...rest] = args;
  const explicitFiles =
    flag && !flag.startsWith("--")
      ? [flag, flagArg, ...rest].filter((f): f is string => Boolean(f))
      : undefined;

  const files = explicitFiles
    ? explicitFiles.filter(isSourceFile).map((f) => path.resolve(REPO_ROOT, f))
    : await resolveScopeFiles(flag ?? "--all", flagArg);

  const manifest = await loadManifest(MANIFEST_PATH);
  const unapproved = await findUnapproved(files, manifest);

  if (unapproved.length === 0) {
    console.log(`comment-approval: ${files.length} file(s) scanned, all comments approved`);
    return 0;
  }

  console.log(
    `comment-approval: ${unapproved.length} unapproved comment(s) in ${files.length} scanned file(s):\n`,
  );
  printUnapproved(unapproved);
  // Suggest approving exactly the affected files, by name — never a blanket
  // `--all`/`--staged` passthrough, even though that's what the user just
  // ran to get here. The whole point of this tool is that approval means a
  // human read the comment; a copy-pasteable command that bulk-approves
  // everything in scope (most dangerously under --all, which today would
  // rubber-stamp the entire pre-existing backlog — see bootstrap note in
  // the README) would train people into rubber-stamping instead.
  const affectedFiles = [...new Set(unapproved.map((u) => relative(u.file)))];
  console.log(
    `\nEither fix these comments so they say what they should, or — once you've read and\n` +
      `stand behind the current wording — approve them:\n\n` +
      `  bun tooling/comment-approval/cli.ts approve ${affectedFiles.join(" ")}\n`,
  );
  return 1;
}

async function cmdApprove(args: string[]): Promise<number> {
  const [flag, flagArg, ...rest] = args;
  if (!flag) {
    console.error(
      "usage: bun tooling/comment-approval/cli.ts approve <--all|--staged|--diff-base <ref>|<files...>>",
    );
    return 1;
  }
  const explicitFiles = !flag.startsWith("--")
    ? [flag, flagArg, ...rest].filter((f): f is string => Boolean(f))
    : undefined;

  const files = explicitFiles
    ? explicitFiles.filter(isSourceFile).map((f) => path.resolve(REPO_ROOT, f))
    : await resolveScopeFiles(flag, flagArg);

  let manifest = await loadManifest(MANIFEST_PATH);
  let total = 0;
  for (const file of files) {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) continue;
    const text = await bunFile.text();
    const comments = await extractComments(text, file);
    manifest = approveComments(manifest, comments);
    total += comments.length;
  }
  await saveManifest(MANIFEST_PATH, manifest);
  console.log(
    `comment-approval: approved ${total} comment(s) across ${files.length} file(s) (manifest now has ${Object.keys(manifest.approved).length} approved hash(es))`,
  );
  return 0;
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case "check":
      process.exit(await cmdCheck(rest));
      break;
    case "approve":
      process.exit(await cmdApprove(rest));
      break;
    default:
      console.error(
        "usage:\n" +
          "  bun tooling/comment-approval/cli.ts check   [--all|--staged|--diff-base <ref>|<files...>]  (default: --all)\n" +
          "  bun tooling/comment-approval/cli.ts approve <--all|--staged|--diff-base <ref>|<files...>>\n",
      );
      process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
