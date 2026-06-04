# std typed-client compile cost by N (tsgo 7.0.0-dev native-preview + stock tsc 6.0.3)

| N | tsgo inst | tsgo types | tsgo check ms | tsgo mem KB | tsgo wall ms | stock tsc inst | stock tsc |
|---|---|---|---|---|---|---|---|
| 10 | 4877 | 3852 | 2 | 27340 | 54 | 3834 | ok |
| 100 | 15017 | 5472 | 8 | 28960 | 60 | 13974 | ok |
| 300 | 37619 | 9083 | 25 | 32232 | 77 | 36576 | ok |
| 600 | 71391 | 14484 | 64 | 36990 | 118 | 70348 | ok |
| 900 | 105219 | 19883 | 122 | 42345 | 181 | 104176 | ok |
