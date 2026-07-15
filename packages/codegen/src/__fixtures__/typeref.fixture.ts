// packages/codegen/src/__fixtures__/typeref.fixture.ts
//
// Standalone functions used to exercise typeRefFromType / typeRefFromFunctionNode
// / typeRefFromReturnType directly (not through the tree walker).

import type { Result } from "@rhi-zone/fractal-core"

export const sample = (input: {
  name: string
  age?: number
  tags: string[]
}): Result<{ total: number }, string> => ({
  ok: true,
  value: { total: input.tags.length },
})
