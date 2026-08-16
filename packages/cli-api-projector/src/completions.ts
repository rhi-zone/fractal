// Static shell completion generation for the CLI projector.
//
// "Static" is the operative word: everything emitted here is baked in at
// generation time from the Node tree's own shape (branch/leaf names) plus
// `SchemaMap` (flag names + enum values from JSON Schema, the same source
// cli.ts's help text and type coercion read). There is no dynamic
// invocation of the CLI at completion time — the generated script is a
// self-contained artifact.
//
// Fallback (wildcard-capture) subtrees are a genuine limitation: the slug
// value at that position can't be enumerated (it's arbitrary user data), so
// completion for the value itself is never offered. Completion for
// everything after the slug (e.g. `books <bookId> re<TAB>` →
// `read`/`replace`/`remove`) still works in bash/zsh, which track a `*`
// placeholder through the fallback position; fish's generator skips
// fallback subtrees entirely (see generateFishCompletion's doc comment).
//
// See:
//   packages/cli-api-projector/src/cli.ts — walkCliCommands, getCliMeta, resolveLeaf

import { isLeaf } from "@rhi-zone/fractal-api-tree/node";
import type { Node } from "@rhi-zone/fractal-api-tree/node";
import { escapeJoin, unescapeJoin } from "@rhi-zone/fractal-api-tree/path";
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree";
import { getCliMeta } from "./cli.ts";
import type { CliLeafMeta } from "./cli.ts";

// ============================================================================
// Shell selector
// ============================================================================

export type ShellName = "bash" | "zsh" | "fish";

export function isShellName(v: string | undefined): v is ShellName {
  return v === "bash" || v === "zsh" || v === "fish";
}

// ============================================================================
// Tree index — one flat pass over the Node tree, independent of shell
// ============================================================================

/** True when `meta.cli.hidden === true`. */
function isHiddenMeta(meta: CliLeafMeta): boolean {
  return getCliMeta(meta).hidden === true;
}

type FlagInfo = {
  readonly name: string;
  readonly enumValues?: readonly string[];
};

/**
 * One entry per tree position reachable in the completion script:
 *   - A branch position: `statics` lists its next-word subcommand names;
 *     `hasFallback` says whether an unrecognized word there should be
 *     treated as a consumed wildcard segment (see module doc comment).
 *   - A leaf position (`isLeaf: true`): `flags` lists its input schema's
 *     top-level fields (and each field's enum values, if any).
 *
 * `key` is the space-joined sequence of argv words leading to this position,
 * with a literal `*` standing in for a fallback-consumed slug value (its
 * concrete value can't be known statically).
 */
type LevelInfo = {
  readonly key: string;
  readonly statics: readonly string[];
  readonly hasFallback: boolean;
  readonly isLeaf: boolean;
  readonly flags: readonly FlagInfo[];
};

/**
 * Same underscore-joined convention extractToolSchemas uses (see
 * packages/api-tree/src/tree.ts) — escape-joined via
 * @rhi-zone/fractal-api-tree/path's `escapeJoin` so a schema-path segment
 * containing "_" can't derive the same lookup key as a genuinely different,
 * deeper tree position (the same fix applied at every other join site — see
 * that module's doc comment). The trailing dash-to-underscore normalization
 * predates this fix and is unrelated to it (preserved as-is): it runs AFTER
 * escaping, so it can't undo an escape sequence (which only ever contains
 * "\" and the delimiter, never "-").
 */
function schemaKeyFor(schemaPath: readonly string[]): string {
  return escapeJoin(schemaPath, "_").replace(/-/g, "_");
}

/**
 * Sentinel `LevelInfo.key` for the tree root, standing in for the empty
 * (zero-segment) path. This key doubles as a bash/zsh associative-array
 * subscript at generation time (buildBashFunctionLines), and bash rejects
 * an empty-string subscript ("bad array subscript"), so every path key,
 * root included, is a non-empty token. Chosen to be a string no real
 * subcommand name would plausibly collide with.
 */
const ROOT_KEY = "__root__";

