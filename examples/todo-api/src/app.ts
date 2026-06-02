// examples/todo-api/src/app.ts
// A real example: a few routes using path/param/methods/body+validate/header.
// Served via the http kit. No external deps beyond the fractal packages.
//
// The composition unit is Node<P,Res> = { meta, handler }.
// app.meta is walkable — toOpenApi(app, info) projects it to OpenAPI 3.0.
//
// Demonstrates:
//   - StandardSchemaV1 with jsonSchema trait → real requestBody schema in OpenAPI
//   - NodeMiddleware (withSecurity) contributing a security descriptor to meta
//     and enforcing at request time — the same node runs both

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
  pass,
  type Node,
  type NodeMiddleware,
  type HandlerWithBody,
} from '@rhi-zone/fractal-http'
import type { StandardSchemaV1, StandardJSONSchemaV1 } from '@rhi-zone/fractal-core'

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

// ── inline StandardSchemaV1 for CreateInput ───────────────────────────────────
//
// No validator library dependency. Implements both:
//   '~standard'.validate          — called at request time by validate()
//   '~standard'.jsonSchema        — optional JSON-Schema trait; toOpenApi uses it
//     .input({ target })          — schema for the incoming payload (used for requestBody)
//     .output({ target })         — schema for the validated value

interface CreateInput { title: string }

const createInputSchema: StandardSchemaV1<unknown, CreateInput> & StandardJSONSchemaV1<unknown, CreateInput> = {
  '~standard': {
    version: 1 as const,
    vendor: 'fractal-example',
    validate(value: unknown): StandardSchemaV1.Result<CreateInput> {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>)['title'] === 'string'
      ) {
        return { value: { title: (value as Record<string, unknown>)['title'] as string } }
      }
      return { issues: [{ message: `expected {title:string}, got ${JSON.stringify(value)}` }] }
    },
    jsonSchema: {
      input: (_opts) => ({
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      }),
      output: (_opts) => ({
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      }),
    },
  },
}

// ── withSecurity: NodeMiddleware that contributes a security descriptor ────────
//
// Wraps a Node to:
//   1. emit meta { kind: "security", schemes, child: inner.meta } — picked up by toOpenApi
//   2. enforce at request time by calling enforce(req); if it throws or returns Pass, pass
//
// This is the documented Node→Node + meta-merge pattern.
// The "security" meta kind is handled by @rhi-zone/fractal-openapi's walker.

type SecurityScheme = Record<string, string[]>

function withSecurity<P extends Record<string, unknown>, Res>(
  schemes: SecurityScheme[],
  enforce: (req: { headers?: Record<string, string> }) => void,
): NodeMiddleware<P, Res> {
  return (inner) => ({
    meta: { kind: 'security', schemes, child: inner.meta },
    handler: async (req) => {
      const httpReq = req as unknown as { headers?: Record<string, string> }
      try {
        enforce(httpReq)
      } catch {
        return pass
      }
      return inner.handler(req)
    },
  })
}

// bearerAuth: check for Authorization: Bearer <token>
// Returns pass (→ 404) on missing/invalid token.
const requireBearerAuth = withSecurity<Record<string, never>, ApiResult>(
  [{ bearerAuth: [] }],
  (req) => {
    const auth = req.headers?.['authorization'] ?? ''
    if (!auth.startsWith('Bearer ')) {
      throw new Error('missing or invalid Authorization header')
    }
  },
)

// ── leaves ────────────────────────────────────────────────────────────────────

const listAll: Node<Record<string, never>, Todo[]> = leaf(async (_req) => [...store])

const listWithLimit: Node<{ limit: string }, Todo[]> = leaf(async (req) => {
  const n = Number(req.params.limit)
  return store.slice(0, Number.isFinite(n) && n > 0 ? n : store.length)
})

const getByIdLeaf: Node<{ id: number }, Todo | null> = leaf(async (req) =>
  store.find((t) => t.id === req.params.id) ?? null,
)

// Bridge string → number
const getById: Node<{ id: string }, Todo | null> = typed<
  { id: number },
  { id: string },
  Todo | null
>((raw) => ({ id: Number(raw['id']) }))(getByIdLeaf)

// Tenant-scoped list (header capture)
const listForTenant: Node<{ 'x-tenant': string }, Todo[]> = leaf(async (req) => {
  const tenant = req.params['x-tenant']
  return store.map((t) => ({ ...t, title: `[${tenant}] ${t.title}` }))
})

// Body-based create: uses the inline StandardSchemaV1 with jsonSchema trait.
// validate(createInputSchema, ...) → schema flows into OpenAPI requestBody.
// requireBearerAuth wraps the node → "security" meta → OpenAPI security entry.
const createLeaf: HandlerWithBody<Record<string, never>, CreateInput, Todo> = async (req) => {
  const todo: Todo = { id: nextId++, title: req.body.title, done: false }
  store.push(todo)
  return todo
}

const createHandler: Node<Record<string, never>, ApiResult> = requireBearerAuth(
  body(validate(createInputSchema, createLeaf)) as Node<Record<string, never>, ApiResult>,
)

// ── routing tree ──────────────────────────────────────────────────────────────

export const app: Node<Record<string, never>, ApiResult> = path<Record<string, never>, ApiResult>({
  todos: choice<Record<string, never>, ApiResult>(
    // GET /todos?limit=N
    query('limit', methods<{ limit: string }, ApiResult>({ GET: listWithLimit })),
    // GET /todos with x-tenant header
    header('x-tenant', methods<{ 'x-tenant': string }, ApiResult>({ GET: listForTenant })),
    // GET /todos or POST /todos (POST requires bearer auth)
    methods<Record<string, never>, ApiResult>({
      GET: listAll,
      POST: createHandler,
    }),
    // GET /todos/:id
    param('id', methods<{ id: string }, ApiResult>({ GET: getById })),
  ),
})
