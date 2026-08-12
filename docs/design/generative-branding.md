# Generative branding / color system — scoping notes

> Early-stage, exploratory scoping document. Captures an idea in its first
> form, grounds it in real prior art, and surveys what the docgen targets
> currently expose for a branding layer to hook into. **Almost nothing here
> is decided.** The project owner explicitly wants to keep refining this doc
> incrementally in follow-up sessions rather than treating this version as
> final — sections marked "open" are genuinely open, and the shape of the
> doc itself (not just its content) should be expected to change as the idea
> firms up. No implementation has started; this is capture-and-research only.

## The idea

Fractal's docgen output (Docusaurus, Starlight, MkDocs, Sphinx, and the
embedded `api-explorer` component) currently has no branding or theming
story at all — see "Current state of the docgen targets" below, verified
this session. The idea is a **generative branding system**: give it one
input — a single accent/brand color — and it derives everything else needed
to theme a generated doc site:

- Light and dark mode variants of that color (and of whatever fuller palette
  gets derived from it).
- WCAG-contrast-compliant color *pairs* (text-on-background, etc.), not just
  a palette of colors that happen to exist.
- A fuller palette "projected" from the one seed color using real color
  theory — not arbitrary lighten/darken steps, but a grounded derivation
  method (see "Prior art" below for what "grounded" could mean concretely).

Also named as part of the surface, at a much earlier stage of thought than
the color-derivation piece: logo handling (light/dark logo variants), and
font/font-pairing selection. These are noted here as in-scope for the
overall "branding system" idea but are not researched in this pass — the
research and prior-art grounding done this session is about the color
piece specifically. Font selection has since been given one further bit of
shape (a `googleFonts()` adapter — see its own section below) but is still
otherwise undesigned; logo handling remains entirely unscoped.

Two further ideas were added in a follow-up round, described in their own
sections below rather than folded in here since they're additions to the
doc's scope, not refinements of the original color-derivation idea: a
stated longer-term goal of this system becoming a "lighthouse, but for
branding" self-audit tool for fractal's own docs sites (see "Bigger idea:
dogfooding..." below), and a composable/placement-aware doc-generation
capability that goal would depend on (see "Adjacent dependency..." below).

## Low floor, high ceiling — what that means concretely (draft)

Named explicitly as a goal but not yet designed in detail. The shape as
currently understood:

- **Floor (zero-config default):** a consuming project supplies exactly one
  color value (a hex/rgb/whatever-is-most-ergonomic accent color) and gets a
  fully themed doc site out — light mode, dark mode, all text/background
  pairs passing at least WCAG AA — with no further input required. No
  palette-editing UI, no per-token overrides, nothing else to configure.
- **Ceiling (tunable):** what exactly becomes tunable beyond the one seed
  color is **open** — candidates floated by the idea's own description
  (fonts, logos, "color systems more broadly") suggest the ceiling includes
  at least font pairing and logo variants, and plausibly direct overrides of
  individual derived tokens (e.g. "use my seed-derived palette for
  everything except the danger/error color, which I want to pin"), but
  whether/how token-level overrides work is not designed here.
- **What's genuinely undecided:** how many steps exist between floor and
  ceiling (binary on/off vs. a graduated set of optional inputs), where
  contrast-algorithm choice (WCAG 2 vs. APCA — see prior art) sits on that
  spectrum (baked-in default vs. exposed knob), and whether "projecting into
  a fuller palette" produces a fixed-shape output (e.g. Radix's 12-step
  convention) or something more free-form.

## Font selection — a `googleFonts()` adapter (draft)

One concrete piece of shape given to the previously-unresearched
font/font-pairing surface: a `googleFonts()` adapter as the entry point for
font selection, the font-side analog of "give it one input, get a themed
output" — though what exactly the "one input" is for fonts (a single font
name? a pairing preference like "serif heading / sans body"? a vibe
keyword?) is not decided here.

The concrete DX ask, distinct from the derivation question above: an
**exhaustive enum of known Google Fonts baked into the adapter**, so a
consumer gets editor autocomplete over real font names instead of a
free-text string that silently does nothing (or throws late) on a typo or
an unsupported family. This is a scoping/DX requirement, not a design —
open items this doc doesn't resolve:

