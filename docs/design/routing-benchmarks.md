# Routing Benchmarks

## How to run

```sh
bun run packages/http-api-projector/src/route.bench.ts
```

Results are saved as timestamped JSON in `packages/http-api-projector/bench-results/`.

## Hardware

| Field | Value |
|---|---|
| CPU | AMD Ryzen 9 9900X 12-Core Processor x24 @ 5621 MHz |
| RAM | 60.2 GB (6.8 GB free at test time) |
| OS | linux/x64 |
| Runtime | Bun 1.3.9 |

## Route tree

993 routes: ~32 static (depths 1-4), ~15 dynamic (1-2 params), 120 wide-branch siblings, 500-leaf 3-deep grid, 48-leaf long-path grid, bulk sets, deep-narrow/uneven stress cases, and long-path fixtures (200-8k chars).

## Architectures

| # | Name | Approach |
|---|---|---|
| 1 | Segment trie | `splitPath` into segments, walk a `Map<segment, child>` tree per level. Production algorithm (local port of private `matchRoute`). |
| 2 | Full-path Map | `Map<"METHOD pathname", handler>`. Only serves routes whose exact concrete path was seeded at build time. Ceiling benchmark for static lookups. |
| 3 | Single regex/method | One alternation regex per HTTP method; one `.exec()` per dispatch. |
| 4 | Compiled switch | `new Function()`-generated nested `switch` over `segs[depth]`, depth-specialized. |
| 5 | Char-level radix trie | Compressed prefix tree walked char-by-char. No `split`, no per-segment allocation. |
| 6 | Flat DFA table | `Uint32Array` transition table `[state*128+charCode] -> next state`. One table per method. |
| 7 | Compiled char-level fn | `new Function()`-generated nested `if/else` on `s.charCodeAt(i)`. Unbranching literal runs folded into single `startsWith` checks. |
| 8 | Hybrid Map+charFn | Static routes in a `Map<pathname, methods>`; dynamic routes only fed to arch 7's codegen (producing a smaller compiled fn). Dispatch: Map lookup first, compiled-fn fallback on miss. |

## Dispatch results (ns/request, 500k iterations)

| Case | 1. Seg trie | 2. Map | 3. Regex | 4. Switch | 5. Radix | 6. DFA | 7. CharFn | 8. Hybrid |
|---|---|---|---|---|---|---|---|---|
| static hit | 94.6 | 48.9 | 1244.1 | 134.5 | 44.1 | 35.6 | 81.1 | 14.1 |
| dynamic hit | 102.5 | 46.0 | 1276.9 | 129.2 | 45.2 | 37.4 | 56.9 | 26.2 |
| deep hit | 176.3 | 55.3 | 1304.3 | 186.5 | 64.8 | 81.4 | 79.2 | 14.5 |
| miss (404) | 91.3 | 38.3 | 1065.8 | 92.8 | 49.6 | 15.0 | 81.1 | 24.3 |
| static 200 | 749.1 | 163.7 | 1394.1 | 430.9 | 170.9 | 424.7 | 75.8 | 20.3 |
| dynamic 200 | 762.1 | 160.8 | 1333.1 | 354.5 | 185.9 | 428.5 | 97.9 | 61.2 |
| static 1k | 2389.9 | 701.4 | 1311.5 | 1155.8 | 672.7 | 1953.2 | 115.4 | 47.5 |
| dynamic 1k | 2422.4 | 629.7 | 1409.6 | 1178.0 | 685.8 | 1958.5 | 164.2 | 101.0 |
| static 2k | 4144.7 | 1137.6 | 1491.4 | 2215.3 | 1307.4 | 3794.8 | 190.1 | 96.1 |
| dynamic 2k | 4127.8 | 1062.1 | 1704.8 | 2309.4 | 1287.5 | 3731.3 | 299.5 | 137.6 |
| static 4k | 7046.4 | 2105.3 | 1886.5 | 4159.4 | 2516.8 | 7616.4 | 304.0 | 144.8 |
| dynamic 4k | 7028.3 | 2024.1 | 2114.1 | 3760.2 | 2544.0 | 7685.1 | 420.1 | 261.4 |
| static 8k | 12296.2 | 4019.3 | 2768.7 | 7116.8 | 4912.0 | 15405.4 | 460.2 | 283.7 |
| dynamic 8k | 12421.8 | 3974.0 | 4644.7 | 7094.8 | 4886.6 | 15456.6 | 830.6 | 420.0 |
| wide early | 110.4 | 63.5 | 2829.8 | 139.8 | 58.5 | 43.9 | 129.5 | 13.9 |
| wide middle | 111.4 | 49.7 | 2619.9 | 138.8 | 72.4 | 44.4 | 179.7 | 14.2 |
| wide late | 112.0 | 41.7 | 3205.4 | 138.3 | 83.0 | 44.5 | 218.0 | 13.9 |
| deep narrow | 316.9 | 64.0 | 1595.2 | 194.3 | 82.2 | 105.6 | 154.7 | 15.6 |
| many dynamic | 236.2 | 55.3 | 1581.9 | 235.1 | 142.5 | 117.9 | 310.8 | 108.1 |
| bulk static | 94.9 | 36.5 | 1646.4 | 126.2 | 65.9 | 33.4 | 194.4 | 13.4 |
| bulk dynamic | 145.5 | 39.4 | 2050.0 | 160.2 | 71.3 | 50.8 | 202.0 | 95.9 |
| bulk long static | 7891.0 | 2380.8 | 2146.4 | 4891.5 | 2743.0 | 8966.1 | 270.7 | 176.3 |
| bulk long dynamic | 7854.4 | 2258.8 | 2354.4 | 4812.2 | 2722.8 | 9081.5 | 410.9 | 334.9 |
| uneven deep | 260.8 | 62.0 | 1950.4 | 203.3 | 49.4 | 89.5 | 54.0 | 15.5 |
| uneven shallow | 98.2 | 40.1 | 1977.0 | 138.8 | 52.0 | 43.1 | 119.9 | 14.9 |
| grid early | 164.2 | 38.8 | 2039.6 | 194.9 | 64.3 | 45.3 | 174.6 | 14.9 |
| grid middle | 164.0 | 41.9 | 2655.8 | 195.0 | 75.5 | 45.6 | 222.5 | 13.8 |
| grid late | 165.3 | 44.5 | 3236.7 | 194.8 | 121.5 | 46.6 | 384.7 | 13.4 |
| long grid early | 4070.3 | 2125.3 | 3371.6 | 3902.2 | 2581.6 | 7505.3 | 301.7 | 148.7 |
| long grid late | 4073.4 | 2103.4 | 4148.7 | 3922.6 | 2558.6 | 7671.6 | 358.4 | 154.8 |

