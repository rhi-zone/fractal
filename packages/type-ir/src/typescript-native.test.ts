import { describe, expect, test } from "bun:test";
import { t, types } from "./index.ts";
import {
  bytes,
  date,
  datetime,
  duration,
  email,
  float32,
  float64,
  int32,
  int64,
  time,
  uri,
  uuid,
} from "./kinds/common.ts";
import { toTypeDeclaration, toTypeDeclarations, toTypeScript } from "./typescript-native.ts";

describe("leaf types", () => {
  test("boolean", () => {
    expect(toTypeScript(t(types.boolean))).toBe("boolean");
  });

  test("number", () => {
    expect(toTypeScript(t(types.number))).toBe("number");
  });

  test("string", () => {
    expect(toTypeScript(t(types.string))).toBe("string");
  });
});

describe("numeric subtypes", () => {
  const cases: Record<string, () => ReturnType<typeof t>> = {
    integer: () => t(types.integer),
    int32: () => int32(),
    int64: () => int64(),
    float32: () => float32(),
    float64: () => float64(),
  };
  for (const [kind, make] of Object.entries(cases)) {
    test(kind, () => {
      expect(toTypeScript(make())).toBe("number");
    });
  }
});

describe("string subtypes", () => {
  const cases: Record<string, () => ReturnType<typeof t>> = {
    uuid: () => uuid(),
    uri: () => uri(),
    email: () => email(),
    time: () => time(),
    duration: () => duration(),
  };
  for (const [kind, make] of Object.entries(cases)) {
    test(kind, () => {
      expect(toTypeScript(make())).toBe("string");
    });
  }
});

// datetime/date are type-ir's `Date` domain type, not a string subtype —
// see kinds/date-time.ts.
describe("Date-domain kinds", () => {
  test("datetime", () => {
    expect(toTypeScript(datetime())).toBe("Date");
  });

  test("date", () => {
    expect(toTypeScript(date())).toBe("Date");
  });
});

test("bytes", () => {
  expect(toTypeScript(bytes())).toBe("Uint8Array");
});

describe("boundary types", () => {
  test("null", () => {
    expect(toTypeScript(t(types.null))).toBe("null");
  });

  test("void", () => {
    expect(toTypeScript(t(types.void))).toBe("void");
  });

  test("unknown", () => {
    expect(toTypeScript(t(types.unknown))).toBe("unknown");
  });

  test("never", () => {
    expect(toTypeScript(t(types.never))).toBe("never");
  });
});

test("object with required and optional fields", () => {
  const ref = t(
    types.object({
      name: t(types.string),
      age: t(types.number, { optional: true }),
    }),
  );
  expect(toTypeScript(ref)).toBe("{ name: string; age?: number }");
});

test("object with readonly field", () => {
  const ref = t(
    types.object({
      id: t(types.string, { readonly: true }),
      name: t(types.string),
    }),
  );
  expect(toTypeScript(ref)).toBe("{ readonly id: string; name: string }");
});

test("object with readonly optional field", () => {
  const ref = t(types.object({ id: t(types.string, { optional: true, readonly: true }) }));
  expect(toTypeScript(ref)).toBe("{ readonly id?: string }");
});

// A field name that isn't a valid bare TS identifier (contains a hyphen —
// e.g. DOM's `Headers`/fetch multi-value-cookie surface exposing a
// `"set-cookie"` member) renders as a quoted string key; left unquoted,
// `set-cookie?: string[]` is a syntax error (`TS1005`/parser "Unexpected -").
test("object field name that isn't a valid identifier renders as a quoted string key", () => {
  const ref = t(types.object({ "set-cookie": t(types.array(t(types.string))) }));
  expect(toTypeScript(ref)).toBe('{ "set-cookie": string[] }');
});

test("object field name starting with a digit renders as a quoted string key", () => {
  const ref = t(types.object({ "0invalid": t(types.string) }));
  expect(toTypeScript(ref)).toBe('{ "0invalid": string }');
});

test("array", () => {
  expect(toTypeScript(t(types.array(t(types.string))))).toBe("string[]");
});

test("array of union uses Array<>", () => {
  const ref = t(types.array(t(types.union([t(types.string), t(types.number)]))));
  expect(toTypeScript(ref)).toBe("Array<string | number>");
});

