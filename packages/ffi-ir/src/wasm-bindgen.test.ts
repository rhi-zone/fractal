import { describe, expect, test } from "bun:test"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toWasmBindgenFfi } from "./wasm-bindgen.ts"
import { boundary, f, ownership, withOwnership, type FfiRef } from "./index.ts"

describe("toWasmBindgenFfi — function", () => {
  test("a simple free function with copy-discipline params/return delegates to type-ir's toWasmBindgen", () => {
    const addFn: FfiRef = f(
      boundary.function(
        [
          { name: "a", type: withOwnership(t(types.integer), ownership.copy()) },
          { name: "b", type: withOwnership(t(types.integer), ownership.copy()) },
        ],
        withOwnership(t(types.integer), ownership.copy()),
      ),
    )
    const src = toWasmBindgenFfi(addFn, "add")

    expect(src).toContain("#[wasm_bindgen]")
    expect(src).toContain("pub fn add(a: i64, b: i64) -> i64 {")
    expect(src).toContain("todo!(")
  })

  test("a function with no ownership meta at all also delegates (unannotated = copy-by-value default)", () => {
    const fn: FfiRef = f(boundary.function([{ name: "n", type: t(types.integer) }], t(types.string)))
    const src = toWasmBindgenFfi(fn, "greet")
    expect(src).toContain("pub fn greet(n: i64) -> String {")
  })

  test("a function requires a name", () => {
    const fn = f(boundary.function([], withOwnership(t(types.void), ownership.copy())))
    expect(() => toWasmBindgenFfi(fn)).toThrow(/"function" requires a name/)
  })
})

describe("toWasmBindgenFfi — resource, copy discipline", () => {
  test("emits #[derive(Clone)] struct + impl block with methods, no ownership meta needed (copy is the default)", () => {
    const greetMethod: FfiRef = f(boundary.method([], withOwnership(t(types.string), ownership.copy()), "Greeter"))
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }))

    const src = toWasmBindgenFfi(greeter, "Greeter")

    expect(src).toContain("#[derive(Clone)]")
    expect(src).toContain("#[wasm_bindgen]")
    expect(src).toContain("pub struct Greeter {}")
    expect(src).toContain("impl Greeter {")
    expect(src).toContain("pub fn greet(&self) -> String {")
    // copy discipline never emits a share() method — that's refcount-only.
    expect(src).not.toContain("pub fn share(")
  })

  test("explicit ownership.copy() on the resource's own meta produces the same output as the default", () => {
    const counterMethod: FfiRef = f(boundary.method([], withOwnership(t(types.integer), ownership.copy()), "Counter"))
    const counter: FfiRef = f(boundary.resource("Counter", { value: counterMethod }), { ownership: ownership.copy() })
    const src = toWasmBindgenFfi(counter, "Counter")
    expect(src).toContain("pub struct Counter {}")
    expect(src).toContain("pub fn value(&self) -> i64 {")
  })
})

describe("toWasmBindgenFfi — resource, refcount discipline", () => {
  test("emits an Arc-wrapped struct, a share() method (Arc::clone), and no custom release/registry code", () => {
    const readMethod: FfiRef = f(boundary.method([], withOwnership(t(types.string), ownership.copy()), "Handle"))
    const handle: FfiRef = f(boundary.resource("Handle", { read: readMethod }), { ownership: ownership.refcount() })

    const src = toWasmBindgenFfi(handle, "Handle")

    expect(src).toContain("struct HandleData {}")
    expect(src).toContain("pub struct Handle {")
    expect(src).toContain("inner: std::sync::Arc<HandleData>,")
    expect(src).toContain("pub fn share(&self) -> Self {")
    expect(src).toContain("Self { inner: std::sync::Arc::clone(&self.inner) }")
    expect(src).toContain("pub fn read(&self) -> String {")

    // Corrected design: no hand-rolled release()/FinalizationRegistry glue —
    // wasm-bindgen's own generated free() + internal weak-refs machinery
    // covers deterministic/GC-driven cleanup, so no such code is emitted
    // (the struct's doc comment above references "free()"/GC timing in
    // prose, but no `fn release`/`new FinalizationRegistry` construct).
    expect(src).not.toContain("pub fn release")
    expect(src).not.toContain("new FinalizationRegistry")
  })

  test("methods are spliced with a leading &self and comma only when the method itself takes params", () => {
    const setMethod: FfiRef = f(
      boundary.method([{ name: "value", type: withOwnership(t(types.integer), ownership.copy()) }], t(types.void), "Counter"),
    )
    const counter: FfiRef = f(boundary.resource("Counter", { set: setMethod }), { ownership: ownership.refcount() })
    const src = toWasmBindgenFfi(counter, "Counter")
    expect(src).toContain("pub fn set(&self, value: i64) {")
  })
})

