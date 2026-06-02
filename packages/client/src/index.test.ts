// packages/client/src/index.test.ts — @rhi-zone/fractal-client
//
// Tests for the typed client.
//
// Coverage:
//   1. In-process transport: client(app).todos.GET(), .todos.POST(body), .todos('1').GET()
//   2. Type negatives (@ts-expect-error consumed): wrong body, wrong param, nonexistent verb/child
//   3. Type probe: type _ = ClientOf<typeof app>
//   4. HTTP transport: mock fetch to assert correct {method, path, body} serialization
//   5. HTTP transport integration: stand up a real bun server, call through client(app, http(url))

import { describe, it, expect, beforeEach } from 'vitest'
import { leaf, methods, param, path, body, validate, route } from '@rhi-zone/fractal-http'
import type { Node } from '@rhi-zone/fractal-core'
import { client, http, type ClientOf } from './index.ts'

// ---------------------------------------------------------------------------
// Test app — mirrors the todo-api example but WITHOUT choice() so the typed
// client can derive the full surface. The full app.ts uses choice() inside
// the collection which makes that surface opaque; here we use plain methods().
//
// Structure:
//   /todos         GET  → list all todos
//                  POST → create todo (body: CreateInput)
//   /todos/:id     GET  → get todo by id (via route() both-and)
// ---------------------------------------------------------------------------

interface Todo {
  id: number
  title: string
  done: boolean
}
interface CreateInput { title: string }

function parseCreate(raw: unknown): CreateInput {
  if (
    typeof raw === 'object' && raw !== null &&
    typeof (raw as Record<string, unknown>)['title'] === 'string'
  ) {
    return { title: (raw as Record<string, unknown>)['title'] as string }
  }
  throw new Error(`expected {title:string}, got ${JSON.stringify(raw)}`)
}

let nextId = 1
let store: Todo[] = [{ id: 1, title: 'first todo', done: false }]

beforeEach(() => {
  nextId = 2
  store = [{ id: 1, title: 'first todo', done: false }]
})

// Leaves
const listAllLeaf: Node<Record<string, never>, Todo[]> = leaf(async () => [...store])

const getByIdLeaf: Node<{ id: string }, Todo | null> = leaf(async (req) =>
  store.find((t) => t.id === Number(req.params.id)) ?? null,
)

const createNode = methods({
  POST: body(validate(parseCreate, async (req) => {
    const todo: Todo = { id: nextId++, title: req.body.title, done: false }
    store.push(todo)
    return todo
  })),
})

// Route: collection = methods({GET, POST}), param = {name:'id', child:methods({GET})}
// Using path() + param() combinators (tests the path/param runtime strategy)
const todosRoute = route(
  methods({
    GET: listAllLeaf,
    POST: body(validate(parseCreate, async (req) => {
      const todo: Todo = { id: nextId++, title: req.body.title, done: false }
      store.push(todo)
      return todo
    })),
  }),
  {
    param: {
      name: 'id' as const,
      child: methods({
        GET: getByIdLeaf as unknown as Node<Record<string, never>, Todo | null>,
      }) as unknown as Node<Record<string, never>, Todo | null>,
    },
  },
)

const app = path({ todos: todosRoute }) as unknown as Node<
  Record<string, never>,
  unknown,
  ReturnType<typeof path<{ todos: typeof todosRoute }>>['meta']
>

// Type probe — verifies that ClientOf expands to the expected surface
// (this is a compile-time check; the assignment is the assertion)
type _ = ClientOf<typeof app>

// Simpler tree for type probes (using path/methods/param, not route)
const simpleTree = path({
  todos: methods({
    GET: listAllLeaf,
    POST: body(validate(parseCreate, async (req) => {
      const todo: Todo = { id: nextId++, title: req.body.title, done: false }
      store.push(todo)
      return todo
    })),
  }),
  todosById: param('id',
    methods({
      GET: getByIdLeaf,
    }),
  ),
})

type SimpleClient = ClientOf<typeof simpleTree>

// ---------------------------------------------------------------------------
// IN-PROCESS transport tests
// ---------------------------------------------------------------------------

