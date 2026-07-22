import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toHaskell, toHaskellModule, toHaskellType } from "./haskell.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toHaskellType(t(types.boolean))).toBe("Bool")
  })
  test("number", () => {
    expect(toHaskellType(t(types.number))).toBe("Double")
  })
  test("integer", () => {
    expect(toHaskellType(t(types.integer))).toBe("Int")
  })
  test("string", () => {
    expect(toHaskellType(t(types.string))).toBe("Text")
  })
  test("null", () => {
    expect(toHaskellType(t(types.null))).toBe("()")
  })
  test("unknown", () => {
    expect(toHaskellType(t(types.unknown))).toBe("Value")
  })
  test("never", () => {
    expect(toHaskellType(t(types.never))).toBe("Void")
  })
})

describe("numeric subtypes", () => {
  test("int32", () => {
    expect(toHaskellType(int32())).toBe("Int32")
  })
  test("int64", () => {
    expect(toHaskellType(int64())).toBe("Int64")
  })
  test("float32", () => {
    expect(toHaskellType(float32())).toBe("Float")
  })
  test("float64", () => {
    expect(toHaskellType(float64())).toBe("Double")
  })
})

describe("string subtypes and bytes", () => {
  test("uuid", () => {
    expect(toHaskellType(uuid())).toBe("Text")
  })
  test("uri", () => {
    expect(toHaskellType(uri())).toBe("Text")
  })
  test("email", () => {
    expect(toHaskellType(email())).toBe("Text")
  })
  test("time", () => {
    expect(toHaskellType(time())).toBe("TimeOfDay")
  })
  test("duration", () => {
    expect(toHaskellType(duration())).toBe("NominalDiffTime")
  })
  test("bytes", () => {
    expect(toHaskellType(bytes())).toBe("ByteString")
  })
})

describe("Date-domain kinds", () => {
  test("datetime", () => {
    expect(toHaskellType(datetime())).toBe("UTCTime")
  })
  test("date", () => {
    expect(toHaskellType(date())).toBe("Day")
  })
})

describe("containers", () => {
  test("array of string", () => {
    expect(toHaskellType(t(types.array(t(types.string))))).toBe("[Text]")
  })

  test("array with meta.vector uses Vector", () => {
    const ref = t(types.array(t(types.integer)), { vector: true })
    expect(toHaskellType(ref)).toBe("Vector Int")
  })

  test("tuple", () => {
    expect(toHaskellType(t(types.tuple([t(types.string), t(types.integer)])))).toBe("(Text, Int)")
  })

  test("map with string key", () => {
    expect(toHaskellType(t(types.map(t(types.string), t(types.integer))))).toBe("Map Text Int")
  })

  test("map with meta.hashMap uses HashMap", () => {
    const ref = t(types.map(t(types.string), t(types.integer)), { hashMap: true })
    expect(toHaskellType(ref)).toBe("HashMap Text Int")
  })
})

describe("optional / nullable", () => {
  test("optional wraps in Maybe", () => {
    expect(toHaskellType(t(types.string, { optional: true }))).toBe("Maybe Text")
  })

  test("nullable wraps in Maybe", () => {
    expect(toHaskellType(t(types.string, { nullable: true }))).toBe("Maybe Text")
  })

  test("optional array wraps whole array in Maybe with parens", () => {
    expect(toHaskellType(t(types.array(t(types.string)), { optional: true }))).toBe("Maybe [Text]")
  })

  test("optional map wraps in Maybe with parens", () => {
    const ref = t(types.map(t(types.string), t(types.integer)), { optional: true })
    expect(toHaskellType(ref)).toBe("Maybe (Map Text Int)")
  })
})

describe("ref", () => {
  test("renders target name, capitalized", () => {
    expect(toHaskellType(t(types.ref("user")))).toBe("User")
  })
})

describe("literal (lossy degrade)", () => {
  test("string literal degrades to Text", () => {
    expect(toHaskellType(t(types.literal("active")))).toBe("Text")
  })
  test("number literal degrades to Int", () => {
    expect(toHaskellType(t(types.literal(42)))).toBe("Int")
  })
  test("boolean literal degrades to Bool", () => {
    expect(toHaskellType(t(types.literal(true)))).toBe("Bool")
  })
})

