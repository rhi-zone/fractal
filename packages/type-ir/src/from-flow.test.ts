import { describe, expect, test } from "bun:test"
import { fromFlow } from "./from-flow.ts"
import { t, types } from "./index.ts"

describe("basic object types", () => {
  test("fields become object properties", () => {
    const doc = fromFlow(`
      type User = {
        id: string,
        age: number,
      }
    `)
    expect(doc.defs.User).toEqual(
      t(types.object({ id: t(types.string), age: t(types.number) }), { exact: false }),
    )
  })

  test("exact object form ({| ... |}) carries no meta.exact (default = exact)", () => {
    const doc = fromFlow(`type Exact = {| a: string |}`)
    expect(doc.defs.Exact).toEqual(t(types.object({ a: t(types.string) })))
  })

  test("root points at the first declaration", () => {
    const doc = fromFlow(`
      type First = { a: string }
      type Second = { b: number }
    `)
    expect(doc.root).toEqual(t(types.ref("First")))
    expect(Object.keys(doc.defs)).toEqual(["First", "Second"])
  })

  test("no declarations -> unknown root, empty defs", () => {
    const doc = fromFlow(`const x = 1`)
    expect(doc.root).toEqual(t(types.unknown))
    expect(doc.defs).toEqual({})
  })
})

describe("optional fields", () => {
  test("optional property carries meta.optional", () => {
    const doc = fromFlow(`type T = { a: string, b?: number }`)
    const fields = (doc.defs.T?.shape as { fields: Record<string, unknown> }).fields
    expect(fields.a).toEqual(t(types.string))
    expect(fields.b).toEqual(t(types.number, { optional: true }))
  })

  test("covariant (+) property carries meta.readonly", () => {
    const doc = fromFlow(`type T = { +a: string }`)
    const fields = (doc.defs.T?.shape as { fields: Record<string, unknown> }).fields
    expect(fields.a).toEqual(t(types.string, { readonly: true }))
  })
})

describe("unions", () => {
  test("string literal union -> enum", () => {
    const doc = fromFlow(`type Status = "active" | "inactive"`)
    expect(doc.defs.Status).toEqual(t(types.enum(["active", "inactive"])))
  })

  test("mixed-type union -> types.union", () => {
    const doc = fromFlow(`type T = string | number`)
    expect(doc.defs.T).toEqual(t(types.union([t(types.string), t(types.number)])))
  })

  test("object union with shared literal field -> discriminator", () => {
    const doc = fromFlow(`
      type Shape =
        | { kind: "circle", radius: number }
        | { kind: "square", side: number }
    `)
    const shape = doc.defs.Shape!
    expect(shape.meta.discriminator).toBe("kind")
    expect(shape.shape.kind).toBe("union")
  })

  test("nullable (?T) carries meta.nullable", () => {
    const doc = fromFlow(`type T = ?number`)
    expect(doc.defs.T).toEqual(t(types.number, { nullable: true }))
  })
})

describe("arrays and tuples", () => {
  test("T[] -> array", () => {
    const doc = fromFlow(`type T = string[]`)
    expect(doc.defs.T).toEqual(t(types.array(t(types.string))))
  })

  test("Array<T> -> array", () => {
    const doc = fromFlow(`type T = Array<string>`)
    expect(doc.defs.T).toEqual(t(types.array(t(types.string))))
  })

  test("tuple -> types.tuple", () => {
    const doc = fromFlow(`type T = [string, number]`)
    expect(doc.defs.T).toEqual(t(types.tuple([t(types.string), t(types.number)])))
  })
})

