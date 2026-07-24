import { describe, expect, test } from "bun:test"
import { toMsgspec } from "./python-msgspec.ts"
import { bytes } from "./kinds/bytes.ts"
import { t, types } from "./index.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toMsgspec(t(types.boolean), "Flag")).toBe("from __future__ import annotations\n\nFlag = bool\n")
  })

  test("number maps to float", () => {
    expect(toMsgspec(t(types.number), "Amount")).toBe("from __future__ import annotations\n\nAmount = float\n")
  })

  test("integer maps to int", () => {
    expect(toMsgspec(t(types.integer), "Count")).toBe("from __future__ import annotations\n\nCount = int\n")
  })

  test("string maps to str", () => {
    expect(toMsgspec(t(types.string), "Name")).toBe("from __future__ import annotations\n\nName = str\n")
  })

  test("bytes maps to bytes", () => {
    expect(toMsgspec(bytes(), "Blob")).toBe("from __future__ import annotations\n\nBlob = bytes\n")
  })

  test("null maps to None", () => {
    expect(toMsgspec(t(types.null), "Nothing")).toBe("from __future__ import annotations\n\nNothing = None\n")
  })

  test("unknown maps to Any and imports it", () => {
    expect(toMsgspec(t(types.unknown), "Anything")).toBe(
      "from __future__ import annotations\nfrom typing import Any\n\nAnything = Any\n",
    )
  })
})

describe("basic msgspec.Struct generation", () => {
  test("emits a msgspec.Struct class with required fields, in source order", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toMsgspec(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "import msgspec",
        "",
        "class User(msgspec.Struct):",
        "    id: str",
        "    age: int",
        "",
      ].join("\n"),
    )
  })

  test("empty object emits pass", () => {
    expect(toMsgspec(t(types.object({})), "Empty")).toBe(
      ["from __future__ import annotations", "import msgspec", "", "class Empty(msgspec.Struct):", "    pass", ""].join("\n"),
    )
  })

  test("nested object field is promoted to its own msgspec.Struct class named from the field", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }))
    expect(toMsgspec(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "import msgspec",
        "",
        "class Address(msgspec.Struct):",
        "    city: str",
        "",
        "class User(msgspec.Struct):",
        "    address: Address",
        "",
      ].join("\n"),
    )
  })

  test("field order is preserved even when an optional field precedes a required one", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
        name: t(types.string),
      }),
    )
    const out = toMsgspec(ref, "Person")
    const nicknameIdx = out.indexOf("    nickname:")
    const nameIdx = out.indexOf("    name:")
    expect(nicknameIdx).toBeGreaterThan(-1)
    expect(nameIdx).toBeGreaterThan(nicknameIdx)
  })
})

describe("validation constraints", () => {
  test("string length + pattern become a single msgspec.Meta call", () => {
    const ref = t(
      types.object({
        username: t(types.string, { minLength: 3, maxLength: 20, pattern: "^[a-z]+$" }),
      }),
    )
    const out = toMsgspec(ref, "Account")
    expect(out).toContain("from typing import Annotated")
    expect(out).toContain(
      '    username: Annotated[str, msgspec.Meta(min_length=3, max_length=20, pattern="^[a-z]+$")]',
    )
  })

  test("numeric bounds become ge/le/gt/lt kwargs", () => {
    const ref = t(
      types.object({
        score: t(types.integer, { minimum: 0, maximum: 100 }),
        ratio: t(types.number, { exclusiveMinimum: 0, exclusiveMaximum: 1 }),
      }),
    )
    const out = toMsgspec(ref, "Result")
    expect(out).toContain("score: Annotated[int, msgspec.Meta(ge=0, le=100)]")
    expect(out).toContain("ratio: Annotated[float, msgspec.Meta(gt=0, lt=1)]")
  })

  test("multipleOf HAS a native msgspec.Meta slot (unlike attrs)", () => {
    const ref = t(types.object({ amount: t(types.integer, { multipleOf: 5 }) }))
    const out = toMsgspec(ref, "Order")
    expect(out).toContain("amount: Annotated[int, msgspec.Meta(multiple_of=5)]")
    expect(out).not.toContain("TODO")
  })

  test("description lands inside the same msgspec.Meta call", () => {
    const ref = t(
      types.object({
        legacyId: t(types.string, { description: "old identifier" }),
      }),
    )
    const out = toMsgspec(ref, "Widget")
    expect(out).toContain('legacyId: Annotated[str, msgspec.Meta(description="old identifier")]')
  })

  test("deprecated has no Meta slot, so it renders as a trailing comment", () => {
    const ref = t(types.object({ legacyId: t(types.string, { deprecated: true }) }))
    const out = toMsgspec(ref, "Widget")
    expect(out).toContain("legacyId: str  # deprecated")
  })

  test("field-level readonly has no per-field equivalent, so it surfaces as a NOTE comment", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    const out = toMsgspec(ref, "Record")
    expect(out).toContain("# NOTE: msgspec has no per-field immutability")
    expect(out).toContain("    id: str")
  })

  test("meta.default renders as a plain class-body assignment for immutable values", () => {
    const ref = t(types.object({ role: t(types.string, { default: "member" }) }))
    const out = toMsgspec(ref, "Account")
    expect(out).toContain('    role: str = "member"')
    expect(out).not.toContain("msgspec.field")
  })

  test("mutable meta.default uses msgspec.field(default_factory=...) instead of a bare literal", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string)), { default: ["a", "b"] }) }))
    const out = toMsgspec(ref, "Item")
    expect(out).toContain('tags: list[str] = msgspec.field(default_factory=lambda: ["a", "b"])')
  })

  test("unrecognized meta keys surface as a TODO comment on the field, no fabricated validator hook", () => {
    const ref = t(types.object({ email: t(types.string, { format: "email" }) }))
    const out = toMsgspec(ref, "Contact")
    expect(out).toContain('unmodeled validation metadata on "email": format')
    expect(out).toContain("msgspec has no per-field validator hook")
    expect(out).toContain("    email: str")
  })

  test("unrecognized meta keys on the object itself surface as a TODO comment above the class", () => {
    const ref = t(types.object({ a: t(types.string) }), { crossFieldRule: "a != b" })
    const out = toMsgspec(ref, "Thing")
    expect(out).toContain('unmodeled validation metadata on "Thing": crossFieldRule')
    expect(out).toContain("no post-init validation hook")
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
    expect(toMsgspec(ref, "Person")).toBe(
      [
        "from __future__ import annotations",
        "import msgspec",
        "",
        "class Person(msgspec.Struct):",
        "    name: str",
        "    nickname: str | None = None",
        "",
      ].join("\n"),
    )
  })

  test("nullable field renders T | None without a default", () => {
    const ref = t(types.object({ note: t(types.string, { nullable: true }) }))
    const out = toMsgspec(ref, "Entry")
    expect(out).toContain("    note: str | None\n")
    expect(out).not.toContain("note: str | None = None")
  })

  test("optional and nullable field only wraps | None once", () => {
    const ref = t(types.object({ note: t(types.string, { optional: true, nullable: true }) }))
    const out = toMsgspec(ref, "Entry")
    expect(out).toContain("    note: str | None = None")
    expect(out).not.toContain("str | None | None")
  })
})

