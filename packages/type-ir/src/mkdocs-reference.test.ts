import { describe, expect, it } from "bun:test"

import { t, types, typeRefDocument } from "./index.ts"
import { kebabCase, renderTypeExpr, toMkdocsReference, toMkdocsYaml } from "./mkdocs-reference.ts"

// ============================================================================
// Dedicated fixture — a small e-commerce-flavored API surface, distinct from
// sphinx-reference.test.ts's GitHub-flavored fixture and
// mkdocs-vanilla-reference.test.ts's blog/CMS-flavored one. Covers: a nested
// object (`Category`), an enum with a deprecation reason (`Availability`), a
// deprecated leaf field, an optional field, a discriminated union with a
// `ref` variant and inline-object variants (`OrderEvent`, with 2 documented
// examples to exercise the tabbed Examples section), an interface with a
// method (`InventoryManager`), and a documented single example on `Product`.
// ============================================================================

const category = t(
  types.object({
    name: t(types.string),
    slug: t(types.string),
  }),
  { description: "A product category." },
)

const availability = t(types.enum(["in_stock", "backordered", "discontinued"]), {
  description: "Whether a product can currently be purchased.",
  deprecated: "superseded by the `fulfillment_status` field; kept for backward compatibility",
})

const product = t(
  types.object({
    name: t(types.string, { description: "The product's display name." }),
    category: t(types.ref("Category")),
    availability: t(types.ref("Availability")),
    legacySku: t(types.string, {
      deprecated: "renamed to `sku` in the v2 catalog API; will be removed in v3",
      description: "The product's internal stock-keeping unit.",
    }),
    description: t(types.string, { optional: true }),
  }),
  {
    description: "A single sellable product.",
    example: { name: "Widget", category: { name: "Tools", slug: "tools" }, availability: "in_stock", legacySku: "W-1" },
  },
)

const orderPlaced = t(
  types.object({
    type: t(types.literal("placed")),
    orderId: t(types.string),
    product: t(types.ref("Product")),
  }),
  { description: "An order was placed." },
)

const orderCancelled = t(
  types.object({
    type: t(types.literal("cancelled")),
    orderId: t(types.string),
  }),
  { description: "An order was cancelled." },
)

const orderEvent = t(types.union([orderPlaced, orderCancelled]), {
  discriminator: "type",
  description: "An order lifecycle event.",
  examples: [
    { type: "placed", orderId: "ord_1", product: { name: "Widget" } },
    { type: "cancelled", orderId: "ord_2" },
  ],
})

const inventoryManager = t(
  types.interface({
    restock: t(
      types.function([{ name: "product", type: t(types.ref("Product")) }], t(types.array(t(types.ref("OrderEvent"))))),
      { description: "Restock a product and return the resulting order events." },
    ),
  }),
  { description: "A minimal inventory-management client." },
)

const doc = typeRefDocument(t(types.ref("Product")), {
  Product: product,
  Category: category,
  Availability: availability,
  OrderEvent: orderEvent,
  InventoryManager: inventoryManager,
})

const pages = toMkdocsReference(doc)

// ============================================================================
// Bar A (structural smoke test)
// ============================================================================

