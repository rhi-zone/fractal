# Pre-release / RC workflow — splitting expensive verification out of regular CI

## Status

Proposal for review, not implemented. Nothing in this document is wired
into `.github/workflows/` — no new workflow file, no trigger, no job. The
project owner asked for a design pass covering (1) what today's CI actually
costs, (2) whether anything was previously cut from CI for being slow rather
than for having stopped being useful, and (3) what a new pre-release/RC
workflow would contain if one were built — scoped repo-wide, not just for
the docgen "verify against the real target tool" case that prompted the
request (`docs/roadmap.md`'s "Candidate 'basics' bars" §803, bar **(C)**).
The exact scope is explicitly left open below for the project owner to
choose; where this doc lays out options it does not pick a favorite.

## 1. Git history: nothing was removed from CI

`git log -p --follow -- .github/workflows/ci.yml` (full history, 4 commits:
`0a679f2` scaffold → `bb38011` add CI → `ab7cf8f` add compile-check →
`4575b1d` add build-packages) and `git log --diff-filter=D --all --
.github/workflows/` (workflow-file deletions, repo-wide) both come back
empty of removals. Every change to `ci.yml` across its history has been
additive — steps and jobs were added, moved, or renamed (e.g. `oven-sh/
setup-bun@v2` → `nix develop --command bun ...`), but nothing was deleted.

This means the premise "something used to run in CI and got cut for being
too slow" does **not** hold for this repo — there is no historical
casualty to reinstate. The roadmap's bar-(C) doc-tooling verification
(`docs/roadmap.md` §851-864) was never implemented at all, let alone cut;
it's a forward-looking option the project owner has explicitly not decided
to build, and separately has said should not land in regular CI once it
is built. The scoping question here is therefore purely forward-looking:
what to build directly into the pre-release workflow rather than regular
CI, and what existing regular-CI cost (see §2) might also belong there.

## 2. What's actually expensive in CI today

`.github/workflows/ci.yml` has two jobs, `check` and `build-packages`, both
`push: [master]` + `pull_request: [master]` (every push, every PR).

### `check` job step costs (approximate, from recent run history)

Sampled via `gh run list`/`gh run view` against the last ~30 `CI` runs
(2026-07-25 through 2026-08-05; note the sample is almost entirely
`failure` conclusions — CI has been red on master for most of this window,
so no recent full-green run exists to sample a clean total from):

- Runs that fail during `Typecheck` or early in `Test`: ~170-280s total.
- Runs that fail deeper into `Test` (i.e. get further before failing):
  routinely **1080-1200s (~18-20 min)** before failure, all still inside
  the `Test` step — `Compile-check generated code` and `Build playground`
  show as `skipped` in every sampled run because `Test` never finished
  successfully.

That ~19-minute `Test`-step cost is not test-suite breadth alone. It
includes `packages/type-ir`'s `compile-check.test.ts` — the file the
`Compile-check generated code` step (see below) also runs — because
`type-ir/package.json`'s `test` script is plain `bun test`, which picks up
every `*.test.ts` in the package, and `bun run --filter '*' test` at the
workspace root runs that script for every package. So today, the real-
compiler check already runs **twice** per CI invocation: once implicitly
inside the general `Test` step, once explicitly and redundantly as its own
named `Compile-check generated code` step (the latter's comment in
`ci.yml` even says it's "already covered by `bun run test` above" and is
broken out only so a regression is visually distinct in the Actions log).

`compile-check.test.ts` shells out to real compilers/checkers for ~15
target languages (tsc, go, cargo, swiftc, ghc, dotnet, g++, crystal, ruby,
php, protoc, capnp, flatc, clang+GNUstep, flow) against a full Nix devShell,
plus needs network access (cargo/rustc resolving `serde`/`serde_json` from
crates.io; a `nix eval` looking up `nlohmann_json`'s store path). This is
the same shape of cost the docgen bar-(C) proposal would add for doc-site
tooling (`docusaurus build`, `mkdocs build --strict`, etc.) — an ingestion/
projection-agnostic "run the real ecosystem tool" pattern already present
in-repo for code-level generation, not yet present for doc-site generation.

Other `check`-job steps are comparatively cheap: `Typecheck` (`tsc
--noEmit` per package), `Install dependencies`, `Build playground` (single
Vite build, currently unreached in every sampled failing run so its actual
cost is unmeasured here).

### `build-packages` job

`tsc -b tsconfig.build.json` project-reference build across all 8
publishable packages. No real-run timing sample exists for this job
either (same reason — no clean recent run to measure against), and nothing
in its `ci.yml` comment or design docs flags it as intentionally scoped
down for speed; it reads as ordinary build verification, not a candidate
for this proposal, but is named here as a data point rather than asserted
settled given the lack of a timing sample.

### `deploy-docs.yml`

Separate workflow, path-filtered to `docs/**` and `packages/playground/**`
pushes to `master` plus `workflow_dispatch`. Builds the VitePress docs site
and the playground, deploys to GitHub Pages. Not part of the `CI` workflow
and not evaluated here as a pre-release candidate — it's a deploy action,
not a verification gate, and nothing in this investigation suggests it's
slow enough to matter.

## 3. Candidates that fit "verify against the real target tool" shape, repo-wide

Per the project owner's ask to look past docgen specifically, three things
surfaced that share the same cost shape (spin up a real external toolchain,
possibly with network access, to verify output beyond structural/type
checks) rather than the shape of a normal unit test:

1. **`compile-check.test.ts` (exists today, in regular CI).** Real-compiler
   verification for ~15 general-purpose-language projectors. Currently
   the single most expensive thing in the `check` job (§2), and runs
   twice per invocation. This is the *already-built* version of the same
   pattern the docgen bar-(C) proposal would add for doc-site tooling —
   `docs/roadmap.md` §851-859 explicitly frames bar-(C) as "the same shape
   of verification this roadmap's 'Testing & Quality' section already
   proposes for the code-level projectors... applying it to doc projectors
   would extend an already-chosen pattern rather than introduce a new
   one." Whether this existing step should now move out of regular CI (to
   match where the project owner wants its doc-projector sibling to live)
   or stay, given it's already accepted and shipped, is an open call —
   see §5.
2. **Doc-site bar-(C) verification (not yet built).** `docusaurus build`,
   `mkdocs build --strict`, `sphinx-build`, etc. against generated output
   for all 25 doc-generation targets (`docs/roadmap.md` §851-864). This is
   the case the project owner named directly as something to keep out of
   regular CI. Needs each target ecosystem's doc-site tooling installed —
   a new dependency footprint per target, not yet present in `flake.nix`
   (which currently carries source/code-language toolchains, not doc-site
   generators).
3. **Battle-testing against real-world corpora (not yet built).**
   `docs/roadmap.md` §976-996 ("Battle testing") names this as "a distinct,
   larger category of open work, not yet started": round-trip testing
   against real OpenAPI/JSON-Schema/`.proto`/etc. corpora pulled from
   APIs.guru/SchemaStore/googleapis, and parser fuzz testing at a scale
   beyond the existing property-based JSON-inference fuzzing. Same shape
   as the other two — pulls in external data/time cost disproportionate to
   a fast per-push signal — even though it doesn't shell out to a third-
   party toolchain the way (1) and (2) do.

Nothing else surfaced in this pass (typecheck, the existing unit/smoke
test suites, the playground build, `build-packages`) reads as
disproportionately expensive or as verifying against a real external tool;
those look like ordinary fast-feedback CI content and aren't proposed for
the move.

## 4. Proposed shape of a pre-release/RC workflow

A new workflow (name TBD — not proposed here, per this repo's CLAUDE.md
"no suggesting project names" convention extended to avoid presupposing a
name for something the project owner should name) that runs the items from
§3 the project owner chooses to include, separately from `ci.yml`.

### Trigger options (tradeoffs, no recommendation)

- **Tag push** (e.g. any tag matching a version pattern). Ties the
  expensive run to an actual release candidate artifact. Requires the repo
  to adopt a tagging convention it doesn't have yet (`git tag -l` is
  currently empty — no tags exist in this repo at all). Natural fit if/
  when npm publishing (currently hard-blocked pending manual owner
  approval, per `TODO.md`) becomes real, since a tag is a natural
  pre-publish gate.
