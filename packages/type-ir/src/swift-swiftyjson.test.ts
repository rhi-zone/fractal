import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, datetime, int32, int64, uuid } from "./kinds/common.ts"
import { toSwiftyJSON } from "./swift-swiftyjson.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toSwiftyJSON(t(types.boolean), "Flag")).toBe("typealias Flag = Bool")
  })

  test("string", () => {
    expect(toSwiftyJSON(t(types.string), "Name")).toBe("typealias Name = String")
  })

  test("number -> Double", () => {
    expect(toSwiftyJSON(t(types.number), "Amount")).toBe("typealias Amount = Double")
  })

  test("integer -> Int", () => {
    expect(toSwiftyJSON(t(types.integer), "Count")).toBe("typealias Count = Int")
  })

  test("int32/int64 -> Int32/Int64", () => {
    expect(toSwiftyJSON(int32(), "Id32")).toBe("typealias Id32 = Int32")
    expect(toSwiftyJSON(int64(), "Id64")).toBe("typealias Id64 = Int64")
  })

  test("uuid degrades to String (no native SwiftyJSON UUID accessor)", () => {
    expect(toSwiftyJSON(uuid(), "UserId")).toBe("typealias UserId = String")
  })

  test("datetime degrades to String (no native SwiftyJSON Date accessor)", () => {
    expect(toSwiftyJSON(datetime(), "CreatedAt")).toBe("typealias CreatedAt = String")
  })

  test("bytes degrades to String (no native SwiftyJSON Data accessor)", () => {
    expect(toSwiftyJSON(bytes(), "Payload")).toBe("typealias Payload = String")
  })

  test("unknown/null/void/never -> Any", () => {
    expect(toSwiftyJSON(t(types.unknown), "Blob")).toBe("typealias Blob = Any")
    expect(toSwiftyJSON(t(types.null), "Nothing")).toBe("typealias Nothing = Any")
  })
})

describe("optional", () => {
  test("meta.optional appends ?", () => {
    expect(toSwiftyJSON(t(types.string, { optional: true }), "Nickname")).toBe(
      "typealias Nickname = String?",
    )
  })

  test("meta.nullable appends ?", () => {
    expect(toSwiftyJSON(t(types.integer, { nullable: true }), "Age")).toBe("typealias Age = Int?")
  })
})

describe("arrays and dictionaries", () => {
  test("array of primitives", () => {
    expect(toSwiftyJSON(t(types.array(t(types.string))), "Tags")).toBe("typealias Tags = [String]")
  })

  test("map -> [String: Value] (JSON object keys are always strings)", () => {
    expect(toSwiftyJSON(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
      "typealias Counts = [String: Int]",
    )
  })

  test("tuple -> Swift tuple", () => {
    expect(toSwiftyJSON(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toBe(
      "typealias Pair = (String, Int)",
    )
  })
})

describe("structs with hand-written init(json:)", () => {
  test("simple struct reads each field via a typed SwiftyJSON accessor", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    expect(toSwiftyJSON(ref, "Person")).toBe(
      [
        "struct Person {",
        "    var name: String",
        "    var age: Int",
        "",
        "    init(json: JSON) {",
        '        self.name = json["name"].stringValue',
        '        self.age = json["age"].intValue',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("readonly field -> let, mutable field -> var", () => {
    const ref = t(
      types.object({
        id: t(types.string, { readonly: true }),
        name: t(types.string),
      }),
    )
    expect(toSwiftyJSON(ref, "Widget")).toBe(
      [
        "struct Widget {",
        "    let id: String",
        "    var name: String",
        "",
        "    init(json: JSON) {",
        '        self.id = json["id"].stringValue',
        '        self.name = json["name"].stringValue',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("optional field uses the plain (nil-returning) accessor variant", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toSwiftyJSON(ref, "Profile")).toBe(
      [
        "struct Profile {",
        "    var nickname: String?",
        "",
        "    init(json: JSON) {",
        '        self.nickname = json["nickname"].string',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("nested object field hoists a sibling struct, emitted before its parent", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    expect(toSwiftyJSON(ref, "Person")).toBe(
      [
        "struct PersonAddress {",
        "    var city: String",
        "",
        "    init(json: JSON) {",
        '        self.city = json["city"].stringValue',
        "    }",
        "}",
        "",
        "struct Person {",
        "    var address: PersonAddress",
        "",
        "    init(json: JSON) {",
        '        self.address = PersonAddress(json: json["address"])',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("description renders as a /// doc comment above the struct", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A person record." })
    expect(toSwiftyJSON(ref, "Person")).toBe(
      [
        "/// A person record.",
        "struct Person {",
        "    var id: String",
        "",
        "    init(json: JSON) {",
        '        self.id = json["id"].stringValue',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("deprecated true renders a bare @available(*, deprecated) attribute", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: true })
    expect(toSwiftyJSON(ref, "Person")).toBe(
      [
        "@available(*, deprecated)",
        "struct Person {",
        "    var id: String",
        "",
        "    init(json: JSON) {",
        '        self.id = json["id"].stringValue',
        "    }",
        "}",
      ].join("\n"),
    )
  })
})

describe("enums", () => {
  test("string-backed enum with a from(json:) factory", () => {
    const ref = t(types.enum(["red", "green", "blue"]))
    expect(toSwiftyJSON(ref, "Color")).toBe(
      [
        "enum Color: String, CaseIterable {",
        "    case red",
        "    case green",
        "    case blue",
        "",
        "    static func from(json: JSON) -> Color? {",
        "        Color(rawValue: json.stringValue)",
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("non-identifier member gets an explicit raw value", () => {
    const ref = t(types.enum(["north-east", "south"]))
    expect(toSwiftyJSON(ref, "Direction")).toBe(
      [
        "enum Direction: String, CaseIterable {",
        '    case northEast = "north-east"',
        "    case south",
        "",
        "    static func from(json: JSON) -> Direction? {",
        "        Direction(rawValue: json.stringValue)",
        "    }",
        "}",
      ].join("\n"),
    )
  })
})

describe("unions", () => {
  test("plain union probes json.type, first match wins", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toSwiftyJSON(ref, "StringOrInt")).toBe(
      [
        "enum StringOrInt {",
        "    case string(String)",
        "    case integer(Int)",
        "",
        "    init(json: JSON) {",
        "        switch json.type {",
        "        case .string: self = .string(json.stringValue)",
        "        case .number: self = .integer(json.intValue)",
        "        default: self = .string(json.stringValue)",
        "        }",
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("discriminated union switches on the discriminator field's stringValue", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })

    const result = toSwiftyJSON(ref, "Shape")

    expect(result).toContain("enum Shape {")
    expect(result).toContain("case circle(Circle)")
    expect(result).toContain("case square(Square)")
    expect(result).toContain('switch json["type"].stringValue {')
    expect(result).toContain('case "circle": self = .circle(Circle(json: json))')
    expect(result).toContain('case "square": self = .square(Square(json: json))')
    expect(result).toContain("struct Circle {")
    expect(result).toContain("struct Square {")
    expect(result).toContain('self.radius = json["radius"].doubleValue')
  })
})
