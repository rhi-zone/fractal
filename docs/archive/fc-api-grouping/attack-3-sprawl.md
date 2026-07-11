# Attack 3 — "The design just moves the sprawl into relation carriers"

*Red-team pass against `design.md` (Carrier-Grouped Function Core v1). Target: the
reified-relation mechanism (§1 "Reified relation carrier", §2c/§2d, §3.1 step 4). Thesis
under test: at the owner's stated scale (~100 slices, ~1.5 subjects/op) the design trades a
flat sprawl of free functions for a **sprawl of tiny relation micro-carriers** — no better,
possibly worse.*

---

## 0. The arithmetic of the owner's own numbers

Owner: **~100 ops, ~1.5 subjects each.** "1.5 subjects" means roughly **half the ops touch
two subjects.** So ~50 ops are two-subject candidates. Decision procedure §3.1 step 4
reifies whenever "no single one owns the property it maintains" — which is the *normal* case
for a join/edge op (assign, tag, grant, watch, link). Generously assume 40 of the 50 reify
(the other 10 dock as a producer/read to one subject).

Relation carriers host few ops. The design's own examples set the rate: Transfer =
make+op = **2**, Assignment = make+op = **2**. So:

```
40 relation-reifying ops ÷ ~2 ops per relation carrier ≈ 20 relation carriers
50 single-subject ops    spread over               ≈ 20 entity carriers
```

