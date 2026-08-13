import { describe, expect, it } from "bun:test";
import { remark } from "remark";
import remarkGfm from "remark-gfm";

import { t, types, typeRefDocument } from "./index.ts";
import { kebabCase, renderTypeExpr, toMarkdownReference } from "./markdown-reference.ts";

// ============================================================================
// Dedicated fixture — a small task-tracker-flavored API surface (distinct
// from sphinx-reference.test.ts's GitHub-API fixture, mkdocs-vanilla-
// reference.test.ts's blog/CMS fixture, and mkdocs-reference.test.ts's
// e-commerce fixture). Covers: a nested object (`Assignee`), an enum with a
// deprecation reason (`Priority`), a deprecated leaf field, an optional
// field, a discriminated union with a `ref` variant and inline-object
// variants (`ActivityEvent`), an interface with a method (`ProjectBoard`),
// and a documented example.
// ============================================================================

const assignee = t(
  types.object({
    name: t(types.string),
    id: t(types.integer),
  }),
  { description: "The person a task is assigned to." },
);

const priority = t(types.enum(["low", "medium", "high"]), {
  description: "A task's urgency level.",
  deprecated: "superseded by the numeric `weight` field; kept for backward compatibility",
});

const task = t(
  types.object({
    title: t(types.string, { description: "The task's short summary." }),
    assignee: t(types.ref("Assignee")),
    priority: t(types.ref("Priority")),
    legacyPointEstimate: t(types.integer, {
      deprecated: "renamed to `weight` in the v2 API; will be removed in v3",
      description: "Story-point estimate for this task.",
    }),
    notes: t(types.string, { optional: true }),
  }),
  {
    description: "A single tracked task.",
    example: {
      title: "Write the onboarding guide",
      assignee: { name: "Priya", id: 7 },
      priority: "medium",
      legacyPointEstimate: 3,
    },
  },
);

const activityCreated = t(
  types.object({
    type: t(types.literal("created")),
    task: t(types.ref("Task")),
  }),
  { description: "A task was created." },
);

const activityClosed = t(
  types.object({
    type: t(types.literal("closed")),
    taskId: t(types.string),
  }),
  { description: "A task was closed." },
);

const activityEvent = t(types.union([activityCreated, activityClosed]), {
  discriminator: "type",
  description: "A task activity event.",
});

const projectBoard = t(
  types.interface({
    listOpenTasks: t(
      types.function(
        [{ name: "assignee", type: t(types.ref("Assignee")) }],
        t(types.array(t(types.ref("ActivityEvent")))),
      ),
      { description: "List activity events for an assignee's open tasks." },
    ),
  }),
  { description: "A minimal project-board client." },
);

const doc = typeRefDocument(t(types.ref("Task")), {
  Task: task,
  Assignee: assignee,
  Priority: priority,
  ActivityEvent: activityEvent,
  ProjectBoard: projectBoard,
});

const pages = toMarkdownReference(doc);

// ============================================================================
// Bar A (structural smoke test): non-empty, correct filenames, no leaked
// tool-specific syntax (frontmatter, admonitions, content tabs, abbreviation
// glossaries) — the whole point of this target is that none of that is
// assumed available.
// ============================================================================

describe("markdown-reference structural validity (bar A)", () => {
  it("every page filename is the kebab-case def name plus .md", () => {
    expect([...pages.keys()].sort()).toEqual(
      ["task.md", "assignee.md", "priority.md", "activity-event.md", "project-board.md"].sort(),
    );
  });

  for (const [filename, content] of pages) {
    it(`${filename} opens with an H1 title, not YAML frontmatter`, () => {
      expect(content.startsWith("# ")).toBe(true);
      expect(content.startsWith("---\n")).toBe(false);
    });

    it(`${filename} is non-empty and ends with exactly one trailing newline`, () => {
      expect(content.length).toBeGreaterThan(0);
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    });

    it(`${filename} contains no Material-only admonition syntax`, () => {
      expect(content).not.toMatch(/^!!!/m);
    });

    it(`${filename} contains no pymdownx content-tab syntax`, () => {
      expect(content).not.toMatch(/^===\s+"/m);
    });

    it(`${filename} contains no abbreviation-glossary syntax`, () => {
      expect(content).not.toMatch(/^\*\[[^\]]+\]:/m);
    });

    it(`${filename} contains no MDX component syntax`, () => {
      expect(content).not.toMatch(/<[A-Z][A-Za-z]*[\s/>]/);
    });
  }
});

// ============================================================================
// Bar B (dedicated fixture, reviewed/structural assertions) — exact expected
// substrings per section kind, same explicit-assertion convention as
// sphinx-reference.test.ts and mkdocs-vanilla-reference.test.ts (this
// codebase doesn't use snapshot testing under packages/type-ir/src).
// ============================================================================

describe("markdown-reference — object def (Task)", () => {
  const md = pages.get("task.md")!;

  it("renders the page title as an H1", () => {
    expect(md).toContain("# Task");
  });

  it("renders the description as plain prose immediately after the title", () => {
    expect(md).toContain("# Task\n\nA single tracked task.");
  });

  it("renders a plain Type Signature fenced code block (no tabs)", () => {
    expect(md).toContain("## Type Signature\n\n```typescript\ntype Task =");
    expect(md).not.toContain('=== "');
  });

  it("renders a Fields table with a header row", () => {
    expect(md).toContain("| Field | Type | Required | Description |");
    expect(md).toContain("| --- | --- | --- | --- |");
  });

  it("cross-links ref-typed fields via plain Markdown links", () => {
    expect(md).toContain("| assignee | [Assignee](assignee.md) | Yes |");
    expect(md).toContain("| priority | [Priority](priority.md) | Yes |");
  });

  it("marks the optional field as not required", () => {
    expect(md).toContain("| notes | string | No |");
  });

  it("marks the deprecated field with a bold deprecated marker in its Description cell", () => {
    expect(md).toContain("Story-point estimate for this task. — **deprecated**");
  });

  it("renders the documented example as a fenced JSON block", () => {
    expect(md).toContain("## Example\n\n```json");
    expect(md).toContain('"name": "Priya"');
  });
});

