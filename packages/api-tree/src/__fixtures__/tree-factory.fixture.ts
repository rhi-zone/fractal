// packages/api-tree/src/__fixtures__/tree-factory.fixture.ts
//
// A Node tree built inside a top-level `export function` factory instead of
// a top-level `export const` — the pattern busiless uses when a tree's
// handlers close over a value only available at deployment/composition time
// (e.g. `export function buildDomainAuthTree(composed: ComposedSurface) {
// ... return api({...}) }`). Exercises walkTree's function-declaration path
// (tree.ts's `returnExpressionOfFactoryBody`), which recognizes the LAST
// top-level statement of the body being an unconditional `return <expr>` —
// everything before it (destructuring, local `op(...)` consts, …) is walked
// over untouched.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../node.ts"

// A stand-in for a composition-time value (e.g. `ComposedSurface`) the
// factory closes over — walkTree never inspects the factory's own
// parameters, only the type of the expression it returns, so this can be
// anything.
type Composed = { greeting: string }

// The multi-statement form: destructuring + local `op(...)` consts, ending
// in `return api(...)` directly — busiless's ACTUAL pattern
// (`buildDomainAuthTree` in domain-auth.ts destructures `composed`, builds
// three `op(...)` locals, then returns `api({}, { fallback: {...} })`).
export function buildGreeterTree(composed: Composed) {
  const { greeting } = composed
  const greet = op(
    /** Say hello, closing over the composition-time greeting. */
    (_input: { name: string }) => ({ message: `${greeting} ${_input.name}` }),
  )
  return api({ greet })
}

// The single `return <expr>` shape — the expression returned directly, body
// is just the one statement.
export function buildPingTree(_composed: Composed) {
  return api({
    ping: op((_input: { count: number }) => ({ pong: _input.count })),
  })
}

// A non-exported factory — must NOT be picked up (mirrors the exported-only
// discipline already applied to `export const` trees).
function buildUnexportedTree(_composed: Composed) {
  return api({
    hidden: op((_input: { x: number }) => ({ y: _input.x })),
  })
}

// An exported factory that returns something other than a tree — must be
// skipped, same as an unrelated `export const`.
export function buildNotATree() {
  return { plain: "object" }
}

// Referenced so the unused-declaration linter/checker doesn't flag it — the
// walker itself never calls this at runtime, only reads its AST/type.
export const unexportedTreeRef = buildUnexportedTree
