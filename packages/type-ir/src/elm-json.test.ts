import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { toElm, toElmType } from "./elm-json.ts"

describe("primitive types", () => {
  test("boolean", () => {
    expect(toElmType(t(types.boolean))).toBe("Bool")
  })

  test("number -> Float", () => {
    expect(toElmType(t(types.number))).toBe("Float")
  })

  test("integer -> Int", () => {
    expect(toElmType(t(types.integer))).toBe("Int")
  })

  test("string", () => {
    expect(toElmType(t(types.string))).toBe("String")
  })

  test("null -> unit", () => {
    expect(toElmType(t(types.null))).toBe("()")
  })

  test("unknown -> Json.Decode.Value", () => {
    expect(toElmType(t(types.unknown))).toBe("Json.Decode.Value")
  })
})

describe("containers", () => {
  test("array -> List T", () => {
    expect(toElmType(t(types.array(t(types.string))))).toBe("List String")
  })

  test("array of Maybe wraps element in parens", () => {
    const ref = t(types.array(t(types.string, { nullable: true })))
    expect(toElmType(ref)).toBe("List (Maybe String)")
  })

  test("map -> Dict K V", () => {
    expect(toElmType(t(types.map(t(types.string), t(types.number))))).toBe("Dict String Float")
  })

  test("2-tuple", () => {
    expect(toElmType(t(types.tuple([t(types.string), t(types.number)])))).toBe("(String, Float)")
  })

  test("3-tuple", () => {
    const ref = t(types.tuple([t(types.string), t(types.number), t(types.boolean)]))
    expect(toElmType(ref)).toBe("(String, Float, Bool)")
  })

  test("4+ tuple degrades to a positional record", () => {
    const ref = t(types.tuple([t(types.string), t(types.number), t(types.boolean), t(types.string)]))
    expect(toElmType(ref)).toBe("{ field0 : String, field1 : Float, field2 : Bool, field3 : String }")
  })
})

describe("optional and nullable", () => {
  test("nullable wraps in Maybe", () => {
    expect(toElmType(t(types.string, { nullable: true }))).toBe("Maybe String")
  })

  test("optional object field wraps in Maybe", () => {
    const ref = t(types.object({ age: t(types.number, { optional: true }) }))
    expect(toElmType(ref)).toBe("{ age : Maybe Float }")
  })
})

describe("records (type alias)", () => {
  test("required + optional fields", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.number, { optional: true }) }))
    const out = toElm(ref, "User")

    expect(out).toContain("type alias User =\n    { id : String\n    , age : Maybe Float\n    }")
    expect(out).toContain('userDecoder =\n    Decode.succeed User\n        |> andMap (Decode.field "id" Decode.string)\n        |> andMap (Decode.maybe (Decode.field "age" Decode.float))')
    expect(out).toContain(
      'encodeUser value =\n    Encode.object\n        [ ( "id", Encode.string value.id )\n        , ( "age", encodeMaybe (\\v -> Encode.float v) value.age )\n        ]',
    )
    // The shared Maybe-encoding helper is only emitted once, and only when needed.
    expect(out).toContain("encodeMaybe : (a -> Encode.Value) -> Maybe a -> Encode.Value")
  })

  test("no Maybe-field helper emitted when nothing is optional", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toElm(ref, "Id")).not.toContain("encodeMaybe")
  })

  test("field names become camelCase, type name PascalCase", () => {
    const ref = t(types.object({ user_id: t(types.string) }))
    const out = toElm(ref, "account_summary")
    expect(out).toContain("type alias AccountSummary =")
    expect(out).toContain("userId : String")
    expect(out).toContain('Decode.field "user_id" Decode.string')
  })
})

describe("enum -> custom type", () => {
  test("no-arg constructors + string decoder/encoder", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toElm(ref, "Status")

    expect(out).toContain("type Status\n    = Active\n    | Inactive")
    expect(out).toContain("statusDecoder : Decoder Status")
    expect(out).toContain('"active" ->\n                        Decode.succeed Active')
    expect(out).toContain('Decode.fail ("Unknown Status: " ++ str)')
    expect(out).toContain("encodeStatus : Status -> Encode.Value")
    expect(out).toContain('Active ->\n                "active"')
  })
})