test("tuple", () => {
  const ref = t(types.tuple([t(types.string), t(types.number)]));
  expect(toTypeScript(ref)).toBe("[string, number]");
});

test("map with string key", () => {
  const ref = t(types.map(t(types.string), t(types.number)));
  expect(toTypeScript(ref)).toBe("Record<string, number>");
});

test("map with non-string key", () => {
  const ref = t(types.map(t(types.number), t(types.string)));
  expect(toTypeScript(ref)).toBe("Map<number, string>");
});

test("union", () => {
  const ref = t(types.union([t(types.string), t(types.number)]));
  expect(toTypeScript(ref)).toBe("string | number");
});

test("literal string", () => {
  expect(toTypeScript(t(types.literal("active")))).toBe('"active"');
});

test("intersection", () => {
  const ref = t(
    types.intersection([
      t(types.object({ id: t(types.string) })),
      t(types.object({ createdAt: t(types.string) })),
    ]),
  );
  expect(toTypeScript(ref)).toBe("{ id: string } & { createdAt: string }");
});

test("three-way intersection joins all members with &", () => {
  const ref = t(
    types.intersection([
      t(types.object({ id: t(types.string) })),
      t(types.string),
      t(types.number),
    ]),
  );
  expect(toTypeScript(ref)).toBe("{ id: string } & string & number");
});

test("array of intersection uses Array<>", () => {
  const ref = t(types.array(t(types.intersection([t(types.string), t(types.number)]))));
  expect(toTypeScript(ref)).toBe("Array<string & number>");
});

// A `function`-shaped intersection member (the overloaded-method rendering —
// `functionRefFromSignatures`/`methodRefFromSignatures` in from-typescript.ts
// wrap ≥2 call signatures as
// `types.intersection([types.function(...), types.function(...)])`) is
// parenthesized per TypeScript's own grammar (`TS1387: Function type notation
// must be parenthesized when used in an intersection type`).
test("intersection of function-typed members parenthesizes each function member", () => {
  const ref = t(
    types.intersection([
      t(types.function([{ name: "a", type: t(types.string) }], t(types.number))),
      t(types.function([{ name: "a", type: t(types.number) }], t(types.string))),
    ]),
  );
  expect(toTypeScript(ref)).toBe("((a: string) => number) & ((a: number) => string)");
});

// Same TS grammar rule (`TS1385`) applies to a union of function types.
test("union of function-typed members parenthesizes each function member", () => {
  const ref = t(
    types.union([
      t(types.function([{ name: "a", type: t(types.string) }], t(types.number))),
      t(types.function([{ name: "a", type: t(types.number) }], t(types.string))),
    ]),
  );
  expect(toTypeScript(ref)).toBe("((a: string) => number) | ((a: number) => string)");
});

// A `union`-shaped intersection member changes meaning if left unwrapped:
// `A & X | Y & B` reads differently from the intended `A & (X | Y) & B` —
// `&` binds tighter than `|`.
test("intersection of a union member parenthesizes the union member", () => {
  const ref = t(
    types.intersection([
      t(types.object({ id: t(types.string) })),
      t(types.union([t(types.string), t(types.number)])),
    ]),
  );
  expect(toTypeScript(ref)).toBe("{ id: string } & (string | number)");
});

// A `meta.nullable` intersection member (`X | null`) has the same
// precedence hazard as a `union`-shaped member above.
test("intersection of a nullable member parenthesizes the nullable member", () => {
  const ref = t(
    types.intersection([
      t(types.object({ id: t(types.string) })),
      t(types.string, { nullable: true }),
    ]),
  );
  expect(toTypeScript(ref)).toBe("{ id: string } & (string | null)");
});

test("literal number", () => {
  expect(toTypeScript(t(types.literal(42)))).toBe("42");
});

test("literal boolean", () => {
  expect(toTypeScript(t(types.literal(true)))).toBe("true");
});

test("literal null", () => {
  expect(toTypeScript(t(types.literal(null)))).toBe("null");
});

test("enum", () => {
  expect(toTypeScript(t(types.enum(["a", "b", "c"])))).toBe('"a" | "b" | "c"');
});

