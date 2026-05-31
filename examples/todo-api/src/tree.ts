// examples/todo-api/src/tree.ts
// The SINGLE definition of the fractal tree. Both the server and the typed
// client derive from `typeof tree` — no separate schema or contract file.

import {
  branch,
  leaf,
  withAuth,
  validated,
  returns,
  ok,
} from '@rhi-zone/fractal-core'
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'

// ── domain types ────────────────────────────────────────────────────────────

export interface Todo {
  id: number
  title: string
}

// A hand-rolled Standard Schema that ALSO implements the optional JSON-Schema
// trait (`StandardJSONSchemaV1`). One explicit `~standard` shape carries BOTH
// `validate` (so `validated`/`returns` accept it as a `StandardSchemaV1`) and
// `jsonSchema` (so the standard-schema / OpenAPI projection can read
// `~standard.jsonSchema[role]({ target })`). The shape is declared as a single
// type — not an intersection — so the object literal's excess-property check
// passes; an `assignableTo` helper then proves it is a valid `StandardSchemaV1`.
// These schemas double as an OpenAPI fixture; no validator library is pulled in.
interface SchemaWithJson<I, O> {
  readonly '~standard': StandardSchemaV1.Props<I, O> &
    StandardJSONSchemaV1.Props<I, O>
}

// Compile-time proof that the doubled-up schema is a valid `StandardSchemaV1`
// (the runtime is the identity function).
const asStandardSchema = <I, O>(
  s: SchemaWithJson<I, O>,
): StandardSchemaV1<I, O> => s

// ── endpoint: plain ─────────────────────────────────────────────────────────
// GET /ping → "pong"
// Wrapped in `returns` so the tree carries a (doc-only) output schema for the
// OpenAPI fixture; `returns` does NOT validate and preserves the leaf's I/O/E.

const pongSchema = {
  '~standard': {
    version: 1,
    vendor: 'todo-api',
    validate: (value: unknown) => ({ value: value as string }),
    jsonSchema: {
      input: () => ({ type: 'string', const: 'pong' }),
      output: () => ({ type: 'string', const: 'pong' }),
    },
    types: undefined as unknown as { input: unknown; output: string },
  },
} satisfies SchemaWithJson<unknown, string>

const ping = returns(
  asStandardSchema(pongSchema),
  leaf<unknown, string>(() => ok('pong')),
)

// ── endpoint: withAuth ───────────────────────────────────────────────────────
// POST /me → the authenticated user's name
// Requires a valid auth handle (injected by the server's 'auth' grant).

const me = withAuth(
  leaf<unknown, string, never, { auth: { user: string | null } }>(
    (_input, ctx) => ok(`hello, ${ctx.caps.auth.user}`),
  ),
)

// ── endpoint: validated seq ─────────────────────────────────────────────────
// POST /todos/add  body: { title: string }  → Todo
// The `validated` stage runs first (unknown → { title: string }) via a Standard
// Schema; the leaf runs only if validation passes. The inline schema also
// implements the JSON-Schema trait so the tree doubles as an OpenAPI fixture.
// On failure the new `validated` joins the issue messages with '; '.

const todoInput = {
  '~standard': {
    version: 1,
    vendor: 'todo-api',
    validate: (value: unknown) => {
      const i = value as { title?: unknown }
      return typeof i?.title === 'string' && i.title.length > 0
        ? { value: { title: i.title } }
        : { issues: [{ message: 'title must be a non-empty string' }] }
    },
    jsonSchema: {
      input: () => ({
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      }),
      output: () => ({
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      }),
    },
    types: undefined as unknown as {
      input: unknown
      output: { title: string }
    },
  },
} satisfies SchemaWithJson<unknown, { title: string }>


// Doc-only output schema for the created Todo, read as the response schema.
const todoOutput = {
  '~standard': {
    version: 1,
    vendor: 'todo-api',
    validate: (value: unknown) => ({ value: value as Todo }),
    jsonSchema: {
      input: () => ({
        type: 'object',
        properties: { id: { type: 'integer' }, title: { type: 'string' } },
        required: ['id', 'title'],
      }),
      output: () => ({
        type: 'object',
        properties: { id: { type: 'integer' }, title: { type: 'string' } },
        required: ['id', 'title'],
      }),
    },
    types: undefined as unknown as { input: unknown; output: Todo },
  },
} satisfies SchemaWithJson<unknown, Todo>

let nextId = 1
const addTodo = returns(
  asStandardSchema(todoOutput),
  validated(asStandardSchema(todoInput)).then(
    leaf<{ title: string }, Todo>(({ title }) => {
      const todo: Todo = { id: nextId++, title }
      return ok(todo)
    }),
  ),
)

// ── tree ─────────────────────────────────────────────────────────────────────

export const tree = branch({
  ping,
  me,
  todos: branch({
    add: addTodo,
  }),
})

export type Tree = typeof tree
