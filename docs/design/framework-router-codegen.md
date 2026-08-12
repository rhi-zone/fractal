# Framework router codegen — scoping notes

> Pre-implementation scoping document. Captures the idea's shape and the
> architectural fork it raises, not a decision. Per this project's
> disposition, options below are laid out with their tradeoffs, not ranked —
> scope (which frameworks, priority order) is explicitly left to the project
> owner, flagged as open rather than guessed at.

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

## Open question: which frameworks, and priority order

Not decided here, deliberately. The prompt for this doc named Express, Hono,
and Elysia as examples (the same three frameworks `vs-hono-elysia.md` and
`docs/design/prior-art/{hono,elysia,dx-pain-express-fastify}.md` already
research), but scope — which frameworks are actually targeted, and in what
order — is a project-owner call, not something to infer from "these are the
frameworks that happened to come up already."

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
regen-then-stop). Whether framework router codegen adopts a regen model, an
eject model, or revisits a drift-guard, is still a project-owner call this
doc doesn't make — but it should be made against the current codegen's
actual behavior, not the retired model's.

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
