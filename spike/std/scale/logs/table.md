# std typed-client compile cost by N (tsgo 7.0.0-dev native-preview + stock tsc 6.0.3)

| N | tsgo inst | tsgo types | tsgo check ms | tsgo mem KB | tsgo wall ms | stock tsc inst | stock tsc |
|---|---|---|---|---|---|---|---|
| 10 | 5842 | 4219 | 3 | 27695 | 58 | 4683 | ok |
| 100 | 18532 | 5869 | 8 | 29304 | 64 | 17373 | ok |
| 300 | 46807 | 9547 | 28 | 32768 | 85 | 45648 | ok |
| 600 | 89079 | 15048 | 76 | 37894 | 129 | 87920 | ok |
| 900 | 131407 | 20547 | 139 | 43330 | 199 | 130248 | ok |
