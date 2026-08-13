// Staged wire-profile validator codegen (Wire --validateEncoding-->
// ValidWire --decode--> T --defaults-fill--> T --validateConstraints-->
// valid T).
//
// See docs/design/wire-profiles-and-staged-validation.md for the design this
// exercises, and compile.ts's "Wire profiles + staged validation" section for
// the implementation. Mirrors compile.test.ts's eval-the-generated-source
// convention.

import { describe, expect, it } from "bun:test";
import {
  argvProfile,
  assembleWireModule,
  compileConstraintsFn,
  compileWireEntryFragmentComposite,
  compileWireModule,
  identityProfile,
  jsonProfile,
  queryProfile,
  wireTypeText,
  wireValidatorKey,
  type ValidationError,
  type WireProfile,
} from "./compile.ts";
import { t, type TypeRef, types } from "./index.ts";
import { datetime } from "./kinds/common.ts";

type WireTriple = {
  parse: (
    wire: unknown,
  ) => { kind: "ok"; value: unknown } | { kind: "err"; errors: ValidationError[] };
};

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
function stripTypes(source: string): string {
  return tsTranspiler.transformSync(source).trim().replace(/;$/, "");
}

function evalWireModule(source: string): Record<string, WireTriple> {
  const commonJs =
    stripTypes(source).replace("export const wireValidators", "const wireValidators") +
    "\nreturn wireValidators;";
  return new Function(commonJs)();
}

/** Compile+evaluate one (entry, profile) pair via the full `compileWireModule`
 * assembly (not a hand-rolled harness) — realistic end-to-end, and exercises
 * `assembleWireModule`'s module-scope wiring (the shared `__inferTypeRef`
 * helper, the `ValidationError` type, the by-name `constraintsFn` call) the
 * same way a real generated module would. */
function evalWireEntry(name: string, ref: TypeRef, profile: WireProfile): WireTriple {
  const mod = evalWireModule(compileWireModule([{ name, ref }], [profile]));
  return mod[wireValidatorKey(name, profile.name)]!;
}

/** Compile+evaluate one `compileWireEntryFragmentComposite` fragment via
 * `assembleWireModule` — same realistic, full-module-assembly path
 * `evalWireEntry` uses for the base (non-composite) fragments, with a single
 * synthetic profile name ("composite") standing in for the ad-hoc per-field
 * profile assignment under test (`assembleWireModule` only ever uses a
 * profile name as a map key — it attaches no meaning to it beyond that). */
function evalCompositeEntry(
  name: string,
  ref: TypeRef,
  fieldProfiles: Readonly<Record<string, WireProfile>>,
  defaultProfile: WireProfile,
): WireTriple {
  const constraints = compileConstraintsFn(name, ref);
  const frag = compileWireEntryFragmentComposite(
    ref,
    fieldProfiles,
    defaultProfile,
    constraints.fnName,
  );
  const source = assembleWireModule(
    [{ name }],
    ["composite"],
    { [name]: constraints },
    { [wireValidatorKey(name, "composite")]: frag },
  );
  const mod = evalWireModule(source);
  return mod[wireValidatorKey(name, "composite")]!;
}

