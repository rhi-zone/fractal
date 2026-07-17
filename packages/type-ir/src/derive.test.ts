import { describe, expect, test } from "bun:test"
import { deepPartial, deepRequired, extend, nullable, omit, partial, pick, required, withMeta } from "./derive.ts"
import { t, types } from "./index.ts"
import { uuid } from "./kinds/common.ts"

const user = t(
  types.object({
    id: uuid(),
    name: t(types.string),
    email: t(types.string, { description: "primary email" }),
    age: t(types.integer, { optional: true }),
  }),
)

describe("partial", () => {
  test("marks all fields optional", () => {
    const ref = partial(user)
    expect(ref.shape.kind).toBe("object")
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    for (const field of Object.values(ref.shape.fields)) {
      expect(field.meta.optional).toBe(true)
    }
  })

  test("preserves existing field metadata", () => {
    const ref = partial(user)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.email!.meta).toEqual({ description: "primary email", optional: true })
  })

  test("preserves top-level meta", () => {
    const annotated = t(user.shape, { description: "a user" })
    const ref = partial(annotated)
    expect(ref.meta).toEqual({ description: "a user" })
  })

  test("does not mutate the original ref", () => {
    partial(user)
    if (user.shape.kind !== "object") throw new Error("unreachable")
    expect(user.shape.fields.name!.meta.optional).toBeUndefined()
  })

  test("non-object refs pass through unchanged", () => {
    const ref = t(types.string, { nullable: true })
    expect(partial(ref)).toEqual(ref)
  })

  test("empty object passes through", () => {
    const ref = t(types.object({}))
    expect(partial(ref)).toEqual(ref)
  })
})

describe("required", () => {
  test("removes optional from all fields", () => {
    const ref = required(user)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    for (const field of Object.values(ref.shape.fields)) {
      expect(field.meta.optional).toBeUndefined()
    }
  })

  test("preserves other field metadata", () => {
    const ref = required(user)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.email!.meta).toEqual({ description: "primary email" })
  })

  test("non-object refs pass through unchanged", () => {
    const ref = t(types.string)
    expect(required(ref)).toEqual(ref)
  })

  test("is the inverse of partial for optional flag", () => {
    const ref = required(partial(user))
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.age!.meta.optional).toBeUndefined()
  })
})

describe("pick", () => {
  test("keeps only named fields", () => {
    const ref = pick(user, ["name", "email"])
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(Object.keys(ref.shape.fields)).toEqual(["name", "email"])
  })

  test("silently skips missing keys", () => {
    const ref = pick(user, ["name", "nonexistent"])
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(Object.keys(ref.shape.fields)).toEqual(["name"])
  })

  test("preserves field metadata", () => {
    const ref = pick(user, ["email"])
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.email!.meta).toEqual({ description: "primary email" })
  })

  test("empty keys yields empty object", () => {
    const ref = pick(user, [])
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields).toEqual({})
  })

  test("non-object refs pass through unchanged", () => {
    const ref = t(types.string)
    expect(pick(ref, ["whatever"])).toEqual(ref)
  })
})

describe("omit", () => {
  test("drops named fields", () => {
    const ref = omit(user, ["age", "id"])
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(Object.keys(ref.shape.fields)).toEqual(["name", "email"])
  })

  test("silently skips missing keys", () => {
    const ref = omit(user, ["nonexistent"])
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(Object.keys(ref.shape.fields)).toEqual(["id", "name", "email", "age"])
  })

  test("non-object refs pass through unchanged", () => {
    const ref = t(types.string)
    expect(omit(ref, ["whatever"])).toEqual(ref)
  })
})

describe("extend", () => {
  const base = t(types.object({ name: t(types.string), age: t(types.integer) }))
  const extension = t(types.object({ age: t(types.number), email: t(types.string) }))

  test("merges fields from both", () => {
    const ref = extend(base, extension)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(Object.keys(ref.shape.fields).sort()).toEqual(["age", "email", "name"])
  })

  test("extension overrides base on overlapping keys", () => {
    const ref = extend(base, extension)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.age!.shape.kind).toBe("number")
  })

  test("merges top-level meta, extension wins", () => {
    const baseM = t(base.shape, { description: "base" })
    const extM = t(extension.shape, { description: "extension" })
    const ref = extend(baseM, extM)
    expect(ref.meta).toEqual({ description: "extension" })
  })

  test("returns extension unchanged if base is not an object", () => {
    const notObject = t(types.string)
    expect(extend(notObject, extension)).toBe(extension)
  })

  test("returns extension unchanged if extension is not an object", () => {
    const notObject = t(types.string)
    expect(extend(base, notObject)).toBe(notObject)
  })
})

