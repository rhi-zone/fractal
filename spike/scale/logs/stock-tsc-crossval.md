# Stock tsc 6.0.3 cross-validation (bunx tsc --extendedDiagnostics)

Per-file isolated typecheck, source paths via tsconfig.base.json.

| variant | N | result | instantiations | memory | check |
|---|---|---|---|---|---|
| A  | 300 | ok | 201,019 | 109,909K | 0.36s |
| A  | 600 | **CRASH: RangeError: Maximum call stack size exceeded** (binder, isNarrowableReference) | — | — | — |
| A  | 900 | **CRASH: RangeError: Maximum call stack size exceeded** (binder) | — | — | — |
| B  | 900 | ok | 34,336  | 93,987K  | 0.34s |
| C1 | 900 | ok | 36,078  | 93,855K  | 0.30s |
| C2 | 900 | ok | 252,816 | 148,210K | 0.71s |

Conclusion: the chained-builder variant A (≥600 deep `.get().post()…` chain) hard-
crashes stock tsc's recursive binder. tsgo (native) survives but is still
quadratic. B/C1/C2 survive both compilers; C1 ≈ B (flat, cheapest).
