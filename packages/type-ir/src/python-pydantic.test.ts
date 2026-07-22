import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes } from "./kinds/bytes.ts"
import { toPython } from "./python-dataclass.ts"
import { toPydantic } from "./python-pydantic.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toPydantic(t(types.boolean), "Flag")).toBe("from __future__ import annotations\n\nFlag = bool\n")
  })

  test("number maps to float", () => {
    expect(toPydantic(t(types.number), "Amount")).toBe("from __future__ import annotations\n\nAmount = float\n")
  })

  test("integer maps to int", () => {
    expect(toPydantic(t(types.integer), "Count")).toBe("from __future__ import annotations\n\nCount = int\n")
  })

  test("string maps to str", () => {
    expect(toPydantic(t(types.string), "Name")).toBe("from __future__ import annotations\n\nName = str\n")
  })

  test("bytes maps to bytes", () => {
    expect(toPydantic(bytes(), "Blob")).toBe("from __future__ import annotations\n\nBlob = bytes\n")
  })

  test("null maps to None", () => {
    expect(toPydantic(t(types.null), "Nothing")).toBe("from __future__ import annotations\n\nNothing = None\n")
  })

  test("unknown maps to Any and imports it", () => {
    expect(toPydantic(t(types.unknown), "Anything")).toBe(
      "from __future__ import annotations\nfrom typing import Any\n\nAnything = Any\n",
    )
  })
})

describe("basic BaseModel generation", () => {
  test("emits a BaseModel with required fields, in source order", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toPydantic(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "from pydantic import BaseModel",
        "",
        "class User(BaseModel):",
        "    id: str",
        "    age: int",
        "",
      ].join("\n"),
    )
  })

  test("empty object emits pass", () => {
    expect(toPydantic(t(types.object({})), "Empty")).toBe(
      ["from __future__ import annotations", "from pydantic import BaseModel", "", "class Empty(BaseModel):", "    pass", ""].join(
        "\n",
      ),
    )
  })

  test("nested object field is promoted to its own BaseModel named from the field", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }))
    expect(toPydantic(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "from pydantic import BaseModel",
        "",
        "class Address(BaseModel):",
        "    city: str",
        "",
        "class User(BaseModel):",
        "    address: Address",
        "",
      ].join("\n"),
    )
  })

  test("field order is preserved even when an optional field precedes a required one", () => {
    // Unlike python-dataclass.ts, Pydantic's generated __init__ takes a
    // single **data param, so there's no positional-default ordering
    // constraint to work around — source order is kept as-is.
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
        name: t(types.string),
      }),
    )
    const out = toPydantic(ref, "Person")
    const nicknameIdx = out.indexOf("    nickname:")
    const nameIdx = out.indexOf("    name:")
    expect(nicknameIdx).toBeGreaterThan(-1)
    expect(nameIdx).toBeGreaterThan(nicknameIdx)
  })
})

