import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, datetime, int32, int64, uuid } from "./kinds/common.ts"
import { toObjectMapper } from "./swift-objectmapper.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toObjectMapper(t(types.boolean), "Flag")).toBe("typealias Flag = Bool")
  })

  test("string", () => {
    expect(toObjectMapper(t(types.string), "Name")).toBe("typealias Name = String")
  })

  test("number -> Double", () => {
    expect(toObjectMapper(t(types.number), "Amount")).toBe("typealias Amount = Double")
  })

  test("integer -> Int", () => {
    expect(toObjectMapper(t(types.integer), "Count")).toBe("typealias Count = Int")
  })

  test("int32/int64 -> Int32/Int64", () => {
    expect(toObjectMapper(int32(), "Id32")).toBe("typealias Id32 = Int32")
    expect(toObjectMapper(int64(), "Id64")).toBe("typealias Id64 = Int64")
  })

  test("uuid degrades to String (no built-in ObjectMapper UUID transform)", () => {
    expect(toObjectMapper(uuid(), "UserId")).toBe("typealias UserId = String")
  })

  test("datetime degrades to String (DateTransform() needs a format string this IR doesn't carry)", () => {
    expect(toObjectMapper(datetime(), "CreatedAt")).toBe("typealias CreatedAt = String")
  })

  test("bytes degrades to String (base64, no built-in Data transform)", () => {
    expect(toObjectMapper(bytes(), "Payload")).toBe("typealias Payload = String")
  })

  test("unknown/null/void/never -> Any", () => {
    expect(toObjectMapper(t(types.unknown), "Blob")).toBe("typealias Blob = Any")
    expect(toObjectMapper(t(types.null), "Nothing")).toBe("typealias Nothing = Any")
  })
})

describe("optional", () => {
  test("meta.optional appends ? (no forced ! at typealias level)", () => {
    expect(toObjectMapper(t(types.string, { optional: true }), "Nickname")).toBe(
      "typealias Nickname = String?",
    )
  })

  test("meta.nullable appends ?", () => {
    expect(toObjectMapper(t(types.integer, { nullable: true }), "Age")).toBe("typealias Age = Int?")
  })
})

