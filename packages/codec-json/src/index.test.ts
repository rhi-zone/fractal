import { describe, it, expect } from 'vitest'
import { jsonCodec } from './index.ts'

describe('jsonCodec', () => {
  it('round-trips a value through a JSON string wire unit', () => {
    const value = { a: 1, b: ['x', true, null] }
    const wire = jsonCodec.encode(value)
    expect(typeof wire).toBe('string')
    expect(jsonCodec.decode(wire)).toEqual(value)
  })
})
