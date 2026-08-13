// packages/api-tree/src/wire-apply-validation-hooks.test.ts
//
// Function-form `encodingMap` — the "one real gap" the phase-B trace in
// docs/design/wire-profiles-and-staged-validation.md documented ("a
// function-valued `encodingMap` entry is silently OMITTED") and this
// implementation closes. Covers:
//   - static existence detection (`readMetaEncodingMapFunctionFields`,
//     exercised indirectly through `extractWireApplyValidationTypeRefs`'s
//     `hookFields`)
//   - the generated module's `hookFields`/hook call-site shape
//   - end-to-end: a real decoder function, read off the tree's own `meta` at
//     WRAP time, decoding a value no built-in profile leaf handler could
//     (a plain-decimal dollar-amount numeric string, `"12.34"` -> `1234`
//     integer cents — see the fixture's own doc comment for why this ISN'T a
//     currency-symbol-prefixed string: a hooked field's wire shape check
//     still runs unmodified, decision 2)
//   - a decoder throw surfacing as a structured `"decode"` ValidationError
//   - both directions of the wrap-time stale-module mismatch (decision 5)
//   - fused<->hook fingerprint invalidation
//   - multi-protocol: one tree, one protocol hooks a field, another doesn't
//
// Uses the same evaluate-the-generated-module trick
// apply-validation-build.test.ts's own `evalModule` does, since this file
// needs a REAL runtime tree (with a real function under
// `meta.<proto>.encodingMap`), not just the fixture's own static shape.

import { describe, expect, it } from "bun:test";
import {
  buildWireApplyValidationModuleSource,
  buildWireApplyValidationModuleSourceIncremental,
  extractWireApplyValidationTypeRefs,
} from "./apply-validation-build.ts";
import {
  createApplyValidation,
  type GeneratedEntry,
  type WireValidatorMap,
} from "./apply-validation.ts";

const FIXTURE = `${import.meta.dir}/__fixtures__/wire-apply-validation-hooks.fixture.ts`;

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

function evalModule(source: string): { applyValidation: ReturnType<typeof createApplyValidation> } {
  const withoutImports = source
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n");
  const commonJs =
    tsTranspiler.transformSync(withoutImports).replaceAll("export const ", "const ") +
    "\nreturn { applyValidation };";
  return new Function("createApplyValidation", commonJs)(createApplyValidation);
}

describe("encodingMap function-form: static existence detection", () => {
  it("detects the hooked field for an http leaf, and leaves a non-hooked leaf's hookFields empty", () => {
    const { byKey } = extractWireApplyValidationTypeRefs(FIXTURE);
    expect(byKey["wire-hooks-http"]!.leaves["price"]!.hookFields).toEqual(["cents"]);
    expect(byKey["wire-hooks-none"]!.leaves["price"]!.hookFields).toEqual([]);
  });

  it("detects the hooked field for a cli leaf independently of http", () => {
    const { byKey } = extractWireApplyValidationTypeRefs(FIXTURE);
    expect(byKey["wire-hooks-cli"]!.leaves["price"]!.hookFields).toEqual(["cents"]);
  });

  it("multi-protocol: the SAME tree hooks `cents` under http but not under cli", () => {
    const { byKey } = extractWireApplyValidationTypeRefs(FIXTURE);
    expect(byKey["wire-hooks-mixed-http"]!.leaves["price"]!.hookFields).toEqual(["cents"]);
    expect(byKey["wire-hooks-mixed-cli"]!.leaves["price"]!.hookFields).toEqual([]);
  });
});

describe("encodingMap function-form: generated module shape", () => {
  it("embeds hookFields on the generated entry and emits a hook call-site referencing `hooks`", () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "./apply-validation.ts",
    });
    expect(source).toContain('hookFields: ["cents"]');
    expect(source).toContain("hooks[");
  });
});

/** A real, hand-built `Node`-shaped runtime tree carrying a real decoder
 * function at `meta.<proto>.encodingMap.cents` — standing in for what `api()`/
 * `op()` actually produce, the same "plain literal tree object" idiom
 * apply-validation-build.test.ts's own runtime-eval tests use (see that
 * file's "http/cli (query/argv-shaped) coerce a numeric-string..." test). */
