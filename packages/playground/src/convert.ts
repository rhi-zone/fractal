// Conversion bridge: the playground's view of `@rhi-zone/fractal-type-ir/registry`,
// which is environment-neutral — text (or parsed JSON) in, a `TypeRefDocument`
// through the middle, a `Projection` out. This module re-exports that
// registry directly rather than carrying its own copy of the dispatch, so the
// playground reaches the package's full set of projection targets.
//
// The checker-backed importers (`from-typescript`,
// `from-standard-schema-type`) are omitted. They are mergeable into the base
// registry via `/registry-core`'s `mergeRegistries`, but merging them here
// would pull the TypeScript compiler into the browser bundle to support an
// input shape — a file path plus a symbol plus a `ts.Program` — that a text
// pane cannot supply.
import type { TypeRefDocument } from "@rhi-zone/fractal-type-ir";
import { project as projectStructured, renderProjection } from "@rhi-zone/fractal-type-ir/registry";

export type {
  Projection,
  ProjectionOptions,
  Projector,
  Importer,
} from "@rhi-zone/fractal-type-ir/registry";

export {
  appliesTo,
  convert,
  getImporter,
  getProjector,
  importerIds,
  importerRegistry,
  ingest,
  projectorIds,
  projectorRegistry,
  renderProjection,
  project as projectStructured,
} from "@rhi-zone/fractal-type-ir/registry";

/** Project to display text. The registry preserves each target's real output
 * shape — JSON values, path -> content maps, header/implementation pairs —
 * but the playground has two text panes and nowhere to put structure, so this
 * is the one thing the playground adds: the flattening. Callers that want the
 * structure use `projectStructured`. */
export function project(id: string, doc: TypeRefDocument): string {
  return renderProjection(projectStructured(id, doc));
}
