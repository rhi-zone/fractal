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

// ── Gap-fix fixtures ─────────────────────────────────────────────────────────

/** Tuple type — must not fall through to the object branch. */
export type TupleType = [string, number, boolean]

/** `Record<K,V>` — pure index signature, no own properties. */
export type RecordType = Record<string, number>

/** Explicit index-signature syntax, same shape concern as Record. */
export type IndexSigType = { [key: string]: boolean }

/** Union of string literals — each member must stay a literal, not widen. */
export type LiteralType = "active" | "inactive"

/** A single string literal (no union) — must not widen to plain string. */
export type SingleLiteral = "active"

/** A single numeric literal. */
export type NumericLiteral = 42

/** A single boolean literal. */
export type BooleanLiteral = true

/** Recursive via an array of self — the common object-tree shape. */
export type RecursiveType = { name: string; children: RecursiveType[] }

/** Directly self-referential (no array indirection). */
export type DirectRecursive = { self: DirectRecursive }

/** A field whose type is a Promise — must unwrap like the return-type path. */
export type PromiseField = { data: Promise<string> }

/** A class with mixed visibility + a method, for private-field/method filtering. */
export class SampleClass {
  public name: string = ""
  private secret: string = ""
  protected internal: number = 0
  greet(): string {
    return this.name
  }
}

/** Class instance type, used as a field to exercise the object branch on it. */
export type ClassInstanceField = { owner: SampleClass }

// ── Branded/opaque type fixtures ────────────────────────────────────────────

/** Branded string — the standard nominal-typing pattern over a primitive. */
export type LocationId = string & { readonly __brand: "LocationId" }

/** A second branded string, to confirm brand values aren't confused. */
export type UserId = string & { readonly __brand: "UserId" }

/** Branded number, using the `__tag` spelling instead of `__brand`. */
export type PositiveInt = number & { readonly __tag: "PositiveInt" }

/** A branded type nested as an object field. */
export type BrandedField = { locationId: LocationId; name: string }

/** A genuine structural intersection (not a brand pattern) — must still punt. */
export type PlainIntersection = { a: string } & { b: number }

// ── Enum / literal-union fixtures ───────────────────────────────────────────

/** A string enum — the checker resolves parameter types of this to a union
 * of its member string literals. */
export enum Status {
  Active = "active",
  Inactive = "inactive",
}

/** A numeric enum — resolves to a union of its member number literals. */
export enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}

/** A hand-written string literal union — same shape concern as a string enum. */
export type StringUnion = "a" | "b" | "c"

/** A union of non-literal primitive types — must still punt. */
export type MixedUnion = string | number

/** A union mixing literal types of different kinds — union of literals. */
export type LiteralMixedUnion = "a" | 1 | true

/** A boolean parameter — TS represents `boolean` as `true | false` internally;
 * must NOT be extracted as `enum(["true", "false"])`. */
export type BooleanParam = boolean

// Standalone functions, one per fixture type above, so tests can drive them
// through `typeRefFromFunctionNode` (the checker resolves the parameter type
// as it would for a real op).
export const statusFn = (status: Status): void => {}
export const priorityFn = (priority: Priority): void => {}
export const stringUnionFn = (u: StringUnion): void => {}
export const mixedUnionFn = (u: MixedUnion): void => {}
export const literalMixedUnionFn = (u: LiteralMixedUnion): void => {}
export const booleanParamFn = (b: BooleanParam): void => {}