test("ref", () => {
  expect(toTypeScript(t(types.ref("User")))).toBe("User");
});

test("nullable appends | null", () => {
  expect(toTypeScript(t(types.string, { nullable: true }))).toBe("string | null");
});

test("toTypeDeclaration for object", () => {
  const ref = t(types.object({ id: t(types.string) }));
  expect(toTypeDeclaration("User", ref)).toBe("type User = { id: string };");
});

test("toTypeDeclaration for non-object", () => {
  expect(toTypeDeclaration("Name", t(types.string))).toBe("type Name = string;");
});

test("toTypeDeclarations", () => {
  const registry = {
    User: t(types.object({ id: t(types.string) })),
    Status: t(types.enum(["active", "inactive"])),
  };
  expect(toTypeDeclarations(registry)).toBe(
    'type User = { id: string };\ntype Status = "active" | "inactive";',
  );
});

test("branded string emits an intersection with a __brand tag", () => {
  expect(toTypeScript(t(types.string, { brand: "LocationId" }))).toBe(
    'string & { readonly __brand: "LocationId" }',
  );
});

describe("doc comments", () => {
  test("description alone emits a single-line TSDoc comment", () => {
    const ref = t(types.string, { description: "A display name" });
    expect(toTypeDeclaration("DisplayName", ref)).toBe(
      "/** A display name */\ntype DisplayName = string;",
    );
  });

  test("deprecated alone emits a single-line @deprecated comment", () => {
    const ref = t(types.string, { deprecated: true });
    expect(toTypeDeclaration("Old", ref)).toBe("/** @deprecated */\ntype Old = string;");
  });

  test("description and deprecated together emit a multi-line block", () => {
    const ref = t(types.string, { description: "A display name", deprecated: true });
    expect(toTypeDeclaration("DisplayName", ref)).toBe(
      ["/**", " * A display name", " * @deprecated", " */", "type DisplayName = string;"].join(
        "\n",
      ),
    );
  });

  test("no description or deprecated emits no comment", () => {
    expect(toTypeDeclaration("Name", t(types.string))).toBe("type Name = string;");
  });
});

test("unknown kind fallback", () => {
  const ref = { shape: { kind: "bogus" } as never, meta: {} };
  expect(toTypeScript(ref)).toBe("unknown");
});

describe("function", () => {
  test("emits a TS function-type expression", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)));
    expect(toTypeScript(ref)).toBe("(x: number) => string");
  });

  test("emits an explicit `this` parameter when thisType is present", () => {
    const ref = t(
      types.function(
        [{ name: "amount", type: t(types.number) }],
        t(types.void),
        t(types.instance("Account", "src/account.ts")),
      ),
    );
    expect(toTypeScript(ref)).toBe("(this: Account, amount: number) => void");
  });

  test("wraps a function element type in Array<...>, not T[]", () => {
    const fn = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)));
    expect(toTypeScript(t(types.array(fn)))).toBe("Array<(x: number) => string>");
  });
});

describe("method", () => {
  test("standalone method falls back to arrow-function syntax via registerParent", () => {
    const ref = t(types.method([{ name: "x", type: t(types.number) }], t(types.string)));
    expect(toTypeScript(ref)).toBe("(x: number) => string");
  });
});

describe("interface", () => {
  test("emits method-signature syntax, not arrow-function fields", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
        balance: t(types.method([], t(types.number))),
      }),
    );
    expect(toTypeScript(ref)).toBe("{ deposit(amount: number): void; balance(): number }");
  });

  test("a method name that isn't a valid identifier renders as a quoted string key", () => {
    const ref = t(types.interface({ "set-cookie": t(types.method([], t(types.string))) }));
    expect(toTypeScript(ref)).toBe('{ "set-cookie"(): string }');
  });
});

describe("stream", () => {
  test("emits AsyncIterable<T>", () => {
    expect(toTypeScript(t(types.stream(t(types.string))))).toBe("AsyncIterable<string>");
  });

  test("emits AsyncIterable<T> for a complex element", () => {
    const ref = t(types.stream(t(types.object({ id: t(types.string) }))));
    expect(toTypeScript(ref)).toBe("AsyncIterable<{ id: string }>");
  });
});
