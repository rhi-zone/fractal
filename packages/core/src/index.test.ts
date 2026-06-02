// packages/core/src/index.test.ts
//
// Type-level assertions ported from spike/routing.ts (tests A–I + G1 probe)
// plus minimal runtime tests for choice and run.
//
// The composition unit is now Node<P,Res> = { meta, handler }.
// leaf(), choice(), capture(), typed() all produce Node.
// run() accepts Node<{}, Res>.

import { describe, it, expect } from 'vitest'
import {
  pass,
  leaf,
  choice,
  typed,
  run,
  capture,
  pipe,
  type Node,
  type Handler,
  type Req,
  type NodeMiddleware,
} from './index.ts'

// ============================================================================
// TYPE-LEVEL ASSERTIONS (compile-time checks via @ts-expect-error probes)
//
// These are ported from spike/node-reflect.ts. The runtime bodies below are
// secondary; the compile-time discipline is the primary artifact.
// ============================================================================

// ---------------------------------------------------------------------------
// TEST A — PARAM DISCHARGE via capture
// capture('id', read, leaf<{id:string}>) → Node<{}>
// ---------------------------------------------------------------------------

const leafA = leaf<{ id: string }, string>(async (req) => req.params.id)

const nodeA: Node<Record<string, never>, string> = capture(
  'id',
  (req) => (req.params as Record<string, unknown>)['id'] as string | typeof pass,
  leafA,
)

// TEST A: Omit<{id:string},'id'> = {} — assignment to Node<{}> compiles.
const _testA_check: Node<Record<string, never>, string> = nodeA

// ---------------------------------------------------------------------------
// TEST B — TYPED REFINEMENT
// typed<{id:number}>(parse)(leaf<{id:number}>) → Node<{id:string}> via P
// capture discharges → Node<{}>
// ---------------------------------------------------------------------------

const leafB_inner = leaf<{ id: number }, string>(async (req) => String(req.params.id))

const leafB_typed: Node<{ id: string }, string> = typed<
  { id: number },
  { id: string },
  string
>((raw) => ({ id: Number(raw['id']) }))(leafB_inner)

// B2: typed over full param type (P={}):
const nodeB2: Node<Record<string, never>, string> = typed<
  { id: number },
  Record<string, never>,
  string
>((raw) => ({ id: Number(raw['id']) }))(leafB_inner)

// TEST B2: fully discharged — compiles.
const _testB2_check: Node<Record<string, never>, string> = nodeB2

// Suppress unused variable warning
void leafB_typed

// ---------------------------------------------------------------------------
// TEST D — IMAGINARY-PARAM GUARD
// Node<{id:number}> correctly rejected by run (regression guard holds).
// ---------------------------------------------------------------------------

const leafD = leaf<{ id: number }, string>(async (req) => String(req.params.id))

// @ts-expect-error [TEST D: Node<{id:number}> correctly rejected by run — expected error]
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

const nodeE2_partialDischarge = capture(
  'id',
  (req) => (req.params as Record<string, unknown>)['id'] as string | typeof pass,
  subtreeE2,
)
// C={tenantId:string, id:string}, K='id', Omit<C,'id'>={tenantId:string}
type _ProbeE2_Partial = typeof nodeE2_partialDischarge // expect Node<{tenantId:string}>

// @ts-expect-error [TEST E-PROPAGATION undischarged: expected error — tenantId still required]
void run(nodeE2_partialDischarge, { params: {} as Record<string, never> })

// ---------------------------------------------------------------------------
// TEST F — NARROWER SIBLING WITHOUT SPURIOUS ERROR
// choice<{role:string}>(leafNeedsNothing, leafNeedsRole): P = {role:string}
// A node needing {role:string} cannot be passed to run (which needs {}).
// ---------------------------------------------------------------------------

const leafNeedsNothing = leaf<{ role: string }, string>(async (_req) => 'ok')
const leafNeedsRole = leaf<{ role: string }, string>(async (req) => req.params.role)

// Explicitly annotate P — the choice needs role injected from above.
const choiceF: Node<{ role: string }, string> = choice(leafNeedsNothing, leafNeedsRole)

// PROBE 1: choiceF is Node<{role:string}> — assigning to Node<{}> errors:
// @ts-expect-error [TEST F probe1: choiceF is Node<{role:string}>, not Node<{}>]
const _probeF_asEmpty: Node<Record<string, never>> = choiceF

// PROBE 2: role not discharged — correctly errors:
// @ts-expect-error [TEST F probe2: role not discharged — correctly errors]
void run(choiceF, { params: {} as Record<string, never> })

// PROBE 3: Node<{role:string}> assignable to Node<{role:string}> — trivially yes:
const _probeF_asRole: Node<{ role: string }> = choiceF