describe("frozen classes", () => {
  test("object-level readonly becomes msgspec.Struct, frozen=True", () => {
    const ref = t(types.object({ id: t(types.string) }), { readonly: true })
    const out = toMsgspec(ref, "Snapshot")
    expect(out).toContain("class Snapshot(msgspec.Struct, frozen=True):")
  })

  test("object-level description becomes the class docstring", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A user record." })
    const out = toMsgspec(ref, "User")
    expect(out).toContain('    "A user record."')
  })
})

describe("enums", () => {
  test("emits a plain Enum (not str-backed)", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toMsgspec(ref, "Status")).toBe(
      [
        "from __future__ import annotations",
        "from enum import Enum",
        "",
        "class StatusEnum(Enum):",
        '    ACTIVE = "active"',
        '    INACTIVE = "inactive"',
        "",
      ].join("\n"),
    )
  })

  test("enum member with non-identifier characters is sanitized", () => {
    const ref = t(types.enum(["in-progress"]))
    expect(toMsgspec(ref, "State")).toBe(
      [
        "from __future__ import annotations",
        "from enum import Enum",
        "",
        "class StateEnum(Enum):",
        '    IN_PROGRESS = "in-progress"',
        "",
      ].join("\n"),
    )
  })
})

describe("unions", () => {
  test("plain union renders as Union[T1, T2]", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toMsgspec(ref, "Id")).toBe(
      "from __future__ import annotations\nfrom typing import Union\n\nId = Union[str, int]\n",
    )
  })

  test("union of duplicate-rendering variants collapses to a single type", () => {
    const ref = t(types.union([t(types.string), t(types.string)]))
    expect(toMsgspec(ref, "Name")).toBe("from __future__ import annotations\n\nName = str\n")
  })

  test("discriminated union renders as a plain Union with a tag_field comment", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "kind" })
    const out = toMsgspec(ref, "Shape")
    expect(out).toContain('Shape = Union[ShapeVariant1, ShapeVariant2]  # discriminated by "kind"')
    expect(out).toContain("tag_field=\"kind\"")
  })

  test("discriminated union field inside an object carries the same tag_field comment", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const shapeUnion = t(types.union([circle, square]), { discriminator: "kind" })
    const ref = t(types.object({ shape: shapeUnion }))
    const out = toMsgspec(ref, "Container")
    expect(out).toContain('shape: Union[ShapeVariant1, ShapeVariant2]  # discriminated by "kind"')
    expect(out).toContain("tag_field=\"kind\"")
  })
})

describe("collections", () => {
  test("array of string", () => {
    expect(toMsgspec(t(types.array(t(types.string))), "Tags")).toBe(
      "from __future__ import annotations\n\nTags = list[str]\n",
    )
  })

  test("array of objects promotes the element to a named msgspec.Struct class", () => {
    const ref = t(types.object({ items: t(types.array(t(types.object({ id: t(types.string) })))) }))
    expect(toMsgspec(ref, "Basket")).toBe(
      [
        "from __future__ import annotations",
        "import msgspec",
        "",
        "class Items(msgspec.Struct):",
        "    id: str",
        "",
        "class Basket(msgspec.Struct):",
        "    items: list[Items]",
        "",
      ].join("\n"),
    )
  })

  test("tuple", () => {
    expect(toMsgspec(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toBe(
      "from __future__ import annotations\n\nPair = tuple[str, int]\n",
    )
  })

  test("dict with string key", () => {
    expect(toMsgspec(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
      "from __future__ import annotations\n\nCounts = dict[str, int]\n",
    )
  })
})

test("literal", () => {
  expect(toMsgspec(t(types.literal("active")), "Status")).toBe(
    'from __future__ import annotations\nfrom typing import Literal\n\nStatus = Literal["active"]\n',
  )
})

test("ref renders as the bare target name", () => {
  expect(toMsgspec(t(types.ref("User")), "Alias")).toBe("from __future__ import annotations\n\nAlias = User\n")
})

test("unknown kind fallback maps to Any", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toMsgspec(ref, "Mystery")).toBe("from __future__ import annotations\nfrom typing import Any\n\nMystery = Any\n")
})
