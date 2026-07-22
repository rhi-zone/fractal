import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { renderClass, renderEnum, toCrystal, toCrystalDeclarations, toCrystalType } from "./crystal-json-serializable.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toCrystalType(t(types.boolean))).toBe("Bool")
  })

  test("string", () => {
    expect(toCrystalType(t(types.string))).toBe("String")
  })

  test("number", () => {
    expect(toCrystalType(t(types.number))).toBe("Float64")
  })

  test("integer", () => {
    expect(toCrystalType(t(types.integer))).toBe("Int32")
  })

  test("null", () => {
    expect(toCrystalType(t(types.null))).toBe("Nil")
  })

  test("unknown", () => {
    expect(toCrystalType(t(types.unknown))).toBe("JSON::Any")
  })

  test("bytes", () => {
    expect(toCrystalType(bytes())).toBe("Bytes")
  })
})

describe("numeric widths", () => {
  test("int32", () => {
    expect(toCrystalType(int32())).toBe("Int32")
  })

  test("int64", () => {
    expect(toCrystalType(int64())).toBe("Int64")
  })

  test("float32", () => {
    expect(toCrystalType(float32())).toBe("Float32")
  })
})

describe("string subtypes", () => {
  test("uuid", () => {
    expect(toCrystalType(uuid())).toBe("String")
  })

  test("uri", () => {
    expect(toCrystalType(uri())).toBe("String")
  })

  test("email", () => {
    expect(toCrystalType(email())).toBe("String")
  })
})

describe("temporal", () => {
  test("datetime", () => {
    expect(toCrystalType(datetime())).toBe("Time")
  })

  test("date", () => {
    expect(toCrystalType(date())).toBe("Time")
  })

  test("time", () => {
    expect(toCrystalType(time())).toBe("String")
  })

  test("duration", () => {
    expect(toCrystalType(duration())).toBe("Time::Span")
  })
})

describe("array", () => {
  test("of string", () => {
    expect(toCrystalType(t(types.array(t(types.string))))).toBe("Array(String)")
  })

  test("of integer", () => {
    expect(toCrystalType(t(types.array(t(types.integer))))).toBe("Array(Int32)")
  })
})

describe("map", () => {
  test("string keyed", () => {
    expect(toCrystalType(t(types.map(t(types.string), t(types.integer))))).toBe("Hash(String, Int32)")
  })
})

describe("tuple", () => {
  test("mixed elements", () => {
    expect(toCrystalType(t(types.tuple([t(types.string), t(types.integer)])))).toBe("Tuple(String, Int32)")
  })
})

describe("union", () => {
  test("two variants", () => {
    expect(toCrystalType(t(types.union([t(types.string), t(types.integer)])))).toBe("String | Int32")
  })

  test("nullable single variant collapses to ?", () => {
    expect(toCrystalType(t(types.union([t(types.string), t(types.null)])))).toBe("String?")
  })

  test("nullable multi-variant spells Nil explicitly", () => {
    const ref = t(types.union([t(types.string), t(types.integer), t(types.null)]))
    expect(toCrystalType(ref)).toBe("String | Int32 | Nil")
  })
})

describe("nilable via meta", () => {
  test("meta.nullable wraps in ?", () => {
    expect(toCrystalType(t(types.string, { nullable: true }))).toBe("String?")
  })
})

describe("instance", () => {
  test("renders class name", () => {
    expect(toCrystalType(t(types.instance("Widget", "./widget.ts")))).toBe("Widget")
  })
})

describe("literal", () => {
  test("string literal degrades to String", () => {
    expect(toCrystalType(t(types.literal("a")))).toBe("String")
  })

  test("integer literal degrades to Int32", () => {
    expect(toCrystalType(t(types.literal(1)))).toBe("Int32")
  })

  test("boolean literal degrades to Bool", () => {
    expect(toCrystalType(t(types.literal(true)))).toBe("Bool")
  })
})

describe("function", () => {
  test("renders Proc(Args, Return)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.integer) }], t(types.string)))
    expect(toCrystalType(ref)).toBe("Proc(Int32, String)")
  })
})

describe("enum", () => {
  test("named enum declaration", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toCrystal(ref, "Status")).toBe("enum Status\n  Active\n  Inactive\nend")
  })

  test("renderEnum matches toCrystal", () => {
    const ref = t(types.enum(["red", "green"]))
    expect(renderEnum("Color", ref)).toBe(toCrystal(ref, "Color"))
  })

  test("without a name, degrades to inline String", () => {
    expect(toCrystalType(t(types.enum(["a", "b"])))).toBe("String")
  })
})

describe("class (object)", () => {
  test("simple class with JSON::Serializable", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toCrystal(ref, "Person")).toBe(
      ["class Person", "  include JSON::Serializable", "", "  property id : String", "  property age : Int32", "end"].join(
        "\n",
      ),
    )
  })

  test("camelCase field gets snake_case property + JSON::Field key", () => {
    const ref = t(types.object({ userId: t(types.string) }))
    expect(toCrystal(ref, "User")).toBe(
      [
        "class User",
        "  include JSON::Serializable",
        "",
        '  @[JSON::Field(key: "userId")]',
        "  property user_id : String",
        "end",
      ].join("\n"),
    )
  })

  test("optional field renders nilable", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toCrystal(ref, "Person")).toBe(
      ["class Person", "  include JSON::Serializable", "", "  property nickname : String?", "end"].join("\n"),
    )
  })

  test("nested object renders sibling class ahead of the referencing class", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const rendered = toCrystal(ref, "Person")
    expect(rendered).toBe(
      [
        "class PersonAddress",
        "  include JSON::Serializable",
        "",
        "  property city : String",
        "end",
        "",
        "class Person",
        "  include JSON::Serializable",
        "",
        "  property address : PersonAddress",
        "end",
      ].join("\n"),
    )
  })

  test("array of nested objects", () => {
    const ref = t(
      types.object({
        tags: t(types.array(t(types.object({ label: t(types.string) })))),
      }),
    )
    const rendered = toCrystal(ref, "Post")
    expect(rendered).toContain("class PostTags")
    expect(rendered).toContain("property tags : Array(PostTags)")
  })

  test("nested enum field renders sibling enum", () => {
    const ref = t(
      types.object({
        status: t(types.enum(["active", "inactive"])),
      }),
    )
    const rendered = toCrystal(ref, "Task")
    expect(rendered).toBe(
      [
        "enum TaskStatus",
        "  Active",
        "  Inactive",
        "end",
        "",
        "class Task",
        "  include JSON::Serializable",
        "",
        "  property status : TaskStatus",
        "end",
      ].join("\n"),
    )
  })

  test("description renders as a doc comment", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A widget." })
    expect(toCrystal(ref, "Widget")).toBe(
      [
        "# A widget.",
        "class Widget",
        "  include JSON::Serializable",
        "",
        "  property id : String",
        "end",
      ].join("\n"),
    )
  })

  test("renderClass matches toCrystal", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(renderClass("Thing", ref)).toBe(toCrystal(ref, "Thing"))
  })
})

describe("toCrystalDeclarations", () => {
  test("renders one declaration per registry entry", () => {
    const registry = {
      Person: t(types.object({ id: t(types.string) })),
      Status: t(types.enum(["active", "inactive"])),
    }
    const rendered = toCrystalDeclarations(registry)
    expect(rendered).toContain("class Person")
    expect(rendered).toContain("enum Status")
  })
})

describe("without a name", () => {
  test("object degrades to JSON::Any", () => {
    expect(toCrystal(t(types.object({ id: t(types.string) })))).toBe("JSON::Any")
  })
})
