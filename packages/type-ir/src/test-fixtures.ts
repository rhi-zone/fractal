// packages/type-ir/src/test-fixtures.ts — shared realistic schemas used by
// both cross-projector.test.ts (string-level smoke tests over every
// projector) and compile-check.test.ts (real-compiler checks over the
// projectors that emit a genuinely compilable target language). Factored out
// so the two suites exercise the exact same shapes rather than drifting.
import { t, types, type TypeRef } from "./index.ts"
import { bytes, datetime, email, int32 } from "./kinds/common.ts"

export function obj(fields: Record<string, TypeRef>): TypeRef {
  return t(types.object(fields))
}

export function opt(ref: TypeRef): TypeRef {
  return { shape: ref.shape, meta: { ...ref.meta, optional: true } }
}

// (a) E-commerce Order — realistic nested API schema.
const address = obj({
  street: t(types.string),
  city: t(types.string),
  state: t(types.string),
  zip: t(types.string),
  country: t(types.string),
})

const orderItem = obj({
  productId: t(types.string),
  quantity: t(types.integer),
  price: t(types.number),
  variant: opt(t(types.enum(["small", "medium", "large"]))),
})

const customer = obj({
  name: t(types.string),
  email: email(),
  address,
})

export const ecommerceOrder = obj({
  id: t(types.integer),
  status: t(types.enum(["pending", "shipped", "delivered", "cancelled"])),
  items: t(types.array(orderItem)),
  customer,
  total: t(types.number),
  createdAt: datetime(),
  notes: opt(t(types.string)),
})

// (b) Recursive Tree — self-referential via `ref`. Each projector renders a
// standalone TypeRef, so the inner `ref` just needs to render as the type's
// own name (verified against typescript-zod.ts / json-schema.ts / etc. — none
// of them require a resolvable registry for a bare `toX(ref)` call). NOTE:
// because the self-reference is the literal string "TreeNode", any caller
// that needs the emitted code to actually resolve (compile-check.test.ts,
// unlike cross-projector.test.ts's pure string-shape check) MUST render this
// fixture with the root name "TreeNode" — passing any other name leaves the
// self-reference dangling.
export const treeNode = obj({
  value: t(types.string),
  children: t(types.array(t(types.ref("TreeNode")))),
})

// (c) Discriminated Union API Response — polymorphism via a union of tagged
// objects. Root kind is `union`, not `object` — most struct-shaped projectors
// (capnp/flatbuffers/sql) require an `object` root and are expected to throw
// on this fixture; see the `.todo` block in cross-projector.test.ts. protobuf
// is the exception: toProtoMessage synthesizes a `oneof` wrapper message for
// a union root (see toProtoUnionMessage in protobuf.ts), so it's a real test
// in the matrix below instead of a `.todo`.
const successResponse = obj({
  type: t(types.literal("success")),
  data: obj({ result: t(types.string) }),
})
const errorResponse = obj({
  type: t(types.literal("error")),
  code: t(types.integer),
  message: t(types.string),
})
const paginatedResponse = obj({
  type: t(types.literal("paginated")),
  items: t(types.array(t(types.string))),
  cursor: t(types.string),
  hasMore: t(types.boolean),
})
export const apiResponse = t(types.union([successResponse, errorResponse, paginatedResponse]))

// (d) Kitchen Sink — as many kind/constraint combinations as reasonably fit
// in one object.
const kitchenSinkLevel3 = obj({
  deepValue: t(types.string, { minLength: 1, maxLength: 50 }),
})
const kitchenSinkLevel2 = obj({
  level3: kitchenSinkLevel3,
  tags: t(types.array(t(types.string))),
})
export const kitchenSink = obj({
  aBoolean: t(types.boolean),
  aNumber: t(types.number, { minimum: 0, maximum: 100 }),
  anInteger: t(types.integer, { minimum: 0 }),
  aString: t(types.string, { pattern: "^[a-z]+$" }),
  aNull: t(types.null),
  anUnknown: t(types.unknown),
  optionalField: opt(t(types.string)),
  nullableField: { shape: types.string, meta: { nullable: true } },
  anEnum: t(types.enum(["red", "green", "blue"]), { description: "primary colors" }),
  nested: kitchenSinkLevel2,
  arrayOfArrays: t(types.array(t(types.array(t(types.integer))))),
  aMap: t(types.map(t(types.string), t(types.number))),
  aTuple: t(types.tuple([t(types.string), t(types.integer), t(types.boolean)])),
  aUnion: t(types.union([t(types.string), t(types.integer)])),
  aLiteral: t(types.literal("fixed-value")),
  int32Field: int32(),
  bytesField: bytes(),
  datetimeField: datetime(),
})

export const fixtures: { name: string; ref: TypeRef }[] = [
  { name: "E-commerce Order", ref: ecommerceOrder },
  { name: "Recursive Tree", ref: treeNode },
  { name: "Discriminated Union API Response", ref: apiResponse },
  { name: "Kitchen Sink", ref: kitchenSink },
]
