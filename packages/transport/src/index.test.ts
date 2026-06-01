import { describe, it, expect } from 'vitest'
import {
  ok,
  err,
  leaf,
  streamLeaf,
  branch,
  methods,
  withAuth,
  check,
} from '@rhi-zone/fractal-core'
import { dispatcher, clientOver, type Transport, type DispatchRequest } from './index.ts'

const req = (over: Partial<DispatchRequest>): DispatchRequest => ({
  path: [],
  input: undefined,
  raw: undefined,
  ...over,
})

describe('dispatcher: generalized walk (branch path + grant + delegate to core)', () => {
  it('routes by path and 404s unknown routes', async () => {
    const tree = branch({
      users: branch({ list: leaf<unknown, string[]>(() => ok(['a', 'b'])) }),
    })
    const dispatch = dispatcher(tree)
    const hit = await dispatch(req({ path: ['users', 'list'] }))
    expect(hit).toEqual({ kind: 'unary', result: { ok: true, value: ['a', 'b'] } })
    const miss = await dispatch(req({ path: ['users', 'missing'] }))
    expect(miss.kind).toBe('unary')
    if (miss.kind === 'unary') expect((miss.result as { ok: boolean }).ok).toBe(false)
  })

  it('grants ONLY the matched capability handle and enforces its gate', async () => {
    const me = leaf<unknown, string, never, { auth: { user: string | null } }>(
      (_i, ctx) => ok(`hello ${ctx.caps.auth.user}`),
    )
    const tree = branch({ me: withAuth(me) })

    const noGrant = dispatcher(tree)
    const denied = await noGrant(req({ path: ['me'] }))
    expect(denied).toEqual({ kind: 'unary', result: { ok: false, error: { code: 'unauthorized' } } })

    const withGrant = dispatcher(tree, {
      grants: { auth: (r) => ({ auth: { user: (r.input as { user?: string })?.user ?? null } }) },
    })
    const allowed = await withGrant(req({ path: ['me'], input: { user: 'alice' } }))
    expect(allowed).toEqual({ kind: 'unary', result: { ok: true, value: 'hello alice' } })
  })

  it('delegates seq semantics to core (validation short-circuit)', async () => {
    const parse = check<{ n: number }>((i) =>
      typeof (i as { n?: unknown })?.n === 'number'
        ? ok(i as { n: number })
        : err({ code: 'invalid', message: 'n must be a number' }),
    )
    const double = leaf<{ n: number }, number>((i) => ok(i.n * 2))
    const dispatch = dispatcher(branch({ double: parse.then(double) }))
    expect(await dispatch(req({ path: ['double'], input: { n: 21 } }))).toEqual({ kind: 'unary', result: { ok: true, value: 42 } })
    const bad = await dispatch(req({ path: ['double'], input: { n: 'x' } }))
    if (bad.kind === 'unary' && !bad.result.ok) expect((bad.result.error as { code: string }).code).toBe('invalid')
  })

  it('reports a streaming leaf as a stream outcome', async () => {
    const counter = streamLeaf<number, number>(async function* (n) {
      for (let i = 0; i < n; i++) yield ok(i)
    })
    const dispatch = dispatcher(branch({ count: counter }))
    const outcome = await dispatch(req({ path: ['count'], input: 3 }))
    expect(outcome.kind).toBe('stream')
    if (outcome.kind === 'stream') {
      const got: unknown[] = []
      for await (const r of outcome.stream) got.push(r)
      expect(got).toEqual([{ ok: true, value: 0 }, { ok: true, value: 1 }, { ok: true, value: 2 }])
    }
  })
})

