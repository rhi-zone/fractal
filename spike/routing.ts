// spike/routing.ts — routing-core type design empirical test
// Purpose: verify that the Handler<P> param-flow algebra behaves as intended under tsgo.
// Runtime bodies are stubs (as any) where noted. Signatures are the artifact under test.
//
// ============================================================================
// KEY FINDINGS (written after observing tsgo output):
//
// 1. PARAM DISCHARGE FAILURE (load-bearing):
//    param<K,P,Res>(name, child: Handler<P & Record<K,string>, Res>): Handler<P,Res>
//    When `child` is Handler<{id:string}>, TS infers P={id:string} — NOT P={}.
//    TS type inference does NOT subtract Record<K,string> from the intersection;
//    it picks the simplest unification (P = child's full param type).
//    Therefore param('id', leaf<{id:string}>) → Handler<{id:string}>, not Handler<{}>.
//    This breaks tests A, B, E, and the nested cases.
//
// 2. CHOICE INFERENCE (conditional on argument types):
//    choice(leafNeedsNothing, leafNeedsRole) where leafNeedsRole: Handler<{role:string}>.
//    tsgo infers P = {role:string} (from the more constrained argument), NOT P={}.
//    So the "most demanding sibling" intuition IS correct for choice — inference works.
//    However param discharge failure still prevents run(param('role', choiceF)) from working.
//
// 3. TYPED CORRECTLY DISCHARGES Out:
//    typed<Out, P, Res>(parse)(inner: Handler<P & Out, Res>): Handler<P, Res>
//    When called as typed<{id:number}>(parse)(leaf<{id:number}>) with P inferred as {},
//    the result is Handler<{}, Res>. typed works correctly in isolation.
//    The full chain typed→param still fails because param discharge fails on the typed output.
//    BUT: typed→param works when typed's output has P={} (no remaining string requirements):
//    param('x', typed<{x:number}>(parse)(leaf<{x:number}>)) → Handler<{}, void>. This compiles!
//    Explanation: typed<{x:number}>(parse)(leaf<{x:number}>) = Handler<{}> (P={} inferred).
//    param('x', Handler<{}>) → TS infers P={}, K='x', P & {x:string} = {x:string},
//    but Handler<{}> is assignable to Handler<{x:string}> by contravariance (safe widening),
//    so the call compiles and returns Handler<{}, void>. Discharge appears to work here
//    only because Handler<{}> is already "less demanding" than what param requires.
//
// 4. G1 SAFETY (param + direct number leaf): param('x', leaf<{x:number}>) COMPILES silently.
//    TS infers P={x:number}, producing Handler<{x:number}>. No error is raised even though
//    param injects a string and the leaf expects a number — the type is unsound at runtime
//    but TS does not catch it statically. This is a hole in the design.
// ============================================================================

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

declare const PASS: unique symbol
type Pass = typeof PASS

type Req<P> = { path: string[]; method: string; params: P }
type Handler<P = {}, Res = unknown> = (req: Req<P>) => Promise<Res | Pass>

// ---------------------------------------------------------------------------
// Combinators (signatures are real; bodies are stubs)
// ---------------------------------------------------------------------------

/** Leaf: wraps a plain handler function into a Handler<P, Res>. */
function leaf<P = {}, Res = unknown>(fn: (req: Req<P>) => Promise<Res>): Handler<P, Res> {
  return fn as any
}

/** Methods: dispatch by req.method. */
function methods<P, Res>(table: Record<string, Handler<P, Res>>): Handler<P, Res> {
  return async (req) => {
    const h = table[req.method]
    if (h === undefined) return PASS as any
    return h(req)
  }
}

/** Path: dispatch by first path segment. */
function path<P, Res>(table: Record<string, Handler<P, Res>>): Handler<P, Res> {
  return async (req) => {
    const [seg, ...rest] = req.path
    if (seg === undefined) return PASS as any
    const h = table[seg]
    if (h === undefined) return PASS as any
    return h({ ...req, path: rest })
  }
}

/** Choice: try handlers in order, return first non-Pass result. */
function choice<P, Res>(...hs: Handler<P, Res>[]): Handler<P, Res> {
  return async (req) => {
    for (const h of hs) {
      const res = await h(req)
      if (res !== PASS) return res
    }
    return PASS as any
  }
}

/**
 * Param: captures one path segment as `name`, injects it into params.
 * INTENDED: child requires P & Record<K, string>; this discharges K, result requires only P.
 * ACTUAL: TS infers P = child's full param type (not P\K). See KEY FINDING #1.
 */
