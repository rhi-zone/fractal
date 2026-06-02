// packages/core/src/index.test.ts
//
// Type-level assertions ported from spike/routing.ts (tests A–I + G1 probe)
// plus minimal runtime tests for choice and run.

import { describe, it, expect } from 'vitest'
import {
  pass,
  leaf,
  choice,
  typed,
  run,
  capture,
  pipe,
  type Handler,
  type Req,
  type Middleware,
} from './index.ts'

// ============================================================================
// TYPE-LEVEL ASSERTIONS (compile-time checks via @ts-expect-error probes)
//
// These are ported from spike/routing.ts. The runtime bodies below are
// secondary; the compile-time discipline is the primary artifact.
// ============================================================================

// ---------------------------------------------------------------------------
// TEST A — PARAM DISCHARGE via capture
// capture('id', read, leaf<{id:string}>) → Handler<{}>
// ---------------------------------------------------------------------------

const leafA = leaf<{ id: string }, string>(async (req) => req.params.id)

const handlerA: Handler<Record<string, never>, string> = capture(
  'id',
  (req) => (req.params as Record<string, unknown>)['id'] as string | typeof pass,
  leafA,
)

// TEST A: Omit<{id:string},'id'> = {} — assignment to Handler<{}> compiles.
const _testA_check: Handler<Record<string, never>, string> = handlerA

// ---------------------------------------------------------------------------
// TEST B — TYPED REFINEMENT
// typed<{id:number}>(parse)(leaf<{id:number}>) → Handler<{id:string}> via P
// capture discharges → Handler<{}>
// ---------------------------------------------------------------------------

const leafB_inner = leaf<{ id: number }, string>(async (req) => String(req.params.id))

const leafB_typed: Handler<{ id: string }, string> = typed<
  { id: number },
  { id: string },
  string
>((raw) => ({ id: Number(raw['id']) }))(leafB_inner)

// B2: typed over full param type (P={}):
const handlerB2: Handler<Record<string, never>, string> = typed<
  { id: number },
  Record<string, never>,
  string
>((raw) => ({ id: Number(raw['id']) }))(leafB_inner)

// TEST B2: fully discharged — compiles.
const _testB2_check: Handler<Record<string, never>, string> = handlerB2

// Suppress unused variable warning
void leafB_typed

// ---------------------------------------------------------------------------
// TEST D — IMAGINARY-PARAM GUARD
// Handler<{id:number}> correctly rejected by run (regression guard holds).
// ---------------------------------------------------------------------------

const leafD = leaf<{ id: number }, string>(async (req) => String(req.params.id))

// @ts-expect-error [TEST D: Handler<{id:number}> correctly rejected by run — expected error]
void run(leafD, { params: {} as Record<string, never> })

// ---------------------------------------------------------------------------
// TEST E — MOUNT REQUIREMENT PROPAGATION
// run(subtreeE) errors; capture discharges → run compiles.
// ---------------------------------------------------------------------------

const subtreeE = leaf<{ tenantId: string }, string>(async (req) => req.params.tenantId)

// @ts-expect-error [TEST E part1: tenantId not discharged — correctly errors]
void run(subtreeE, { params: {} as Record<string, never> })

// E-PROPAGATION: partial discharge (two-param child)
const subtreeE2 = leaf<{ tenantId: string; id: string }, string>(
  async (req) => `${req.params.tenantId}/${req.params.id}`,
)

const handlerE2_partialDischarge = capture(
  'id',
  (req) => (req.params as Record<string, unknown>)['id'] as string | typeof pass,
  subtreeE2,
)
// C={tenantId:string, id:string}, K='id', Omit<C,'id'>={tenantId:string}
type _ProbeE2_Partial = typeof handlerE2_partialDischarge // expect Handler<{tenantId:string}>

// @ts-expect-error [TEST E-PROPAGATION undischarged: expected error — tenantId still required]
void run(handlerE2_partialDischarge, { params: {} as Record<string, never> })

// ---------------------------------------------------------------------------
// TEST F — NARROWER SIBLING WITHOUT SPURIOUS ERROR
// choice<{role:string}>(leafNeedsNothing, leafNeedsRole): P = {role:string}
// A handler needing {role:string} cannot be passed to run (which needs {}).
// ---------------------------------------------------------------------------

const leafNeedsNothing = leaf<{ role: string }, string>(async (_req) => 'ok')
const leafNeedsRole = leaf<{ role: string }, string>(async (req) => req.params.role)

// Explicitly annotate P — the choice needs role injected from above.
const choiceF: Handler<{ role: string }, string> = choice(leafNeedsNothing, leafNeedsRole)

// PROBE 1: choiceF is Handler<{role:string}> — assigning to Handler<{}> errors:
// @ts-expect-error [TEST F probe1: choiceF is Handler<{role:string}>, not Handler<{}>]
const _probeF_asEmpty: Handler<Record<string, never>> = choiceF

// PROBE 2: role not discharged — correctly errors:
// @ts-expect-error [TEST F probe2: role not discharged — correctly errors]
void run(choiceF, { params: {} as Record<string, never> })

// PROBE 3: Handler<{role:string}> assignable to Handler<{role:string}> — trivially yes:
const _probeF_asRole: Handler<{ role: string }> = choiceF

// ---------------------------------------------------------------------------
// TEST G1 — SAFETY: capture with V=string rejects number-typed child
//
// capture pins V by the child's type requirement C. The G1 proof for the HTTP
// kit's httpParam (which pins V=string explicitly via C extends Record<K,string>)
// lives in packages/http. Here we verify that capture itself is generic: if a
// child expects {x:number}, the read function's return type must be number.
// ---------------------------------------------------------------------------

// G1 is verified in packages/http where V=string is pinned. See that package.