**Relation carriers ≈ entity carriers.** The reified set is not a garnish on the entity set;
it is a *second population the same size as the first*, made entirely of nouns that do not
appear in the domain schema. And §4.2 (the design's own self-critique) concedes step 4
**over-fires** on ambient-state effects (`RateLimitCheck` carriers), which only pushes the
relation count *above* the entity count.

---

## 1. A concrete 20-entity domain, counted

Domain: a project/work-management + billing SaaS. 20 real entities:

`User, Organization, Team, Project, Task, Comment, Document, File, Folder, Tag, Milestone,
Sprint, Role, Permission, Invitation, Notification, Subscription, Invoice, Payment,
Webhook.`

Now apply §3.1 step 4 to every cross-cutting op. Each edge below has a predicate that reads
**two** subjects' fields and no single subject is a superset → the rule *mandates*
reification.

| # | Reified relation carrier | Subjects | Its "invariant" (§3.2 breaking predicate) | Ops | Real law? |
|---|--------------------------|----------|-------------------------------------------|-----|-----------|
| 1 | Settlement | Payment × Invoice | `sum(payments) ≤ invoice.total` | applyPayment, refund | **yes** (conservation) |
| 2 | TaskDependency | Task × Task | no cycles in the dep graph | addDep, removeDep | **yes** (acyclicity) |
| 3 | OrgSeat | User × Organization | `activeSeats ≤ plan.cap` | join, leave | **yes** (cardinality) |
| 4 | TeamMembership | User × Team | `a.active` | add, remove | no (flag) |
| 5 | ProjectAssignment | User × Project | `a.active` | assign, revoke | no (flag) |
| 6 | TaskAssignment | User × Task | `a.active` | assign, unassign | no (flag) |
| 7 | RoleGrant | User × Role | `a.active` | grant, revoke | no (flag) |
| 8 | PermissionGrant | Role × Permission | `a.active` | allow, deny | no (flag) |
| 9 | Tagging | Tag × Task | `a.active` | tag, untag | no (flag) |
| 10 | Watch | User × Task | `a.active` | watch, unwatch | no (flag) |
| 11 | SprintScope | Task × Sprint | `a.active` | addToSprint, remove | no (flag) |
| 12 | ProjectTeam | Team × Project | `a.active` | attach, detach | no (flag) |
| 13 | Filing | Document × Folder | `a.active` | file, move | no (flag) |
| 14 | Billing | Subscription × Organization | `a.active` | subscribe, cancel | no (flag) |
| 15 | Mention | Comment × User | (none) | mention | **1 op** |
| 16 | ReadReceipt | User × Notification | (none) | markRead | **1 op** |
| 17 | Delivery | Webhook × Notification | (none) | deliver | **1 op** |

**Count: 20 entity carriers vs 17 relation carriers** — 37 total carriers for a 20-noun
domain. The relation population is ~85% the size of the entity population, and I was
*conservative* (I docked Comment.authorId, Task.milestoneId, File.folderId to their owning
entity instead of reifying them; a literal reading of step 4 reifies those too, pushing
relation carriers past 20 and **over** the entity count).

---

## 2. The three breaks, made concrete

### Break A — most relation carriers are free functions in a noun costume

Look at the "Real law?" column. **Of 17 relation carriers, only 3 carry a genuine
cross-subject law** (Settlement, TaskDependency, OrgSeat). The other **14 either have the
identical trivial invariant `a.active` (11 of them) or no invariant at all (3 one-op
carriers).**

The design's whole justification for reifying (§2c/§2d, §3.2) is that *a real conserved
property lives on the pair*. But 11 of these carriers copy-paste the *same* placeholder
predicate `a => a.active` — a boolean flag on the edge row, which is not a cross-subject law
at all; it is "the row exists." That is precisely the design's Assignment example (`invariant:
a => a.active`), and it generalizes to every join table. A carrier whose "invariant" is
`row.active` and whose ops are `create` + `soft-delete` **is a free function pair wearing a
noun.** The design named the anti-pattern in §4 and then instantiated it 11 times.

The 3 one-op carriers (Mention, ReadReceipt, Delivery) are worse: **one op, no invariant.**
`Mention` is `carrier<Mention>` hosting exactly `mention(comment, user) => Mention`. That is
a single free function that has been forced to invent a type, a name, and a file. This is the
exact anti-pattern the design set out to kill, reproduced one-per-edge.

### Break B — the third-noun navigation failure (not solved anywhere)

A dev wants "assign a user to a project." They reason from what they *have* in hand: a
`User` and a `Project`. They look under `User` — not there (it docked to the edge). They look
under `Project` — not there. **The op lives under `ProjectAssignment`, a third noun that
appears in neither the dev's task nor the domain schema.** To find it they must already know
the entire invented edge vocabulary.

Contrast the flat sprawl the design replaced: `grep assign` finds `assignUserToProject`
instantly. **The carrier grouping makes the reified half of the API *less* greppable and
*less* navigable than the flat list it replaced**, because the entry point (an invented noun)
is exactly the thing the searcher does not know. The design provides an index for
capabilities ("index, never a home", §1) but provides **no discovery index for relation
carriers from their endpoint subjects.** A user staring at `User` cannot discover that 6 of
this domain's edges (TeamMembership, ProjectAssignment, TaskAssignment, RoleGrant, Watch,
OrgSeat, Mention) even involve users.

This is the crux of the "moves the sprawl" charge: grouping reduces *bucket count* (37 < 100)
but for the reified subset it **degrades discoverability below the flat baseline.** Sprawl
didn't shrink; it relocated into a namespace with no door from the nouns devs actually hold.

### Break C — naming pressure = bikeshedding at scale, with the tool forbidden to help

Every one of the 17 carriers needs a noun *invented and agreed*. The same user-belongs-to-a-
group edge is legitimately nameable as **Membership / Enrollment / Assignment / Seat / Grant
/ Affiliation.** My table already drifted: `OrgSeat` vs `TeamMembership` vs
`ProjectAssignment` — three different nouns for one structural pattern (user ∈ group),
chosen by *my* taste in one sitting. Across a team and a year you get `ProjectAssignment` in
one module and `ProjectMember` in another for the same edge. There is no schema anchor to
converge on (the edge has no pre-existing domain name the way `User` does), and the project's
own **"no suggesting names"** rule means neither the tooling nor the assistant is allowed to
break the tie. **17 forced naming debates, each a bikeshed, each a future duplicate-carrier
risk.** The flat-function world had this too (`assignUserToProject`) but the verb-first name
was self-describing and greppable; the noun-first carrier name is neither.

---

## 3. Verdict: **FIXABLE** (strong sprawl, but not fatal)

The attack lands hard on three points — relation carriers rival entity carriers in count,
~82% of them (14/17) carry no real cross-subject law and are the design's own confessed
anti-pattern, and the reified subset is *less* discoverable than the flat list it replaced.

But it is **not FATAL**, for one honest reason: total bucket count still *drops* (37 vs 100),
and the 3 genuinely-lawful carriers (Settlement, TaskDependency, OrgSeat) *are* real
architectural wins the flat list buried. The failure is not the mechanism; it is the
**absence of a stop-condition and a discovery door.** All three breaks are curable with local
changes that reuse machinery the design already contains.

### Minimal fix (three parts, all reuse existing design concepts)

1. **Reification threshold — a carrier must earn its noun.** Amend §3.1 step 4: reify a
   relation carrier **only if** the §3.2 breaking predicate reads ≥2 subjects' fields *and is
   non-trivial* (i.e. not reducible to "the edge row exists"). A carrier whose only invariant
   is `row.active` and whose ops are create + soft-delete does **not** get reified — it docks
   as an `op`/`read` on the higher-cardinality subject with the counterpart passed as an
   argument (`User.op("joinTeam", (u, team) => …)`), or lives in a single shared
   `Edges` host. This collapses the 14 flag/one-op carriers, leaving **~3 lawful relation
   carriers** for the 20-entity domain. The threshold is exactly the "genuine conservation
   law vs op that happens to touch two things" distinction §4.2 already admits is missing.

2. **Dual-home discovery index (reuse the capability "index, never a home" pattern).** When
   an edge *is* reified, index it under **both** endpoint nouns: `User.edges` and
   `Project.edges` both surface `ProjectAssignment`. The edge still has one home (no second
   source of truth), but is *discoverable* from either subject the dev is holding. This is the
   §1 capability mechanism ("an index, never a home") applied to relations — zero new
   concepts. Kills Break B.

3. **Deterministic edge naming.** Name a reified edge from its ordered subject pair + primary
   verb (`User×Project:assign`) rather than an invented singular noun. No taste, no bikeshed,
   no "no-suggesting-names" violation — the name is *derived*, and it is greppable from either
   subject. Kills Break C.

With the threshold, the "carriers > entities" arithmetic inverts (3 relation vs 20 entity),
the noun-costume free functions dock back onto real subjects, and the two survivors that
remain are the ones with laws worth the ceremony. The design's uniformity claim survives; its
un-gated reification does not.
