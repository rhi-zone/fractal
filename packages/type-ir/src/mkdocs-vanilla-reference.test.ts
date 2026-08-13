import { describe, expect, it } from "bun:test";

import { t, types, typeRefDocument } from "./index.ts";
import { kebabCase, renderTypeExpr, toMkdocsVanillaReference } from "./mkdocs-vanilla-reference.ts";

// ============================================================================
// Dedicated fixture — a small blog/CMS-flavored API surface (distinct from
// sphinx-reference.test.ts's GitHub-API-flavored fixture, so this target
// isn't just re-exercising the same shapes under a different projector).
// Covers: a nested object (`Author`), an enum with a deprecation reason
// (`Status`), a deprecated leaf field, an optional field, a discriminated
// union with a `ref` variant and inline-object variants (`CommentEvent`),
// an interface with a method (`Moderator`), and a documented example.
// ============================================================================

const author = t(
  types.object({
    name: t(types.string),
    id: t(types.integer),
  }),
  { description: "The user who wrote a post." },
);

const status = t(types.enum(["draft", "published", "archived"]), {
  description: "A post's publication state.",
  deprecated: "superseded by the `workflow_state` field; kept for backward compatibility",
});

const post = t(
  types.object({
    title: t(types.string, { description: "The post's headline." }),
    author: t(types.ref("Author")),
    status: t(types.ref("Status")),
    legacyViewCount: t(types.integer, {
      deprecated: "renamed to `view_count` (snake_case) in the v2 API; will be removed in v3",
      description: "Number of times this post was viewed.",
    }),
    summary: t(types.string, { optional: true }),
  }),
  {
    description: "A single blog post.",
    example: {
      title: "Hello, MkDocs",
      author: { name: "Ada", id: 1 },
      status: "published",
      legacyViewCount: 42,
    },
  },
);

const commentCreated = t(
  types.object({
    type: t(types.literal("created")),
    body: t(types.string),
    post: t(types.ref("Post")),
  }),
  { description: "A comment was posted." },
);

const commentDeleted = t(
  types.object({
    type: t(types.literal("deleted")),
    commentId: t(types.string),
  }),
  { description: "A comment was removed." },
);

const commentEvent = t(types.union([commentCreated, commentDeleted]), {
  discriminator: "type",
  description: "A comment moderation event.",
});

const moderator = t(
  types.interface({
    listFlagged: t(
      types.function(
        [{ name: "post", type: t(types.ref("Post")) }],
        t(types.array(t(types.ref("CommentEvent")))),
      ),
      { description: "List flagged comment events for a post." },
    ),
  }),
  { description: "A minimal comment-moderation client." },
);

const doc = typeRefDocument(t(types.ref("Post")), {
  Post: post,
  Author: author,
  Status: status,
  CommentEvent: commentEvent,
  Moderator: moderator,
});

const pages = toMkdocsVanillaReference(doc);

// ============================================================================
// Bar A (structural smoke test): non-empty, well-formed frontmatter, and —
// the whole point of this target — none of Material's pymdownx-specific
// syntax leaks in anywhere.
// ============================================================================

describe("mkdocs-vanilla-reference structural validity (bar A)", () => {
  it("every page filename is the kebab-case def name plus .md", () => {
    expect([...pages.keys()].sort()).toEqual(
      ["post.md", "author.md", "status.md", "comment-event.md", "moderator.md"].sort(),
    );
  });

  for (const [filename, content] of pages) {
    it(`${filename} opens with well-formed YAML frontmatter`, () => {
      expect(content.startsWith("---\ntitle:")).toBe(true);
      expect(content).toContain("\n---\n");
    });

    it(`${filename} is non-empty and ends with exactly one trailing newline`, () => {
      expect(content.length).toBeGreaterThan(0);
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    });

    it(`${filename} contains no Material-Material-only admonition syntax`, () => {
      expect(content).not.toMatch(/^!!!/m);
    });

    it(`${filename} contains no pymdownx content-tab syntax`, () => {
      expect(content).not.toMatch(/^===\s+"/m);
    });

    it(`${filename} contains no abbreviation-glossary syntax`, () => {
      expect(content).not.toMatch(/^\*\[[^\]]+\]:/m);
    });
  }
});

// ============================================================================
// Bar B (dedicated fixture, reviewed/structural assertions) — exact expected
// substrings per section kind, same explicit-assertion convention as
// sphinx-reference.test.ts and mkdocs-reference's own doc-projectors.md
// example (this codebase doesn't use snapshot testing under
// packages/type-ir/src).
// ============================================================================

