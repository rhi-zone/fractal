import { describe, expect, it } from "bun:test";

import { t, types, typeRefDocument } from "./index.ts";
import { kebabCase, renderTypeExpr, toSphinxReference } from "./sphinx-reference.ts";

// ============================================================================
// Dedicated fixture — a small Python-package-shaped API surface, the kind of
// thing Sphinx autodoc is actually pointed at in the real world (a GitHub-
// API-flavored repository model), distinct from registry.test.ts's generic
// 3-field `sample`/`multi` shared fixture. Covers: a nested object (`Owner`),
// an enum (`visibility`), a deprecated field with a reason, a discriminated
// union with a `ref` variant and inline-object variants (`WebhookEvent`), an
// interface with a method (`IssueTracker`), and a documented example.
// ============================================================================

const owner = t(
  types.object({
    login: t(types.string),
    id: t(types.integer),
  }),
  { description: "The account that owns a repository." },
);

const visibility = t(types.enum(["public", "private", "internal"]), {
  description: "Who can see this repository.",
  deprecated: "superseded by the `access_control` object; kept for backward compatibility",
});

const repository = t(
  types.object({
    name: t(types.string, { description: "The repository's short name." }),
    owner: t(types.ref("Owner")),
    visibility: t(types.ref("Visibility")),
    stargazersCount: t(types.integer, {
      deprecated:
        "renamed to `stargazers_count` (snake_case) in API v4; this field will be removed in v5",
      description: "Number of users who starred this repository.",
    }),
    description: t(types.string, { optional: true }),
  }),
  {
    description: "A single Git repository, as returned by the repositories API.",
    example: {
      name: "fractal",
      owner: { login: "rhi-zone", id: 42 },
      visibility: "public",
      stargazersCount: 12,
    },
  },
);

const pushEvent = t(
  types.object({
    type: t(types.literal("push")),
    ref: t(types.string),
    commits: t(types.array(t(types.string))),
  }),
  { description: "A push to a branch." },
);

const issueEvent = t(
  types.object({
    type: t(types.literal("issue")),
    action: t(types.enum(["opened", "closed", "reopened"])),
    repository: t(types.ref("Repository")),
  }),
  { description: "An issue was opened, closed, or reopened." },
);

const webhookEvent = t(types.union([pushEvent, issueEvent]), {
  discriminator: "type",
  description: "A webhook payload delivered for a repository event.",
});

const issueTracker = t(
  types.interface({
    listIssues: t(
      types.function(
        [{ name: "repo", type: t(types.ref("Repository")) }],
        t(types.array(t(types.ref("WebhookEvent")))),
      ),
      { description: "List open issues for a repository." },
    ),
  }),
  { description: "A minimal issue-tracking client." },
);

const doc = typeRefDocument(t(types.ref("Repository")), {
  Repository: repository,
  Owner: owner,
  Visibility: visibility,
  WebhookEvent: webhookEvent,
  IssueTracker: issueTracker,
});

const pages = toSphinxReference(doc);

// ============================================================================
// Bar A (structural validity, specific to RST): docutils is strict about
// title-underline length and directive-block indentation in ways generic
// non-empty-output checks can't catch — checked here across every page this
// dedicated fixture produces, not just spot-checked on one.
// ============================================================================

// Every non-blank line immediately followed by a run of a single
// underline-punctuation character must have that run's length exactly equal
// to the title line's length — docutils rejects a mismatch outright (too
// short) or treats it as a different heading level (too long, silently
// wrong). `=/-/~/^` is this projector's full heading-character vocabulary.
function headingUnderlinesMatch(rst: string): boolean {
  const lines = rst.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const title = lines[i] ?? "";
    const underline = lines[i + 1] ?? "";
    if (title.length === 0) continue;
    if (!/^[=\-~^]+$/.test(underline)) continue;
    // A `---` list-table row separator or similar coincidental match on a
    // non-heading line would have a differently-shaped title line (table
    // rows/prose don't happen to be followed by a bare rule); restrict the
    // check to genuine heading pairs by requiring the underline to be pure
    // repetition of its first character.
    const first = underline[0];
    if (!underline.split("").every((c) => c === first)) continue;
    if (underline.length !== title.length) return false;
  }
  return true;
}

