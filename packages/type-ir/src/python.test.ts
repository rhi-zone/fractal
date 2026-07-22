import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { toPython } from "./python.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toPython(t(types.boolean), "Flag")).toBe(
      "from __future__ import annotations\n\nFlag = bool\n",
    )
  })

  test("number maps to float", () => {
    expect(toPython(t(types.number), "Amount")).toBe(
      "from __future__ import annotations\n\nAmount = float\n",
    )
  })

  test("integer maps to int", () => {
    expect(toPython(t(types.integer), "Count")).toBe(
      "from __future__ import annotations\n\nCount = int\n",
    )
  })

  test("string maps to str", () => {
    expect(toPython(t(types.string), "Name")).toBe(
      "from __future__ import annotations\n\nName = str\n",
    )
  })

  test("null maps to None", () => {
    expect(toPython(t(types.null), "Nothing")).toBe(
      "from __future__ import annotations\n\nNothing = None\n",
    )
  })

  test("unknown maps to Any and imports it", () => {
    expect(toPython(t(types.unknown), "Anything")).toBe(
      "from __future__ import annotations\nfrom typing import Any\n\nAnything = Any\n",
    )
  })

  test("never maps to NoReturn and imports it", () => {
    expect(toPython(t(types.never), "Impossible")).toBe(
      "from __future__ import annotations\nfrom typing import NoReturn\n\nImpossible = NoReturn\n",
    )
  })
})

describe("objects", () => {
  test("emits a @dataclass with required fields", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toPython(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class User:",
        "    id: str",
        "    age: int",
        "",
      ].join("\n"),
    )
  })

  test("optional field renders as Optional[T] = None and sorts after required fields", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(toPython(ref, "Person")).toBe(
      [
        "from __future__ import annotations",
        "from dataclasses import dataclass",
        "from typing import Optional",
        "",
        "@dataclass",
        "class Person:",
        "    name: str",
        "    nickname: Optional[str] = None",
        "",
      ].join("\n"),
    )
  })

  test("optional field declared before required field is still reordered after it", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
        name: t(types.string),
      }),
    )
    const out = toPython(ref, "Person")
    const nameIdx = out.indexOf("    name: str")
    const nicknameIdx = out.indexOf("    nickname: Optional[str] = None")
    expect(nameIdx).toBeGreaterThan(-1)
    expect(nicknameIdx).toBeGreaterThan(nameIdx)
  })

  test("nested object field is promoted to its own dataclass named from the field", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    expect(toPython(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class Address:",
        "    city: str",
        "",
        "@dataclass",
        "class User:",
        "    address: Address",
        "",
      ].join("\n"),
    )
  })

  test("empty object emits pass", () => {
    expect(toPython(t(types.object({})), "Empty")).toBe(
      ["from __future__ import annotations", "from dataclasses import dataclass", "", "@dataclass", "class Empty:", "    pass", ""].join(
        "\n",
      ),
    )
  })
})

describe("arrays", () => {
  test("array of string", () => {
    expect(toPython(t(types.array(t(types.string))), "Tags")).toBe(
      "from __future__ import annotations\n\nTags = list[str]\n",
    )
  })

  test("array of objects promotes the element to a named dataclass", () => {
    const ref = t(types.object({ items: t(types.array(t(types.object({ id: t(types.string) })))) }))
    expect(toPython(ref, "Basket")).toBe(
      [
        "from __future__ import annotations",
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class Items:",
        "    id: str",
        "",
        "@dataclass",
        "class Basket:",
        "    items: list[Items]",
        "",
      ].join("\n"),
    )
  })
})

test("tuple", () => {
  expect(toPython(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toBe(
    "from __future__ import annotations\n\nPair = tuple[str, int]\n",
  )
})

test("map with string key", () => {
  expect(toPython(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
    "from __future__ import annotations\n\nCounts = dict[str, int]\n",
  )
})

describe("enums", () => {
  test("emits a class FooEnum(Enum) with string members", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toPython(ref, "Status")).toBe(
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
    expect(toPython(ref, "State")).toBe(
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

  test("nested enum field is promoted to its own <Field>Enum class", () => {
    const ref = t(types.object({ status: t(types.enum(["active", "inactive"])) }))
    expect(toPython(ref, "User")).toBe(
      [
        "from __future__ import annotations",
        "from dataclasses import dataclass",
        "from enum import Enum",
        "",
        "class StatusEnum(Enum):",
        '    ACTIVE = "active"',
        '    INACTIVE = "inactive"',
        "",
        "@dataclass",
        "class User:",
        "    status: StatusEnum",
        "",
      ].join("\n"),
    )
  })
})

describe("unions", () => {
  test("union renders as Union[T1, T2]", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toPython(ref, "Id")).toBe(
      "from __future__ import annotations\nfrom typing import Union\n\nId = Union[str, int]\n",
    )
  })

  test("union of duplicate-rendering variants collapses to a single type", () => {
    const ref = t(types.union([t(types.string), t(types.string)]))
    expect(toPython(ref, "Name")).toBe("from __future__ import annotations\n\nName = str\n")
  })

  test("discriminated union notes the discriminator in a trailing comment", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "kind" })
    const out = toPython(ref, "Shape")
    expect(out).toContain('Shape = Union[ShapeVariant1, ShapeVariant2]  # discriminated by "kind"')
  })

  test("discriminated union field inside an object carries the same comment", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const shapeUnion = t(types.union([circle, square]), { discriminator: "kind" })
    const ref = t(types.object({ shape: shapeUnion }))
    const out = toPython(ref, "Container")
    expect(out).toContain('shape: Union[ShapeVariant1, ShapeVariant2]  # discriminated by "kind"')
  })
})

describe("optional and nullable", () => {
  test("nullable field renders Optional[T] without a default", () => {
    const ref = t(types.object({ note: t(types.string, { nullable: true }) }))
    const out = toPython(ref, "Entry")
    expect(out).toContain("    note: Optional[str]\n")
    expect(out).not.toContain("Optional[str] = None")
  })

  test("optional and nullable field only wraps Optional once", () => {
    const ref = t(types.object({ note: t(types.string, { optional: true, nullable: true }) }))
    const out = toPython(ref, "Entry")
    expect(out).toContain("    note: Optional[str] = None")
    expect(out).not.toContain("Optional[Optional[str]]")
  })
})

test("ref renders as the bare target name", () => {
  expect(toPython(t(types.ref("User")), "Alias")).toBe("from __future__ import annotations\n\nAlias = User\n")
})

test("literal", () => {
  expect(toPython(t(types.literal("active")), "Status")).toBe(
    'from __future__ import annotations\nfrom typing import Literal\n\nStatus = Literal["active"]\n',
  )
})

test("unknown kind fallback maps to Any", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toPython(ref, "Mystery")).toBe(
    "from __future__ import annotations\nfrom typing import Any\n\nMystery = Any\n",
  )
})