describe("validation constraints", () => {
  test("string length + pattern become Field(...) via Annotated", () => {
    const ref = t(
      types.object({
        username: t(types.string, { minLength: 3, maxLength: 20, pattern: "^[a-z]+$" }),
      }),
    )
    const out = toPydantic(ref, "Account")
    expect(out).toContain("from pydantic import BaseModel, Field")
    expect(out).toContain("from typing import Annotated")
    expect(out).toContain(
      '    username: Annotated[str, Field(min_length=3, max_length=20, pattern="^[a-z]+$")]',
    )
  })

  test("numeric bounds become ge/le/gt/lt", () => {
    const ref = t(
      types.object({
        score: t(types.integer, { minimum: 0, maximum: 100 }),
        ratio: t(types.number, { exclusiveMinimum: 0, exclusiveMaximum: 1 }),
      }),
    )
    const out = toPydantic(ref, "Result")
    expect(out).toContain("score: Annotated[int, Field(ge=0, le=100)]")
    expect(out).toContain("ratio: Annotated[float, Field(gt=0, lt=1)]")
  })

  test("multipleOf becomes multiple_of", () => {
    const ref = t(types.object({ amount: t(types.integer, { multipleOf: 5 }) }))
    expect(toPydantic(ref, "Order")).toContain("amount: Annotated[int, Field(multiple_of=5)]")
  })

  test("description and deprecated become Field kwargs", () => {
    const ref = t(
      types.object({
        legacyId: t(types.string, { description: "old identifier", deprecated: true }),
      }),
    )
    const out = toPydantic(ref, "Widget")
    expect(out).toContain('legacyId: Annotated[str, Field(description="old identifier", deprecated=True)]')
  })

  test("field-level readonly becomes Field(frozen=True)", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    expect(toPydantic(ref, "Record")).toContain("id: Annotated[str, Field(frozen=True)]")
  })

  test("meta.default renders as the field's assignment default", () => {
    const ref = t(types.object({ role: t(types.string, { default: "member" }) }))
    const out = toPydantic(ref, "Account")
    expect(out).toContain('    role: str = "member"')
  })

  test("unrecognized meta keys surface as a @field_validator stub", () => {
    const ref = t(types.object({ email: t(types.string, { format: "email" }) }))
    const out = toPydantic(ref, "Contact")
    expect(out).toContain("from pydantic import BaseModel, field_validator")
    expect(out).toContain('    @field_validator("email")')
    expect(out).toContain("    @classmethod")
    expect(out).toContain('unmodeled validation metadata on "email": format')
  })

  test("unrecognized meta keys on the object itself surface as a @model_validator stub", () => {
    const ref = t(types.object({ a: t(types.string) }), { crossFieldRule: "a != b" })
    const out = toPydantic(ref, "Thing")
    expect(out).toContain("from pydantic import BaseModel, model_validator")
    expect(out).toContain('@model_validator(mode="after")')
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
    expect(toPydantic(ref, "Person")).toBe(
      [
        "from __future__ import annotations",
        "from pydantic import BaseModel",
        "",
        "class Person(BaseModel):",
        "    name: str",
        "    nickname: str | None = None",
        "",
      ].join("\n"),
    )
  })

  test("nullable field renders T | None without a default", () => {
    const ref = t(types.object({ note: t(types.string, { nullable: true }) }))
    const out = toPydantic(ref, "Entry")
    expect(out).toContain("    note: str | None\n")
    expect(out).not.toContain("note: str | None = None")
  })

  test("optional and nullable field only wraps | None once", () => {
    const ref = t(types.object({ note: t(types.string, { optional: true, nullable: true }) }))
    const out = toPydantic(ref, "Entry")
    expect(out).toContain("    note: str | None = None")
    expect(out).not.toContain("str | None | None")
  })
})

describe("enums", () => {
  test("emits a string-backed Enum for JSON serialization", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toPydantic(ref, "Status")).toBe(
      [
        "from __future__ import annotations",
        "from enum import Enum",
        "",
        "class StatusEnum(str, Enum):",
        '    ACTIVE = "active"',
        '    INACTIVE = "inactive"',
        "",
      ].join("\n"),
    )
  })

  test("enum member with non-identifier characters is sanitized", () => {
    const ref = t(types.enum(["in-progress"]))
    expect(toPydantic(ref, "State")).toBe(
      [
        "from __future__ import annotations",
        "from enum import Enum",
        "",
        "class StateEnum(str, Enum):",
        '    IN_PROGRESS = "in-progress"',
        "",
      ].join("\n"),
    )
  })
})

describe("unions", () => {
  test("plain union renders as Union[T1, T2]", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toPydantic(ref, "Id")).toBe(
      "from __future__ import annotations\nfrom typing import Union\n\nId = Union[str, int]\n",
    )
  })

  test("union of duplicate-rendering variants collapses to a single type", () => {
    const ref = t(types.union([t(types.string), t(types.string)]))
    expect(toPydantic(ref, "Name")).toBe("from __future__ import annotations\n\nName = str\n")
  })

  test("discriminated union renders Annotated[Union[...], Discriminator(...)]", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "kind" })
    const out = toPydantic(ref, "Shape")
    expect(out).toContain("from pydantic import BaseModel, Discriminator")
    expect(out).toContain("from typing import Annotated")
    expect(out).toContain('Shape = Annotated[Union[ShapeVariant1, ShapeVariant2], Discriminator("kind")]')
  })

  test("discriminated union field inside an object carries the same Discriminator wrapper", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const shapeUnion = t(types.union([circle, square]), { discriminator: "kind" })
    const ref = t(types.object({ shape: shapeUnion }))
    const out = toPydantic(ref, "Container")
    expect(out).toContain('shape: Annotated[Union[ShapeVariant1, ShapeVariant2], Discriminator("kind")]')
  })
})