- Where the enum's source of truth comes from and how it stays current —
  the Google Fonts catalog changes over time (fonts are added; variable-font
  metadata changes), so a hand-maintained enum would drift. Google publishes
  a [Fonts Developer API](https://developers.google.com/fonts/docs/developer_api)
  that returns the current family list; whether the enum would be
  generated from that API at build/publish time, vendored and periodically
  refreshed, or hand-maintained is not decided.
- Whether the enum is scoped to font *families* only, or also encodes
  available weights/styles/variable-font axes per family (real DX value,
  real added complexity — not designed here).
- How this adapter's output actually reaches each docgen target — same
  open native-hook-vs-raw-CSS question as the color system (per "How this
  might integrate per target" below), since font loading has its own
  per-framework mechanisms (e.g. Docusaurus/Starlight can load a
  `<link>`/`@font-face` via their respective config or a custom-CSS/head
  injection point; MkDocs Material has its own `theme.font` config key
  already; Sphinx has none of these natively).
- Whether/how this composes with the "font pairing" idea from the original
  prompt (heading font + body font as a deliberate pair, not two
  independent free choices) — `googleFonts()` as named so far is a
  single-font selector; pairing is a separate, unaddressed question.

## Prior art (grounded, researched this session)

Researched via web search this session; every mechanism and figure below is
cited, not invented. Two residual uncertainties are flagged inline where
found.

### Material Design 3 / Material You — HCT color space

Google's approach to deriving an entire perceptually-consistent color
scheme (light + dark, ~40 named UI-role colors) from one seed color.

- **HCT** (Hue, Chroma, Tone) is a hybrid space: Hue/Chroma come from the
  **CAM16** color-appearance model (more perceptually accurate hue
  prediction than HSL/Lab); Tone is lightness taken from **CIELAB L\***
  instead of CAM16's own lightness term — combining CAM16's better hue
  behavior with L\*'s simpler, better-behaved lightness behavior.
- **Tonal palettes:** for a seed, Hue/Chroma are held fixed and Tone is
  swept across 13 fixed stops (0, 10, 20 … 100). Material You generates five
  such palettes per seed (Primary, Secondary, Tertiary, Neutral,
  Neutral-variant) via fixed hue/chroma offset rules from the seed, then a
  `DynamicScheme` maps specific tones from each palette onto named color
  roles, separately for light and dark.
- **The contrast guarantee is arithmetic, not measured per pair:** because
  Tone is linear in L\*, a Tone difference of ≥40 between two colors sharing
  a palette guarantees WCAG contrast ≥3.0, and ≥50 guarantees ≥4.5 — this
  turns "is this pair accessible" into a fixed offset in tone-space rather
  than a per-pair computation.
- Open-source reference implementation: `material-color-utilities`
  (Apache-2.0, TS/Java/C++/Dart) — HCT↔sRGB conversion, tonal palette
  generation, key-color extraction from images, `DynamicScheme` role
  mapping.
- Sources: [material-color-utilities](https://github.com/material-foundation/material-color-utilities/), [dynamic_color_scheme.md](https://github.com/material-foundation/material-color-utilities/blob/main/concepts/dynamic_color_scheme.md), [Android Developers — color for mobile design](https://developer.android.com/design/ui/mobile/guides/styles/color), [ColorAide HCT docs](https://facelessuser.github.io/coloraide/colors/hct/)

### Radix Colors — 12-step scale convention

A conventionalized, role-based scale (not just "a palette") so any app using
it gets consistent semantics regardless of which hue was picked.

- Every scale has 12 steps with a fixed conventional role, consistent across
  scales and both light/dark: 1–2 app/subtle backgrounds, 3–5 component
  backgrounds (normal/hover/active), 6–8 borders (subtle → interactive →
  strong), 9–10 solid/saturated backgrounds, 11–12 accessible text
  (low/high emphasis).
- Contrast targets use **APCA**, not WCAG 2 ratios — steps 11/12 are tuned
  to guarantee APCA Lc 60 / Lc 90 respectively against step 2 of the same
  scale.
- **Generation is mixed, not purely algorithmic.** Radix's own shipped
  named palettes (~30 colors) are described by Radix as hand-crafted/tuned,
  not blind algorithm output. A separate custom-palette generation tool
  (and a related community tool, Equinor's) *is* algorithmic: given one
  seed, it works in OKLCH, holds hue roughly fixed, and varies
  lightness/chroma across the 12 steps via a Gaussian falloff on chroma.
  **Open/unverified:** whether the shipped named palettes came from the same
  algorithm and were then hand-adjusted, or were designed by a different
  process entirely, isn't stated definitively in Radix's own docs.
- Sources: [Understanding the scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale), [Scales](https://www.radix-ui.com/colors/docs/palette-composition/scales), [Custom palettes](https://www.radix-ui.com/colors/docs/overview/custom-palettes), [Equinor Colour Palette Generator](https://color-palette-generator-eds-prod.radix.equinor.com/about)

### culori vs. chroma.js — JS color math libraries

| | culori | chroma.js |
|---|---|---|
| Coverage | Conversion/interpolation/ΔE/blending/gamut-mapping across CSS Color 4 spaces incl. OKLab/OKLCH | Chainable manipulation + scale/interpolation, historically the dataviz default |
| License | MIT | BSD |
| Adoption signal | Used internally by Tailwind CSS v4 and Radix's OKLCH tooling | ~18.4M weekly downloads, mostly legacy/dataviz consumers |
| Fit here | Better fit for theme-token generation (native OKLCH, used by comparable tools) | Better fit for chart color scales specifically |

Sources: [culori](https://github.com/evercoder/culori), [culorijs.org](https://culorijs.org/), [chroma.js](https://github.com/gka/chroma.js)

### OKLCH / OKLab

The perceptually-uniform color space increasingly used for exactly this
kind of programmatic derivation.

- **OKLab** (Björn Ottosson, 2020): equal numeric steps in L/a/b correspond
  to approximately equal perceived differences — fixes known nonuniformity
  in CIELAB (particularly hue-shift/perceptual-jump artifacts in blues).
  **OKLCH** is its cylindrical (Lightness, Chroma, Hue) form.
- Why not HSL: HSL's "lightness" isn't perceptually linear and is coupled
  with saturation/hue, so a fixed HSL lightness looks like different
  perceived brightness at different hues — a real problem for sweeping
  lightness to build a tonal scale, which is exactly the operation this
  idea needs. OKLCH's L axis stays visually consistent across hues.
- CSS support: `oklch()`/`oklab()` are standardized in CSS Color Module
  Level 4 and supported in all evergreen browsers (Chrome 111+, Edge 111+,
  Safari 15.4+, Firefox 113+) as of 2026.
- This is the space Tailwind CSS v4 and Radix's custom-palette generator
  both use internally.
- Sources: [Oklab color space — Wikipedia](https://en.wikipedia.org/wiki/Oklab_color_space), [CSS oklch() Color Guide](https://csstools.io/blog/css-oklch-color-guide)

### WCAG 2.x contrast vs. APCA

- **WCAG 2.x** (current normative algorithm, SC 1.4.3): relative luminance
  `L = 0.2126R + 0.7152G + 0.0722B` over linearized sRGB channels; contrast
  ratio `(L1+0.05)/(L2+0.05)`; thresholds 4.5:1 normal text / 3:1 large text
  for AA. Known flaw: a simple linear luminance ratio that ignores text
  size/weight and is known to overstate contrast for dark colors.
- **APCA** (Advanced Perceptual Contrast Algorithm): built for WCAG 3,
  designed so halving/doubling its `Lc` score tracks roughly
  halving/doubling perceived contrast; treats light-on-dark vs. dark-on-light
  asymmetrically; meant to be read alongside font-size/weight guidance.
  Already used internally by Radix (above) to set contrast targets.
- **Adoption status, unsettled:** WCAG 3's visual-contrast section was
  pulled from its working draft in July 2023 for further evaluation: there
  is **no finalized WCAG 3 contrast algorithm** as of this research. APCA is
  the leading candidate and is usable/adopted in tooling today, but WCAG 2.x
  numeric thresholds remain the only normatively required target for
  compliance purposes. Any doc language should say "leading candidate," not
  "the WCAG 3 standard."
- Sources: [WCAG 2.1 Understanding SC 1.4.3](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html), [APCA in a Nutshell](https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html), [Why APCA?](https://git.apcacontrast.com/documentation/WhyAPCA.html)

### Other seed-to-palette tools worth citing

- **Adobe Leonardo** (`@adobe/leonardo-contrast-colors`, open source) —
  inverts the usual flow: you specify a *target contrast ratio* against a
  background and it solves for the color hitting that ratio, built on
  D3-color. Powers Adobe Spectrum's adaptive color system. [GitHub](https://github.com/adobe/leonardo)
- **Huetone** — an interactive LCH/OKLCH/CIELCH palette editor with live
  WCAG 2.1 contrast checking; human-in-the-loop, not an unattended
  generator — relevant as prior art for a verification/editing UI rather
  than the generation algorithm itself. [GitHub](https://github.com/ardov/huetone)
- **Tailwind CSS v4 / shadcn/ui** — Tailwind v4's token system is now
  defined in OKLCH; shadcn/ui theme generators derive a full semantic token
  set (background, foreground, card, muted, accent, destructive, border,
  ring, chart colors, light+dark) from one primary color, checking
  every text/surface pairing for contrast. Probably the closest existing
  analog to this idea's overall shape. [shadcn/ui theming](https://ui.shadcn.com/docs/theming)
- **IBM Carbon** — the opposite approach, cited as a counterpoint: a fixed,
  hand-designed token set: theming means remapping existing tokens, not
  deriving new ones from a seed. Worth naming as the non-generative
  alternative this idea is explicitly not choosing.

## Current state of the docgen targets — verified this session

Read directly, not inferred. **All target-specific theming surfaces are
either untouched or minimal** — this is close to greenfield, with one
partial exception.

- **Docusaurus** (`packages/type-ir/src/docusaurus-reference.ts`) — emits
  only per-type MDX pages (frontmatter + a `<TypeRef>` component reference).
  No `docusaurus.config.js` is generated at all. **Greenfield.** Docusaurus's
  own native theming hook (for later reference) is `themeConfig` in
  `docusaurus.config.js`, including a `colorMode` block for light/dark.
- **Starlight** (`packages/type-ir/src/starlight-reference.ts`) — emits only
  per-type MDX pages. No Astro/Starlight config file generated.
  **Greenfield.** Starlight's native hook is an Astro `starlight()`
  integration config object, including its own accent-color/theme CSS
  variable overrides.
- **MkDocs, Material variant** (`packages/type-ir/src/mkdocs-reference.ts`)
  — the one exception: `toMkdocsYaml` (lines 534–601) already emits an
  `mkdocs.yml` with a `theme: { name: material, features: [...], palette:
  [...] }` block, but it's a literal copy of Material's stock light/dark
  toggle scaffold (`scheme: default` / `scheme: slate`) — no brand colors,
  no `palette.primary`/`accent`, no logo, no font, no `extra_css`. A
  branding layer here would be **editing an existing block**, not adding a
  new one — different shape of work from the other targets.
- **MkDocs, vanilla variant**
  (`packages/type-ir/src/mkdocs-vanilla-reference.ts`) — no `mkdocs.yml`
  emitter exists in this file at all; only page Markdown. **Greenfield**,
  and per the file's own doc comment this is a deliberately independent,
  fully-duplicated sibling of the Material variant, not sharing code with
  it.
- **Sphinx** (`packages/type-ir/src/sphinx-reference.ts`) — emits only
  `.rst` pages. No `conf.py`, no `html_theme`/`html_theme_options`/
  `html_css_files`. **Greenfield.**
- **http-route-reference**
  (`packages/http-api-projector/src/http-route-reference.ts`) — a separate,
  route-level MDX projector (Docusaurus/Starlight only, no MkDocs/Sphinx
  variant) that embeds the live `<ApiExplorer/>` component. Emits only
  frontmatter. **Greenfield** for theming.
- **Cross-projector sharing:** `packages/type-ir/src/codegen-helpers.ts` is
  shared, but only for a `quote` string-escaping helper — nothing
  theming-related. Every projector otherwise independently reimplements its
  own page-building logic; duplication here is explicit by design per
  in-file comments.
- **`packages/api-explorer/`** — a React component library (not an app),
  embedded by the route-level projector above. No `.css`/`.scss` files
  exist in the package. No occurrence of "theme"/"dark"/"light" anywhere in
  its source. Styling today is plain `className` strings
  (`api-explorer`, `api-explorer-method`, `api-explorer-response`, ...)
  with **no stylesheet defining them anywhere in the package** — a
  consuming site is implicitly expected to supply CSS today. This is
  arguably the most direct integration point for a generated CSS-variable
  theme: the classNames already exist and are unstyled, waiting for exactly
  this kind of external stylesheet.

## How this might integrate per target — open, not designed

Framed as a question per target rather than a proposal, since the survey
above shows the targets aren't uniform in what native hook (if any) they
offer:

- **Docusaurus / Starlight:** both have real native theming config surfaces
  (`themeConfig`/`colorMode`, and Starlight's own theme CSS-variable
  overrides respectively) that today's projectors don't touch at all. Open:
  would a branding layer emit config *into* those native surfaces (requires
  generating `docusaurus.config.js`/Starlight integration config, which
  doesn't exist today), or ship raw CSS custom properties via each
  framework's custom-CSS-file mechanism, sidestepping the native config
  layer entirely? Native-hook integration is more idiomatic per-framework
  but is more work and more framework-specific code to maintain; raw CSS
  custom properties is one mechanism reusable across every target
  (including MkDocs/Sphinx, see below) at the cost of not participating in
  each framework's own theme system (e.g. Starlight users configuring theme
  via its normal config wouldn't see this layer's output there).
- **MkDocs (Material):** already has a `palette` block to extend
  (`palette.primary`/`palette.accent`) plus `extra_css` for anything the
  native palette keys can't express — both are real native hooks, unlike
  the greenfield targets above.
- **MkDocs (vanilla) / Sphinx:** no MDX, no component-import mechanism (per
  the separate, previously-verified finding in
  `docs/design/mocked-fetch-backend.md` that MkDocs is out of scope for live
  component embedding specifically) — but plain CSS injection via each
  tool's stock custom-CSS/`html_css_files` mechanism is still available for
  a color-variables-only approach, independent of the MDX-component
  question.
- **`api-explorer`:** the components already use bare, unstyled
  `className`s — a generated CSS-variable stylesheet is a plausible fit
  with zero component-code changes required, but this hasn't been checked
  against the actual classNames' structure for whether they map cleanly to
  a token set (background/foreground/border/accent-per-state) or would need
  additional classNames added first.
- **Whether one generator emits CSS variables that all targets consume the
  same way, or each target gets its own generated artifact shape,** is
  itself open — the projectors are already independent per the survey
  above (no shared config-generation code path exists today), so a shared
  branding-CSS-generation module would be new shared infrastructure, not an
  extension of an existing shared path.

## Bigger idea: dogfooding this as a branding/polish audit tool ("lighthouse, but for branding")

A stated longer-term goal, added in a follow-up round, well beyond the
scope of the color/font derivation work above and not designed at all here
— captured because the project owner wants it recorded as a real target for
this system, not just a color-derivation utility.

The idea: once fractal can *generate* a branded theme from one input, the
same machinery (color-derivation rules, contrast checks, whatever the font
system becomes) could plausibly also *audit* an already-built docs site —
checking things like contrast compliance, palette consistency, and general
"branding polish" against fractal's own generated output — in the spirit of
how Lighthouse audits a page for performance/accessibility/SEO, but scoped
to branding/theming coherence specifically instead. **Fractal's own docs
sites are explicitly named as the first target** — this is meant to
dogfood on fractal itself before it's pointed at anyone else's site.

Genuinely nothing about the audit tooling is designed here: not its check
list, not its output format (pass/fail? score? Lighthouse-style report?),
not whether it's a new package, a mode of the branding-generation package,
or a separate CLI, and not whether it audits only fractal-generated sites
or is meant to generalize to arbitrary docs sites later. Recorded as a
stated goal, not a spec.

## Adjacent dependency for the audit idea: composable, placement-aware doc generation

Flagged as a real dependency of the audit idea above, not a standalone
ask: auditing meaningfully requires knowing what got generated and *where
it landed* in a site's structure, and today's projectors don't offer that
kind of control — per the survey above, every projector's job today is
closer to "generate pages for everything in the input document," with
`options.basePath` (seen in both the type-ir reference projectors and
`http-route-reference.ts`) as the only placement knob currently found,
not a way to selectively scope *what* gets generated or place different
subsets at different points in a site's structure. You can't audit
placement you don't control — an audit that wants to check "is this
section's branding consistent with that section's" needs the generation
step to be able to produce deliberately-scoped, deliberately-placed output
in the first place, which is a bigger, separate capability from anything
else in this doc.

Not designed here at all: what "composable" means concretely (a
filter/selector API over the input document? per-section generation calls
that a consumer composes themselves? something else), whether this is a
enhancement to the existing projectors or a new layer in front of them,
and whether it's motivated *only* by the audit idea or has independent
value (e.g. large API surfaces wanting partial/staged doc generation
regardless of branding). Recorded here specifically as "the audit idea
needs this to be buildable," not as its own scoped idea yet — unlike the
`googleFonts()` adapter above, which stands on its own regardless of the
audit goal.

## Open questions

Genuinely unresolved, listed rather than defaulted:

- Which color-space/derivation method (HCT-style, OKLCH-Gaussian-scale
  Radix-style, target-contrast-solving Leonardo-style, or something else)
  actually gets used — not decided; the prior-art section above is meant to
  inform this choice, not make it.
- Fixed output shape (e.g. a Radix-style 12-step scale) vs. a smaller/larger
  set of derived tokens tailored to what the docgen targets and
  `api-explorer` actually need — the survey above didn't find an existing
  token inventory to target against, since nothing today consumes theming
  tokens at all.
- WCAG 2.x vs. APCA (or both, with APCA as an enhancement) for the
  contrast-compliance guarantee.
- Scope of "projects into a fuller palette" — does it cover semantic colors
  (success/warning/danger) or only neutral/surface/text derived from the one
  accent?
- Native-framework-config vs. raw-CSS-injection integration strategy per
  target (see above) — plausibly different answers for different targets
  given how non-uniform their native hooks already are.
- Font pairing and logo-variant handling — named as in scope by the
  original idea but not researched or scoped at all in this pass.
- Whether this ships as one new package, lives inside an existing package
  (`type-ir`? a new sibling of `api-explorer`?), or is spread across the
  consuming projectors directly — not discussed yet.
- Zero-config default vs. tunable-knob boundary (see "Low floor, high
  ceiling" above) — which specific things belong on which side.
- `googleFonts()`'s enum source of truth, its scope (families only vs.
  weights/styles/variable axes), and how a selected font actually reaches
  each docgen target (see "Font selection" above).
- The branding/polish audit tool's check list, output shape, and package
  boundary — entirely undesigned, see "Bigger idea: dogfooding..." above.
- Whether composable/placement-aware doc generation (the audit idea's
  named dependency) is scoped as part of this branding effort at all, or
  as separate, prerequisite work tracked elsewhere — not decided, and
  itself not designed even at the shape level yet beyond "the projectors
  don't offer this today."

## See also

- `packages/type-ir/src/docusaurus-reference.ts`,
  `starlight-reference.ts`, `mkdocs-reference.ts`,
  `mkdocs-vanilla-reference.ts`, `sphinx-reference.ts` — the five
  type-page projectors surveyed above.
- `packages/http-api-projector/src/http-route-reference.ts` — the
  route-level MDX projector embedding `<ApiExplorer/>`.
- `packages/api-explorer/src/api-explorer.tsx` — the unstyled component
  whose bare classNames are the most direct integration point found this
  session.
- `docs/design/mocked-fetch-backend.md` — prior verified findings on which
  docgen targets support live-component/MDX embedding at all (Docusaurus
  and Starlight yes, MkDocs no), relevant background for the
  native-config-vs-raw-CSS question above.
- `docs/design/framework-router-codegen.md` — another scoping doc in this
  directory, referenced for structural convention.