// `.. list-table::` bodies must indent every row consistently at 3 spaces
// (this projector's convention) with `* -` starting each row and `  -`
// continuing it — a docutils parse error otherwise.
function listTablesWellFormed(rst: string): boolean {
  const lines = rst.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== ".. list-table::") continue;
    // the next non-blank-adjacent lines through the header-rows option and
    // blank line should lead into rows starting with "   * - "
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").startsWith("   :")) j++;
    if ((lines[j] ?? "") !== "") return false;
    j++;
    if (!(lines[j] ?? "").startsWith("   * - ")) return false;
  }
  return true;
}

describe("sphinx-reference structural validity (bar A, RST-specific)", () => {
  for (const [filename, content] of pages) {
    it(`${filename} has matching heading underline lengths`, () => {
      expect(headingUnderlinesMatch(content)).toBe(true);
    });

    it(`${filename} has well-formed list-table blocks`, () => {
      expect(listTablesWellFormed(content)).toBe(true);
    });

    it(`${filename} ends with exactly one trailing newline`, () => {
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    });
  }

  it("every page filename is the kebab-case def name plus .rst", () => {
    expect([...pages.keys()].sort()).toEqual(
      [
        "repository.rst",
        "owner.rst",
        "visibility.rst",
        "webhook-event.rst",
        "issue-tracker.rst",
      ].sort(),
    );
  });
});

// ============================================================================
// Bar B (dedicated fixture, reviewed/structural assertions) — exact expected
// substrings for each section kind, reviewed by hand against real Sphinx/RST
// conventions rather than snapshotted (this codebase doesn't use snapshot
// testing anywhere under packages/type-ir/src; see compile-check.test.ts and
// sibling *.test.ts files for the same explicit-assertion convention).
// ============================================================================

describe("sphinx-reference — object def (Repository)", () => {
  const rst = pages.get("repository.rst")!;

  it("opens with a cross-link label immediately before the title", () => {
    expect(rst.startsWith(".. _repository:\n\nRepository\n==========\n")).toBe(true);
  });

  it("renders the page description as prose", () => {
    expect(rst).toContain("A single Git repository, as returned by the repositories API.");
  });

  it("renders a Type Signature code-block", () => {
    expect(rst).toContain(".. code-block:: typescript\n\n   type Repository =");
  });

  it("renders a Fields list-table with a header row", () => {
    expect(rst).toContain(".. list-table::\n   :header-rows: 1");
    expect(rst).toContain("   * - Field\n     - Type\n     - Required\n     - Description");
  });

  it("cross-links a ref-typed field to its own page via :ref:", () => {
    expect(rst).toContain("   * - owner\n     - :ref:`Owner <owner>`\n     - Yes");
    expect(rst).toContain("   * - visibility\n     - :ref:`Visibility <visibility>`\n     - Yes");
  });

  it("marks the optional field as not required", () => {
    expect(rst).toContain("   * - description\n     - string\n     - No");
  });

  it("marks the deprecated field with a bold deprecated marker in its Description cell", () => {
    // Same fidelity as mkdocs-reference.ts's `fieldRow`: the deprecation
    // *reason* string lives on `.. deprecated::` at the type level (see the
    // Visibility/top-level-deprecation coverage below); the Fields table
    // shows only a per-field boolean marker.
    expect(rst).toContain("Number of users who starred this repository. — **deprecated**");
  });

  it("renders the documented example as a JSON code-block", () => {
    expect(rst).toContain("Example\n-------");
    expect(rst).toContain(".. code-block:: json");
    expect(rst).toContain('"login": "rhi-zone"');
  });
});

describe("sphinx-reference — deprecated leaf field renders its own value type correctly", () => {
  it("stargazersCount still renders as integer despite being deprecated", () => {
    const rst = pages.get("repository.rst")!;
    expect(rst).toContain("   * - stargazersCount\n     - integer\n     - Yes");
  });
});

describe("sphinx-reference — enum def (Visibility)", () => {
  const rst = pages.get("visibility.rst")!;

  it("has its own cross-link label", () => {
    expect(rst.startsWith(".. _visibility:\n\nVisibility\n==========\n")).toBe(true);
  });

  it("renders a Members section with each enum value as an RST inline literal", () => {
    expect(rst).toContain("Members\n-------");
    expect(rst).toContain('- ``"public"``');
    expect(rst).toContain('- ``"private"``');
    expect(rst).toContain('- ``"internal"``');
  });

  it("renders a def-level `.. deprecated::` directive with a non-data version placeholder and the reason as indented body content", () => {
    // The reason must not sit on the `::` line itself — docutils' directive
    // grammar splits a multi-word single-line argument into a bogus
    // "version" (first word) plus a truncated inline explanation (see
    // sphinx-reference.ts's `deprecatedDirective` comment).
    expect(rst).toContain(
      ".. deprecated:: N/A\n\n   superseded by the `access_control` object; kept for backward compatibility",
    );
  });
});

