// packages/openapi/src/index.test.ts
//
// Tests for toOpenApi and toJsonSchema.
// Uses a representative todos API tree:
//   GET  /todos           (list)
//   POST /todos           (create with requestBody)
//   GET  /todos/{id}      (get by path param)
//
// Hand-rolled StandardSchemaV1 fixture (no real validator dep):
//   { '~standard': { version: 1, vendor: 'test', validate, jsonSchema: { input, output } } }

import { describe, it, expect } from 'vitest'
import { leaf, typed, choice, path, methods, param, body, validate } from '@rhi-zone/fractal-http'
import type { Node } from '@rhi-zone/fractal-core'
import type { StandardSchemaV1, StandardJSONSchemaV1 } from '@standard-schema/spec'
import { toOpenApi, toJsonSchema } from './index.ts'

// ---------------------------------------------------------------------------
// Hand-rolled Standard Schema fixture
// ---------------------------------------------------------------------------

type TodoInput = { title: string }

/**
 * makeTestSchema: a minimal StandardSchemaV1 + StandardJSONSchemaV1 fixture.
 * validate: accepts objects with { title: string }; rejects everything else.
 * jsonSchema: returns a fixed schema object for both input and output.
 */
function makeTestSchema(
  jsonSchemaObject: Record<string, unknown>,
): StandardSchemaV1<unknown, TodoInput> & StandardJSONSchemaV1<unknown, TodoInput> {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate(value: unknown): StandardSchemaV1.Result<TodoInput> {
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as Record<string, unknown>)['title'] === 'string'
        ) {
          return { value: value as TodoInput }
        }
        return { issues: [{ message: 'expected {title:string}' }] }
      },
      jsonSchema: {
        input: (_opts) => jsonSchemaObject,
        output: (_opts) => jsonSchemaObject,
      },
    },
  }
}

const todoBodySchema = makeTestSchema({
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
})

// ---------------------------------------------------------------------------
// Build a representative todos API tree
// ---------------------------------------------------------------------------

type Todo = { id: string; title: string }
type ApiResult = Todo | Todo[] | null

const listLeaf: Node<Record<string, never>, Todo[]> = leaf(async () => [])

const createHandler: Node<Record<string, never>, Todo> = body(
  validate(todoBodySchema, async (req) => ({ id: 'new', title: req.body.title })),
)

const getByIdLeaf: Node<{ id: string }, Todo | null> = leaf(async (req) => ({
  id: req.params.id,
  title: 'Example',
}))

const app: Node<Record<string, never>, ApiResult> = path<Record<string, never>, ApiResult>({
  todos: choice<Record<string, never>, ApiResult>(
    methods<Record<string, never>, ApiResult>({
      GET: listLeaf,
      POST: createHandler as Node<Record<string, never>, ApiResult>,
    }),
    param('id', methods<{ id: string }, ApiResult>({ GET: getByIdLeaf })),
  ),
})

// ---------------------------------------------------------------------------
// toOpenApi tests
// ---------------------------------------------------------------------------

describe('toOpenApi', () => {
  const doc = toOpenApi(app, { title: 'Todos API', version: '1.0.0' })

  it('produces openapi 3.0.3', () => {
    expect(doc.openapi).toBe('3.0.3')
  })

  it('carries the info', () => {
    expect(doc.info.title).toBe('Todos API')
    expect(doc.info.version).toBe('1.0.0')
  })

  it('has /todos path', () => {
    expect(Object.keys(doc.paths)).toContain('/todos')
  })

  it('has /todos/{id} path', () => {
    expect(Object.keys(doc.paths)).toContain('/todos/{id}')
  })

  it('GET /todos has no requestBody', () => {
    const op = doc.paths['/todos']?.['get']
    expect(op).toBeDefined()
    expect(op?.requestBody).toBeUndefined()
  })

  it('POST /todos has a requestBody with the schema', () => {
    const op = doc.paths['/todos']?.['post']
    expect(op).toBeDefined()
    expect(op?.requestBody).toBeDefined()
    const schema = op?.requestBody?.content?.['application/json']?.schema
    expect(schema).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    })
  })

  it('GET /todos/{id} has a path parameter', () => {
    const op = doc.paths['/todos/{id}']?.['get']
    expect(op).toBeDefined()
    expect(op?.parameters).toBeDefined()
    const pathParam = op?.parameters.find((p) => p.in === 'path' && p.name === 'id')
    expect(pathParam).toBeDefined()
    expect(pathParam?.required).toBe(true)
  })

  it('GET /todos/{id} has no requestBody', () => {
    const op = doc.paths['/todos/{id}']?.['get']
    expect(op?.requestBody).toBeUndefined()
  })

  it('all operations have a 200 response', () => {
    for (const pathItem of Object.values(doc.paths)) {
      for (const op of Object.values(pathItem)) {
        expect(op.responses['200']).toBeDefined()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// toJsonSchema tests
// ---------------------------------------------------------------------------

describe('toJsonSchema', () => {
  const frag = toJsonSchema(app)

  it('returns an object schema', () => {
    expect(frag.type).toBe('object')
  })

  it('has /todos and /todos/{id} as properties', () => {
    const props = frag.properties as Record<string, unknown>
    expect(props).toHaveProperty('/todos')
    expect(props).toHaveProperty('/todos/{id}')
  })

  it('/todos post has a requestBody schema', () => {
    const props = frag.properties as Record<string, unknown>
    const todosPost = (props['/todos'] as Record<string, unknown>)['post'] as Record<string, unknown>
    expect(todosPost).toBeDefined()
    expect(todosPost['requestBody']).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' } },
    })
  })
})

// ---------------------------------------------------------------------------
// Degrade gracefully when jsonSchema trait is absent
// ---------------------------------------------------------------------------

describe('toOpenApi without jsonSchema trait', () => {
  // A schema with only validate (no jsonSchema)
  const schemaNoJsonSchema: StandardSchemaV1<unknown, TodoInput> = {
    '~standard': {
      version: 1 as const,
      vendor: 'test-no-jsonschema',
      validate(value: unknown): StandardSchemaV1.Result<TodoInput> {
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as Record<string, unknown>)['title'] === 'string'
        ) {
          return { value: value as TodoInput }
        }
        return { issues: [{ message: 'expected {title:string}' }] }
      },
    },
  }

  const appNoSchema: Node<Record<string, never>, ApiResult> = path<Record<string, never>, ApiResult>({
    items: methods<Record<string, never>, ApiResult>({
      POST: body(
        validate(schemaNoJsonSchema, async (req) => ({
          id: 'new',
          title: (req.body as TodoInput).title,
        })),
      ) as Node<Record<string, never>, ApiResult>,
    }),
  })

  it('produces a doc with an empty schema when jsonSchema trait is absent', () => {
    const doc = toOpenApi(appNoSchema, { title: 'Test', version: '0.0.1' })
    const op = doc.paths['/items']?.['post']
    expect(op?.requestBody?.content['application/json'].schema).toEqual({})
  })
})
