import { describe, expect, it } from 'vitest'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { branch, leaf, returns, validated, withAuth } from '@rhi-zone/fractal-core'
import { toJsonSchema, toOpenApi } from './index.ts'

// A Standard-Schema fixture carrying the (draft 1.1) jsonSchema trait.
const numberSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v: unknown) =>
      typeof v === 'number' ? { value: v } : { issues: [{ message: 'not a number' }] },
    jsonSchema: {
      input: () => ({ type: 'number' }),
      output: () => ({ type: 'number' }),
    },
    types: undefined,
  },
} as unknown as StandardSchemaV1<unknown, number>

const titleSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v: unknown) =>
      v && typeof v === 'object' && typeof (v as { title?: unknown }).title === 'string'
        ? { value: v }
        : { issues: [{ message: 'title required' }] },
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
    types: undefined,
  },
  // biome-ignore lint/suspicious/noExplicitAny: hand-rolled test fixture
} as any

// A fixture with NO jsonSchema trait (degradation path).
const opaqueSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v: unknown) => ({ value: v }),
    types: undefined,
  },
  // biome-ignore lint/suspicious/noExplicitAny: hand-rolled test fixture
} as any

describe('toJsonSchema', () => {
  it('resolves via the Standard-Schema jsonSchema trait', () => {
    expect(toJsonSchema(validated(numberSchema))).toEqual({ type: 'number' })
  })

  it('degrades to {} when the schema has no jsonSchema trait', () => {
    expect(toJsonSchema(validated(opaqueSchema))).toEqual({})
  })

  it('emits a plain JSON-Schema (TypeBox-style) value verbatim', () => {
    const node = returns({ type: 'string' } as object as StandardSchemaV1, leaf((x) => ({ ok: true, value: x })))
    expect(toJsonSchema(node, { role: 'output' })).toEqual({ type: 'string' })
  })

  it('returns undefined when no matching schema annotation exists', () => {
    expect(toJsonSchema(leaf((x) => ({ ok: true, value: x })))).toBeUndefined()
  })
})

describe('toOpenApi', () => {
  const handler = leaf((x) => ({ ok: true, value: x }))
  const tree = branch({
    ping: leaf(() => ({ ok: true, value: 'pong' })),
    me: withAuth(leaf(() => ({ ok: true, value: { id: 1 } }))),
    todos: branch({
      add: returns(titleSchema, validated(titleSchema).then(handler)),
    }),
  })
  const doc = toOpenApi(tree, { title: 'todo', version: '1.0.0' })

  it('emits a post operation for every endpoint path', () => {
    expect(doc.paths['/ping']?.post).toBeDefined()
    expect(doc.paths['/me']?.post).toBeDefined()
    expect(doc.paths['/todos/add']?.post).toBeDefined()
  })

  it('emits the resolved request body for a validated endpoint', () => {
    const body = doc.paths['/todos/add']?.post?.requestBody
    expect(body?.required).toBe(true)
    expect(body?.content['application/json']?.schema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    })
  })

  it('carries auth security on protected endpoints and registers the scheme', () => {
    expect(doc.paths['/me']?.post?.security).toEqual([{ auth: [] }])
    expect(doc.components?.securitySchemes?.auth).toEqual({
      type: 'http',
      scheme: 'bearer',
    })
  })

  it('produces a structurally valid document', () => {
    expect(doc.openapi).toBe('3.0.3')
    expect(doc.info).toEqual({ title: 'todo', version: '1.0.0' })
  })
})
