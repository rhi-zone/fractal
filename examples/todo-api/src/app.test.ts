// examples/todo-api/src/app.test.ts
// Integration tests for the todo-api example using the http kit's serve().
// Runs under bun test (real I/O capable runtime).

import { describe, it, expect, beforeEach } from 'bun:test'
import { serve } from '@rhi-zone/fractal-http'
import { app, store, type Todo, type ApiResult } from './app.ts'

// Reset store before each test to avoid cross-test pollution
beforeEach(() => {
  store.length = 0
  store.push(
    { id: 1, title: 'Todo one', done: false },
    { id: 2, title: 'Todo two', done: false },
    { id: 3, title: 'Todo three', done: false },
  )
})

describe('GET /todos', () => {
  it('returns all todos', async () => {
    const r = await serve<ApiResult>(app, { method: 'GET', url: '/todos' })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
    expect((r.body as Todo[]).length).toBe(3)
  })
})

describe('GET /todos?limit=N', () => {
  it('returns at most N todos', async () => {
    const r = await serve<ApiResult>(app, { method: 'GET', url: '/todos?limit=2' })
    expect(r.status).toBe(200)
    expect((r.body as Todo[]).length).toBe(2)
  })
})

describe('GET /todos with x-tenant header', () => {
  it('prefixes titles with tenant name', async () => {
    const r = await serve<ApiResult>(app, {
      method: 'GET',
      url: '/todos',
      headers: { 'x-tenant': 'acme' },
    })
    expect(r.status).toBe(200)
    const todos = r.body as Todo[]
    expect(todos[0]?.title).toMatch(/^\[acme\]/)
  })
})

describe('GET /todos/:id', () => {
  it('returns the todo with the given id', async () => {
    const r = await serve<ApiResult>(app, { method: 'GET', url: '/todos/2' })
    expect(r.status).toBe(200)
    expect((r.body as Todo).id).toBe(2)
    expect((r.body as Todo).title).toBe('Todo two')
  })

  it('returns null for an unknown id', async () => {
    const r = await serve<ApiResult>(app, { method: 'GET', url: '/todos/999' })
    expect(r.status).toBe(200)
    expect(r.body).toBeNull()
  })
})

describe('POST /todos with body — StandardSchemaV1 validation', () => {
  it('creates a new todo when body is valid and bearer token present', async () => {
    const r = await serve<ApiResult>(app, {
      method: 'POST',
      url: '/todos',
      headers: { authorization: 'Bearer secret' },
      body: { title: 'New from test' },
    })
    expect(r.status).toBe(200)
    expect((r.body as Todo).title).toBe('New from test')
    expect(typeof (r.body as Todo).id).toBe('number')
  })

  it('throws on invalid body (StandardSchemaV1 validate rejects)', async () => {
    await expect(
      serve<ApiResult>(app, {
        method: 'POST',
        url: '/todos',
        headers: { authorization: 'Bearer secret' },
        body: { wrong: 42 },
      }),
    ).rejects.toThrow('expected {title:string}')
  })

  it('returns 404 when Authorization header is missing (withSecurity guard)', async () => {
    const r = await serve<ApiResult>(app, {
      method: 'POST',
      url: '/todos',
      body: { title: 'Should not be created' },
    })
    expect(r.status).toBe(404)
    expect(r.body).toBeNull()
  })

  it('returns 404 when Authorization header is malformed', async () => {
    const r = await serve<ApiResult>(app, {
      method: 'POST',
      url: '/todos',
      headers: { authorization: 'Basic abc123' },
      body: { title: 'Should not be created' },
    })
    expect(r.status).toBe(404)
    expect(r.body).toBeNull()
  })
})

describe('404 — unknown routes', () => {
  it('returns 404 for unknown top-level path', async () => {
    const r = await serve<ApiResult>(app, { method: 'GET', url: '/unknown' })
    expect(r.status).toBe(404)
    expect(r.body).toBeNull()
  })

  it('returns 404 when path is not fully consumed (methods guard)', async () => {
    const r = await serve<ApiResult>(app, { method: 'GET', url: '/todos/1/extra' })
    expect(r.status).toBe(404)
  })
})
