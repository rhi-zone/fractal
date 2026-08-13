# Comment approval

A content-hash gate on comments: every `//`/`/* */` comment in the codebase either has
its content-hash in `approved-comments.json` (a human read it and stands behind the
wording) or it doesn't (new, or changed since it was last approved). This is the
mechanism, not a one-time cleanup pass — it's meant to REPLACE periodic manual/AI review
sweeps of "are the comments in this codebase still good," by making that review happen
continuously, gated at commit/CI time, instead of on a schedule.

## Why hash-based, and why content, not position

Comments move around constantly as the code above/below them is edited — that's normal
churn and shouldn't force re-review. Hashing the comment's own text (not its file/line)
means a comment keeps its approval when it moves, and loses it the instant its wording
actually changes. Position is deliberately not part of identity.

## What counts as a comment

`//` line comments and `/* */` block comments (JSDoc `/** */` is syntactically a block
comment — no special-casing needed) in `.ts`/`.tsx`/`.js`/`.jsx`/`.mts`/`.cts`/`.mjs`/`.cjs`
files. Not extracted: shebang lines (a directive, not prose) and anything inside a
string/template/regex literal.

Extraction (`comments.ts`) walks a real parsed TypeScript AST
(`ts.createSourceFile` + `ts.get{Leading,Trailing}CommentRanges`) rather than a
regex/state-machine over `//`/`/*`/`*/`. A regex approach has to separately reimplement
string/template/regex-literal awareness to avoid treating `"// not a comment"` or a regex
literal containing `/*` as a comment — a real parser already resolves that correctly (it's
inherently a parsing decision: whether `/` starts a regex or is division depends on
whether an expression is expected at that position). `typescript` is already a root
devDependency, so this adds no new dependency.

