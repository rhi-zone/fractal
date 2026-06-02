// examples/todo-api/src/app.e2e.test.ts
//
// E2E round-trip: real Bun HTTP server via listen() + parity assertions
// against the in-process transport via serve().
//
// The canonical typed client (client(app, http(url))) cannot enumerate the full
// `app` surface because app's todosCollection uses choice() — which is opaque
// to the typed client by design (choice branches collapse to ChoiceMeta, literal
// keys are not preserved). The route() combinator and its RouteMeta ARE
// transparent; choice() inside a collection is still fine for HTTP dispatch.
//
// Parity strategy:
//   - "in-process" path:  serve(app, req) — the fractal http kit's own adapter
//   - "http transport" path: raw fetch() to the real server
// Both paths exercise the SAME app tree. The round-trip proves:
//   - listen() correctly translates web Request → fractal HttpReq
//   - serve() and listen()'s handler produce the same JSON over the wire
//   - auth guard (withSecurity) fires identically in both paths
//
// Bun listen API: listen(node, { port: 0 }) assigns an OS ephemeral port.
// The server is stopped in afterAll.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { listen, serve } from '@rhi-zone/fractal-http'
import type { ListenServer } from '@rhi-zone/fractal-http'
import { app, store, type Todo, type ApiResult } from './app.ts'

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: ListenServer
let baseUrl: string