describe("wire profiles — per-profile emission", () => {
  it("argv: coerces a numeric string field, rejects a non-numeric one", () => {
    const ref = t(types.object({ page: t(types.number) }));
    const v = evalWireEntry("Page", ref, argvProfile);
    expect(v.parse({ page: "42" })).toEqual({ kind: "ok", value: { page: 42 } });
    const err = v.parse({ page: "abc" }) as { kind: "err"; errors: ValidationError[] };
    expect(err.kind).toBe("err");
    expect(err.errors[0]!.kind).toBe("encoding");
  });

  it("query: same numeric-string coercion as argv", () => {
    const ref = t(types.object({ page: t(types.number) }));
    const v = evalWireEntry("Page", ref, queryProfile);
    expect(v.parse({ page: "7" })).toEqual({ kind: "ok", value: { page: 7 } });
  });

  it("json: numbers/booleans/strings arrive already typed, no coercion", () => {
    const ref = t(types.object({ count: t(types.number), active: t(types.boolean) }));
    const v = evalWireEntry("Counter", ref, jsonProfile);
    expect(v.parse({ count: 3, active: true })).toEqual({
      kind: "ok",
      value: { count: 3, active: true },
    });
    // A numeric string is a wire-shape violation under json (typed wire, no
    // coercion) — unlike argv/query, where the same input coerces.
    const err = v.parse({ count: "3", active: true }) as { kind: "err"; errors: ValidationError[] };
    expect(err.kind).toBe("err");
    expect(err.errors[0]!.kind).toBe("type");
  });

  it("json: date/datetime still coerce from an ISO string (JSON has no date literal)", () => {
    const ref = t(types.object({ createdAt: datetime() }));
    const v = evalWireEntry("Event", ref, jsonProfile);
    const ok = v.parse({ createdAt: "2024-01-01T00:00:00.000Z" }) as {
      kind: "ok";
      value: { createdAt: Date };
    };
    expect(ok.kind).toBe("ok");
    expect(ok.value.createdAt).toBeInstanceOf(Date);
  });

  it("identity: no coercion at all — a numeric string is an encoding error, not a decode", () => {
    const ref = t(types.object({ count: t(types.number) }));
    const v = evalWireEntry("Counter", ref, identityProfile);
    expect(v.parse({ count: 3 })).toEqual({ kind: "ok", value: { count: 3 } });
    const err = v.parse({ count: "3" }) as { kind: "err"; errors: ValidationError[] };
    expect(err.kind).toBe("err");
    expect(err.errors[0]!.kind).toBe("type");
  });

  it("identity IS strict validation: full constraint check still runs (min/max on T)", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 0, maximum: 130 }) }));
    const v = evalWireEntry("Person", ref, identityProfile);
    const err = v.parse({ age: 200 }) as { kind: "err"; errors: ValidationError[] };
    expect(err.kind).toBe("err");
    expect(err.errors[0]!.kind).toBe("max");
  });
});

describe("wire profiles — strict boolean encoding", () => {
  it('query: only "true"/"false" strings, no native boolean, no loose spellings', () => {
    const ref = t(types.object({ active: t(types.boolean) }));
    const v = evalWireEntry("Flag", ref, queryProfile);
    expect(v.parse({ active: "true" })).toEqual({ kind: "ok", value: { active: true } });
    expect(v.parse({ active: "false" })).toEqual({ kind: "ok", value: { active: false } });
    expect((v.parse({ active: "1" }) as { kind: "err" }).kind).toBe("err");
    expect((v.parse({ active: "yes" }) as { kind: "err" }).kind).toBe("err");
    expect((v.parse({ active: true }) as { kind: "err" }).kind).toBe("err");
  });

  it('argv: native true/false sentinel OR strict "true"/"false" strings, no loose spellings', () => {
    const ref = t(types.object({ verbose: t(types.boolean) }));
    const v = evalWireEntry("Flags", ref, argvProfile);
    expect(v.parse({ verbose: true })).toEqual({ kind: "ok", value: { verbose: true } });
    expect(v.parse({ verbose: "true" })).toEqual({ kind: "ok", value: { verbose: true } });
    expect(v.parse({ verbose: "false" })).toEqual({ kind: "ok", value: { verbose: false } });
    expect((v.parse({ verbose: "1" }) as { kind: "err" }).kind).toBe("err");
    expect((v.parse({ verbose: "yes" }) as { kind: "err" }).kind).toBe("err");
  });
});

describe("wire profiles — ValidWire typing", () => {
  it("argv: a number field's ValidWire type is string", () => {
    expect(wireTypeText(t(types.number), argvProfile)).toBe("string");
  });

  it("argv: a boolean field's ValidWire type is the boolean|string-literal union", () => {
    expect(wireTypeText(t(types.boolean), argvProfile)).toBe(`boolean | "true" | "false"`);
  });

  it("query: a boolean field's ValidWire type is the strict string-literal union", () => {
    expect(wireTypeText(t(types.boolean), queryProfile)).toBe(`"true" | "false"`);
  });

  it("identity: a number field's ValidWire type is number (no coercion, wire IS T)", () => {
    expect(wireTypeText(t(types.number), identityProfile)).toBe("number");
  });

  it("object: every field renders optional in ValidWire, regardless of meta.optional", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.number) }));
    expect(wireTypeText(ref, argvProfile)).toBe(`{ "id"?: string; "age"?: string }`);
  });

  it("array of a coerced leaf renders element-wise", () => {
    const ref = t(types.array(t(types.number)));
    expect(wireTypeText(ref, argvProfile)).toBe("(string)[]");
  });
});

