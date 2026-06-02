// spike/routing.ts — routing-core type design empirical test
// Purpose: verify that the Handler<P> param-flow algebra behaves as intended under tsgo.
// Runtime bodies are stubs (as any) where noted. Signatures are the artifact under test.
//
// ============================================================================
// ENCODING UNDER TEST (v2): param via Omit<C, K>
//
// param<K extends string, C extends Record<K, string>, Res>(
//   name: K, child: Handler<C, Res>,
// ): Handler<Omit<C, K>, Res>
//
// C is the child's FULL param requirement (constrained to include K as string).
// The return drops K from C, discharging exactly what param injects.
//
// KEY FINDINGS (written after observing tsgo output with Omit encoding):
//
// A: PASS. param('id', leaf<{id:string}>) → Handler<{}>, run compiles.
//    Omit encoding correctly discharges K.
//
// B: PASS. param('id', typed<{id:number}>(parse)(leaf<{id:number}>)) → Handler<{}>, run compiles.
//    typed produces Handler<{id:string}>, param discharges id → Handler<{}>. Full chain works.
//
// C: PASS. Deep nesting infers to Handler<{}>. No casts needed. req.params.id is string inside leaves.
//
// D: PASS. Handler<{id:number}> still rejected by run (regression guard holds).
//
// E: PASS. param('tenantId', subtreeE) discharges → Handler<{}>, run compiles.
//    E-PROPAGATION: param('id', twoParamChild) → Handler<{tenantId:string}> (id discharged only).
//    run of partial discharge correctly errors. param('tenantId', that) → Handler<{}>. run compiles.
//
// F: PASS. choice infers {role:string}. param('role', choiceF) discharges → Handler<{}>, run compiles.
//
// G1: PASS (hole CLOSED). param('x', leaf<{x:number}>) is now a compile error.
//     {x:number} does not satisfy C extends Record<'x',string>. @ts-expect-error consumed.
//
// G2/G3: PASS. typed bridge still works. _coexistA is now Handler<{}> (param discharged).
//
// H: UNUSED CAPTURE COMPILES SILENTLY. param('id', leaf<{}>) does NOT error.
//    {} structurally satisfies C extends Record<'id',string> in TypeScript
//    (excess-property checks don't apply to type constraints — {} is assignable to any Record<K,V>
//    by structural subtyping: empty object has no contradictions).
//    Result is Handler<Omit<{},'id'>, void> = Handler<{}, void>. Run compiles.
//    Verdict: unused captures are silently permitted. This is an ergonomic tradeoff —
//    you can param-wrap a child that doesn't use the captured key without error.
//    The key is still injected at runtime; the child just ignores it.
//
// I: PASS. leaf<{id:number}> → typed<{id:number}>(parse)(leaf) = Handler<{id:string}>
//    → param('id', that) = Handler<{}> → run compiles. Full realistic chain works end-to-end.
//
// BOTTOM LINE: The Omit<C,K> encoding makes param discharge correctly through all cases.
//   No regressions on D, F, B2/G2/G3. G1 safety hole is now CLOSED.
//   One ergonomic note: unused captures (H) compile silently — empty child P satisfies
//   C extends Record<K,string> by structural subtyping. Acceptable tradeoff.
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
 * v2 encoding: infer child's FULL param type C (must include K as string),
 * return Handler<Omit<C, K>, Res> — discharges exactly K from C.
 */