// ---------------------------------------------------------------------------
// TEST G1 — SAFETY: capture with V=string rejects number-typed child
//
// capture pins V by the child's type requirement C. The G1 proof for the HTTP
// kit's param (which pins V=string explicitly via C extends Record<K,string>)
// lives in packages/http. Here we verify that capture itself is generic: if a
// child expects {x:number}, the read function's return type must be number.
// ---------------------------------------------------------------------------

// G1 is verified in packages/http where V=string is pinned. See that package.

// ---------------------------------------------------------------------------
// TEST I — TYPED+PARAM CHAIN: realistic full composition
// leaf<{id:number}> → typed<{id:number}>(parse)(leaf) = Node<{id:string}>
// → capture → Node<{}> → run should compile
// ---------------------------------------------------------------------------

const leafI = leaf<{ id: number }, string>(async (req) => String(req.params.id))

const typedI: Node<{ id: string }, string> = typed<{ id: number }, { id: string }, string>(
  (raw) => ({ id: Number(raw['id']) }),
)(leafI)

const nodeI = capture(
  'id',
  (req) => (req.params as Record<string, unknown>)['id'] as string | typeof pass,
  typedI,
)
type _ProbeI = typeof nodeI // expect Node<{}, string>

// TEST I: full chain composes — compiles.
const _testI_check: Node<Record<string, never>, string> = nodeI

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
  it('wraps a plain async function into a Node', async () => {
    const n = leaf<Record<string, never>, string>(async (_req) => 'hello')
    expect(n.meta).toEqual({ kind: 'leaf' })
    const result = await n.handler({ params: {} as Record<string, never> })
    expect(result).toBe('hello')
  })
})

describe('run', () => {
  it('returns the result when node handler succeeds', async () => {
    const n: Node<Record<string, never>, string> = leaf(async (_req) => 'ok')
    const result = await run(n, { params: {} as Record<string, never> })
    expect(result).toBe('ok')
  })

  it('returns null when node handler passes', async () => {
    const n: Node<Record<string, never>, string> = {
      meta: { kind: 'leaf' },
      handler: async (_req) => pass,
    }
    const result = await run(n, { params: {} as Record<string, never> })
    expect(result).toBeNull()
  })
})

describe('choice', () => {
  it('returns first non-pass result', async () => {
    const n1: Node<Record<string, never>, string> = { meta: { kind: 'leaf' }, handler: async (_req) => pass }
    const n2: Node<Record<string, never>, string> = { meta: { kind: 'leaf' }, handler: async (_req) => 'second' }
    const n3: Node<Record<string, never>, string> = { meta: { kind: 'leaf' }, handler: async (_req) => 'third' }
    const n = choice(n1, n2, n3)
    expect(n.meta).toMatchObject({ kind: 'choice' })
    const result = await n.handler({ params: {} as Record<string, never> })
    expect(result).toBe('second')
  })

  it('returns pass when all nodes pass', async () => {
    const n1: Node<Record<string, never>, string> = { meta: { kind: 'leaf' }, handler: async (_req) => pass }
    const n2: Node<Record<string, never>, string> = { meta: { kind: 'leaf' }, handler: async (_req) => pass }
    const n = choice(n1, n2)
    const result = await n.handler({ params: {} as Record<string, never> })
    expect(result).toBe(pass)
  })

  it('returns pass with no nodes', async () => {
    const n = choice<Record<string, never>, string>()
    const result = await n.handler({ params: {} as Record<string, never> })
    expect(result).toBe(pass)
  })

  it('tries nodes in order and stops at first match', async () => {
    const calls: number[] = []
    const n1: Node<Record<string, never>, number> = { meta: { kind: 'leaf' }, handler: async (_req) => { calls.push(1); return pass } }
    const n2: Node<Record<string, never>, number> = { meta: { kind: 'leaf' }, handler: async (_req) => { calls.push(2); return 42 } }
    const n3: Node<Record<string, never>, number> = { meta: { kind: 'leaf' }, handler: async (_req) => { calls.push(3); return 99 } }
    const n = choice(n1, n2, n3)
    const result = await n.handler({ params: {} as Record<string, never> })
    expect(result).toBe(42)
    expect(calls).toEqual([1, 2])
  })

  it('meta includes children metas', () => {
    const n1 = leaf<Record<string, never>, string>(async () => 'a')
    const n2 = leaf<Record<string, never>, string>(async () => 'b')
    const c = choice(n1, n2)
    expect(c.meta).toEqual({ kind: 'choice', children: [{ kind: 'leaf' }, { kind: 'leaf' }] })
  })
})

