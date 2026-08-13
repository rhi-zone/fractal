// packages/fractal/src/index.ts — @rhi-zone/fractal
//
// Package root = the function core. Every projection subpath is useless
// without `api`/`op`/`Result`, so the umbrella's root is `api-tree` rather
// than a sixth thing to import.
//
// This module and every sibling facade module use `export *` instead of
// this repo's usual explicit named re-export lists: these facades carry no
// logic of their own, so an explicit list would only be a second copy of the
// underlying package's public surface — one that goes stale silently when an
// export is added upstream.

export * from "@rhi-zone/fractal-api-tree";