function param<K extends string, P, Res>(
  name: K,
  child: Handler<P & Record<K, string>, Res>,
): Handler<P, Res> {
  return async (req) => {
    const [seg, ...rest] = req.path
    if (seg === undefined) return PASS as any
    const enriched = { ...req, path: rest, params: { ...req.params, [name]: seg } } as Req<
      P & Record<K, string>
    >
    return child(enriched)
  }
}

/**
 * Typed: a typing middleware that parses raw string params into a typed shape Out.
 * `inner` requires P & Out; this discharges Out (it parses it from params).
 * Returns a handler requiring only P.
 * ACTUAL: Works correctly. typed<Out>(parse)(leaf<Out>) → Handler<{}, Res>. See KEY FINDING #3.
 */
function typed<Out, P = {}, Res = unknown>(
  parse: (raw: Record<string, string>) => Out,
): (inner: Handler<P & Out, Res>) => Handler<P, Res> {
  return (inner) =>
    async (req) => {
      const parsed = parse(req.params as unknown as Record<string, string>)
      const enriched = { ...req, params: { ...(req.params as object), ...parsed } } as Req<P & Out>
      return inner(enriched)
    }
}

/** Run: only accepts a handler whose required params are fully discharged (P = {}). */
function run(h: Handler<{}, any>): void {
  void h
}

// ---------------------------------------------------------------------------
// TEST A — PARAM FLOW
// INTENDED: param('id', leaf<{id:string}>) → Handler<{}>, run compiles.
// ACTUAL: FAIL. param infers P={id:string}, returns Handler<{id:string}>.
//   run(handlerA) is correctly rejected by tsgo (wrong for the intended design).
//   The @ts-expect-error below documents that tsgo rejects what SHOULD compile.
// ---------------------------------------------------------------------------

const leafA_A = leaf<{ id: string }, string>(async (req) => {
  // Internal assertion: req.params.id is string — COMPILES (leaf type is correct).
  const idA: string = req.params.id
  return idA
})

const handlerA = param('id', leafA_A)
// handlerA is Handler<{id:string}, string> — param did NOT discharge id.
// @ts-expect-error [TEST A: FAIL] param returns Handler<{id:string}> not Handler<{}>
//   tsgo: Argument of type 'Handler<{id:string},string>' not assignable to 'Handler<{},any>'
//   Property 'id' is missing in type '{}' but required in type '{id:string}'
run(handlerA)

// ---------------------------------------------------------------------------
// TEST B — TYPED REFINEMENT
// INTENDED: param('id', typed<{id:number}>(parse)(leaf<{id:number}>)) → Handler<{}>
// ACTUAL: PARTIAL FAIL.
//   typed<{id:number}>(parse)(leaf<{id:number}>) → Handler<{id:string}> (discharges number, leaves string).
//   Then param('id', Handler<{id:string}>) fails to discharge — same as A.
//   However: typed in FULL chain (typed discharges everything) DOES work — see B2.
// ---------------------------------------------------------------------------

function parseIdToNumber(raw: Record<string, string>): { id: number } {
  return { id: Number(raw['id']) }
}

const leafB_inner = leaf<{ id: number }, string>(async (req) => {
  // Internal assertion: req.params.id is number — COMPILES.
  const idB: number = req.params.id
  return String(idB)
})

// typed<{id:number}>(parse)(leafB_inner): discharges {id:number}, result needs {id:string} for param.
// typed correctly infers P={id:string} from the composition context:
const leafB_typed: Handler<{ id: string }, string> = typed<
  { id: number },
  { id: string },
  string
>(parseIdToNumber)(leafB_inner)
// ↑ COMPILES — typed correctly discharges {id:number}, leaving {id:string} for param to fill.

const handlerB = param('id', leafB_typed)
// @ts-expect-error [TEST B: FAIL] param returns Handler<{id:string}> not Handler<{}>
//   tsgo: Argument of type 'Handler<{id:string},string>' not assignable to 'Handler<{},any>'
run(handlerB)

// B2: typed over the FULL param type (typed discharges id completely, P={}):
// typed<{id:number}, {}, string>(parse) takes leaf<{id:number}> and produces Handler<{}, string>:
const handlerB2: Handler<{}, string> = typed<{ id: number }, {}, string>(parseIdToNumber)(leafB_inner)
// ↑ COMPILES — typed with explicit P={} discharges everything, Handler<{}> confirmed.
run(handlerB2) // COMPILES — no param needed; typed fully discharged.

// ---------------------------------------------------------------------------
// TEST C — NESTING + INFERENCE
// INTENDED: A realistic nested structure infers without annotations; req.params.id available.
// ACTUAL: PARTIAL FAIL.
//   - req.params.id IS typed as string inside leafGetUser/leafDelUser (PASS).
//   - methods({GET:x, POST:y}) requires all handlers to unify Res; different Res types error.
//   - param inside choice fails to discharge id when types are explicit.
//   - With explicit P annotations on outer combinators, param's non-discharge leaks inward.
// ---------------------------------------------------------------------------

