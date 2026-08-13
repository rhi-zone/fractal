// Generic registry mechanism — lookup, aliasing, and merging over entries as
// data.
//
// This module knows nothing about importers, projectors, TypeRefs, or which
// formats exist. It is the dispatch substrate the concrete registries are
// built from, and its only requirement of an entry is that it has an `id`.
// Keeping it entry-agnostic is what lets the base registry and the
// `typescript`-backed extension be *the same kind of thing*, mergeable through
// one function, rather than two parallel dispatch surfaces a caller has to
// choose between.
//
// It is also why this file has no imports at all. `typescript` is an optional
// peer dependency, so a consumer that never touches the TypeScript-backed
// entries must not typecheck against `ts.*` — not even in a type position.
// A registry generic in its entry type never names those types, so the
// isolation survives merging: the union `Registry<A | B>` only comes into
// existence in code that already imported both halves.

/** The one thing every registry entry must have. */
export interface RegistryEntry {
  readonly id: string;
}

/** An immutable, ordered, id-keyed collection of entries.
 *
 * `entries`/`ids` are canonical and in registration order — that is what a
 * UI enumerates and a doc generator lists. `byId` additionally resolves
 * aliases, so it is strictly larger whenever aliases exist and is what
 * `lookup` consults. */
export interface Registry<E extends RegistryEntry> {
  readonly entries: readonly E[];
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, E>;
}

/** Build a registry from entries plus optional alias -> canonical-id mappings.
 *
 * Both duplicate canonical ids and aliases that shadow or dangle are thrown
 * on rather than resolved by a precedence rule. A registry is written once and
 * read everywhere; a silently-dropped entry would surface as a format that
 * inexplicably does nothing, which is far more expensive to diagnose than a
 * startup error. */
export function defineRegistry<E extends RegistryEntry>(
  entries: readonly E[],
  aliases: Readonly<Record<string, string>> = {},
): Registry<E> {
  const byId = new Map<string, E>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`duplicate registry id: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const [alias, target] of Object.entries(aliases)) {
    if (byId.has(alias)) throw new Error(`alias ${alias} collides with an existing id`);
    const entry = byId.get(target);
    if (entry === undefined) throw new Error(`alias ${alias} targets unknown id ${target}`);
    byId.set(alias, entry);
  }
  return { entries, ids: entries.map((e) => e.id), byId };
}

/** Combine registries into one, preserving order and rejecting collisions.
 *
 * The entry types need not be identical: merging a `Registry<A>` with a
 * `Registry<B>` yields a `Registry<A | B>`, which callers narrow with whatever
 * discriminator the entries carry. This is the extension point — an optional
 * capability ships as its own registry in its own module, and a caller that
 * wants it merges it in and afterwards uses one lookup, one id space, and one
 * error path for everything. */
export function mergeRegistries<E extends RegistryEntry>(
  ...registries: readonly Registry<E>[]
): Registry<E> {
  const entries: E[] = [];
  const byId = new Map<string, E>();
  for (const registry of registries) {
    for (const [id, entry] of registry.byId) {
      const existing = byId.get(id);
      if (existing !== undefined && existing !== entry) {
        throw new Error(`conflicting registry id when merging: ${id}`);
      }
      byId.set(id, entry);
    }
    entries.push(...registry.entries);
  }
  return { entries, ids: entries.map((e) => e.id), byId };
}

/** Resolve `id` (canonical or alias), or throw naming what kind of thing was
 * being looked up — `kind` is woven into the message because "unknown foo" is
 * useless to someone who mistyped an output format. */
export function lookup<E extends RegistryEntry>(
  registry: Registry<E>,
  kind: string,
  id: string,
): E {
  const entry = registry.byId.get(id);
  if (entry === undefined) throw new Error(`unknown ${kind}: ${id}`);
  return entry;
}

/** Whether `id` resolves, without throwing. */
export function has<E extends RegistryEntry>(registry: Registry<E>, id: string): boolean {
  return registry.byId.has(id);
}
