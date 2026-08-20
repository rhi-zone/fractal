import { describe, expect, it } from "bun:test";

import { t, types, typeRefDocument } from "./index.ts";
import { kebabCase, renderTypeExpr, toRstReference } from "./rst-reference.ts";

// ============================================================================
// Dedicated fixture — a small conference-talk-CFP-shaped API surface,
// distinct from sphinx-reference.ts's GitHub-flavored fixture and
// mkdocs-vanilla-reference.ts's blog/CMS-flavored one. Covers: a nested
// object (`Speaker`), an enum with a deprecation reason (`Track`), a
// deprecated leaf field, an optional field, a discriminated union with a
// `ref` variant and inline-object variants (`ReviewEvent`), an interface
// with a method (`ProgramCommittee`), and a documented example.
// ============================================================================

const speaker = t(
  types.object({
    name: t(types.string),
    id: t(types.integer),
  }),
  { description: "The person proposing a talk." },
);

const track = t(types.enum(["backend", "frontend", "infra"]), {
  description: "Which conference track a talk belongs to.",
  deprecated: "superseded by the `topic_tags` array; kept for backward compatibility",
});

const talk = t(
  types.object({
    title: t(types.string, { description: "The talk's headline." }),
    speaker: t(types.ref("Speaker")),
    track: t(types.ref("Track")),
    legacyVoteCount: t(types.integer, {
      deprecated: "renamed to `score` in the v2 CFP API; will be removed in v3",
      description: "Number of community votes this talk received.",
    }),
    abstract: t(types.string, { optional: true }),
  }),
  {
    description: "A single conference-talk proposal.",
    example: {
      title: "Docutils without Sphinx",
      speaker: { name: "Ada", id: 1 },
      track: "backend",
      legacyVoteCount: 12,
    },
  },
);

const reviewAccepted = t(
  types.object({
    type: t(types.literal("accepted")),
    talk: t(types.ref("Talk")),
  }),
  { description: "A talk proposal was accepted." },
);

const reviewRejected = t(
  types.object({
    type: t(types.literal("rejected")),
    reason: t(types.string),
  }),
  { description: "A talk proposal was rejected." },
);

const reviewEvent = t(types.union([reviewAccepted, reviewRejected]), {
  discriminator: "type",
  description: "A CFP review decision.",
});

const programCommittee = t(
  types.interface({
    listPending: t(
      types.function(
        [{ name: "track", type: t(types.ref("Track")) }],
        t(types.array(t(types.ref("ReviewEvent")))),
      ),
      { description: "List pending review decisions for a track." },
    ),
  }),
  { description: "A minimal CFP review client." },
);

const doc = typeRefDocument(t(types.ref("Talk")), {
  Talk: talk,
  Speaker: speaker,
  Track: track,
  ReviewEvent: reviewEvent,
  ProgramCommittee: programCommittee,
});

const pages = toRstReference(doc);

// ============================================================================
// Bar A (structural smoke test, RST-specific) — same checks
// sphinx-reference.test.ts runs (heading-underline length, well-formed
// list-table blocks), plus this target's own defining constraint: no
// Sphinx-only construct leaks in anywhere.
// ============================================================================

function headingUnderlinesMatch(rst: string): boolean {
  const lines = rst.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const title = lines[i] ?? "";
    const underline = lines[i + 1] ?? "";
    if (title.length === 0) continue;
    if (!/^[=\-~^]+$/.test(underline)) continue;
    const first = underline[0];
    if (!underline.split("").every((c) => c === first)) continue;
    if (underline.length !== title.length) return false;
  }
  return true;
}

function listTablesWellFormed(rst: string): boolean {
  const lines = rst.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== ".. list-table::") continue;
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").startsWith("   :")) j++;
    if ((lines[j] ?? "") !== "") return false;
    j++;
    if (!(lines[j] ?? "").startsWith("   * - ")) return false;
  }
  return true;
}

describe("rst-reference structural validity (bar A, RST-specific)", () => {
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

    it(`${filename} contains no Sphinx-only :ref: role`, () => {
      expect(content).not.toContain(":ref:`");
    });

    it(`${filename} contains no Sphinx-only cross-reference label`, () => {
      expect(content).not.toMatch(/^\.\. _[a-z0-9-]+:$/m);
    });

    it(`${filename} contains no Sphinx-only code-block directive`, () => {
      expect(content).not.toContain(".. code-block::");
    });

    it(`${filename} contains no Sphinx-only deprecated directive`, () => {
      expect(content).not.toContain(".. deprecated::");
    });
  }

  it("every page filename is the kebab-case def name plus .rst", () => {
    expect([...pages.keys()].sort()).toEqual(
      ["talk.rst", "speaker.rst", "track.rst", "review-event.rst", "program-committee.rst"].sort(),
    );
  });
});

// ============================================================================
// Bar B (dedicated fixture, reviewed/structural assertions) — exact expected
// substrings per section kind, same explicit-assertion convention as
// sphinx-reference.test.ts and mkdocs-vanilla-reference.test.ts.
// ============================================================================

