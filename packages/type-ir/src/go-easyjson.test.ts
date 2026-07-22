import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, datetime, float32, int32, int64, uuid } from "./kinds/common.ts"
import { toEasyjson } from "./go-easyjson.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toEasyjson(t(types.boolean), "Flag")).toBe("type Flag = bool")
  })

  test("number maps to float64", () => {
    expect(toEasyjson(t(types.number), "Amount")).toBe("type Amount = float64")
  })

  test("string", () => {
    expect(toEasyjson(t(types.string), "Name")).toBe("type Name = string")
  })

  test("bare integer maps to int", () => {
    expect(toEasyjson(t(types.integer), "Count")).toBe("type Count = int")
  })

  test("int32/int64 preserve width", () => {
    expect(toEasyjson(int32(), "Id32")).toBe("type Id32 = int32")
    expect(toEasyjson(int64(), "Id64")).toBe("type Id64 = int64")
  })

  test("float32 preserves width", () => {
    expect(toEasyjson(float32(), "Ratio")).toBe("type Ratio = float32")
  })

  test("uuid degrades to string", () => {
    expect(toEasyjson(uuid(), "Id")).toBe("type Id = string")
  })

  test("datetime maps to time.Time", () => {
    expect(toEasyjson(datetime(), "CreatedAt")).toBe("type CreatedAt = time.Time")
  })

  test("bytes maps to []byte", () => {
    expect(toEasyjson(bytes(), "Payload")).toBe("type Payload = []byte")
  })

  test("null and unknown map to interface{}", () => {
    expect(toEasyjson(t(types.null), "Nothing")).toBe("type Nothing = interface{}")
    expect(toEasyjson(t(types.unknown), "Anything")).toBe("type Anything = interface{}")
  })

  test("void and never map to struct{}", () => {
    expect(toEasyjson(t(types.void), "Nada")).toBe("type Nada = struct{}")
    expect(toEasyjson(t(types.never), "Impossible")).toBe("type Impossible = struct{}")
  })
})

test("array becomes a slice", () => {
  expect(toEasyjson(t(types.array(t(types.string))), "Names")).toBe("type Names = []string")
})

test("map becomes a Go map", () => {
  const ref = t(types.map(t(types.string), t(types.number)))
  expect(toEasyjson(ref, "Scores")).toBe("type Scores = map[string]float64")
})

describe("struct with easyjson directive + json tags", () => {
  test("required field gets a plain json tag under the directive", () => {
    const ref = t(types.object({ name: t(types.string) }))
    expect(toEasyjson(ref, "User")).toBe(
      '//easyjson:json\ntype User struct {\n\tName string `json:"name"`\n}',
    )
  })

  test("optional value-kind field becomes a pointer with omitempty", () => {
    const ref = t(types.object({ age: t(types.number, { optional: true }) }))
    expect(toEasyjson(ref, "User")).toBe(
      '//easyjson:json\ntype User struct {\n\tAge *float64 `json:"age,omitempty"`\n}',
    )
  })

  test("optional slice field is not pointer-wrapped (nil already means absent)", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string)), { optional: true }) }))
    expect(toEasyjson(ref, "Post")).toBe(
      '//easyjson:json\ntype Post struct {\n\tTags []string `json:"tags,omitempty"`\n}',
    )
  })

  test("nullable field is pointer-wrapped like optional", () => {
    const ref = t(types.object({ name: t(types.string, { nullable: true }) }))
    expect(toEasyjson(ref, "User")).toBe(
      '//easyjson:json\ntype User struct {\n\tName *string `json:"name,omitempty"`\n}',
    )
  })

  test("multiple fields preserve declaration order", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.number) }))
    expect(toEasyjson(ref, "User")).toBe(
      '//easyjson:json\ntype User struct {\n\tId string `json:"id"`\n\tAge float64 `json:"age"`\n}',
    )
  })
})