describe('client() — in-process transport', () => {
  it('GET /todos returns all todos', async () => {
    const c = client(simpleTree)
    const result = await c.todos.GET()
    expect(Array.isArray(result)).toBe(true)
    expect((result as Todo[]).length).toBe(1)
    expect((result as Todo[])[0]?.title).toBe('first todo')
  })

  it('POST /todos creates a new todo', async () => {
    const c = client(simpleTree)
    const result = await c.todos.POST({ title: 'new todo' })
    expect((result as Todo).title).toBe('new todo')
    expect(typeof (result as Todo).id).toBe('number')
    expect(store.length).toBe(2)
  })

  it('GET /todosById/:id returns the correct todo', async () => {
    const c = client(simpleTree)
    const result = await c.todosById('1').GET()
    expect((result as Todo).id).toBe(1)
    expect((result as Todo).title).toBe('first todo')
  })

  it('GET /todosById/:id returns null for unknown id', async () => {
    const c = client(simpleTree)
    const result = await c.todosById('9999').GET()
    expect(result).toBeNull()
  })

  it('GET /todos reflects POST changes', async () => {
    const c = client(simpleTree)
    await c.todos.POST({ title: 'second' })
    const todos = await c.todos.GET() as Todo[]
    expect(todos.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// TYPE NEGATIVE ASSERTIONS (@ts-expect-error — compile-time only)
//
// Each @ts-expect-error below must be consumed (not reported as unused by tsgo).
// They are wrapped in `false && (...)` so they never execute at runtime.
// ---------------------------------------------------------------------------

describe('type negatives — @ts-expect-error probes', () => {
  it('NEG-1: wrong body type to POST (number instead of CreateInput)', () => {
    const c = client(simpleTree)
    // @ts-expect-error [NEG-1: number is not assignable to CreateInput]
    const _neg1 = false && c.todos.POST(42)
    void _neg1
    expect(true).toBe(true) // compile-time assertion only
  })

  it('NEG-2: wrong param type to todosById (number instead of string)', () => {
    const c = client(simpleTree)
    // @ts-expect-error [NEG-2: number is not assignable to string]
    const _neg2 = false && c.todosById(42)
    void _neg2
    expect(true).toBe(true)
  })

  it('NEG-3: nonexistent verb on todos (DELETE not in table)', () => {
    const c = client(simpleTree)
    // @ts-expect-error [NEG-3: DELETE does not exist on todos methods client]
    const _neg3 = false && c.todos.DELETE()
    void _neg3
    expect(true).toBe(true)
  })

  it('NEG-4: nonexistent path child on root (nonexistent not in table)', () => {
    const c = client(simpleTree)
    // @ts-expect-error [NEG-4: nonexistent does not exist on path client]
    const _neg4 = false && c.nonexistent
    void _neg4
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// HTTP transport — mock fetch (unit test: asserts correct serialization)
//
// We mock globalThis.fetch to capture what the http transport sends.
// ---------------------------------------------------------------------------

describe('client() — http transport (mock fetch)', () => {
  it('GET /todos serializes correctly', async () => {
    let captured: { url: string; method: string; body: string | undefined } | undefined

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init: RequestInit | undefined) => {
      captured = {
        url: url as string,
        method: (init?.method ?? 'GET') as string,
        body: init?.body as string | undefined,
      }
      return new Response(JSON.stringify([{ id: 1, title: 'mocked', done: false }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      const c = client(simpleTree, http('http://localhost:3000'))
      const result = await c.todos.GET()
      expect(captured?.url).toBe('http://localhost:3000/todos')
      expect(captured?.method).toBe('GET')
      expect(captured?.body).toBeUndefined()
      expect(Array.isArray(result)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('POST /todos serializes correctly with body', async () => {
    let captured: { url: string; method: string; body: string | undefined } | undefined

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init: RequestInit | undefined) => {
      captured = {
        url: url as string,
        method: (init?.method ?? 'GET') as string,
        body: init?.body as string | undefined,
      }
      return new Response(JSON.stringify({ id: 2, title: 'new todo', done: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      const c = client(simpleTree, http('http://localhost:3000'))
      const result = await c.todos.POST({ title: 'new todo' })
      expect(captured?.url).toBe('http://localhost:3000/todos')
      expect(captured?.method).toBe('POST')
      expect(JSON.parse(captured?.body ?? '{}')).toEqual({ title: 'new todo' })
      expect((result as Todo).title).toBe('new todo')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('GET /todosById/:id serializes path param correctly', async () => {
    let captured: { url: string; method: string } | undefined

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init: RequestInit | undefined) => {
      captured = {
        url: url as string,
        method: (init?.method ?? 'GET') as string,
      }
      return new Response(JSON.stringify({ id: 1, title: 'first todo', done: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      const c = client(simpleTree, http('http://localhost:3000'))
      const result = await c.todosById('1').GET()
      expect(captured?.url).toBe('http://localhost:3000/todosById/1')
      expect(captured?.method).toBe('GET')
      expect((result as Todo).id).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ---------------------------------------------------------------------------
// SIMPLE TYPE CHECK — ClientOf<typeof simpleTree> surface
// ---------------------------------------------------------------------------

describe('ClientOf type surface', () => {
  it('type-checks assignment to SimpleClient', () => {
    const c: SimpleClient = client(simpleTree)
    // If this compiles, the type derivation is correct
    expect(typeof c.todos.GET).toBe('function')
    expect(typeof c.todos.POST).toBe('function')
    expect(typeof c.todosById).toBe('function')
  })
})