describe("rst-reference — object def (Talk)", () => {
  const rst = pages.get("talk.rst")!;

  it("opens with the page title and no cross-link label (core docutils has no per-file label graph)", () => {
    expect(rst.startsWith("Talk\n====\n")).toBe(true);
    expect(rst.startsWith(".. _")).toBe(false);
  });

  it("renders the page description as prose", () => {
    expect(rst).toContain("A single conference-talk proposal.");
  });

  it("renders a Type Signature code block via the plain .. code:: directive", () => {
    expect(rst).toContain(".. code:: typescript\n\n   type Talk =");
    expect(rst).not.toContain(".. code-block::");
  });

  it("renders a Fields list-table with a header row", () => {
    expect(rst).toContain(".. list-table::\n   :header-rows: 1");
    expect(rst).toContain("   * - Field\n     - Type\n     - Required\n     - Description");
  });

  it("cross-links a ref-typed field via a plain hyperlink reference to the sibling .rst file", () => {
    expect(rst).toContain("   * - speaker\n     - `Speaker <speaker.rst>`_\n     - Yes");
    expect(rst).toContain("   * - track\n     - `Track <track.rst>`_\n     - Yes");
  });

  it("marks the optional field as not required", () => {
    expect(rst).toContain("   * - abstract\n     - string\n     - No");
  });

  it("marks the deprecated field with a bold deprecated marker in its Description cell", () => {
    expect(rst).toContain("Number of community votes this talk received. — **deprecated**");
  });

  it("renders the documented example as a JSON code block via .. code::", () => {
    expect(rst).toContain("Example\n-------");
    expect(rst).toContain(".. code:: json");
    expect(rst).toContain('"name": "Ada"');
  });
});

describe("rst-reference — deprecated leaf field still renders its own value type correctly", () => {
  it("legacyVoteCount still renders as integer despite being deprecated", () => {
    const rst = pages.get("talk.rst")!;
    expect(rst).toContain("   * - legacyVoteCount\n     - integer\n     - Yes");
  });
});

describe("rst-reference — enum def (Track) with a def-level deprecation", () => {
  const rst = pages.get("track.rst")!;

  it("has no per-file cross-link label", () => {
    expect(rst.startsWith("Track\n=====\n")).toBe(true);
  });

  it("renders a Members section with each enum value as an RST inline literal", () => {
    expect(rst).toContain("Members\n-------");
    expect(rst).toContain('- ``"backend"``');
    expect(rst).toContain('- ``"frontend"``');
    expect(rst).toContain('- ``"infra"``');
  });

  it("renders the def-level deprecation as a generic titled admonition, not Sphinx's .. deprecated::", () => {
    expect(rst).toContain(
      ".. admonition:: Deprecated\n\n   superseded by the `topic_tags` array; kept for backward compatibility",
    );
    expect(rst).not.toContain(".. deprecated::");
  });
});

describe("rst-reference — union def (ReviewEvent)", () => {
  const rst = pages.get("review-event.rst")!;

  it("names the discriminator", () => {
    expect(rst).toContain("Discriminated by ``type``.");
  });

  it("renders one subsection per variant, named by the discriminator's literal tag", () => {
    expect(rst).toContain("accepted\n~~~~~~~~");
    expect(rst).toContain("rejected\n~~~~~~~~");
  });

  it("cross-links a ref-typed field inside a variant's nested Fields table", () => {
    expect(rst).toContain("`Talk <talk.rst>`_");
  });
});

describe("rst-reference — interface def (ProgramCommittee)", () => {
  const rst = pages.get("program-committee.rst")!;

  it("renders a Methods list-table instead of a Fields table", () => {
    expect(rst).toContain("Methods\n-------");
    expect(rst).toContain("   * - Method\n     - Signature\n     - Description");
  });

  it("renders the method's parameter and return-type cross-links as plain hyperlink references", () => {
    expect(rst).toContain("`Track <track.rst>`_");
    expect(rst).toContain("`ReviewEvent <review-event.rst>`_");
  });
});

describe("rst-reference — cross-page link/filename agreement", () => {
  it("every hyperlink reference target used anywhere matches a real emitted filename", () => {
    const emittedFilenames = new Set(pages.keys());
    const linkTargets = new Set<string>();
    for (const content of pages.values()) {
      for (const m of content.matchAll(/`[^<]+<([a-z0-9-]+\.rst)>`_/g)) {
        const target = m[1];
        if (target !== undefined) linkTargets.add(target);
      }
    }
    expect(linkTargets.size).toBeGreaterThan(0);
    for (const target of linkTargets) expect(emittedFilenames.has(target)).toBe(true);
  });
});

describe("rst-reference — options.basePath", () => {
  it("prefixes every returned filename", () => {
    const prefixed = toRstReference(doc, { basePath: "reference/" });
    expect([...prefixed.keys()].every((k) => k.startsWith("reference/"))).toBe(true);
    expect(prefixed.has("reference/talk.rst")).toBe(true);
  });
});

// ============================================================================
// Helper coverage — exported alongside the projector for callers assembling
// their own page layout, same convention every other doc projector follows.
// ============================================================================

describe("rst-reference — exported helpers", () => {
  it("kebabCase matches the filenames toRstReference actually produces", () => {
    expect(kebabCase("ReviewEvent")).toBe("review-event");
    expect(pages.has(`${kebabCase("ReviewEvent")}.rst`)).toBe(true);
  });

  it("renderTypeExpr(linked: true) on a ref produces a plain hyperlink reference", () => {
    expect(renderTypeExpr(t(types.ref("Speaker")), true)).toBe("`Speaker <speaker.rst>`_");
  });

  it("renderTypeExpr(linked: false) on a ref renders the bare name", () => {
    expect(renderTypeExpr(t(types.ref("Speaker")), false)).toBe("Speaker");
  });
});
