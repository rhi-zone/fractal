import { describe, it, expect } from 'vitest'
import { structuredCloneCodec } from './index.ts'

describe('structuredCloneCodec', () => {
  it('is the identity: the wire unit IS the envelope object', () => {
    const value = { a: 1, m: new Map([['k', 2]]) }
    const wire = structuredCloneCodec.encode(value)
    expect(wire).toBe(value)
    expect(structuredCloneCodec.decode(wire)).toBe(value)
  })
})