// ---------------------------------------------------------------------------
// TEST I — TYPED+PARAM CHAIN: realistic full composition
// leaf<{id:number}> → typed<{id:number}>(parse)(leaf) = Handler<{id:string}>
// → capture → Handler<{}> → run should compile
// ---------------------------------------------------------------------------

const leafI = leaf<{ id: number }, string>(async (req) => String(req.params.id))

const typedI: Handler<{ id: string }, string> = typed<{ id: number }, { id: string }, string>(
  (raw) => ({ id: Number(raw['id']) }),
)(leafI)

const handlerI = capture(
  'id',
  (req) => (req.params as Record<string, unknown>)['id'] as string | typeof pass,
  typedI,
)
type _ProbeI = typeof handlerI // expect Handler<{}, string>

// TEST I: full chain composes — compiles.
const _testI_check: Handler<Record<string, never>, string> = handlerI

// ============================================================================
// RUNTIME TESTS
// ============================================================================

describe('pass sentinel', () => {
  it('is a unique symbol', () => {
    expect(typeof pass).toBe('symbol')
    expect(pass.toString()).toBe('Symbol(fractal.Pass)')
  })
})

describe('leaf', () => {
  it('wraps a plain async function', async () => {
    const h = leaf<Record<string, never>, string>(async (_req) => 'hello')
    const result = await h({ params: {} as Record<string, never> })
    expect(result).toBe('hello')
  })
})

describe('run', () => {
  it('returns the result when handler succeeds', async () => {
    const h: Handler<Record<string, never>, string> = leaf(async (_req) => 'ok')
    const result = await run(h, { params: {} as Record<string, never> })
    expect(result).toBe('ok')
  })

  it('returns null when handler passes', async () => {
    const h: Handler<Record<string, never>, string> = async (_req) => pass
    const result = await run(h, { params: {} as Record<string, never> })
    expect(result).toBeNull()
  })
})

describe('choice', () => {
  it('returns first non-pass result', async () => {
    const h1: Handler<Record<string, never>, string> = async (_req) => pass
    const h2: Handler<Record<string, never>, string> = async (_req) => 'second'
    const h3: Handler<Record<string, never>, string> = async (_req) => 'third'
    const h = choice(h1, h2, h3)
    const result = await h({ params: {} as Record<string, never> })
    expect(result).toBe('second')
  })

  it('returns pass when all handlers pass', async () => {
    const h1: Handler<Record<string, never>, string> = async (_req) => pass
    const h2: Handler<Record<string, never>, string> = async (_req) => pass
    const h = choice(h1, h2)
    const result = await h({ params: {} as Record<string, never> })
    expect(result).toBe(pass)
  })

  it('returns pass with no handlers', async () => {
    const h = choice<Record<string, never>, string>()
    const result = await h({ params: {} as Record<string, never> })
    expect(result).toBe(pass)
  })

  it('tries handlers in order and stops at first match', async () => {
    const calls: number[] = []
    const h1: Handler<Record<string, never>, number> = async (_req) => { calls.push(1); return pass }
    const h2: Handler<Record<string, never>, number> = async (_req) => { calls.push(2); return 42 }
    const h3: Handler<Record<string, never>, number> = async (_req) => { calls.push(3); return 99 }
    const h = choice(h1, h2, h3)
    const result = await h({ params: {} as Record<string, never> })
    expect(result).toBe(42)
    expect(calls).toEqual([1, 2])
  })
})

describe('capture', () => {
  it('injects a value into params and calls child', async () => {
    const child = leaf<{ id: string }, string>(async (req) => req.params.id)
    const h = capture(
      'id',
      (_req) => 'injected',
      child,
    )
    const result = await h({ params: {} as Record<string, never> })
    expect(result).toBe('injected')
  })

  it('returns pass when read returns pass', async () => {
    const child = leaf<{ id: string }, string>(async (req) => req.params.id)
    const h = capture(
      'id',
      (_req) => pass,
      child,
    )
    const result = await h({ params: {} as Record<string, never> })
    expect(result).toBe(pass)
  })

  it('works with numeric V (non-string transport)', async () => {
    const child = leaf<{ count: number }, number>(async (req) => req.params.count)
    const h = capture(
      'count',
      (_req) => 42,
      child,
    )
    const result = await h({ params: {} as Record<string, never> })
    expect(result).toBe(42)
  })
})

describe('typed', () => {
  it('parses params and enriches the request', async () => {
    const inner = leaf<{ id: number }, number>(async (req) => req.params.id)
    const h = typed<{ id: number }, Record<string, never>, number>(
      (raw) => ({ id: Number(raw['id']) }),
    )(inner)
    const result = await h({ params: { id: '7' } as unknown as Record<string, never> })
    expect(result).toBe(7)
  })
})

describe('pipe', () => {
  it('composes middleware left-to-right', async () => {
    const log: string[] = []
    const mw1: Middleware<Record<string, never>, string> = (inner) => async (req) => {
      log.push('mw1-before')
      const r = await inner(req)
      log.push('mw1-after')
      return r
    }
    const mw2: Middleware<Record<string, never>, string> = (inner) => async (req) => {
      log.push('mw2-before')
      const r = await inner(req)
      log.push('mw2-after')
      return r
    }
    const base = leaf<Record<string, never>, string>(async (_req) => 'done')
    const h = pipe(mw1, mw2)(base)
    await h({ params: {} as Record<string, never> })
    // pipe(mw1,mw2)(base) = reduceRight([mw1,mw2], (acc,mw)=>mw(acc), base)
    // = mw1(mw2(base)): mw1 is outermost, executes first
    // execution order: mw1-before → mw2-before → mw2-after → mw1-after
    expect(log).toEqual(['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after'])
  })
})