describe("mkdocs-vanilla-reference — object def (Post)", () => {
  const md = pages.get("post.md")!;

  it("has a title and description in frontmatter", () => {
    expect(md).toContain('title: "Post"');
    expect(md).toContain('description: "A single blog post."');
  });

  it("renders the page title as an H1", () => {
    expect(md).toContain("# Post");
  });

  it("renders a plain Type Signature fenced code block (no tabs)", () => {
    expect(md).toContain("## Type Signature\n\n```typescript\ntype Post =");
    expect(md).not.toContain('=== "');
  });

  it("renders a Fields table with a header row", () => {
    expect(md).toContain("| Field | Type | Required | Description |");
    expect(md).toContain("| --- | --- | --- | --- |");
  });

  it("cross-links ref-typed fields via plain Markdown links", () => {
    expect(md).toContain("| author | [Author](author.md) | Yes |");
    expect(md).toContain("| status | [Status](status.md) | Yes |");
  });

  it("marks the optional field as not required", () => {
    expect(md).toContain("| summary | string | No |");
  });

  it("marks the deprecated field with a bold deprecated marker in its Description cell", () => {
    expect(md).toContain("Number of times this post was viewed. — **deprecated**");
  });

  it("renders the documented example as a fenced JSON block, not a Material tab", () => {
    expect(md).toContain("## Example\n\n```json");
    expect(md).toContain('"name": "Ada"');
    expect(md).not.toContain('=== "Example');
  });
});

describe("mkdocs-vanilla-reference — deprecated leaf field still renders its own value type correctly", () => {
  it("legacyViewCount still renders as integer despite being deprecated", () => {
    const md = pages.get("post.md")!;
    expect(md).toContain("| legacyViewCount | integer | Yes |");
  });
});

describe("mkdocs-vanilla-reference — enum def (Status) with a def-level deprecation", () => {
  const md = pages.get("status.md")!;

  it("renders a Members section with each enum value as an inline-code bullet", () => {
    expect(md).toContain("## Members");
    expect(md).toContain('- `"draft"`');
    expect(md).toContain('- `"published"`');
    expect(md).toContain('- `"archived"`');
  });

  it("renders the def-level deprecation as a plain blockquote, not a Material admonition", () => {
    expect(md).toContain(
      "> **Deprecated.** superseded by the `workflow_state` field; kept for backward compatibility",
    );
    expect(md).not.toContain("!!! warning");
  });
});

describe("mkdocs-vanilla-reference — union def (CommentEvent)", () => {
  const md = pages.get("comment-event.md")!;

  it("names the discriminator", () => {
    expect(md).toContain("Discriminated by `type`.");
  });

  it("renders one H3 subsection per variant, named by the discriminator's literal tag", () => {
    expect(md).toContain("### created");
    expect(md).toContain("### deleted");
  });

  it("cross-links a ref-typed field inside a variant's nested Fields table", () => {
    expect(md).toContain("[Post](post.md)");
  });
});

describe("mkdocs-vanilla-reference — interface def (Moderator)", () => {
  const md = pages.get("moderator.md")!;

  it("renders a Methods table instead of a Fields table", () => {
    expect(md).toContain("## Methods");
    expect(md).toContain("| Method | Signature | Description |");
  });

  it("renders the method's parameter and return-type cross-links", () => {
    expect(md).toContain("[Post](post.md)");
    expect(md).toContain("[CommentEvent](comment-event.md)");
  });
});

describe("mkdocs-vanilla-reference — options.basePath", () => {
  it("prefixes every returned filename", () => {
    const prefixed = toMkdocsVanillaReference(doc, { basePath: "reference/" });
    expect([...prefixed.keys()].every((k) => k.startsWith("reference/"))).toBe(true);
    expect(prefixed.has("reference/post.md")).toBe(true);
  });
});

// ============================================================================
// Helper coverage — exported alongside the projector for callers assembling
// their own page layout, same convention every other doc projector follows.
// ============================================================================

describe("mkdocs-vanilla-reference — exported helpers", () => {
  it("kebabCase matches the filenames toMkdocsVanillaReference actually produces", () => {
    expect(kebabCase("CommentEvent")).toBe("comment-event");
    expect(pages.has(`${kebabCase("CommentEvent")}.md`)).toBe(true);
  });

  it("renderTypeExpr(linked: true) on a ref produces a Markdown link", () => {
    expect(renderTypeExpr(t(types.ref("Author")), true)).toBe("[Author](author.md)");
  });

  it("renderTypeExpr(linked: false) on a ref renders the bare name", () => {
    expect(renderTypeExpr(t(types.ref("Author")), false)).toBe("Author");
  });
});
