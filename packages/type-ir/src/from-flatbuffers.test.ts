import { describe, expect, test } from "bun:test"
import { t, types, type TypeRef } from "./index.ts"
import { fromFlatbuffers } from "./from-flatbuffers.ts"
import { toFlatBuffersDeclarations, toFlatBuffersTable } from "./flatbuffers.ts"

describe("basic table with multiple field types", () => {
  test("bool, int widths, float widths, string all convert", () => {
    const result = fromFlatbuffers(`
      table Widget {
        active:bool;
        a:byte;
        b:ubyte;
        c:short;
        d:ushort;
        e:int;
        f:uint;
        g:long;
        h:ulong;
        i:float;
        j:double;
        name:string;
      }
    `)
    const widget = result.Widget!
    expect(widget.shape.kind).toBe("object")
    const fields = (widget.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.active!.shape.kind).toBe("boolean")
    expect(fields.a!.shape.kind).toBe("int8")
    expect(fields.b!.shape.kind).toBe("uint8")
    expect(fields.c!.shape.kind).toBe("int16")
    expect(fields.d!.shape.kind).toBe("uint16")
    expect(fields.e!.shape.kind).toBe("int32")
    expect(fields.f!.shape.kind).toBe("uint32")
    expect(fields.g!.shape.kind).toBe("int64")
    expect(fields.h!.shape.kind).toBe("uint64")
    expect(fields.i!.shape.kind).toBe("float32")
    expect(fields.j!.shape.kind).toBe("float64")
    expect(fields.name!.shape.kind).toBe("string")
    // Table fields are optional by default.
    for (const f of Object.values(fields)) expect(f.meta.optional).toBe(true)
  })

  test("width-suffixed spellings (int8/uint8/int16/.../float64) map the same as their aliases", () => {
    const result = fromFlatbuffers(`
      table W {
        a:int8;
        b:uint8;
        c:int16;
        d:uint16;
        e:int32;
        f:uint32;
        g:int64;
        h:uint64;
        i:float32;
        j:float64;
      }
    `)
    const fields = (result.W!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.a!.shape.kind).toBe("int8")
    expect(fields.j!.shape.kind).toBe("float64")
  })
})

describe("table vs struct", () => {
  test("struct fields are never optional, even without (required); meta.struct is set", () => {
    const result = fromFlatbuffers(`
      struct Point {
        x:float;
        y:float;
      }
    `)
    const point = result.Point!
    expect(point.meta.struct).toBe(true)
    const fields = (point.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.x!.meta.optional).toBeUndefined()
    expect(fields.y!.meta.optional).toBeUndefined()
  })

  test("table fields are optional by default; meta.struct is absent", () => {
    const result = fromFlatbuffers(`
      table Rect {
        w:float;
        h:float;
      }
    `)
    const rect = result.Rect!
    expect(rect.meta.struct).toBeUndefined()
    const fields = (rect.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.w!.meta.optional).toBe(true)
  })
})

describe("enums", () => {
  test("sequential values with no explicit numbers", () => {
    const result = fromFlatbuffers(`
      enum Color : byte { Red, Green, Blue }
    `)
    const color = result.Color!
    expect(color.shape.kind).toBe("enum")
    expect((color.shape as unknown as { members: string[] }).members).toEqual(["Red", "Green", "Blue"])
    expect(color.meta.values).toEqual({ Red: 0, Green: 1, Blue: 2 })
    expect(color.meta.fbsBase).toBe("byte")
  })

  test("explicit values including a gap/reset case", () => {
    const result = fromFlatbuffers(`
      enum Status { A, B = 5, C }
    `)
    const status = result.Status!
    expect(status.meta.values).toEqual({ A: 0, B: 5, C: 6 })
    // basetype omitted -> defaults to "int"
    expect(status.meta.fbsBase).toBe("int")
  })
})

