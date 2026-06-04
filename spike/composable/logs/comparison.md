# Composable model vs old chained router — instantiations (tsgo 7.0.0-dev)

D = composable: flat `routes(route(...))` of route VALUES + `client(app)` + typed
    probes (the composable analogue of chained variant A).
A = old chained builder `.get().post()…` + `client(app)` (spike/scale variant A).
E = composable per-route typing only (no client); B = chained per-route only.

### Type instantiations — D (this model) vs A (old chained)

| N | D (composable) | A (chained) | A/D | D inst/N |
|---|---|---|---|---|
| 100 | 17,232  | 58,184    | 3.4x  | 172 |
| 300 | 41,707  | 215,120   | 5.2x  | 139 |
| 600 | 78,421  | 675,556   | 8.6x  | 131 |
| 900 | 115,207 | 1,406,020 | 12.2x | 128 |

- D inst/N converges to ~128 → **LINEAR**. 9x routes (100→900) → 6.7x inst.
- A inst/N climbs 582→1562 → **super-linear/quadratic**. 9x routes → 24.2x inst.

### Stock tsc 6.0.3 survival at 900

| model | result at N=900 |
|---|---|
| D composable | **ok** — 114,557 inst, 0.49s |
| A chained    | **CRASH** RangeError (binder), already at 600 |

### vs the scale-test's flat winner (C1, contract object)

| N | D (composable, full client) | C1 (flat contract obj) | E (composable, no client) | B (chained, no client) |
|---|---|---|---|---|
| 900 | 115,207 | 36,794 | 57,091 | 34,818 |

D is ~3x C1's instantiations because D's flat `Client<R>` mapped type keys by a
STRUCTURAL `KeyOf<Segment[]>` fold (per route) plus per-route param recovery from
the segment tuple — richer than C1's string-key contract. It is still firmly
linear and an order of magnitude under chained A (1.4M). The composable model
buys structural (non-string) paths + value composition at a linear, stock-tsc-
surviving cost.