describe("nullable", () => {
  test("sets meta.nullable = true", () => {
    const ref = nullable(t(types.string))
    expect(ref.meta).toEqual({ nullable: true })
  })

  test("preserves existing metadata", () => {
    const ref = nullable(t(types.string, { description: "a name" }))
    expect(ref.meta).toEqual({ description: "a name", nullable: true })
  })
})

describe("withMeta", () => {
  test("merges metadata into the ref", () => {
    const ref = withMeta(t(types.integer), { minimum: 0, maximum: 100 })
    expect(ref.meta).toEqual({ minimum: 0, maximum: 100 })
  })

  test("new keys override existing ones", () => {
    const ref = withMeta(t(types.string, { description: "old" }), { description: "new" })
    expect(ref.meta).toEqual({ description: "new" })
  })
})

describe("composition", () => {
  test("partial(pick(...)) narrows fields and makes them optional", () => {
    const ref = partial(pick(user, ["name", "email"]))
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(Object.keys(ref.shape.fields)).toEqual(["name", "email"])
    expect(ref.shape.fields.name!.meta.optional).toBe(true)
    expect(ref.shape.fields.email!.meta).toEqual({ description: "primary email", optional: true })
  })

  test("extend(a, partial(b)) merges required base with optional patch", () => {
    const base = t(types.object({ name: t(types.string), age: t(types.integer) }))
    const patch = t(types.object({ age: t(types.integer), nickname: t(types.string) }))
    const ref = extend(base, partial(patch))
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.name!.meta.optional).toBeUndefined()
    expect(ref.shape.fields.age!.meta.optional).toBe(true)
    expect(ref.shape.fields.nickname!.meta.optional).toBe(true)
  })

  test("omit then nullable composes cleanly", () => {
    const ref = nullable(omit(user, ["id"]))
    expect(ref.meta.nullable).toBe(true)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(Object.keys(ref.shape.fields)).toEqual(["name", "email", "age"])
  })

  test("update = partial(create) pattern", () => {
    const create = t(
      types.object({
        title: t(types.string),
        body: t(types.string),
      }),
    )
    const update = partial(create)
    if (update.shape.kind !== "object") throw new Error("unreachable")
    expect(update.shape.fields.title!.meta.optional).toBe(true)
    expect(update.shape.fields.body!.meta.optional).toBe(true)
    // original untouched
    if (create.shape.kind !== "object") throw new Error("unreachable")
    expect(create.shape.fields.title!.meta.optional).toBeUndefined()
  })
})

describe("deepPartial", () => {
  test("flat object: same behavior as partial", () => {
    const ref = deepPartial(user)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    for (const field of Object.values(ref.shape.fields)) {
      expect(field.meta.optional).toBe(true)
    }
  })

  test("nested object: all levels become optional", () => {
    const nested = t(
      types.object({
        user: t(
          types.object({
            name: t(types.string),
            address: t(types.object({ city: t(types.string) })),
          }),
        ),
      }),
    )
    const ref = deepPartial(nested)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.user!.meta.optional).toBe(true)
    const userShape = ref.shape.fields.user!.shape
    if (userShape.kind !== "object") throw new Error("unreachable")
    expect(userShape.fields.name!.meta.optional).toBe(true)
    expect(userShape.fields.address!.meta.optional).toBe(true)
    const addressShape = userShape.fields.address!.shape
    if (addressShape.kind !== "object") throw new Error("unreachable")
    expect(addressShape.fields.city!.meta.optional).toBe(true)
  })

  test("array of objects: element fields become optional", () => {
    const ref = deepPartial(
      t(
        types.object({
          items: t(types.array(t(types.object({ id: uuid(), label: t(types.string) })))),
        }),
      ),
    )
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.items!.meta.optional).toBe(true)
    const arrayShape = ref.shape.fields.items!.shape
    if (arrayShape.kind !== "array") throw new Error("unreachable")
    const elementShape = arrayShape.element.shape
    if (elementShape.kind !== "object") throw new Error("unreachable")
    expect(elementShape.fields.id!.meta.optional).toBe(true)
    expect(elementShape.fields.label!.meta.optional).toBe(true)
  })

  test("mixed nesting: objects inside arrays inside objects", () => {
    const ref = deepPartial(
      t(
        types.object({
          groups: t(
            types.array(
              t(
                types.object({
                  name: t(types.string),
                  members: t(types.array(t(types.object({ id: uuid() })))),
                }),
              ),
            ),
          ),
        }),
      ),
    )
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    const groupsArray = ref.shape.fields.groups!.shape
    if (groupsArray.kind !== "array") throw new Error("unreachable")
    const groupShape = groupsArray.element.shape
    if (groupShape.kind !== "object") throw new Error("unreachable")
    expect(groupShape.fields.name!.meta.optional).toBe(true)
    expect(groupShape.fields.members!.meta.optional).toBe(true)
    const membersArray = groupShape.fields.members!.shape
    if (membersArray.kind !== "array") throw new Error("unreachable")
    const memberShape = membersArray.element.shape
    if (memberShape.kind !== "object") throw new Error("unreachable")
    expect(memberShape.fields.id!.meta.optional).toBe(true)
  })

  test("non-object refs pass through unchanged", () => {
    const ref = t(types.string, { nullable: true })
    expect(deepPartial(ref)).toEqual(ref)
  })

  test("composes with pick", () => {
    const nested = t(
      types.object({
        user: t(types.object({ name: t(types.string) })),
        other: t(types.string),
      }),
    )
    const ref = deepPartial(pick(nested, ["user"]))
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(Object.keys(ref.shape.fields)).toEqual(["user"])
    const userShape = ref.shape.fields.user!.shape
    if (userShape.kind !== "object") throw new Error("unreachable")
    expect(userShape.fields.name!.meta.optional).toBe(true)
  })
})