describe("union", () => {
  test("union without aliases", () => {
    const result = fromFlatbuffers(`
      table Rect { w:float; }
      table Circle { r:float; }
      union Shape { Rect, Circle }
    `)
    const shape = result.Shape!
    expect(shape.shape.kind).toBe("union")
    const variants = (shape.shape as unknown as { variants: TypeRef[] }).variants
    expect(variants).toHaveLength(2)
    expect(variants[0]).toEqual({ shape: { kind: "ref", target: "Rect" }, meta: {} })
    expect(variants[1]).toEqual({ shape: { kind: "ref", target: "Circle" }, meta: {} })
    expect(shape.meta.aliases).toBeUndefined()
  })

  test("union with aliased members", () => {
    const result = fromFlatbuffers(`
      table Rect { w:float; }
      union Shape { R:Rect }
    `)
    const shape = result.Shape!
    const variants = (shape.shape as unknown as { variants: TypeRef[] }).variants
    expect((variants[0]!.shape as { target: string }).target).toBe("Rect")
    expect(shape.meta.aliases).toEqual({ R: "Rect" })
  })
})

describe("vectors", () => {
  test("vector of a scalar", () => {
    const result = fromFlatbuffers(`
      table Post { tags:[string]; }
    `)
    const fields = (result.Post!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.tags!.shape.kind).toBe("array")
    expect((fields.tags!.shape as { element: TypeRef }).element.shape.kind).toBe("string")
  })

  test("vector of a referenced table type", () => {
    const result = fromFlatbuffers(`
      table Item { name:string; }
      table Inventory { items:[Item]; }
    `)
    const fields = (result.Inventory!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.items!.shape.kind).toBe("array")
    const element = (fields.items!.shape as { element: TypeRef }).element
    expect(element.shape.kind).toBe("ref")
    expect((element.shape as { target: string }).target).toBe("Item")
  })
})

describe("nested/cross-referenced types", () => {
  test("a table field referencing another declared table resolves to a ref at the right key", () => {
    const result = fromFlatbuffers(`
      table Address { city:string; }
      table Person { address:Address; }
    `)
    const fields = (result.Person!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.address!.shape).toEqual({ kind: "ref", target: "Address" })
    expect(result.Address).toBeDefined()
  })
})

describe("namespaces", () => {
  test("declarations are keyed by their qualified dotted name", () => {
    const result = fromFlatbuffers(`
      namespace a.b.c;
      table Foo { n:int; }
    `)
    expect(result["a.b.c.Foo"]).toBeDefined()
    expect(result.Foo).toBeUndefined()
  })

  test("a same-namespace unqualified reference resolves correctly", () => {
    const result = fromFlatbuffers(`
      namespace a.b;
      table Address { city:string; }
      table Person { address:Address; }
    `)
    const fields = (result["a.b.Person"]!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.address!.shape).toEqual({ kind: "ref", target: "a.b.Address" })
  })

  test("namespace applies file-wide until the next namespace statement", () => {
    const result = fromFlatbuffers(`
      namespace a;
      table First { n:int; }
      namespace b;
      table Second { n:int; }
    `)
    expect(result["a.First"]).toBeDefined()
    expect(result["b.Second"]).toBeDefined()
  })
})

describe("default values", () => {
  test("numeric default", () => {
    const result = fromFlatbuffers(`table T { n:int = 42; }`)
    const fields = (result.T!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.n!.meta.default).toBe(42)
  })

  test("boolean default", () => {
    const result = fromFlatbuffers(`table T { flag:bool = true; }`)
    const fields = (result.T!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.flag!.meta.default).toBe(true)
  })

  test("enum-identifier default kept as the string name, not resolved to a number", () => {
    const result = fromFlatbuffers(`
      enum Color : byte { Red, Green, Blue }
      table T { color:Color = Green; }
    `)
    const fields = (result.T!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.color!.meta.default).toBe("Green")
  })
})

describe("attributes", () => {
  test("(deprecated), (id: N), (required), and a custom attribute", () => {
    const result = fromFlatbuffers(`
      table T {
        old:string (deprecated);
        n:int (id: 3);
        must:string (required);
        k:string (key);
        custom:string (nested_flatbuffer: "OtherTable");
      }
    `)
    const fields = (result.T!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.old!.meta.deprecated).toBe(true)
    expect(fields.n!.meta.id).toBe(3)
    expect(fields.must!.meta.optional).toBeUndefined()
    expect(fields.k!.meta.attributes).toEqual({ key: true })
    expect(fields.custom!.meta.attributes).toEqual({ nested_flatbuffer: "OtherTable" })
  })
})

