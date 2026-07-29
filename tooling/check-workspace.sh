#!/usr/bin/env bash
# Detect broken `node_modules` symlinks before they surface as a confusing
# wall of "Cannot find module" errors or an ENOENT thrown from inside a test.
#
# Deliberately plain shell + coreutils: this checks the dependency tree, so it
# must not itself depend on the dependency tree. A bun/TypeScript version would
# fail to start under exactly the conditions it exists to diagnose.
#
# Two distinct failure modes, which want different responses:
#
#   FOREIGN — a dangling link whose target escapes the repository. Bun's
#     isolated linker points each workspace package's `node_modules/<dep>` at a
#     store under the workspace root; if an install resolved that root to a
#     different checkout, every link is well-formed but points into a tree that
#     may not exist here. This breaks the build, and `bun install` fixes it by
#     rewriting the links against the correct root. Fails the check.
#
#   STALE — a dangling link whose target stays inside the repository, left over
#     from a workspace package that was renamed or removed. `bun install` does
#     not prune these. Nothing imports them, so they are noise rather than
#     breakage. Reported, but does not fail the check: a check that cries wolf
#     over known-harmless cruft is a check people learn to skip.
#
# Silent on success. This runs ahead of every build and test, and a guard that
# reports "all clear" on every invocation trains people to stop reading it —
# so by default it says nothing unless it has something actionable. Pass
# `--verbose` (as `bun run check:workspace` does) to see the full picture.
set -uo pipefail

verbose=0
[ "${1:-}" = "--verbose" ] && verbose=1

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root" || exit 2

foreign=()
stale=()

# `-xtype l` matches symlinks whose target does not resolve — cheaper and more
# direct than resolving every one of the ~900 links by hand. `.direnv` holds
# legitimate absolute links into the nix store and is not a dependency tree.
while IFS= read -r link; do
  target=$(readlink "$link")
  dir=$(dirname "$link")
  case "$target" in
    /*) resolved="$target" ;;
    *) resolved="$dir/$target" ;;
  esac
  # Normalize without requiring the path to exist (realpath -m is coreutils).
  resolved=$(realpath -m "$resolved" 2>/dev/null || echo "$resolved")
  case "$resolved" in
    "$root"/*) stale+=("$link -> $target") ;;
    *) foreign+=("$link -> $target") ;;
  esac
done < <(find . -path ./.direnv -prune -o -type l -xtype l -print 2>/dev/null | grep '/node_modules/')

# Stale links are shown as context when something is actually wrong, or on
# explicit request — never as routine build chatter.
if [ ${#stale[@]} -gt 0 ] && { [ $verbose -eq 1 ] || [ ${#foreign[@]} -gt 0 ]; }; then
  printf 'note: %d stale node_modules symlink(s) pointing at removed workspace packages.\n' "${#stale[@]}"
  printf '      Harmless (nothing imports them); bun install does not prune them.\n'
  for entry in "${stale[@]:0:5}"; do printf '      %s\n' "$entry"; done
  [ ${#stale[@]} -gt 5 ] && printf '      ... and %d more\n' "$((${#stale[@]} - 5))"
fi

if [ ${#foreign[@]} -gt 0 ]; then
  printf '\nERROR: %d node_modules symlink(s) point outside this repository.\n' "${#foreign[@]}"
  printf 'The dependency store was linked against a different workspace root, so\n'
  printf 'builds will fail with missing-module errors and tests with ENOENT.\n\n'
  for entry in "${foreign[@]:0:10}"; do printf '  %s\n' "$entry"; done
  [ ${#foreign[@]} -gt 10 ] && printf '  ... and %d more\n' "$((${#foreign[@]} - 10))"
  printf '\nRecover with:\n\n  bun install\n\nrun from %s\n' "$root"
  exit 1
fi

[ $verbose -eq 1 ] && printf 'workspace ok: no node_modules symlinks escape the repository.\n'
exit 0
