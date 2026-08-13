// packages/fractal/src/http.ts — @rhi-zone/fractal/http
//
// Re-exports `@rhi-zone/fractal-http-api-projector`'s root surface. Deeper
// subpaths of that package (`/preset`, `/layers`, `/extensions/*`, ...) live
// only on the projector package itself, imported directly — it is a hard
// dependency of this one, so it is already installed. Mirroring all 23
// subpaths here would make the umbrella a second copy of the package's
// module layout.

export * from "@rhi-zone/fractal-http-api-projector";
