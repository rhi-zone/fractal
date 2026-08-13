import { describe, expect, test } from "bun:test";
import { t, types } from "./index.ts";
import { bytes, datetime, date, time, duration, email, uri, uuid } from "./kinds/common.ts";
import { toElixir, toElixirType } from "./elixir-jason.ts";

describe("primitives", () => {
  test("boolean", () => {
    expect(toElixirType(t(types.boolean), "X", { decls: [], seen: new Set() })).toBe("boolean()");
  });

  test("number maps to float()", () => {
    expect(toElixirType(t(types.number), "X", { decls: [], seen: new Set() })).toBe("float()");
  });

  test("integer maps to integer()", () => {
    expect(toElixirType(t(types.integer), "X", { decls: [], seen: new Set() })).toBe("integer()");
  });

  test("string maps to String.t()", () => {
    expect(toElixirType(t(types.string), "X", { decls: [], seen: new Set() })).toBe("String.t()");
  });

  test("null maps to nil", () => {
    expect(toElixirType(t(types.null), "X", { decls: [], seen: new Set() })).toBe("nil");
  });

  test("void maps to nil", () => {
    expect(toElixirType(t(types.void), "X", { decls: [], seen: new Set() })).toBe("nil");
  });

  test("unknown maps to any()", () => {
    expect(toElixirType(t(types.unknown), "X", { decls: [], seen: new Set() })).toBe("any()");
  });

  test("never maps to no_return()", () => {
    expect(toElixirType(t(types.never), "X", { decls: [], seen: new Set() })).toBe("no_return()");
  });

  test("bytes maps to binary()", () => {
    expect(toElixirType(bytes(), "X", { decls: [], seen: new Set() })).toBe("binary()");
  });
});

describe("semantic subtypes", () => {
  test("uuid/uri/email honestly degrade to String.t()", () => {
    const ctx = { decls: [], seen: new Set<string>() };
    expect(toElixirType(uuid(), "X", ctx)).toBe("String.t()");
    expect(toElixirType(uri(), "X", ctx)).toBe("String.t()");
    expect(toElixirType(email(), "X", ctx)).toBe("String.t()");
  });

  test("datetime/date/time map to the matching stdlib Calendar type", () => {
    const ctx = { decls: [], seen: new Set<string>() };
    expect(toElixirType(datetime(), "X", ctx)).toBe("DateTime.t()");
    expect(toElixirType(date(), "X", ctx)).toBe("Date.t()");
    expect(toElixirType(time(), "X", ctx)).toBe("Time.t()");
  });

  test("duration maps to the stdlib Duration struct (Elixir 1.17+)", () => {
    expect(toElixirType(duration(), "X", { decls: [], seen: new Set() })).toBe("Duration.t()");
  });
});