describe("arrays and dictionaries", () => {
  test("array of primitives has a clean element type, no IUO leaking into it", () => {
    expect(toObjectMapper(t(types.array(t(types.string))), "Tags")).toBe("typealias Tags = [String]")
  })

  test("map -> [String: Value] (JSON object keys are always strings)", () => {
    expect(toObjectMapper(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
      "typealias Counts = [String: Int]",
    )
  })

  test("tuple -> Swift tuple", () => {
    expect(toObjectMapper(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toBe(
      "typealias Pair = (String, Int)",
    )
  })
})

describe("Mappable structs", () => {
  test("required fields are implicitly-unwrapped (T!), wired via <- map[key]", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    expect(toObjectMapper(ref, "Person")).toBe(
      [
        "struct Person: Mappable {",
        "    var name: String!",
        "    var age: Int!",
        "",
        "    init?(map: Map) {}",
        "",
        "    mutating func mapping(map: Map) {",
        '        name <- map["name"]',
        '        age <- map["age"]',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("optional field is plain T?, not implicitly-unwrapped", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toObjectMapper(ref, "Profile")).toBe(
      [
        "struct Profile: Mappable {",
        "    var nickname: String?",
        "",
        "    init?(map: Map) {}",
        "",
        "    mutating func mapping(map: Map) {",
        '        nickname <- map["nickname"]',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("array-typed field stays a clean [T]!, no IUO on the element", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string))) }))
    expect(toObjectMapper(ref, "Post")).toBe(
      [
        "struct Post: Mappable {",
        "    var tags: [String]!",
        "",
        "    init?(map: Map) {}",
        "",
        "    mutating func mapping(map: Map) {",
        '        tags <- map["tags"]',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("nested object field hoists a nested Mappable struct inside the parent's body", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    expect(toObjectMapper(ref, "Person")).toBe(
      [
        "struct Person: Mappable {",
        "    var address: Address!",
        "",
        "    init?(map: Map) {}",
        "",
        "    mutating func mapping(map: Map) {",
        '        address <- map["address"]',
        "    }",
        "",
        "    struct Address: Mappable {",
        "        var city: String!",
        "",
        "        init?(map: Map) {}",
        "",
        "        mutating func mapping(map: Map) {",
        '            city <- map["city"]',
        "        }",
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("tuple-typed field is declared but left unwired, with a degrade comment", () => {
    const ref = t(types.object({ pair: t(types.tuple([t(types.string), t(types.integer)])) }))
    const result = toObjectMapper(ref, "Row")
    expect(result).toContain("var pair: (String, Int)!")
    expect(result).toContain("ObjectMapper has no tuple transform")
    expect(result).not.toContain('pair <- map["pair"]')
  })

  test("description renders as a /// doc comment above the struct", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A person record." })
    expect(toObjectMapper(ref, "Person")).toBe(
      [
        "/// A person record.",
        "struct Person: Mappable {",
        "    var id: String!",
        "",
        "    init?(map: Map) {}",
        "",
        "    mutating func mapping(map: Map) {",
        '        id <- map["id"]',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("deprecated true renders a bare @available(*, deprecated) attribute", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: true })
    expect(toObjectMapper(ref, "Person")).toBe(
      [
        "@available(*, deprecated)",
        "struct Person: Mappable {",
        "    var id: String!",
        "",
        "    init?(map: Map) {}",
        "",
        "    mutating func mapping(map: Map) {",
        '        id <- map["id"]',
        "    }",
        "}",
      ].join("\n"),
    )
  })
})

describe("enums", () => {
  test("string-backed enum, no extra ceremony (RawRepresentable <- overload)", () => {
    const ref = t(types.enum(["red", "green", "blue"]))
    expect(toObjectMapper(ref, "Color")).toBe(
      ["enum Color: String, CaseIterable {", "    case red", "    case green", "    case blue", "}"].join(
        "\n",
      ),
    )
  })

  test("non-identifier member gets an explicit raw value", () => {
    const ref = t(types.enum(["north-east", "south"]))
    expect(toObjectMapper(ref, "Direction")).toBe(
      [
        "enum Direction: String, CaseIterable {",
        '    case northEast = "north-east"',
        "    case south",
        "}",
      ].join("\n"),
    )
  })
})

describe("unions", () => {
  test("plain union of object variants tries each variant's own init?(map:)", () => {
    const circle = t(types.object({ radius: t(types.number) }), { typeName: "Circle" })
    const square = t(types.object({ side: t(types.number) }), { typeName: "Square" })
    const ref = t(types.union([circle, square]))

    const result = toObjectMapper(ref, "Shape")

    expect(result).toContain("enum Shape {")
    expect(result).toContain("case circle(Circle)")
    expect(result).toContain("case square(Square)")
    expect(result).toContain("static func from(map: Map) -> Shape? {")
    expect(result).toContain("if let value = Circle(map: map) { return .circle(value) }")
    expect(result).toContain("if let value = Square(map: map) { return .square(value) }")
    expect(result).toContain("struct Circle: Mappable {")
    expect(result).toContain("struct Square: Mappable {")
  })

  test("plain union of scalar variants leaves them unreachable, flagged with a comment", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    const result = toObjectMapper(ref, "StringOrInt")

    expect(result).toContain("case string(String)")
    expect(result).toContain("case integer(Int)")
    expect(result).toContain("ObjectMapper's Map only wraps a keyed JSON object")
    expect(result).toContain("return nil")
    expect(result).not.toContain("as? String")
  })

  test("discriminated union switches on the discriminator key read from map.JSON", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })

    const result = toObjectMapper(ref, "Shape")

    expect(result).toContain("enum Shape {")
    expect(result).toContain("case circle(Circle)")
    expect(result).toContain("case square(Square)")
    expect(result).toContain('guard let type = map.JSON["type"] as? String else { return nil }')
    expect(result).toContain('case "circle": return Circle(map: map).map { .circle($0) }')
    expect(result).toContain('case "square": return Square(map: map).map { .square($0) }')
    expect(result).toContain("struct Circle: Mappable {")
    expect(result).toContain("struct Square: Mappable {")
    expect(result).toContain('radius <- map["radius"]')
  })
})
