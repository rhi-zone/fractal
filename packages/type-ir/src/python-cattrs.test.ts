import { describe, expect, test } from "bun:test"
import { toCattrs } from "./python-cattrs.ts"
import { toAttrs } from "./python-attrs.ts"
import { bytes } from "./kinds/bytes.ts"
import { t, types } from "./index.ts"

describe("primitives", () => {
  test("boolean", () => {
    const out = toCattrs(t(types.boolean), "Flag")
    expect(out).toContain("Flag = bool")
    expect(out).toContain("import cattrs")
    expect(out).toContain("converter = cattrs.Converter()")
  })

  test("number maps to float", () => {
    expect(toCattrs(t(types.number), "Amount")).toContain("Amount = float")
  })

  test("integer maps to int", () => {
    expect(toCattrs(t(types.integer), "Count")).toContain("Count = int")
  })

  test("string maps to str", () => {
    expect(toCattrs(t(types.string), "Name")).toContain("Name = str")
  })

  test("bytes maps to bytes", () => {
    expect(toCattrs(bytes(), "Blob")).toContain("Blob = bytes")
  })

  test("null maps to None", () => {
    expect(toCattrs(t(types.null), "Nothing")).toContain("Nothing = None")
  })

  test("unknown maps to Any and imports it", () => {
    const out = toCattrs(t(types.unknown), "Anything")
    expect(out).toContain("from typing import Any")
    expect(out).toContain("Anything = Any")
  })
})

describe("basic attrs class generation, cattrs converter preamble", () => {
  test("emits an attrs.define class with required fields, in source order", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    const out = toCattrs(ref, "User")
    expect(out).toContain("import attrs")
    expect(out).toContain("import cattrs")
    expect(out).toContain("@attrs.define()")
    expect(out).toContain("class User:")
    expect(out).toContain("    id: str")
    expect(out).toContain("    age: int")
    expect(out).toContain("converter = cattrs.Converter()")
    expect(out).toContain("converter.structure(data, User) / converter.unstructure(obj)")
  })

  test("empty object emits pass", () => {
    const out = toCattrs(t(types.object({})), "Empty")
    expect(out).toContain("@attrs.define()")
    expect(out).toContain("class Empty:")
    expect(out).toContain("    pass")
  })

  test("nested object field is promoted to its own attrs class named from the field", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }))
    const out = toCattrs(ref, "User")
    expect(out).toContain("class Address:")
    expect(out).toContain("    city: str")
    expect(out).toContain("class User:")
    expect(out).toContain("    address: Address")
  })

  test("field order is preserved even when an optional field precedes a required one", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
        name: t(types.string),
      }),
    )
    const out = toCattrs(ref, "Person")
    const nicknameIdx = out.indexOf("    nickname:")
    const nameIdx = out.indexOf("    name:")
    expect(nicknameIdx).toBeGreaterThan(-1)
    expect(nameIdx).toBeGreaterThan(nicknameIdx)
  })
})

describe("validation constraints (identical to python-attrs.ts)", () => {
  test("string length + pattern become attrs.validators chained with and_", () => {
    const ref = t(
      types.object({
        username: t(types.string, { minLength: 3, maxLength: 20, pattern: "^[a-z]+$" }),
      }),
    )
    const out = toCattrs(ref, "Account")
    expect(out).toContain(
      '    username: str = attrs.field(validator=attrs.validators.and_(attrs.validators.min_len(3), attrs.validators.max_len(20), attrs.validators.matches_re("^[a-z]+$")))',
    )
  })

  test("numeric bounds become ge/le/gt/lt validators", () => {
    const ref = t(
      types.object({
        score: t(types.integer, { minimum: 0, maximum: 100 }),
      }),
    )
    const out = toCattrs(ref, "Result")
    expect(out).toContain(
      "score: int = attrs.field(validator=attrs.validators.and_(attrs.validators.ge(0), attrs.validators.le(100)))",
    )
  })

  test("multipleOf has no built-in attrs validator, so it surfaces as an unmodeled-metadata stub", () => {
    const ref = t(types.object({ amount: t(types.integer, { multipleOf: 5 }) }))
    const out = toCattrs(ref, "Order")
    expect(out).toContain("def _validate_amount(instance: object, attribute: object, value: object) -> None:")
    expect(out).toContain('unmodeled validation metadata on "amount": multipleOf')
  })

  test("field-level readonly becomes attrs.field(on_setattr=attrs.setters.frozen)", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    expect(toCattrs(ref, "Record")).toContain("id: str = attrs.field(on_setattr=attrs.setters.frozen)")
  })

  test("mutable meta.default uses attrs.field(factory=...) instead of a bare literal", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string)), { default: ["a", "b"] }) }))
    const out = toCattrs(ref, "Item")
    expect(out).toContain('tags: list[str] = attrs.field(factory=lambda: ["a", "b"])')
  })
})

