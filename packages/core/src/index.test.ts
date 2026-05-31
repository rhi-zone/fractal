import { describe, it, expect } from 'vitest'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
  ok,
  err,
  leaf,
  streamLeaf,
  branch,
  annotate,
  identity,
  withAuth,
  withRateLimit,
  check,
  validated,
  client,
  evaluate,
  evaluateStream,
  type Context,
  type ErrorOf,
  type InputOf,
  type OutputOf,
  type AnyNode,
  type ModeOf,
  type UClient,
  type Client,
  type Meta,
  type Result,
} from './index.ts'

// A hand-rolled Standard Schema fixture (no real validator dependency).
const numberSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v: unknown) =>
      typeof v === 'number' ? { value: v } : { issues: [{ message: 'not a number' }] },
    jsonSchema: { input: () => ({ type: 'number' }), output: () => ({ type: 'number' }) },
    types: undefined,
  },
} as unknown as StandardSchemaV1<unknown, number>

// An ASYNC-validate fixture: validate resolves a Promise.
const asyncNumberSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: async (v: unknown) =>
      typeof v === 'number' ? { value: v } : { issues: [{ message: 'not a number' }] },
    jsonSchema: { input: () => ({ type: 'number' }), output: () => ({ type: 'number' }) },
    types: undefined,
  },
} as unknown as StandardSchemaV1<unknown, number>

// ============================================================================
// TYPE-LEVEL ASSERTIONS
// ============================================================================

// Tiny static assertion helpers (compile-time only).
type Expect<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Extends<A, B> = A extends B ? true : false

describe('type-level: self-describing capabilities (no central error map)', () => {
  it('each capability widens ErrorOf by its OWN declared error', () => {
    const base = leaf<string, number, { code: 'bad_input' }>((i) => ok(i.length))
    const authed = withAuth(base)
    const both = withRateLimit(authed)

    type EAuth = ErrorOf<typeof authed>
    type EBoth = ErrorOf<typeof both>

    // auth contributes { code: 'unauthorized' }; base error retained.
    type _a1 = Expect<Extends<{ code: 'unauthorized' }, EAuth>>
    type _a2 = Expect<Extends<{ code: 'bad_input' }, EAuth>>
    // rate-limit contributes its own { code: 'rate_limited' } independently.
    type _b1 = Expect<Extends<{ code: 'rate_limited' }, EBoth>>
    type _b2 = Expect<Extends<{ code: 'unauthorized' }, EBoth>>
    type _b3 = Expect<Extends<{ code: 'bad_input' }, EBoth>>

    const e: EBoth = { code: 'unauthorized' }
    // @ts-expect-error — a code no capability contributed is NOT in the union (load-bearing)
    const bad: EBoth = { code: 'nonexistent' }
    void e
    void bad
    expect(true).toBe(true)
  })
})

describe('type-level: .then / .pipe is a type-checked chain', () => {
  it('threads types and rejects mismatched output→input', () => {
    const a = leaf<string, number, { code: 'a' }>((i) => ok(i.length))
    const b = leaf<number, boolean, { code: 'b' }>((i) => ok(i > 0))
    const bad = leaf<string, boolean, { code: 'c' }>((i) => ok(i.length > 0))

    const chained = a.then(b)
    type CIn = InputOf<typeof chained>
    type COut = OutputOf<typeof chained>
    type CErr = ErrorOf<typeof chained>
    type _ti = Expect<Equal<CIn, string>>
    type _to = Expect<Equal<COut, boolean>>
    type _te1 = Expect<Extends<{ code: 'a' }, CErr>>
    type _te2 = Expect<Extends<{ code: 'b' }, CErr>>

    // still a reflectable seq data node
    expect(chained.tag).toBe('seq')

    // @ts-expect-error — OutputOf(a)=number not assignable to InputOf(bad)=string (load-bearing)
    const broken = a.then(bad)
    void broken
    expect(true).toBe(true)
  })
})

describe('type-level: gradual typing', () => {
  it('an untyped leaf infers unknown I/O and never error', () => {
    const u = leaf((i) => ok(i))
    type UIn = InputOf<typeof u>
    type UOut = OutputOf<typeof u>
    type UErr = ErrorOf<typeof u>
    type _i = Expect<Equal<UIn, unknown>>
    type _o = Expect<Equal<UOut, unknown>>
    type _e = Expect<Equal<UErr, never>>
    expect(u.tag).toBe('leaf')
  })
})

// ============================================================================
// TYPE-LEVEL ASSERTIONS — STREAMING
// ============================================================================

