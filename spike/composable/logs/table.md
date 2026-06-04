# Composable model — tsgo --extendedDiagnostics by variant × N

D = flat `routes(route(...))` of route VALUES + `client(app)` + typed probes.
E = per-route typing only (no client) — isolates per-route cost.

### Type instantiations
| N | D | E |
|---|---|---|
| 10 | 6154 | 3249 |
| 100 | 17232 | 8694 |
| 300 | 41707 | 20791 |
| 600 | 78421 | 38941 |
| 900 | 115207 | 57091 |

### Types created
| N | D | E |
|---|---|---|
| 10 | 4716 | 3137 |
| 100 | 7277 | 5162 |
| 300 | 12982 | 9662 |
| 600 | 21528 | 16412 |
| 900 | 30082 | 23162 |

### Check time (ms)
| N | D | E |
|---|---|---|
| 10 | 5 | 3 |
| 100 | 14 | 12 |
| 300 | 31 | 67 |
| 600 | 58 | 239 |
| 900 | 89 | 513 |

### Total tsc time (ms)
| N | D | E |
|---|---|---|
| 10 | 28 | 26 |
| 100 | 36 | 35 |
| 300 | 55 | 91 |
| 600 | 81 | 261 |
| 900 | 112 | 536 |

### Memory used (KB)
| N | D | E |
|---|---|---|
| 10 | 28730 | 27696 |
| 100 | 32180 | 31365 |
| 300 | 40268 | 41147 |
| 600 | 51973 | 61635 |
| 900 | 63601 | 86384 |

### Wall-clock best-of-3 (ms, full process incl. startup)
| N | D | E |
|---|---|---|
| 10 | 58 | 55 |
| 100 | 66 | 65 |
| 300 | 87 | 121 |
| 600 | 117 | 297 |
| 900 | 147 | 573 |