describe("generics", () => {
  test("unconstrained type parameter -> unknown with comment", () => {
    const doc = fromFlow(`type Box<T> = { value: T }`)
    const fields = (doc.defs.Box?.shape as { fields: Record<string, unknown> }).fields
    expect((fields.value as { shape: { kind: string } }).shape.kind).toBe("unknown")
  })

  test("bounded type parameter extracts constraint, tagged generic", () => {
    const doc = fromFlow(`type Box<T: string> = { value: T }`)
    const fields = (doc.defs.Box?.shape as { fields: Record<string, unknown> }).fields
    expect(fields.value).toEqual(t(types.string, { generic: true }))
  })

  test("Map<K, V> -> types.map", () => {
    const doc = fromFlow(`type T = Map<string, number>`)
    expect(doc.defs.T).toEqual(t(types.map(t(types.string), t(types.number))))
  })

  test("Promise<T> unwraps to T", () => {
    const doc = fromFlow(`type T = Promise<string>`)
    expect(doc.defs.T).toEqual(t(types.string))
  })

  test("reference to a locally declared generic alias drops type args (documented gap)", () => {
    const doc = fromFlow(`
      type ListOf<T> = Array<T>
      type Names = ListOf<string>
    `)
    expect(doc.defs.Names).toEqual(t(types.ref("ListOf")))
  })
})

describe("interfaces", () => {
  test("interface fields become object properties", () => {
    const doc = fromFlow(`
      interface Named {
        name: string,
      }
    `)
    expect(doc.defs.Named).toEqual(t(types.object({ name: t(types.string) }), { exact: false }))
  })

  test("interface method becomes types.function", () => {
    const doc = fromFlow(`
      interface Greeter {
        greet(x: string): void,
      }
    `)
    const fields = (doc.defs.Greeter?.shape as { fields: Record<string, unknown> }).fields
    expect(fields.greet).toEqual(t(types.function([{ name: "x", type: t(types.string) }], t(types.void))))
  })

  test("interface extends -> intersection of base ref + own body", () => {
    const doc = fromFlow(`
      interface Base { x: string }
      interface Sub extends Base { y: number }
    `)
    expect(doc.defs.Sub).toEqual(
      t(types.intersection([t(types.ref("Base")), t(types.object({ y: t(types.number) }), { exact: false })])),
    )
  })
})

describe("type aliases", () => {
  test("primitive alias", () => {
    const doc = fromFlow(`type Name = string`)
    expect(doc.defs.Name).toEqual(t(types.string))
  })

  test("literal alias", () => {
    const doc = fromFlow(`type Five = 5`)
    expect(doc.defs.Five).toEqual(t(types.literal(5)))
  })

  test("export type is still picked up", () => {
    const doc = fromFlow(`export type Name = string`)
    expect(doc.defs.Name).toEqual(t(types.string))
  })

  test("declare type is still picked up", () => {
    const doc = fromFlow(`declare type Name = string`)
    expect(doc.defs.Name).toEqual(t(types.string))
  })
})

describe("nested types", () => {
  test("nested object field", () => {
    const doc = fromFlow(`
      type Address = { street: string, city: string }
      type Person = { name: string, address: Address }
    `)
    const fields = (doc.defs.Person?.shape as { fields: Record<string, unknown> }).fields
    expect(fields.address).toEqual(t(types.ref("Address")))
  })

  test("indexer alongside own fields -> meta.additionalPropertyType", () => {
    const doc = fromFlow(`type T = { a: string, [key: string]: number }`)
    const ref = doc.defs.T!
    expect(ref.meta.additionalPropertyType).toEqual(t(types.number))
  })

  test("pure indexer (no own fields) -> types.map", () => {
    const doc = fromFlow(`type Dict = { [key: string]: number }`)
    expect(doc.defs.Dict).toEqual(t(types.map(t(types.string), t(types.number))))
  })

  test("intersection -> types.intersection", () => {
    const doc = fromFlow(`type T = { a: string } & { b: number }`)
    expect(doc.defs.T).toEqual(
      t(types.intersection([t(types.object({ a: t(types.string) }), { exact: false }), t(types.object({ b: t(types.number) }), { exact: false })])),
    )
  })

  test("opaque type carries meta.opaque", () => {
    const doc = fromFlow(`opaque type Id = string`)
    expect(doc.defs.Id).toEqual(t(types.string, { opaque: true }))
  })
})