// `LevelInfo.key` below (space-joined argv path, distinct from
// `schemaKeyFor`'s underscore-joined SchemaMap lookup key above) IS now run
// through `escapeJoin`, like every other join site this investigation
// converted — but this one needs a matching change on the other side of the
// wire. This key isn't only synthesized once in TypeScript and used as an
// opaque map key: the GENERATED bash script (`buildBashFunctionLines`,
// below) independently RECONSTRUCTS the identical key at completion time by
// concatenating matched argv words (`path="$path $word"`), with no access
// to `escapeJoin`'s TypeScript implementation. So the bash reconstruction
// (see the `while` loop in `buildBashFunctionLines`) now ALSO applies
// `escapeJoin`'s exact escaping scheme — backslash-double the word, then
// backslash-escape the space delimiter within it — to each matched word
// before appending it to `$path`, byte-for-byte matching `escapeSegment`
// (./path.ts). Both sides are covered by completions.test.ts: one test
// shells out to real bash to drive the generated completion function
// end-to-end through a segment containing a literal backslash (a segment
// containing a literal space can never be typed as a single matchable argv
// word here in the first place — `STATICS["$path"]`'s own value is a
// space-separated list, so `for c in ${STATICS["$path"]}` word-splits it;
// that's a separate, pre-existing limitation of this generator's
// `compgen -W`-based design, not something this escaping fix changes), and
// another test runs the `esc=` lines themselves under real bash against
// space- and backslash-containing input and checks the output matches
// `escapeJoin` byte-for-byte.


function buildLevels(
  n: Node,
  schemas: SchemaMap,
  path: readonly string[] = [],
  schemaPath: readonly string[] = [],
): LevelInfo[] {
  const levels: LevelInfo[] = [];
  const children = n.children ?? {};
  const statics: string[] = [];
  for (const [childKey, child] of Object.entries(children)) {
    if (isHiddenMeta(child.meta as CliLeafMeta)) continue;
    statics.push(childKey);
  }
  // `completions` is a reserved top-level command (see cli.ts's runCli) —
  // not part of the authored tree, so it isn't discovered by walking
  // `children`. Listed here (root level only) so it tab-completes too. Its
  // own `<bash|zsh|fish>` argument isn't modeled (no positional-arg
  // completion in this generator) — only the word "completions" itself.
  if (path.length === 0) statics.push("completions");

  levels.push({
    key: path.length === 0 ? ROOT_KEY : escapeJoin(path, " "),
    statics,
    hasFallback: n.fallback !== undefined,
    isLeaf: false,
    flags: [],
  });

  for (const [childKey, child] of Object.entries(children)) {
    if (isHiddenMeta(child.meta as CliLeafMeta)) continue;
    const childPath = [...path, childKey];
    const childSchemaPath = [...schemaPath, childKey];
    if (isLeaf(child)) {
      const toolSchema = schemas[schemaKeyFor(childSchemaPath)];
      const props = toolSchema?.inputSchema.properties ?? {};
      const flags: FlagInfo[] = Object.entries(props).map(([field, fieldSchema]) =>
        fieldSchema.enum !== undefined
          ? { name: field, enumValues: fieldSchema.enum }
          : { name: field },
      );
      levels.push({
        key: escapeJoin(childPath, " "),
        statics: [],
        hasFallback: false,
        isLeaf: true,
        flags,
      });
    } else {
      levels.push(...buildLevels(child, schemas, childPath, childSchemaPath));
    }
  }

  if (n.fallback !== undefined) {
    const subtree = n.fallback.subtree;
    const fallbackPath = [...path, "*"];
    const fallbackSchemaPath = [...schemaPath, n.fallback.name];

    // `fallback.subtree` may be a bare leaf (`op()`) rather than a branch
    // (`api({...})`). A bare leaf has no `children` to enumerate, so it is
    // pushed as its own `isLeaf: true` level directly, mirroring the
    // ordinary-leaf branch above — the same convention used by
    // api-tree/tree.ts's `walkNodeType` and the other projectors.
    if (isLeaf(subtree)) {
      const toolSchema = schemas[schemaKeyFor(fallbackSchemaPath)];
      const props = toolSchema?.inputSchema.properties ?? {};
      const flags: FlagInfo[] = Object.entries(props).map(([field, fieldSchema]) =>
        fieldSchema.enum !== undefined
          ? { name: field, enumValues: fieldSchema.enum }
          : { name: field },
      );
      levels.push({
        key: escapeJoin(fallbackPath, " "),
        statics: [],
        hasFallback: false,
        isLeaf: true,
        flags,
      });
    } else {
      levels.push(...buildLevels(subtree, schemas, fallbackPath, fallbackSchemaPath));
    }
  }

  return levels;
}

// ============================================================================
// bash — the reference generator: a real, fallback-aware path-matching walk
// ============================================================================

