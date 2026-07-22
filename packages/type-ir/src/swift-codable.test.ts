import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, int32, int64, uuid } from "./kinds/common.ts"
import { toSwift } from "./swift-codable.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toSwift(t(types.boolean), "Flag")).toBe("typealias Flag = Bool")
  })

  test("string", () => {
    expect(toSwift(t(types.string), "Name")).toBe("typealias Name = String")
  })

  test("number -> Double", () => {
    expect(toSwift(t(types.number), "Amount")).toBe("typealias Amount = Double")
  })

  test("integer -> Int", () => {
    expect(toSwift(t(types.integer), "Count")).toBe("typealias Count = Int")
  })

  test("int32/int64 -> Int32/Int64", () => {
    expect(toSwift(int32(), "Id32")).toBe("typealias Id32 = Int32")
    expect(toSwift(int64(), "Id64")).toBe("typealias Id64 = Int64")
  })

  test("uuid -> UUID", () => {
    expect(toSwift(uuid(), "UserId")).toBe("typealias UserId = UUID")
  })

  test("bytes -> Data", () => {
    expect(toSwift(bytes(), "Payload")).toBe("typealias Payload = Data")
  })

  test("unknown -> Any", () => {
    expect(toSwift(t(types.unknown), "Blob")).toBe("typealias Blob = Any")
  })

  test("null -> Never?", () => {
    expect(toSwift(t(types.null), "Nothing")).toBe("typealias Nothing = Never?")
  })
})

describe("optional", () => {
  test("meta.optional appends ?", () => {
    expect(toSwift(t(types.string, { optional: true }), "Nickname")).toBe("typealias Nickname = String?")
  })

  test("meta.nullable appends ?", () => {
    expect(toSwift(t(types.integer, { nullable: true }), "Age")).toBe("typealias Age = Int?")
  })
})

describe("arrays and dictionaries", () => {
  test("array of primitives", () => {
    expect(toSwift(t(types.array(t(types.string))), "Tags")).toBe("typealias Tags = [String]")
  })

  test("map with string keys -> dictionary", () => {
    expect(toSwift(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
      "typealias Counts = [String: Int]",
    )
  })

  test("tuple -> Swift tuple", () => {
    expect(toSwift(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toBe(
      "typealias Pair = (String, Int)",
    )
  })
})

describe("Codable structs", () => {
  test("simple struct, no CodingKeys needed", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    expect(toSwift(ref, "Person")).toBe(
      ["struct Person: Codable {", "    var name: String", "    var age: Int", "}"].join("\n"),
    )
  })

  test("readonly field -> let, mutable field -> var", () => {
    const ref = t(
      types.object({
        id: t(types.string, { readonly: true }),
        name: t(types.string),
      }),
    )
    expect(toSwift(ref, "Widget")).toBe(
      ["struct Widget: Codable {", "    let id: String", "    var name: String", "}"].join("\n"),
    )
  })

  test("snake_case JSON key -> camelCase property + CodingKeys", () => {
    const ref = t(types.object({ user_name: t(types.string) }))
    expect(toSwift(ref, "Account")).toBe(
      [
        "struct Account: Codable {",
        "    var userName: String",
        "",
        "    enum CodingKeys: String, CodingKey {",
        '        case userName = "user_name"',
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("optional field renders as Optional", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toSwift(ref, "Profile")).toBe(
      ["struct Profile: Codable {", "    var nickname: String?", "}"].join("\n"),
    )
  })

  test("nested object field hoists to a nested struct", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    expect(toSwift(ref, "Person")).toBe(
      [
        "struct Person: Codable {",
        "    var address: Address",
        "",
        "    struct Address: Codable {",
        "        var city: String",
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("description renders as a /// doc comment above the struct", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A person record." })
    expect(toSwift(ref, "Person")).toBe(
      ["/// A person record.", "struct Person: Codable {", "    var id: String", "}"].join("\n"),
    )
  })

  test("deprecated true renders a bare @available(*, deprecated) attribute", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: true })
    expect(toSwift(ref, "Person")).toBe(
      ["@available(*, deprecated)", "struct Person: Codable {", "    var id: String", "}"].join("\n"),
    )
  })

  test("deprecated string message renders @available(*, deprecated, message:)", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: "Use NewPerson instead." })
    expect(toSwift(ref, "Person")).toBe(
      [
        '@available(*, deprecated, message: "Use NewPerson instead.")',
        "struct Person: Codable {",
        "    var id: String",
        "}",
      ].join("\n"),
    )
  })
})

describe("enums", () => {
  test("string-backed enum with CaseIterable", () => {
    const ref = t(types.enum(["red", "green", "blue"]))
    expect(toSwift(ref, "Color")).toBe(
      [
        "enum Color: String, Codable, CaseIterable {",
        "    case red",
        "    case green",
        "    case blue",
        "}",
      ].join("\n"),
    )
  })

  test("non-identifier member gets an explicit raw value", () => {
    const ref = t(types.enum(["north-east", "south"]))
    expect(toSwift(ref, "Direction")).toBe(
      [
        "enum Direction: String, Codable, CaseIterable {",
        '    case northEast = "north-east"',
        "    case south",
        "}",
      ].join("\n"),
    )
  })

  test("description and deprecated render doc comment + @available above the enum", () => {
    const ref = t(types.enum(["red", "green"]), { description: "A color.", deprecated: true })
    expect(toSwift(ref, "Color")).toBe(
      [
        "/// A color.",
        "@available(*, deprecated)",
        "enum Color: String, Codable, CaseIterable {",
        "    case red",
        "    case green",
        "}",
      ].join("\n"),
    )
  })
})

describe("unions", () => {
  test("plain union -> enum with associated values, probing Codable", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toSwift(ref, "StringOrInt")).toBe(
      [
        "enum StringOrInt: Codable {",
        "    case string(String)",
        "    case integer(Int)",
        "",
        "    init(from decoder: Decoder) throws {",
        "        let container = try decoder.singleValueContainer()",
        "        if let value = try? container.decode(String.self) {",
        "            self = .string(value)",
        "            return",
        "        }",
        "        if let value = try? container.decode(Int.self) {",
        "            self = .integer(value)",
        "            return",
        "        }",
        '        throw DecodingError.typeMismatch(StringOrInt.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "No matching variant for StringOrInt"))',
        "    }",
        "",
        "    func encode(to encoder: Encoder) throws {",
        "        var container = encoder.singleValueContainer()",
        "        switch self {",
        "        case .string(let value): try container.encode(value)",
        "        case .integer(let value): try container.encode(value)",
        "        }",
        "    }",
        "}",
      ].join("\n"),
    )
  })

  test("discriminated union -> tagged enum keyed on meta.discriminator", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })

    const result = toSwift(ref, "Shape")

    expect(result).toContain("enum Shape: Codable {")
    expect(result).toContain("case circle(Circle)")
    expect(result).toContain("case square(Square)")
    expect(result).toContain('private enum CodingKeys: String, CodingKey { case type = "type" }')
    expect(result).toContain('case "circle": self = .circle(try Circle(from: decoder))')
    expect(result).toContain('case "square": self = .square(try Square(from: decoder))')
    expect(result).toContain("struct Circle: Codable {")
    expect(result).toContain("struct Square: Codable {")
  })

  test("union-level description and deprecated render doc comment + @available above the enum", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]), {
      description: "A string or int.",
      deprecated: "Use NewValue instead.",
    })
    const result = toSwift(ref, "StringOrInt")
    expect(result.startsWith('/// A string or int.\n@available(*, deprecated, message: "Use NewValue instead.")\nenum StringOrInt: Codable {')).toBe(true)
  })
})
