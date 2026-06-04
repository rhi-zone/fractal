# Typed-router compile cost vs route count

**Question.** Does fractal's typed router/client survive ~900 routes? The router's
5th type param `Routes extends readonly RouteSpec[]` ACCUMULATES every route's
spec on every chained `.get/.post/.mount`, and `ClientOf<R>` maps that whole
tuple — the Hono `hc` / Eden `treaty` pattern, known to blow up at scale. Is the
accumulation+`ClientOf` the bottleneck, or is per-route handler typing the cost?

**Harness.** `spike/scale/` — a generator (`gen/generate.ts`) emits a fractal app
with N routes (deterministic mix of `get`/`post`/`put`, `:id` params, ~1-in-4
mutating routes carry a `withValidation` body) for N ∈ {10, 100, 300, 600, 900},
in four variants. Each file is typechecked in isolation; `run.ts` records tsgo
`--extendedDiagnostics` (best of 3 after a warm-up). Paths point at package
**source** (`packages/*/src/index.ts`), so this measures the current code.

| Variant | What it isolates |
|---|---|
| **A** | CURRENT coupled router: chained builder accumulates `Routes`, plus `client(app)` + 8 typed call-sites (forces `ClientOf`). |
| **B** | Per-route typing ONLY: N handlers each typed locally (`ctx.params`/body/return), never fed through the chained builder — no accumulation tuple formed. |
| **C1** | DECOUPLED, contract-object (tRPC-style): one `{ "/p": { get: h } } as const` literal, `ClientOfContract<typeof contract>` maps the object once. No chained accumulation. |
| **C2** | DECOUPLED, opt-in accumulation: each route an independent `defineRoute(...)`, `buildClient([...])` forms the tuple at ONE call site. |

**Tools.** Primary: **tsgo `7.0.0-dev.20260527.2`** (`@typescript/native-preview`,
nix-provided) — gives full `--extendedDiagnostics`. Cross-validated against
**stock tsc `6.0.3`** (`bunx tsc`) at N=600/900. All four variants typecheck with
**zero errors** at every N. Client correctness (params/body/return enforced, and
`@ts-expect-error` negatives fire) verified for A, C1, C2 in `correctness.ts`.

## Results (tsgo --extendedDiagnostics)

### Type instantiations
| N | A | B | C1 | C2 |
|---|---|---|---|---|
| 10  | 26,683    | 9,902  | 12,728 | 13,764  |
| 100 | 58,184    | 12,422 | 15,516 | 38,008  |
| 300 | 215,120   | 18,018 | 20,694 | 91,940  |
| 600 | 675,556   | 26,418 | 28,750 | 172,724 |
| 900 | **1,406,020** | 34,818 | **36,794** | 253,540 |

### Check time (ms) / Memory (KB)
| N | A check | A mem | C1 check | C1 mem | B check | C2 check |
|---|---|---|---|---|---|---|
| 100 | 16  | 36,804  | 7  | 31,209 | 6  | 17  |
| 300 | 58  | 59,360  | 11 | 34,448 | 18 | 43  |
| 600 | 164 | 119,209 | 19 | 39,043 | 45 | 103 |
| 900 | 371 | 214,880 | 30 | 43,909 | 92 | 170 |

### Cross-validation, stock tsc 6.0.3 (instantiations / outcome)
| N | A | B | C1 | C2 |
|---|---|---|---|---|
| 300 | 201,019 (ok) | — | — | — |
| 600 | **CRASH — RangeError: Maximum call stack size exceeded** | — | — | — |
| 900 | **CRASH (binder stack overflow)** | 34,336 (ok) | 36,078 (ok) | 252,816 (ok) |

## Verdict

**A (current coupled) does NOT scale. It is quadratic, O(N²).** Instantiations
grow **24x for a 9x route increase** (100→900); `inst / N²` is roughly constant
(~1.7–2.4), the signature of quadratic blow-up — each chained call re-spreads the
growing `[...Routes, RouteOf<...>]` tuple, and `ClientOf` re-maps the whole tuple.
At 900 it costs **1.4M instantiations, 371 ms check, 215 MB** under tsgo.

Worse, the *runtime* of typechecking is not the only failure: the 900-deep chained
`.get().post()…` expression **crashes stock tsc 6.0.3 with a binder stack overflow
somewhere between N=300 and N=600** (A-300 ok, A-600 crashes). tsgo's native binder
survives, but consumers on stock tsc — the common case — get a hard compiler crash,
not slow types. This is the exact Hono-`hc` / Eden failure mode, confirmed.

**B (per-route typing only) is flat/cheap and is NOT the problem.** ~28
instantiations per route, dead linear: 9.9K→34.8K across 10→900, 92 ms check at
900. Per-route `ctx.params`/body/return inference scales fine regardless of N.
**At 900, A costs 40x B's instantiations** — the entire excess is accumulation +
`ClientOf`, exactly as hypothesised.

**C decoupled keeps the typed client AND scales.**
- **C1 (contract object) is the winner.** Tracks B almost exactly — 36.8K
  instantiations and **30 ms** check at 900 (**38x fewer instantiations than A,
  12x faster check, 5x less memory**), survives stock tsc. The object literal's
  type is inferred once; the mapped `ClientOfContract` walks its keys with no
  per-route tuple re-spread. The client still types fully (negatives in
  `correctness.ts` fire).
- **C2 (opt-in accumulation) also works** and is ~5.5x cheaper than A at 900
  (253K vs 1.4M, 170 ms vs 371 ms) and survives stock tsc — but it is still
  roughly linear-with-a-tuple, ~7x C1's cost, because `buildClient` does form the
  N-tuple (just once, not N times). Acceptable, but C1 is strictly better.

## Recommendation

**Decouple. Drop the `Routes` accumulation tuple from the router type; derive the
typed client from a declared contract object (C1).** Concretely:

- Remove the 5th `Routes` type param and `__routes` phantom from `Router`; stop
  threading `[...Routes, RouteOf<...>]` on every verb/`mount`. The router keeps
  per-route handler typing (B-class cost — cheap, flat) and reflection via the
  runtime `meta` array.
- Provide a contract-object surface (`spike/scale/contract.ts::ClientOfContract`)
  as the source for `client(...)`: `{ "/users/:id": { get, post } } as const`.
  One mapped type, inferred once.

This taxes EVERY router today (A's quadratic cost is paid even when the client is
never derived — B proves the router alone could be flat). Decoupling makes the
typed client opt-in and turns an O(N²)-with-a-stock-tsc-crash into an O(N) (C1
effectively flat) that survives 900+ routes on every compiler. If the chained
builder ergonomics must stay, C2 (opt-in `buildClient`) is the fallback: 5.5x
cheaper and crash-free, but C1 is the recommendation.

*Reproduce:* `cd spike/scale && bun gen/generate.ts && bun run.ts`
(writes `logs/results.csv`, `logs/table.md`). Tool: tsgo native-preview; stock
tsc cross-check via `bunx tsc -p <per-file tsconfig> --extendedDiagnostics`.
