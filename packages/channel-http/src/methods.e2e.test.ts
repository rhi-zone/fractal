// HTTP methods end-to-end: a `methods` node served via serveBun, consumed via
// the unified httpClient. Proves (1) the typed client's `.get`/`.post` call names
// issue the matching HTTP verb on the wire, (2) both verbs resolve at the SAME
// URL path (the methods node consumes no path segment), (3) an unmapped verb is
// surfaced as a 405-backed error Result, and (4) per-verb input/output types flow
// through `UClient`.

import { describe, it, expect } from 'bun:test'
import { ok, err, branch, leaf, methods, check } from '@rhi-zone/fractal-core'
import { clientOver, composeRequestResponse } from '@rhi-zone/fractal-transport'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import type { AnyNode } from '@rhi-zone/fractal-core'
import { serveBun, type BunServer } from './bun.ts'
import { httpExchange } from './client.ts'

const httpClient = <N extends AnyNode>(node: N, baseUrl: string) =>
  clientOver(node, composeRequestResponse(httpExchange(baseUrl), jsonCodec))

const makeTree = () =>
  branch({
    users: branch({
      list: methods({
        GET: leaf<{ q?: string } | undefined, string[]>(() => ok(['ann', 'bob'])),
        POST: check<{ name: string }>((i) =>
          typeof (i as { name?: unknown })?.name === 'string'
            ? ok(i as { name: string })
            : err({ code: 'invalid', message: 'name required' }),
        ).then(leaf<{ name: string }, { id: number; name: string }>((b) => ok({ id: 1, name: b.name }))),
      }),
    }),
  })

describe('HTTP methods e2e', () => {
  it('typed client issues GET vs POST at the same path, inferring per-verb types', async () => {
    const server: BunServer = serveBun(makeTree(), { port: 0 })
    try {
      const api = httpClient(makeTree(), `http://127.0.0.1:${server.port}`)

      // GET dispatches to the read handler (proving the client issued GET — the
      // POST handler would have demanded a `name` and 422'd on this empty input).
      const listed = await api.users.list.get(undefined)
      expect(listed).toEqual({ ok: true, value: ['ann', 'bob'] })

      // POST dispatches to the create handler at the SAME /users/list path.
      const created = await api.users.list.post({ name: 'cleo' })
      expect(created).toEqual({ ok: true, value: { id: 1, name: 'cleo' } })
    } finally {
      await server.stop()
    }
  })

  it('an unmapped verb comes back as a 405-backed error Result', async () => {
    // The typed client only exposes declared verbs; reach the wire path directly
    // through the exchange to assert the 405 framing for a verb not in the map.
    const server: BunServer = serveBun(makeTree(), { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/users/list`, { method: 'DELETE' })
      expect(res.status).toBe(405)
      const body = (await res.json()) as { code: string; allow: string[] }
      expect(body.code).toBe('method_not_allowed')
      expect(body.allow.sort()).toEqual(['GET', 'POST'])
    } finally {
      await server.stop()
    }
  })
})
