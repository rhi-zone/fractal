// examples/todo-api/src/tree.ts
// The SINGLE definition of the fractal tree. Both the server and the typed
// client derive from `typeof tree` — no separate schema or contract file.

import {
  branch,
  leaf,
  withAuth,
  validated,
  ok,
  err,
} from '@rhi-zone/fractal-core'

// ── domain types ────────────────────────────────────────────────────────────

export interface Todo {
  id: number
  title: string
}

// ── endpoint: plain ─────────────────────────────────────────────────────────
// GET /ping → "pong"

const ping = leaf<unknown, string>(() => ok('pong'))

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
// The `validated` stage runs first (unknown → { title: string });
// the leaf runs only if validation passes.

const parseTodo = validated<{ title: string }>((input) => {
  const i = input as { title?: unknown }
  if (typeof i?.title === 'string' && i.title.length > 0) {
    return ok({ title: i.title })
  }
  return err({ code: 'invalid' as const, message: 'title must be a non-empty string' })
})

let nextId = 1
const addTodo = parseTodo.then(
  leaf<{ title: string }, Todo>(({ title }) => {
    const todo: Todo = { id: nextId++, title }
    return ok(todo)
  }),
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