describe("string-literal unions render like enums", () => {
  test("union of string literals", () => {
    const ref = t(types.union([t(types.literal("a")), t(types.literal("b"))]))
    const out = toElm(ref, "Letter")
    expect(out).toContain("type Letter\n    = A\n    | B")
    expect(out).toContain('"a" ->\n                        Decode.succeed A')
  })
})

describe("discriminated unions -> tagged custom type", () => {
  test("meta.discriminator picks constructor names from the tag field", () => {
    const ref = t(
      types.union([
        t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) })),
        t(types.object({ kind: t(types.literal("square")), side: t(types.number) })),
      ]),
      { discriminator: "kind" },
    )
    const out = toElm(ref, "Shape")

    expect(out).toContain("type Shape\n    = Circle { radius : Float }\n    | Square { side : Float }")
    expect(out).toContain('Decode.field "kind" Decode.string')
    expect(out).toContain("Decode.succeed (\\radius -> Circle { radius = radius })")
    expect(out).toContain('"circle" ->')
    expect(out).toContain("Circle fields ->")
    expect(out).toContain('( "kind", Encode.string "circle" )')
    expect(out).toContain("( \"radius\", Encode.float fields.radius )")
  })
})

describe("untagged unions fall back to positional constructors", () => {
  test("Decode.oneOf tries each variant in order", () => {
    const ref = t(types.union([t(types.string), t(types.number)]))
    const out = toElm(ref, "StringOrNumber")

    expect(out).toContain("type StringOrNumber\n    = Variant1 String\n    | Variant2 Float")
    expect(out).toContain("Decode.oneOf\n        [ Decode.map Variant1 Decode.string\n        , Decode.map Variant2 Decode.float\n        ]")
    expect(out).toContain("Variant1 value ->\n            Encode.string value")
  })
})

describe("nested enum/union fields are hoisted into their own declaration", () => {
  test("object field referencing an enum hoists a named custom type", () => {
    const status = t(types.enum(["active", "inactive"]))
    const ref = t(types.object({ status }))
    const out = toElm(ref, "Account")

    expect(out).toContain("{ status : AccountStatus\n    }")
    expect(out).toContain('Decode.field "status" accountStatusDecoder')
    expect(out).toContain('( "status", encodeAccountStatus value.status )')
    expect(out).toContain("type AccountStatus\n    = Active\n    | Inactive")
    expect(out).toContain("accountStatusDecoder : Decoder AccountStatus")
    expect(out).toContain("encodeAccountStatus : AccountStatus -> Encode.Value")
  })
})

describe("toElm defaults name to Value", () => {
  test("bare string ref", () => {
    const out = toElm(t(types.string))
    expect(out).toContain("type alias Value = String")
    expect(out).toContain("valueDecoder : Decoder Value")
    expect(out).toContain("valueDecoder =\n    Decode.string")
    expect(out).toContain("encodeValue : Value -> Encode.Value")
  })
})

describe("ref", () => {
  test("references another named decoder/encoder by convention", () => {
    expect(toElmType(t(types.ref("User")))).toBe("User")
  })
})

describe("doc comments", () => {
  test("meta.description -> {-| ... -} above the type alias", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A person." })
    const out = toElm(ref, "Person")
    expect(out.startsWith("{-| A person.\n-}\ntype alias Person =")).toBe(true)
  })

  test("meta.deprecated true adds a **Deprecated.** note", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: true })
    const out = toElm(ref, "Person")
    expect(out.startsWith("{-| **Deprecated.**\n-}\ntype alias Person =")).toBe(true)
  })

  test("meta.deprecated string reason is included", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { deprecated: "use NewPerson instead" })
    const out = toElm(ref, "Person")
    expect(out).toContain("**Deprecated:** use NewPerson instead")
  })

  test("description and deprecated combine in one comment block", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A person.", deprecated: true })
    const out = toElm(ref, "Person")
    expect(out.startsWith("{-| **Deprecated.**\n\nA person.\n-}\ntype alias Person =")).toBe(true)
  })

  test("no description/deprecated -> no doc comment", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const out = toElm(ref, "Person")
    expect(out.startsWith("{-|")).toBe(false)
  })

  test("enum with description", () => {
    const ref = withMeta(t(types.enum(["active", "inactive"])), { description: "Account status." })
    const out = toElm(ref, "Status")
    expect(out.startsWith("{-| Account status.\n-}\ntype Status")).toBe(true)
  })
})
