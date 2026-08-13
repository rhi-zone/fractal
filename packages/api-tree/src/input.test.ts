// packages/api-tree/src/input.test.ts — input resolution pipeline
//
// The `deployment-store.fixture.ts` side-effect import is load-bearing: it is
// this test suite's stand-in "deployment" augmentation (typed-store-spec §3),
// supplying the HTTP store fragment these tests read (`query`/`header`/`path`)
// plus one required service store to exercise §4's registration mechanism.
// Without it, `StoreRegistry` here is core's `caller`-only registry.

import { describe, expect, expectTypeOf, it } from "bun:test";
import "./__fixtures__/deployment-store.fixture.ts";
import { assemble } from "./input.ts";
import type {
  RequiredServiceStoreKeys,
  ServiceStores,
  Store,
  StoreRegistry,
  Stores,
} from "./input.ts";

/** A stand-in for whatever adapter a real deployment would register (§4). */
const tabularSource: StoreRegistry["tabularSource"] = {
  read: async (_sourceId: string) => ({ headers: [], rows: [] }),
};

/**
 * Build a full `Stores` bag for a test. `Stores` is no longer
 * blanket-optional — `caller` (core) and `tabularSource` (this suite's
 * stand-in deployment) are required members, so a test that only cares about
 * `query` still has to be honest about the rest of the bag.
 */
const storesOf = (data: Partial<Pick<Stores, "query" | "header" | "path" | "body">>): Stores => ({
  caller: {},
  tabularSource,
  ...data,
});

describe("assemble", () => {
  it("resolves params from the primary store by convention", () => {
    const stores = storesOf({ query: { a: "1", b: "2" } });
    const result = assemble(stores, ["a", "b"], {}, "query");
    expect(result).toEqual({ a: "1", b: "2" });
  });

  it("applies sourceMap overrides ahead of the primary store", () => {
    const stores = storesOf({
      query: { a: "from-query" },
      header: { a: "from-header" },
    });
    const result = assemble(stores, ["a"], { a: { store: "header" } }, "query");
    expect(result).toEqual({ a: "from-header" });
  });

  it("applies sourceMap overrides with a remapped key", () => {
    const stores = storesOf({
      query: {},
      header: { "x-a": "from-header-key" },
    });
    const result = assemble(stores, ["a"], { a: { store: "header", key: "x-a" } }, "query");
    expect(result).toEqual({ a: "from-header-key" });
  });

  it("prefers pathParamNames over sourceMap and primary store", () => {
    const stores = storesOf({
      path: { id: "path-id" },
      query: { id: "query-id" },
    });
    const result = assemble(stores, ["id"], { id: { store: "query" } }, "query", ["id"]);
    expect(result).toEqual({ id: "path-id" });
  });

  it("returns undefined values for params missing from their store", () => {
    const stores = storesOf({ query: {} });
    const result = assemble(stores, ["missing"], {}, "query");
    expect(result).toEqual({ missing: undefined });
  });
});

// ============================================================================
// Type-level regression tests — typed-store-spec.md §9
//
// These assert at COMPILE time (via `bun run typecheck`), not at runtime; the
// runtime bodies exist only so `bun test` reports them. A `@ts-expect-error`
// line that stops being an error fails typecheck with "Unused
// '@ts-expect-error' directive", so each negative case genuinely guards its
// invariant rather than silently passing.
// ============================================================================

describe("StoreRegistry carries real value types (§9(1))", () => {
  it("a member's value type is its declared shape, never `true`", () => {
    // §9(1): a `name: true` member is the defect this spec removed. `caller`
    // is core's own member; if it regressed to `true`, this assertion fails.
    expectTypeOf<StoreRegistry["caller"]>().toEqualTypeOf<Store>();
    expectTypeOf<StoreRegistry["caller"]>().not.toEqualTypeOf<true>();

    // A service store's members are reachable through the registry's value
    // type — the whole point of value-carrying members.
    expectTypeOf<StoreRegistry["tabularSource"]["read"]>().toBeFunction();

    expect(true).toBe(true);
  });
});

describe("Stores preserves each member's own optionality (§9(2))", () => {
  it("required members need no guard; optional members do", () => {
    const stores = storesOf({ query: { q: "x" } });

    // Required (core + service) — no `?.` needed. If `Stores` regressed to a
    // blanket-`?` mapped type, both of these would be errors.
    expectTypeOf(stores.caller).toEqualTypeOf<Store>();
    expectTypeOf(stores.tabularSource).toEqualTypeOf<StoreRegistry["tabularSource"]>();
    // Reaching straight through with no guard is the assertion: a blanket-`?`
    // `Stores` would make this line an error.
    void stores.tabularSource.read;

    // Optional (projector-built, per-request) — nullable, guard required.
    expectTypeOf(stores.query).toEqualTypeOf<Store | undefined>();
    // @ts-expect-error — `query` is optional; reading through it needs a guard
    void stores.query.q;
    void stores.query?.q;

    expect(true).toBe(true);
  });

  it("an undeclared store name is still a compile error", () => {
    const stores = storesOf({});
    // @ts-expect-error — `carrierPigeon` is not a registered store name
    void stores.carrierPigeon;

    expect(true).toBe(true);
  });
});

describe("service-store registration is single-shot and complete (§4, §9(6))", () => {
  it("a registration object missing a required service store is a compile error", () => {
    const complete: ServiceStores = { tabularSource };
    expect(complete.tabularSource).toBe(tabularSource);

    // @ts-expect-error — `tabularSource` is a required service store; an empty
    // registration object is rejected AT THE REGISTRATION SITE, which is the
    // property §4 exists to provide.
    const incomplete: ServiceStores = {};
    void incomplete;

    expect(true).toBe(true);
  });

  it("RequiredServiceStoreKeys excludes core-owned and projector-built members", () => {
    // `caller` is required but core-owned (a projector builds it per-request),
    // so it is NOT something a deployment registers.
    expectTypeOf<RequiredServiceStoreKeys>().toEqualTypeOf<"tabularSource">();

    expect(true).toBe(true);
  });
});