describe("toHaskell: object -> record", () => {
  test("simple record with required and optional fields", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    const out = toHaskell(ref, "Person")

    expect(out).toContain("data Person = Person")
    expect(out).toContain("{ personName :: Text")
    expect(out).toContain(", personAge :: Maybe Int")
    expect(out).toContain("} deriving (Show, Eq, Generic)")
    expect(out).toContain("personFieldLabel :: String -> String")
    expect(out).toContain("personFieldLabel s = case drop 6 s of")
    expect(out).toContain("instance ToJSON Person where")
    expect(out).toContain("toJSON = genericToJSON defaultOptions { fieldLabelModifier = personFieldLabel }")
    expect(out).toContain("instance FromJSON Person where")
    expect(out).toContain("parseJSON = genericParseJSON defaultOptions { fieldLabelModifier = personFieldLabel }")
  })

  test("empty object", () => {
    const out = toHaskell(t(types.object({})), "Empty")
    expect(out).toContain("data Empty = Empty\n  deriving (Show, Eq, Generic)")
  })

  test("nested object field is hoisted as a sibling record declaration", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toHaskell(ref, "Person")

    // Nested decl (PersonAddress) appears before the outer one (Person).
    const addressIndex = out.indexOf("data PersonAddress")
    const personIndex = out.indexOf("data Person = Person")
    expect(addressIndex).toBeGreaterThanOrEqual(0)
    expect(personIndex).toBeGreaterThan(addressIndex)
    expect(out).toContain("personAddressCity :: Text")
    expect(out).toContain("personAddress :: PersonAddress")
  })

  test("array of nested objects hoists the element type", () => {
    const ref = t(
      types.object({
        pets: t(types.array(t(types.object({ name: t(types.string) })))),
      }),
    )
    const out = toHaskell(ref, "Person")
    expect(out).toContain("data PersonPets = PersonPets")
    expect(out).toContain("personPets :: [PersonPets]")
  })
})

describe("toHaskell: enum -> sum type of nullary constructors", () => {
  test("basic enum with custom ToJSON/FromJSON", () => {
    const ref = t(types.enum(["active", "inactive", "pending"]))
    const out = toHaskell(ref, "Status")

    expect(out).toContain("data Status\n  = StatusActive\n  | StatusInactive\n  | StatusPending\n  deriving (Show, Eq, Generic)")
    expect(out).toContain('instance ToJSON Status where')
    expect(out).toContain('toJSON StatusActive = String "active"')
    expect(out).toContain('toJSON StatusInactive = String "inactive"')
    expect(out).toContain("instance FromJSON Status where")
    expect(out).toContain('parseJSON = withText "Status" $ \\t -> case t of')
    expect(out).toContain('"active" -> pure StatusActive')
    expect(out).toContain('other -> fail ("Unknown Status value: " ++ T.unpack other)')
  })
})

describe("toHaskell: plain union -> untagged sum type", () => {
  test("union of scalars uses positional constructors and <|> parsing", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    const out = toHaskell(ref, "StringOrInt")

    expect(out).toContain("data StringOrInt")
    expect(out).toContain("= StringOrIntString Text")
    expect(out).toContain("| StringOrIntInteger Int")
    expect(out).toContain("deriving (Show, Eq, Generic)")
    expect(out).toContain("instance ToJSON StringOrInt where")
    expect(out).toContain("toJSON (StringOrIntString v) = toJSON v")
    expect(out).toContain("toJSON (StringOrIntInteger v) = toJSON v")
    expect(out).toContain("instance FromJSON StringOrInt where")
    expect(out).toContain("(StringOrIntString <$> parseJSON v)")
    expect(out).toContain("<|> (StringOrIntInteger <$> parseJSON v)")
  })
})

describe("toHaskell: discriminated union -> tagged sum type of records", () => {
  test("shape example", () => {
    const ref = withMeta(
      t(
        types.union([
          t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) })),
          t(types.object({ kind: t(types.literal("square")), side: t(types.number) })),
        ]),
      ),
      { discriminator: "kind" },
    )
    const out = toHaskell(ref, "Shape")

    expect(out).toContain("data Shape")
    expect(out).toContain("= ShapeCircle { shapeCircleRadius :: Double }")
    expect(out).toContain("| ShapeSquare { shapeSquareSide :: Double }")
    expect(out).toContain("deriving (Show, Eq, Generic)")

    expect(out).toContain("instance ToJSON Shape where")
    expect(out).toContain(
      'toJSON (ShapeCircle{..}) = object ["kind" .= ("circle" :: Text), "radius" .= shapeCircleRadius]',
    )
    expect(out).toContain(
      'toJSON (ShapeSquare{..}) = object ["kind" .= ("square" :: Text), "side" .= shapeSquareSide]',
    )

    expect(out).toContain("instance FromJSON Shape where")
    expect(out).toContain('parseJSON = withObject "Shape" $ \\o -> do')
    expect(out).toContain('tag <- o .: "kind"')
    expect(out).toContain('"circle" -> ShapeCircle <$> o .: "radius"')
    expect(out).toContain('"square" -> ShapeSquare <$> o .: "side"')
    expect(out).toContain('other -> fail ("Unknown Shape tag: " ++ T.unpack other)')
  })
})

describe("toHaskell: default name", () => {
  test("falls back to meta.typeName then \"T\"", () => {
    expect(toHaskell(t(types.object({ id: t(types.string) })))).toContain("data T = T")
    expect(
      toHaskell(t(types.object({ id: t(types.string) }), { typeName: "widget" })),
    ).toContain("data Widget = Widget")
  })
})

describe("toHaskellModule", () => {
  test("renders module header + every registry entry", () => {
    const out = toHaskellModule("MyApp.Types", {
      Person: t(types.object({ name: t(types.string) })),
      Status: t(types.enum(["active", "inactive"])),
    })

    expect(out).toContain("module MyApp.Types where")
    expect(out).toContain("import Data.Aeson")
    expect(out).toContain("data Person = Person")
    expect(out).toContain("data Status")
  })
})
