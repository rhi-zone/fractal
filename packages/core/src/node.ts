import type { Handler } from './result.ts'

/**
 * Open, string-keyed annotation. Capabilities attach these; interpreters read
 * `kind` to decide which handle to grant. The value is opaque structure.
 */
export interface Annotation<K extends string = string, V = unknown> {
  readonly kind: K
  readonly value: V
}

/**
 * Phantom type carrier. Every node variant extends NodeMeta so the I/O/E
 * extractors below can read a node's typed signature without a central map.
 * The fields never exist at runtime; `__i` is contravariant (a fn arg) so
 * input types compose correctly under inference.
 */
export interface NodeMeta<I, O, E> {
  readonly __i?: I
  readonly __o?: O
  readonly __e?: E
}

/** Leaf — the only variant carrying a closure. `run` is the code. */
export interface Leaf<I, O, E, Caps extends Record<string, unknown>>
  extends NodeMeta<I, O, E> {
  readonly tag: 'leaf'
  readonly run: Handler<I, O, E, Caps>
  readonly __caps?: Caps
}

/** Branch — pure structure. Dispatch is key indexing, performed by the interpreter. */
export interface Branch<C extends Record<string, AnyNode>>
  extends NodeMeta<never, unknown, never> {
  readonly tag: 'branch'
  readonly children: C
}

/**
 * Annotated — a type-PRESERVING cross-cutting effect wrapping a child.
 * The capability's own declared error `EAdd` is unioned into ErrorOf. There is
 * no central kind→error map: the widening comes from the wrapper's own param.
 */
export interface Annotated<Child extends AnyNode, EAdd, ReqCaps extends Record<string, unknown>>
  extends NodeMeta<InputOf<Child>, OutputOf<Child>, ErrorOf<Child> | EAdd> {
  readonly tag: 'annotated'
  readonly annotation: Annotation
  readonly child: Child
  readonly __req?: ReqCaps
}

/**
 * Seq — a type-CHANGING composition. left.output must equal right.input
 * (enforced at the .then/.pipe call site). Input is left's, output is right's,
 * error is the union of both.
 */
export interface Seq<L extends AnyNode, R extends AnyNode>
  extends NodeMeta<InputOf<L>, OutputOf<R>, ErrorOf<L> | ErrorOf<R>> {
  readonly tag: 'seq'
  readonly left: L
  readonly right: R
}

/** The reflectable node union. Only `leaf` holds code. */
export type AnyNode =
  | Leaf<any, any, any, any>
  | Branch<any>
  | Annotated<any, any, any>
  | Seq<any, any>

/** Extract a node's input type. */
export type InputOf<N> = N extends NodeMeta<infer I, any, any> ? I : never
/** Extract a node's output type. */
export type OutputOf<N> = N extends NodeMeta<any, infer O, any> ? O : never
/** Extract a node's error union. */
export type ErrorOf<N> = N extends NodeMeta<any, any, infer E> ? E : never

/** Extract the capabilities a node tree requires (union of leaf Caps and capability ReqCaps). */
export type CapsOf<N> =
  N extends Leaf<any, any, any, infer Caps> ? Caps
  : N extends Annotated<infer Child, any, infer Req> ? CapsOf<Child> & Req
  : N extends Seq<infer L, infer R> ? CapsOf<L> & CapsOf<R>
  : N extends Branch<infer C> ? { [K in keyof C]: CapsOf<C[K]> }[keyof C]
  : Record<string, unknown>