function param<K extends string, C extends Record<K, string>, Res>(
  name: K,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res> {
  return async (req) => {
    const [seg, ...rest] = req.path
    if (seg === undefined) return PASS as any
    const enriched = { ...req, path: rest, params: { ...req.params, [name]: seg } } as Req<C>
    return child(enriched)
  }
}

/**
 * Typed: a typing middleware that parses raw string params into a typed shape Out.
 * `inner` requires P & Out; this discharges Out (it parses it from params).
 * Returns a handler requiring only P.
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
// TYPE PROBES — inlined `type _ = ...` to observe inferred shapes
// ---------------------------------------------------------------------------

// Probe: what does param('id', leaf<{id:string}>) infer for its return type?
type _ProbeA_HandlerA = typeof handlerA
// Probe: what does param('tenantId', subtreeE) infer?
type _ProbeE_HandlerE = typeof handlerE
// These are referenced below after declarations.

// ---------------------------------------------------------------------------
// TEST A — PARAM DISCHARGE
// INTENDED: param('id', leaf<{id:string}>) → Handler<{}>, run compiles.
// With Omit encoding: C={id:string}, K='id', Omit<{id:string},'id'>={} → Handler<{}>
// ---------------------------------------------------------------------------

const leafA_A = leaf<{ id: string }, string>(async (req) => {
  // Internal assertion: req.params.id is string — COMPILES (leaf type is correct).
  const idA: string = req.params.id
  return idA
})

const handlerA = param('id', leafA_A)
// With Omit encoding: should be Handler<Omit<{id:string},'id'>, string> = Handler<{}, string>
run(handlerA) // [TEST A: expected PASS with Omit encoding]

// ---------------------------------------------------------------------------
// TEST B — TYPED REFINEMENT
// typed<{id:number}>(parse)(leaf<{id:number}>) → Handler<{id:string}> (discharges number, leaves string).
// param('id', Handler<{id:string}>) → should now discharge id → Handler<{}, string>
// ---------------------------------------------------------------------------

function parseIdToNumber(raw: Record<string, string>): { id: number } {
  return { id: Number(raw['id']) }
}

const leafB_inner = leaf<{ id: number }, string>(async (req) => {
  const idB: number = req.params.id
  return String(idB)
})

// typed correctly discharges {id:number}, result needs {id:string} for param:
const leafB_typed: Handler<{ id: string }, string> = typed<
  { id: number },
  { id: string },
  string
>(parseIdToNumber)(leafB_inner)
// COMPILES — typed correctly discharges {id:number}, leaving {id:string} for param to fill.

const handlerB = param('id', leafB_typed)
// With Omit encoding: C={id:string}, K='id', Omit<{id:string},'id'>={} → Handler<{}>
run(handlerB) // [TEST B: expected PASS with Omit encoding]

// B2: typed over the FULL param type (typed discharges id completely, P={}):
const handlerB2: Handler<{}, string> = typed<{ id: number }, {}, string>(parseIdToNumber)(leafB_inner)
// COMPILES — typed with explicit P={} discharges everything, Handler<{}> confirmed.
run(handlerB2) // COMPILES — no param needed; typed fully discharged.

// ---------------------------------------------------------------------------
// TEST C — NESTING + INFERENCE
// INTENDED: path({users:choice(methods({GET,POST}), param('id', methods({GET,DELETE})))})
//   should infer to Handler<{}> and compile; req.params.id typed string in deep leaves.
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

// With Omit encoding: param('id', methods<{id:string}, object>({...}))
//   C = {id:string}, K='id', return = Handler<Omit<{id:string},'id'>, object> = Handler<{}, object>
const handlerC_inner = param('id', methods<{ id: string }, object>({ GET: leafGetUser, DELETE: leafDelUser }))
// [TEST C inner probe: expected Handler<{}, object>]
type _ProbeC_Inner = typeof handlerC_inner

// Assignment to Handler<{}, object> should now compile:
const _handlerC_check: Handler<{}, object> = handlerC_inner // [TEST C: expected PASS]

// Full nested structure without casts:
const handlerC = path<{}, object>({
  users: choice<{}, object>(
    methods<{}, object>({ GET: leafGetUsers, POST: leafCreateUser }),
    handlerC_inner, // no cast needed if handlerC_inner is Handler<{}, object>
  ),
})
run(handlerC) // [TEST C: expected PASS]

// ---------------------------------------------------------------------------
// TEST D — IMAGINARY-PARAM GUARD
// A leaf needing {id:number} with NO param above it → run MUST error.
// This should still PASS (regression guard).
// ---------------------------------------------------------------------------

const leafD = leaf<{ id: number }, string>(async (req) => {
  return String(req.params.id)
})

// @ts-expect-error [TEST D: PASS] Handler<{id:number}> correctly rejected by run — expected error
run(leafD)

// ---------------------------------------------------------------------------
// TEST E — MOUNT REQUIREMENT PROPAGATION
// INTENDED: run(subtreeE) errors; param('tenantId', subtreeE) discharges, run compiles.
// ---------------------------------------------------------------------------

const subtreeE = leaf<{ tenantId: string }, string>(async (req) => req.params.tenantId)

// @ts-expect-error [TEST E part1: guard] tenantId not discharged — correctly errors
run(subtreeE)

const handlerE = param('tenantId', subtreeE)
// With Omit encoding: C={tenantId:string}, K='tenantId', Omit<{tenantId:string},'tenantId'>={}
run(handlerE) // [TEST E part2: expected PASS]

// ---------------------------------------------------------------------------
// TEST E-PROPAGATION — PARTIAL DISCHARGE (two-param child)
// child needs {tenantId:string, id:string}
// param('id', child) → should discharge id only → Handler<{tenantId:string}>
// run(that) must error (tenantId still required) — mark @ts-expect-error
// param('tenantId', param('id', child)) → should discharge both → Handler<{}>
// ---------------------------------------------------------------------------

const subtreeE2 = leaf<{ tenantId: string; id: string }, string>(async (req) => {
  const t: string = req.params.tenantId
  const i: string = req.params.id
  return `${t}/${i}`
})

const handlerE2_partialDischarge = param('id', subtreeE2)
// C={tenantId:string, id:string}, K='id', Omit<C,'id'>={tenantId:string}
type _ProbeE2_Partial = typeof handlerE2_partialDischarge // expect Handler<{tenantId:string}, string>

// @ts-expect-error [TEST E-PROPAGATION undischarged: expected error — tenantId still required]
run(handlerE2_partialDischarge)

const handlerE2_fullDischarge = param('tenantId', handlerE2_partialDischarge)
// C={tenantId:string}, K='tenantId', Omit<{tenantId:string},'tenantId'>={}
run(handlerE2_fullDischarge) // [TEST E-PROPAGATION full: expected PASS]

// ---------------------------------------------------------------------------
// TEST F — NARROWER SIBLING WITHOUT SPURIOUS ERROR
// choice(leafNeedsNothing, leafNeedsRole): P inferred as {role:string}
// param('role', choiceF) should discharge role → Handler<{}>
// ---------------------------------------------------------------------------

const leafNeedsNothing = leaf(async (_req) => 'ok')
const leafNeedsRole = leaf<{ role: string }, string>(async (req) => req.params.role)

const choiceF = choice(leafNeedsNothing, leafNeedsRole)

// PROBE 1: choiceF is Handler<{role:string}> — assigning to Handler<{}> errors:
// @ts-expect-error [TEST F probe1: PASS] choiceF is Handler<{role:string}>, not Handler<{}>
const _probeF_asEmpty: Handler<{}> = choiceF

// PROBE 2: run(choiceF) errors — role is undischarged:
// @ts-expect-error [TEST F probe2: PASS] role not discharged — correctly errors
run(choiceF)

// PROBE 3: Handler<{role:string}> assignable to Handler<{role:string}> — trivially yes:
const _probeF_asRole: Handler<{ role: string }> = choiceF // COMPILES

// PROBE 4: param('role', choiceF) should discharge role → Handler<{}, string>:
const handlerF_withRole = param('role', choiceF)
type _ProbeF_WithRole = typeof handlerF_withRole // expect Handler<{}, string>
run(handlerF_withRole) // [TEST F probe4: expected PASS with Omit encoding]

// ---------------------------------------------------------------------------
// TEST G — ORTHOGONALITY
// ---------------------------------------------------------------------------

// G1: SAFETY HOLE TEST: param('x', leaf<{x:number}>) — child doesn't satisfy Record<'x',string>
//     With Omit encoding: C extends Record<'x',string> — leaf<{x:number}> has x:number not string.
//     This SHOULD be a compile error. Mark @ts-expect-error — verify tsgo raises it.
const leafG_wantsNumber = leaf<{ x: number }, void>(async (_req) => {})

// @ts-expect-error [TEST G1: expected COMPILE ERROR — {x:number} not assignable to Record<'x',string>]
const _paramG1_mustError = param('x', leafG_wantsNumber)

// G2: typed is the bridge — param('x', typed<{x:number}>(parse)(leaf<{x:number}>)):
//     typed<{x:number}>(parse)(leaf<{x:number}>) with P inferred as {}
//     → Handler<{}, void> (typed fully discharges {x:number})
//     Then param('x', Handler<{}>) — does {} satisfy C extends Record<'x',string>? Test H below.
//     G2 focuses on the typed bridge: full chain compiles.
const handlerG2 = param(
  'x',
  typed<{ x: number }>(raw => ({ x: Number(raw['x']) }))(leafG_wantsNumber),
)
// [TEST G2: see H for whether this compiles or errors — the typed result is Handler<{}> (no x in P)]
run(handlerG2)

// G3: Orthogonality of untyped (A) and typed (B2) paths:
// handlerA should now be Handler<{}> (param discharged id):
const _coexistA: Handler<{}> = handlerA // [expected PASS with Omit encoding]
// handlerB2 (typed-only, no param) is Handler<{}> — coexists cleanly:
const _coexistB2: Handler<{}> = handlerB2 // COMPILES — typed path works orthogonally

// ---------------------------------------------------------------------------
// TEST H — UNUSED CAPTURE: param('id', leaf<{}>) where child does NOT need id
// Question: does {} satisfy C extends Record<'id',string>?
// {} does NOT have id:string, so this should be an error.
// Documenting the actual behavior — either outcome is acceptable, I just need to KNOW.
// ---------------------------------------------------------------------------

const leafH_needsNothing = leaf<{}, void>(async (_req) => {})

// With C extends Record<'id',string>: one might expect {} to fail the constraint.
// ACTUAL: COMPILES SILENTLY. In TypeScript, {} structurally satisfies Record<'id',string>
// because structural subtyping does not require the key to be present — it only requires
// no contradictions. Handler<{}> is assignable to Handler<Record<'id',string>> via contravariance.
// Result: Handler<Omit<{},'id'>, void> = Handler<{}, void>. run compiles.
// [TEST H: COMPILES — unused capture is silently permitted]
const _paramH_unusedCapture = param('id', leafH_needsNothing)
// No error here — param('id', leaf<{}>) produces Handler<{}, void> without complaint.
run(_paramH_unusedCapture) // COMPILES

// ---------------------------------------------------------------------------
// TEST I — TYPED+PARAM CHAIN: realistic full composition
// leaf<{id:number}> → typed<{id:number}>(parse)(leaf) = Handler<{id:string}>
// → param('id', that) = Handler<Omit<{id:string},'id'>> = Handler<{}>
// → run should compile
// ---------------------------------------------------------------------------

const leafI = leaf<{ id: number }, string>(async (req) => {
  // req.params.id is number inside the leaf — COMPILES:
  const n: number = req.params.id
  return String(n)
})

// typed turns {id:number} need into {id:string} need:
const typedI: Handler<{ id: string }, string> = typed<{ id: number }, { id: string }, string>(
  raw => ({ id: Number(raw['id']) })
)(leafI)

// param discharges id:string:
const handlerI = param('id', typedI)
type _ProbeI = typeof handlerI // expect Handler<{}, string>

run(handlerI) // [TEST I: expected PASS — full chain composes end-to-end]

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
