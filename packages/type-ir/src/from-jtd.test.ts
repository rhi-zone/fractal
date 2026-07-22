import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int8, int16, int32, int64, time, uint8, uint16, uint32, uri, uuid } from "./kinds/common.ts"
import { fromJtd, fromJtdDocument } from "./from-jtd.ts"
import { toJtd } from "./jtd.ts"

describe("empty form", () => {
  test("unknown", () => {
    expect(fromJtd({})).toEqual(t(types.unknown))
  })

  test("nullable-only empty form reads back as null (matches from-json-schema's null/void convention)", () => {
    expect(fromJtd({ nullable: true })).toEqual(t(types.null))
  })
})

describe("type form", () => {
  test("boolean", () => {
    expect(fromJtd({ type: "boolean" })).toEqual(t(types.boolean))
  })

  test("string", () => {
    expect(fromJtd({ type: "string" })).toEqual(t(types.string))
  })

  test("float32 / float64", () => {
    expect(fromJtd({ type: "float32" })).toEqual(float32())
    expect(fromJtd({ type: "float64" })).toEqual(float64())
  })

  test("int8 / uint8 / int16 / uint16 / int32 / uint32", () => {
    expect(fromJtd({ type: "int8" })).toEqual(int8())
    expect(fromJtd({ type: "uint8" })).toEqual(uint8())
    expect(fromJtd({ type: "int16" })).toEqual(int16())
    expect(fromJtd({ type: "uint16" })).toEqual(uint16())
    expect(fromJtd({ type: "int32" })).toEqual(int32())
    expect(fromJtd({ type: "uint32" })).toEqual(uint32())
  })

  test("timestamp maps to datetime", () => {
    expect(fromJtd({ type: "timestamp" })).toEqual(datetime())
  })

  test("string + format metadata recovers uuid/uri/email/time/duration", () => {
    expect(fromJtd({ type: "string", metadata: { format: "uuid" } })).toEqual(uuid())
    expect(fromJtd({ type: "string", metadata: { format: "uri" } })).toEqual(uri())
    expect(fromJtd({ type: "string", metadata: { format: "email" } })).toEqual(email())
    expect(fromJtd({ type: "string", metadata: { format: "time" } })).toEqual(time())
    expect(fromJtd({ type: "string", metadata: { format: "duration" } })).toEqual(duration())
  })

  test("string + contentEncoding: base64 recovers bytes", () => {
    expect(fromJtd({ type: "string", metadata: { contentEncoding: "base64" } })).toEqual(bytes())
  })

  test("unrecognized format is kept as plain string metadata, not guessed", () => {
    expect(fromJtd({ type: "string", metadata: { format: "ipv4" } })).toEqual(t(types.string, { format: "ipv4" }))
  })

  test("metadata.type int64 escape hatch recovers int64", () => {
    expect(fromJtd({ metadata: { type: "int64" } })).toEqual(int64())
  })

  test("unrecognized type name is kept visible, not silently guessed", () => {
    expect(fromJtd({ type: "decimal128" })).toEqual(t(types.string, { jtdType: "decimal128" }))
  })
})

describe("enum form", () => {
  test("enum members", () => {
    expect(fromJtd({ enum: ["a", "b", "c"] })).toEqual(t(types.enum(["a", "b", "c"])))
  })

  test("single-member enum stays an enum (JTD has no separate single-literal form)", () => {
    expect(fromJtd({ enum: ["active"] })).toEqual(t(types.enum(["active"])))
  })
})

describe("elements form", () => {
  test("array", () => {
    expect(fromJtd({ elements: { type: "int32" } })).toEqual(t(types.array(int32())))
  })

  test("metadata.stream recovers stream", () => {
    expect(fromJtd({ elements: { type: "int32" }, metadata: { stream: true } })).toEqual(t(types.stream(int32())))
  })

  test("metadata.tuple recovers a single-element tuple (lossy — toJtd only kept the first member)", () => {
    expect(fromJtd({ elements: { type: "string" }, metadata: { tuple: true } })).toEqual(t(types.tuple([t(types.string)])))
  })
})