- **Manual `workflow_dispatch`.** Zero convention required, works today,
  puts the decision of "run the expensive stuff now" entirely in the
  project owner's hands (matches `deploy-docs.yml`'s existing
  `workflow_dispatch` for redeploys). Cost: relies on someone remembering
  to click it before a release; nothing enforces it ran.
- **Release branch** (e.g. a `release/*` branch pattern). Matches
  workflows that batch multiple pending changes before a cut; the repo
  doesn't currently have any branch other than `master`, so this would be
  a new branching convention, not a rename of existing practice.
- **Combination.** These aren't mutually exclusive — e.g.
  `workflow_dispatch` for on-demand runs plus a tag-push trigger once
  tagging exists, the way many projects run RC workflows both manually and
  automatically once a release process matures.

Given the repo currently has no tags and no branch other than `master`,
`workflow_dispatch` is the only option that requires no new convention to
adopt before it could be wired up — noted as a fact about the repo's
current state, not a recommendation among the options above.

### What would move vs. stay (pending §3/§5 decisions)

| Item | Today | Proposed |
|---|---|---|
| Typecheck | `ci.yml` `check` job | stays in regular CI |
| Unit/property/smoke test suites (excl. compile-check) | `ci.yml` `check` job | stays in regular CI |
| Playground build | `ci.yml` `check` job | stays in regular CI |
| `build-packages` (tsc -b, 8 packages) | `ci.yml` `build-packages` job | stays in regular CI (no expensive-cost evidence found, §2) |
| `compile-check.test.ts` (real-compiler, ~15 languages) | `ci.yml` `check` job, runs twice | open — candidate to move, see §5 |
| Doc-site bar-(C) real-tool verification | not built | proposed pre-release-only |
| Battle-testing / real-world corpora | not built | proposed pre-release-only |

