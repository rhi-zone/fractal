// packages/cli-api-projector/src/cli-validators.test.ts — @rhi-zone/fractal-cli-api-projector
//
// Generated-validator wiring: `runCli`'s `opts.rewriters` runs
// `applyValidation(key, tree)` (@rhi-zone/fractal-api-tree/apply-validation)
// on `rootNode` before dispatch, wrapping a covered leaf's handler to run
// `parse()` (decode + validation) before the handler ever sees its input.
// There is no local fallback anymore (see
// docs/design/wire-profiles-and-staged-validation.md, "What goes away"): a
// leaf `applyValidation` doesn't cover gets the raw assembled wire values
// (`buildInput`'s output — argv's `string | string[] | true` shape,
// untouched) passed straight to its handler, unvalidated. These tests build
// their `GeneratedEntry`s directly (a synthetic `parse()`, not real codegen
// output) — a full codegen-driven `applyValidation(key, tree, "cli")` test
// through a generated wire validator would need a fixture built via
// api-tree's `apply-validation-build.ts` machinery (see e.g.
// packages/api-tree/src/__fixtures__/wire-apply-validation.fixture.ts), which
// this pass didn't build; that's a coverage gap, not a claim that the wire
// profile path itself is untested (it has its own tests in api-tree).

import { describe, it, expect } from "bun:test";
import { runCli, CliError } from "./cli.ts";
import { api, op } from "@rhi-zone/fractal-api-tree/node";
import { createApplyValidation } from "@rhi-zone/fractal-api-tree/apply-validation";
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/apply-validation";

function makeMockIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: {
        write: (s: string) => {
          out.push(s);
        },
      },
      stderr: {
        write: (s: string) => {
          err.push(s);
        },
      },
      confirm: async () => true,
    },
  };
}

/** A synthetic GeneratedEntry: requires `qty` to be a numeric string,
 * coercing it to a number on success. */
function qtyEntry(): GeneratedEntry {
  return {
    parse: (value: unknown) => {
      if (typeof value !== "object" || value === null) {
        return {
          kind: "err",
          errors: [{ kind: "type", path: [], expected: "object", actual: value }],
        };
      }
      const v = value as Record<string, unknown>;
      if (typeof v.qty !== "string" || !/^\d+$/.test(v.qty)) {
        return {
          kind: "err",
          errors: [{ kind: "type", path: ["qty"], expected: "numeric string", actual: v.qty }],
        };
      }
      return { kind: "ok", value: { ...v, qty: Number(v.qty) } };
    },
  };
}

describe("runCli — generated validators wired via opts.rewriters' applyValidation", () => {
  const tree = api({
    widgets: api({
      create: op((input: { name: string; qty: number }) => input),
    }),
  });

  it("routes input through the generated validator's parse() before the handler runs", async () => {
    const mock = makeMockIO();
    const applyValidation = createApplyValidation({ gen: { "widgets/create": qtyEntry() } });
    await runCli(tree, ["widgets", "create", "--name", "Widget", "--qty", "3"], mock.io, {
      rewriters: [(t) => applyValidation("gen", t)],
    });
    const result = JSON.parse(mock.out.join(""));
    expect(result).toEqual({ name: "Widget", qty: 3 });
  });

  it("a generated-validator rejection surfaces as a CliError and never calls the handler", async () => {
    let handlerCalled = false;
    const trackedTree = api({
      widgets: api({
        create: op((input: unknown) => {
          handlerCalled = true;
          return input;
        }),
      }),
    });
    const mock = makeMockIO();
    const applyValidation = createApplyValidation({ gen: { "widgets/create": qtyEntry() } });
    await expect(
      runCli(
        trackedTree,
        ["widgets", "create", "--name", "Widget", "--qty", "not-a-number"],
        mock.io,
        { rewriters: [(t) => applyValidation("gen", t)] },
      ),
    ).rejects.toThrow(CliError);
    expect(handlerCalled).toBe(false);
    expect(mock.err.join("")).toContain("Error:");
    expect(mock.err.join("")).toContain("numeric string");
  });

  it("a leaf with no matching generated-validator entry gets raw wire values, unvalidated — qty stays a string", async () => {
    const mock = makeMockIO();
    // A validator IS wired, but keyed under a DIFFERENT path — this leaf
    // isn't covered, so it gets no decode/validation at all: `--qty 3`
    // reaches the handler as the string "3", not the number 3.
    const applyValidation = createApplyValidation({ gen: { "other/path": qtyEntry() } });
    await runCli(tree, ["widgets", "create", "--name", "Widget", "--qty", "3"], mock.io, {
      rewriters: [(t) => applyValidation("gen", t)],
    });
    const result = JSON.parse(mock.out.join(""));
    expect(result).toEqual({ name: "Widget", qty: "3" });
  });

  it("without opts.rewriters at all, raw wire values reach the handler completely unvalidated", async () => {
    const mock = makeMockIO();
    await runCli(tree, ["widgets", "create", "--name", "Widget", "--qty", "3"], mock.io);
    const result = JSON.parse(mock.out.join(""));
    expect(result).toEqual({ name: "Widget", qty: "3" });
  });

  it("without opts.rewriters, a boolean flag value that isn't the bare `true` sentinel stays a string", async () => {
    const boolTree = api({
      widgets: api({
        toggle: op((input: { ready: unknown }) => input),
      }),
    });
    const mock = makeMockIO();
    await runCli(boolTree, ["widgets", "toggle", "--ready", "true"], mock.io);
    const result = JSON.parse(mock.out.join(""));
    // "true" the STRING (argv value), not the boolean `true` — no decode ran.
    expect(result).toEqual({ ready: "true" });
  });
});