describe("properties form", () => {
  test("required and optional fields split from properties/optionalProperties", () => {
    const jtd = {
      properties: { name: { type: "string" } },
      optionalProperties: { nickname: { type: "string" } },
    }
    expect(fromJtd(jtd)).toEqual(
      t(
        types.object({
          name: t(types.string),
          nickname: t(types.string, { optional: true }),
        }),
      ),
    )
  })

  test("empty properties form", () => {
    expect(fromJtd({ properties: {} })).toEqual(t(types.object({})))
  })

  test("additionalProperties: true preserved in meta", () => {
    expect(fromJtd({ properties: { id: { type: "string" } }, additionalProperties: true })).toEqual(
      t(types.object({ id: t(types.string) }), { additionalProperties: true }),
    )
  })
})

describe("values form", () => {
  test("map with string keys", () => {
    expect(fromJtd({ values: { type: "float64" } })).toEqual(t(types.map(t(types.string), float64())))
  })
})

describe("discriminator form", () => {
  test("tagged union reconstructs the discriminator field on each variant", () => {
    const jtd = {
      discriminator: "eventType",
      mapping: {
        push: { properties: { commits: { type: "int32" } } },
        pull_request: { properties: { number: { type: "int32" } } },
      },
    }
    const result = fromJtd(jtd)
    const expectedUnion = t(
      types.union([
        t(types.object({ eventType: t(types.literal("push")), commits: int32() })),
        t(types.object({ eventType: t(types.literal("pull_request")), number: int32() })),
      ]),
    )
    expect(result).toEqual({ shape: expectedUnion.shape, meta: { discriminator: "eventType" } })
  })
})

describe("ref form", () => {
  test("ref target", () => {
    expect(fromJtd({ ref: "User" })).toEqual(t(types.ref("User")))
  })
})

describe("nullable", () => {
  test("type form + nullable", () => {
    expect(fromJtd({ type: "string", nullable: true })).toEqual(t(types.string, { nullable: true }))
  })

  test("elements form + nullable", () => {
    expect(fromJtd({ elements: { type: "int32" }, nullable: true })).toEqual(t(types.array(int32()), { nullable: true }))
  })
})

describe("metadata passthrough", () => {
  test("description", () => {
    expect(fromJtd({ type: "string", metadata: { description: "a name" } })).toEqual(
      t(types.string, { description: "a name" }),
    )
  })

  test("arbitrary unconsumed keys pass through to meta", () => {
    expect(fromJtd({ type: "string", metadata: { minLength: 1, pattern: "^[a-z]+$" } })).toEqual(
      t(types.string, { minLength: 1, pattern: "^[a-z]+$" }),
    )
  })
})

describe("escape hatches", () => {
  test("never", () => {
    expect(fromJtd({ metadata: { never: true } })).toEqual(t(types.never))
  })

  test("non-string literal const", () => {
    expect(fromJtd({ metadata: { const: 42 } })).toEqual(t(types.literal(42)))
    expect(fromJtd({ metadata: { const: true } })).toEqual(t(types.literal(true)))
    expect(fromJtd({ metadata: { const: null } })).toEqual(t(types.literal(null)))
  })

  test("union", () => {
    expect(fromJtd({ metadata: { union: [{ type: "string" }, { type: "int32" }] } })).toEqual(
      t(types.union([t(types.string), int32()])),
    )
  })

  test("intersection recovers a single-member intersection (lossy — toJtd only kept the first member)", () => {
    expect(fromJtd({ type: "string", metadata: { intersection: true } })).toEqual(t(types.intersection([t(types.string)])))
  })

  test("function degrades to a placeholder zero-param/unknown-return function", () => {
    expect(fromJtd({ metadata: { function: true } })).toEqual(t(types.function([], t(types.unknown))))
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const jtd = {
      properties: {
        ids: { elements: { type: "string", metadata: { format: "uuid" } } },
      },
    }
    expect(fromJtd(jtd)).toEqual(t(types.object({ ids: t(types.array(uuid())) })))
  })
})

