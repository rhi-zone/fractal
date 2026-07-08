// packages/codegen/src/__fixtures__/tree.fixture.ts
//
// A real Node tree used by extract.test.ts as BOTH the extractor's source input
// (parsed via the compiler API for its op input types + JSDoc) and the runtime
// tree fed to toTools. Not a test file (no `.test.ts`), so bun test skips it.

import { node, op, param } from "@rhi-zone/fractal-core/node"
import type { Result } from "@rhi-zone/fractal-core"

export const tree = node({
  children: {
    users: node({
      ops: {
        /** Create a new user account. */
        create: op(
          (_input: {
            name: string
            age?: number
            roles: string[]
            address: { street: string; zip?: string }
          }) => ({ id: "u1" }),
        ),
      },
      children: {
        userId: param(
          "userId",
          node({
            ops: {
              get: op((input: { userId: string }) => ({ userId: input.userId })),
            },
          }),
        ),
      },
    }),
    // Union input → exercises the punt path.
    search: node({
      ops: {
        run: op((_input: { q: string | number }) => ({ hits: 0 })),
      },
    }),
    // Promise<T> return → output schema should unwrap to T's schema.
    async: node({
      ops: {
        fetch: op(async (_input: { id: string }) => ({ value: 42 })),
      },
    }),
    // Result<T,E> return → union alias, punts to exotic fallback with TODO.
    fallible: node({
      ops: {
        compute: op(
          (_input: { x: number }): Result<{ answer: number }, string> =>
            ({ ok: true, value: { answer: _input.x } }),
        ),
      },
    }),
  },
})
