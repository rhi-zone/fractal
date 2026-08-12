import { GlobalRegistrator } from "@happy-dom/global-registrator"

// Must register the DOM globals before anything below touches `document`/
// `window` — react-dom/client's `createRoot` needs a real DOM to mount into,
// and this package (unlike packages/playground/, a browser Vite app) has no
// browser runtime of its own, only `bun test`'s Node-shaped environment.
// `bun test` loads every *.test.tsx in one process, and GlobalRegistrator
// throws if `.register()` runs twice — guard against whichever test file
// happens to import (and register) first.
try {
  GlobalRegistrator.register()
} catch {
  // already registered by another test file in this same process
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { ApiExplorer } from "./api-explorer.tsx"
import { ApiExplorerFetchProvider } from "./fetch-context.tsx"

// ============================================================================
// Real-verification test: renders <ApiExplorer/> into a real (happy-dom) DOM,
// clicks its "Send" button, and asserts the response shown on screen came
// from an ACTUAL in-process request run through http-api-projector's real
// `createFetch` + `toDropInFetch` — the same adapter
// docs/design/mocked-fetch-backend.md resolved as the doc-embed integration
// point. Nothing here is a mock of the component's own fetch call: the
// tree's handler genuinely executes, genuine routing/validation happens, and
// the assertion below reads the genuine `Response` body back out of the
// rendered DOM. This is the "actually render/build against a fixture route"
// check called for — not just a compile check.
//
// http-api-projector's own source is imported by RELATIVE path rather than
// its package name (`@rhi-zone/fractal-http-api-projector`): this package
// isn't (yet) registered in the root workspaces array (a sibling in-flight
// change owns that file right now — see this session's handoff), so no
// `node_modules/@rhi-zone/fractal-http-api-projector` symlink exists for a
// bare-specifier import to resolve against here. A relative import bypasses
// package resolution entirely; the imported files' OWN internal bare
// imports (e.g. preset.ts's `@rhi-zone/fractal-api-tree`) still resolve
// correctly regardless, since Node/Bun resolution is always rooted at the
// IMPORTING file's own location (packages/http-api-projector/src/, which
// already has its own node_modules) — not at this test file's location.
// ============================================================================

import { api, op } from "../../api-tree/src/index.ts"
import { http } from "../../http-api-projector/src/verbs.ts"
import { createFetch, toDropInFetch } from "../../http-api-projector/src/preset.ts"

const books = [{ id: "1", title: "Fractal Reference" }]

const tree = api({
  books: api({
    list: op(() => books, http.get),
  }),
})

const realFetch = toDropInFetch(createFetch(tree))

async function flush(times = 5): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
    }
  })
}

describe("ApiExplorer", () => {
  test("Send issues a real request through the provided fetch and renders the real response", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <ApiExplorerFetchProvider fetch={realFetch}>
          <ApiExplorer method="GET" path="/books/list" responseSchema={{ type: "array" }} />
        </ApiExplorerFetchProvider>,
      )
    })

    const button = container.querySelector("button")
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe("Send")

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })

    const responseEl = container.querySelector('[data-testid="api-explorer-response"]')
    expect(responseEl).not.toBeNull()
    expect(responseEl?.textContent).toContain("200")

    const bodyEl = container.querySelector(".api-explorer-response-body")
    const parsed = JSON.parse(bodyEl?.textContent ?? "null")
    expect(parsed).toEqual(books)

    root.unmount()
    container.remove()
  })

  test("a route with a {param} segment renders one input per param, defaulted into the shown request URL", async () => {
    // Wildcard path params are authored via a tree `fallback` (see
    // http-manifest.test.ts's own "/books/:bookId" fixture) — the segment
    // name becomes both the URL wildcard and the bound input field.
    // (Simulating an actual keystroke into this input and re-asserting the
    // interpolated URL is covered at the unit level instead, in
    // path-template.test.ts — see that file's own comment for why: React's
    // controlled-input value tracking isn't reliably simulatable in this
    // package's happy-dom test environment. This test stays DOM-level for
    // what a DOM environment CAN reliably prove: the params UI renders and
    // the live path preview reflects `interpolatePath`'s real output.)
    const echoTree = api({
      items: api(
        {},
        {
          fallback: {
            name: "id",
            subtree: api({
              get: op((input: { id: string }) => ({ id: input.id }), http.get, http.moveTo("..")),
            }),
          },
        },
      ),
    })
    const fetchImpl = toDropInFetch(createFetch(echoTree))

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <ApiExplorerFetchProvider fetch={fetchImpl}>
          <ApiExplorer method="GET" path="/items/{id}" responseSchema={{ type: "object" }} />
        </ApiExplorerFetchProvider>,
      )
    })

    const input = container.querySelector("input")
    expect(input).not.toBeNull()
    expect(input?.placeholder).toBe("id")
    // No value entered yet: the empty-param interpolation this test can't
    // simulate typing into is the same `interpolatePath(path, {})` case
    // path-template.test.ts asserts directly ("/books/{id}" -> "/books/").
    expect(container.querySelector(".api-explorer-path")?.textContent).toBe("/items/")

    root.unmount()
    container.remove()
  })
})
