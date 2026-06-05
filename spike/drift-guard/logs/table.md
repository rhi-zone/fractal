# Drift-guard scale: formulation × N (tsgo 7.0.0-dev + stock tsc 6.0.3)

### Type instantiations (tsgo)
| routes | noguard | f1-naive | f2-flatmap | f3-perroute | f4-hybrid | f5-union |
|---|---|---|---|---|---|---|
| 99 | 0 | 98715 | 102899 | 84563 | 84596 | 29444 |
| 300 | 0 | 693072 | 627509 | 411322 | 411355 | 83245 |
| 600 | 0 | 2582172 | 2212109 | 1299822 | 1299855 | 163545 |
| 900 | 0 | 5671272 | 4756709 | 2668322 | 2668355 | 243845 |

### Check time ms (tsgo)
| routes | noguard | f1-naive | f2-flatmap | f3-perroute | f4-hybrid | f5-union |
|---|---|---|---|---|---|---|
| 99 | 0 | 34 | 27 | 23 | 23 | 18 |
| 300 | 1 | 252 | 128 | 95 | 94 | 78 |
| 600 | 2 | 1014 | 441 | 287 | 287 | 308 |
| 900 | 3 | 2319 | 920 | 584 | 577 | 707 |

### Stock tsc 6.0.3 survival
| routes | noguard | f1-naive | f2-flatmap | f3-perroute | f4-hybrid | f5-union |
|---|---|---|---|---|---|---|
| 99 | ok | ok | ok | ok | ok | ok |
| 300 | ok | ok | ok | ok | ok | ok |
| 600 | ok | ok | ok | ok | ok | ok |
| 900 | ok | ERR | ok | ok | ok | ok |

