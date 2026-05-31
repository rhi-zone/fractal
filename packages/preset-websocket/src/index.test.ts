// @rhi-zone/fractal-preset-websocket — smoke tests
// Full e2e coverage lives in packages/channel-websocket/src/index.test.ts
// (which exercises wsClient + serveWs from this preset, plus a bare compose
// one-liner, over a real Bun WebSocket server).

import { describe, it, expect } from 'vitest'
import { wsClient, serveWs } from './index.ts'

describe('preset-websocket exports', () => {
  it('exports wsClient as a function', () => {
    expect(typeof wsClient).toBe('function')
  })

  it('exports serveWs as a function', () => {
    expect(typeof serveWs).toBe('function')
  })
})