describe("wire profiles — defaults-fill", () => {
  it("fills a missing field's meta.default before constraint-checking, for every profile", () => {
    const ref = t(types.object({ limit: t(types.number, { default: 10, minimum: 1 }) }));
    for (const profile of [argvProfile, queryProfile, jsonProfile, identityProfile]) {
      const v = evalWireEntry("Query", ref, profile);
      expect(v.parse({})).toEqual({ kind: "ok", value: { limit: 10 } });
    }
  });

  it("a required field with no default still reports missing, post-fill (unchanged validateConstraints)", () => {
    const ref = t(types.object({ id: t(types.string) }));
    const v = evalWireEntry("Item", ref, argvProfile);
    const err = v.parse({}) as { kind: "err"; errors: ValidationError[] };
    expect(err.errors).toEqual([{ kind: "missing", path: ["id"] }]);
  });

  it("a caller-supplied value is unaffected by a field's default", () => {
    const ref = t(types.object({ limit: t(types.number, { default: 10 }) }));
    const v = evalWireEntry("Query", ref, argvProfile);
    expect(v.parse({ limit: "5" })).toEqual({ kind: "ok", value: { limit: 5 } });
  });
});

describe("wire profiles — shared constraint validator reused across profiles", () => {
  it("compileConstraintsFn's output is identical text regardless of which profile will call it", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 0 }) }));
    const a = compileConstraintsFn("Person", ref);
    const b = compileConstraintsFn("Person", ref);
    expect(a.lines.join("\n")).toBe(b.lines.join("\n"));
  });

  it("compileWireModule emits the constraints fn ONCE per entry even when requested for multiple profiles", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 0 }) }));
    const source = compileWireModule(
      [{ name: "Person", ref }],
      [argvProfile, jsonProfile, identityProfile],
    );
    const occurrences = source.split("function __constraints_Person(").length - 1;
    expect(occurrences).toBe(1);
  });

  it("the same min-constraint violation is caught identically whether reached via argv or json", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 0 }) }));
    const source = compileWireModule([{ name: "Person", ref }], [argvProfile, jsonProfile]);
    const mod = evalWireModule(source);
    const argvErr = mod[wireValidatorKey("Person", "argv")]!.parse({ age: "-5" }) as {
      kind: "err";
      errors: ValidationError[];
    };
    const jsonErr = mod[wireValidatorKey("Person", "json")]!.parse({ age: -5 }) as {
      kind: "err";
      errors: ValidationError[];
    };
    expect(argvErr.errors).toEqual(jsonErr.errors);
    expect(argvErr.errors[0]!.kind).toBe("min");
  });

  it("two DIFFERENT entries' constraints fns don't collide on hoisted const names when spliced into one module (regression, phase A/B bug)", () => {
    // Both entries' `age`-shaped field triggers a `type`-kind error referencing a
    // hoisted `refLiteral` const inside `compileConstraintsFn`'s own `GenCtx`. Two
    // entries' independently-fresh `GenCtx`es can each mint the same `__ref0` name,
    // producing a duplicate `const __ref0 = ...` when spliced into one module's
    // shared scope (`assembleWireModule`) — evaluating the module (not just
    // generating its source text) is the real assertion here, since a duplicate
    // `const` is a SyntaxError at eval/transpile time.
    const refA = t(types.object({ age: t(types.number, { minimum: 0 }) }));
    const refB = t(types.object({ age: t(types.number, { minimum: 0 }) }));
    const source = compileWireModule(
      [
        { name: "PersonA", ref: refA },
        { name: "PersonB", ref: refB },
      ],
      [argvProfile],
    );
    expect(() => evalWireModule(source)).not.toThrow();
    const mod = evalWireModule(source);
    const okA = mod[wireValidatorKey("PersonA", "argv")]!.parse({ age: "5" });
    const okB = mod[wireValidatorKey("PersonB", "argv")]!.parse({ age: "5" });
    expect(okA).toEqual({ kind: "ok", value: { age: 5 } });
    expect(okB).toEqual({ kind: "ok", value: { age: 5 } });
  });

  it("wireValidatorKey joins with a real space, not a NUL byte (regression, phase A byte-level bug)", () => {
    expect(wireValidatorKey("Person", "argv")).toBe("Person argv");
    expect(wireValidatorKey("Person", "argv")).not.toContain("\u0000");
  });
});

