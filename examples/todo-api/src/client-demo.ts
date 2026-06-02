// examples/todo-api/src/client-demo.ts
//
// Demonstrates the typed in-process client derived from a fractal Node tree.
//
// The full app.ts uses choice() for collection-level dispatch (query/header/auth
// variants) which makes the surface opaque to the typed client — as documented in
// spike/typed-client.ts (DESIGN NOTE) and packages/client/src/index.ts.
//
// This demo builds a simplified typed tree (path + route, no choice()) so the
// client can derive the full surface:
//   client.todos.GET()           → Todo[]
//   client.todos.POST({title})   → Todo
//   client.todos('1').GET()      → Todo | null
//
// Same Node, same handler logic — only the routing shape differs (route() vs choice()).
// Hyper unification: the client IS the server handler, invoked in-process.

import { route, methods, leaf, body, validate, path } from '@rhi-zone/fractal-http'
import type { MethodsMeta } from '@rhi-zone/fractal-http'
import type { Node } from '@rhi-zone/fractal-core'
import { client } from '@rhi-zone/fractal-client'
import { store, type Todo } from './app.ts'

// ── Domain ────────────────────────────────────────────────────────────────────

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

// ── Typed route tree (no choice()) ───────────────────────────────────────────
//
// route() both-and combinator:
//   collection = methods({GET: list, POST: create})  — handles /todos
//   param = {name:'id', child: methods({GET: getById})}  — handles /todos/:id

let nextId = store.length + 1

const listAll = leaf<Record<string, never>, Todo[]>(async () => [...store])

const createTodo = body(validate(parseCreate, async (req) => {
  const todo: Todo = { id: nextId++, title: req.body.title, done: false }
  store.push(todo)
  return todo
}))

const getById = leaf<{ id: string }, Todo | null>(async (req) =>
  store.find((t) => t.id === Number(req.params.id)) ?? null,
)

// The param child: methods({GET: getById}) — cast to Node<{},Todo|null,MethodsMeta<{GET:getById}>>
// to satisfy route()'s fully-discharged requirement while preserving the literal meta type.
// The `id` param is injected at runtime by route()'s param dispatch; the cast is safe.
type GetByIdMethods = Node<Record<string, never>, Todo | null, MethodsMeta<{ GET: typeof getById }>>
const byIdMethods = methods({
  GET: getById as unknown as typeof listAll,
}) as unknown as GetByIdMethods

const todosRoute = route(
  methods({ GET: listAll, POST: createTodo }),
  {
    param: {
      name: 'id' as const,
      child: byIdMethods,
    },
  },
)

const typedApp = path({ todos: todosRoute })

// ── Typed client ─────────────────────────────────────────────────────────────

const c = client(typedApp)

// Type probe — the compiler verifies this is the correct surface:
//   c.todos.GET()         → Promise<Todo[]>
//   c.todos.POST({title}) → Promise<Todo>
//   c.todos('1')          → callable-object hybrid with .GET()
//
// These are COMPILE-TIME checks (assignments would fail if types are wrong).

console.log('=== fractal typed client demo (in-process Hyper unification) ===\n')
console.log('Tree: path({ todos: route(methods({GET,POST}), {param:{name:"id",child:methods({GET})}}) })')
console.log('client(typedApp) — same Node, invoked in-process\n')

// ── Calls ─────────────────────────────────────────────────────────────────────

const r1 = await c.todos.GET()
console.log('client.todos.GET()                      →', JSON.stringify(r1))

const r2 = await c.todos.POST({ title: 'new from client-demo' })
console.log('client.todos.POST({title:"new …"})      →', JSON.stringify(r2))

const r3 = await c.todos.GET()
console.log('client.todos.GET() after POST           →', JSON.stringify(r3))

// c.todos is the route's callable-object hybrid: callable for param, has verb props
const todoById1 = await c.todos('1').GET()
console.log('client.todos("1").GET()                 →', JSON.stringify(todoById1))

const todoByIdNew = await c.todos(String(r2.id)).GET()
console.log(`client.todos("${r2.id}").GET()              →`, JSON.stringify(todoByIdNew))

const todoByIdMissing = await c.todos('9999').GET()
console.log('client.todos("9999").GET()              →', JSON.stringify(todoByIdMissing), '(null expected)')

console.log('\n=== Hyper unification: client is the server handler ===')
console.log('No network. client(typedApp) invokes typedApp.handler in-process.')
console.log('Same Node → HTTP server (via serve()) AND typed client (via client()).')
console.log('\n=== DONE ===')
