import { describe, expect, it } from "bun:test";

import { t, types, typeRefDocument } from "./index.ts";
import { kebabCase, renderTypeExpr, toOrgModeReference } from "./org-mode-reference.ts";

// ============================================================================
// Dedicated fixture — a small task/project-management API surface (Org's own
// real-world home turf: TODO lists and project tracking), distinct from
// sphinx-reference.test.ts's GitHub-flavored fixture, mkdocs-vanilla-
// reference.test.ts's blog/CMS-flavored fixture, and mkdocs-reference.test.ts's
// e-commerce-flavored fixture. Covers: a nested object (`Assignee`), an enum
// (`priority`), a deprecated field with a reason, a discriminated union with a
// `ref` variant and inline-object variants (`ActivityEvent`), an interface
// with a method (`ProjectBoard`), and a documented example.
// ============================================================================

const assignee = t(
  types.object({
    handle: t(types.string),
    id: t(types.integer),
  }),
  { description: "The person a task is assigned to." },
);

const priority = t(types.enum(["low", "medium", "high"]), {
  description: "How urgently a task needs attention.",
  deprecated: "superseded by the numeric `weight` field; kept for backward compatibility",
});

const task = t(
  types.object({
    title: t(types.string, { description: "The task's short summary." }),
    assignee: t(types.ref("Assignee")),
    priority: t(types.ref("Priority")),
    watcherCount: t(types.integer, {
      deprecated: "renamed to `watcher_count` (snake_case) in API v4; removed in v5",
      description: "Number of users watching this task.",
    }),
    notes: t(types.string, { optional: true }),
  }),
  {
    description: "A single tracked task, as returned by the tasks API.",
    example: {
      title: "Write the org-mode projector",
      assignee: { handle: "rhi-zone", id: 42 },
      priority: "high",
      watcherCount: 3,
    },
  },
);

const createdEvent = t(
  types.object({
    type: t(types.literal("created")),
    by: t(types.string),
  }),
  { description: "A task was created." },
);

const reassignedEvent = t(
  types.object({
    type: t(types.literal("reassigned")),
    to: t(types.enum(["unassigned", "reassigned"])),
    task: t(types.ref("Task")),
  }),
  { description: "A task was reassigned to someone else." },
);

const activityEvent = t(types.union([createdEvent, reassignedEvent]), {
  discriminator: "type",
  description: "An activity entry recorded against a task.",
});

