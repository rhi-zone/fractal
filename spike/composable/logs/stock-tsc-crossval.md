# Stock tsc 6.0.3 cross-validation — composable model (variant D)

Per-file isolated typecheck (`bunx tsc -p {include:[D-N]} --extendedDiagnostics`),
source resolved via tsconfig.base.json paths.

| variant | N | result | instantiations | memory | check |
|---|---|---|---|---|---|
| D (composable) | 600 | **ok** | 77,771  | 102,185K | 0.40s |
| D (composable) | 900 | **ok** | 114,557 | 117,276K | 0.49s |

Compare to the old CHAINED router (spike/scale variant A) on the SAME stock tsc:

| variant | N | result |
|---|---|---|
| A (chained) | 600 | **CRASH: RangeError: Maximum call stack size exceeded** (binder) |
| A (chained) | 900 | **CRASH: RangeError: Maximum call stack size exceeded** (binder) |

Conclusion: the composable flat-value model SURVIVES stock tsc at 900 routes
(~115K instantiations, half a second) exactly where the chained builder hard-
crashes the recursive binder. The flat compose + structural (non-string) params
removed the deep accumulation chain that blew the stack.
