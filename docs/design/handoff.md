# Next-session handoff

## Read order

1. **`handoff.md`** (this doc) — current state and next work.
2. **[`invariants.md`](./invariants.md)** — the authoritative mined model.
   Defer to it on any conflict.
3. **[`function-core-and-projection.md`](./function-core-and-projection.md)** —
   fuller design, partly superseded. On any conflict, `invariants.md` wins.

## Branch / commits

- Branch: `redesign/function-core`.
- Commit `f301adb` — design doc + superseded banners.
- Commit `f35975f` — function-core spine slice.

## What's built (slice `f35975f`)

- `packages/core` rewritten = the function category
  (`compose` / `pipe` / `Result` + derived `composeK` / `collect`) + the
  Candidate-D tree combinators `path` / `param` / `group` / `methods` / `route` +
  the `app` anchor (`NoInfer` on every child/table/handler position; `app` seeds
  `C={}`).
- `packages/http` = `toFetch` dispatch with 404 / 405 / `Allow` / HEAD / OPTIONS
  correctness + JSON/error encoders.
- `examples/spine-demo`.
- Tests green: core 5, http 4, spine-demo 12 (incl. negatives: 400 bad body,
  400 missing query, 401 missing capability, 404, 405 + `Allow`). Typechecks clean.

## PROVISIONAL / to replace

The slice authors runtime `Schema` values (`str` / `num` / `bool` / `obj`) on the
leaf for dispatch-time validation. This is **SCAFFOLDING**, to be replaced by
codegen-from-types validators (truth = types + JSDoc). Do not treat the on-tree
schemas as the model.

## Fenced (in `TODO.md`, removed from workspace, not deleted)

`packages/openapi`, `packages/codegen`, `packages/client`, `examples/todo-api`,
`examples/dogfood` — to migrate to the function-core model.

## Verified result to keep

The bare object-literal tree type-checks with full inference via `NoInfer` + root
anchor. `group`'s producer must NOT have an un-annotated parameter
(`() => x` or `(req: Request) => x`; a return annotation alone is insufficient).
(Spike scratch artifacts were ephemeral and are gone; the result is captured here
and in the design doc.)

## Next work, in priority order

Each must be settled FROM the user's definition (do not guess):

1. The verb/method model.
2. The agnostic-tree shape + whether one tree can drive HTTP and CLI.
3. Node disambiguation.
4. Override authoring form.

Then: codegen-from-types (validators / OpenAPI / client) replacing the provisional
on-tree schemas.

## Working agreement

Check every move against [`invariants.md`](./invariants.md) and its guardrails
before proposing. When the model is unsettled, ASK the user for their definition
rather than inventing one.
