// packages/worker/src/index.test.ts
//
// Tests porting the worker demo behaviors from spike/demo.ts:
// typed-number capture without typed(), procedure dispatch, not-found.
//
// All combinators now produce/consume Node<P,Res> = { meta, handler }.

import { describe, it, expect } from 'bun:test'
import {
  procedure,
  field,
  dispatch,
  leaf,
  typed,
  choice,
  pass,
  type Node,
  type Handler,
  type WorkerCall,
  type WorkerCallResult,
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

// id arrives as string — typed bridges string → number
const getTodoLeaf: Node<{ id: number }, Todo | null> = leaf(async (req) =>
  STORE.find((t) => t.id === req.params.id) ?? null,
)

const getTodo: Node<{ id: string }, Todo | null> = typed<
  { id: number },
  { id: string },
  Todo | null
>((raw) => ({ id: Number(raw['id']) }))(getTodoLeaf)

const getTodoFromParams: Node<Record<string, never>, Todo | null> = typed<
  { id: string },
  Record<string, never>,
  Todo | null
>((raw) => ({ id: String(raw['id'] ?? '') }))(getTodo)

// Worker typed capture proof: id arrives as number, NO typed() needed
const getTodoByTypedId: Node<{ id: number }, Todo | null> = leaf(async (req) =>
  STORE.find((t) => t.id === req.params.id) ?? null,
)

const getTodoTypedField: Node<Record<string, never>, Todo | null> = field(
  'id',
  (req) => {
    const v = (req.params as Record<string, unknown>)['id']
    return typeof v === 'number' ? v : pass
  },
  getTodoByTypedId,
)

let nextId = 10
const createTodo: Node<{ title: string }, Todo> = leaf(async (req) => {
  const todo: Todo = { id: nextId++, title: req.params.title, done: false }
  STORE.push(todo)
  return todo
})

const createTodoTyped: Node<Record<string, never>, Todo> = typed<
  { title: string },
  Record<string, never>,
  Todo
>((raw) => ({ title: String(raw['title'] ?? 'untitled') }))(createTodo)

// ============================================================================
// WORKER ROUTING TREE
// ============================================================================

const workerApp: Node<Record<string, never>, ApiResult> = procedure<Record<string, never>, ApiResult>({
  'todos.list': listTodos,
  'todos.get': getTodoFromParams,
  'todos.get.typed': getTodoTypedField as Node<Record<string, never>, ApiResult>,
  'todos.create': createTodoTyped,
})

// ============================================================================
// TESTS
// ============================================================================

describe('procedure dispatch', () => {
  it('todos.list returns all todos', async () => {
    const r: WorkerCallResult<ApiResult> = await dispatch<ApiResult>(workerApp, {
      procedure: 'todos.list',
    })
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.result)).toBe(true)
  })

  it('todos.get with string id resolves via typed bridge', async () => {
    const r = await dispatch<ApiResult>(workerApp, {
      procedure: 'todos.get',
      params: { id: '1' },
    })
    expect(r.ok).toBe(true)
    expect((r.result as Todo).id).toBe(1)
  })

  it('unknown procedure returns not-found error', async () => {
    const r = await dispatch<ApiResult>(workerApp, {
      procedure: 'todos.nonexistent',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('procedure not found')
    expect(r.result).toBeNull()
  })
})

describe('field capture — typed V=number (no typed() step)', () => {
  it('todos.get.typed with number id returns the todo', async () => {
    const r = await dispatch<ApiResult>(workerApp, {
      procedure: 'todos.get.typed',
      params: { id: 2 },
    } as WorkerCall)
    expect(r.ok).toBe(true)
    expect((r.result as Todo).id).toBe(2)
  })

  it('todos.get.typed with number id=3 returns todo #3', async () => {
    const r = await dispatch<ApiResult>(workerApp, {
      procedure: 'todos.get.typed',
      params: { id: 3 },
    } as WorkerCall)
    expect(r.ok).toBe(true)
    expect((r.result as Todo).id).toBe(3)
  })

  it('todos.get.typed with wrong type (string) returns not-found (field returns pass)', async () => {
    const r = await dispatch<ApiResult>(workerApp, {
      procedure: 'todos.get.typed',
      params: { id: 'not-a-number' },
    } as WorkerCall)
    // field's read fn returns pass for non-number → procedure dispatched but field passes
    expect(r.ok).toBe(false)
    expect(r.error).toBe('procedure not found')
  })
})

describe('typed capture (string params)', () => {
  it('todos.create creates a todo from string params', async () => {
    const before = STORE.length
    const r = await dispatch<ApiResult>(workerApp, {
      procedure: 'todos.create',
      params: { title: 'WorkerCreatedTodo' },
    })
    expect(r.ok).toBe(true)
    expect((r.result as Todo).title).toBe('WorkerCreatedTodo')
    expect(STORE.length).toBe(before + 1)
  })
})

describe('choice in worker context', () => {
  it('choice tries nodes in order', async () => {
    const n1: Node<Record<string, never>, string> = { meta: { kind: 'leaf' }, handler: async (_req) => pass }
    const n2: Node<Record<string, never>, string> = { meta: { kind: 'leaf' }, handler: async (_req) => 'matched' }
    const combined = choice(n1, n2)
    const r = await dispatch<string>(combined, { procedure: 'anything' })
    expect(r.ok).toBe(true)
    expect(r.result).toBe('matched')
  })
})

describe('Node meta descriptors', () => {
  it('leaf has kind:leaf meta', () => {
    const n = leaf<Record<string, never>, string>(async () => 'x')
    expect(n.meta).toEqual({ kind: 'leaf' })
  })

  it('procedure has kind:procedure meta with procedures map', () => {
    expect(workerApp.meta).toMatchObject({ kind: 'procedure' })
    const meta = workerApp.meta as unknown as { procedures: Record<string, unknown> }
    expect(Object.keys(meta.procedures)).toContain('todos.list')
  })

  it('field has kind:field meta with name', () => {
    expect(getTodoTypedField.meta).toMatchObject({ kind: 'field', name: 'id' })
  })
})

// Ensure Handler is still exported for direct use
const _handlerCheck: Handler<Record<string, never>, string> = async (_req) => 'ok'
void _handlerCheck