A contiguous run of `//` lines at the same indentation, with no blank/code line between
them, is merged into ONE logical comment — matching how a person reads a `//` paragraph,
and how a `/* */` block already behaves as a single unit. Without this, a 10-line `//`
paragraph (common in this codebase's design-rationale comments) would hash as ten
independent one-liners: noisier to review, noisier in the manifest, and a poor match for
how these comments actually get read and judged.

## Normalization

Before hashing, a comment's delimiters are stripped, JSDoc `*`-continuation decoration is
stripped, and each line is trimmed — so pure reformatting (a formatter changing
indentation, realigning JSDoc `*`s) doesn't invalidate approval. Internal wording,
punctuation, and mid-comment blank lines are left alone: those are content, and changing
them is exactly what should force re-review. See `normalizeComment` in `comments.ts` for
the precise rules and `comments.test.ts` for the cases this is checked against.

## The manifest — `approved-comments.json`

```json
{
  "version": 1,
  "approved": {
    "<sha256 hex>": { "excerpt": "first ~80 chars, for humans skimming a diff", "approvedAt": "<ISO date>" }
  }
}
```

Keys are sorted on write so re-running `approve` on an unchanged scope produces a
byte-identical file — the manifest is meant to be read in diffs (`git diff` on this file
shows exactly which comments got approved in a change, hash-and-excerpt visible without
needing to also read the source). `excerpt`/`approvedAt` are audit trail only; the check
logic only ever looks at the hash keys.

## CLI

```sh
bun tooling/comment-approval/cli.ts check [--all|--staged|--diff-base <ref>|<files...>]
bun tooling/comment-approval/cli.ts approve <--all|--staged|--diff-base <ref>|<files...>>

# equivalently, from the repo root:
bun run comments:check [-- --staged|...]
bun run comments:approve -- <files...>
```

`check` exits non-zero (and prints each unapproved comment's file:line, hash prefix, and
first line, plus a copy-pasteable `approve` command scoped to exactly the affected files)
if anything in scope has an unapproved hash. `approve` computes hashes for everything in
scope and adds them to the manifest — it does not filter by "already reviewed"; approving
is the human's attestation that they've read the current wording, so run it after reading,
not before.

## Bootstrap: why the existing backlog starts UNAPPROVED, not bulk-approved

This codebase already has a lot of comments, and a meaningful fraction of them are the
rambly, chain-of-thought-flavored kind this tool exists to catch. Two ways to bring the
gate online: bulk-approve everything as of the day this landed (smooth adoption, gate only
bites on new/changed comments going forward), or leave the whole backlog unapproved (the
gate immediately has ~6,500 findings across the repo, but ONLY for files someone actually
touches — see the scoping rationale below).

**Chosen: leave it unapproved.** Bulk-approving would rubber-stamp exactly the comments
this tool exists to force review of — the manifest would claim "a human stands behind
this wording" for thousands of comments nobody actually re-read at landing time, which is
worse than having no manifest at all (a false attestation, not just a missing one). It
would also erase the backlog as a visible signal: once approved, a rambly comment looks
identical to a good one until someone happens to touch that file again with fresh eyes and
notices.

Leaving it unapproved only works because of the scoping choice below (file-scoped, not
whole-repo) — see that section for why day-one adoption doesn't mean this blocks unrelated
work across ~6,500 pre-existing findings.

## Why the gate is scoped to touched FILES, not the whole repo

Two ways to decide what a commit/PR's check covers: every comment in the whole repository
(unconditional, would immediately fail on the entire unapproved backlog above, blocking
essentially any commit the day this lands), or only comments in files the change actually
touches (a comment three files away from your diff never blocks you).

**Chosen: file-scoped** — `--staged` (pre-commit hook) and `--diff-base <ref>` (CI) both
resolve to "files that differ between two git states," then check every comment in THOSE
files (not just the lines that changed within them — hash-based identity already means an
untouched comment elsewhere in the same file is silently fine either way, so checking the
whole file costs nothing extra and avoids the complexity of correlating diff hunks with
comment ranges). Combined with the bootstrap choice above, this is what makes "leave
everything unapproved" viable on day one: nothing is blocked until you touch it, at which
point you're asked to have looked at what's already there in that file — a natural,
incremental path to working down the backlog as code is touched anyway, which is the
literal alternative to a scheduled sweep this tool exists to be.

A whole-repo report is still available on demand (`check --all`, or the CI job's default
if invoked without `--diff-base`) for anyone who wants current backlog size/visibility —
this is explicitly NOT wired into any blocking gate; it's a status view, not a recurring
gate.

## Wiring

- **Git hook** — `.githooks/pre-commit` (this repo's `core.hooksPath`, see `.git/config` —
  distinct from `tooling/claude-hooks/`, which hooks the Claude Code harness's own tool
  calls, not git). Runs `check --staged`, blocks the commit on any finding. No
  `--no-verify` escape hatch is sanctioned (`CLAUDE.md`); the fix is fast — read the
  flagged comment(s), then fix the wording or run the printed `approve` command.
- **CI** — `.github/workflows/ci.yml`'s `check` job: a "Determine comment-approval diff
  base" step resolves the PR base SHA (`pull_request` events) or the pre-push SHA (`push`
  events, skipped on a branch's first push, where there's no prior commit to diff
  against), then `check --diff-base <sha>` runs the same file-scoped check CI-side as a
  backstop for anyone who committed without the hook active (fresh clone before
  `core.hooksPath` took effect, a commit made through the GitHub UI, etc.). Needs
  `fetch-depth: 0` on checkout so the base commit is actually present to diff against.
- **Lint rule** — not wired as one today: this repo has no ESLint (or other lint-runner)
  config to plug into (checked; none exists). If one is ever adopted, wrapping this as a
  custom rule is a thin shim: `extractComments`/`isApproved` (already pure, filesystem-
  and git-free) are exactly the two calls a rule's `visitor` would need — report a finding
  per comment whose hash isn't in the loaded manifest. Not built speculatively here since
  there'd be nothing to run it.

## Tests

`comments.test.ts` (extraction correctness — including the string/regex/template
false-positive cases and the line-comment-grouping behavior) and `manifest.test.ts`
(load/save/round-trip/approve semantics). Run directly (not a workspace package, so
`bun run test` at the repo root doesn't reach it):

```sh
bun test tooling/comment-approval
```

CI runs this as its own step for the same reason `compile-check.test.ts` gets its own
named CI step elsewhere in this repo: a regression here should show up distinctly, not
buried in an unrelated step's output.
