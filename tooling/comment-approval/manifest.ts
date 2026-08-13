// tooling/comment-approval/manifest.ts
//
// Load/save/query the approved-comment-hash manifest. Pure I/O + data-shape
// concerns only — extraction/hashing lives in comments.ts, git/CLI plumbing
// in cli.ts.

import type { ExtractedComment } from "./comments.ts";

export const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  /** First ~80 chars of the normalized comment, purely for a human skimming
   *  a diff of the manifest file or auditing what got approved — never read
   *  by the check logic itself. Kept short so a changed excerpt (which
   *  happens whenever the underlying comment — and therefore its hash and
   *  manifest key — changes) doesn't produce noisy diffs unrelated to the
   *  actual approval set. */
  readonly excerpt: string;
  /** ISO date the hash was added, for audit trail only — never read by the
   *  check logic. */
  readonly approvedAt: string;
}

export interface Manifest {
  readonly version: number;
  readonly approved: Readonly<Record<string, ManifestEntry>>;
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, approved: {} };
}

const EXCERPT_LENGTH = 80;

export function makeExcerpt(normalized: string): string {
  const firstLine = normalized.split("\n")[0] ?? "";
  return firstLine.length > EXCERPT_LENGTH ? `${firstLine.slice(0, EXCERPT_LENGTH)}…` : firstLine;
}

export function isApproved(manifest: Manifest, hash: string): boolean {
  return hash in manifest.approved;
}

/** Returns a NEW manifest with every comment's hash added (or refreshed —
 *  re-approving an already-approved hash just updates its excerpt/date,
 *  which is a no-op in practice since identical hash implies identical
 *  normalized text implies identical excerpt). Order-independent, so callers
 *  can fold this over comments from many files. */
export function approveComments(
  manifest: Manifest,
  comments: readonly ExtractedComment[],
  now: () => string = () => new Date().toISOString(),
): Manifest {
  const approved = { ...manifest.approved };
  const timestamp = now();
  for (const comment of comments) {
    approved[comment.hash] = { excerpt: makeExcerpt(comment.normalized), approvedAt: timestamp };
  }
  return { version: manifest.version, approved };
}

export function parseManifest(json: string): Manifest {
  const parsed = JSON.parse(json) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("approved" in parsed)) {
    throw new Error(
      'malformed comment-approval manifest: expected an object with an "approved" key',
    );
  }
  const obj = parsed as { version?: unknown; approved?: unknown };
  if (typeof obj.approved !== "object" || obj.approved === null) {
    throw new Error('malformed comment-approval manifest: "approved" must be an object');
  }
  return {
    version: typeof obj.version === "number" ? obj.version : MANIFEST_VERSION,
    approved: obj.approved as Record<string, ManifestEntry>,
  };
}

/** Serialized with keys sorted so re-running `approve` on an unchanged input
 *  produces a byte-identical file (no diff noise from JS's insertion-order
 *  object serialization) and so the manifest reads as a stable, diffable
 *  record rather than an append-order log. */
export function serializeManifest(manifest: Manifest): string {
  const sortedApproved: Record<string, ManifestEntry> = {};
  for (const hash of Object.keys(manifest.approved).sort()) {
    sortedApproved[hash] = manifest.approved[hash]!;
  }
  return `${JSON.stringify({ version: manifest.version, approved: sortedApproved }, null, 2)}\n`;
}

export async function loadManifest(path: string): Promise<Manifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) return emptyManifest();
  return parseManifest(await file.text());
}

export async function saveManifest(path: string, manifest: Manifest): Promise<void> {
  await Bun.write(path, serializeManifest(manifest));
}