describe("deepRequired", () => {
  test("flat object: same behavior as required", () => {
    const ref = deepRequired(deepPartial(user))
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    for (const field of Object.values(ref.shape.fields)) {
      expect(field.meta.optional).toBeUndefined()
    }
  })

  test("nested object: all levels lose optional", () => {
    const nested = t(
      types.object({
        user: t(
          types.object({
            name: t(types.string),
            address: t(types.object({ city: t(types.string) })),
          }),
        ),
      }),
    )
    const ref = deepRequired(deepPartial(nested))
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.user!.meta.optional).toBeUndefined()
    const userShape = ref.shape.fields.user!.shape
    if (userShape.kind !== "object") throw new Error("unreachable")
    expect(userShape.fields.name!.meta.optional).toBeUndefined()
    expect(userShape.fields.address!.meta.optional).toBeUndefined()
    const addressShape = userShape.fields.address!.shape
    if (addressShape.kind !== "object") throw new Error("unreachable")
    expect(addressShape.fields.city!.meta.optional).toBeUndefined()
  })

  test("array of objects: element fields lose optional", () => {
    const original = t(
      types.object({
        items: t(types.array(t(types.object({ id: uuid(), label: t(types.string) })))),
      }),
    )
    const ref = deepRequired(deepPartial(original))
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.items!.meta.optional).toBeUndefined()
    const arrayShape = ref.shape.fields.items!.shape
    if (arrayShape.kind !== "array") throw new Error("unreachable")
    const elementShape = arrayShape.element.shape
    if (elementShape.kind !== "object") throw new Error("unreachable")
    expect(elementShape.fields.id!.meta.optional).toBeUndefined()
    expect(elementShape.fields.label!.meta.optional).toBeUndefined()
  })

  test("mixed nesting: objects inside arrays inside objects", () => {
    const original = t(
      types.object({
        groups: t(
          types.array(
            t(
              types.object({
                name: t(types.string),
                members: t(types.array(t(types.object({ id: uuid() })))),
              }),
            ),
          ),
        ),
      }),
    )
    const ref = deepRequired(deepPartial(original))
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    const groupsArray = ref.shape.fields.groups!.shape
    if (groupsArray.kind !== "array") throw new Error("unreachable")
    const groupShape = groupsArray.element.shape
    if (groupShape.kind !== "object") throw new Error("unreachable")
    expect(groupShape.fields.name!.meta.optional).toBeUndefined()
    expect(groupShape.fields.members!.meta.optional).toBeUndefined()
    const membersArray = groupShape.fields.members!.shape
    if (membersArray.kind !== "array") throw new Error("unreachable")
    const memberShape = membersArray.element.shape
    if (memberShape.kind !== "object") throw new Error("unreachable")
    expect(memberShape.fields.id!.meta.optional).toBeUndefined()
  })

  test("non-object refs pass through unchanged", () => {
    const ref = t(types.string)
    expect(deepRequired(ref)).toEqual(ref)
  })
})

describe("deepPartial / deepRequired do not affect shallow partial / required", () => {
  test("partial does not recurse into nested objects", () => {
    const nested = t(
      types.object({
        user: t(types.object({ name: t(types.string) })),
      }),
    )
    const ref = partial(nested)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.user!.meta.optional).toBe(true)
    const userShape = ref.shape.fields.user!.shape
    if (userShape.kind !== "object") throw new Error("unreachable")
    expect(userShape.fields.name!.meta.optional).toBeUndefined()
  })

  test("required does not recurse into nested objects", () => {
    const nested = t(
      types.object({
        user: t(types.object({ name: t(types.string, { optional: true }) }), { optional: true }),
      }),
    )
    const ref = required(nested)
    if (ref.shape.kind !== "object") throw new Error("unreachable")
    expect(ref.shape.fields.user!.meta.optional).toBeUndefined()
    const userShape = ref.shape.fields.user!.shape
    if (userShape.kind !== "object") throw new Error("unreachable")
    expect(userShape.fields.name!.meta.optional).toBe(true)
  })
})
