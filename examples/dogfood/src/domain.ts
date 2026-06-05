// examples/dogfood/src/domain.ts
//
// The use-case layer for the prospects slice — a GENERIC reproduction of the
// SHAPE of a real CRM resource (a sales pipeline). It models the
// reference app's two load-bearing patterns:
//
//   1. Use cases return a Result<T, E> with a discriminated error `code` — they
//      NEVER throw for anticipated failures. The HTTP layer maps each code to a
//      status (404 / 409 / 422). This is the reference's
//      "use cases return Result, route surfaces the specific error code" rule.
//   2. A non-trivial multi-step orchestration (`assignProspect`): a role check +
//      a state mutation + a side effect (a notification), one failure mode each.
//
// In-memory store; no DB, no external deps.

export const STATUSES = ["new", "qualified", "converted", "lost"] as const;
export type ProspectStatus = (typeof STATUSES)[number];

export interface Prospect {
  id: string;
  contactName: string;
  source: string;
  status: ProspectStatus;
  assignedToUserId: string | null;
}

/** A discriminated result, mirroring the reference's `Result<ok, err>`. */
export type Result<T, E extends { code: string }> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

const okR = <T>(value: T): Result<T, never> => ({ ok: true, value });
const errR = <E extends { code: string }>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const prospects = new Map<string, Prospect>();
let seq = 1;

/** A captured notification side effect — asserted by tests to prove the
 *  orchestration fired exactly when it should (and not otherwise). */
export const notifications: { targetUserId: string; prospectId: string }[] = [];

/** A toy admin-user table (the reference reads the auth-owned users table to
 *  verify an assignee exists and has the right role before assigning). */
const adminUsers = new Set<string>(["alice", "bob"]);

export function reset(): void {
  prospects.clear();
  notifications.length = 0;
  seq = 1;
}

// ---------------------------------------------------------------------------
// Use cases (Result-returning)
// ---------------------------------------------------------------------------

/** List with optional status/source filters — the reference's filtered query. */
export function listProspects(filter: {
  status?: ProspectStatus;
  source?: string;
}): Prospect[] {
  let out = [...prospects.values()];
  if (filter.status !== undefined) {
    out = out.filter((p) => p.status === filter.status);
  }
  if (filter.source !== undefined) {
    out = out.filter((p) => p.source === filter.source);
  }
  return out;
}

export function createProspect(input: {
  contactName: string;
  source: string;
}): Prospect {
  const prospect: Prospect = {
    id: String(seq++),
    contactName: input.contactName,
    source: input.source,
    status: "new",
    assignedToUserId: null,
  };
  prospects.set(prospect.id, prospect);
  return prospect;
}

export function getProspect(
  id: string,
): Result<Prospect, { code: "NOT_FOUND" }> {
  const p = prospects.get(id);
  return p ? okR(p) : errR({ code: "NOT_FOUND" });
}

export function updateProspect(
  id: string,
  patch: { contactName: string },
): Result<Prospect, { code: "NOT_FOUND" }> {
  const p = prospects.get(id);
  if (p === undefined) return errR({ code: "NOT_FOUND" });
  p.contactName = patch.contactName;
  return okR(p);
}

export function deleteProspect(
  id: string,
): Result<null, { code: "NOT_FOUND" }> {
  return prospects.delete(id) ? okR(null) : errR({ code: "NOT_FOUND" });
}

// Allowed status transitions — the reference's `INVALID_TRANSITION` /
// `ALREADY_CONVERTED` state machine. "converted" is terminal.
const ALLOWED: Record<ProspectStatus, ReadonlySet<ProspectStatus>> = {
  new: new Set(["qualified", "lost"]),
  qualified: new Set(["converted", "lost"]),
  converted: new Set(),
  lost: new Set(["new"]),
};

/** Status transition — the multi-error use case. Maps to 404 / 409 / 422. */
export function updateProspectStatus(
  id: string,
  next: ProspectStatus,
): Result<
  Prospect,
  | { code: "NOT_FOUND" }
  | { code: "ALREADY_CONVERTED" }
  | { code: "INVALID_TRANSITION" }
> {
  const p = prospects.get(id);
  if (p === undefined) return errR({ code: "NOT_FOUND" });
  if (p.status === "converted") return errR({ code: "ALREADY_CONVERTED" });
  if (!ALLOWED[p.status].has(next)) {
    return errR({ code: "INVALID_TRANSITION" });
  }
  p.status = next;
  return okR(p);
}

/** Assign a prospect to an admin — the ORCHESTRATION: verify the target user
 *  exists and is an admin (auth-table read), mutate, then fire a targeted
 *  notification side effect when the assignee actually changes. Mirrors the
 *  reference's hand-written `POST /:id/assign`. */
export function assignProspect(
  id: string,
  userId: string,
): Result<
  Prospect,
  { code: "NOT_FOUND" } | { code: "INVALID_ROLE" }
> {
  const p = prospects.get(id);
  if (p === undefined) return errR({ code: "NOT_FOUND" });
  if (!adminUsers.has(userId)) return errR({ code: "INVALID_ROLE" });
  const previous = p.assignedToUserId;
  p.assignedToUserId = userId;
  if (previous !== userId) {
    notifications.push({ targetUserId: userId, prospectId: p.id });
  }
  return okR(p);
}
