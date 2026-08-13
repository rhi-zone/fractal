// packages/fractal/src/http.ts — @rhi-zone/fractal/http
//
// Re-exports `@rhi-zone/fractal-http-api-projector`'s root surface. Deeper
// subpaths of that package (`/preset`, `/layers`, `/extensions/*`, ...) are
// NOT mirrored here — an umbrella that re-exported 23 subpaths would be a
// second copy of the package's module layout. Import the projector package
// directly for those; it is a hard dependency of this one, so it is already
// installed.

export * from "@rhi-zone/fractal-http-api-projector";
