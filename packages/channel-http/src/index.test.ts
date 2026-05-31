import { describe, it, expect } from 'vitest'
import {
  ok,
  err,
  leaf,
  branch,
  withAuth,
  check,
} from '@rhi-zone/fractal-core'
import { serve, type HttpRequestLike } from './index.ts'

const req = (over: Partial<HttpRequestLike>): HttpRequestLike => ({
  method: 'GET',
  segments: [],
  body: undefined,
  ...over,
})

describe('http interpreter: branch → path segments', () => {
  it('dispatches by path and 404s unknown routes', async () => {
    const tree = branch({
      users: branch({
        list: leaf<unknown, string[]>(() => ok(['a', 'b'])),
      }),
    })
    const handler = serve(tree)
    expect(await handler(req({ segments: ['users', 'list'] }))).toEqual({ status: 200, body: ['a', 'b'] })
    const miss = await handler(req({ segments: ['users', 'missing'] }))
    expect(miss.status).toBe(404)
  })
})

describe('http interpreter: annotation grants only that capability handle + enforces', () => {
  it('401 without a valid auth grant, 200 with one', async () => {
    const me = leaf<unknown, string, never, { auth: { user: string | null } }>(
      (_i, ctx) => ok(`hello ${ctx.caps.auth.user}`),
    )
    const tree = branch({ me: withAuth(me) })

    // No grant registered → enforce sees absent handle → unauthorized.
    const noGrant = serve(tree)
    const denied = await noGrant(req({ segments: ['me'] }))
    expect(denied.status).toBe(401)
    expect(denied.body).toEqual({ code: 'unauthorized' })

    // Grant injects the auth handle for kind 'auth' only.
    const withGrant = serve(tree, {
      grants: { auth: (r) => ({ auth: { user: (r.raw.body as { user?: string })?.user ?? null } }) },
    })
    const allowed = await withGrant(req({ segments: ['me'], body: { user: 'alice' } }))
    expect(allowed).toEqual({ status: 200, body: 'hello alice' })
  })
})

describe('http interpreter: seq validation stage maps error to status', () => {
  it('422 on invalid input, 200 on valid', async () => {
    const parse = check<{ n: number }>((i) =>
      typeof (i as { n?: unknown })?.n === 'number'
        ? ok(i as { n: number })
        : err({ code: 'invalid', message: 'n must be a number' }),
    )
    const double = leaf<{ n: number }, number>((i) => ok(i.n * 2))
    const tree = branch({ double: parse.then(double) })
    const handler = serve(tree)
    expect(await handler(req({ segments: ['double'], body: { n: 21 } }))).toEqual({ status: 200, body: 42 })
    const bad = await handler(req({ segments: ['double'], body: { n: 'x' } }))
    expect(bad.status).toBe(422)
  })
})

describe('http interpreter: transport stays out of leaves', () => {
  it('a leaf returns a plain Result; status mapping happens only in serve', async () => {
    const failing = leaf<unknown, never, { code: 'boom' }>(() => err({ code: 'boom' }))
    const handler = serve(branch({ x: failing }))
    const res = await handler(req({ segments: ['x'] }))
    expect(res).toEqual({ status: 400, body: { code: 'boom' } })
  })
})