const leafGetUsers = leaf<{}, { users: string[] }>(async (_req) => ({ users: [] as string[] }))
const leafCreateUser = leaf<{}, { created: boolean }>(async (_req) => ({ created: true }))

const leafGetUser = leaf<{ id: string }, { id: string }>(async (req) => {
  // COMPILES — req.params.id is string.
  const idC: string = req.params.id
  return { id: idC }
})

const leafDelUser = leaf<{ id: string }, { deleted: string }>(async (req) => {
  // COMPILES — req.params.id is string.
  const idC2: string = req.params.id
  return { deleted: idC2 }
})

// param('id', methods<{id:string}, object>({...})) returns Handler<{id:string}, object> (not {}).
// To expose the failure cleanly, we extract the param result and try to assign it to Handler<{}>.
// [TEST C: FAIL] param inside nesting still returns Handler<{id:string}>, not Handler<{}>:
const handlerC_inner = param('id', methods<{ id: string }, object>({ GET: leafGetUser, DELETE: leafDelUser }))
// handlerC_inner is Handler<{id:string}, object> — param did not discharge id.
// @ts-expect-error [TEST C: FAIL] param returns Handler<{id:string}> not Handler<{}>
const _handlerC_check: Handler<{}, object> = handlerC_inner

// For run(), we force P={} by casting — just to show the nesting structure compiles otherwise:
const handlerC = path<{}, object>({
  users: choice<{}, object>(
    methods<{}, object>({ GET: leafGetUsers, POST: leafCreateUser }),
    handlerC_inner as unknown as Handler<{}, object>, // cast to expose structure only
  ),
})
run(handlerC) // COMPILES (but only via cast — tree is not well-typed as-is)

// ---------------------------------------------------------------------------
// TEST D — IMAGINARY-PARAM GUARD
// A leaf needing {id:number} with NO param above it → run MUST error.
// ACTUAL: PASS — run(leafD) correctly errors.
// ---------------------------------------------------------------------------

const leafD = leaf<{ id: number }, string>(async (req) => {
  return String(req.params.id)
})

// @ts-expect-error [TEST D: PASS] Handler<{id:number}> correctly rejected by run — expected error
run(leafD)

// ---------------------------------------------------------------------------
// TEST E — MOUNT REQUIREMENT PROPAGATION
// INTENDED: run(subtreeE) errors; param('tenantId', subtreeE) discharges, run compiles.
// ACTUAL: run(subtreeE) correctly errors (PASS); param discharge FAILS (run still errors).
// ---------------------------------------------------------------------------

const subtreeE = leaf<{ tenantId: string }, string>(async (req) => req.params.tenantId)

// @ts-expect-error [TEST E part1: PASS] tenantId not discharged — correctly errors
run(subtreeE)

const handlerE = param('tenantId', subtreeE)
// handlerE is Handler<{tenantId:string}> not Handler<{}> (param discharge failure):
// @ts-expect-error [TEST E part2: FAIL] param returns Handler<{tenantId:string}> not Handler<{}>
//   tsgo: Argument of type 'Handler<{tenantId:string},string>' not assignable to 'Handler<{},any>'
run(handlerE)

// ---------------------------------------------------------------------------
// TEST F — NARROWER SIBLING WITHOUT SPURIOUS ERROR
// choice(leafNeedsNothing, leafNeedsRole): what P is inferred?
// ACTUAL: P = {role:string} — inference IS correct! The most demanding sibling wins.
//   tsgo infers from the more constrained argument (leafNeedsRole) and the less constrained
//   (leafNeedsNothing: Handler<{}>) is assignable to Handler<{role:string}> by contravariance.
//   So choiceF is Handler<{role:string}, string>.
//   run(choiceF) correctly errors (PASS for guard).
//   run(param('role', choiceF)) should compile — but param discharge FAILS (same root cause).
// ---------------------------------------------------------------------------

const leafNeedsNothing = leaf(async (_req) => 'ok')
const leafNeedsRole = leaf<{ role: string }, string>(async (req) => req.params.role)

const choiceF = choice(leafNeedsNothing, leafNeedsRole)

// PROBE 1: choiceF is Handler<{role:string}> — assigning to Handler<{}> errors:
// @ts-expect-error [TEST F probe1: PASS] choiceF is Handler<{role:string}>, not Handler<{}>
//   tsgo: Type 'Handler<{role:string},string>' not assignable to type 'Handler<{},unknown>'
const _probeF_asEmpty: Handler<{}> = choiceF

