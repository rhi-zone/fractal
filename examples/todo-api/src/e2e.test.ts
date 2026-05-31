// examples/todo-api/src/e2e.test.ts
// End-to-end integration test: boots a real Bun server, calls it via the
// typed fetch client, then shuts the server down.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serveBun, type BunServer } from '@rhi-zone/fractal-channel-http/bun'
import { clientOver, composeRequestResponse } from '@rhi-zone/fractal-transport'
import { httpExchange } from '@rhi-zone/fractal-channel-http/client'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import { type HttpCapGrant as CapGrant } from '@rhi-zone/fractal-channel-http'
import { tree } from './tree.ts'

// SELF-COMPOSE HTTP client (NO preset): `httpExchange` is the pure HTTP CHANNEL;
// the request-response protocol form + JSON codec are wired via the kernel's
// `composeRequestResponse`. Per-call headers are the `meta?` arg on each method.
//   clientOver(tree, composeRequestResponse(httpExchange(baseUrl), jsonCodec))

// ── auth grant ────────────────────────────────────────────────────────────
// Reads Authorization header: "Bearer <username>" → { auth: { user: username } }
// Absent or malformed token → { auth: { user: null } } → 401 from withAuth.
const authGrant: CapGrant = (req) => {
  const header = req.raw.headers?.get('authorization') ?? ''
  const match = /^Bearer (.+)$/.exec(header)
  return { auth: { user: match !== null ? match[1] : null } }
}

// ── server lifecycle ──────────────────────────────────────────────────────
let server: BunServer
let baseUrl: string
let api: ReturnType<typeof clientOver<typeof tree>>

beforeAll(() => {
  server = serveBun(tree, {
    port: 0, // OS picks an ephemeral port → no collision
    grants: { auth: authGrant },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
  api = clientOver(tree, composeRequestResponse(httpExchange(baseUrl), jsonCodec))
})

afterAll(() => {
  server.stop()
})

// ── case 1: plain endpoint ────────────────────────────────────────────────
describe('ping (plain leaf)', () => {
  it('returns pong', async () => {
    const result = await api.ping(undefined)
    console.log('ping result:', JSON.stringify(result))
    expect(result).toEqual({ ok: true, value: 'pong' })
  })
})

// ── case 2: auth-guarded endpoint ─────────────────────────────────────────
describe('me (withAuth capability)', () => {
  it('returns unauthorized without a token', async () => {
    const result = await api.me(undefined)
    console.log('me (no token) result:', JSON.stringify(result))
    expect(result).toEqual({ ok: false, error: { code: 'unauthorized' } })
  })

  it('returns the user name with a valid token', async () => {
    const result = await api.me(undefined, { authorization: 'Bearer alice' })
    console.log('me (alice token) result:', JSON.stringify(result))
    expect(result).toEqual({ ok: true, value: 'hello, alice' })
  })
})

// ── case 3: validated seq ──────────────────────────────────────────────────
describe('todos/add (validated seq)', () => {
  it('returns a validation error on bad input', async () => {
    const result = await api.todos.add({ title: 42 as unknown as string })
    console.log('add (bad input) result:', JSON.stringify(result))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.error as { code: string }).code).toBe('invalid')
      // The new `validated` joins the schema's issue messages with '; '.
      expect((result.error as { message: string }).message).toBe(
        'title must be a non-empty string',
      )
    }
  })

  it('returns the created todo on valid input', async () => {
    const result = await api.todos.add({ title: 'write tests' })
    console.log('add (valid input) result:', JSON.stringify(result))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ title: 'write tests' })
      expect(typeof result.value.id).toBe('number')
    }
  })
})