describe("doc comments", () => {
  test("description renders as a leading // Name comment above the directive", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "represents a person." })
    expect(toEasyjson(ref, "User")).toBe(
      '// User represents a person.\n//easyjson:json\ntype User struct {\n\tId string `json:"id"`\n}',
    )
  })

  test("deprecated true renders a // Deprecated: line above the directive", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: true })
    expect(toEasyjson(ref, "User")).toBe(
      '// Deprecated: User is deprecated.\n//easyjson:json\ntype User struct {\n\tId string `json:"id"`\n}',
    )
  })

  test("deprecated string message and description combine with a blank comment line", () => {
    const ref = t(types.object({ id: t(types.string) }), {
      description: "represents a person.",
      deprecated: "Use NewUser instead.",
    })
    expect(toEasyjson(ref, "User")).toBe(
      '// User represents a person.\n//\n// Deprecated: Use NewUser instead.\n//easyjson:json\ntype User struct {\n\tId string `json:"id"`\n}',
    )
  })
})

describe("nested objects", () => {
  test("nested object field hoists a separate easyjson-annotated struct", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    expect(toEasyjson(ref, "User")).toBe(
      [
        "//easyjson:json",
        "type UserAddress struct {",
        '\tCity string `json:"city"`',
        "}",
        "",
        "//easyjson:json",
        "type User struct {",
        '\tAddress UserAddress `json:"address"`',
        "}",
      ].join("\n"),
    )
  })
})

describe("tuple", () => {
  test("renders as an easyjson-annotated struct with numbered fields", () => {
    const ref = t(types.tuple([t(types.string), t(types.number)]))
    expect(toEasyjson(ref, "Pair")).toBe(
      '//easyjson:json\ntype Pair struct {\n\tF0 string `json:"0"`\n\tF1 float64 `json:"1"`\n}',
    )
  })
})

describe("enum", () => {
  test("renders as a string type plus a const block, no directive", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toEasyjson(ref, "Status")).toBe(
      [
        "type Status string",
        "",
        "const (",
        '\tStatusActive Status = "active"',
        '\tStatusInactive Status = "inactive"',
        ")",
      ].join("\n"),
    )
  })
})

describe("union", () => {
  test("renders as a json.RawMessage-backed named type documenting its variants", () => {
    const ref = t(
      types.union([
        t(types.object({ kind: t(types.string), a: t(types.number) })),
        t(types.object({ kind: t(types.string), b: t(types.string) })),
      ]),
    )
    const out = toEasyjson(ref, "Shape")
    expect(out).toContain("//easyjson:json\ntype ShapeObject struct {")
    expect(out).toContain("//easyjson:json\ntype ShapeObject2 struct {")
    expect(out).toContain(
      "// Shape is a discriminated union deferred via json.RawMessage — re-unmarshal into one of: ShapeObject, ShapeObject2.\ntype Shape json.RawMessage",
    )
  })

  test("primitive variants get wrapped in a locally-defined named type", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    const out = toEasyjson(ref, "Value")
    expect(out).toBe(
      [
        "type ValueString string",
        "",
        "type ValueNumber float64",
        "",
        "// Value is a discriminated union deferred via json.RawMessage — re-unmarshal into one of: ValueString, ValueNumber.",
        "type Value json.RawMessage",
      ].join("\n"),
    )
  })
})

describe("service interface", () => {
  test("interface kind maps to a native Go interface, no directive", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
        balance: t(types.method([], t(types.number))),
      }),
    )
    expect(toEasyjson(ref, "Account")).toBe(
      ["type Account interface {", "\tDeposit(float64)", "\tBalance() float64", "}"].join("\n"),
    )
  })
})

test("root object needs no extra alias line", () => {
  const ref = t(types.object({ id: t(types.string) }))
  expect(toEasyjson(ref, "User")).toBe(
    '//easyjson:json\ntype User struct {\n\tId string `json:"id"`\n}',
  )
})

test("default root name is Root", () => {
  expect(toEasyjson(t(types.string))).toBe("type Root = string")
})
