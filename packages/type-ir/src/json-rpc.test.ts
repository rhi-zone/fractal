import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import {
  JSON_RPC_INVALID_PARAMS,
  jsonRpcErrorSchema,
  toJsonRpcMethod,
  toJsonRpcMethods,
} from "./json-rpc.ts"

describe("standard error codes", () => {
  test("JSON_RPC_INVALID_PARAMS matches spec §5.1", () => {
    expect(JSON_RPC_INVALID_PARAMS).toBe(-32602)
  })
})

describe("jsonRpcErrorSchema", () => {
  test("no data schema -> unconstrained data", () => {
    expect(jsonRpcErrorSchema()).toEqual({
      type: "object",
      properties: { code: { type: "integer" }, message: { type: "string" }, data: {} },
      required: ["code", "message"],
    })
  })

  test("with data schema -> data constrained", () => {
    expect(jsonRpcErrorSchema({ type: "string" })).toEqual({
      type: "object",
      properties: { code: { type: "integer" }, message: { type: "string" }, data: { type: "string" } },
      required: ["code", "message"],
    })
  })
})

describe("toJsonRpcMethod", () => {
  test("params by-name, required mirrors non-optional params", () => {
    const ref = t(
      types.method(
        [
          { name: "amount", type: t(types.number) },
          { name: "memo", type: t(types.string, { optional: true }) },
        ],
        t(types.void),
      ),
    )
    const method = toJsonRpcMethod("deposit", ref)
    expect(method.name).toBe("deposit")
    expect(method.paramsSchema).toEqual({
      type: "object",
      properties: { amount: { type: "number" }, memo: { type: "string" } },
      required: ["amount"],
    })
  })

  test("void return -> null result schema", () => {
    const ref = t(types.method([], t(types.void)))
    expect(toJsonRpcMethod("noop", ref).resultSchema).toEqual({ type: "null" })
  })

  test("plain return type -> result schema", () => {
    const ref = t(types.method([], t(types.number)))
    expect(toJsonRpcMethod("getBalance", ref).resultSchema).toEqual({ type: "number" })
  })

  test("stream return type -> element schema + streaming: true", () => {
    const ref = t(types.method([], t(types.stream(t(types.string)))))
    const method = toJsonRpcMethod("watch", ref)
    expect(method.resultSchema).toEqual({ type: "string" })
    expect(method.streaming).toBe(true)
  })

  test("non-stream return type omits streaming", () => {
    const ref = t(types.method([], t(types.string)))
    expect(toJsonRpcMethod("get", ref).streaming).toBeUndefined()
  })

  test("description and deprecated pass through from meta", () => {
    const ref = t(types.method([], t(types.void)), { description: "Deposits funds", deprecated: true })
    const method = toJsonRpcMethod("deposit", ref)
    expect(method.description).toBe("Deposits funds")
    expect(method.deprecated).toBe(true)
  })

  test("no description/deprecated -> keys omitted", () => {
    const ref = t(types.method([], t(types.void)))
    const method = toJsonRpcMethod("deposit", ref)
    expect(method.description).toBeUndefined()
    expect(method.deprecated).toBeUndefined()
  })

  test("default errorSchema has unconstrained data", () => {
    const ref = t(types.method([], t(types.void)))
    expect(toJsonRpcMethod("deposit", ref).errorSchema).toEqual({
      type: "object",
      properties: { code: { type: "integer" }, message: { type: "string" }, data: {} },
      required: ["code", "message"],
    })
  })

  test("meta.errorType constrains the error envelope's data schema", () => {
    const errorType = t(types.object({ reason: t(types.string) }))
    const ref = t(types.method([], t(types.void)), { errorType })
    const method = toJsonRpcMethod("deposit", ref)
    expect(method.errorSchema).toEqual({
      type: "object",
      properties: {
        code: { type: "integer" },
        message: { type: "string" },
        data: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
      },
      required: ["code", "message"],
    })
  })
})

describe("toJsonRpcMethods (interface -> flat method list, the key use case)", () => {
  test("one JsonRpcMethod per interface method, in key order", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
        getBalance: t(types.method([], t(types.number))),
      }),
    )
    const methods = toJsonRpcMethods(ref)
    expect(methods.map((m) => m.name)).toEqual(["deposit", "getBalance"])
    expect(methods[0]!.paramsSchema).toEqual({
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
    })
    expect(methods[1]!.resultSchema).toEqual({ type: "number" })
  })
})
