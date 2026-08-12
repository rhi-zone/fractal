# Framework router codegen — scoping notes

> Pre-implementation scoping document. Captures the idea's shape and the
> architectural fork it raises. Per this project's disposition, options
> that are still genuinely open are laid out with their tradeoffs, not
> ranked; some questions below (package boundary, eject-as-the-model,
> framework scope) have since received a project-owner decision and are
> marked as such where they're recorded.

## The idea

Alongside (or instead of) `http-api-projector`'s own router output — the
`HttpRoute` tree, compiled by `radixRouter`/`compiledCharRouter`/
`mapCharRouter` and run via `createFetch`/`serveBun`/`serveNode`/etc. — emit
idiomatic router code for existing HTTP frameworks: an Express `Router`
instance, a Hono app with chained `.get`/`.post` calls, an Elysia app with
its own chain, and so on. A user who wants their fractal-defined API to run
*inside* an existing Express/Hono/Elysia app (rather than as a standalone
fractal-served process) would import the generated router the same way they
import any hand-written one.

## What already exists that this builds on

`http-api-projector` already has a working precedent for "walk `HttpRoute`,
emit source text for a target that isn't fractal's own runtime":
`codegen.ts`'s `generateClient`/`generateClientFromNode` produce a
**standalone** TypeScript client — zero imports from any fractal package,
depending only on global `fetch`/`Request`/`URL` — by walking the same
`HttpRoute` tree `client.ts`'s runtime proxy and `openapi.ts`'s spec
generation already walk. Framework router codegen is the same shape of
problem (`HttpRoute` + `SchemaMap` → generated source string) with a
different target: instead of a fetch-based *client*, it emits a
framework-native *router*.

`type-ir`'s doc projectors (`docusaurus-reference.ts`, `starlight-reference.ts`,
`mkdocs-reference.ts`, see `docs/reference/type-ir/doc-projectors.md`) are a
second, closer precedent for the *family* shape this idea implies: one IR,
multiple named target-specific emitters living as sibling modules, each
producing idiomatic output for its target's conventions rather than one
generic lowest-common-denominator format. Framework router codegen would
likely be organized the same way — one module per target framework
(an Express emitter, a Hono emitter, an Elysia emitter, ...), not one
generic "framework router" emitter parameterized by framework.

## Architectural fork: new projector vs. new emit modules in `http-api-projector`

The project owner has given direction on package boundary (see below) — Option
B, sized/justified once scope firms up — so this is no longer the fully open
question it was; both options are still laid out here for the tradeoffs they
name, since the sizing question below depends on understanding what Option A
would have reused.

**Option A — sibling modules inside `http-api-projector`.** Add
`express-router.ts`/`hono-router.ts`/`elysia-router.ts` (or however many)
next to `codegen.ts`, each exporting a `generate<Framework>Router(route,
schemas, options)` function that walks the same `HttpRoute` tree
`codegen.ts` already walks. Reuses `HttpRoute` construction
(`naiveTransform`/`applyMethods`/`applyMoveTo`/`applyResponse`), the
existing `SchemaMap`→JSON-Schema-string helpers, and the co-located-handler
naming logic `codegen.ts`/`openapi.ts` already solved. Keeps everything
HTTP-shaped in the one package that currently owns HTTP.