describe('dispatcher: methods node — dispatch by HTTP method, NOT by path segment', () => {
  const tree = branch({
    users: branch({
      list: methods({
        GET: leaf<unknown, string[]>(() => ok(['a', 'b'])),
        POST: check<{ name: string }>((i) =>
          typeof (i as { name?: unknown })?.name === 'string'
            ? ok(i as { name: string })
            : err({ code: 'invalid', message: 'name required' }),
        ).then(leaf<{ name: string }, string>((b) => ok(`created ${b.name}`))),
      }),
    }),
  })
  const dispatch = dispatcher(tree)

  it('selects the GET handler at /users/list (no extra path segment consumed)', async () => {
    const r = await dispatch(req({ path: ['users', 'list'], method: 'GET' }))
    expect(r).toEqual({ kind: 'unary', result: { ok: true, value: ['a', 'b'] } })
  })

  it('selects the POST handler at the SAME path, composing the seq subtree', async () => {
    const r = await dispatch(req({ path: ['users', 'list'], method: 'POST', input: { name: 'al' } }))
    expect(r).toEqual({ kind: 'unary', result: { ok: true, value: 'created al' } })
  })

  it('matches the method case-insensitively', async () => {
    const r = await dispatch(req({ path: ['users', 'list'], method: 'get' }))
    expect(r).toEqual({ kind: 'unary', result: { ok: true, value: ['a', 'b'] } })
  })

  it('405s an unmapped verb, listing the allowed verbs', async () => {
    const r = await dispatch(req({ path: ['users', 'list'], method: 'DELETE' }))
    expect(r.kind).toBe('unary')
    if (r.kind === 'unary' && !r.result.ok) {
      const e = r.result.error as { code: string; allow: string[] }
      expect(e.code).toBe('method_not_allowed')
      expect(e.allow.sort()).toEqual(['GET', 'POST'])
    }
  })

  it('falls back to defaultVerb (POST) when no method is present (non-HTTP transport)', async () => {
    const r = await dispatch(req({ path: ['users', 'list'], input: { name: 'def' } }))
    expect(r).toEqual({ kind: 'unary', result: { ok: true, value: 'created def' } })
  })

  it('defaultVerb is the first declared verb when POST is absent', async () => {
    const t = branch({
      thing: methods({
        GET: leaf<unknown, string>(() => ok('read')),
        PUT: leaf<unknown, string>(() => ok('replaced')),
      }),
    })
    const d = dispatcher(t)
    const r = await d(req({ path: ['thing'] }))
    expect(r).toEqual({ kind: 'unary', result: { ok: true, value: 'read' } })
  })
})

describe('clientOver: transport routing', () => {
  it('routes unary leaves through transport.invoke with the branch path + meta', async () => {
    const tree = branch({ users: branch({ get: leaf<{ id: number }, string>(() => ok('x')) }) })
    const seen: { path: readonly string[]; input: unknown; meta: unknown }[] = []
    const transport: Transport = {
      invoke: async (path, input, meta) => {
        seen.push({ path, input, meta })
        return ok('routed')
      },
    }
    const client = clientOver(tree, transport)
    const r = await client.users.get({ id: 7 }, { token: 'abc' })
    expect(r).toEqual({ ok: true, value: 'routed' })
    expect(seen).toEqual([{ path: ['users', 'get'], input: { id: 7 }, meta: { token: 'abc' } }])
  })

  it('routes streaming leaves through transport.stream', async () => {
    const tree = branch({
      count: streamLeaf<number, number>(async function* (n) {
        for (let i = 0; i < n; i++) yield ok(i)
      }),
    })
    const transport: Transport = {
      invoke: async () => ok(null),
      stream: async function* (path, input) {
        expect(path).toEqual(['count'])
        for (let i = 0; i < (input as number); i++) yield ok(i * 10)
      },
    }
    const client = clientOver(tree, transport)
    const got: unknown[] = []
    for await (const r of client.count(2)) got.push(r)
    expect(got).toEqual([{ ok: true, value: 0 }, { ok: true, value: 10 }])
  })

  it('exposes verbs as lowercased call names that issue the right method, same path', async () => {
    const tree = branch({
      users: branch({
        list: methods({
          GET: leaf<{ q?: string }, string[]>(() => ok(['a'])),
          POST: leaf<{ name: string }, string>(() => ok('made')),
        }),
      }),
    })
    const seen: { path: readonly string[]; input: unknown; method: unknown }[] = []
    const transport: Transport = {
      invoke: async (path, input, _meta, method) => {
        seen.push({ path, input, method })
        return method === 'GET' ? ok(['a']) : ok('made')
      },
    }
    const client = clientOver(tree, transport)
    // Typed: client.users.list.get / .post are both callable; types inferred per verb.
    const g = await client.users.list.get({ q: 'x' })
    const p = await client.users.list.post({ name: 'al' })
    expect(g).toEqual({ ok: true, value: ['a'] })
    expect(p).toEqual({ ok: true, value: 'made' })
    // Same path for both verbs; no segment appended for the methods node.
    expect(seen).toEqual([
      { path: ['users', 'list'], input: { q: 'x' }, method: 'GET' },
      { path: ['users', 'list'], input: { name: 'al' }, method: 'POST' },
    ])
  })

  it('ERRORS EXPLICITLY when a stream leaf is called over a transport lacking stream()', () => {
    const tree = branch({
      count: streamLeaf<number, number>(async function* () { yield ok(0) }),
    })
    const unaryOnly: Transport = { invoke: async () => ok(null) }
    const client = clientOver(tree, unaryOnly)
    // Calling the streaming method synchronously builds + throws (no silent degrade).
    expect(() => client.count(1)).toThrow(/cannot carry a stream/)
  })
})
