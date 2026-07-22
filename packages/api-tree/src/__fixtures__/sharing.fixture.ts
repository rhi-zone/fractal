// packages/api-tree/src/__fixtures__/sharing.fixture.ts
//
// A Node tree exercising structural sharing (Address reused across three
// tools) and self-recursion (Category.parent points back at Category) for
// extract.test.ts's SharingRegistry/shouldShare/finalizeSharedDefs tests.

import { api, op } from "../node.ts"

interface Address {
  street: string
  city: string
  zip: string
  country: string
  region: string
  landmark: string
}

interface Category {
  name: string
  parent?: Category
}

function getUser(input: { id: string }): { name: string; billing: Address; shipping: Address } {
  return { name: "x", billing: {} as Address, shipping: {} as Address }
}

function getOrder(input: { id: string }): { total: number; address: Address } {
  return { total: 1, address: {} as Address }
}

function getProduct(input: { id: string }): { name: string; category: Category } {
  return { name: "x", category: {} as Category }
}

export const tree = api({
  getUser: op(getUser),
  getOrder: op(getOrder),
  getProduct: op(getProduct),
})
