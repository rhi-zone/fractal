// tooling/derivable-comments/cli.ts
//
// `bun tooling/derivable-comments/cli.ts [path ...]` — walks the repo (or the
// given paths) and reports comments whose content is mechanically
// recoverable from the declaration they sit above, a hardcoded count, a repo
// path cross-reference, or pure banner decoration. See checks.ts for what
// each of the five checks does and doesn't claim.
//
// This is a report-only tool: it never edits files, never exits nonzero (see
// bottom of this file for why), and isn't wired into any hook or CI job.
// It's meant to be run by a person and read, the same way `oxlint` output is
// read before anyone decides whether to act on it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { extractComments, isSourceFile } from "./extract.ts";
import { runChecks, type CheckId, type Finding } from "./checks.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

// Same exclusion list the old comment-approval tool used: dependency trees,
// build output, VCS/tool state, Nix's direnv cache, and codegen output
// (comments there are whatever the generator template says, not authored
// prose worth reviewing).
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".git", ".direnv", "generated"]);

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function resolveTargets(args: string[]): string[] {
  const roots = args.length > 0 ? args.map((a) => path.resolve(REPO_ROOT, a)) : [REPO_ROOT];
  const out: string[] = [];
  for (const root of roots) {
    const st = statSync(root);
    if (st.isDirectory()) walkSourceFiles(root, out);
    else if (isSourceFile(root)) out.push(root);
  }
  return out;
}

function existsRelPath(relPath: string): boolean {
  return existsSync(path.join(REPO_ROOT, relPath));
}

const CHECK_LABEL: Record<CheckId, string> = {
  "param-restatement": "param-restatement",
  "signature-restatement": "signature-restatement",
  "rotting-count": "rotting-count",
  "path-reference": "path-reference",
  decoration: "decoration",
};

function main() {
  const args = process.argv.slice(2);
  const files = resolveTargets(args);

  const byCheck: Record<CheckId, number> = {
    "param-restatement": 0,
    "signature-restatement": 0,
    "rotting-count": 0,
    "path-reference": 0,
    decoration: 0,
  };
  let total = 0;
  let filesWithFindings = 0;

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    let comments;
    try {
      comments = extractComments(text, file);
    } catch (err) {
      console.error(
        `skip ${path.relative(REPO_ROOT, file)}: parse error: ${(err as Error).message}`,
      );
      continue;
    }
    const selfPath = path.relative(REPO_ROOT, file);
    const findings: { comment: (typeof comments)[number]; finding: Finding }[] = [];
    for (const comment of comments) {
      for (const finding of runChecks(comment, existsRelPath, selfPath)) {
        findings.push({ comment, finding });
      }
    }
    if (findings.length === 0) continue;
    filesWithFindings++;
    console.log(path.relative(REPO_ROOT, file));
    for (const { comment, finding } of findings) {
      byCheck[finding.check]++;
      total++;
      const line = comment.line + finding.lineOffset;
      console.log(`  ${line}:  [${CHECK_LABEL[finding.check]}]  ${finding.reason}`);
      console.log(`      ${finding.excerpt}`);
    }
    console.log("");
  }

  console.log(`${total} finding(s) in ${filesWithFindings} file(s) (${files.length} scanned)`);
  for (const id of Object.keys(byCheck) as CheckId[]) {
    if (byCheck[id] > 0) console.log(`  ${CHECK_LABEL[id]}: ${byCheck[id]}`);
  }
}

// Always exits 0. This is a report, not a gate — nothing calls this tool
// expecting a pass/fail signal, and it isn't wired into pre-commit or CI.
// Whether/how to gate on it is an open decision, not baked in here.
main();
