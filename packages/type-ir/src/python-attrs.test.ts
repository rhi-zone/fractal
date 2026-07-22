import { describe, expect, test } from "bun:test"
import { toAttrs } from "./python-attrs.ts"
import { toPython } from "./python-dataclass.ts"
import { bytes } from "./kinds/bytes.ts"
import { t, types } from "./index.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toAttrs(t(types.boolean), "Flag")).toBe("from __future__ import annotations\n\nFlag = bool\n")
  })

  test("number maps to float", () => {
    expect(toAttrs(t(types.number), "Amount")).toBe("from __future__ import annotations\n\nAmount = float\n")
  })

  test("integer maps to int", () => {
    expect(toAttrs(t(types.integer), "Count")).toBe("from __future__ import annotations\n\nCount = int\n")
  })

  test("string maps to str", () => {
    expect(toAttrs(t(types.string), "Name")).toBe("from __future__ import annotations\n\nName = str\n")
  })

  test("bytes maps to bytes", () => {
    expect(toAttrs(bytes(), "Blob")).toBe("from __future__ import annotations\n\nBlob = bytes\n")
  })

  test("null maps to None", () => {
    expect(toAttrs(t(types.null), "Nothing")).toBe("from __future__ import annotations\n\nNothing = None\n")
  })

  test("unknown maps to Any and imports it", () => {
    expect(toAttrs(t(types.unknown), "Anything")).toBe(
      "from __future__ import annotations\nfrom typing import Any\n\nAnything = Any\n",
    )
  })
})

describe("basic attrs class generation", () => {
  test("emits an attrs.define class with required fields, in source order", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toAttrs(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "import attrs",
        "",
        "@attrs.define()",
        "class User:",
        "    id: str",
        "    age: int",
        "",
      ].join("\n"),
    )
  })

  test("empty object emits pass", () => {
    expect(toAttrs(t(types.object({})), "Empty")).toBe(
      ["from __future__ import annotations", "import attrs", "", "@attrs.define()", "class Empty:", "    pass", ""].join("\n"),
    )
  })

  test("nested object field is promoted to its own attrs class named from the field", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }))
    expect(toAttrs(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "import attrs",
        "",
        "@attrs.define()",
        "class Address:",
        "    city: str",
        "",
        "@attrs.define()",
        "class User:",
        "    address: Address",
        "",
      ].join("\n"),
    )
  })

  test("field order is preserved even when an optional field precedes a required one", () => {
    // Unlike python-dataclass.ts, attrs (like Pydantic) has no positional-
    // before-keyword-default ordering constraint this generator needs to
    // work around — source order is kept as-is.
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
        name: t(types.string),
      }),
    )
    const out = toAttrs(ref, "Person")
    const nicknameIdx = out.indexOf("    nickname:")
    const nameIdx = out.indexOf("    name:")
    expect(nicknameIdx).toBeGreaterThan(-1)
    expect(nameIdx).toBeGreaterThan(nicknameIdx)
  })
})

