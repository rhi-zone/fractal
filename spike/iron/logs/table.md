# Iron model — tsgo --extendedDiagnostics by variant × N

I = `choice(route(method, path(lit, param), fn), ...)` of handler VALUES + `client(app)` + typed probes.
J = per-route typing only (no client) — isolates per-route cost.

### Type instantiations
| N | I | J |
|---|---|---|
| 10 | 7265 | 3750 |
| 100 | 25593 | 11040 |
| 300 | 66042 | 27237 |
| 600 | 126732 | 51537 |
| 900 | 187542 | 75837 |

### Types created
| N | I | J |
|---|---|---|
| 10 | 4777 | 3451 |
| 100 | 7706 | 5881 |
| 300 | 14206 | 11280 |
| 600 | 23948 | 19380 |
| 900 | 33706 | 27480 |

### Check time (ms)
| N | I | J |
|---|---|---|
| 10 | 4 | 3 |
| 100 | 13 | 22 |
| 300 | 34 | 158 |
| 600 | 67 | 655 |
| 900 | 101 | 1529 |

### Total tsc time (ms)
| N | I | J |
|---|---|---|
| 10 | 27 | 25 |
| 100 | 34 | 45 |
| 300 | 55 | 180 |
| 600 | 89 | 678 |
| 900 | 125 | 1551 |

### Memory used (KB)
| N | I | J |
|---|---|---|
| 10 | 29196 | 27996 |
| 100 | 33481 | 33017 |
| 300 | 43262 | 52208 |
| 600 | 57651 | 103883 |
| 900 | 71684 | 170142 |

### Wall-clock best-of-3 (ms, full process incl. startup)
| N | I | J |
|---|---|---|
| 10 | 54 | 54 |
| 100 | 64 | 74 |
| 300 | 86 | 205 |
| 600 | 123 | 717 |
| 900 | 161 | 1590 |

## Stock tsc 6.0.3 survival gate (variant I)
| N | ok | errors | wallMs |
|---|---|---|---|
| 600 | true | 0 | 664 |
| 900 | true | 0 | 805 |

## Cross-model comparison — Type instantiations (the decisive metric)

Same route plan across all models. Full typed-client variants:
- **I** = THIS iron model (handler is the only type; client from `.meta`).
- **D** = composable-with-`Route`-struct (reified `Route`/`Segment` types).
- **A** = the original chained/accumulating model.

| N | I (iron) | D (composable+struct) | A (chained) |
|---|---|---|---|
| 10  | 7,265   | 6,154   | 26,683    |
| 100 | 25,593  | 17,232  | 58,184    |
| 300 | 66,042  | 41,707  | 215,120   |
| 600 | 126,732 | 78,421  | 675,556   |
| 900 | 187,542 | 115,207 | 1,406,020 |

Growth 100→900 (9× the routes):
- I: 25,593 → 187,542  = **7.3×**  → LINEAR (sub-N).
- D: 17,232 → 115,207  = 6.7×      → linear.
- A: 58,184 → 1,406,020 = **24.2×** → super-linear (≈quadratic).

Stock tsc 6.0.3 survives variant I at 900 (0 errors, ~805 ms). The chained model
is the one that blows up; iron is linear, ~1.6× the instantiation constant of the
composable-with-struct model — the cost of carrying segment tuples + the union
fold in `.meta` instead of a reified `Route` struct, but the SAME linear curve.