/** Sanitize a program name into a valid bash/zsh function-name fragment. */
function sanitizeIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Escape a value for embedding inside a double-quoted bash string. */
function bashEscape(s: string): string {
  return s.replace(/(["\\$`])/g, "\\$1");
}

/**
 * Build the bash completion function body (everything between the
 * `_prog_completions() { ... }` braces) as a flat list of lines. Shared
 * verbatim by generateBashCompletion and generateZshCompletion (zsh loads
 * it via bashcompinit — see that function's doc comment).
 */
function buildBashFunctionLines(root: Node, schemas: SchemaMap, funcName: string): string[] {
  const levels = buildLevels(root, schemas);
  const branchLevels = levels.filter((l) => !l.isLeaf);
  const leafLevels = levels.filter((l) => l.isLeaf);

  const lines: string[] = [];
  lines.push("_" + funcName + "() {");
  lines.push("  local cur word path i matched c prevword esc");
  lines.push("  declare -A STATICS");
  for (const l of branchLevels) {
    lines.push(
      '  STATICS["' + bashEscape(l.key) + '"]="' + l.statics.map(bashEscape).join(" ") + '"',
    );
  }
  lines.push("  declare -A HAS_FALLBACK");
  for (const l of branchLevels.filter((l) => l.hasFallback)) {
    lines.push('  HAS_FALLBACK["' + bashEscape(l.key) + '"]=1');
  }
  lines.push("  declare -A FLAGS");
  for (const l of leafLevels) {
    const flagWords = l.flags.map((f) => "--" + f.name);
    lines.push(
      '  FLAGS["' + bashEscape(l.key) + '"]="' + flagWords.map(bashEscape).join(" ") + '"',
    );
  }
  lines.push("  declare -A ENUMS");
  for (const l of leafLevels) {
    for (const f of l.flags) {
      if (f.enumValues !== undefined && f.enumValues.length > 0) {
        const enumKey = l.key + "|--" + f.name;
        lines.push(
          '  ENUMS["' + bashEscape(enumKey) + '"]="' + f.enumValues.map(bashEscape).join(" ") + '"',
        );
      }
    }
  }
  lines.push("");
  lines.push("  cur=${COMP_WORDS[COMP_CWORD]}");
  lines.push('  path="' + ROOT_KEY + '"');
  lines.push("  i=1");
  lines.push('  while [ "$i" -lt "$COMP_CWORD" ]; do');
  lines.push("    word=${COMP_WORDS[$i]}");
  lines.push('    if [[ "$word" == --* ]]; then');
  lines.push("      i=$((i+1))");
  lines.push("      continue");
  lines.push("    fi");
  lines.push("    matched=0");
  lines.push('    for c in ${STATICS["$path"]}; do');
  lines.push('      if [ "$c" = "$word" ]; then');
  // path is either the root sentinel (replaced outright — the sentinel
  // isn't a real prefix) or a real escape-joined prefix (appended to),
  // matching how buildLevels now joins non-root keys via `escapeJoin(path,
  // " ")` (./path.ts) instead of a bare `.join(" ")`. `$word` is escaped the
  // same way `escapeSegment` escapes a segment before that join — backslash
  // first (so an already-escaped backslash isn't re-interpreted as part of
  // a delimiter escape), then the space delimiter — so the key this loop
  // builds incrementally, one matched word at a time, is byte-identical to
  // what `escapeJoin` computes over the same segments in one shot. See this
  // function's own doc comment above for why this reconstruction has to
  // happen here at all, and completions.test.ts for a test that shells out
  // to real bash to prove the two sides agree.
  lines.push("        esc=${word//\\\\/\\\\\\\\}");
  lines.push("        esc=${esc// /\\\\ }");
  lines.push(
    '        if [ "$path" = "' + ROOT_KEY + '" ]; then path="$esc"; else path="$path $esc"; fi',
  );
  lines.push("        matched=1");
  lines.push("        break");
  lines.push("      fi");
  lines.push("    done");
  lines.push('    if [ "$matched" -eq 0 ] && [ -n "${HAS_FALLBACK["$path"]}" ]; then');
  lines.push('      if [ "$path" = "' + ROOT_KEY + '" ]; then path="*"; else path="$path *"; fi');
  lines.push("    fi");
  lines.push("    i=$((i+1))");
  lines.push("  done");
  lines.push("");
  lines.push("  prevword=${COMP_WORDS[$((COMP_CWORD-1))]}");
  lines.push('  if [[ "$prevword" == --* ]] && [ -n "${ENUMS["$path|$prevword"]}" ]; then');
  lines.push('    COMPREPLY=($(compgen -W "${ENUMS["$path|$prevword"]}" -- "$cur"))');
  lines.push('  elif [[ "$cur" == --* ]]; then');
  lines.push('    COMPREPLY=($(compgen -W "${FLAGS["$path"]}" -- "$cur"))');
  lines.push("  else");
  lines.push('    COMPREPLY=($(compgen -W "${STATICS["$path"]} ${FLAGS["$path"]}" -- "$cur"))');
  lines.push("  fi");
  lines.push("}");
  return lines;
}

/** Generate a bash completion script (`complete -F ... programName`, source it or drop it in a completions dir). */
export function generateBashCompletion(
  root: Node,
  schemas: SchemaMap,
  programName: string,
): string {
  const funcName = sanitizeIdent(programName) + "_completions";
  const lines: string[] = [
    "# bash completion for " + programName,
    "# Generated by @rhi-zone/fractal-cli-api-projector (static — see completions.ts).",
    "# Usage: source this file, or install it under your bash-completion directory.",
    "",
    ...buildBashFunctionLines(root, schemas, funcName),
    "",
    "complete -F _" + funcName + " " + programName,
    "",
  ];
  return lines.join("\n");
}

/**
 * Generate a zsh completion script. zsh's native completion system
 * (`compdef`/`_arguments`) is a different, much larger API; to keep this
 * generator static and simple, zsh output instead loads `bashcompinit` and
 * reuses the bash function body verbatim — a documented zsh compatibility
 * path (`man zshcompsys` — "Backward Compatibility").
 */
export function generateZshCompletion(root: Node, schemas: SchemaMap, programName: string): string {
  const funcName = sanitizeIdent(programName) + "_completions";
  const lines: string[] = [
    "#compdef " + programName,
    "# zsh completion for " + programName,
    "# Generated by @rhi-zone/fractal-cli-api-projector (static — see completions.ts).",
    "# Reuses the bash completion protocol via bashcompinit — see this function's doc comment.",
    "",
    "autoload -U +X bashcompinit && bashcompinit",
    "",
    ...buildBashFunctionLines(root, schemas, funcName),
    "",
    "complete -F _" + funcName + " " + programName,
    "",
  ];
  return lines.join("\n");
}

// ============================================================================
// fish — simplified: static branches only, fallback subtrees are skipped
// ============================================================================

/** Escape a value for embedding inside a single-quoted fish string. */
function fishEscape(s: string): string {
  return s.replace(/'/g, "\\'");
}

/**
 * Generate a fish completion script.
 *
 * Fish's condition primitive (`__fish_seen_subcommand_from`) checks whether
 * a word occurs anywhere on the command line, not at an exact position —
 * there is no lightweight fish equivalent of the bash version's
 * associative-array path walk without hand-rolling one in fish script. Fish
 * output therefore covers only static subtrees: branch and leaf positions
 * reachable without crossing a fallback (wildcard-capture) segment.
 * Fallback-nested commands (e.g. `books <bookId> read`) still work when
 * typed by hand — they just don't tab-complete under fish, unlike bash and
 * zsh (above).
 */
export function generateFishCompletion(
  root: Node,
  schemas: SchemaMap,
  programName: string,
): string {
  const levels = buildLevels(root, schemas).filter((l) => !l.key.includes("*"));
  const lines: string[] = [
    "# fish completion for " + programName,
    "# Generated by @rhi-zone/fractal-cli-api-projector (static — see completions.ts).",
    "# Limitation: fallback (wildcard-capture) subtrees are not completed — see",
    "# generateFishCompletion's doc comment in completions.ts.",
    "",
  ];

  for (const l of levels) {
    const ancestorWords = l.key === ROOT_KEY ? [] : unescapeJoin(l.key, " ");
    const condition =
      ancestorWords.length > 0
        ? "__fish_seen_subcommand_from " +
          ancestorWords.map((w) => "'" + fishEscape(w) + "'").join(" ")
        : "__fish_use_subcommand";

    if (!l.isLeaf) {
      for (const name of l.statics) {
        lines.push(
          "complete -c " +
            programName +
            ' -n "' +
            condition +
            '"' +
            " -a '" +
            fishEscape(name) +
            "'",
        );
      }
    } else {
      for (const f of l.flags) {
        const base =
          "complete -c " +
          programName +
          ' -n "' +
          condition +
          '"' +
          " -l '" +
          fishEscape(f.name) +
          "'";
        if (f.enumValues !== undefined && f.enumValues.length > 0) {
          lines.push(base + " -a '" + f.enumValues.map(fishEscape).join(" ") + "'");
        } else {
          lines.push(base);
        }
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// Dispatch
// ============================================================================

export function generateCompletions(
  shell: ShellName,
  root: Node,
  schemas: SchemaMap,
  programName: string,
): string {
  switch (shell) {
    case "bash":
      return generateBashCompletion(root, schemas, programName);
    case "zsh":
      return generateZshCompletion(root, schemas, programName);
    case "fish":
      return generateFishCompletion(root, schemas, programName);
  }
}