**Option B — a new, separate projector package.** A package alongside
`http-api-projector` (the same relationship `graphql-api-projector`,
`cli-api-projector`, `mcp-api-projector`, and `json-rpc-api-projector` have
to each other and to `api-tree`) dedicated to framework-router emission,
depending on `http-api-projector` (or directly on `api-tree`'s `Node`) as
needed. Keeps `http-api-projector`'s own scope — being fractal's *own*
working HTTP framework/runtime — undiluted by a growing list of
third-party-framework emit targets that have nothing to do with running a
fractal-served process.

**Direction given by the project owner: Option B, as a single new package
covering all target frameworks** — one `framework-codegen`-shaped package
(name TBD, see this repo's "no suggesting project names" constraint) housing
the Express/Hono/Elysia/... emitters together, not one package per framework
and not sibling files inside `http-api-projector`. This is a real call, not
fully final — recorded here as the direction to build toward.

The remaining open part is sizing/justification, which is explicitly
*not* yet knowable: the call was to size and justify the new package
relative to how big framework-codegen ends up being compared to
`http-api-projector` itself (the same "a two-framework feature and a
ten-framework feature don't obviously belong in the same place" tension
raised below), and that ratio depends on which frameworks are in scope and
how much per-framework work each one takes — both still open (see the next
section). `http-api-projector`'s README currently frames that package as
"turns an `api()`/`op()` tree into an HTTP router" that *runs* (via the
`serve*`/`to*` adapters); framework codegen serves a different end (someone
else's runtime executes the output, not fractal's) — consistent with
keeping it a separate package rather than folding it in, the same
relationship `graphql-api-projector`/`cli-api-projector`/
`mcp-api-projector`/`json-rpc-api-projector` have to `http-api-projector`
and `api-tree`.

## Framework scope and priority order

**Decided by the project owner: comprehensive coverage, not a curated
shortlist.** Scope is all JS/TS web frameworks with real usage — the
Express/Hono/Elysia trio named earlier in this doc were examples that
happened to already have prior-art research, not the intended final list.
The only carve-out is frameworks with no real adoption (the project owner's
framing: something like "someone's personal project used by three people"),
not any curated subset of the frameworks that *do* have real usage. Priority
order across that comprehensive set is popularity-descending, per direction
the project owner gave earlier — most-used frameworks get emitters first,
long-tail frameworks later, rather than an arbitrary or hand-picked order.

**A first candidate list, ordered roughly by current popularity** — useful
as a starting point for sequencing implementation work, *not* a locked
decision on exact ordering. Relative popularity between adjacent frameworks
shifts (Hono and Elysia in particular are both still growing fast enough
that this ordering could look different in another year), and this list
itself may be missing frameworks with real usage that didn't surface in a
quick pass — both are reasons this stays a "first candidate," to be revised
as actual download/usage data is checked at implementation time rather than
treated as settled:

1. **Express** — still the largest install base by a wide margin (tens of
   millions of weekly npm downloads); the default many tutorials and
   existing codebases target.
2. **Fastify** — the common "faster/more structured than Express" pick for
   greenfield Node APIs; JSON-Schema-native validation, which lines up
   well with fractal's own schema story.
3. **NestJS** — the dominant structured/enterprise/DI-flavored framework;
   large install base, but its router shape (decorator classes, modules) is
   the most structurally different from the other candidates here, worth
   flagging as likely the highest per-framework implementation cost.
4. **Koa** — smaller ecosystem than Express but a long-standing, still
   actively used minimal/async-first framework from the same lineage.
5. **Hono** — the fastest-growing of the newer entrants, multi-runtime
   (Node/Bun/Deno/Workers) as its core pitch; already named explicitly in
   this doc's earlier sections and has prior-art research
   (`docs/design/prior-art/hono.md`).
6. **Elysia** — Bun-native, smaller install base than Hono but fast-growing
   and already has prior-art research (`docs/design/prior-art/elysia.md`).
7. **AdonisJS** — batteries-included, smaller but real and actively
   maintained user base.
8. **Hapi** — older, enterprise-adjacent, smaller current install base than
   the above but still real usage.
9. **Feathers**, **Restify**, **Sails**, **LoopBack** — longer-tail
   frameworks with real but comparatively small current usage; candidates
   for later sequencing, not necessarily in a firm relative order among
   themselves at this level of research.

This list was built from a general popularity check (npm weekly-download
comparisons, current framework-comparison writeups), not a rigorous
download-count audit — treat the ordering, and the inclusion/exclusion of
any specific long-tail framework, as a first pass to be checked against real
numbers when a given framework's emitter is actually about to be built, not
as this doc settling it.

## Validator/schema mapping per target — already solved upstream

Each candidate framework has its own native validation-library convention
baked into its idiomatic router shape — Hono's `zValidator` (Zod), Elysia's
`t.Object` (TypeBox), Express has no single dominant convention (see
`dx-pain-express-fastify.md`: "Express ships with no protective defaults at
all," validation is always a bolt-on).

**Correction:** an earlier version of this doc said fractal's own schema
representation *is* `SchemaMap`/`ToolSchema` (JSON-Schema-shaped) and framed
"generate a real Zod schema from it" as a nontrivial, unsolved per-target
mapping problem. Both parts were wrong, verified against current code:

- Fractal's actual base schema representation is `TypeRef` — the
  `{ shape, meta }` pair defined in `@rhi-zone/fractal-type-ir`
  (`packages/type-ir/src/index.ts`), a subtyping hierarchy over a closed set
  of shape kinds plus an open metadata bag. `SchemaMap`/`ToolSchema`
  (`packages/api-tree/src/tree.ts`) is a **JSON-Schema-shaped projection**
  of that IR — `extractToolSchemas` derives it by going TS type → `TypeRef`
  → JSON Schema (see `packages/api-tree/src/extract.ts`'s module comment),
  the same walk that also exposes the pre-projection `TypeRef` directly via
  `extractToolTypeRefs`/`TypeRefMap`/`ToolTypeInfo`. JSON Schema is one
  target of that projection, not the representation itself.
- `TypeRef` → Zod and `TypeRef` → TypeBox source-text generation already
  exist and are shipped: `packages/type-ir/src/typescript-zod.ts` and
  `packages/type-ir/src/typescript-typebox.ts`, published as the `./zod`
  and `./typebox` subpaths of `@rhi-zone/fractal-type-ir` (each with a test
  file: `typescript-zod.test.ts`, `typescript-typebox.test.ts`). Both emit
  validator *builder source text* (e.g. `z.object({ ... })`,
  `Type.Object({ ... })`), not runtime schema instances — the same
  "emit source, don't run it" shape `codegen.ts`'s client generation
  already follows.

So generating a real `zValidator`(Zod)/`t.Object`(TypeBox) call for a
framework router is not an open mapping problem this feature would need to
invent: it's TypeRef (already recoverable per-leaf via `extractToolTypeRefs`,
the same walk `extractToolSchemas` runs) fed through `type-ir`'s existing
`./zod`/`./typebox` projectors. What's still genuinely open is Express
(no dominant validation convention to target at all, per
`dx-pain-express-fastify.md`) and the wiring/integration work of calling
these projectors from framework-router codegen — not the schema-mapping
problem itself.

## Regen vs. one-time eject

A proposal came back for this question: "regen is a strict superset of
eject — if a user can always just stop rerunning codegen and hand-edit the
last generated output, picking regen-by-default doesn't foreclose anyone
who wants the eject workflow; they just don't rerun it." That reasoning was
checked against what `http-api-projector`'s codegen actually does today,
not against the mechanism this doc previously described — and the previous
description turned out to be wrong, which changes the picture.

**Correction: the drift-guard mechanism this doc cited doesn't exist in the
current codegen.** `AssertExact<RouteUnion<typeof app>, GenUnion>` and
`fractal watch` regenerating `client.ts`/`server.ts` are real, but they
belong to a **retired prior design** — documented in
`docs/design/handler-model.md`, which carries an explicit
"Status: Superseded" banner and describes the old `Handler<R>`/`req.ctx`/
`.meta` model and the pre-rename package split
(`fractal-openapi-api-projector`/`fractal-client-api-projector`, since
merged into `http-api-projector`). The doc that supersedes it,
`docs/design/function-core-and-projection.md`, explicitly rejects the
drift-guard approach: "A runtime meta tree (`.meta`, `_def`) is a second
source of truth that drifts from the types and must be kept in sync by hand
or by a guard (the old model needed an `AssertExact` drift guard precisely
because it had two truths). Reading the types directly removes the second
truth and the guard with it." Confirmed against current source: there is no
`AssertExact`/drift-guard code anywhere under `packages/http-api-projector/src`;
the only place `AssertExact` exists is `spike/drift-guard/` (an
un-integrated research spike measuring type-instantiation cost, per its own
README, not wired into any shipped codegen path); and today's
`codegen.ts` only generates a client (`generateClient`/
`generateClientFromNode`, marked `// @generated ... do not edit`) — there
is no `server.ts` generation and no CLI `watch` command drives it (the
current `fractal-api-tree` CLI's `watch`/`watch-schema` regenerate the
`applyValidation` and JSON-Schema modules, not a client or router).

So, checked against what's actually shipped rather than the retired model:
`http-api-projector`'s current generated client has no self-verifying
mechanism at all (no drift guard, no watch loop) beyond a "do not edit"
comment header — nothing in the current output structure would make
hand-editing it and never rerunning codegen mechanically awkward or broken.
On that narrow point, the "regen minus rerunning it = eject" reasoning
doesn't hit an obstacle in what exists today.

That's a weaker finding than "confirmed, strict superset, no catch," though:
the premise being evaluated (a drift-guard-backed regen model) isn't
current behavior, so this doc can't honestly resolve the question by
pointing at that mechanism. What it can say: (1) no evidence of a technical
catch in the *current* shipped codegen that would make eject-by-abandonment
awkward, and (2) if a future drift-guard mechanism were reintroduced for
framework-router codegen specifically, the superset reasoning would need
re-checking against whatever that mechanism actually does (a drift guard
*embedded in the generated file itself*, if one existed, could make
"hand-edit and stop rerunning" produce a file that still fails `tsc` unless
the guard line is also deleted — a real asymmetry between eject and
regen-then-stop).

**Decided by the project owner: eject, as the model.** Framework router
codegen writes the router file once; nothing in fractal's build or CLI
re-runs it automatically or asserts the output still matches the source
types. This is a real call, recorded here as settled — not re-litigated by
what follows.

### Refinement under consideration: a drift-detecting regen command

Eject-as-the-model doesn't rule out *also* shipping a `regenerate` (or
`--force`) command a user can invoke by hand later — e.g. after the fractal
API surface changes and they want a fresh router reflecting it. The
project owner asked for that command to detect whether the file it's about
to overwrite was hand-edited since it was last generated, rather than
silently clobbering it. This section thinks that mechanism through and
checks it against how existing codegen-with-eject tools that face the same
problem actually behave, rather than inventing one from scratch.

**Does hashing the file content work?** Yes, with one wrinkle: hashing
"the whole file" is self-referential if the hash is also stored inside that
same file (the hash would need to cover its own comment line). Two ways
around that, both used in practice by real tools:

- **Store the hash out-of-band**, in a sidecar (a per-file entry in a
  manifest like `.fractal/codegen.lock.json` mapping output path → hash of
  the content generated for it) rather than inside the generated file
  itself. This is the shape Prisma actually uses for its own drift
  detection: migration checksums aren't embedded in the migration SQL file,
  they're recorded in the database's migration-history table, and `prisma
  migrate` compares the file's current checksum against that stored value
  to detect an applied migration was edited after the fact ("migration
  `[name]` was modified after it was applied"). Advantage: the generated
  file itself stays exactly what a human would hand-write, no tooling
  metadata baked into router source. Disadvantage: the manifest is a second
  file that has to travel with the project (and be gitignored or not,
  itself a small decision) and can get out of sync with the outputs it
  describes if someone deletes/moves a router file without going through
  the tool.
- **Embed the hash as a comment in the generated file**, computed over the
  file's content *excluding* that comment line (generate the body first,
  hash it, then prepend/append the `// @generated-hash: sha256:...` line).
  Self-contained — no second file to keep in sync, the provenance travels
  with the router file wherever it's copied — at the cost of a tooling
  artifact sitting in what's otherwise meant to look like a plain
  hand-editable Express/Hono/Elysia router.

Either construction is mechanically sound; which one fits better is closer
to a style call than a technical one, and is left open below rather than
picked here.

**What does the regen command do when it detects drift?** This is the part
genuinely still open, and prior art doesn't converge on one answer —
existing tools split across at least three real strategies:

- **Refuse and require an explicit override.** Print what changed (a diff
  against what fresh codegen would now produce) and stop; the user re-runs
  with `--force`/`--overwrite` to proceed anyway, or resolves by hand
  first. Safest against silent data loss; adds a step to the common case
  where the user *does* want the refresh.
- **Overwrite anyway, but only after an explicit flag or interactive
  confirmation** — closer to `openapi-generator`'s `--skip-overwrite` /
  `.openapi-generator-ignore` model: `openapi-generator` doesn't hash-check
  for drift at all, it instead lets the user mark specific output files as
  permanently hands-off from future regens (an ignore-file, `.gitignore`-
  shaped) or pass `--skip-overwrite` to leave any existing file alone
  wholesale. That sidesteps drift detection entirely by making "don't touch
  this file again" an explicit, standing per-file declaration rather than a
  per-run detected condition.
- **Don't touch the live file at all — write the fresh output somewhere
  else and let the user reconcile.** The closest working precedent is
  `shadcn/ui`'s `diff` command: `shadcn` components are themselves an eject
  model (copied into the user's project, not re-run automatically), and its
  `diff`/`add --diff` commands are an on-demand, explicit check that show
  the user a diff between their local (possibly hand-edited) copy and what
  the registry would generate now — the user decides what to do with that
  diff; the tool never overwrites on its own.

  (For completeness: hash-based drift detection embedded in generated
  output has also been requested, unimplemented, for GraphQL Code
  Generator — the community discussion there proposes exactly the
  stamped-hash-plus-`--check`-command shape this section is evaluating,
  which suggests it's a real gap other eject/regen-hybrid tools have felt
  too, not just a fractal-specific concern.)

**Decided by the project owner: support all three, not pick one.** The
earlier framing above — "None of these is picked here... that's a
project-owner call to make" — has been superseded: the call made was that
the regen command supports all three strategies (refuse-and-diff,
flag-to-override, write-alongside-for-manual-reconcile) as modes the user
selects per-invocation, rather than fractal committing every user to one
project-wide behavior. This is a real call, recorded here as settled — not
re-litigated by what follows.

(The ignore-file-style opt-out described above under `openapi-generator` —
a *standing*, per-file "never touch this again" declaration, orthogonal to
any single invocation — is a related but different mechanism from the three
per-invocation modes the project owner scoped this decision to. It isn't
folded into "all three" here; whether fractal also wants a persistent
opt-out list alongside per-invocation mode selection is a separate,
still-open question this doc doesn't resolve.)

What a hash of the generated content is a workable, low-cost way to detect
drift remains true regardless of which mode a given invocation runs in —
refuse-and-diff and write-alongside both need that comparison to produce
their diff, and flag-to-override needs it available even though it chooses
to skip acting on it. Whether that hash lives in a sidecar manifest or a
comment in the generated file itself is still open, as before.

### Command surface for selecting a mode per-invocation

This is this doc's own reasoned proposal for the concrete flag/subcommand
shape — not yet project-owner-ratified the way "support all three" above
is. It's checked against prior art rather than invented from scratch, per
the same approach the rest of this section takes.

Two shapes were considered for exposing three modes on one command:

- **Three independent flags** (something like `--refuse` / `--force` /
  `--diff-only`), left for the user to combine freely. Weighed against and
  set aside: the three modes are mutually exclusive outcomes for the same
  drift event, not independently-togglable options — separate boolean flags
  invite an invalid combination (`--force` and `--diff-only` together, say)
  that the command then has to detect and reject, rather than the CLI's
  shape ruling it out structurally.
- **A default write path plus a separate read-only path**, matching a split
  prior art in this doc already draws: Prisma's `migrate dev` (writes) vs.
  `migrate diff` (separate, read-only, never writes) are two different
  commands, not one command with three flags; `shadcn`'s `add` (writes,
  prompts on conflict) vs. `diff` (separate, read-only) follow the same
  split. That split lines up with a real distinction between the three
  modes: write-alongside-for-manual-reconcile never touches the live output
  file — it's inspection, not a write attempt — while refuse-and-diff and
  flag-to-override are two settings of the *same* write attempt
  (check-then-write vs. skip-check-and-write).

The second shape is what this proposal follows:

- `fractal regen <target>` (command name TBD — package/CLI naming is
  explicitly out of scope for this doc per this repo's "no suggesting
  project names" constraint) is the write path. With no flags, it's
  refuse-and-diff: hash what fresh codegen would produce, compare against
  the stored last-generated hash, and if the live file doesn't match, print
  a diff between the live file and fresh output and exit non-zero without
  writing.
  - `--force` (alias `--overwrite`) skips the drift check and writes the
    fresh output unconditionally — flag-to-override.
- Write-alongside-for-manual-reconcile gets a read-only entry point that
  structurally cannot touch the live file, in one of two forms, both
  workable:
  - a `--diff` flag on the same `regen` command that, when passed, never
    writes to the live path and instead writes fresh output to a sibling
    file (e.g. `<file>.generated.ts` next to the hand-edited `<file>.ts`)
    for the user to reconcile with their own diff tool; or
  - a separate `regen:diff`-shaped subcommand mirroring `prisma migrate
    diff` / `shadcn diff`'s command-level split.

  A flag keeps the CLI surface smaller — one command name to learn. A
  separate subcommand states the "this can never mutate your file" guarantee
  at the command-name level, where it can't be missed the way a flag can be.
  Which fits better is a naming/ergonomics call, closer in kind to the
  still-open sidecar-vs-embedded-hash question above than something this
  proposal resolves.

One follow-up question this raises and doesn't answer: whether the chosen
mode can be persisted as a project default (e.g. a `regen.driftMode` field
in project config) so a team doesn't retype `--force` on every invocation,
or whether mode selection is strictly per-invocation only, the way "a flag
the user picks per-invocation" was framed when this was scoped. Left open
here rather than assumed.

## Open question: relationship to the existing OpenAPI projection

`http-api-projector` already emits OpenAPI 3.1 (`toOpenApi`, auto-served at
`/openapi.json`). Some ecosystem tooling exists for OpenAPI-spec-driven
route scaffolding, in whatever framework. Whether framework router codegen
should be built as a thin layer on top of the existing OpenAPI output (reuse
that projection, then feed it through an existing or new OpenAPI-to-router
generator) versus derived directly from `HttpRoute` the way `codegen.ts`'s
client generation is today (bypassing OpenAPI, walking the tree structure
directly) is open, and affects fidelity — the OpenAPI projection is a lossy
intermediate the same way client codegen documents its own known
degradations around co-located multi-verb entries (see `codegen.ts`'s
module doc, "co-located members... degrade").

## Open question: does this replace or coexist with fractal's own router

Not addressed here: whether framework router codegen is positioned as an
escape hatch (a user leaves fractal's own runtime behind entirely once they
adopt the generated Express/Hono/Elysia router, calling into fractal-defined
handler functions but no longer through `radixRouter`/`compiledCharRouter`/
`createFetch`), or whether it's meant to coexist — e.g., mounting a fractal
sub-app inside a larger existing Express/Hono app via each framework's own
sub-router mounting convention, while fractal's compiled matcher still does
the actual dispatch underneath. These are materially different products
(one replaces fractal's routing; one embeds it), and the doc doesn't resolve
which is intended.

## See also

- `packages/http-api-projector/README.md` — current package scope and exports.
- `packages/http-api-projector/src/codegen.ts` — existing standalone-client
  codegen precedent this idea's shape follows.
- `docs/design/vs-hono-elysia.md`, `docs/design/prior-art/hono.md`,
  `docs/design/prior-art/elysia.md`, `docs/design/prior-art/dx-pain-express-fastify.md`
  — existing competitive framing this doc's target frameworks are drawn from.
- `docs/reference/type-ir/doc-projectors.md` — the one-IR/many-named-target-emitters
  precedent this idea's package shape likely follows.
- `packages/type-ir/src/index.ts`, `packages/type-ir/README.md` — `TypeRef`,
  fractal's actual base schema representation.
- `packages/type-ir/src/typescript-zod.ts`, `packages/type-ir/src/typescript-typebox.ts`
  — the existing `TypeRef` → Zod/TypeBox source-text projectors this doc now
  points at instead of describing the mapping as unsolved.
- `docs/design/function-core-and-projection.md` (current, itself noted as
  partially superseded by `invariants.md`), `docs/design/handler-model.md`
  ("Status: Superseded") — why the `AssertExact` drift guard isn't part of
  the current model.
- Prior art consulted for the eject-plus-drift-detection refinement:
  Prisma's migration-checksum model (checksum stored in migration history,
  not the migration file, compared on apply), `openapi-generator`'s
  `--skip-overwrite`/`.openapi-generator-ignore` per-file opt-out,
  `shadcn/ui`'s on-demand `diff` command (eject model, explicit diff against
  the registry rather than automatic overwrite-or-refuse), and GraphQL Code
  Generator's community-requested-but-unimplemented checksum/`--check`
  proposal.
