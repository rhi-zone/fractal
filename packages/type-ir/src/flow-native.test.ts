import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { toFlow, toFlowType } from "./flow-native.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toFlowType(t(types.boolean))).toBe("boolean")
  })

  test("number", () => {
    expect(toFlowType(t(types.number))).toBe("number")
  })

  test("string", () => {
    expect(toFlowType(t(types.string))).toBe("string")
  })

  test("null", () => {
    expect(toFlowType(t(types.null))).toBe("null")
  })

  test("void", () => {
    expect(toFlowType(t(types.void))).toBe("void")
  })

  test("unknown becomes mixed", () => {
    expect(toFlowType(t(types.unknown))).toBe("mixed")
  })

  test("never becomes empty", () => {
    expect(toFlowType(t(types.never))).toBe("empty")
  })
})

describe("mixed fallback", () => {
  test("unrecognized kind falls back to mixed", () => {
    const ref = { shape: { kind: "bogus" } as never, meta: {} }
    expect(toFlowType(ref)).toBe("mixed")
  })
})

describe("exact object types", () => {
  test("object defaults to Flow's exact object syntax", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.number) }))
    expect(toFlowType(ref)).toBe("{| name: string, age: number |}")
  })

  test("meta.exact: false renders an inexact object type", () => {
    const ref = t(types.object({ name: t(types.string) }), { exact: false })
    expect(toFlowType(ref)).toBe("{ name: string }")
  })

  test("optional field uses ?: on the property, not a nullable union", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.number, { optional: true }) }))
    expect(toFlowType(ref)).toBe("{| name: string, age?: number |}")
  })

  test("readonly field uses Flow's covariant + marker", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    expect(toFlowType(ref)).toBe("{| +id: string |}")
  })

  test("readonly optional field combines + and ?", () => {
    const ref = t(types.object({ id: t(types.string, { optional: true, readonly: true }) }))
    expect(toFlowType(ref)).toBe("{| +id?: string |}")
  })
})

describe("array", () => {
  test("plain array uses Array<T>", () => {
    expect(toFlowType(t(types.array(t(types.string))))).toBe("Array<string>")
  })

  test("readonly array uses $ReadOnlyArray<T>", () => {
    expect(toFlowType(t(types.array(t(types.string)), { readonly: true }))).toBe("$ReadOnlyArray<string>")
  })

  test("array of object", () => {
    const ref = t(types.array(t(types.object({ id: t(types.string) }))))
    expect(toFlowType(ref)).toBe("Array<{| id: string |}>")
  })
})

test("tuple", () => {
  const ref = t(types.tuple([t(types.string), t(types.number)]))
  expect(toFlowType(ref)).toBe("[string, number]")
})

describe("map", () => {
  test("string-keyed map renders as an indexer object type", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toFlowType(ref)).toBe("{ [key: string]: number }")
  })

  test("non-string-keyed map still uses the indexer form", () => {
    const ref = t(types.map(t(types.number), t(types.string)))
    expect(toFlowType(ref)).toBe("{ [key: number]: string }")
  })
})

describe("enum", () => {
  test("renders as a union of string literals", () => {
    expect(toFlowType(t(types.enum(["a", "b", "c"])))).toBe('"a" | "b" | "c"')
  })
})

describe("nullable vs optional", () => {
  test("nullable renders as a prefix maybe-type", () => {
    expect(toFlowType(t(types.string, { nullable: true }))).toBe("?string")
  })

  test("optional object field renders as ?: on the property, independent of nullable", () => {
    const ref = t(types.object({ name: t(types.string, { optional: true }) }))
    expect(toFlowType(ref)).toBe("{| name?: string |}")
  })

  test("nullable field inside an object combines ?: and the maybe-type", () => {
    const ref = t(types.object({ name: t(types.string, { optional: true, nullable: true }) }))
    expect(toFlowType(ref)).toBe("{| name?: ?string |}")
  })

  test("nullable union wraps in parens to keep maybe-ness over the whole type", () => {
    const ref = t(types.union([t(types.string), t(types.number)]), { nullable: true })
    expect(toFlowType(ref)).toBe("?(string | number)")
  })
})

describe("union", () => {
  test("plain union", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    expect(toFlowType(ref)).toBe("string | number")
  })
})

test("literal string", () => {
  expect(toFlowType(t(types.literal("active")))).toBe('"active"')
})

test("literal number", () => {
  expect(toFlowType(t(types.literal(42)))).toBe("42")
})

test("ref", () => {
  expect(toFlowType(t(types.ref("User")))).toBe("User")
})

test("intersection", () => {
  const ref = t(
    types.intersection([t(types.object({ id: t(types.string) })), t(types.object({ createdAt: t(types.string) }))]),
  )
  expect(toFlowType(ref)).toBe("{| id: string |} & {| createdAt: string |}")
})

test("branded string emits an intersection with a __brand tag", () => {
  expect(toFlowType(t(types.string, { brand: "LocationId" }))).toBe(
    'string & {| +__brand: "LocationId" |}',
  )
})

describe("function", () => {
  test("emits a Flow function-type expression", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toFlowType(ref)).toBe("(x: number) => string")
  })
})

describe("interface", () => {
  test("emits method-signature syntax", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
      }),
    )
    expect(toFlowType(ref)).toBe("{ deposit(amount: number): void }")
  })
})

describe("toFlow with a name", () => {
  test("emits the @flow pragma and an export type declaration", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toFlow(ref, "User")).toBe("// @flow\nexport type User = {| id: string |};")
  })

  test("without a name returns the bare type expression", () => {
    expect(toFlow(t(types.string))).toBe("string")
  })

  test("includes a doc comment when meta.description is set", () => {
    const ref = t(types.string, { description: "A display name" })
    expect(toFlow(ref, "DisplayName")).toBe("// @flow\n/** A display name */\nexport type DisplayName = string;")
  })
})