describe('type-level: streaming leaves + UClient derivation', () => {
  it('(a) existing unary endpoints derive byte-identical Promise<Result<…>>', () => {
    const u = leaf<string, number, { code: 'bad' }>((i) => ok(i.length))
    type CU = Client<typeof u>
    // The unary client method shape: (input, meta?) => Promise<Result<O,E>>.
    type Expected = (input: string, meta?: Meta) => Promise<Result<number, { code: 'bad' }>>
    type _eq = Expect<Equal<CU, Expected>>
    // UClient and Client coincide for a unary node.
    type _alias = Expect<Equal<UClient<typeof u>, Client<typeof u>>>
    // A unary node is mode 'unary'.
    type _m = Expect<Equal<ModeOf<typeof u>, 'unary'>>
    expect(u.tag).toBe('leaf')
  })

  it('(b) a streamLeaf derives (input, meta?) => AsyncIterable<Result<O,E>>', () => {
    const s = streamLeaf<number, string, { code: 'se' }>(async function* (i) {
      yield ok(String(i))
    })
    type CS = UClient<typeof s>
    type Expected = (input: number, meta?: Meta) => AsyncIterable<Result<string, { code: 'se' }>>
    type _eq = Expect<Equal<CS, Expected>>
    type _m = Expect<Equal<ModeOf<typeof s>, 'stream'>>
    expect(s.mode).toBe('stream')
  })

  it('(c) stream composed under seq/annotated/capability stays streaming with the cap error in the per-item union', () => {
    const setup = leaf<number, number>((i) => ok(i))
    const producer = streamLeaf<number, string, { code: 'pe' }>(async function* (i) {
      yield ok(String(i))
    })
    // seq: unary head .then streaming tail ⇒ the seq is streaming (tail rule).
    const piped = setup.then(producer)
    type _mseq = Expect<Equal<ModeOf<typeof piped>, 'stream'>>

    // annotated over a stream stays streaming.
    const tagged = annotate({ kind: 'doc', value: 'x' }, producer)
    type _mann = Expect<Equal<ModeOf<typeof tagged>, 'stream'>>

    // capability over a stream stays streaming AND widens the per-item error.
    const authed = withAuth(producer)
    type _mcap = Expect<Equal<ModeOf<typeof authed>, 'stream'>>
    type CAuth = UClient<typeof authed>
    // The yielded element type must include the capability's error.
    type Elem = CAuth extends (input: any, meta?: Meta) => AsyncIterable<infer R> ? R : never
    type _eItem = Expect<Extends<{ code: 'unauthorized' }, Elem extends Result<any, infer E> ? E : never>>
    type _eItem2 = Expect<Extends<{ code: 'pe' }, Elem extends Result<any, infer E> ? E : never>>
    expect(piped.tag).toBe('seq')
  })

  it('(d) treating a stream method result as a Promise is a type error; (e) meta? is optional', () => {
    const s = streamLeaf<number, string>(async function* () {
      yield ok('x')
    })
    const c = client(s, { ctx: { caps: {} } }) as UClient<typeof s>
    // (e) meta? is optional — both call shapes type-check.
    const it0 = c(1)
    const it1 = c(1, { trace: 'abc' })
    void it0
    void it1
    // (d) the result is an AsyncIterable, NOT a Promise. Awaiting/assigning to
    // Promise must be a type error (load-bearing).
    // @ts-expect-error — a stream method returns AsyncIterable, not Promise (load-bearing)
    const asPromise: Promise<unknown> = c(1)
    void asPromise
    expect(true).toBe(true)
  })
})

// ============================================================================
// RUNTIME + LAWS (deterministic seeded sampler — fast-check not on disk here)
// ============================================================================

