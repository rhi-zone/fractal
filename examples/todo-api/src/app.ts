// examples/todo-api/src/app.ts
// A real example: a few routes using path/param/methods/body+validate/header.
// Served via the http kit. No external deps beyond the fractal packages.

import {
  path,
  methods,
  param,
  query,
  header,
  body,
  validate,
  choice,
  leaf,
  typed,
  type Handler,
  type HandlerWithBody,
} from '@rhi-zone/fractal-http'

// ── domain ────────────────────────────────────────────────────────────────────

export interface Todo {
  id: number
  title: string
  done: boolean
}

let nextId = 1
export const store: Todo[] = [
  { id: nextId++, title: 'fractal todo example', done: false },
]

export type ApiResult = Todo | Todo[] | { error: string } | null

// ── leaves ────────────────────────────────────────────────────────────────────

const listAll: Handler<Record<string, never>, Todo[]> = leaf(async (_req) => [...store])

const listWithLimit: Handler<{ limit: string }, Todo[]> = leaf(async (req) => {
  const n = Number(req.params.limit)
  return store.slice(0, Number.isFinite(n) && n > 0 ? n : store.length)
})

const getByIdLeaf: Handler<{ id: number }, Todo | null> = leaf(async (req) =>
  store.find((t) => t.id === req.params.id) ?? null,
)

// Bridge string → number
const getById: Handler<{ id: string }, Todo | null> = typed<
  { id: number },
  { id: string },
  Todo | null
>((raw) => ({ id: Number(raw['id']) }))(getByIdLeaf)

// Tenant-scoped list (header capture)
const listForTenant: Handler<{ 'x-tenant': string }, Todo[]> = leaf(async (req) => {
  const tenant = req.params['x-tenant']
  return store.map((t) => ({ ...t, title: `[${tenant}] ${t.title}` }))
})

// Body-based create
interface CreateInput { title: string }

function parseCreateBody(raw: unknown): CreateInput {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as Record<string, unknown>)['title'] !== 'string'
  ) {
    throw new Error(`invalid body: expected {title:string}, got ${JSON.stringify(raw)}`)
  }
  return { title: (raw as Record<string, unknown>)['title'] as string }
}

const createLeaf: HandlerWithBody<Record<string, never>, CreateInput, Todo> = async (req) => {
  const todo: Todo = { id: nextId++, title: req.body.title, done: false }
  store.push(todo)
  return todo
}

const createHandler: Handler<Record<string, never>, Todo> = body(
  validate(parseCreateBody, createLeaf),
)

// ── routing tree ──────────────────────────────────────────────────────────────

export const app: Handler<Record<string, never>, ApiResult> = path<Record<string, never>, ApiResult>({
  todos: choice<Record<string, never>, ApiResult>(
    // GET /todos?limit=N
    query('limit', methods<{ limit: string }, ApiResult>({ GET: listWithLimit })),
    // GET /todos with x-tenant header
    header('x-tenant', methods<{ 'x-tenant': string }, ApiResult>({ GET: listForTenant })),
    // GET /todos or POST /todos
    methods<Record<string, never>, ApiResult>({
      GET: listAll,
      POST: createHandler as Handler<Record<string, never>, ApiResult>,
    }),
    // GET /todos/:id
    param('id', methods<{ id: string }, ApiResult>({ GET: getById })),
  ),
})
