import { describe, expect, test } from "bun:test"
import { toGlaze } from "./cpp-glaze.ts"
import { t, types } from "./index.ts"
import { bytes, int32 } from "./kinds/common.ts"

describe("primitives", () => {
  test("boolean", () => {
    expect(toGlaze(t(types.boolean), "Flag")).toBe(["", "using Flag = bool;", ""].join("\n"))
  })

  test("string", () => {
    expect(toGlaze(t(types.string), "Name")).toBe(
      ["#include <string>", "", "using Name = std::string;", ""].join("\n"),
    )
  })

  test("number maps to double", () => {
    expect(toGlaze(t(types.number), "Amount")).toBe(["", "using Amount = double;", ""].join("\n"))
  })

  test("bare integer defaults to int64_t", () => {
    expect(toGlaze(t(types.integer), "Count")).toBe(
      ["#include <cstdint>", "", "using Count = int64_t;", ""].join("\n"),
    )
  })

  test("int32 kind maps to int32_t", () => {
    expect(toGlaze(int32(), "Count")).toBe(["#include <cstdint>", "", "using Count = int32_t;", ""].join("\n"))
  })

  test("bytes maps to std::vector<uint8_t>", () => {
    expect(toGlaze(bytes(), "Blob")).toBe(
      ["#include <cstdint>", "#include <vector>", "", "using Blob = std::vector<uint8_t>;", ""].join("\n"),
    )
  })

  test("null maps to std::nullptr_t", () => {
    expect(toGlaze(t(types.null), "Nothing")).toBe(
      ["#include <cstddef>", "", "using Nothing = std::nullptr_t;", ""].join("\n"),
    )
  })

  test("unknown falls back to glz::json_t", () => {
    expect(toGlaze(t(types.unknown), "Anything")).toBe(
      ["#include <glaze/glaze.hpp>", "", "using Anything = glz::json_t;", ""].join("\n"),
    )
  })
})

describe("struct", () => {
  test("emits a plain struct plus a glz::meta<T> specialization, no per-field glue", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    const out = toGlaze(ref, "User")
    expect(out).toContain("#include <glaze/glaze.hpp>")
    expect(out).toContain("struct User {")
    expect(out).toContain("std::string id;")
    expect(out).toContain("std::optional<int64_t> age;")
    expect(out).toContain("template <>")
    expect(out).toContain("struct glz::meta<User> {")
    expect(out).toContain("using T = User;")
    expect(out).toContain('static constexpr auto value = glz::object("id", &User::id, "age", &User::age);')
  })

  test("nested object field hoists to its own named struct declared first", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const out = toGlaze(ref, "Account")
    expect(out.indexOf("struct Address {")).toBeGreaterThan(-1)
    expect(out.indexOf("struct Address {")).toBeLessThan(out.indexOf("struct Account {"))
    expect(out).toContain("Address address;")
    expect(out).toContain("struct glz::meta<Address> {")
    expect(out).toContain('glz::object("id", &Account::id, "address", &Account::address)')
  })

  test("struct with no fields still emits glz::object with no entries", () => {
    const ref = t(types.object({}))
    const out = toGlaze(ref, "Empty")
    expect(out).toContain("static constexpr auto value = glz::object();")
  })
})

test("array maps to std::vector<T>", () => {
  expect(toGlaze(t(types.array(t(types.string))), "Names")).toBe(
    ["#include <string>", "#include <vector>", "", "using Names = std::vector<std::string>;", ""].join("\n"),
  )
})

describe("map", () => {
  test("maps to std::map<K, V> by default", () => {
    expect(toGlaze(t(types.map(t(types.string), t(types.number))), "Scores")).toBe(
      ["#include <map>", "#include <string>", "", "using Scores = std::map<std::string, double>;", ""].join("\n"),
    )
  })

  test("meta.unordered switches to std::unordered_map<K, V>", () => {
    const ref = t(types.map(t(types.string), t(types.number)), { unordered: true })
    expect(toGlaze(ref, "Scores")).toBe(
      [
        "#include <string>",
        "#include <unordered_map>",
        "",
        "using Scores = std::unordered_map<std::string, double>;",
        "",
      ].join("\n"),
    )
  })
})

test("tuple maps to std::tuple<...>", () => {
  const ref = t(types.tuple([t(types.string), t(types.number)]))
  expect(toGlaze(ref, "Pair")).toBe(
    ["#include <string>", "#include <tuple>", "", "using Pair = std::tuple<std::string, double>;", ""].join("\n"),
  )
})

describe("enum class", () => {
  test("emits enum class plus a glz::meta<T> using glz::enumerate, no toString/fromString helpers", () => {
    const ref = t(types.enum(["active", "inactive"]))
    const out = toGlaze(ref, "Status")
    expect(out).toContain("enum class Status {")
    expect(out).toContain("template <>")
    expect(out).toContain("struct glz::meta<Status> {")
    expect(out).toContain("using enum Status;")
    expect(out).toContain('static constexpr auto value = glz::enumerate(Active, "active", Inactive, "inactive");')
    expect(out).not.toContain("toString")
    expect(out).not.toContain("FromString")
  })
})

test("optional wraps in std::optional<T>", () => {
  const ref = t(types.string, { optional: true })
  expect(toGlaze(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join("\n"),
  )
})

test("nullable also wraps in std::optional<T>", () => {
  const ref = t(types.string, { nullable: true })
  expect(toGlaze(ref, "Name")).toBe(
    ["#include <optional>", "#include <string>", "", "using Name = std::optional<std::string>;", ""].join("\n"),
  )
})

test("union maps to std::variant<...>, natively glaze-serializable with no extra glue", () => {
  const ref = t(types.union([t(types.string), t(types.number)]))
  expect(toGlaze(ref, "Value")).toBe(
    ["#include <string>", "#include <variant>", "", "using Value = std::variant<std::string, double>;", ""].join(
      "\n",
    ),
  )
})

test("instance renders the class name and expects it to be included by the caller", () => {
  const ref = t(types.instance("Account", "src/account.ts"))
  expect(toGlaze(ref, "Owner")).toBe(["", "using Owner = Account;", ""].join("\n"))
})

test("ref renders the target name directly", () => {
  const ref = t(types.ref("User"))
  expect(toGlaze(ref, "Alias")).toBe(["", "using Alias = User;", ""].join("\n"))
})

test("function maps to std::function<Ret(Params...)>", () => {
  const ref = t(types.function([{ name: "amount", type: t(types.number) }], t(types.void)))
  expect(toGlaze(ref, "Callback")).toBe(
    ["#include <functional>", "", "using Callback = std::function<void(double)>;", ""].join("\n"),
  )
})

describe("interface", () => {
  test("emits an abstract class of pure-virtual methods", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
      }),
    )
    const out = toGlaze(ref, "Account")
    expect(out).toContain("class Account {")
    expect(out).toContain("virtual ~Account() = default;")
    expect(out).toContain("virtual void deposit(double amount) = 0;")
  })
})

test("unknown/unregistered kind falls back to glz::json_t", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} }
  expect(toGlaze(ref, "Mystery")).toBe(
    ["#include <glaze/glaze.hpp>", "", "using Mystery = glz::json_t;", ""].join("\n"),
  )
})