// Minimal deterministic PRNG (mulberry32) so property tests are reproducible
// without a network/dependency install.
const sampler = (seed: number) => {
  let s = seed >>> 0
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SAMPLES = 200
const ctx: Context = { caps: {} }
const run = (n: AnyNode, i: unknown) => evaluate(n, i, ctx)

describe('law: .then associativity', () => {
  it('(a.then(b)).then(c) ≡ a.then(b.then(c)) for all inputs', async () => {
    const rnd = sampler(1)
    const a = leaf<number, number>((i) => ok(i + 1))
    const b = leaf<number, number>((i) => ok(i * 2))
    const c = leaf<number, number>((i) => ok(i - 3))
    const left = a.then(b).then(c)
    const right = a.then(b.then(c))
    for (let k = 0; k < SAMPLES; k++) {
      const x = Math.floor(rnd() * 2000) - 1000
      const l = await run(left, x)
      const r = await run(right, x)
      expect(l).toEqual(r)
    }
  })
})

describe('law: identity is the chain unit', () => {
  it('a.then(identity()) ≡ a ≡ identity().then(a)', async () => {
    const rnd = sampler(2)
    const a = leaf<number, number>((i) => ok(i * 7 + 1))
    const pre = identity<number>().then(a)
    const post = a.then(identity<number>())
    for (let k = 0; k < SAMPLES; k++) {
      const x = Math.floor(rnd() * 2000) - 1000
      const base = await run(a, x)
      expect(await run(pre, x)).toEqual(base)
      expect(await run(post, x)).toEqual(base)
    }
  })
})

describe('law: annotation transparency (metadata never changes behavior)', () => {
  it('annotate(meta, node) ≡ node on success', async () => {
    const rnd = sampler(3)
    const a = leaf<number, number>((i) => ok(i % 5))
    const tagged = annotate({ kind: 'doc', value: 'hello' }, a)
    for (let k = 0; k < SAMPLES; k++) {
      const x = Math.floor(rnd() * 2000) - 1000
      expect(await run(tagged, x)).toEqual(await run(a, x))
    }
  })
})

describe('law: branch dispatch totality', () => {
  it('every child key resolves and runs', async () => {
    const tree = branch({
      inc: leaf<number, number>((i) => ok(i + 1)),
      dec: leaf<number, number>((i) => ok(i - 1)),
    })
    const c = client(tree, { ctx })
    expect(await c.inc(10)).toEqual(ok(11))
    expect(await c.dec(10)).toEqual(ok(9))
    // totality: every declared key is reachable
    for (const key of Object.keys(tree.children)) {
      expect(typeof (c as Record<string, unknown>)[key]).toBe('function')
    }
  })
})

// ============================================================================
// BEHAVIOR: capabilities, seq error short-circuit, validated stage
// ============================================================================

describe('capability enforcement', () => {
  it('withAuth blocks when no user, passes when present, and returns its error', async () => {
    const handler = leaf<string, string, never, { auth: { user: string | null } }>(
      (i) => ok(`hi ${i}`),
    )
    const guarded = withAuth(handler)
    const denied = await evaluate(guarded, 'bob', { caps: { auth: { user: null } } })
    expect(denied).toEqual(err({ code: 'unauthorized' }))
    const allowed = await evaluate(guarded, 'bob', { caps: { auth: { user: 'alice' } } })
    expect(allowed).toEqual(ok('hi bob'))
  })

  it('withRateLimit injects its own independent error', async () => {
    const handler = leaf<number, number>((i) => ok(i))
    const limited = withRateLimit(handler)
    let allow = true
    const caps = { limiter: { take: () => allow } }
    expect(await evaluate(limited, 1, { caps })).toEqual(ok(1))
    allow = false
    expect(await evaluate(limited, 1, { caps })).toEqual(err({ code: 'rate_limited' }))
  })
})

describe('seq short-circuits on error', () => {
  it('right stage is skipped when left errors', async () => {
    let rightRan = false
    const left = leaf<number, number, { code: 'boom' }>(() => err({ code: 'boom' }))
    const right = leaf<number, number>((i) => {
      rightRan = true
      return ok(i)
    })
    const seq = left.then(right)
    expect(await run(seq, 1)).toEqual(err({ code: 'boom' }))
    expect(rightRan).toBe(false)
  })
})

describe('validated seq stage (Standard Schema)', () => {
  it('validates unknown→T via a Standard Schema and joins the error union', async () => {
    const square = leaf<number, number>((i) => ok(i * i))
    const pipeline = validated(numberSchema).then(square)
    expect(await run(pipeline, 4)).toEqual(ok(16))
    expect(await run(pipeline, 'x')).toEqual(err({ code: 'invalid', message: 'not a number' }))
  })

  it('wraps the validating leaf in an inert kind:schema / role:input annotation', () => {
    const node = validated(numberSchema)
    expect(node.tag).toBe('annotated')
    expect(node.annotation.kind).toBe('schema')
    const value = node.annotation.value as { role: string; schema: unknown }
    expect(value.role).toBe('input')
    expect(value.schema).toBe(numberSchema)
    // No enforce gate ⇒ inert: interpreters walk it transparently.
    expect('enforce' in (node.annotation.value as object)).toBe(false)
    expect(node.child.tag).toBe('leaf')
  })

  it('supports an async validate (Promise-returning) schema', async () => {
    const square = leaf<number, number>((i) => ok(i * i))
    const pipeline = validated(asyncNumberSchema).then(square)
    expect(await run(pipeline, 5)).toEqual(ok(25))
    expect(await run(pipeline, 'x')).toEqual(err({ code: 'invalid', message: 'not a number' }))
  })
})

describe('check raw-parse stage', () => {
  it('parses unknown→T from a raw parse fn and joins the error union', async () => {
    const parseNum = check<number>((i) =>
      typeof i === 'number' ? ok(i) : err({ code: 'invalid', message: 'not a number' }),
    )
    const square = leaf<number, number>((i) => ok(i * i))
    const pipeline = parseNum.then(square)
    expect(await run(pipeline, 4)).toEqual(ok(16))
    expect(await run(pipeline, 'x')).toEqual(err({ code: 'invalid', message: 'not a number' }))
  })
})

describe('node reflectability', () => {
  it('structure is inspectable without running code', () => {
    const tree = branch({
      a: annotate({ kind: 'doc', value: 'x' }, leaf((i) => ok(i))),
    })
    expect(tree.tag).toBe('branch')
    const childA = tree.children.a
    expect(childA.tag).toBe('annotated')
    expect(childA.annotation.kind).toBe('doc')
    expect(childA.child.tag).toBe('leaf')
  })
})

// ============================================================================
// RUNTIME: streaming leaves
// ============================================================================

describe('streaming leaf runtime', () => {
  it('evaluateStream yields each Result of an async-generator leaf', async () => {
    const s = streamLeaf<number, number, never>(async function* (n) {
      for (let k = 0; k < n; k++) yield ok(k)
    })
    const got: Array<Result<number, never>> = []
    for await (const r of evaluateStream(s, 3, { caps: {} })) {
      got.push(r as Result<number, never>)
    }
    expect(got).toEqual([ok(0), ok(1), ok(2)])
  })

  it('a streaming client method returns an AsyncIterable of Results', async () => {
    const s = streamLeaf<string, string>(async function* (prefix) {
      yield ok(`${prefix}-a`)
      yield ok(`${prefix}-b`)
    })
    const c = client(s, { ctx: { caps: {} } }) as UClient<typeof s>
    const out: Array<Result<string, never>> = []
    for await (const r of c('x')) out.push(r as Result<string, never>)
    expect(out).toEqual([ok('x-a'), ok('x-b')])
  })

  it('stops yielding when the AbortSignal fires (cancellation)', async () => {
    const ac = new AbortController()
    let produced = 0
    const s = streamLeaf<void, number, never>(async function* () {
      for (let k = 0; k < 1000; k++) {
        produced++
        yield ok(k)
      }
    })
    const seen: number[] = []
    for await (const r of evaluateStream(s, undefined, { caps: {}, signal: ac.signal })) {
      if (r.ok) seen.push(r.value as number)
      if (seen.length === 3) ac.abort()
    }
    // The loop stops pulling after abort: we saw the 3 emitted before aborting,
    // and the interpreter ceased iterating rather than draining all 1000.
    expect(seen).toEqual([0, 1, 2])
    expect(produced).toBeLessThan(1000)
  })

  it('a capability gate on a stream denies by yielding its error and stopping', async () => {
    const producer = streamLeaf<string, string, never>(async function* (i) {
      yield ok(`hi ${i}`)
    })
    const guarded = withAuth(producer)
    const denied: Array<Result<string, unknown>> = []
    for await (const r of evaluateStream(guarded, 'bob', { caps: { auth: { user: null } } })) {
      denied.push(r as Result<string, unknown>)
    }
    expect(denied).toEqual([err({ code: 'unauthorized' })])

    const allowed: Array<Result<string, unknown>> = []
    for await (const r of evaluateStream(guarded, 'bob', { caps: { auth: { user: 'alice' } } })) {
      allowed.push(r as Result<string, unknown>)
    }
    expect(allowed).toEqual([ok('hi bob')])
  })

  it('unary head .then streaming tail threads the head output into the stream', async () => {
    const setup = leaf<number, number>((i) => ok(i + 10))
    const producer = streamLeaf<number, number, never>(async function* (base) {
      yield ok(base)
      yield ok(base + 1)
    })
    const piped = setup.then(producer)
    const out: number[] = []
    for await (const r of evaluateStream(piped, 5, { caps: {} })) {
      if (r.ok) out.push(r.value as number)
    }
    expect(out).toEqual([15, 16])
  })
})
