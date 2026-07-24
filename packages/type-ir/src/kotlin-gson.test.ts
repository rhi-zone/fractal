import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes } from "./kinds/common.ts"
import { toKotlinGson, toKotlinGsonDeclarations, toKotlinType } from "./kotlin-gson.ts"

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
  test("emits a data class with @SerializedName + @Expose per field, no @Serializable marker", () => {
    const ref = t(
      types.object({
        id: t(types.string, { readonly: true }),
        age: t(types.integer, { optional: true }),
      }),
    )
    expect(toKotlinGson(ref, "User")).toBe(
      [
        "data class User(",
        '    @SerializedName("id") @Expose val id: String,',
        '    @SerializedName("age") @Expose var age: Int? = null',
        ")",
      ].join("\n"),
    )
  })

  test("expose: false omits @Expose", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toKotlinGson(ref, "User", { expose: false })
    expect(out).toContain('@SerializedName("id") var id: String')
    expect(out).not.toContain("@Expose")
  })

  test("nested object field synthesizes a separate nested data class", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const output = toKotlinGson(ref, "Person")
    expect(output).toContain("data class Person(")
    expect(output).toContain('@SerializedName("address") @Expose var address: Address')
    expect(output).toContain("data class Address(")
    expect(output).toContain('@SerializedName("city") @Expose var city: String')
  })

  test("without a name, falls back to Anonymous", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toKotlinGson(ref)).toContain("data class Anonymous(")
  })
})

describe("enum class generation", () => {
  test("emits an enum class with @SerializedName + @Expose on each constant, SCREAMING_SNAKE_CASE entries", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toKotlinGson(ref, "Status")).toBe(
      [
        "enum class Status {",
        '    @SerializedName("active") @Expose ACTIVE,',
        '    @SerializedName("inactive") @Expose INACTIVE',
        "}",
      ].join("\n"),
    )
  })

  test("camelCase members reshape to SCREAMING_SNAKE_CASE while @SerializedName preserves the original", () => {
    const ref = t(types.enum(["pendingReview"]))
    const output = toKotlinGson(ref, "Status")
    expect(output).toContain('@SerializedName("pendingReview") @Expose PENDING_REVIEW')
  })
})

describe("sealed class unions", () => {
  test("discriminated union emits a sealed class with a RuntimeTypeAdapterFactory comment, no @SerialName tag", () => {
    const ref = t(
      types.union([
        t(types.object({ type: t(types.literal("circle")), radius: t(types.number) })),
        t(types.object({ type: t(types.literal("square")), side: t(types.number) })),
      ]),
      { discriminator: "type" },
    )
    const output = toKotlinGson(ref, "Shape")
    expect(output).toContain("sealed class Shape")
    expect(output).toContain("data class Circle(")
    expect(output).toContain(") : Shape()")
    expect(output).not.toContain("@SerialName")
    expect(output).toContain("// Gson has no annotation-based polymorphism support")
    expect(output).toContain('.of(Shape::class.java, "type")')
    expect(output).toContain('.registerSubtype(Circle::class.java, "Circle")')
    // The discriminant field itself is dropped from the generated fields.
    expect(output).not.toContain('@SerializedName("type")')
    expect(output).toContain('@SerializedName("radius") @Expose var radius: Double')
  })

  test("plain (non-discriminated) union falls back to numbered scalar-carrier variants", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    const output = toKotlinGson(ref, "StringOrNumber")
    expect(output).toContain("sealed class StringOrNumber")
    expect(output).toContain("data class Variant1(val value: String) : StringOrNumber()")
    expect(output).toContain("data class Variant2(val value: Double) : StringOrNumber()")
    expect(output).toContain(".of(StringOrNumber::class.java)")
  })
})

test("typealias for a non-named kind given a name", () => {
  expect(toKotlinGson(t(types.string), "Name")).toBe("typealias Name = String")
})

test("no name and a non-named kind returns the bare type expression", () => {
  expect(toKotlinGson(t(types.array(t(types.string))))).toBe("List<String>")
})

test("toKotlinGsonDeclarations renders every registry entry", () => {
  const registry = {
    User: t(types.object({ id: t(types.string) })),
    Status: t(types.enum(["active", "inactive"])),
  }
  const output = toKotlinGsonDeclarations(registry)
  expect(output).toContain("data class User(")
  expect(output).toContain("enum class Status {")
})

test("unknown kind fallback", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toKotlinType(ref)).toBe("Any")
})
