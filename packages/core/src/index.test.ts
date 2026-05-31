import { describe, it, expect } from 'vitest'
import {
  ok,
  err,
  leaf,
  branch,
  annotate,
  identity,
  withAuth,
  withRateLimit,
  validated,
  client,
  evaluate,
  type Context,
  type ErrorOf,
  type InputOf,
  type OutputOf,
  type AnyNode,
} from './index.ts'

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

describe('validated seq stage', () => {
  it('parses unknown→T and joins the error union', async () => {
    const parseNum = validated<number>((i) =>
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