beforeAll(() => {
  server = listen(app, { port: 0 })
  baseUrl = `http://localhost:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

// Reset the shared todo store before each test to avoid cross-test pollution.
beforeEach(() => {
  store.length = 0
  store.push(
    { id: 1, title: 'Todo one', done: false },
    { id: 2, title: 'Todo two', done: false },
    { id: 3, title: 'Todo three', done: false },
  )
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-process via serve() — no network. */
async function ip(method: string, url: string, opts: { headers?: Record<string,string>; body?: unknown } = {}) {
  return serve<ApiResult>(app, {
    method,
    url,
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  })
}

/** HTTP transport via real fetch — real network round-trip. */
async function wire(method: string, path: string, opts: { headers?: Record<string,string>; body?: unknown } = {}) {
  const hasBody = opts.body !== undefined
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
  })
}

// ---------------------------------------------------------------------------
// GET /todos — list all
// ---------------------------------------------------------------------------

describe('GET /todos — list all', () => {
  it('in-process returns all todos', async () => {
    const r = await ip('GET', '/todos')
    expect(r.status).toBe(200)
    const todos = r.body as Todo[]
    expect(Array.isArray(todos)).toBe(true)
    expect(todos.length).toBe(3)
    expect(todos[0]?.title).toBe('Todo one')
  })

  it('http transport returns all todos', async () => {
    const r = await wire('GET', '/todos')
    expect(r.status).toBe(200)
    const todos = await r.json() as Todo[]
    expect(Array.isArray(todos)).toBe(true)
    expect(todos.length).toBe(3)
    expect(todos[0]?.title).toBe('Todo one')
  })

  it('http transport result equals in-process result', async () => {
    const ipResult = (await ip('GET', '/todos')).body as Todo[]
    const httpRes  = await wire('GET', '/todos')
    const httpResult = await httpRes.json() as Todo[]
    expect(httpResult).toEqual(ipResult)
  })
})

// ---------------------------------------------------------------------------
// POST /todos — create (bearer auth required)
// ---------------------------------------------------------------------------

describe('POST /todos — create with bearer auth', () => {
  it('in-process: POST with valid bearer token creates todo', async () => {
    const r = await ip('POST', '/todos', {
      headers: { authorization: 'Bearer secret' },
      body: { title: 'in-process created' },
    })
    expect(r.status).toBe(200)
    const created = r.body as Todo
    expect(created.title).toBe('in-process created')
    expect(typeof created.id).toBe('number')
    expect(created.done).toBe(false)
  })

  it('http transport: POST with valid bearer token creates todo', async () => {
    const r = await wire('POST', '/todos', {
      headers: { Authorization: 'Bearer secret' },
      body: { title: 'http-transport created' },
    })
    expect(r.status).toBe(200)
    const created = await r.json() as Todo
    expect(created.title).toBe('http-transport created')
    expect(typeof created.id).toBe('number')
    expect(created.done).toBe(false)
  })

  it('http transport: POST and GET parity — created todo visible in list', async () => {
    // Create via http transport
    const createResp = await wire('POST', '/todos', {
      headers: { Authorization: 'Bearer secret' },
      body: { title: 'e2e parity todo' },
    })
    expect(createResp.status).toBe(200)
    const created = await createResp.json() as Todo

    // Confirm visible via in-process GET
    const ipList = (await ip('GET', '/todos')).body as Todo[]
    expect(ipList.some(t => t.id === created.id && t.title === 'e2e parity todo')).toBe(true)

    // Confirm visible via http GET
    const httpListResp = await wire('GET', '/todos')
    const httpList = await httpListResp.json() as Todo[]
    expect(httpList.some(t => t.id === created.id && t.title === 'e2e parity todo')).toBe(true)
  })

  it('in-process: POST without Authorization → 404', async () => {
    const r = await ip('POST', '/todos', { body: { title: 'should not be created' } })
    expect(r.status).toBe(404)
    expect(r.body).toBeNull()
  })

  it('http transport: POST without Authorization → 404', async () => {
    const r = await wire('POST', '/todos', { body: { title: 'should not be created' } })
    expect(r.status).toBe(404)
    // Store must be unmodified
    const list = (await ip('GET', '/todos')).body as Todo[]
    expect(list.every(t => t.title !== 'should not be created')).toBe(true)
  })

  it('http transport: POST with malformed Authorization → 404', async () => {
    const r = await wire('POST', '/todos', {
      headers: { Authorization: 'Basic abc123' },
      body: { title: 'should not be created' },
    })
    expect(r.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /todos/:id — single item by id
// ---------------------------------------------------------------------------

describe('GET /todos/:id — by id', () => {
  it('in-process returns the correct todo', async () => {
    const r = await ip('GET', '/todos/1')
    expect(r.status).toBe(200)
    expect((r.body as Todo).id).toBe(1)
    expect((r.body as Todo).title).toBe('Todo one')
  })

  it('http transport returns the same todo', async () => {
    const r = await wire('GET', '/todos/2')
    expect(r.status).toBe(200)
    const todo = await r.json() as Todo
    expect(todo.id).toBe(2)
    expect(todo.title).toBe('Todo two')
  })

  it('http transport result equals in-process result for same id', async () => {
    const ipResult = (await ip('GET', '/todos/3')).body as Todo
    const httpResult = await (await wire('GET', '/todos/3')).json() as Todo
    expect(httpResult).toEqual(ipResult)
  })

  it('http transport returns null for unknown id', async () => {
    const r = await wire('GET', '/todos/9999')
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toBeNull()
  })

  it('in-process returns null for unknown id', async () => {
    const r = await ip('GET', '/todos/9999')
    expect(r.status).toBe(200)
    expect(r.body).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 404 — unknown routes
// ---------------------------------------------------------------------------

describe('404 — unknown routes', () => {
  it('in-process: GET /unknown → 404', async () => {
    const r = await ip('GET', '/unknown')
    expect(r.status).toBe(404)
    expect(r.body).toBeNull()
  })

  it('http transport: GET /unknown → 404', async () => {
    const r = await wire('GET', '/unknown')
    expect(r.status).toBe(404)
  })

  it('in-process: path-not-exhausted (methods guard) → 404', async () => {
    const r = await ip('GET', '/todos/1/extra')
    expect(r.status).toBe(404)
  })

  it('http transport: path-not-exhausted (methods guard) → 404', async () => {
    const r = await wire('GET', '/todos/1/extra')
    expect(r.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Parity: full round-trip equality for all routes
// ---------------------------------------------------------------------------

describe('Parity: http transport === in-process for all routes', () => {
  it('GET /todos: wire == serve', async () => {
    const ipTodos = (await ip('GET', '/todos')).body
    const wireTodos = await (await wire('GET', '/todos')).json()
    expect(wireTodos).toEqual(ipTodos)
  })

  it('GET /todos/1: wire == serve', async () => {
    const ipItem = (await ip('GET', '/todos/1')).body
    const wireItem = await (await wire('GET', '/todos/1')).json()
    expect(wireItem).toEqual(ipItem)
  })

  it('GET /todos/9999: wire == serve (null)', async () => {
    const ipItem = (await ip('GET', '/todos/9999')).body
    const wireItem = await (await wire('GET', '/todos/9999')).json()
    expect(wireItem).toEqual(ipItem)
    expect(wireItem).toBeNull()
  })
})