describe("wire profiles — error phrasing per stage", () => {
  it("encoding-stage error is phrased against the WIRE (expected: a shape description string)", () => {
    const ref = t(types.object({ page: t(types.number) }));
    const v = evalWireEntry("Page", ref, argvProfile);
    const err = v.parse({ page: "abc" }) as { kind: "err"; errors: ValidationError[] };
    expect(err.errors[0]).toEqual({
      kind: "encoding",
      path: ["page"],
      expected: "numeric string (number)",
      actual: "abc",
    });
  });

  it("constraint-stage error is phrased against T (expected: a number, not a wire description)", () => {
    const ref = t(types.object({ age: t(types.number, { minimum: 18 }) }));
    const v = evalWireEntry("Person", ref, argvProfile);
    const err = v.parse({ age: "10" }) as { kind: "err"; errors: ValidationError[] };
    expect(err.errors[0]).toEqual({
      kind: "min",
      path: ["age"],
      expected: 18,
      actual: 10,
      exclusive: false,
    });
  });

  it("a wholly wrong wire shape (object expected, got an array) is an encoding error, not a type error", () => {
    const ref = t(types.object({ id: t(types.string) }));
    const v = evalWireEntry("Item", ref, argvProfile);
    const err = v.parse([1, 2, 3]) as { kind: "err"; errors: ValidationError[] };
    expect(err.errors).toEqual([
      { kind: "encoding", path: [], expected: "object", actual: [1, 2, 3] },
    ]);
  });
});

describe("wire profiles — composite per-field profiles (compileWireEntryFragmentComposite)", () => {
  it("each field's OWN profile encoding applies, and does not leak to the other field", () => {
    const ref = t(types.object({ count: t(types.number), startedAt: datetime() }));
    const v = evalCompositeEntry(
      "Mixed",
      ref,
      { count: queryProfile, startedAt: jsonProfile },
      identityProfile,
    );
    // `count` under queryProfile: a numeric string coerces.
    const ok = v.parse({ count: "42", startedAt: "2024-01-01T00:00:00.000Z" }) as {
      kind: "ok";
      value: { count: number; startedAt: Date };
    };
    expect(ok.kind).toBe("ok");
    expect(ok.value.count).toBe(42);
    expect(ok.value.startedAt).toBeInstanceOf(Date);

    // `startedAt` under jsonProfile does not accept queryProfile's numeric-string
    // coercion rule leaking over: a non-ISO-string value is an encoding error.
    const badDate = v.parse({ count: "42", startedAt: 12345 }) as {
      kind: "err";
      errors: ValidationError[];
    };
    expect(badDate.kind).toBe("err");
    expect(badDate.errors[0]!.kind).toBe("encoding");

    // `count` under queryProfile does not fall back to jsonProfile/identity's
    // "must already be a number" rule — a non-numeric string is a (query-shaped)
    // encoding error, not silently accepted as a string.
    const badCount = v.parse({ count: "abc", startedAt: "2024-01-01T00:00:00.000Z" }) as {
      kind: "err";
      errors: ValidationError[];
    };
    expect(badCount.kind).toBe("err");
    expect(badCount.errors[0]!.kind).toBe("encoding");
  });

  it("a field absent from fieldProfiles falls back to defaultProfile", () => {
    const ref = t(types.object({ count: t(types.number), other: t(types.number) }));
    const v = evalCompositeEntry("Mixed2", ref, { count: queryProfile }, identityProfile);
    // `other` isn't in fieldProfiles → defaultProfile (identity): no coercion.
    const err = v.parse({ count: "1", other: "2" }) as { kind: "err"; errors: ValidationError[] };
    expect(err.kind).toBe("err");
    expect(err.errors[0]!.kind).toBe("type");
  });

  it("a non-object top-level ref delegates to compileWireEntryFragment (defaultProfile only)", () => {
    const ref = t(types.number);
    const v = evalCompositeEntry("Bare", ref, { irrelevant: queryProfile }, queryProfile);
    expect(v.parse("7")).toEqual({ kind: "ok", value: 7 });
  });
});

