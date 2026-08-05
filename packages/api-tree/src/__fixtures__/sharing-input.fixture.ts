// packages/api-tree/src/__fixtures__/sharing-input.fixture.ts
//
// Same Address-reuse + Category-recursion shapes as sharing.fixture.ts, but
// on the INPUT side (build.test.ts's now-deleted buildValidatorModuleSource
// only compiled input types) — for testing the shouldShare opt-in end-to-end
// through the extraction pipeline (extractRouteTypeRefs), and (via
// apply-validation-sharing-input.fixture.ts) through the applyValidation
// codegen pipeline's own shouldShare opt-in.

import { api, op } from "../node.ts"

interface Address {
  street: string
  city: string
  zip: string
  country: string
  region: string
  landmark: string
}

function setBilling(_input: { userId: string; billing: Address }): { ok: boolean } {
  return { ok: true }
}

function setShipping(_input: { userId: string; shipping: Address }): { ok: boolean } {
  return { ok: true }
}

export const tree = api({
  setBilling: op(setBilling),
  setShipping: op(setShipping),
})
