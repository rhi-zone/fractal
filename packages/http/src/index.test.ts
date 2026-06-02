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
  route,
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
//
// path/methods now take a single type param T (the literal table type) and
// return Node<{}, unknown, PathMeta<T>/MethodsMeta<T>>. The <P,Res> annotation
// is removed; types flow structurally from the leaf nodes. Cast to
// Node<{},ApiResult> for serve() which needs a concrete Res type.
// ============================================================================

const httpApp = path({
  todos: choice(
    // /todos?limit=N
    query(
      'limit',
      methods({ GET: listTodosWithLimit }),
    ),
    // /todos with x-tenant header
    header(
      'x-tenant',
      methods({ GET: listTodosForTenant }),
    ),
    // Exact /todos — method dispatch
    methods({
      GET: listTodos,
      POST: createTodoBodyHandler as unknown as Node<Record<string, never>, ApiResult>,
    }),
    // /todos/:id
    param(
      'id',
      methods({ GET: getTodo }),
    ),
  ),
}) as unknown as Node<Record<string, never>, ApiResult>

// ============================================================================
// TYPE-LEVEL ASSERTION: G1 — param with number-typed child is a compile error
// ============================================================================

const _g1LeafWantsNumber = async (req: Req<{ x: number }>) => req.params.x
// @ts-expect-error [G1: {x:number} does not satisfy C extends Record<'x',string>]
export const _g1ProbeTest = param('x', { meta: { kind: 'leaf' as const }, handler: _g1LeafWantsNumber })
void _g1ProbeTest

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

describe('validate with StandardSchemaV1 fixture', () => {
  // Hand-rolled StandardSchemaV1 fixture — no real validator dep
  const testSchema = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate(value: unknown) {
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as Record<string, unknown>)['title'] === 'string'
        ) {
          return { value: { title: (value as Record<string, unknown>)['title'] as string } }
        }
        return { issues: [{ message: 'expected {title:string}' }] }
      },
      jsonSchema: {
        input: (_opts: { target: string }) => ({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }),
        output: (_opts: { target: string }) => ({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }),
      },
    },
  }

  const stdSchemaApp = path({
    items: methods({
      POST: body(
        validate(
          testSchema,
          async (req) => ({ id: 99, title: req.body.title, done: false }),
        ),
      ),
    }),
  }) as unknown as Node<Record<string, never>, ApiResult>

  it('accepts valid body', async () => {
    const r = await serve<ApiResult>(stdSchemaApp, {
      method: 'POST',
      url: '/items',
      body: { title: 'StdSchema todo' },
    })
    expect(r.status).toBe(200)
    expect((r.body as Todo).title).toBe('StdSchema todo')
  })

  it('rejects invalid body with schema error', async () => {
    await expect(
      serve<ApiResult>(stdSchemaApp, {
        method: 'POST',
        url: '/items',
        body: { wrong: 42 },
      }),
    ).rejects.toThrow('expected {title:string}')
  })

  it('body meta carries validate meta with schema', () => {
    const handler = body(
      validate(testSchema, async (req) => ({ id: 1, title: req.body.title, done: false })),
    )
    expect(handler.meta).toMatchObject({ kind: 'body' })
    const childMeta = (handler.meta as { child: unknown }).child as Record<string, unknown>
    expect(childMeta.kind).toBe('validate')
    expect(childMeta.schema).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' } },
    })
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

describe('route() both-and combinator', () => {
  // Build: /items (GET list, POST create) + /items/{id} (GET single)
  // via route() — no choice() at the routing level
  const routeApp = path({
    items: route(
      methods({
        GET: leaf<Record<string, never>, string[]>(async () => ['a', 'b']),
        POST: leaf<Record<string, never>, string>(async () => 'created'),
      }),
      {
        param: {
          name: 'id' as const,
          child: methods({
            GET: leaf<{ id: string }, string>(async (req) => `item:${req.params.id}`),
          }),
        },
      },
    ),
  }) as unknown as Node<Record<string, never>, unknown>

  it('GET /items returns collection (path exhausted → collection)', async () => {
    const r = await serve(routeApp, { method: 'GET', url: '/items' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual(['a', 'b'])
  })

  it('POST /items returns created (collection POST)', async () => {
    const r = await serve(routeApp, { method: 'POST', url: '/items' })
    expect(r.status).toBe(200)
    expect(r.body).toBe('created')
  })

  it('GET /items/42 returns param-dispatched result', async () => {
    const r = await serve(routeApp, { method: 'GET', url: '/items/42' })
    expect(r.status).toBe(200)
    expect(r.body).toBe('item:42')
  })

  it('GET /items/unknown returns item (param fallthrough)', async () => {
    const r = await serve(routeApp, { method: 'GET', url: '/items/xyz' })
    expect(r.status).toBe(200)
    expect(r.body).toBe('item:xyz')
  })

  it('GET /items/42/extra returns 404 (methods guard: path not exhausted)', async () => {
    const r = await serve(routeApp, { method: 'GET', url: '/items/42/extra' })
    expect(r.status).toBe(404)
  })

  it('route meta has kind:route', () => {
    const todosNode = (routeApp.meta as unknown as { children: Record<string, unknown> }).children['items'] as { meta: { kind: string } }
    expect(todosNode.meta.kind).toBe('route')
  })
})

// Ensure Handler is still exported for direct use
const _handlerCheck: Handler<Record<string, never>, string> = async (_req) => 'ok'
void _handlerCheck