describe("root_type", () => {
  test("sets meta.isRootType on the correct entry", () => {
    const result = fromFlatbuffers(`
      table Foo { n:int; }
      table Bar { n:int; }
      root_type Bar;
    `)
    expect(result.Bar!.meta.isRootType).toBe(true)
    expect(result.Foo!.meta.isRootType).toBeUndefined()
  })

  test("resolves namespace-aware root_type just like a field reference", () => {
    const result = fromFlatbuffers(`
      namespace a.b;
      table Foo { n:int; }
      root_type Foo;
    `)
    expect(result["a.b.Foo"]!.meta.isRootType).toBe(true)
  })
})

describe("out-of-scope constructs are recognized but skipped", () => {
  test("include/attribute/file_identifier/file_extension don't break parsing", () => {
    const result = fromFlatbuffers(`
      include "other.fbs";
      attribute "custom_attr";
      file_identifier "ABCD";
      file_extension "bin";
      table Foo { n:int; }
    `)
    expect(result.Foo).toBeDefined()
  })

  test("rpc_service is skipped, not converted, and doesn't corrupt surrounding parse state", () => {
    const result = fromFlatbuffers(`
      table Ping { value:string; }

      rpc_service Pinger {
        Do(Ping):Ping;
      }

      table Pong { value:string; }
    `)
    expect(result.Ping).toBeDefined()
    expect(result.Pong).toBeDefined()
    expect(result.Pinger).toBeUndefined()
    expect(Object.keys(result).sort()).toEqual(["Ping", "Pong"])
  })
})

describe("round-trip via toFlatBuffersTable/toFlatBuffersDeclarations", () => {
  test("an object TypeRef survives toFlatBuffersTable -> fromFlatbuffers as a table", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        age: withOptional(t(types.string)),
      }),
    )
    const text = toFlatBuffersTable("Person", ref)
    const result = fromFlatbuffers(text)
    expect(result.Person!.shape.kind).toBe("object")
    const fields = (result.Person!.shape as unknown as { fields: Record<string, TypeRef> }).fields
    expect(fields.id!.shape.kind).toBe("string")
    expect(fields.age!.shape.kind).toBe("string")
    // Lossy spot: toFlatBuffersTable emits `(required)` only when the source
    // field is NOT optional/nullable (fieldRequired). Both fields above are
    // plain (non-optional) TypeRefs, so both round-trip as required — i.e.
    // `meta.optional` should be absent on both sides here.
    expect(fields.id!.meta.optional).toBeUndefined()
  })

  test("an enum TypeRef survives toFlatBuffersDeclarations -> fromFlatbuffers", () => {
    const registry = { Color: t(types.enum(["Red", "Green", "Blue"])) }
    const text = toFlatBuffersDeclarations(registry)
    const result = fromFlatbuffers(text)
    expect(result.Color!.shape.kind).toBe("enum")
    expect((result.Color!.shape as unknown as { members: string[] }).members).toEqual(["Red", "Green", "Blue"])
    // Lossy spot: toFlatBuffersDeclarations always renders `base: "int"` for a
    // bare enum TypeRef (it has no width info of its own to draw on), so the
    // round-tripped meta.fbsBase is "int" regardless of the original member
    // values' actual range.
    expect(result.Color!.meta.fbsBase).toBe("int")
  })

  test("a union TypeRef survives toFlatBuffersDeclarations -> fromFlatbuffers", () => {
    const registry = {
      Shape: t(types.union([t(types.ref("Rect")), t(types.ref("Circle"))])),
    }
    const text = toFlatBuffersDeclarations(registry)
    const result = fromFlatbuffers(text)
    expect(result.Shape!.shape.kind).toBe("union")
    const variants = (result.Shape!.shape as unknown as { variants: TypeRef[] }).variants
    expect(variants.map((v) => (v.shape as { target: string }).target)).toEqual(["Rect", "Circle"])
  })
})

function withOptional(ref: TypeRef): TypeRef {
  return { shape: ref.shape, meta: { ...ref.meta, optional: true } }
}
