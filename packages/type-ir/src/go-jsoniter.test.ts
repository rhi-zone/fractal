import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, datetime, float32, int32, int64, uuid } from "./kinds/common.ts"
import { toJsoniter } from "./go-jsoniter.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toJsoniter(t(types.boolean), "Flag")).toBe("type Flag = bool")
  })

  test("number maps to float64", () => {
    expect(toJsoniter(t(types.number), "Amount")).toBe("type Amount = float64")
  })

  test("string", () => {
    expect(toJsoniter(t(types.string), "Name")).toBe("type Name = string")
  })

  test("bare integer maps to int", () => {
    expect(toJsoniter(t(types.integer), "Count")).toBe("type Count = int")
  })

  test("int32/int64 preserve width", () => {
    expect(toJsoniter(int32(), "Id32")).toBe("type Id32 = int32")
    expect(toJsoniter(int64(), "Id64")).toBe("type Id64 = int64")
  })

  test("float32 preserves width", () => {
    expect(toJsoniter(float32(), "Ratio")).toBe("type Ratio = float32")
  })

  test("uuid degrades to string", () => {
    expect(toJsoniter(uuid(), "Id")).toBe("type Id = string")
  })

  test("datetime maps to time.Time", () => {
    expect(toJsoniter(datetime(), "CreatedAt")).toBe("type CreatedAt = time.Time")
  })

  test("bytes maps to []byte", () => {
    expect(toJsoniter(bytes(), "Payload")).toBe("type Payload = []byte")
  })

  test("null and unknown map to interface{}", () => {
    expect(toJsoniter(t(types.null), "Nothing")).toBe("type Nothing = interface{}")
    expect(toJsoniter(t(types.unknown), "Anything")).toBe("type Anything = interface{}")
  })

  test("void and never map to struct{}", () => {
    expect(toJsoniter(t(types.void), "Nada")).toBe("type Nada = struct{}")
    expect(toJsoniter(t(types.never), "Impossible")).toBe("type Impossible = struct{}")
  })
})

test("array becomes a slice", () => {
  expect(toJsoniter(t(types.array(t(types.string))), "Names")).toBe("type Names = []string")
})

test("map becomes a Go map", () => {
  const ref = t(types.map(t(types.string), t(types.number)))
  expect(toJsoniter(ref, "Scores")).toBe("type Scores = map[string]float64")
})

describe("struct with json tags", () => {
  test("required field gets a plain json tag", () => {
    const ref = t(types.object({ name: t(types.string) }))
    expect(toJsoniter(ref, "User")).toBe('type User struct {\n\tName string `json:"name"`\n}')
  })

  test("optional value-kind field becomes a pointer with omitempty", () => {
    const ref = t(types.object({ age: t(types.number, { optional: true }) }))
    expect(toJsoniter(ref, "User")).toBe('type User struct {\n\tAge *float64 `json:"age,omitempty"`\n}')
  })

  test("optional slice field is not pointer-wrapped (nil already means absent)", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string)), { optional: true }) }))
    expect(toJsoniter(ref, "Post")).toBe('type Post struct {\n\tTags []string `json:"tags,omitempty"`\n}')
  })

  test("nullable field is pointer-wrapped like optional", () => {
    const ref = t(types.object({ name: t(types.string, { nullable: true }) }))
    expect(toJsoniter(ref, "User")).toBe('type User struct {\n\tName *string `json:"name,omitempty"`\n}')
  })

  test("multiple fields preserve declaration order", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.number) }))
    expect(toJsoniter(ref, "User")).toBe(
      'type User struct {\n\tId string `json:"id"`\n\tAge float64 `json:"age"`\n}',
    )
  })
})

describe("doc comments", () => {
  test("description renders as a leading // Name comment", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "represents a person." })
    expect(toJsoniter(ref, "User")).toBe(
      '// User represents a person.\ntype User struct {\n\tId string `json:"id"`\n}',
    )
  })

  test("deprecated true renders a // Deprecated: line", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: true })
    expect(toJsoniter(ref, "User")).toBe(
      '// Deprecated: User is deprecated.\ntype User struct {\n\tId string `json:"id"`\n}',
    )
  })

  test("deprecated string message and description combine with a blank comment line", () => {
    const ref = t(types.object({ id: t(types.string) }), {
      description: "represents a person.",
      deprecated: "Use NewUser instead.",
    })
    expect(toJsoniter(ref, "User")).toBe(
      '// User represents a person.\n//\n// Deprecated: Use NewUser instead.\ntype User struct {\n\tId string `json:"id"`\n}',
    )
  })
})

describe("nested objects", () => {
  test("nested object field hoists a separate named struct", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    expect(toJsoniter(ref, "User")).toBe(
      [
        "type UserAddress struct {",
        '\tCity string `json:"city"`',
        "}",
        "",
        "type User struct {",
        '\tAddress UserAddress `json:"address"`',
        "}",
      ].join("\n"),
    )
  })
})

describe("tuple", () => {
  test("renders as a struct with numbered fields", () => {
    const ref = t(types.tuple([t(types.string), t(types.number)]))
    expect(toJsoniter(ref, "Pair")).toBe(
      'type Pair struct {\n\tF0 string `json:"0"`\n\tF1 float64 `json:"1"`\n}',
    )
  })
})

describe("enum", () => {
  test("renders as a string type plus a const block", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toJsoniter(ref, "Status")).toBe(
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
  test("object variants get the marker method attached to their own hoisted struct", () => {
    const ref = t(
      types.union([
        t(types.object({ kind: t(types.string), a: t(types.number) })),
        t(types.object({ kind: t(types.string), b: t(types.string) })),
      ]),
    )
    const out = toJsoniter(ref, "Shape")
    expect(out).toContain("type Shape interface {\n\tisShape()\n}")
    expect(out).toContain("func (ShapeObject) isShape() {}")
    expect(out).toContain("func (ShapeObject2) isShape() {}")
    expect(out).toContain('type ShapeObject struct {')
    expect(out).toContain('type ShapeObject2 struct {')
  })

  test("primitive variants get wrapped in a locally-defined named type", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    const out = toJsoniter(ref, "Value")
    expect(out).toBe(
      [
        "type Value interface {",
        "\tisValue()",
        "}",
        "",
        "type ValueString string",
        "",
        "func (ValueString) isValue() {}",
        "",
        "type ValueNumber float64",
        "",
        "func (ValueNumber) isValue() {}",
      ].join("\n"),
    )
  })
})

describe("service interface", () => {
  test("interface kind maps to a native Go interface", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
        balance: t(types.method([], t(types.number))),
      }),
    )
    expect(toJsoniter(ref, "Account")).toBe(
      ["type Account interface {", "\tDeposit(float64)", "\tBalance() float64", "}"].join("\n"),
    )
  })
})

test("root object needs no extra alias line", () => {
  const ref = t(types.object({ id: t(types.string) }))
  expect(toJsoniter(ref, "User")).toBe('type User struct {\n\tId string `json:"id"`\n}')
})

test("default root name is Root", () => {
  expect(toJsoniter(t(types.string))).toBe("type Root = string")
})

test("jsoniter output is identical to encoding/json output (drop-in compatibility)", async () => {
  const { toGo } = await import("./go-encoding-json.ts")
  const ref = t(
    types.object({
      id: t(types.string),
      tags: t(types.array(t(types.string)), { optional: true }),
      status: t(types.enum(["active", "inactive"])),
    }),
    { description: "A user record." },
  )
  expect(toJsoniter(ref, "User")).toBe(toGo(ref, "User"))
})