describe("definitions / fromJtdDocument", () => {
  test("definitions become defs, root ref stays unresolved", () => {
    const jtd = {
      ref: "User",
      definitions: {
        User: { properties: { id: { type: "string" } } },
      },
    }
    const doc = fromJtdDocument(jtd)
    expect(doc.root).toEqual(t(types.ref("User")))
    expect(doc.defs).toEqual({ User: t(types.object({ id: t(types.string) })) })
  })

  test("no definitions -> empty defs", () => {
    const doc = fromJtdDocument({ type: "string" })
    expect(doc.root).toEqual(t(types.string))
    expect(doc.defs).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Round-trip: fromJtd(toJtd(ref)) should recover `ref` for the subset of
// TypeRef shapes JTD can represent losslessly (i.e. everything toJtd doesn't
// have to degrade — see jtd.ts's per-kind comments for which kinds those
// are). Kinds toJtd documents as lossy (tuple, intersection, union,
// function, literal-via-enum, stream) are covered separately above as
// one-way reconstructions, not round-trips.
// ---------------------------------------------------------------------------

describe("round-trip via toJtd", () => {
  test("leaf kinds", () => {
    expect(fromJtd(toJtd(t(types.boolean)))).toEqual(t(types.boolean))
    expect(fromJtd(toJtd(t(types.string)))).toEqual(t(types.string))
    expect(fromJtd(toJtd(int32()))).toEqual(int32())
    expect(fromJtd(toJtd(int64()))).toEqual(int64())
    expect(fromJtd(toJtd(float32()))).toEqual(float32())
    expect(fromJtd(toJtd(float64()))).toEqual(float64())
    expect(fromJtd(toJtd(uuid()))).toEqual(uuid())
    expect(fromJtd(toJtd(uri()))).toEqual(uri())
    expect(fromJtd(toJtd(email()))).toEqual(email())
    expect(fromJtd(toJtd(datetime()))).toEqual(datetime())
    expect(fromJtd(toJtd(bytes()))).toEqual(bytes())
    expect(fromJtd(toJtd(t(types.unknown)))).toEqual(t(types.unknown))
    expect(fromJtd(toJtd(t(types.never)))).toEqual(t(types.never))
  })

  test("null and void both round-trip to null", () => {
    expect(fromJtd(toJtd(t(types.null)))).toEqual(t(types.null))
    expect(fromJtd(toJtd(t(types.void)))).toEqual(t(types.null))
  })

  // type-ir's generic `number`/`integer`/`date` degrade to a *narrower*
  // JTD-native kind (float64/int32/timestamp) that itself round-trips to a
  // different (but JTD-equivalent) type-ir kind — documented in jtd.ts as
  // "closest fit", so the round-trip target here is the closest-fit kind,
  // not the original.
  test("number/integer/date degrade to their closest JTD-native fit", () => {
    expect(fromJtd(toJtd(t(types.number)))).toEqual(float64())
    expect(fromJtd(toJtd(t(types.integer)))).toEqual(int32())
    expect(fromJtd(toJtd(date()))).toEqual(datetime())
  })

  test("object / array / map", () => {
    const obj = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(fromJtd(toJtd(obj))).toEqual(obj)

    const arr = t(types.array(t(types.integer)))
    expect(fromJtd(toJtd(arr))).toEqual(t(types.array(int32())))

    const map = t(types.map(t(types.string), t(types.number)))
    expect(fromJtd(toJtd(map))).toEqual(t(types.map(t(types.string), float64())))
  })

  test("enum / ref", () => {
    const enumRef = t(types.enum(["a", "b", "c"]))
    expect(fromJtd(toJtd(enumRef))).toEqual(enumRef)

    const ref = t(types.ref("User"))
    expect(fromJtd(toJtd(ref))).toEqual(ref)
  })

  test("nullable leaf and container", () => {
    const leaf = t(types.string, { nullable: true })
    expect(fromJtd(toJtd(leaf))).toEqual(leaf)

    const container = t(types.array(t(types.string)), { nullable: true })
    expect(fromJtd(toJtd(container))).toEqual(t(types.array(t(types.string)), { nullable: true }))
  })

  test("metadata passthrough", () => {
    const ref = t(types.string, { description: "a name", minLength: 1 })
    expect(fromJtd(toJtd(ref))).toEqual(ref)
  })

  test("stream", () => {
    const stream = t(types.stream(t(types.integer)))
    expect(fromJtd(toJtd(stream))).toEqual(t(types.stream(int32())))
  })
})