describe("collections", () => {
  test("array of string", () => {
    expect(toPydantic(t(types.array(t(types.string))), "Tags")).toBe(
      "from __future__ import annotations\n\nTags = list[str]\n",
    )
  })

  test("array of objects promotes the element to a named BaseModel", () => {
    const ref = t(types.object({ items: t(types.array(t(types.object({ id: t(types.string) })))) }))
    expect(toPydantic(ref, "Basket")).toBe(
      [
        "from __future__ import annotations",
        "from pydantic import BaseModel",
        "",
        "class Items(BaseModel):",
        "    id: str",
        "",
        "class Basket(BaseModel):",
        "    items: list[Items]",
        "",
      ].join("\n"),
    )
  })

  test("tuple", () => {
    expect(toPydantic(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toBe(
      "from __future__ import annotations\n\nPair = tuple[str, int]\n",
    )
  })

  test("dict with string key", () => {
    expect(toPydantic(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
      "from __future__ import annotations\n\nCounts = dict[str, int]\n",
    )
  })
})

test("literal", () => {
  expect(toPydantic(t(types.literal("active")), "Status")).toBe(
    'from __future__ import annotations\nfrom typing import Literal\n\nStatus = Literal["active"]\n',
  )
})

test("ref renders as the bare target name", () => {
  expect(toPydantic(t(types.ref("User")), "Alias")).toBe("from __future__ import annotations\n\nAlias = User\n")
})

test("unknown kind fallback maps to Any", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toPydantic(ref, "Mystery")).toBe("from __future__ import annotations\nfrom typing import Any\n\nMystery = Any\n")
})

describe("model_config", () => {
  test("object-level readonly becomes model_config = ConfigDict(frozen=True)", () => {
    const ref = t(types.object({ id: t(types.string) }), { readonly: true })
    const out = toPydantic(ref, "Snapshot")
    expect(out).toContain("from pydantic import BaseModel, ConfigDict")
    expect(out).toContain("class Snapshot(BaseModel):")
    expect(out).toContain("    model_config = ConfigDict(frozen=True)")
  })

  test("object-level description becomes the class docstring", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A user record." })
    const out = toPydantic(ref, "User")
    expect(out).toContain('    "A user record."')
  })
})

describe("comparison with dataclass output", () => {
  test("dataclass reorders optional-after-required; pydantic keeps source order", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
        name: t(types.string),
      }),
    )
    const dataclassOut = toPython(ref, "Person")
    const pydanticOut = toPydantic(ref, "Person")
    // dataclass: nickname (optional) is pushed after name.
    expect(dataclassOut.indexOf("nickname")).toBeGreaterThan(dataclassOut.indexOf("name: str"))
    // pydantic: source order preserved, nickname stays first.
    expect(pydanticOut.indexOf("nickname")).toBeLessThan(pydanticOut.indexOf("name: str"))
  })

  test("dataclass emits @dataclass + Optional[T]; pydantic emits BaseModel + T | None", () => {
    const ref = t(types.object({ note: t(types.string, { optional: true }) }))
    const dataclassOut = toPython(ref, "Entry")
    const pydanticOut = toPydantic(ref, "Entry")
    expect(dataclassOut).toContain("@dataclass")
    expect(dataclassOut).toContain("Optional[str] = None")
    expect(pydanticOut).toContain("class Entry(BaseModel):")
    expect(pydanticOut).toContain("note: str | None = None")
  })

  test("dataclass enum is plain Enum; pydantic enum is str-backed", () => {
    const ref = t(types.enum(["a", "b"]))
    const dataclassOut = toPython(ref, "Choice")
    const pydanticOut = toPydantic(ref, "Choice")
    expect(dataclassOut).toContain("class ChoiceEnum(Enum):")
    expect(pydanticOut).toContain("class ChoiceEnum(str, Enum):")
  })
})
