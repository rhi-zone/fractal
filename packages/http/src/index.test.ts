// packages/http/src/index.test.ts
//
// Tests porting the HTTP demo behaviors from spike/demo.ts:
// param+typed, query, header, lazy body counter, validation accept/reject,
// nested discharge, 404, G1 @ts-expect-error.
//
// All combinators now produce/consume Node<P,Res> = { meta, handler }.
// Tests call serve(node, ...) and node.handler(...) directly.

import { describe, it, expect } from 'bun:test'
import {
  path,
  methods,
  param,
  query,
  header,
  body,
  validate,
  serve,
  leaf,
  typed,
  choice,
  pass,
  type Node,
  type Handler,
  type HandlerWithBody,
  type Req,
} from './index.ts'

// ============================================================================
// DOMAIN MODEL
// ============================================================================

interface Todo {
  id: number
  title: string
  done: boolean
}

const STORE: Todo[] = [
  { id: 1, title: 'Write the spike', done: false },
  { id: 2, title: 'Prove protocol agnosticism', done: false },
  { id: 3, title: 'Commit and report', done: false },
]

type ApiResult = Todo | Todo[] | { error: string } | null

// ============================================================================
// LEAVES
// ============================================================================

const listTodos: Node<Record<string, never>, Todo[]> = leaf(async (_req) => [...STORE])

const listTodosWithLimit: Node<{ limit: string }, Todo[]> = leaf(async (req) => {
  const n = Number(req.params.limit)
  return STORE.slice(0, Number.isFinite(n) && n > 0 ? n : STORE.length)
})

const getTodoLeaf: Node<{ id: number }, Todo | null> = leaf(async (req) =>
  STORE.find((t) => t.id === req.params.id) ?? null,
)

const getTodo: Node<{ id: string }, Todo | null> = typed<
  { id: number },
  { id: string },
  Todo | null
>((raw) => ({ id: Number(raw['id']) }))(getTodoLeaf)

const listTodosForTenant: Node<{ 'x-tenant': string }, Todo[]> = leaf(async (req) => {
  const tenant = req.params['x-tenant']
  return STORE.map((t) => ({ ...t, title: `[tenant:${tenant}] ${t.title}` }))
})

interface CreateTodoInput { title: string }

function parseCreateTodoBody(raw: unknown): CreateTodoInput {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as Record<string, unknown>)['title'] !== 'string'
  ) {
    throw new Error(`invalid body: expected {title:string}, got ${JSON.stringify(raw)}`)
  }
  return { title: (raw as Record<string, unknown>)['title'] as string }
}

let nextId = 10
const createTodoFromBodyLeaf: HandlerWithBody<Record<string, never>, CreateTodoInput, Todo> =
  async (req) => {
    const todo: Todo = { id: nextId++, title: req.body.title, done: false }
    STORE.push(todo)
    return todo
  }

const createTodoBodyHandler: Node<Record<string, never>, Todo> = body(
  validate(parseCreateTodoBody, createTodoFromBodyLeaf),
)

// ============================================================================
// HTTP ROUTING TREE
// ============================================================================

const httpApp: Node<Record<string, never>, ApiResult> = path<Record<string, never>, ApiResult>({
  todos: choice<Record<string, never>, ApiResult>(
    // /todos?limit=N
    query(
      'limit',
      methods<{ limit: string }, ApiResult>({ GET: listTodosWithLimit }),
    ),
    // /todos with x-tenant header
    header(
      'x-tenant',
      methods<{ 'x-tenant': string }, ApiResult>({ GET: listTodosForTenant }),
    ),
    // Exact /todos — method dispatch
    methods<Record<string, never>, ApiResult>({
      GET: listTodos,
      POST: createTodoBodyHandler as Node<Record<string, never>, ApiResult>,
    }),
    // /todos/:id
    param(
      'id',
      methods<{ id: string }, ApiResult>({ GET: getTodo }),
    ),
  ),
})

// ============================================================================
// TYPE-LEVEL ASSERTION: G1 — param with number-typed child is a compile error
// ============================================================================

const _g1LeafWantsNumber = async (req: Req<{ x: number }>) => req.params.x
// @ts-expect-error [G1: {x:number} does not satisfy C extends Record<'x',string>]
const _g1Probe = param('x', { meta: { kind: 'leaf' as const }, handler: _g1LeafWantsNumber })
void _g1Probe

// ============================================================================
// TESTS
// ============================================================================

describe('param + typed (string → number bridge)', () => {
  it('GET /todos/2 returns todo #2', async () => {
    const r = await serve<ApiResult>(httpApp, { method: 'GET', url: '/todos/2' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: 2, title: 'Prove protocol agnosticism' })
  })

  it('GET /todos/999 returns null (not found todo)', async () => {
    const r = await serve<ApiResult>(httpApp, { method: 'GET', url: '/todos/999' })
    expect(r.status).toBe(200)
    expect(r.body).toBeNull()
  })
})

describe('query capture', () => {
  it('GET /todos?limit=2 returns first 2 todos', async () => {
    const r = await serve<ApiResult>(httpApp, { method: 'GET', url: '/todos?limit=2' })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
    expect((r.body as Todo[]).length).toBe(2)
  })

  it('GET /todos returns all todos when no limit', async () => {
    const r = await serve<ApiResult>(httpApp, { method: 'GET', url: '/todos' })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })
})