describe("sphinx-reference — union def (WebhookEvent)", () => {
  const rst = pages.get("webhook-event.rst")!;

  it("names the discriminator", () => {
    expect(rst).toContain("Discriminated by ``type``.");
  });

  it("renders one subsection per variant, named by the discriminator's literal tag", () => {
    // "push" and "issue" come from the literal `type` field, per this
    // projector's `variantName` selection (title > discriminator tag >
    // positional fallback) — matching mkdocs-reference.ts's own convention.
    // Variant names are one heading level deeper than the page's own H1
    // (`=`) and the page's H2 sections (`-`), so they use the `~` subsection
    // char (see sphinx-reference.ts's HEADING_CHARS).
    expect(rst).toContain("push\n~~~~");
    expect(rst).toContain("issue\n~~~~~");
  });

  it("cross-links a ref-typed field inside a variant's nested Fields table", () => {
    expect(rst).toContain(":ref:`Repository <repository>`");
  });

  it("every variant subsection underline is the subsection char, not the page-title char", () => {
    // "push" (4 chars) underlined with 4 `~` — not `=` (reserved for the
    // page's own H1) and not `-` (reserved for the page's own H2 sections).
    expect(rst).toContain("push\n~~~~\n");
  });
});

describe("sphinx-reference — interface def (IssueTracker)", () => {
  const rst = pages.get("issue-tracker.rst")!;

  it("renders a Methods list-table instead of a Fields table", () => {
    expect(rst).toContain("Methods\n-------");
    expect(rst).toContain("   * - Method\n     - Signature\n     - Description");
  });

  it("renders the method's parameter and return-type cross-links", () => {
    expect(rst).toContain(":ref:`Repository <repository>`");
    expect(rst).toContain(":ref:`WebhookEvent <webhook-event>`");
  });
});

describe("sphinx-reference — cross-page link/label agreement", () => {
  it("every :ref: target used anywhere resolves to a real `.. _label:` declared on some emitted page", () => {
    const declaredLabels = new Set(
      [...pages.values()]
        .map((content) => /^\.\. _([a-z0-9-]+):/.exec(content)?.[1])
        .filter((l): l is string => l !== undefined),
    );
    const refTargets = new Set<string>();
    for (const content of pages.values()) {
      for (const m of content.matchAll(/:ref:`[^<]+<([a-z0-9-]+)>`/g)) {
        const target = m[1];
        if (target !== undefined) refTargets.add(target);
      }
    }
    expect(refTargets.size).toBeGreaterThan(0);
    for (const target of refTargets) expect(declaredLabels.has(target)).toBe(true);
  });
});

describe("sphinx-reference — options.basePath", () => {
  it("prefixes every returned filename", () => {
    const prefixed = toSphinxReference(doc, { basePath: "reference/" });
    expect([...prefixed.keys()].every((k) => k.startsWith("reference/"))).toBe(true);
    expect(prefixed.has("reference/repository.rst")).toBe(true);
  });
});

// ============================================================================
// Helper coverage — exported alongside the projector for callers assembling
// their own page layout, same convention mkdocs-reference.ts follows.
// ============================================================================

describe("sphinx-reference — exported helpers", () => {
  it("kebabCase matches the filenames toSphinxReference actually produces", () => {
    expect(kebabCase("WebhookEvent")).toBe("webhook-event");
    expect(pages.has(`${kebabCase("WebhookEvent")}.rst`)).toBe(true);
  });

  it("renderTypeExpr(linked: true) on a ref produces a :ref: role", () => {
    expect(renderTypeExpr(t(types.ref("Owner")), true)).toBe(":ref:`Owner <owner>`");
  });

  it("renderTypeExpr(linked: false) on a ref renders the bare name", () => {
    expect(renderTypeExpr(t(types.ref("Owner")), false)).toBe("Owner");
  });
});
