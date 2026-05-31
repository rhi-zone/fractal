// @rhi-zone/fractal-core
// Inert-data node IR, capability contracts, Context, and the combinator surface.
//
// Composition is core; structure is reflectable data; only `leaf` carries code.
// The full tree is intentionally NOT JSON-serializable (closures live in leaves).

export type { Result, Context, Handler, StreamHandler } from './result.ts'
export { ok, err } from './result.ts'

export type {
  Annotation,
  NodeMeta,
  Leaf,
  StreamLeaf,
  LeafMode,
  Branch,
  Annotated,
  Seq,
  AnyNode,
  InputOf,
  OutputOf,
  ErrorOf,
  ModeOf,
  CapsOf,
} from './node.ts'

export {
  leaf,
  streamLeaf,
  branch,
  annotate,
  capability,
  withCapability,
  identity,
} from './combinators.ts'
export type {
  Chainable,
  Capability,
  LeafNode,
  StreamLeafNode,
  BranchNode,
  SeqNode,
  AnnotatedNode,
} from './combinators.ts'

export {
  withAuth,
  withRateLimit,
  validated,
  route,
  get,
} from './presets.ts'
export type {
  UnauthorizedError,
  AuthCaps,
  RateLimitedError,
  RateLimitCaps,
  ValidationError,
} from './presets.ts'

export { evaluate, evaluateStream } from './evaluate.ts'
export type { Callable } from './evaluate.ts'

export { client } from './client.ts'
export type { Client, UClient, Meta, ClientOptions } from './client.ts'