describe("optional and nullable", () => {
  test("optional field renders as T | None = None", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    const out = toCattrs(ref, "Person")
    expect(out).toContain("    name: str")
    expect(out).toContain("    nickname: str | None = None")
  })

  test("nullable field renders T | None without a default", () => {
    const ref = t(types.object({ note: t(types.string, { nullable: true }) }))
    const out = toCattrs(ref, "Entry")
    expect(out).toContain("    note: str | None\n")
    expect(out).not.toContain("note: str | None = None")
  })
})

describe("frozen classes", () => {
  test("object-level readonly becomes @attrs.define(frozen=True)", () => {
    const ref = t(types.object({ id: t(types.string) }), { readonly: true })
    const out = toCattrs(ref, "Snapshot")
    expect(out).toContain("@attrs.define(frozen=True)")
    expect(out).toContain("class Snapshot:")
  })

  test("object-level description becomes the class docstring", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A user record." })
    const out = toCattrs(ref, "User")
    expect(out).toContain('    "A user record."')
  })
})

describe("enums", () => {
  test("emits a plain Enum (not str-backed)", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toCattrs(ref, "Status")
    expect(out).toContain("from enum import Enum")
    expect(out).toContain("class StatusEnum(Enum):")
    expect(out).toContain('    ACTIVE = "active"')
    expect(out).toContain('    INACTIVE = "inactive"')
  })

  test("enum member with non-identifier characters is sanitized", () => {
    const ref = t(types.enum(["in-progress"]))
    expect(toCattrs(ref, "State")).toContain('IN_PROGRESS = "in-progress"')
  })
})

describe("unions", () => {
  test("plain union renders as Union[T1, T2]", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    const out = toCattrs(ref, "Id")
    expect(out).toContain("from typing import Union")
    expect(out).toContain("Id = Union[str, int]")
  })

  test("union of duplicate-rendering variants collapses to a single type", () => {
    const ref = t(types.union([t(types.string), t(types.string)]))
    expect(toCattrs(ref, "Name")).toContain("Name = str")
  })

  test("discriminated union renders a converter.register_structure_hook TODO stub", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "kind" })
    const out = toCattrs(ref, "Shape")
    expect(out).toContain("Shape = Union[ShapeVariant1, ShapeVariant2]")
    expect(out).toContain("converter.register_structure_hook(")
    expect(out).toContain("Shape,")
    expect(out).toContain('"kind"')
  })

  test("discriminated union field inside an object carries an inline comment pointing at the hook", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const shapeUnion = t(types.union([circle, square]), { discriminator: "kind" })
    const ref = t(types.object({ shape: shapeUnion }))
    const out = toCattrs(ref, "Container")
    expect(out).toContain('shape: Union[ShapeVariant1, ShapeVariant2]  # discriminated by "kind"')
    expect(out).toContain("register_structure_hook")
  })
})

describe("collections", () => {
  test("array of string", () => {
    expect(toCattrs(t(types.array(t(types.string))), "Tags")).toContain("Tags = list[str]")
  })

  test("array of objects promotes the element to a named attrs class", () => {
    const ref = t(types.object({ items: t(types.array(t(types.object({ id: t(types.string) })))) }))
    const out = toCattrs(ref, "Basket")
    expect(out).toContain("class Items:")
    expect(out).toContain("    id: str")
    expect(out).toContain("class Basket:")
    expect(out).toContain("    items: list[Items]")
  })

  test("tuple", () => {
    expect(toCattrs(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toContain("Pair = tuple[str, int]")
  })

  test("dict with string key", () => {
    expect(toCattrs(t(types.map(t(types.string), t(types.integer))), "Counts")).toContain("Counts = dict[str, int]")
  })
})

test("literal", () => {
  const out = toCattrs(t(types.literal("active")), "Status")
  expect(out).toContain("from typing import Literal")
  expect(out).toContain('Status = Literal["active"]')
})

test("ref renders as the bare target name", () => {
  expect(toCattrs(t(types.ref("User")), "Alias")).toContain("Alias = User")
})

test("unknown kind fallback maps to Any", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  const out = toCattrs(ref, "Mystery")
  expect(out).toContain("from typing import Any")
  expect(out).toContain("Mystery = Any")
})

describe("comparison with plain attrs output", () => {
  test("class declarations are identical to python-attrs.ts apart from the cattrs preamble/converter", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer, { optional: true }) }))
    const attrsOut = toAttrs(ref, "Person")
    const cattrsOut = toCattrs(ref, "Person")
    expect(cattrsOut).toContain("@attrs.define()")
    expect(cattrsOut).toContain("class Person:")
    expect(cattrsOut).toContain("    id: str")
    expect(cattrsOut).toContain("    age: int | None = None")
    // attrs output has no cattrs converter; cattrs output does.
    expect(attrsOut).not.toContain("cattrs.Converter")
    expect(cattrsOut).toContain("cattrs.Converter()")
  })
})