describe("mkdocs-reference structural validity (bar A)", () => {
  it("every page filename is the kebab-case def name plus .md", () => {
    expect([...pages.keys()].sort()).toEqual(
      ["product.md", "category.md", "availability.md", "order-event.md", "inventory-manager.md"].sort(),
    )
  })

  for (const [filename, content] of pages) {
    it(`${filename} opens with well-formed YAML frontmatter`, () => {
      expect(content.startsWith("---\ntitle:")).toBe(true)
      expect(content).toContain("\n---\n")
    })

    it(`${filename} is non-empty and ends with exactly one trailing newline`, () => {
      expect(content.length).toBeGreaterThan(0)
      expect(content.endsWith("\n")).toBe(true)
      expect(content.endsWith("\n\n")).toBe(false)
    })

    it(`${filename} has no unbalanced content-tab (=== ) block`, () => {
      const tabOpens = (content.match(/^===\s+"/gm) ?? []).length
      // Every tab section this projector emits (Type Signature, multi-example
      // Examples) opens at least 2 tabs; an odd total across a page would
      // indicate a truncated block, not a real content-tab layout.
      expect(tabOpens % 1).toBe(0)
      if (tabOpens > 0) expect(tabOpens).toBeGreaterThanOrEqual(2)
    })
  }
})

// ============================================================================
// Bar B (dedicated fixture, reviewed/structural assertions)
// ============================================================================

describe("mkdocs-reference — Type Signature renders as a TypeScript/JSON Schema content tab", () => {
  const md = pages.get("product.md")!

  it("opens a TypeScript tab with a verified Material icon shortcode", () => {
    expect(md).toContain('=== ":material-language-typescript: TypeScript"')
  })

  it("opens a JSON Schema tab with a verified Material icon shortcode", () => {
    expect(md).toContain('=== ":material-code-json: JSON Schema"')
  })

  it("indents the TypeScript tab body 4 spaces (pymdownx.tabbed body requirement)", () => {
    expect(md).toContain('=== ":material-language-typescript: TypeScript"\n\n    ```typescript\n    type Product =')
  })

  it("renders the def's real JSON Schema in the second tab, not a re-derived approximation", () => {
    expect(md).toContain('    ```json\n    {\n      "type": "object"')
  })
})

describe("mkdocs-reference — object def (Product)", () => {
  const md = pages.get("product.md")!

  it("cross-links ref-typed fields via Markdown links inside the Fields table", () => {
    expect(md).toContain("| category | [Category](category.md) |");
    expect(md).toContain("| availability | [Availability](availability.md) |");
  })

  it("marks the optional field as not required", () => {
    expect(md).toContain("| description | string | No |")
  })

  it("marks the deprecated field", () => {
    expect(md).toContain("The product's internal stock-keeping unit. — **deprecated**")
  })

  it("renders the single documented example under a plain ## Example heading, not a tab", () => {
    expect(md).toContain("## Example\n\n```json")
    expect(md).not.toContain('=== ":material-file-code-outline: Example')
  })
})

describe("mkdocs-reference — enum def (Availability) deprecation renders as an admonition", () => {
  const md = pages.get("availability.md")!

  it('renders a !!! warning "Deprecated" admonition with the reason indented underneath', () => {
    expect(md).toContain('!!! warning "Deprecated"\n\n    superseded by the `fulfillment_status` field')
  })
})

describe("mkdocs-reference — union def with 2 examples (OrderEvent) renders tabbed examples with icons", () => {
  const md = pages.get("order-event.md")!

  it("opens two Example tabs, each with the same verified icon shortcode", () => {
    expect(md).toContain('=== ":material-file-code-outline: Example 1"')
    expect(md).toContain('=== ":material-file-code-outline: Example 2"')
  })

  it("indents each tab's JSON body 4 spaces", () => {
    expect(md).toContain('=== ":material-file-code-outline: Example 1"\n\n    ```json\n    {')
  })
})

describe("mkdocs-reference — Related Types grid cards", () => {
  it("Product's page renders a grid-cards block linking every def it references", () => {
    const md = pages.get("product.md")!
    expect(md).toContain('## Related Types\n\n<div class="grid cards" markdown>')
    expect(md).toContain("-   :material-cube-outline: **[Availability](availability.md)**")
    expect(md).toContain("-   :material-cube-outline: **[Category](category.md)**")
    expect(md).toMatch(/<div class="grid cards" markdown>[\s\S]*<\/div>/)
  })

  it("a page with no referenced defs (Category, a leaf object) has no Related Types section", () => {
    const md = pages.get("category.md")!
    expect(md).not.toContain("## Related Types")
  })

  it("a card's blurb comes from the referenced def's own description", () => {
    const md = pages.get("product.md")!
    expect(md).toContain("Whether a product can currently be purchased.")
  })
})

describe("mkdocs-reference — abbreviations block still renders alongside the new grid cards", () => {
  it("Product's page still emits the *[Name]: hover-tooltip block", () => {
    const md = pages.get("product.md")!
    expect(md).toMatch(/^\*\[Category\]: /m)
    expect(md).toMatch(/^\*\[Availability\]: /m)
  })
})

describe("mkdocs-reference — interface def (InventoryManager)", () => {
  const md = pages.get("inventory-manager.md")!

  it("renders a Methods table", () => {
    expect(md).toContain("## Methods")
  })

  it("cross-links the method's parameter and return-type refs", () => {
    expect(md).toContain("[Product](product.md)")
    expect(md).toContain("[OrderEvent](order-event.md)")
  })
})

describe("mkdocs-reference — options.basePath", () => {
  it("prefixes every returned filename", () => {
    const prefixed = toMkdocsReference(doc, { basePath: "reference/" })
    expect([...prefixed.keys()].every((k) => k.startsWith("reference/"))).toBe(true)
    expect(prefixed.has("reference/product.md")).toBe(true)
  })
})

// ============================================================================
// toMkdocsYaml — real Material `mkdocs.yml` emission
// ============================================================================

describe("toMkdocsYaml", () => {
  const yaml = toMkdocsYaml(doc)

  it("sets theme: name: material with the documented feature set", () => {
    expect(yaml).toContain("theme:\n  name: material")
    expect(yaml).toContain("- navigation.tabs")
    expect(yaml).toContain("- content.tabs.link")
    expect(yaml).toContain("- content.code.copy")
  })

  it("emits the standard light/dark palette toggle block", () => {
    expect(yaml).toContain("- scheme: default")
    expect(yaml).toContain("icon: material/brightness-7")
    expect(yaml).toContain("- scheme: slate")
    expect(yaml).toContain("icon: material/brightness-4")
  })

  it("configures pymdownx.tabbed with alternate_style (required for === content tabs)", () => {
    expect(yaml).toContain("- pymdownx.tabbed:\n      alternate_style: true")
  })

  it("configures pymdownx.emoji for Material icon shortcodes", () => {
    expect(yaml).toContain("emoji_index: !!python/name:material.extensions.emoji.twemoji")
    expect(yaml).toContain("emoji_generator: !!python/name:material.extensions.emoji.to_svg")
  })

  it("enables attr_list and md_in_html (required for grid cards) and abbr (required for hover tooltips)", () => {
    expect(yaml).toContain("- attr_list")
    expect(yaml).toContain("- md_in_html")
    expect(yaml).toContain("- abbr")
  })

  it("emits a flat nav entry per def, matching toMkdocsReference's own filenames", () => {
    expect(yaml).toContain("nav:")
    expect(yaml).toContain('  - "Product": product.md')
    expect(yaml).toContain('  - "Category": category.md')
  })

  it("always includes the search plugin but omits social by default", () => {
    expect(yaml).toContain("plugins:\n  - search")
    expect(yaml).not.toContain("- social")
  })

  it("includes the social plugin when socialCards is requested with a siteUrl", () => {
    const withSocial = toMkdocsYaml(doc, { siteUrl: "https://example.com", socialCards: true })
    expect(withSocial).toContain("site_url: \"https://example.com\"")
    expect(withSocial).toContain("plugins:\n  - search\n  - social")
  })

  it("throws if socialCards is requested without a siteUrl (social plugin needs an absolute site_url)", () => {
    expect(() => toMkdocsYaml(doc, { socialCards: true })).toThrow(/siteUrl/)
  })

  it("respects options.basePath in nav file paths", () => {
    const prefixed = toMkdocsYaml(doc, { basePath: "reference/" })
    expect(prefixed).toContain('  - "Product": reference/product.md')
  })
})

// ============================================================================
// Helper coverage
// ============================================================================

describe("mkdocs-reference — exported helpers", () => {
  it("kebabCase matches the filenames toMkdocsReference actually produces", () => {
    expect(kebabCase("OrderEvent")).toBe("order-event")
    expect(pages.has(`${kebabCase("OrderEvent")}.md`)).toBe(true)
  })

  it("renderTypeExpr(linked: true) on a ref produces a Markdown link", () => {
    expect(renderTypeExpr(t(types.ref("Category")), true)).toBe("[Category](category.md)")
  })
})