## Build cost and memory

| # | Architecture | us/build | Heap KB | External KB | Codegen chars |
|---|---|---|---|---|---|
| 1 | Segment trie | 623 | 4.6 | 7.3 | -- |
| 2 | Full-path Map | 550 | 18.3 | 227.2 | -- |
| 3 | Single regex/method | 891 | 0.0 | 0.0 | -- |
| 4 | Compiled switch | 639 | 0.0 | 0.0 | 259,366 |
| 5 | Char-level radix trie | 461 | 0.0 | 101.7 | -- |
| 6 | Flat DFA table | 79,176 | 0.0 | 54,930.5 | -- |
| 7 | Compiled char-level fn | 13,301 | 0.0 | 0.0 | 256,306 |
| 8 | Hybrid Map+charFn | 1,906 | 1.3 | 232.3 | 31,476 |

## Observations

**Path length scaling.** Architectures 1 (segment trie), 2 (Map), 4 (compiled switch), 5 (radix trie), and 6 (DFA) all scale roughly linearly with path length -- dispatch time at 8k chars is 100-400x their short-path time. Architecture 3 (regex) scales more gently because the regex engine's internal DFA amortizes per-char cost, but starts high (~1.2us even for short paths). Architectures 7 and 8 (compiled char fn, hybrid) scale sub-linearly thanks to the `startsWith`-folded unbranching runs -- 8k static paths cost only ~5-6x their short-path time.

**Wide branching.** Architecture 3 (regex) degrades sharply under wide branching (2.6-3.2us for 120 siblings). Architectures 1, 4, 5, 6 handle it well (hash/switch/trie lookups are O(1) or O(log n) per level). Architecture 7 degrades moderately because the compiled fn tries each literal `startsWith` in sequence at that branch point (129-218ns, scaling with position). Architecture 8 avoids this entirely for static wide branches via the Map (13-14ns regardless of position).

**Build cost tradeoffs.** Architecture 6 (DFA) is 130x more expensive to build than architecture 5 (radix trie) and consumes ~54MB of external memory (Uint32Array transition tables), making it impractical for dynamic route registration. Architecture 7's codegen is also expensive (13ms) due to `new Function()` compilation of 256k chars of generated source. Architecture 8's dynamic-only codegen is 7x cheaper (1.9ms) because its generated source is only 31k chars -- the static routes are in the Map, not the codegen.

**JIT-hoisting methodology.** Calling `dispatch(sameLiteral, sameLiteral)` 500k times lets V8/JSC prove arguments are constant across iterations, artificially speeding up branch-free architectures. The benchmark defeats this by pre-generating 8 distinct string objects per case (same content, different identity via `split/join`) and indexing with a per-iteration counter, forcing a runtime array read the engine cannot prove constant. Applied uniformly to all architectures.

## Caveat

Results are from a single machine (AMD Ryzen 9 9900X, 60GB RAM) running a single runtime version (Bun 1.3.9 on Linux x64). Different CPUs, cache hierarchies, and JS engines (Node/V8 vs Bun/JSC) may shift relative rankings. Re-validate on target hardware before drawing production conclusions.
