// packages/json-rpc-api-projector/src/wire.test.ts — JSON-RPC 2.0 wire-format helpers

import { describe, expect, it } from "bun:test"
import {
  isJsonRpcError,
  isJsonRpcRequestShape,
  jsonRpcErrorResponse,
  jsonRpcSuccessResponse,
} from "./wire.ts"

describe("isJsonRpcRequestShape", () => {
  it("a well-formed Request object is recognized", () => {
    expect(isJsonRpcRequestShape({ jsonrpc: "2.0", method: "ping", id: 1 })).toBe(true)
  })

  it("a well-formed Notification (no id) is also recognized — shape doesn't require id", () => {
    expect(isJsonRpcRequestShape({ jsonrpc: "2.0", method: "ping" })).toBe(true)
  })

  it("wrong jsonrpc version is rejected", () => {
    expect(isJsonRpcRequestShape({ jsonrpc: "1.0", method: "ping", id: 1 })).toBe(false)
  })

  it("missing jsonrpc field is rejected", () => {
    expect(isJsonRpcRequestShape({ method: "ping", id: 1 })).toBe(false)
  })

  it("non-string method is rejected", () => {
    expect(isJsonRpcRequestShape({ jsonrpc: "2.0", method: 123, id: 1 })).toBe(false)
  })

  it("missing method is rejected", () => {
    expect(isJsonRpcRequestShape({ jsonrpc: "2.0", id: 1 })).toBe(false)
  })

  it("an array is rejected (never mistaken for a batch itself being one Request)", () => {
    expect(isJsonRpcRequestShape([{ jsonrpc: "2.0", method: "ping" }])).toBe(false)
  })

  it("null and primitives are rejected", () => {
    expect(isJsonRpcRequestShape(null)).toBe(false)
    expect(isJsonRpcRequestShape(42)).toBe(false)
    expect(isJsonRpcRequestShape("ping")).toBe(false)
    expect(isJsonRpcRequestShape(undefined)).toBe(false)
  })
})

describe("jsonRpcSuccessResponse", () => {
  it("carries the given result verbatim", () => {
    expect(jsonRpcSuccessResponse(1, { ok: true })).toEqual({ jsonrpc: "2.0", result: { ok: true }, id: 1 })
  })

  it("undefined result degrades to null (undefined isn't valid JSON)", () => {
    expect(jsonRpcSuccessResponse(1, undefined)).toEqual({ jsonrpc: "2.0", result: null, id: 1 })
  })

  it("a literal null result is preserved as null, not confused with the undefined-degrade path", () => {
    expect(jsonRpcSuccessResponse(1, null)).toEqual({ jsonrpc: "2.0", result: null, id: 1 })
  })

  it("string/number ids pass through untouched", () => {
    expect(jsonRpcSuccessResponse("abc", 1).id).toBe("abc")
    expect(jsonRpcSuccessResponse(null, 1).id).toBe(null)
  })
})

describe("jsonRpcErrorResponse", () => {
  it("omits data when not supplied", () => {
    const res = jsonRpcErrorResponse(1, -32600, "Invalid Request")
    expect(res).toEqual({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: 1 })
    expect("data" in res.error).toBe(false)
  })

  it("includes data when supplied, even when falsy", () => {
    expect(jsonRpcErrorResponse(1, -32000, "custom", 0)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "custom", data: 0 },
      id: 1,
    })
    expect(jsonRpcErrorResponse(1, -32000, "custom", null)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "custom", data: null },
      id: 1,
    })
  })
})

describe("isJsonRpcError", () => {
  it("distinguishes error from success responses", () => {
    expect(isJsonRpcError(jsonRpcErrorResponse(1, -32600, "x"))).toBe(true)
    expect(isJsonRpcError(jsonRpcSuccessResponse(1, "x"))).toBe(false)
  })
})