describe("markdown-reference — deprecated leaf field still renders its own value type correctly", () => {
  it("legacyPointEstimate still renders as integer despite being deprecated", () => {
    const md = pages.get("task.md")!;
    expect(md).toContain("| legacyPointEstimate | integer | Yes |");
  });
});

describe("markdown-reference — enum def (Priority) with a def-level deprecation", () => {
  const md = pages.get("priority.md")!;

  it("renders a Members section with each enum value as an inline-code bullet", () => {
    expect(md).toContain("## Members");
    expect(md).toContain('- `"low"`');
    expect(md).toContain('- `"medium"`');
    expect(md).toContain('- `"high"`');
  });

  it("renders the def-level deprecation as a plain blockquote", () => {
    expect(md).toContain(
      "> **Deprecated.** superseded by the numeric `weight` field; kept for backward compatibility",
    );
    expect(md).not.toContain("!!! warning");
  });
});

describe("markdown-reference — union def (ActivityEvent)", () => {
  const md = pages.get("activity-event.md")!;

  it("names the discriminator", () => {
    expect(md).toContain("Discriminated by `type`.");
  });

  it("renders one H3 subsection per variant, named by the discriminator's literal tag", () => {
    expect(md).toContain("### created");
    expect(md).toContain("### closed");
  });

  it("cross-links a ref-typed field inside a variant's nested Fields table", () => {
    expect(md).toContain("[Task](task.md)");
  });
});

describe("markdown-reference — interface def (ProjectBoard)", () => {
  const md = pages.get("project-board.md")!;

  it("renders a Methods table instead of a Fields table", () => {
    expect(md).toContain("## Methods");
    expect(md).toContain("| Method | Signature | Description |");
  });

  it("renders the method's parameter and return-type cross-links", () => {
    expect(md).toContain("[Assignee](assignee.md)");
    expect(md).toContain("[ActivityEvent](activity-event.md)");
  });
});

describe("markdown-reference — options.basePath", () => {
  it("prefixes every returned filename", () => {
    const prefixed = toMarkdownReference(doc, { basePath: "reference/" });
    expect([...prefixed.keys()].every((k) => k.startsWith("reference/"))).toBe(true);
    expect(prefixed.has("reference/task.md")).toBe(true);
  });
});

// ============================================================================
// Helper coverage — exported alongside the projector for callers assembling
// their own page layout, same convention every other doc projector follows.
// ============================================================================

describe("markdown-reference — exported helpers", () => {
  it("kebabCase matches the filenames toMarkdownReference actually produces", () => {
    expect(kebabCase("ActivityEvent")).toBe("activity-event");
    expect(pages.has(`${kebabCase("ActivityEvent")}.md`)).toBe(true);
  });

  it("renderTypeExpr(linked: true) on a ref produces a Markdown link", () => {
    expect(renderTypeExpr(t(types.ref("Assignee")), true)).toBe("[Assignee](assignee.md)");
  });

  it("renderTypeExpr(linked: false) on a ref renders the bare name", () => {
    expect(renderTypeExpr(t(types.ref("Assignee")), false)).toBe("Assignee");
  });
});

// ============================================================================
// Bar D (verified correct, not just accepted): this target has no single
// "real tool" to build against the way MkDocs/Sphinx do — it isn't tied to
// any doc-site generator. Its nearest equivalent, per the same "human
// confirms it's not broken" intent the other targets' bar-D note describes,
// is feeding every generated page through a real, spec-compliant GFM parser
// (`remark` + `remark-gfm`, the same parser powering MDX/Next.js/Gatsby
// Markdown pipelines) and confirming it parses without error into the
// expected AST shapes — a table stays a `table` node, a fenced code block
// stays a `code` node, a cross-link stays a `link` node — rather than, say,
// silently degrading into a paragraph of literal text because of a syntax
// mistake bar A's substring checks wouldn't catch.
// ============================================================================

describe("markdown-reference — verified against a real GFM parser (bar D)", () => {
  const processor = remark().use(remarkGfm);

  for (const [filename, content] of pages) {
    it(`${filename} parses as well-formed GFM with no parser messages`, () => {
      const file = processor.processSync(content);
      expect(file.messages).toEqual([]);
    });
  }

  it("task.md's Fields table parses as a real GFM table node, not literal text", () => {
    const tree = processor.parse(pages.get("task.md")!);
    const hasTable = tree.children.some((node) => node.type === "table");
    expect(hasTable).toBe(true);
  });

  it("task.md's Type Signature block parses as a real fenced code node", () => {
    const tree = processor.parse(pages.get("task.md")!);
    const codeNodes = tree.children.filter(
      (node): node is typeof node & { lang?: string } => node.type === "code",
    );
    expect(codeNodes.some((node) => node.lang === "typescript")).toBe(true);
  });

  it("task.md's cross-link to Assignee parses as a real link node, not literal brackets", () => {
    const tree = processor.parse(pages.get("task.md")!);
    const table = tree.children.find((node) => node.type === "table") as
      | { children: unknown[] }
      | undefined;
    expect(table).toBeDefined();
    const serialized = JSON.stringify(table);
    expect(serialized).toContain('"type":"link"');
    expect(serialized).toContain('"url":"assignee.md"');
  });
});