describe("objects", () => {
  test("emits a struct module with @enforce_keys, @derive Jason.Encoder, defstruct, and typespec", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }));
    expect(toElixir(ref, "User")).toBe(
      [
        "defmodule User do",
        "  @enforce_keys [:id, :age]",
        "  @derive Jason.Encoder",
        "  defstruct [:id, :age]",
        "",
        "  @type t :: %__MODULE__{",
        "    id: String.t(),",
        "    age: integer()",
        "  }",
        "end",
        "",
      ].join("\n"),
    );
  });

  test("optional field gets a nil default, no enforce_keys entry, and | nil unless already nullable", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    );
    expect(toElixir(ref, "Person")).toBe(
      [
        "defmodule Person do",
        "  @enforce_keys [:name]",
        "  @derive Jason.Encoder",
        "  defstruct [:name, nickname: nil]",
        "",
        "  @type t :: %__MODULE__{",
        "    name: String.t(),",
        "    nickname: String.t() | nil",
        "  }",
        "end",
        "",
      ].join("\n"),
    );
  });

  test("optional field declared before a required field is still reordered after it (defstruct keyword-tail syntax)", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
        name: t(types.string),
      }),
    );
    const out = toElixir(ref, "Person");
    expect(out).toContain("defstruct [:name, nickname: nil]");
  });

  test("nested object field is promoted to its own struct module named from the field", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }));
    const out = toElixir(ref, "User");
    expect(out).toContain("defmodule Address do");
    expect(out).toContain("city: String.t()");
    expect(out).toContain("defmodule User do");
    expect(out).toContain("address: Address.t()");
  });

  test("object-level description becomes @moduledoc", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A user record." });
    expect(toElixir(ref, "User")).toContain('@moduledoc "A user record."');
  });

  test("deprecated object emits a Deprecated comment", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: true });
    expect(toElixir(ref, "User")).toContain("# Deprecated\n");
  });

  test("deprecated with string message includes the message", () => {
    const ref = t(types.object({ id: t(types.string) }), { deprecated: "Use NewUser instead." });
    expect(toElixir(ref, "User")).toContain("# Deprecated: Use NewUser instead.");
  });

  test("empty object emits defstruct [] and an empty typespec map, no @enforce_keys", () => {
    const out = toElixir(t(types.object({})), "Empty");
    expect(out).toBe(
      [
        "defmodule Empty do",
        "  @derive Jason.Encoder",
        "  defstruct []",
        "",
        "  @type t :: %__MODULE__{}",
        "end",
        "",
      ].join("\n"),
    );
    expect(out).not.toContain("@enforce_keys");
  });

  test("field name that isn't a bare atom is quoted consistently in enforce_keys, defstruct, and the typespec", () => {
    const ref = t(types.object({ "first-name": t(types.string) }));
    const out = toElixir(ref, "Person");
    expect(out).toContain('@enforce_keys [:"first-name"]');
    expect(out).toContain('defstruct [:"first-name"]');
    expect(out).toContain('"first-name": String.t()');
  });

  test("field name preserves original casing rather than converting to snake_case", () => {
    const ref = t(types.object({ firstName: t(types.string) }));
    const out = toElixir(ref, "Person");
    expect(out).toContain(":firstName");
    expect(out).toContain("firstName: String.t()");
  });
});

describe("arrays / tuples / maps", () => {
  test("array of string", () => {
    expect(toElixir(t(types.array(t(types.string))), "Tags")).toBe(
      ["defmodule Tags do", "  @type t :: list(String.t())", "end", ""].join("\n"),
    );
  });

  test("array of objects promotes the element to a named struct module", () => {
    const ref = t(
      types.object({ items: t(types.array(t(types.object({ id: t(types.string) })))) }),
    );
    const out = toElixir(ref, "Basket");
    expect(out).toContain("defmodule Items do");
    expect(out).toContain("items: list(Items.t())");
  });

  test("tuple renders as a literal Elixir tuple type", () => {
    expect(toElixir(t(types.tuple([t(types.string), t(types.integer)])), "Pair")).toBe(
      ["defmodule Pair do", "  @type t :: {String.t(), integer()}", "end", ""].join("\n"),
    );
  });

  test("map with string key", () => {
    expect(toElixir(t(types.map(t(types.string), t(types.integer))), "Counts")).toBe(
      ["defmodule Counts do", "  @type t :: %{String.t() => integer()}", "end", ""].join("\n"),
    );
  });
});

describe("enums", () => {
  test("emits an atom-union type, no sanitization needed for messy members", () => {
    const ref = t(types.enum(["active", "inactive"]));
    expect(toElixir(ref, "Status")).toBe(
      ["defmodule Status do", "  @type t :: :active | :inactive", "end", ""].join("\n"),
    );
  });

  test("enum member with non-identifier characters is quoted, not sanitized/renamed", () => {
    const ref = t(types.enum(["in-progress"]));
    expect(toElixir(ref, "State")).toBe(
      ["defmodule State do", '  @type t :: :"in-progress"', "end", ""].join("\n"),
    );
  });

  test("nested enum field is promoted to its own atom-union module", () => {
    const ref = t(types.object({ status: t(types.enum(["active", "inactive"])) }));
    const out = toElixir(ref, "User");
    expect(out).toContain("defmodule Status do");
    expect(out).toContain("@type t :: :active | :inactive");
    expect(out).toContain("status: Status.t()");
  });
});