function priceTree(protocol: "http" | "cli", decodeCents: (w: unknown) => unknown) {
  return {
    meta: {},
    children: {
      price: {
        meta: { [protocol]: { encodingMap: { cents: decodeCents } } },
        handler: (input: unknown) => input,
      },
    },
  };
}

const decodeCents = (wire: unknown): number => {
  if (typeof wire !== "string") throw new Error(`expected a numeric string, got ${typeof wire}`);
  const match = /^-?\d+(?:\.(\d+))?$/.exec(wire);
  if (!match) throw new Error(`not a plain decimal amount: ${JSON.stringify(wire)}`);
  const fractionalDigits = match[1] ?? "";
  if (fractionalDigits.length > 2) {
    throw new Error(`expected at most 2 decimal places (cents), got ${JSON.stringify(wire)}`);
  }
  return Math.round(Number(wire) * 100);
};

describe("encodingMap function-form: end-to-end runtime decode", () => {
  it("http: decodes a dollars-amount numeric-string wire value into integer cents — no built-in profile leaf handler does this interpretation", async () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "./apply-validation.ts",
    });
    const { applyValidation: wire } = evalModule(source);
    const tree = wire("wire-hooks-http", priceTree("http", decodeCents), "http") as {
      children: { price: { handler: (input: unknown) => unknown } };
    };
    const result = await tree.children.price.handler({ cents: "12.34" });
    expect(result).toEqual({ cents: 1234 });
  });

  it("cli: same decoder, argv wire shape", async () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "./apply-validation.ts",
    });
    const { applyValidation: wire } = evalModule(source);
    const tree = wire("wire-hooks-cli", priceTree("cli", decodeCents), "cli") as {
      children: { price: { handler: (input: unknown) => unknown } };
    };
    const result = await tree.children.price.handler({ cents: "5" });
    expect(result).toEqual({ cents: 500 });
  });

  it("a field with no hook (wire-hooks-none) still fuses its default numeric-string decode", async () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "./apply-validation.ts",
    });
    const { applyValidation: wire } = evalModule(source);
    const tree = wire(
      "wire-hooks-none",
      { meta: {}, children: { price: { meta: {}, handler: (input: unknown) => input } } },
      "http",
    ) as { children: { price: { handler: (input: unknown) => unknown } } };
    const result = await tree.children.price.handler({ cents: "1234" });
    expect(result).toEqual({ cents: 1234 });
  });
});

describe('encodingMap function-form: decoder throw -> structured "decode" error', () => {
  it("a throw inside the decoder surfaces as a `decode`-kind ValidationError, not an uncaught exception", async () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "./apply-validation.ts",
    });
    const { applyValidation: wire } = evalModule(source);
    const tree = wire("wire-hooks-http", priceTree("http", decodeCents), "http") as {
      children: { price: { handler: (input: unknown) => unknown } };
    };
    // "12.345" IS a numeric string (passes `numericStringLeaf`'s own
    // `validateEncoding` check unmodified — decision 2), so it reaches the
    // hook; the hook itself rejects more than 2 decimal places as not a
    // valid cents amount. This is exactly the distinction a `"decode"`
    // error exists to draw: wire-shape-valid, decoder-semantically-invalid.
    const result = (await tree.children.price.handler({ cents: "12.345" })) as {
      kind: string;
      error: { kind: string; path: string[]; message: string }[];
    };
    expect(result.kind).toBe("err");
    expect(result.error).toHaveLength(1);
    expect(result.error[0]!.kind).toBe("decode");
    expect(result.error[0]!.path).toEqual(["cents"]);
    expect(result.error[0]!.message).toContain("at most 2 decimal places");
  });

  it("a wire-shape-invalid input (not even a string) is rejected as an `encoding` error, never reaching the hook", async () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "./apply-validation.ts",
    });
    const { applyValidation: wire } = evalModule(source);
    const tree = wire("wire-hooks-http", priceTree("http", decodeCents), "http") as {
      children: { price: { handler: (input: unknown) => unknown } };
    };
    // HTTP query encoding requires a numeric-string-SHAPED wire per the
    // default `numericStringLeaf` check; passing a boolean fails encoding
    // before decode's hook is even considered.
    const result = (await tree.children.price.handler({ cents: true })) as {
      kind: string;
      error: { kind: string }[];
    };
    expect(result.kind).toBe("err");
    expect(result.error[0]!.kind).toBe("encoding");
  });
});

