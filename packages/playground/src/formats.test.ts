// packages/playground/src/formats.test.ts — format registry lookup tests

import { describe, expect, test } from "bun:test";
import { inputFormatById, inputFormats, outputFormatById, outputFormats } from "./formats.ts";

describe("inputFormatById", () => {
  test("resolves a known id", () => {
    expect(inputFormatById("json-schema")?.label).toBe("JSON Schema");
  });

  test("returns undefined for an unknown id", () => {
    expect(inputFormatById("not-a-real-format")).toBeUndefined();
  });

  test("every input format carries a non-empty sample", () => {
    for (const format of inputFormats) {
      expect(format.sample, `${format.id} should have a sample`).toBeDefined();
      expect(format.sample?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  test("input format ids are unique", () => {
    const ids = inputFormats.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("outputFormatById", () => {
  test("resolves a known id", () => {
    expect(outputFormatById("typescript")?.label).toBe("TypeScript");
  });

  test("returns undefined for an unknown id", () => {
    expect(outputFormatById("not-a-real-format")).toBeUndefined();
  });

  test("output format ids are unique", () => {
    const ids = outputFormats.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
