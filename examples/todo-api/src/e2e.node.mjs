// examples/todo-api/src/e2e.node.mjs
// Node.js (20+) e2e runner — same three cases as e2e.test.ts but using the
// serveNode adapter and a plain assertion function instead of vitest.
//
// Run with:  node examples/todo-api/src/e2e.node.mjs
// (from the fractal monorepo root, after `bun run build`)

import { serveNode } from '../../../packages/channel-http/dist/node.js'
import { httpClientWithHeaders } from '../../../packages/facade/dist/facade.js'
import { tree } from './tree.node.mjs'

// ── assertion helper ──────────────────────────────────────────────────────────
let passed = 0
let failed = 0

const assert = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  PASS ${label}`)
    passed++
  } else {
    console.error(`  FAIL ${label}`)
    console.error(`    expected: ${JSON.stringify(expected)}`)
    console.error(`    actual:   ${JSON.stringify(actual)}`)
    failed++
  }
}

const assertOk = (label, value) => {
  if (value) {
    console.log(`  PASS ${label}`)
    passed++
  } else {
    console.error(`  FAIL ${label}: expected truthy, got ${value}`)
    failed++
  }
}

// ── auth grant ────────────────────────────────────────────────────────────────
const authGrant = (req) => {
  const header = req.headers?.get('authorization') ?? ''
  const match = /^Bearer (.+)$/.exec(header)
  return { auth: { user: match !== null ? match[1] : null } }
}

// ── main ──────────────────────────────────────────────────────────────────────
const server = await serveNode(tree, {
  port: 0,
  grants: { auth: authGrant },
})

const baseUrl = `http://127.0.0.1:${server.port}`
console.log(`Node server started on ${baseUrl}`)

const api = httpClientWithHeaders(tree, baseUrl)

// ── case 1: plain endpoint ────────────────────────────────────────────────────
console.log('\nping (plain leaf):')
const pingResult = await api.ping(undefined)
console.log('  result:', JSON.stringify(pingResult))
assert('returns pong', pingResult, { ok: true, value: 'pong' })

// ── case 2: auth-guarded endpoint ─────────────────────────────────────────────
console.log('\nme (withAuth capability):')

const meNoToken = await api.me(undefined)
console.log('  me (no token) result:', JSON.stringify(meNoToken))
assert('returns unauthorized without a token', meNoToken, { ok: false, error: { code: 'unauthorized' } })

const meAlice = await api.me(undefined, { authorization: 'Bearer alice' })
console.log('  me (alice token) result:', JSON.stringify(meAlice))
assert('returns the user name with a valid token', meAlice, { ok: true, value: 'hello, alice' })

// ── case 3: validated seq ──────────────────────────────────────────────────────
console.log('\ntodos/add (validated seq):')

const addBad = await api.todos.add({ title: 42 })
console.log('  add (bad input) result:', JSON.stringify(addBad))
assertOk('returns a validation error on bad input', !addBad.ok && addBad.error?.code === 'invalid')

const addGood = await api.todos.add({ title: 'write tests' })
console.log('  add (valid input) result:', JSON.stringify(addGood))
assertOk('returns the created todo on valid input', addGood.ok && typeof addGood.value?.id === 'number' && addGood.value?.title === 'write tests')

// ── teardown ──────────────────────────────────────────────────────────────────
await server.stop()

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