describe("wire profiles — defs/ref recursion (phase D)", () => {
  // A self-recursive def: Category.parent: Category — per finalizeSharedDefs'
  // "always shared" rule (from-typescript.ts), a self-recursive type is
  // always shared regardless of `shouldShare`. This is the concrete shape a
  // `ref` under a wire profile needs to actually recurse into, rather than
  // falling through as a structural no-op with no coercion/recursion at all.
  const categoryRef = t(
    types.object({
      name: t(types.string),
      age: t(types.number, { minimum: 0 }),
      parent: t(types.ref("Category"), { optional: true }),
    }),
  );
  const defs = { Category: categoryRef };

  it("a self-recursive def decodes correctly through a wire profile — argv's numeric-string coercion recurses into `parent`", () => {
    const source = compileWireModule([{ name: "Category", ref: categoryRef }], [argvProfile], {
      defs,
    });
    const mod = evalWireModule(source);
    const v = mod[wireValidatorKey("Category", "argv")]!;
    const wire = { name: "child", age: "5", parent: { name: "root", age: "10" } };
    const result = v.parse(wire) as {
      kind: "ok";
      value: { name: string; age: number; parent?: { name: string; age: number } };
    };
    expect(result.kind).toBe("ok");
    expect(result.value).toEqual({ name: "child", age: 5, parent: { name: "root", age: 10 } });
  });

  it("a constraint violation nested inside the shared def's own field is still caught (constraints layer's ref delegation)", () => {
    const source = compileWireModule([{ name: "Category", ref: categoryRef }], [argvProfile], {
      defs,
    });
    const mod = evalWireModule(source);
    const v = mod[wireValidatorKey("Category", "argv")]!;
    const wire = { name: "child", age: "5", parent: { name: "root", age: "-1" } };
    const err = v.parse(wire) as { kind: "err"; errors: ValidationError[] };
    expect(err.kind).toBe("err");
    expect(err.errors[0]!.kind).toBe("min");
  });

  it("a type reused across two entries in one compileWireModule call compiles to ONE shared wire-decode function per profile", () => {
    const entryA = t(types.object({ cat: t(types.ref("Category")) }));
    const entryB = t(types.object({ cat: t(types.ref("Category")) }));
    const source = compileWireModule(
      [
        { name: "A", ref: entryA },
        { name: "B", ref: entryB },
      ],
      [argvProfile],
      { defs },
    );
    const occurrences = source.split("function __wiredecode_Category_argv(").length - 1;
    expect(occurrences).toBe(1);
    const mod = evalWireModule(source);
    const a = mod[wireValidatorKey("A", "argv")]!.parse({ cat: { name: "x", age: "1" } });
    const b = mod[wireValidatorKey("B", "argv")]!.parse({ cat: { name: "y", age: "2" } });
    expect(a).toEqual({ kind: "ok", value: { cat: { name: "x", age: 1 } } });
    expect(b).toEqual({ kind: "ok", value: { cat: { name: "y", age: 2 } } });
  });

  it("interaction with the GenCtx namespace fix (phase C): two entries + defs in one module doesn't regress the duplicate-const bug", () => {
    const refA = t(
      types.object({ age: t(types.number, { minimum: 0 }), cat: t(types.ref("Category")) }),
    );
    const refB = t(
      types.object({ age: t(types.number, { minimum: 0 }), cat: t(types.ref("Category")) }),
    );
    const source = compileWireModule(
      [
        { name: "PersonA", ref: refA },
        { name: "PersonB", ref: refB },
      ],
      [argvProfile],
      { defs },
    );
    expect(() => evalWireModule(source)).not.toThrow();
    const mod = evalWireModule(source);
    const okA = mod[wireValidatorKey("PersonA", "argv")]!.parse({
      age: "5",
      cat: { name: "x", age: "1" },
    });
    const okB = mod[wireValidatorKey("PersonB", "argv")]!.parse({
      age: "6",
      cat: { name: "y", age: "2" },
    });
    expect(okA).toEqual({ kind: "ok", value: { age: 5, cat: { name: "x", age: 1 } } });
    expect(okB).toEqual({ kind: "ok", value: { age: 6, cat: { name: "y", age: 2 } } });
  });

  it("a bare ref with no defs passed is still a structural no-op (prior behavior preserved)", () => {
    const v = evalWireEntry("Whatever", t(types.ref("Missing")), argvProfile);
    expect(v.parse("anything")).toEqual({ kind: "ok", value: "anything" });
  });
});

describe("wire profiles — object/array structural decode", () => {
  it("argv: array of numeric strings decodes element-wise", () => {
    const ref = t(types.object({ ids: t(types.array(t(types.number))) }));
    const v = evalWireEntry("Batch", ref, argvProfile);
    expect(v.parse({ ids: ["1", "2", "3"] })).toEqual({ kind: "ok", value: { ids: [1, 2, 3] } });
  });

  it("a field absent from the wire is left absent post-decode (no missing error at the encoding stage)", () => {
    const ref = t(
      types.object({ id: t(types.string), nickname: t(types.string, { optional: true }) }),
    );
    const v = evalWireEntry("Item", ref, argvProfile);
    const err = v.parse({ id: "x" }) as { kind: "ok"; value: { id: string; nickname?: string } };
    expect(err).toEqual({ kind: "ok", value: { id: "x" } });
  });
});
