import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toJtd } from "./jtd.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toJtd(t(types.boolean))).toEqual({ type: "boolean" })
  })

  test("string", () => {
    expect(toJtd(t(types.string))).toEqual({ type: "string" })
  })

  test("float32", () => {
    expect(toJtd(float32())).toEqual({ type: "float32" })
  })

  test("float64", () => {
    expect(toJtd(float64())).toEqual({ type: "float64" })
  })

  test("int32", () => {
    expect(toJtd(int32())).toEqual({ type: "int32" })
  })

  test("datetime maps to timestamp", () => {
    expect(toJtd(datetime())).toEqual({ type: "timestamp" })
  })

  test("date maps to timestamp (JTD has no calendar-only date form)", () => {
    expect(toJtd(date())).toEqual({ type: "timestamp" })
  })

  test("unknown is the empty form", () => {
    expect(toJtd(t(types.unknown))).toEqual({})
  })

  test("never degrades to empty + metadata", () => {
    expect(toJtd(t(types.never))).toEqual({ metadata: { never: true } })
  })

  test("null degrades to empty + forced nullable", () => {
    expect(toJtd(t(types.null))).toEqual({ nullable: true })
  })

  test("void degrades to empty + forced nullable", () => {
    expect(toJtd(t(types.void))).toEqual({ nullable: true })
  })
})

describe("closest-fit degradation", () => {
  test("number has no JTD equivalent, degrades to float64", () => {
    expect(toJtd(t(types.number))).toEqual({ type: "float64" })
  })

  test("integer has no JTD equivalent, degrades to int32", () => {
    expect(toJtd(t(types.integer))).toEqual({ type: "int32" })
  })

  test("int64 has no JTD equivalent, degrades to empty + metadata", () => {
    expect(toJtd(int64())).toEqual({ metadata: { type: "int64" } })
  })
})

describe("string subtypes", () => {
  test("uuid", () => {
    expect(toJtd(uuid())).toEqual({ type: "string", metadata: { format: "uuid" } })
  })

  test("uri", () => {
    expect(toJtd(uri())).toEqual({ type: "string", metadata: { format: "uri" } })
  })

  test("email", () => {
    expect(toJtd(email())).toEqual({ type: "string", metadata: { format: "email" } })
  })

  test("time", () => {
    expect(toJtd(time())).toEqual({ type: "string", metadata: { format: "time" } })
  })

  test("duration", () => {
    expect(toJtd(duration())).toEqual({ type: "string", metadata: { format: "duration" } })
  })

  test("bytes", () => {
    expect(toJtd(bytes())).toEqual({
      type: "string",
      metadata: { contentEncoding: "base64" },
    })
  })
})

describe("object", () => {
  test("required and optional fields split into properties/optionalProperties", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(toJtd(ref)).toEqual({
      properties: { name: { type: "string" } },
      optionalProperties: { nickname: { type: "string" } },
    })
  })

  test("no optionalProperties key when all fields required", () => {
    const ref = t(types.object({ name: t(types.string) }))
    expect(toJtd(ref)).toEqual({ properties: { name: { type: "string" } } })
  })
})

describe("array", () => {
  test("elements", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toJtd(ref)).toEqual({ elements: { type: "int32" } })
  })
})

describe("tuple", () => {
  test("degrades to elements of first member + metadata flag", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toJtd(ref)).toEqual({
      elements: { type: "string" },
      metadata: { tuple: true },
    })
  })
})

describe("map", () => {
  test("values", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toJtd(ref)).toEqual({ values: { type: "float64" } })
  })
})

describe("union", () => {
  test("degrades to empty + variants in metadata", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toJtd(ref)).toEqual({
      metadata: { union: [{ type: "string" }, { type: "int32" }] },
    })
  })
})

describe("literal", () => {
  test("string literal becomes a single-member enum", () => {
    expect(toJtd(t(types.literal("active")))).toEqual({ enum: ["active"] })
  })

  test("non-string literal degrades to empty + const metadata", () => {
    expect(toJtd(t(types.literal(42)))).toEqual({ metadata: { const: 42 } })
    expect(toJtd(t(types.literal(true)))).toEqual({ metadata: { const: true } })
    expect(toJtd(t(types.literal(null)))).toEqual({ metadata: { const: null } })
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toJtd(ref)).toEqual({ enum: ["a", "b", "c"] })
  })
})

describe("ref", () => {
  test("ref target", () => {
    expect(toJtd(t(types.ref("User")))).toEqual({ ref: "User" })
  })
})

describe("nullable", () => {
  test("adds nullable: true", () => {
    const ref = t(types.string, { nullable: true })
    expect(toJtd(ref)).toEqual({ type: "string", nullable: true })
  })
})

describe("metadata passthrough", () => {
  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toJtd(ref)).toEqual({ type: "string", metadata: { description: "a name" } })
  })

  test("arbitrary unconsumed keys pass through to metadata", () => {
    const ref = t(types.string, { minLength: 1, pattern: "^[a-z]+$" })
    expect(toJtd(ref)).toEqual({
      type: "string",
      metadata: { minLength: 1, pattern: "^[a-z]+$" },
    })
  })

  test("optional and nullable are consumed, not passed through", () => {
    const ref = t(types.object({ name: t(types.string, { optional: true, nullable: true }) }))
    expect(toJtd(ref)).toEqual({
      properties: {},
      optionalProperties: { name: { type: "string", nullable: true } },
    })
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toJtd(ref)).toEqual({ type: "int32" })
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toJtd(ref)).toEqual({
      properties: {
        ids: { elements: { type: "string", metadata: { format: "uuid" } } },
      },
    })
  })
})

describe("function", () => {
  test("degrades to the empty form, flagged in metadata (no callable-type form)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toJtd(ref)).toEqual({ metadata: { function: true } })
  })
})

describe("stream", () => {
  test("degrades to the elements form, flagged in metadata", () => {
    const ref = t(types.stream(t(types.integer)))
    expect(toJtd(ref)).toEqual({ elements: { type: "int32" }, metadata: { stream: true } })
  })
})