describe("validation constraints", () => {
  test("string length + pattern become attrs.validators chained with and_", () => {
    const ref = t(
      types.object({
        username: t(types.string, { minLength: 3, maxLength: 20, pattern: "^[a-z]+$" }),
      }),
    )
    const out = toAttrs(ref, "Account")
    expect(out).toContain("import attrs")
    expect(out).toContain(
      '    username: str = attrs.field(validator=attrs.validators.and_(attrs.validators.min_len(3), attrs.validators.max_len(20), attrs.validators.matches_re("^[a-z]+$")))',
    )
  })

  test("numeric bounds become ge/le/gt/lt validators", () => {
    const ref = t(
      types.object({
        score: t(types.integer, { minimum: 0, maximum: 100 }),
        ratio: t(types.number, { exclusiveMinimum: 0, exclusiveMaximum: 1 }),
      }),
    )
    const out = toAttrs(ref, "Result")
    expect(out).toContain(
      "score: int = attrs.field(validator=attrs.validators.and_(attrs.validators.ge(0), attrs.validators.le(100)))",
    )
    expect(out).toContain(
      "ratio: float = attrs.field(validator=attrs.validators.and_(attrs.validators.gt(0), attrs.validators.lt(1)))",
    )
  })

  test("a single constraint needs no and_ wrapper", () => {
    const ref = t(types.object({ score: t(types.integer, { minimum: 0 }) }))
    const out = toAttrs(ref, "Result")
    expect(out).toContain("score: int = attrs.field(validator=attrs.validators.ge(0))")
    expect(out).not.toContain("and_")
  })

  test("multipleOf has no built-in attrs validator, so it surfaces as an unmodeled-metadata stub", () => {
    const ref = t(types.object({ amount: t(types.integer, { multipleOf: 5 }) }))
    const out = toAttrs(ref, "Order")
    expect(out).toContain("def _validate_amount(instance: object, attribute: object, value: object) -> None:")
    expect(out).toContain('unmodeled validation metadata on "amount": multipleOf')
    expect(out).toContain("amount: int = attrs.field(validator=_validate_amount)")
  })

  test("description and deprecated become attrs.field metadata kwargs", () => {
    const ref = t(
      types.object({
        legacyId: t(types.string, { description: "old identifier", deprecated: true }),
      }),
    )
    const out = toAttrs(ref, "Widget")
    expect(out).toContain('legacyId: str = attrs.field(metadata={"description": "old identifier", "deprecated": True})')
  })

  test("field-level readonly becomes attrs.field(on_setattr=attrs.setters.frozen)", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    expect(toAttrs(ref, "Record")).toContain("id: str = attrs.field(on_setattr=attrs.setters.frozen)")
  })

  test("meta.default renders as a plain class-body assignment for immutable values", () => {
    const ref = t(types.object({ role: t(types.string, { default: "member" }) }))
    const out = toAttrs(ref, "Account")
    expect(out).toContain('    role: str = "member"')
    expect(out).not.toContain("attrs.field")
  })

  test("mutable meta.default uses attrs.field(factory=...) instead of a bare literal", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.string)), { default: ["a", "b"] }) }))
    const out = toAttrs(ref, "Item")
    expect(out).toContain('tags: list[str] = attrs.field(factory=lambda: ["a", "b"])')
  })

  test("unrecognized meta keys surface as a standalone validator function wired via validator=", () => {
    const ref = t(types.object({ email: t(types.string, { format: "email" }) }))
    const out = toAttrs(ref, "Contact")
    expect(out).toContain("def _validate_email(instance: object, attribute: object, value: object) -> None:")
    expect(out).toContain('unmodeled validation metadata on "email": format')
    expect(out).toContain("email: str = attrs.field(validator=_validate_email)")
  })

  test("unrecognized meta keys on the object itself surface as an __attrs_post_init__ stub", () => {
    const ref = t(types.object({ a: t(types.string) }), { crossFieldRule: "a != b" })
    const out = toAttrs(ref, "Thing")
    expect(out).toContain("def __attrs_post_init__(self) -> None:")
    expect(out).toContain('unmodeled validation metadata on "Thing": crossFieldRule')
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
    expect(toAttrs(ref, "Person")).toBe(
      [
        "from __future__ import annotations",
        "import attrs",
        "",
        "@attrs.define()",
        "class Person:",
        "    name: str",
        "    nickname: str | None = None",
        "",
      ].join("\n"),
    )
  })

  test("nullable field renders T | None without a default", () => {
    const ref = t(types.object({ note: t(types.string, { nullable: true }) }))
    const out = toAttrs(ref, "Entry")
    expect(out).toContain("    note: str | None\n")
    expect(out).not.toContain("note: str | None = None")
  })

  test("optional and nullable field only wraps | None once", () => {
    const ref = t(types.object({ note: t(types.string, { optional: true, nullable: true }) }))
    const out = toAttrs(ref, "Entry")
    expect(out).toContain("    note: str | None = None")
    expect(out).not.toContain("str | None | None")
  })
})

describe("frozen classes", () => {
  test("object-level readonly becomes @attrs.define(frozen=True)", () => {
    const ref = t(types.object({ id: t(types.string) }), { readonly: true })
    const out = toAttrs(ref, "Snapshot")
    expect(out).toContain("@attrs.define(frozen=True)")
    expect(out).toContain("class Snapshot:")
  })

  test("object-level description becomes the class docstring", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A user record." })
    const out = toAttrs(ref, "User")
    expect(out).toContain('    "A user record."')
  })
})

