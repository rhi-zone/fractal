// packages/fractal/src/index.ts — @rhi-zone/fractal
//
// Package root = the function core. Every projection subpath is useless
// without `api`/`op`/`Result`, so the umbrella's root is `api-tree` rather
// than a sixth thing to import.
//
// `export *` (rather than this repo's usual explicit named re-export lists)
// is deliberate here and in every sibling facade module: a facade that
// enumerates names is a second copy of the underlying package's public
// surface, and a copy that goes stale silently — an export added upstream
// would simply be missing from the umbrella until someone noticed. There is
// no logic in these modules to make the enumeration worth its maintenance.

export * from "@rhi-zone/fractal-api-tree"