describe('header capture', () => {
  it('GET /todos with x-tenant header prefixes titles', async () => {
    const r = await serve<ApiResult>(httpApp, {
      method: 'GET',
      url: '/todos',
      headers: { 'x-tenant': 'acme' },
    })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
    const todos = r.body as Todo[]
    expect(todos[0]?.title).toMatch(/^\[tenant:acme\]/)
  })
})

describe('body laziness', () => {
  it('GET /todos does NOT pull the body thunk', async () => {
    let thunkPulled = false
    // Build a manual HTTP request with a counting thunk
    const httpReqFields = {
      method: 'GET',
      path: ['todos'],
      query: {},
      headers: {},
      params: {} as Record<string, never>,
      body: () => {
        thunkPulled = true
        return Promise.resolve({ title: 'ShouldNotRead' })
      },
    }
    const res = await httpApp.handler(httpReqFields)
    expect(thunkPulled).toBe(false)
    expect(res).not.toBe(pass)
  })

  it('POST /todos DOES pull the body thunk', async () => {
    let thunkPulled = false
    const httpReqFields = {
      method: 'POST',
      path: ['todos'],
      query: {},
      headers: {},
      params: {} as Record<string, never>,
      body: () => {
        thunkPulled = true
        return Promise.resolve({ title: 'LazyBodyTodo' })
      },
    }
    await httpApp.handler(httpReqFields)
    expect(thunkPulled).toBe(true)
  })
})

describe('validate', () => {
  it('POST /todos with valid body creates todo', async () => {
    const before = STORE.length
    const r = await serve<ApiResult>(httpApp, {
      method: 'POST',
      url: '/todos',
      body: { title: 'ValidateTodo' },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ title: 'ValidateTodo' })
    expect(STORE.length).toBe(before + 1)
  })

  it('POST /todos with invalid body throws', async () => {
    await expect(
      serve<ApiResult>(httpApp, {
        method: 'POST',
        url: '/todos',
        body: { wrong: true },
      }),
    ).rejects.toThrow('invalid body')
  })
})

describe('nested discharge', () => {
  it('GET /todos returns 200', async () => {
    const r = await serve<ApiResult>(httpApp, { method: 'GET', url: '/todos' })
    expect(r.status).toBe(200)
  })

  it('GET /todos/1 returns todo #1', async () => {
    const r = await serve<ApiResult>(httpApp, { method: 'GET', url: '/todos/1' })
    expect(r.status).toBe(200)
    expect((r.body as Todo).id).toBe(1)
  })
})

describe('404 — pass-through', () => {
  it('GET /unknown returns 404', async () => {
    const r = await serve<ApiResult>(httpApp, { method: 'GET', url: '/unknown' })
    expect(r.status).toBe(404)
    expect(r.body).toBeNull()
  })

  it('methods guard: GET /todos/1/extra returns 404 (path not exhausted)', async () => {
    const r = await serve<ApiResult>(httpApp, { method: 'GET', url: '/todos/1/extra' })
    expect(r.status).toBe(404)
  })
})

describe('Node meta descriptors', () => {
  it('leaf has kind:leaf meta', () => {
    const n = leaf<Record<string, never>, string>(async () => 'x')
    expect(n.meta).toEqual({ kind: 'leaf' })
  })

  it('path has kind:path meta with children', () => {
    const n = path({ foo: leaf<Record<string, never>, string>(async () => 'foo') })
    expect(n.meta).toMatchObject({ kind: 'path' })
    expect((n.meta as { children: unknown }).children).toHaveProperty('foo')
  })

  it('methods has kind:methods meta with verbs', () => {
    const n = methods({ GET: leaf<Record<string, never>, string>(async () => 'ok') })
    expect(n.meta).toMatchObject({ kind: 'methods' })
    expect((n.meta as unknown as { verbs: unknown }).verbs).toHaveProperty('GET')
  })

  it('param has kind:param meta with in:path', () => {
    const inner = leaf<{ id: string }, string>(async (req) => req.params.id)
    const n = param('id', inner)
    expect(n.meta).toMatchObject({ kind: 'param', name: 'id', in: 'path' })
  })

  it('query has kind:query meta with in:query', () => {
    const inner = leaf<{ limit: string }, string>(async (req) => req.params.limit)
    const n = query('limit', inner)
    expect(n.meta).toMatchObject({ kind: 'query', name: 'limit', in: 'query' })
  })

  it('header has kind:header meta with in:header', () => {
    const inner = leaf<{ 'x-tenant': string }, string>(async (req) => req.params['x-tenant'])
    const n = header('x-tenant', inner)
    expect(n.meta).toMatchObject({ kind: 'header', name: 'x-tenant', in: 'header' })
  })

  it('httpApp root meta is kind:path', () => {
    expect(httpApp.meta).toMatchObject({ kind: 'path' })
  })
})

// Ensure Handler is still exported for direct use
const _handlerCheck: Handler<Record<string, never>, string> = async (_req) => 'ok'
void _handlerCheck