describe("unions", () => {
  test("plain non-discriminated union inlines directly, no wrapper module needed for the union itself", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]));
    expect(toElixir(ref, "Id")).toBe(
      ["defmodule Id do", "  @type t :: String.t() | integer()", "end", ""].join("\n"),
    );
  });

  test("union of duplicate-rendering variants collapses to a single type", () => {
    const ref = t(types.union([t(types.string), t(types.string)]));
    expect(toElixir(ref, "Name")).toBe(
      ["defmodule Name do", "  @type t :: String.t()", "end", ""].join("\n"),
    );
  });

  test("discriminated union declares one struct module per variant, named from its discriminant tag, plus an inline typespec union", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }));
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }));
    const ref = t(types.union([circle, square]), { discriminator: "kind" });
    const out = toElixir(ref, "Shape");
    expect(out).toContain("defmodule Circle do");
    expect(out).toContain("defmodule Square do");
    // The discriminant field is kept (unlike kotlin-kotlinx.ts's sealed-class
    // encoding) since Jason has no out-of-band mechanism to reconstruct it.
    expect(out).toContain("kind: String.t()");
    expect(out).toContain("defmodule Shape do\n  @type t :: Circle.t() | Square.t()\nend");
  });

  test("discriminated union variant without a literal tag falls back to VariantN naming", () => {
    const a = t(types.object({ kind: t(types.string), value: t(types.integer) }));
    const b = t(types.object({ kind: t(types.string), label: t(types.string) }));
    const ref = t(types.union([a, b]), { discriminator: "kind" });
    const out = toElixir(ref, "Thing");
    expect(out).toContain("defmodule Variant1 do");
    expect(out).toContain("defmodule Variant2 do");
  });
});

describe("optional and nullable", () => {
  test("nullable field renders T | nil without a defstruct default", () => {
    const ref = t(types.object({ note: t(types.string, { nullable: true }) }));
    const out = toElixir(ref, "Entry");
    expect(out).toContain("note: String.t() | nil");
    expect(out).toContain("@enforce_keys [:note]");
    expect(out).not.toContain("note: nil");
  });

  test("optional and nullable field only appends | nil once", () => {
    const ref = t(types.object({ note: t(types.string, { optional: true, nullable: true }) }));
    const out = toElixir(ref, "Entry");
    expect(out).toContain("note: String.t() | nil");
    expect(out).not.toContain("String.t() | nil | nil");
  });
});

test("ref renders as <Target>.t()", () => {
  expect(toElixir(t(types.ref("User")), "Alias")).toBe(
    ["defmodule Alias do", "  @type t :: User.t()", "end", ""].join("\n"),
  );
});

describe("literals", () => {
  test("string literal degrades to String.t() (no literal-string typespec in Elixir)", () => {
    expect(toElixir(t(types.literal("active")), "Status")).toBe(
      ["defmodule Status do", "  @type t :: String.t()", "end", ""].join("\n"),
    );
  });

  test("integer literal renders as a literal typespec value", () => {
    expect(toElixir(t(types.literal(42)), "Answer")).toBe(
      ["defmodule Answer do", "  @type t :: 42", "end", ""].join("\n"),
    );
  });

  test("boolean literal renders as the literal atom", () => {
    expect(toElixir(t(types.literal(true)), "Flag")).toBe(
      ["defmodule Flag do", "  @type t :: true", "end", ""].join("\n"),
    );
  });

  test("null literal renders as nil", () => {
    expect(toElixir(t(types.literal(null)), "Nothing")).toBe(
      ["defmodule Nothing do", "  @type t :: nil", "end", ""].join("\n"),
    );
  });
});

test("unknown kind fallback maps to any()", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} };
  expect(toElixir(ref, "Mystery")).toBe(
    ["defmodule Mystery do", "  @type t :: any()", "end", ""].join("\n"),
  );
});

test("recursive self-reference compiles as a self-qualified <Module>.t() reference", () => {
  const ref = t(
    types.object({
      value: t(types.string),
      children: t(types.array(t(types.ref("TreeNode")))),
    }),
  );
  const out = toElixir(ref, "TreeNode");
  expect(out).toContain("children: list(TreeNode.t())");
});
