import type { Handler } from './result.ts'
import { ok } from './result.ts'
import type {
  AnyNode,
  Annotation,
  Branch,
  ErrorOf,
  InputOf,
  Leaf,
  NodeMeta,
  OutputOf,
  Seq,
} from './node.ts'

/**
 * The chain surface. `.then` / `.pipe` are the ONLY way to build a Seq. The
 * `next` parameter type forces OutputOf<this> assignable to InputOf<next>: when
 * they mismatch, `next`'s expected type collapses to `never` and the call is a
 * compile error. The result is a reflectable Seq node that is itself Chainable,
 * so chains extend without losing inference.
 *
 * LAW (associativity): a.then(b).then(c) and a.then(b.then(c)) interpret
 * identically — Seq dispatch is left-fold-invariant.
 * LAW (identity unit): a.then(identity()) ≡ a ≡ identity().then(a) behaviorally.
 */
export interface Chainable<I, O, E> extends NodeMeta<I, O, E> {
  then<R extends AnyNode>(
    next: O extends InputOf<R> ? R : never,
  ): SeqNode<I, O, E, R>
  pipe<R extends AnyNode>(
    next: O extends InputOf<R> ? R : never,
  ): SeqNode<I, O, E, R>
}

/** A constructed leaf is a reflectable Leaf node plus the chain surface. */
export type LeafNode<I, O, E, Caps extends Record<string, unknown>> =
  Leaf<I, O, E, Caps> & Chainable<I, O, E>

/**
 * A constructed seq node, threaded and re-chainable. Input/output/error are
 * threaded explicitly (input from the chain head, output/error from the tail),
 * NOT re-derived from the erased `left` slot — so InputOf stays precise.
 */
export type SeqNode<I, _O, E, R extends AnyNode> =
  Omit<Seq<AnyNode, R>, '__i' | '__o' | '__e'> &
  NodeMeta<I, OutputOf<R>, E | ErrorOf<R>> &
  Chainable<I, OutputOf<R>, E | ErrorOf<R>>

/** A constructed annotated node, type-preserving over its child plus an added error. */
export type AnnotatedNode<Child extends AnyNode, EAdd, ReqCaps extends Record<string, unknown>> =
  import('./node.ts').Annotated<Child, EAdd, ReqCaps> &
  Chainable<InputOf<Child>, OutputOf<Child>, ErrorOf<Child> | EAdd>

/** A constructed branch node (branches are not chainable — they have no single I/O). */
export type BranchNode<C extends Record<string, AnyNode>> = Branch<C>

/** Attach the chain methods to a structural node object. ONE place builds chains. */
const chainable = <N extends { readonly tag: string }>(node: N): N & Chainable<unknown, unknown, unknown> => {
  const self = node as N & Chainable<unknown, unknown, unknown>
  const then = (next: AnyNode): unknown =>
    chainable({ tag: 'seq', left: self as unknown as AnyNode, right: next } as Seq<AnyNode, AnyNode>)
  Object.defineProperty(self, 'then', { value: then, enumerable: false })
  Object.defineProperty(self, 'pipe', { value: then, enumerable: false })
  return self
}

/**
 * PRIMITIVE 1 — leaf. The only constructor carrying code. With no type args an
 * untyped `leaf((i) => ...)` infers I=O=unknown, E=never (gradual typing): types
 * are an opt-in overlay, never mandatory.
 */
export const leaf = <I = unknown, O = unknown, E = never, Caps extends Record<string, unknown> = Record<string, unknown>>(
  run: Handler<I, O, E, Caps>,
): LeafNode<I, O, E, Caps> =>
  chainable({ tag: 'leaf', run } as Leaf<I, O, E, Caps>) as LeafNode<I, O, E, Caps>

/**
 * PRIMITIVE 2 — branch. Pure structure; dispatch is key indexing by an
 * interpreter. Children keep their own typed signatures.
 *
 * LAW (dispatch totality): every key in `children` resolves to a child node;
 * an interpreter's branch dispatch is total over `Object.keys(children)`.
 */
export const branch = <C extends Record<string, AnyNode>>(children: C): BranchNode<C> =>
  ({ tag: 'branch', children }) as BranchNode<C>

/**
 * PRIMITIVE 3 — annotate / capability combinators. Type-PRESERVING wrapper that
 * may inject an error and require a handle.
 *
 * LAW (annotation transparency): the wrapped node's behavior on success is
 * identical to the child's; an annotation only adds a gate/effect + its error.
 */
export const annotate = <Child extends AnyNode>(
  annotation: Annotation,
  child: Child,
): AnnotatedNode<Child, never, Record<string, never>> =>
  chainable({ tag: 'annotated', annotation, child } as import('./node.ts').Annotated<Child, never, Record<string, never>>) as AnnotatedNode<Child, never, Record<string, never>>

/**
 * A capability is a SELF-DESCRIBING combinator. It declares its OWN added error
 * `EAdd` and the handle shape `ReqCaps` it needs. Applying it widens ErrorOf by
 * exactly EAdd — with NO central kind→error map in core. New capabilities are
 * new `Capability` instances; core is never edited to add one.
 */
export interface Capability<EAdd, ReqCaps extends Record<string, unknown>> {
  readonly kind: string
  /** Optional runtime gate, run by an interpreter with the granted handle. */
  readonly enforce?: (caps: ReqCaps, signal?: AbortSignal) => { ok: true } | { ok: false; error: EAdd }
  readonly value: unknown
  readonly __eadd?: (x: EAdd) => void
  readonly __req?: (x: ReqCaps) => void
}

/** Define a capability combinator. */
export const capability = <EAdd, ReqCaps extends Record<string, unknown> = Record<string, never>>(
  kind: string,
  spec: {
    readonly value?: unknown
    readonly enforce?: (caps: ReqCaps, signal?: AbortSignal) => { ok: true } | { ok: false; error: EAdd }
  } = {},
): Capability<EAdd, ReqCaps> => ({
  kind,
  value: spec.value ?? {},
  ...(spec.enforce ? { enforce: spec.enforce } : {}),
})

/**
 * Apply a capability to a node. Widens the node's error union by the
 * capability's declared `EAdd` and records its required handles `ReqCaps`.
 */
export const withCapability = <Child extends AnyNode, EAdd, ReqCaps extends Record<string, unknown>>(
  cap: Capability<EAdd, ReqCaps>,
  child: Child,
): AnnotatedNode<Child, EAdd, ReqCaps> =>
  chainable({
    tag: 'annotated',
    annotation: { kind: cap.kind, value: cap },
    child,
  } as import('./node.ts').Annotated<Child, EAdd, ReqCaps>) as AnnotatedNode<Child, EAdd, ReqCaps>

/**
 * DERIVED — identity. A leaf that returns its input unchanged. It is the unit of
 * the `.then` chain: `a.then(identity())` ≡ `a` ≡ `identity().then(a)`.
 */
export const identity = <T = unknown>(): LeafNode<T, T, never, Record<string, unknown>> =>
  leaf<T, T, never>((input) => ok(input))
