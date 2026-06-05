# spike/drift-guard — static (tsc-time) drift guard for codegen

**Question.** Can the generated client/server STATICALLY error at `tsc` time when it
has drifted from the source handler tree, WITHOUT reintroducing the O(N²) blowup
codegen exists to avoid?

**Answer: YES.** Formulation **f5 (union-vs-union `AssertExact`)** is linear in
type instantiations (~270/route, flat), survives stock tsc 6.0.3 at 900 routes,
and fires on all four drift kinds (route added / removed / param renamed / body
field type changed) on BOTH tsgo and stock tsc. See `derive.ts` (`RouteUnion` +
`AssertExact`) for the winning code.

## Layout
- `derive.ts` — `AssertExact` (sound function-identity equality), `FlatRoutes`
  (f2/f3/f4 object derivation), and **`RouteUnion`** (f5 — the linear winner).
- `naive.ts` — `ClientShapeFromMeta` (f1's heavy nested re-derive).
- `gen/generate.ts` — builds an N-resource app (≈3N routes; mirrors
  `packages/codegen/test/scale/gen.ts`), emits the source `app`, the generated
  artifacts (`GenRoutes`, `GenUnion`, `ApiClient`), and one file per formulation,
  plus drift-mutated artifacts at the smallest N.
- `run.ts` — typechecks each formulation × N in isolation under tsgo
  `--extendedDiagnostics` + stock tsc; writes `logs/{results.csv,table.md}`.

## Reproduce
```
cd spike/drift-guard
bun gen/generate.ts 99 300 600 900     # writes out/*.ts
bun run.ts                              # writes logs/table.md
```

Drift proof (after generate):
```
# build f5 drift guards at N=99 (33 resources), then typecheck each — must error:
for d in add remove renameParam changeBody; do
  printf '%s\n' \
    "import type { app } from \"./app-33.ts\";" \
    "import type { GenUnion } from \"./genunion-33-$d.ts\";" \
    "import type { Assert, AssertExact, RouteUnion } from \"../derive.ts\";" \
    "export const _g: Assert<AssertExact<RouteUnion<typeof app>, GenUnion>> = true;" \
    > out/f5drift-$d.ts
done
# tsgo: bun ../../node_modules/.bin/tsgo -p <tsconfig including out/f5drift-$d.ts>
# tsc : bun ../../node_modules/.bin/tsc  -p <same>
```

## Results — see `logs/table.md`. Headline at 900 routes (instantiations):
| no-guard | f1 naive | f2 flatmap | f3 per-route | f4 hybrid | **f5 union** |
|---|---|---|---|---|---|
| 0 | 5.67M (tsc TS2589) | 4.76M | 2.67M | 2.67M | **0.24M** |

f1/f2/f3/f4 are all O(N²) (the `UnionToObj` merge / per-route re-walk).
f5 never materializes a keyed object — it compares two UNIONS — so it stays linear.

## Core API finding
`methods<P>({ GET: h })` (the param-route pattern used in
`packages/codegen/test/scale/gen.ts` and examples) **erases the literal verb set**
in `.meta` (`verbs: readonly Method[]` instead of `readonly ["GET"]`), because the
explicit `P` type arg defeats `const T` inference. Any type-level guard reading
`MethodsMeta.verbs`/`__io` is blind to verbs for those routes. Workaround used
here: `methods<P, typeof tbl>(tbl)`. A real fold into codegen must either fix
core's `methods` inference or emit guards that don't depend on per-node verb
literals for explicitly-`P`-pinned routes.
