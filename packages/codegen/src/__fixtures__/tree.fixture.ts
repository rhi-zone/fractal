// packages/codegen/src/__fixtures__/tree.fixture.ts
//
// A real Node tree used by extract.test.ts as BOTH the extractor's source input
// (parsed via the compiler API for its leaf handler input types + JSDoc) and the
// runtime tree fed to toTools. Not a test file (no `.test.ts`), so bun test skips it.
//
// In the new node model, leaf nodes (callables) are stored in `children` as
// `op(fn, meta?)` calls. The codegen walker recognises `op(...)` children as
// leaves and extracts their input schemas.

import { api, op } from "@rhi-zone/fractal-core/node"
// (a) Direct import from core's package root.
import type { Result } from "@rhi-zone/fractal-core"
// (b) Barrel re-export: Result re-exported through a local barrel FILE, name
// unchanged. TypeScript sees the same identifier "Result" — the syntax path
// matches it by name and extracts the first type argument.
import type { Result as ResultFromBarrel } from "./result-reexport.fixture.ts"

// (c) Further-generic alias: a local type alias that wraps Result<T, string>.
// The syntax path recognizes this by walking the local TypeAliasDeclaration —
// its body is a TypeReference named "Result", so the first type arg at the call
// site maps to T.
type ApiResult<T> = Result<T, string>

export const tree = api({
    users: api({
        /** Create a new user account. */
        create: op(
          (_input: {
            name: string
            age?: number
            roles: string[]
            address: { street: string; zip?: string }
          }) => ({ id: "u1" }),
        ),
      }, { fallback: {
        name: "userId",
        subtree: api({
            get: op((input: { userId: string }) => ({ userId: input.userId })),
          }),
      } }),
    // Union input → exercises the punt path.
    search: api({
        run: op((_input: { q: string | number }) => ({ hits: 0 })),
      }),
    // Promise<T> return → output schema should unwrap to T's schema.
    async: api({
        fetch: op(async (_input: { id: string }) => ({ value: 42 })),
      }),
    // (a) Direct import: Result<T,E> — syntax path extracts T by name + 2 typeArgs.
    fallible: api({
        compute: op(
          (_input: { x: number }): Result<{ answer: number }, string> =>
            ({ kind: "ok", value: { answer: _input.x } }),
        ),
      }),
    // (b) Barrel re-export: same "Result" name imported through a local barrel.
    // The syntax path checks the identifier name, not the origin file, so it
    // correctly extracts T from `ResultFromBarrel<{count:number}>`.
    barrel: api({
        query: op(
          (_input: { term: string }): ResultFromBarrel<{ count: number }, string> =>
            ({ kind: "ok", value: { count: 0 } }),
        ),
      }),
    // (c) Further-generic alias: ApiResult<T> = Result<T, string>.
    // Syntax path walks the local TypeAliasDeclaration and recognizes the pattern.
    generic: api({
        search: op(
          (_input: { q: string }): ApiResult<{ items: string[] }> =>
            ({ kind: "ok", value: { items: [] } }),
        ),
      }),
    // Promise<Result<T,E>> → syntax path strips Promise first, then unwraps Result.
    promiseResult: api({
        load: op(
          async (_input: { id: string }): Promise<Result<{ name: string }, string>> =>
            ({ kind: "ok", value: { name: "Alice" } }),
        ),
      }),
    // Genuinely-different union that must NOT be false-positived.
    // This is a 2-member union but does NOT have the Result name or DU shape.
    differentUnion: api({
        ping: op(
          (_input: { x: number }): { kind: "a"; x: number } | { kind: "b"; y: string } =>
            ({ kind: "a", x: _input.x }),
        ),
      }),
  })