describe("encodingMap function-form: wrap-time stale-module mismatch (both directions)", () => {
  it("direction (a): generated entry expects a hook the running tree's meta doesn't have -> throws at wrap time", () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "./apply-validation.ts",
    });
    const { applyValidation: wire } = evalModule(source);
    const treeMissingHook = {
      meta: {},
      children: { price: { meta: { http: {} }, handler: (input: unknown) => input } },
    };
    expect(() => wire("wire-hooks-http", treeMissingHook, "http")).toThrow(
      /expects a decoder hook/,
    );
  });

  it("direction (b): the running tree's meta has a function-valued encodingMap entry the generated entry doesn't expect -> throws at wrap time", () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "./apply-validation.ts",
    });
    const { applyValidation: wire } = evalModule(source);
    // "wire-hooks-none" was codegen'd with NO hookFields for `price` (see the
    // fixture's `httpTreeNoHook`) — wiring a tree that DOES carry a function
    // there is exactly codegen-ran-before-the-override-was-authored drift.
    const treeWithUnexpectedHook = priceTree("http", decodeCents);
    expect(() => wire("wire-hooks-none", treeWithUnexpectedHook, "http")).toThrow(
      /does not expect a hook/,
    );
  });
});

describe("encodingMap function-form: fused<->hook fingerprint invalidation", () => {
  it("a field's fingerprint changes when it gains a function-form encodingMap override", () => {
    const hooked = buildWireApplyValidationModuleSourceIncremental(FIXTURE, {});
    // Compare the SAME leaf shape (`price`, `{ cents: number }`) across two
    // call sites that differ ONLY in whether `cents` is hook-covered
    // (`wire-hooks-http` vs `wire-hooks-none`, both http, both GET) — any
    // fingerprint difference is attributable to the hook flip alone.
    const hookedFp = hooked.leafFingerprints["wire-hooks-http price http"];
    const unhookedFp = hooked.leafFingerprints["wire-hooks-none price http"];
    expect(hookedFp).toBeDefined();
    expect(unhookedFp).toBeDefined();
    expect(hookedFp).not.toBe(unhookedFp);
  });

  it("a leaf's own fingerprint (and artifact) carries forward unchanged when neither its ref nor its hookFields change", () => {
    const first = buildWireApplyValidationModuleSourceIncremental(FIXTURE, {});
    const second = buildWireApplyValidationModuleSourceIncremental(FIXTURE, {
      prior: {
        leafFingerprints: first.leafFingerprints,
        leafArtifacts: first.leafArtifacts,
        defNamesFingerprint: first.defNamesFingerprint,
      },
    });
    expect(second.changedLeaves).toEqual([]);
  });
});

describe("encodingMap function-form: GeneratedEntry hookFields is additive", () => {
  it("a hand-authored GeneratedEntry with no hookFields at all keeps working unchanged (parse called with one argument's worth of behavior)", async () => {
    const entry: GeneratedEntry = {
      parse: (value) => ({ kind: "ok", value }),
    };
    const wireValidators: WireValidatorMap = { k: { leaf: { http: entry } } };
    const applyValidation = createApplyValidation({}, wireValidators);
    const tree = applyValidation(
      "k",
      { meta: {}, children: { leaf: { meta: {}, handler: (input: unknown) => input } } },
      "http",
    ) as { children: { leaf: { handler: (input: unknown) => unknown } } };
    expect(await tree.children.leaf.handler("anything")).toBe("anything");
  });
});
