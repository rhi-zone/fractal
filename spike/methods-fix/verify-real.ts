// Verifies the fixed core and the drift-guard derivation together. Confirms:
//   G1: `methods({GET,POST})` carries literal verbs in `.meta`, with no workaround.
//   G2: a handler with a declared param propagates its obligation through `methods`.
//   drift-guard: `RouteUnion` reads the param route's verbs as literals, making
//                the old `methods<P, typeof tbl>(tbl)` workaround unnecessary.
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
} from "@rhi-zone/fractal-api-tree";
import { json } from "@rhi-zone/fractal-http-api-projector";
import type { RouteUnion } from "../drift-guard/derive.ts";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// G1: literal verbs, no workaround.
const collection = methods({ GET: () => json([]), POST: () => json({}) });
type CVerbs = typeof collection.meta extends MethodsMeta<infer V, infer _IO> ? V : never;
type _G1 = Expect<Equals<CVerbs, "GET" | "POST">>;
// @ts-expect-error — must not widen to the full Method union.
type _G1neg = Expect<Equals<CVerbs, Method>>;

// G2: a declared-param handler propagates {id} through methods, with no type-arg.
const idLeaf = methods({
  GET: (req: Request & { params: { id: string } }) => json(req.params.id),
});
type IdLeafP =
  typeof idLeaf extends Handler<infer P> ? (P extends { id: string } ? true : false) : never;
// idLeaf's obligation includes {id}.
type _G2 = Expect<IdLeafP>;
// param("id", …) discharges it: Omit<{id},"id"> is assignable to Handler<{}>.
const discharged: Handler<{}> = param("id", idLeaf);
void discharged;

// drift-guard: a param route's verbs read as literals via RouteUnion.
// Builds a resource the same way the scale generator does, without the old
// `methods<P, typeof tbl>(tbl)` workaround.
const app = path({
  res0: choice(methods({ GET: () => json([]), POST: () => json({}) }), param("id", idLeaf)),
});

type Routes = RouteUnion<typeof app>;
// The set of route keys the derivation produced.
type RouteKeys = Routes extends { k: infer K } ? K : never;
// The param route's GET must appear as the literal key "GET /res0/{id}", which
// requires MethodsMeta to carry the literal "GET" rather than the full Method
// set (which would also emit POST/PUT/DELETE/… keys).
type _Drift = Expect<Equals<RouteKeys, "GET /res0" | "POST /res0" | "GET /res0/{id}">>;

export {};