// PROBE 2: run(choiceF) errors — role is undischarged:
// @ts-expect-error [TEST F probe2: PASS] role not discharged — correctly errors
//   tsgo: Argument of type 'Handler<{role:string},string>' not assignable to 'Handler<{},any>'
run(choiceF)

// PROBE 3: Handler<{role:string}> assignable to Handler<{role:string}> — trivially yes:
const _probeF_asRole: Handler<{ role: string }> = choiceF // COMPILES

// PROBE 4: param('role', choiceF) should discharge role → Handler<{}, string>:
const handlerF_withRole = param('role', choiceF)
// @ts-expect-error [TEST F probe4: FAIL] param discharge failure — returns Handler<{role:string}>
//   tsgo: Argument of type 'Handler<{role:string},string>' not assignable to 'Handler<{},any>'
run(handlerF_withRole)

// SUMMARY: choiceF inferred as Handler<{role:string}, string> — inference CORRECT.
// run without discharge correctly errors — guard WORKS for choice.
// param('role', choiceF) still fails to discharge — same param failure as A/B/E.

// ---------------------------------------------------------------------------
// TEST G — ORTHOGONALITY
// param only injects strings; typed is the only place types enter.
// The untyped path (A) and typed path (B) coexist with no codec in param's signature.
// ---------------------------------------------------------------------------

// G1: param injects string — leaf expecting number directly param-wrapped.
//     INTENDED: type error (param injects string, leaf wants number).
//     ACTUAL: COMPILES silently. TS infers P={x:number}, K='x', Res=void.
//     P & Record<K,string> = {x:number} & {x:string} = {x:never} but TS does not flag this.
//     This is a type-safety hole: param('x', leaf<{x:number}>) produces Handler<{x:number}>,
//     runtime will pass a string where number is expected — unsound but uncaught.
const leafG_wantsNumber = leaf<{ x: number }, void>(async (_req) => {})

// NO @ts-expect-error here: this silently compiles (unexpected, unsound):
// [TEST G1: FAIL] Expected error from param injecting string into number-typed leaf.
//   TS infers P={x:number}, returns Handler<{x:number}, void>. No diagnostic raised.
const _paramG1_silent = param('x', leafG_wantsNumber) // compiles — unsound, no error

// G2: typed is the bridge — param('x', typed<{x:number}>(parse)(leaf<{x:number}>)):
//     typed<{x:number}>(parse)(leaf<{x:number}>) with P inferred as {}:
//     → result is Handler<{}, void> (typed discharges {x:number}).
//     then param('x', Handler<{}, void>): P inferred as {}, K='x',
//     P & {x:string} = {x:string}, but Handler<{}> is assignable to Handler<{x:string}>
//     by contravariance (safe: accepting a wider req). So param returns Handler<{}, void>.
//     run(handlerG2) COMPILES — this works! (Accidentally, via contravariance, not discharge.)
const handlerG2 = param(
  'x',
  typed<{ x: number }>(raw => ({ x: Number(raw['x']) }))(leafG_wantsNumber),
)
// [TEST G2: PARTIAL PASS] run compiles, but for subtle reason (see comment above):
run(handlerG2) // COMPILES

// G3: Orthogonality of untyped (A) and typed (B2) paths:
// handlerA is Handler<{id:string}> (param discharge failure):
// @ts-expect-error [TEST G3a: confirmed] handlerA has undischarged id — correctly rejected
const _coexistA: Handler<{}> = handlerA
// handlerB2 (typed-only, no param) is Handler<{}> — coexists cleanly:
const _coexistB2: Handler<{}> = handlerB2 // COMPILES — typed path works orthogonally
// Both untyped-via-param and typed-via-typed can coexist in the same file.
// The typed path produces clean Handler<{}> without codec in param's signature.
// param's signature remains purely structural (string injection) — orthogonality confirmed.

// ---------------------------------------------------------------------------
// BONUS: typed discharge correctness in full.
// ---------------------------------------------------------------------------

const leafBonus = leaf<{ id: number; tenantId: string }, string>(async (req) => {
  const n: number = req.params.id        // COMPILES
  const t: string = req.params.tenantId  // COMPILES
  return `${n}/${t}`
})

// typed<{id:number}, {tenantId:string}> discharges id, leaves tenantId:
const typedBonus: Handler<{ tenantId: string }, string> = typed<
  { id: number },
  { tenantId: string },
  string
>(parseIdToNumber)(leafBonus)
// COMPILES — typed correctly discharges {id:number}, remaining P = {tenantId:string}.

// @ts-expect-error [BONUS: PASS] tenantId not discharged — correctly errors
run(typedBonus)