describe("toWasmBindgenFfi — unsupported ownership disciplines", () => {
  test("opaque-handle discipline on a parameter throws explicitly", () => {
    const handleParam = withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.opaqueHandle("file_handle_free"))
    const fn: FfiRef = f(boundary.function([{ name: "handle", type: handleParam }], t(types.void)))
    expect(() => toWasmBindgenFfi(fn, "close")).toThrow(
      /unsupported ownership discipline "opaque-handle" for wasm-bindgen\/JS target at parameter "handle"/,
    )
  })

  test("opaque-handle discipline on a return type throws explicitly", () => {
    const fn: FfiRef = f(
      boundary.function([], withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.opaqueHandle())),
    )
    expect(() => toWasmBindgenFfi(fn, "open")).toThrow(
      /unsupported ownership discipline "opaque-handle" for wasm-bindgen\/JS target at return type/,
    )
  })

  test("resource (own/borrow) discipline throws explicitly, for both own and borrow modes", () => {
    const ownedParam = withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("own"))
    const borrowedParam = withOwnership(t({ kind: "ref", target: "FileHandle" }), ownership.resource("borrow"))

    const ownFn: FfiRef = f(boundary.function([{ name: "h", type: ownedParam }], t(types.void)))
    const borrowFn: FfiRef = f(boundary.function([{ name: "h", type: borrowedParam }], t(types.void)))

    expect(() => toWasmBindgenFfi(ownFn, "take")).toThrow(
      /unsupported ownership discipline "resource" for wasm-bindgen\/JS target/,
    )
    expect(() => toWasmBindgenFfi(borrowFn, "peek")).toThrow(
      /unsupported ownership discipline "resource" for wasm-bindgen\/JS target/,
    )
  })

  test("a resource declared with an unsupported discipline (opaque-handle/resource) throws when the declaration itself is emitted", () => {
    const method: FfiRef = f(boundary.method([], t(types.void), "Thing"))
    const opaqueThing: FfiRef = f(boundary.resource("Thing", { m: method }), { ownership: ownership.opaqueHandle() })
    const resourceThing: FfiRef = f(boundary.resource("Thing", { m: method }), { ownership: ownership.resource("own") })

    expect(() => toWasmBindgenFfi(opaqueThing, "Thing")).toThrow(
      /unsupported ownership discipline "opaque-handle" for wasm-bindgen\/JS target on resource "Thing"/,
    )
    expect(() => toWasmBindgenFfi(resourceThing, "Thing")).toThrow(
      /unsupported ownership discipline "resource" for wasm-bindgen\/JS target on resource "Thing"/,
    )
  })
})

describe("toWasmBindgenFfi — module", () => {
  test("groups functions and resources into a pub mod block", () => {
    const greetMethod: FfiRef = f(boundary.method([], t(types.string), "Greeter"))
    const greeter: FfiRef = f(boundary.resource("Greeter", { greet: greetMethod }))
    const helloFn: FfiRef = f(boundary.function([], t(types.string)))

    const mod: FfiRef = f(boundary.module("MyModule", { hello: helloFn }, { Greeter: greeter }))
    const src = toWasmBindgenFfi(mod, "MyModule")

    expect(src).toContain("pub mod my_module {")
    expect(src).toContain("use wasm_bindgen::prelude::*;")
    expect(src).toContain("pub struct Greeter {}")
    expect(src).toContain("pub fn hello() -> String {")
  })
})
