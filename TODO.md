# fractal — TODO

## Open threads (advisory)

> *Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

These are starting context for a future session, not a task list. Each points at
the design docs for detail rather than restating them; verify each is still live
before acting.

### Design model is captured and authoritative in `docs/design/invariants.md`

The settled model was mined from the design conversation (with the original
author's verbatim words) into `docs/design/invariants.md`, and the next-session
handoff lives in `docs/design/handoff.md`. `docs/design/function-core-and-projection.md`
is fuller but partly superseded — on any conflict, invariants.md wins. invariants.md
also records 7 **guardrails** (things to NOT do — reified runtime meta, treating
input as "raw", leaking HTTP shape into the handler, Kleisli-as-base, losing the
single explicit tree, `create→POST`, forcing "data over code") that recurred as
mistakes. Worth reading those before proposing anything in this area.

### Unsettled design questions need the author's own definition, not invention

From invariants.md §open — these were explicitly left open and (per the guardrails)
should be settled FROM the author's definition rather than guessed:

- The full **verb/method model**: only "POST = a method call, not create" is
  settled; the `read→GET / replace→PUT / remove→DELETE / partial→PATCH`
  access-verb mapping was an *unconfirmed assistant proposal*, not part of the
  model. The author seemed to be leaning toward starting with the verb model
  first, but that's a lean, not a decision.
- Whether **one agnostic tree can auto-derive both HTTP and CLI**, given HTTP
  paths/headers and CLI subcommands/env vars have no 1:1 mapping — open and
  unreconciled.
- **Node disambiguation**: segment vs operation vs param within one node, and
  where the input→options transform lives.
- **Authoring form for bespoke verb/path overrides**: inline on the node vs a
  separate binding layer — undecided.
- **Creation / non-record output encoding** (author leans toward an explicit
  `POST /…/new`, not settled).
- The unresolved **"is it too general?"** tension — never closed.

### Codegen-from-types is not yet built

The current vertical slice authors provisional runtime `Schema` values
(`str`/`num`/`bool`/`obj`) on the leaf as dispatch-time-validation **scaffolding**.
The intent is to replace these with codegen-derived validators, where the single
source of truth is the inferred TS types + JSDoc (not an on-tree schema). The
on-tree schemas should NOT be mistaken for the model — they're a placeholder until
codegen-from-types exists. See `docs/design/handoff.md` §"PROVISIONAL / to replace".

### Dispatch extensibility model is settled in `docs/design/dispatch-extensibility.md`

The extensible dispatch model is settled: augmentable `DispatchKinds` interface,
batteries as plain matcher functions, declaration merging next to the tree,
projector takes a dictionary + tree. See `docs/design/dispatch-extensibility.md`
for the full model and pseudocode. Implementation: replace the closed
`DispatchMarker` union and hardcoded if/else dispatch in `packages/http/src/project.ts`.

### Migrate the fenced packages to the function-core model

The function-core rewrite (`docs/design/function-core-and-projection.md`) landed
as a vertical slice: `packages/core` + `packages/http` are rewritten to the new
model (function category + Result + Kleisli/applicative combinators; the
protocol-neutral D-tree `path`/`param`/`group`/`methods`/`route` + `app`; HTTP
dispatch + `Result`→`Response` encoding), proven by `examples/spine-demo`.

The packages below import the RETIRED `Handler<R>` / `req.ctx` / `.meta` model and
were **fenced out of the active workspace** (removed from root `package.json`
`workspaces`; not deleted) so the new slice builds green. They might need migrating
to the function-core model (or retiring) before being re-added:

- `packages/openapi` — OpenAPI projection from `.meta`. Would become an OUTPUT
  projection from inferred types (compiler-API walk), not a `.meta` reader.
- `packages/codegen` — typed client + drift guard from `.meta`. Would migrate to
  the types→client / types→OpenAPI build-time projection; the drift guard is
  likely retired (no second source of truth once types are the only truth).
- `packages/client` — typed HTTP client factory. Would re-mirror the new handler
  signature.
- `examples/todo-api` — re-author on the D-tree.
- `examples/dogfood` — re-author on the D-tree.

When migrating, each package's `package.json` `exports`/`main` and `tsconfig`
would also need re-pointing to match the slice's convention (currently `exports` →
`src` directly + `tsconfig` `paths` to sibling `src`, no build step) or restoring a
real `dist` build.

---

## Pending renames (apply when code is next touched)

- `DispatchMarker` in `packages/http/src/project.ts` currently uses `by` as the
  discriminant key (`{ by: "header", name }`, `{ by: "query", name }`,
  `{ by: "contentType" }`). Rename `by` → `kind` to match the settled convention
  (tagged-union discriminants are `kind`). Do NOT rename now — record here per
  the convention.

## Pending removals (apply when code is next touched)

- `effectiveTags` / tag inheritance in `packages/core/src/tags.ts`: remove the
  closest-wins tree-walk. A node's tags are what's on the node — subtree-wide
  tags are a `(tree) => tree` transform, not inheritance. Tags on a node should
  not depend on ancestors (breaks composability: moving a subtree silently
  changes its behavior).

---

## PUBLISH (after the model settles)

- Create `github.com/rhi-zone/fractal`, push, set pages/topics/homepage.
- Ecosystem docs-sync in `~/git/rhizone/github-io` — 7 touchpoints:
  1. `docs/about.md`
  2. `README.md`
  3. `docs/.vitepress/config.ts`
  4. `docs/index.md`
  5. `docs/projects/index.md`
  6. NEW `docs/projects/fractal.md`
  7. `~/git/rhizone/profile/profile/README.md`

## Deferred (build when needed)

### WebSocket / MCP / CLI surface kits

The protocol-neutral D-tree is surface-agnostic at the core level. Additional
surface kits (WS, MCP, CLI) would follow the same projection pattern. Note the open
question above on whether one tree can drive both HTTP and CLI — that's a
prerequisite for the CLI kit. No design work started.

### Reactivity / streaming substrate

invariants.md notes the author wants a canonical stream construct (rejecting a
`Result<T,E> | Response` escape hatch). Live queries and reactive client bindings
would require a reactive client library to exist first.

---

## Pointers

- **Authoritative model: `docs/design/invariants.md`** (mined, verbatim; wins on conflict)
- **Next-session handoff: `docs/design/handoff.md`**
- Fuller (partly superseded) design: `docs/design/function-core-and-projection.md`
- Commit history: `git log --oneline` in this repo
- Scorecard vs Hono/Elysia: `docs/design/vs-hono-elysia.md`
- Ecosystem design principles: `~/git/rhizone/github-io/docs/decisions/throughlines.md`
- Pre-function-core docs (superseded): `docs/design/roadmap.md`, `docs/design/handler-model.md`, `docs/design/optics-direction.md`
</content>
</invoke>