const projectBoard = t(
  types.interface({
    listTasks: t(
      types.function(
        [{ name: "assignee", type: t(types.ref("Assignee")) }],
        t(types.array(t(types.ref("ActivityEvent")))),
      ),
      { description: "List activity for every task assigned to a given person." },
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

const pages = toOrgModeReference(doc);

// ============================================================================
// Bar A (structural validity, specific to Org): headline star-depth,
// property-drawer placement, and table well-formedness are all invariants
// generic non-empty-output checks can't catch — checked here across every
// page this dedicated fixture produces, not just spot-checked on one.
// ============================================================================

// A level-1 headline (a page's own title) must be followed immediately by a
// `:PROPERTIES:` drawer (no blank line in between — Org's own placement
// rule, see org-mode-reference.ts's header comment) that closes with
// `:END:` before the next blank line.
function propertyDrawerWellPlaced(org: string): boolean {
  const lines = org.split("\n");
  const titleIndex = lines.findIndex((l) => l.startsWith("* "));
  if (titleIndex === -1) return false;
  if (lines[titleIndex + 1] !== ":PROPERTIES:") return false;
  let j = titleIndex + 2;
  while (j < lines.length && lines[j] !== ":END:") {
    if (!/^:[A-Za-z_]+: /.test(lines[j] ?? "")) return false;
    j++;
  }
  return lines[j] === ":END:";
}

// Every `|---+---|`-shaped separator row must be made only of `|`, `-`, and
// `+`, and its `+`-separated segment count must match the header row's
// `|`-delimited cell count directly above it.
function tablesWellFormed(org: string): boolean {
  const lines = org.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/^\|[-+]+\|$/.test(line)) continue;
    const header = lines[i - 1] ?? "";
    if (!header.startsWith("|")) return false;
    const headerCells = header.split("|").filter((c) => c.trim() !== "").length;
    const segments = line.slice(1, -1).split("+").length;
    if (headerCells !== segments) return false;
  }
  return true;
}

describe("org-mode-reference structural validity (bar A, Org-specific)", () => {
  for (const [filename, content] of pages) {
    it(`${filename} places its :PROPERTIES: drawer immediately below the page headline`, () => {
      expect(propertyDrawerWellPlaced(content)).toBe(true);
    });

    it(`${filename} has well-formed tables`, () => {
      expect(tablesWellFormed(content)).toBe(true);
    });

    it(`${filename} ends with exactly one trailing newline`, () => {
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    });
  }

  it("every page filename is the kebab-case def name plus .org", () => {
    expect([...pages.keys()].sort()).toEqual(
      [
        "task.org",
        "assignee.org",
        "priority.org",
        "activity-event.org",
        "project-board.org",
      ].sort(),
    );
  });
});

// ============================================================================
// Bar B (dedicated fixture, reviewed/structural assertions) — exact expected
// substrings per section kind, reviewed by hand against real Org syntax
// rather than snapshotted (this codebase doesn't use snapshot testing
// anywhere under packages/type-ir/src; see sphinx-reference.test.ts and
// compile-check.test.ts for the same explicit-assertion convention).
// ============================================================================

describe("org-mode-reference — object def (Task)", () => {
  const org = pages.get("task.org")!;

  it("opens with #+TITLE/#+DESCRIPTION keywords", () => {
    expect(org.startsWith("#+TITLE: Task\n#+DESCRIPTION:")).toBe(true);
  });

  it("has a level-1 headline with a CUSTOM_ID property drawer", () => {
    expect(org).toContain("* Task\n:PROPERTIES:\n:CUSTOM_ID: task\n:END:");
  });

  it("renders the page description as prose", () => {
    expect(org).toContain("A single tracked task, as returned by the tasks API.");
  });

  it("renders a Type Signature src block", () => {
    expect(org).toContain("#+BEGIN_SRC typescript\ntype Task =");
    expect(org).toContain("#+END_SRC");
  });

  it("renders a Fields table with a header row and separator", () => {
    expect(org).toContain("| Field | Type | Required | Description |");
    expect(org).toContain("|---+---+---+---|");
  });

  it("cross-links a ref-typed field to its own page via a file: link", () => {
    expect(org).toContain("| assignee | [[file:assignee.org::#assignee][Assignee]] | Yes");
    expect(org).toContain("| priority | [[file:priority.org::#priority][Priority]] | Yes");
  });

  it("marks the optional field as not required", () => {
    expect(org).toContain("| notes | string | No |");
  });

  it("marks the deprecated field with a bold deprecated marker in its Description cell", () => {
    expect(org).toContain("Number of users watching this task. — *deprecated*");
  });

  it("renders the documented example as a JSON src block", () => {
    expect(org).toContain("* Example");
    expect(org).toContain("#+BEGIN_SRC json");
    expect(org).toContain('"handle": "rhi-zone"');
  });
});

describe("org-mode-reference — enum def (Priority)", () => {
  const org = pages.get("priority.org")!;

  it("has its own CUSTOM_ID drawer", () => {
    expect(org).toContain("* Priority\n:PROPERTIES:\n:CUSTOM_ID: priority\n:END:");
  });

  it("renders a Members section with each enum value as an Org verbatim literal", () => {
    expect(org).toContain("* Members");
    expect(org).toContain('- ~"low"~');
    expect(org).toContain('- ~"medium"~');
    expect(org).toContain('- ~"high"~');
  });

  it("renders a def-level #+BEGIN_QUOTE deprecation block with the reason", () => {
    expect(org).toContain(
      "#+BEGIN_QUOTE\n*Deprecated.* superseded by the numeric `weight` field; kept for backward compatibility\n#+END_QUOTE",
    );
  });
});

describe("org-mode-reference — union def (ActivityEvent)", () => {
  const org = pages.get("activity-event.org")!;

  it("names the discriminator", () => {
    expect(org).toContain("Discriminated by ~type~.");
  });

  it("renders one level-3 headline per variant, named by the discriminator's literal tag", () => {
    expect(org).toContain("*** created");
    expect(org).toContain("*** reassigned");
  });

  it("cross-links a ref-typed field inside a variant's nested Fields table", () => {
    expect(org).toContain("[[file:task.org::#task][Task]]");
  });

  it("escapes a union type's literal pipe inside a table cell", () => {
    // `to` is `"unassigned" | "reassigned"` (an inline enum) rendered into a
    // table cell — the raw " | " must become " \vert{} ", or it would split
    // the cell into extra (invalid) table columns.
    expect(org).toContain("\\vert{}");
  });
});

describe("org-mode-reference — interface def (ProjectBoard)", () => {
  const org = pages.get("project-board.org")!;

  it("renders a Methods table instead of a Fields table", () => {
    expect(org).toContain("* Methods");
    expect(org).toContain("| Method | Signature | Description |");
  });

  it("renders the method's parameter and return-type cross-links unwrapped (not inside ~…~)", () => {
    expect(org).toContain("[[file:assignee.org::#assignee][Assignee]]");
    expect(org).toContain("[[file:activity-event.org::#activity-event][ActivityEvent]]");
  });
});

describe("org-mode-reference — cross-page link/anchor agreement", () => {
  it("every file: link's ::#id resolves to a real :CUSTOM_ID: declared on some emitted page", () => {
    const declaredIds = new Set(
      [...pages.values()].flatMap((content) =>
        [...content.matchAll(/^:CUSTOM_ID: (.+)$/gm)].map((m) => m[1]),
      ),
    );
    const linkTargets = new Set<string>();
    for (const content of pages.values()) {
      for (const m of content.matchAll(/\[\[file:[a-z0-9-]+\.org::#([a-z0-9-]+)\]/g)) {
        const target = m[1];
        if (target !== undefined) linkTargets.add(target);
      }
    }
    expect(linkTargets.size).toBeGreaterThan(0);
    for (const target of linkTargets) expect(declaredIds.has(target)).toBe(true);
  });
});

describe("org-mode-reference — options.basePath", () => {
  it("prefixes every returned filename", () => {
    const prefixed = toOrgModeReference(doc, { basePath: "reference/" });
    expect([...prefixed.keys()].every((k) => k.startsWith("reference/"))).toBe(true);
    expect(prefixed.has("reference/task.org")).toBe(true);
  });
});

// ============================================================================
// Helper coverage — exported alongside the projector for callers assembling
// their own page layout, same convention every sibling doc projector follows.
// ============================================================================

describe("org-mode-reference — exported helpers", () => {
  it("kebabCase matches the filenames toOrgModeReference actually produces", () => {
    expect(kebabCase("ActivityEvent")).toBe("activity-event");
    expect(pages.has(`${kebabCase("ActivityEvent")}.org`)).toBe(true);
  });

  it("renderTypeExpr(linked: true) on a ref produces a file: link", () => {
    expect(renderTypeExpr(t(types.ref("Assignee")), true)).toBe(
      "[[file:assignee.org::#assignee][Assignee]]",
    );
  });

  it("renderTypeExpr(linked: false) on a ref renders the bare name", () => {
    expect(renderTypeExpr(t(types.ref("Assignee")), false)).toBe("Assignee");
  });
});
