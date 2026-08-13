// packages/api-tree/src/__fixtures__/wire-apply-validation-hooks.fixture.ts
//
// Function-form `encodingMap` fixtures — the phase this fixture exercises is
// the "one real gap" the phase-B trace in docs/design/
// wire-profiles-and-staged-validation.md documented and this implementation
// closes: `meta.<proto>.encodingMap.<field>` authored as a custom decoder
// FUNCTION rather than a base-profile-name string.
//
// The canonical example the design doc's own task instructions used: a
// `cents` field, authored as `number`. A hook-covered field still runs its
// normal `validateEncoding` check unmodified (decision 2 — the design
// deliberately reuses `genWireEncodeDecode`'s existing per-kind leaf-handler
// statements rather than skipping them for a hooked field), so under HTTP
// query / CLI argv encoding the wire MUST already be a bare numeric string
// (`numericStringLeaf`'s own check) before the hook ever runs — a
// `"$12.34"`-style currency-symbol-prefixed string would fail THAT check,
// never reach the hook, and isn't what this fixture exercises. What no
// built-in leaf handler does, and what genuinely needs a custom decoder, is
// the NUMERIC INTERPRETATION: the wire's numeric string is a plain decimal
// DOLLAR amount (`"12.34"`), and the domain value the handler wants is
// INTEGER CENTS (`1234`) — `numericStringLeaf`'s own fused decode would give
// `12.34` (a `number`, unchanged), never `1234`.
//
// The function VALUE itself is authored here only so the fixture reads
// naturally end-to-end; codegen (`extractWireApplyValidationTypeRefs`) never
// reads it as a value — only its EXISTENCE, via
// `readMetaEncodingMapFunctionFields` (tree.ts). The real function only
// matters again at WRAP time, read off the actual running tree's `meta` by
// `apply-validation.ts`.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import "./wire-apply-validation-meta.fixture.ts";
import { api, op } from "../node.ts";
import { applyValidation } from "./apply-validation-stub.fixture.ts";

/** Parses a plain-decimal dollar-amount numeric string (`"12.34"`) -> `1234`
 * (integer cents). Deliberately nontrivial: this runs on a value that has
 * ALREADY passed `numericStringLeaf`'s own "is this a numeric string" check
 * (decision 2 reuses that check unmodified for a hooked field) — what no
 * built-in leaf handler does is the DOLLARS-TO-CENTS interpretation, and the
 * rejection of a >2-decimal-place amount below (numeric-string-valid, but
 * not a valid CENTS amount) is exactly the kind of decoder-level rejection
 * that becomes a `"decode"` `ValidationError`, distinct from an
 * `"encoding"` one. */
function decodeCents(wire: unknown): number {
  if (typeof wire !== "string") throw new Error(`expected a numeric string, got ${typeof wire}`);
  const match = /^-?\d+(?:\.(\d+))?$/.exec(wire);
  if (!match) throw new Error(`not a plain decimal amount: ${JSON.stringify(wire)}`);
  const fractionalDigits = match[1] ?? "";
  if (fractionalDigits.length > 2) {
    throw new Error(`expected at most 2 decimal places (cents), got ${JSON.stringify(wire)}`);
  }
  return Math.round(Number(wire) * 100);
}

const httpTree = api({
  price: op((input: { cents: number }) => ({ cents: input.cents }), {
    http: { method: "GET", encodingMap: { cents: decodeCents } },
  }),
});

const cliTree = api({
  price: op((input: { cents: number }) => ({ cents: input.cents }), {
    cli: { encodingMap: { cents: decodeCents } },
  }),
});

/** Same tree, HTTP hooks `cents` but CLI does NOT — the multi-protocol case
 * (a leaf shared across two protocols with only one protocol's namespace
 * declaring a function-form override). */
const mixedTree = api({
  price: op((input: { cents: number }) => ({ cents: input.cents }), {
    http: { method: "GET", encodingMap: { cents: decodeCents } },
  }),
});

/** A leaf with a STRING-form `encodingMap` override only (no function) —
 * fingerprint/cache-invalidation tests diff this against `httpTree` above to
 * prove a field's fused<->hook flip alone changes the leaf's fingerprint. */
const httpTreeNoHook = api({
  price: op((input: { cents: number }) => ({ cents: input.cents }), {
    http: { method: "GET" },
  }),
});

export const http = applyValidation("wire-hooks-http", httpTree, "http");
export const cli = applyValidation("wire-hooks-cli", cliTree, "cli");
export const mixedHttp = applyValidation("wire-hooks-mixed-http", mixedTree, "http");
export const mixedCli = applyValidation("wire-hooks-mixed-cli", mixedTree, "cli");
export const noHook = applyValidation("wire-hooks-none", httpTreeNoHook, "http");
