import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes } from "./kinds/common.ts"
import { toKotlin, toKotlinDeclarations, toKotlinType } from "./kotlin.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toKotlinType(t(types.boolean))).toBe("Boolean")
  })

  test("string", () => {
    expect(toKotlinType(t(types.string))).toBe("String")
  })

  test("integer -> Int", () => {
    expect(toKotlinType(t(types.integer))).toBe("Int")
  })

  test("number -> Double", () => {
    expect(toKotlinType(t(types.number))).toBe("Double")
  })

  test("null -> Nothing?", () => {
    expect(toKotlinType(t(types.null))).toBe("Nothing?")
  })

  test("void -> Unit", () => {
    expect(toKotlinType(t(types.void))).toBe("Unit")
  })

  test("unknown -> Any", () => {
    expect(toKotlinType(t(types.unknown))).toBe("Any")
  })

  test("never -> Nothing", () => {
    expect(toKotlinType(t(types.never))).toBe("Nothing")
  })
})

test("bytes -> ByteArray", () => {
  expect(toKotlinType(bytes())).toBe("ByteArray")
})

test("nullable string appends ?", () => {
  expect(toKotlinType(t(types.string, { nullable: true }))).toBe("String?")
})

test("optional field also appends ?", () => {
  expect(toKotlinType(t(types.string, { optional: true }))).toBe("String?")
})

describe("array / map / tuple", () => {
  test("array -> List<T>", () => {
    expect(toKotlinType(t(types.array(t(types.string))))).toBe("List<String>")
  })

  test("map with string key -> Map<String, V>", () => {
    expect(toKotlinType(t(types.map(t(types.string), t(types.number))))).toBe("Map<String, Double>")
  })

  test("two-element tuple -> Pair<A, B>", () => {
    expect(toKotlinType(t(types.tuple([t(types.string), t(types.number)])))).toBe("Pair<String, Double>")
  })

  test("three-element tuple -> Triple<A, B, C>", () => {
    const ref = t(types.tuple([t(types.string), t(types.number), t(types.boolean)]))
    expect(toKotlinType(ref)).toBe("Triple<String, Double, Boolean>")
  })

  test("four-element tuple degrades to List<Any?>", () => {
    const ref = t(types.tuple([t(types.string), t(types.number), t(types.boolean), t(types.string)]))
    expect(toKotlinType(ref)).toBe("List<Any?>")
  })
})

test("ref renders the bare target name", () => {
  expect(toKotlinType(t(types.ref("User")))).toBe("User")
})

test("literal string type widens to String", () => {
  expect(toKotlinType(t(types.literal("active")))).toBe("String")
})

describe("data class generation", () => {
  test("emits a @Serializable data class with @SerialName per field", () => {
    const ref = t(
      types.object({
        id: t(types.string, { readonly: true }),
        age: t(types.integer, { optional: true }),
      }),
    )
    expect(toKotlin(ref, "User")).toBe(
      [
        "@Serializable",
        "data class User(",
        '    @SerialName("id") val id: String,',
        '    @SerialName("age") var age: Int? = null',
        ")",
      ].join("\n"),
    )
  })

  test("nested object field synthesizes a separate nested data class", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const output = toKotlin(ref, "Person")
    expect(output).toContain("data class Person(")
    expect(output).toContain('@SerialName("address") var address: Address')
    expect(output).toContain("data class Address(")
    expect(output).toContain('@SerialName("city") var city: String')
  })

  test("without a name, falls back to Anonymous", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toKotlin(ref)).toContain("data class Anonymous(")
  })
})

describe("enum class generation", () => {
  test("emits a @Serializable enum class with @SerialName + SCREAMING_SNAKE_CASE entries", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toKotlin(ref, "Status")).toBe(
      [
        "@Serializable",
        "enum class Status {",
        '    @SerialName("active") ACTIVE,',
        '    @SerialName("inactive") INACTIVE',
        "}",
      ].join("\n"),
    )
  })

  test("camelCase members reshape to SCREAMING_SNAKE_CASE while @SerialName preserves the original", () => {
    const ref = t(types.enum(["pendingReview"]))
    const output = toKotlin(ref, "Status")
    expect(output).toContain('@SerialName("pendingReview") PENDING_REVIEW')
  })
})

describe("sealed class unions", () => {
  test("discriminated union emits a sealed class with @SerialName-tagged subclasses", () => {
    const ref = t(
      types.union([
        t(types.object({ type: t(types.literal("circle")), radius: t(types.number) })),
        t(types.object({ type: t(types.literal("square")), side: t(types.number) })),
      ]),
      { discriminator: "type" },
    )
    const output = toKotlin(ref, "Shape")
    expect(output).toContain("sealed class Shape")
    expect(output).toContain('@SerialName("circle")')
    expect(output).toContain("data class Circle(")
    expect(output).toContain(") : Shape()")
    // The discriminant field itself is dropped from the generated fields —
    // it's now encoded via @SerialName on the subclass, not a data field.
    expect(output).not.toContain('@SerialName("type")')
    expect(output).toContain('@SerialName("radius") var radius: Double')
  })

  test("plain (non-discriminated) union falls back to numbered scalar-carrier variants", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    const output = toKotlin(ref, "StringOrNumber")
    expect(output).toContain("sealed class StringOrNumber")
    expect(output).toContain("data class Variant1(val value: String) : StringOrNumber()")
    expect(output).toContain("data class Variant2(val value: Double) : StringOrNumber()")
  })
})

test("typealias for a non-named kind given a name", () => {
  expect(toKotlin(t(types.string), "Name")).toBe("typealias Name = String")
})

test("no name and a non-named kind returns the bare type expression", () => {
  expect(toKotlin(t(types.array(t(types.string))))).toBe("List<String>")
})

test("toKotlinDeclarations renders every registry entry", () => {
  const registry = {
    User: t(types.object({ id: t(types.string) })),
    Status: t(types.enum(["active", "inactive"])),
  }
  const output = toKotlinDeclarations(registry)
  expect(output).toContain("data class User(")
  expect(output).toContain("enum class Status {")
})

test("unknown kind fallback", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toKotlinType(ref)).toBe("Any")
})