describe('capture', () => {
  it('injects a value into params and calls child', async () => {
    const child = leaf<{ id: string }, string>(async (req) => req.params.id)
    const n = capture(
      'id',
      (_req) => 'injected',
      child,
    )
    expect(n.meta).toMatchObject({ kind: 'capture', name: 'id' })
    const result = await n.handler({ params: {} as Record<string, never> })
    expect(result).toBe('injected')
  })

  it('returns pass when read returns pass', async () => {
    const child = leaf<{ id: string }, string>(async (req) => req.params.id)
    const n = capture(
      'id',
      (_req) => pass,
      child,
    )
    const result = await n.handler({ params: {} as Record<string, never> })
    expect(result).toBe(pass)
  })

  it('works with numeric V (non-string transport)', async () => {
    const child = leaf<{ count: number }, number>(async (req) => req.params.count)
    const n = capture(
      'count',
      (_req) => 42,
      child,
    )
    const result = await n.handler({ params: {} as Record<string, never> })
    expect(result).toBe(42)
  })
})

describe('typed', () => {
  it('parses params and enriches the request (raw parse fn)', async () => {
    const inner = leaf<{ id: number }, number>(async (req) => req.params.id)
    const n = typed<{ id: number }, Record<string, never>, number>(
      (raw) => ({ id: Number(raw['id']) }),
    )(inner)
    expect(n.meta).toMatchObject({ kind: 'typed' })
    const result = await n.handler({ params: { id: '7' } as unknown as Record<string, never> })
    expect(result).toBe(7)
  })

  it('parses params and enriches the request (StandardSchemaV1 fixture)', async () => {
    // Hand-rolled StandardSchemaV1 fixture — no real validator dep
    const testSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate(value: unknown) {
          if (
            typeof value === 'object' &&
            value !== null &&
            typeof (value as Record<string, unknown>)['id'] === 'string'
          ) {
            return { value: { id: Number((value as Record<string, unknown>)['id']) } }
          }
          return { issues: [{ message: 'expected {id:string}' }] }
        },
        jsonSchema: {
          input: (_opts: { target: string }) => ({ type: 'object', properties: { id: { type: 'string' } } }),
          output: (_opts: { target: string }) => ({ type: 'object', properties: { id: { type: 'number' } } }),
        },
      },
    }

    const inner = leaf<{ id: number }, number>(async (req) => req.params.id)
    const n = typed<{ id: number }, Record<string, never>, number>(testSchema)(inner)
    expect(n.meta).toMatchObject({ kind: 'typed' })
    // schema should be the output JSON-Schema from the fixture
    expect((n.meta as { schema: unknown }).schema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'number' } },
    })
    const result = await n.handler({ params: { id: '7' } as unknown as Record<string, never> })
    expect(result).toBe(7)
  })

  it('throws on invalid input with StandardSchemaV1', async () => {
    type IdOut = { id: number }
    const failSchema: import('./index.ts').StandardSchemaV1<Record<string, unknown>, IdOut> = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate(_value: unknown): import('./index.ts').StandardSchemaV1.Result<IdOut> {
          return { issues: [{ message: 'always fails' }] }
        },
      },
    }
    const inner = leaf<IdOut, number>(async (req) => req.params.id)
    const n = typed<IdOut, Record<string, never>, number>(failSchema)(inner)
    await expect(
      n.handler({ params: {} as Record<string, never> }),
    ).rejects.toThrow('always fails')
  })
})

describe('pipe', () => {
  it('composes NodeMiddlewares left-to-right', async () => {
    const log: string[] = []
    const mw1: NodeMiddleware<Record<string, never>, string> = (inner) => ({
      meta: { kind: 'pipe', metas: [{ kind: 'mw1' }], child: inner.meta },
      handler: async (req) => {
        log.push('mw1-before')
        const r = await inner.handler(req)
        log.push('mw1-after')
        return r
      },
    })
    const mw2: NodeMiddleware<Record<string, never>, string> = (inner) => ({
      meta: { kind: 'pipe', metas: [{ kind: 'mw2' }], child: inner.meta },
      handler: async (req) => {
        log.push('mw2-before')
        const r = await inner.handler(req)
        log.push('mw2-after')
        return r
      },
    })
    const base = leaf<Record<string, never>, string>(async (_req) => 'done')
    const n = pipe(mw1, mw2)(base)
    await n.handler({ params: {} as Record<string, never> })
    // pipe(mw1,mw2)(base) = reduceRight([mw1,mw2], (acc,mw)=>mw(acc), base)
    // = mw1(mw2(base)): mw1 is outermost, executes first
    // execution order: mw1-before → mw2-before → mw2-after → mw1-after
    expect(log).toEqual(['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after'])
  })
})

// Ensure Handler is still exported as the executable function type
const _handlerTypeCheck: Handler<Record<string, never>, string> = async (_req) => 'ok'
void _handlerTypeCheck

// Ensure Req is still exported
const _reqTypeCheck: Req<{ x: string }> = { params: { x: 'hello' } }
void _reqTypeCheck