describe("enums", () => {
  test("emits a plain Enum (not str-backed, unlike pydantic)", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toAttrs(ref, "Status")).toBe(
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
    expect(toAttrs(ref, "State")).toBe(
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
    expect(toAttrs(ref, "Id")).toBe(
      "from __future__ import annotations\nfrom typing import Union\n\nId = Union[str, int]\n",
    )
  })

  test("union of duplicate-rendering variants collapses to a single type", () => {
    const ref = t(types.union([t(types.string), t(types.string)]))
    expect(toAttrs(ref, "Name")).toBe("from __future__ import annotations\n\nName = str\n")
  })

  test("discriminated union renders as a plain Union with a cattrs-hook comment", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "kind" })
    const out = toAttrs(ref, "Shape")
    expect(out).toContain("Shape = Union[ShapeVariant1, ShapeVariant2]  # discriminated by \"kind\"")
    expect(out).toContain("cattrs.register_structure_hook")
  })

  test("discriminated union field inside an object carries the same cattrs-hook comment", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const shapeUnion = t(types.union([circle, square]), { discriminator: "kind" })
    const ref = t(types.object({ shape: shapeUnion }))
    const out = toAttrs(ref, "Container")
    expect(out).toContain('shape: Union[ShapeVariant1, ShapeVariant2]  # discriminated by "kind"')
    expect(out).toContain("cattrs.register_structure_hook")
  })
})

describe("collections", () => {
  test("array of string", () => {
    expect(toAttrs(t(types.array(t(types.string))), "Tags")).toBe(
      "from __future__ import annotations\n\nTags = list[str]\n",
    )
  })

  test("array of objects promotes the element to a named attrs class", () => {
    const ref = t(types.object({ items: t(types.array(t(types.object({ id: t(types.string) })))) }))
    expect(toAttrs(ref, "Basket")).toBe(
      [
        "from __future__ import annotations",
        "import attrs",
        "",
        "@attrs.define()",
        "class Items:",
        "    id: str",
        "",
        "@attrs.define()",
        "class Basket:",
        "    items: list[Items]",
        "",
      ].join("\n"),
    )
  })

  test("tuple", () => {
    expect(toAttrs(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toBe(
      "from __future__ import annotations\n\nPair = tuple[str, int]\n",
    )
  })

  test("dict with string key", () => {
    expect(toAttrs(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
      "from __future__ import annotations\n\nCounts = dict[str, int]\n",
    )
  })
})

test("literal", () => {
  expect(toAttrs(t(types.literal("active")), "Status")).toBe(
    'from __future__ import annotations\nfrom typing import Literal\n\nStatus = Literal["active"]\n',
  )
})

test("ref renders as the bare target name", () => {
  expect(toAttrs(t(types.ref("User")), "Alias")).toBe("from __future__ import annotations\n\nAlias = User\n")
})

test("unknown kind fallback maps to Any", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toAttrs(ref, "Mystery")).toBe("from __future__ import annotations\nfrom typing import Any\n\nMystery = Any\n")
})

describe("comparison with dataclass output", () => {
  test("dataclass reorders optional-after-required; attrs keeps source order", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
        name: t(types.string),
      }),
    )
    const dataclassOut = toPython(ref, "Person")
    const attrsOut = toAttrs(ref, "Person")
    // dataclass: nickname (optional) is pushed after name.
    expect(dataclassOut.indexOf("nickname")).toBeGreaterThan(dataclassOut.indexOf("name: str"))
    // attrs: source order preserved, nickname stays first.
    expect(attrsOut.indexOf("nickname")).toBeLessThan(attrsOut.indexOf("name: str"))
  })

  test("dataclass emits @dataclass + Optional[T]; attrs emits @attrs.define + T | None", () => {
    const ref = t(types.object({ note: t(types.string, { optional: true }) }))
    const dataclassOut = toPython(ref, "Entry")
    const attrsOut = toAttrs(ref, "Entry")
    expect(dataclassOut).toContain("@dataclass")
    expect(dataclassOut).toContain("Optional[str] = None")
    expect(attrsOut).toContain("@attrs.define()")
    expect(attrsOut).toContain("note: str | None = None")
  })

  test("both dataclass and attrs enums are plain Enum (unlike pydantic's str-backed enum)", () => {
    const ref = t(types.enum(["a", "b"]))
    const dataclassOut = toPython(ref, "Choice")
    const attrsOut = toAttrs(ref, "Choice")
    expect(dataclassOut).toContain("class ChoiceEnum(Enum):")
    expect(attrsOut).toContain("class ChoiceEnum(Enum):")
  })
})
