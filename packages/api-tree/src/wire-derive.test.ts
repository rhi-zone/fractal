// Direct, hand-built-input tests for `deriveFieldProfiles` (wire-derive.ts) —
// see that file's doc comment and
// docs/design/wire-profiles-and-staged-validation.md's "Implementation trace
// (phase B)" section for the mechanism this exercises.

import { describe, expect, it } from "bun:test";
import { argvProfile, identityProfile, jsonProfile, queryProfile } from "@rhi-zone/fractal-type-ir";
import { deriveFieldProfiles } from "./wire-derive.ts";

describe("deriveFieldProfiles — uniform protocols", () => {
  it("identity: always identityProfile, no meta read", () => {
    expect(deriveFieldProfiles("identity", { anything: { store: "body" } }, "POST", ["x"])).toEqual(
      {
        profile: identityProfile,
      },
    );
  });

  it("mcp/graphql/jsonrpc: always jsonProfile, no meta read", () => {
    for (const protocol of ["mcp", "graphql", "jsonrpc"] as const) {
      expect(deriveFieldProfiles(protocol, undefined, undefined, [])).toEqual({
        profile: jsonProfile,
      });
    }
  });
});

describe("deriveFieldProfiles — cli", () => {
  it("no sourceMap, no path params: defaultProfile is argv (flag default)", () => {
    const result = deriveFieldProfiles("cli", undefined, undefined, []);
    expect(result).toEqual({ fieldProfiles: {}, defaultProfile: argvProfile });
  });

  it("a field matching a path-param name defaults to path store (still argv encoding)", () => {
    const result = deriveFieldProfiles("cli", undefined, undefined, ["bookId"]);
    expect(result).toEqual({ fieldProfiles: { bookId: argvProfile }, defaultProfile: argvProfile });
  });

  it("an explicit sourceMap override wins over the path-param default", () => {
    const result = deriveFieldProfiles("cli", { bookId: { store: "env" } }, undefined, ["bookId"]);
    // Both "path" and "env" map to argvProfile (CLI is uniform) — the point is
    // the override is READ (not ignored), even though the resulting profile
    // object happens to be identical either way.
    expect(result).toEqual({ fieldProfiles: { bookId: argvProfile }, defaultProfile: argvProfile });
  });
});

describe("deriveFieldProfiles — http", () => {
  it("GET: defaultProfile is query (queryProfile-style encoding)", () => {
    const result = deriveFieldProfiles("http", undefined, "GET", []);
    expect(result).toEqual({ fieldProfiles: {}, defaultProfile: queryProfile });
  });

  it("POST: defaultProfile is body (jsonProfile-style encoding)", () => {
    const result = deriveFieldProfiles("http", undefined, "POST", []);
    expect(result).toEqual({ fieldProfiles: {}, defaultProfile: jsonProfile });
  });

  it("a field matching a path-param name gets queryProfile-style encoding regardless of method", () => {
    const result = deriveFieldProfiles("http", undefined, "POST", ["bookId"]);
    expect(result).toEqual({
      fieldProfiles: { bookId: queryProfile },
      defaultProfile: jsonProfile,
    });
  });

  it("an explicit sourceMap override to body wins over a path-param name match", () => {
    const result = deriveFieldProfiles("http", { bookId: { store: "body" } }, "GET", ["bookId"]);
    expect(result).toEqual({
      fieldProfiles: { bookId: jsonProfile },
      defaultProfile: queryProfile,
    });
  });

  it("an explicit sourceMap override to header gets queryProfile-style (string) encoding", () => {
    const result = deriveFieldProfiles("http", { apiKey: { store: "header" } }, "POST", []);
    expect(result).toEqual({
      fieldProfiles: { apiKey: queryProfile },
      defaultProfile: jsonProfile,
    });
  });

  it("method defaults to GET's query-store posture when method is undefined", () => {
    const result = deriveFieldProfiles("http", undefined, undefined, []);
    expect(result).toEqual({ fieldProfiles: {}, defaultProfile: queryProfile });
  });
});