## 5. Open questions for the project owner

- **Does `compile-check.test.ts` move out of regular CI, or stay?** It's
  already shipped and accepted at its current cost; moving it would make
  regular CI meaningfully faster (§2's ~19-minute `Test` step is largely
  this) but would also mean a broken real-compiler check on a target
  language wouldn't surface until the pre-release run, no longer on every
  push/PR. Orthogonal fix available either way: collapsing the duplicate
  run (`Test` step already covers it; the separate `Compile-check
  generated code` step is redundant per its own comment) recovers some
  time in regular CI regardless of the move decision.
- **What triggers the new workflow** — tag push, manual dispatch, release
  branch, or a combination (§4)? Depends in part on whether/when the
  npm-publish hard-block (`TODO.md`) lifts, since a tag-based trigger reads
  most naturally paired with an actual publish step.
- **Does doc-site bar-(C) verification get built into the pre-release
  workflow directly, or built first as a normal (but pre-release-scoped)
  test file the workflow then runs** — mirroring how `compile-check.
  test.ts` is a normal `bun test` file that regular CI happens to invoke,
  vs. being bespoke workflow-only logic? Affects whether it's exercisable
  locally via `nix develop --command bun test` the same way compile-check
  is today.
- **Does battle-testing (§3.3) belong in this same pre-release workflow,
  a separate scheduled workflow (e.g. nightly against live corpora), or
  stay a manual/local-only activity** given it pulls external corpora
  rather than shelling out to a fixed toolchain? Not resolved here — named
  as in-scope for "repo-wide, same shape" per the project owner's framing,
  but its trigger cadence may reasonably differ from tag/dispatch/release-
  branch (e.g. it could run on a schedule instead, independent of any
  release event).
