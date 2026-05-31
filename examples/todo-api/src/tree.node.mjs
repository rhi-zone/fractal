// examples/todo-api/src/tree.node.mjs
// Plain-JS version of tree.ts for the Node.js e2e runner.
// Imports from built dist files using relative paths so no workspace resolver
// is needed — works with plain `node` after `bun run build`.

import { branch, leaf, withAuth, validated, ok, err } from '../../../packages/core/dist/core.js'

// ── endpoint: plain ─────────────────────────────────────────────────────────
const ping = leaf(() => ok('pong'))

// ── endpoint: withAuth ───────────────────────────────────────────────────────
const me = withAuth(
  leaf((_input, ctx) => ok(`hello, ${ctx.caps.auth.user}`)),
)

// ── endpoint: validated seq ─────────────────────────────────────────────────
const parseTodo = validated((input) => {
  const i = input
  if (typeof i?.title === 'string' && i.title.length > 0) {
    return ok({ title: i.title })
  }
  return err({ code: 'invalid', message: 'title must be a non-empty string' })
})

let nextId = 1
const addTodo = parseTodo.then(
  leaf(({ title }) => {
    const todo = { id: nextId++, title }
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
