// spike/methods-fix/verify-real.ts
//
// FINAL verification against the REAL fixed core + the real drift-guard
// derivation. Confirms:
//   G1: `methods({GET,POST})` carries LITERAL verbs in `.meta` (no workaround).
//   G2: a DECLARED-param handler propagates its obligation through `methods`.
//   drift-guard: `RouteUnion` reads the param route's verbs as literals — the
//                old `methods<P, typeof tbl>(tbl)` workaround is unnecessary.
//
// Run (from spike/drift-guard's path mapping, which points the package specifiers
// at the source):
//   tsgo --noEmit -p spike/methods-fix/tsconfig.real.json
//   tsc   --noEmit -p spike/methods-fix/tsconfig.real.json

import {
  choice,
  methods,
  param,
  path,
  type Handler,
  type MethodsMeta,
  type Method,
} from "@rhi-zone/fractal-core";
import { json } from "@rhi-zone/fractal-http";
import type { RouteUnion } from "../drift-guard/derive.ts";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// ===== G1: literal verbs, no workaround =====
const collection = methods({ GET: () => json([]), POST: () => json({}) });
type CVerbs = typeof collection.meta extends MethodsMeta<infer V, infer _IO>
  ? V
  : never;
type _G1 = Expect<Equals<CVerbs, "GET" | "POST">>;
// @ts-expect-error — must NOT widen to the full Method union.
type _G1neg = Expect<Equals<CVerbs, Method>>;

// ===== G2: declared-param handler propagates {id} through methods, NO type-arg =====
const idLeaf = methods({
  GET: (req: Request & { params: { id: string } }) => json(req.params.id),
});
type IdLeafP = typeof idLeaf extends Handler<infer P>
  ? P extends { id: string }
    ? true
    : false
  : never;
// idLeaf's obligation includes {id}.
type _G2 = Expect<IdLeafP>;
// And param("id", …) discharges it (Omit<{id},"id"> => assignable to Handler<{}>).
const discharged: Handler<{}> = param("id", idLeaf);
void discharged;

// ===== drift-guard: a param route's verbs read as literals via RouteUnion =====
// Build a resource exactly like the scale gen — WITHOUT the old
// `methods<P, typeof tbl>(tbl)` workaround.
const app = path({
  res0: choice(
    methods({ GET: () => json([]), POST: () => json({}) }),
    param("id", idLeaf),
  ),
});

type Routes = RouteUnion<typeof app>;
// Extract the set of route KEYS the derivation produced.
type RouteKeys = Routes extends { k: infer K } ? K : never;
// The param route's GET must appear as a LITERAL key "GET /res0/{id}" — only
// possible if MethodsMeta carried the literal "GET" (not the full Method set,
// which would have emitted POST/PUT/DELETE/… keys too).
type _Drift = Expect<
  Equals<
    RouteKeys,
    | "GET /res0"
    | "POST /res0"
    | "GET /res0/{id}"
  >
>;

export {};
