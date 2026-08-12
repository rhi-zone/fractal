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

This is the central open question — genuinely undecided, not a placeholder:

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

Neither option is picked here. The considerations that would decide it:
`http-api-projector`'s README currently frames the package as "turns an
`api()`/`op()` tree into an HTTP router" that *runs* (via the `serve*`/`to*`
adapters) — framework codegen is adjacent (still HTTP, still walks
`HttpRoute`) but serves a different end (someone else's runtime executes the
output, not fractal's). Whether that's close enough to stay in-package (like
the client codegen already does) or different enough to warrant its own
package (like the protocol projectors did) is the actual fork, and it likely
also depends on how many target frameworks are in scope (see below) — a
two-framework feature and a ten-framework feature don't obviously belong in
the same place.

## Open question: which frameworks, and priority order

Not decided here, deliberately. The prompt for this doc named Express, Hono,
and Elysia as examples (the same three frameworks `vs-hono-elysia.md` and
`docs/design/prior-art/{hono,elysia,dx-pain-express-fastify}.md` already
research), but scope — which frameworks are actually targeted, and in what
order — is a project-owner call, not something to infer from "these are the
frameworks that happened to come up already."

## Open question: validator/schema mapping per target

Each candidate framework has its own native validation-library convention
baked into its idiomatic router shape — Hono's `zValidator` (Zod), Elysia's
`t.Object` (TypeBox), Express has no single dominant convention (see
`dx-pain-express-fastify.md`: "Express ships with no protective defaults at
all," validation is always a bolt-on). fractal's own schema representation
is `SchemaMap`/`ToolSchema` (JSON-Schema-shaped, `StandardSchemaV1`-oriented
per `wire-profiles-and-staged-validation.md`'s conventions elsewhere in this
codebase). Emitting an idiomatic Hono router with real `zValidator` calls
means generating (or requiring as a dependency) a Zod schema derived from
fractal's own schema representation — a nontrivial per-target mapping
problem distinct from generating the routing/path shape itself, and one
`codegen.ts`'s existing `schemaToType` (JSON-Schema-subset → TS type string)
doesn't currently attempt (it emits type aliases, not runtime validator
instances). Whether framework router codegen ships with real per-framework
validator wiring, or emits routes with validation left as a TODO/stub for
the target framework's own idiom, is open.

## Open question: generated-and-regenerated vs. one-time eject

`http-api-projector`'s existing codegen has a specific operating model:
`fractal watch` regenerates `client.ts`/`server.ts` on every source save,
and the generated output embeds a static drift guard
(`AssertExact<RouteUnion<typeof app>, GenUnion>`) that turns any
app/generated mismatch into a `tsc` error. It's not clear whether framework
router codegen is meant to work the same way — output that stays in
lockstep with the fractal tree and is regenerated continuously — or whether
it's meant as a one-time "eject" (generate an idiomatic Express/Hono/Elysia
app once, then the user owns and hand-edits it going forward, decoupled from
the fractal source). These have very different implications: a drift-guard
model needs the same `AssertExact`-style mechanism ported per target
framework's type system (straightforward for Hono, which is itself
TypeScript-typed end-to-end; less obvious for Express, which has no
type-level route registry to assert against); an eject model needs no such
mechanism but means the generated code is no longer fractal's problem to
keep correct after generation. Not decided.

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
