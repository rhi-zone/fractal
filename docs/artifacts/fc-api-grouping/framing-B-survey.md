# Framing B — Empirical Cross-Paradigm Survey: How Real Systems Cluster Many Operations

**Problem.** A typed-data-transformation core is just `T => U` functions + composition. Users
author a library of operations on top. Left unstructured, this becomes a flat sprawl of free
functions: thousands of names in one namespace, no map for "where does the operation I need
live?", no map for "where should the operation I'm writing go?". We want the *organizing
principle* — the axis along which operations cluster — derived not from taste but from what
systems that already solved this problem converged on.

**Method.** Survey systems that expose *many* operations and were forced to solve sprawl.
For each: (1) the **unit of grouping**, (2) what **determines membership** in a unit, (3) what
goes **wrong** when grouping is absent or chosen on the wrong axis. Then strip surface syntax
and ask what the *successful* ones share.

---

## Per-system table

| System | Unit of grouping | Membership determinant | What goes wrong (no grouping / wrong axis) |
|---|---|---|---|
| **gRPC / Protobuf** | `service` (a set of RPCs) over message types | RPCs that operate on / return the same resource-shaped messages; cohesive responsibility of one server | One god-service with 200 methods → unversionable, unsplittable, every client depends on everything; or methods grouped by caller (UI screen) → same op duplicated per screen |
| **GraphQL** | Object **type**; fields/resolvers hang off the type they return-from or belong-to | A resolver belongs to the type whose field it computes (`User.posts` lives on `User`) | "Anemic"/flat schema: a `Query` root with 300 fields and no object types → no traversal, no reuse, every client re-derives relationships. Grouping by feature instead of type → same type's fields scattered |
| **Smalltalk / OO** | The **object/class**; methods are messages the object answers | A method belongs to the class of the receiver it acts on (data + behavior co-located) | Free functions reaching into object internals → broken encapsulation; "feature envy"; behavior for one concept smeared across many classes |
| **Erlang/OTP** | **Module** = one concept's API; **behaviour** = a contract (generic engine + callback module) | Functions on the same state/process; behaviour membership = "implements these callbacks" | Without behaviours, every server hand-rolls the same loop → no shared structure; modules grouped by layer not concept → ripple edits across modules per change |
| **Unix** | The **tool** (one program, one job); composition via a *uniform interface* (text streams/pipes) | One tool = one transformation; membership is "does one thing well" | Monolithic do-everything programs (the thing Unix rejected); or tools with *non-uniform* interfaces → can't compose, each pair needs a custom adapter |
| **DDD** | **Aggregate** (consistency boundary) inside a **bounded context** (language boundary) | Objects that must stay transactionally/invariant-consistent together; one ubiquitous language | Anemic domain model: data bags + a sprawl of free "service" functions → invariants enforced nowhere, logic duplicated; contexts split on wrong axis → same term means two things, integration chaos |
| **Standard libraries** | **Module / package** usually keyed to a **data type** or namespace (`String`, `List`, `Map`, `math`, `os`) | Operations whose *primary operand* is that type, OR operations sharing a domain (IO, time) | Flat global namespace (early C, PHP `str*`/`array_*` prefixes) → name collisions, no discoverability, no autocomplete locus; grouping by feature → can't find "all the things I can do to a List" |
| **Capability systems** | The **capability/object reference** — authority *bundled with* the operations it permits | An operation is reachable iff you hold a reference; ops travel with the resource | Ambient authority (ACL/global functions any code can call) → no locality of reasoning, confused-deputy, can't tell who can do what to what |
| **SQL / relational** | The **relation (table)** + a *closed algebra* of operators (select/project/join…) | Data clustered by relation; operations are a small fixed universal set, not per-table | Operations defined per-table (one bespoke proc per table per action) → combinatorial sprawl; the algebra's win is that ops are *few and uniform*, data is what varies |

---

## Reading the table: two distinct moves, often conflated

The systems actually use **two different strategies**, and confusing them is a common failure:

1. **Cluster operations around the principal data type / resource they act on.**
   gRPC services around messages, GraphQL fields on the type they belong to, OO methods on the
   receiver class, stdlib modules keyed to `String`/`List`, DDD aggregates, capabilities bound
   to a reference. The unit's identity *is* a data shape, and an operation's membership is
   decided by "what does it primarily operate on / return?"

2. **Keep operations few and uniform; let the data vary.**
   Unix (every tool speaks the one text-stream interface) and SQL's relational algebra (a small
   closed set of operators that work on *every* relation). Here you don't grow the operation
   namespace at all — you grow the *data*, and composition is universal because the interface
   is uniform.

These are not in conflict; they are the two halves of the same invariant (below). Strategy 1
says *where an operation lives*; strategy 2 says *how operations connect*. The healthy systems
do both: a cohesive home keyed to a type, plus a uniform seam that lets units compose without
bespoke adapters.

---

## What goes wrong — the failure modes, named

- **Flat sprawl (no axis).** Early C / PHP: thousands of `str_`, `array_` functions in one
  global namespace. No discoverability, no autocomplete anchor, name collisions. This is
  exactly the danger the brief names.
- **Anemic model (data and behavior split apart).** DDD's named anti-pattern and GraphQL's
  flat-`Query`-root failure: data is dumb bags, behavior is a separate pile of free functions.
  Invariants get enforced nowhere; the same logic is re-derived per call site.
- **Wrong axis — grouping by *feature/caller* instead of by *operand*.** A method/RPC/resolver
  grouped by the UI screen or use-case that calls it. Result: the same operation on the same
  type is duplicated across features, and "all the things I can do to X" is unfindable. The
  consistent empirical finding (stdlib, GraphQL, gRPC) is that **feature/caller is the wrong
  primary axis**; it can be a *secondary* index but not the home.
- **Non-uniform seam.** Even with good clusters, if units don't share a composition interface
  (Unix's counter-example: monolithic tools, or tools with ad-hoc formats) you get O(n²)
  adapters and composition dies.
- **God-unit.** One service/module/class that owns everything → unversionable, untestable,
  every consumer coupled to the whole.

---

## The convergent invariant

Beneath the syntax, the successful systems share one principle:

> **Operations cluster around the data they transform — the unit of grouping is a *type/
> resource/consistency-boundary*, not a feature, layer, or caller — and the units interoperate
> through a single uniform composition seam, so the namespace grows with the data, not with the
> cross product of operations × callers.**

Two load-bearing clauses:

1. **Home = operand.** An operation belongs with the type it primarily acts on/returns. This
   gives a deterministic answer to *both* "where do I find it?" and "where do I put it?", makes
   the unit cohesive (data + behavior co-located, killing anemia), and turns the cluster into a
   discoverability anchor (the autocomplete/`Type.` locus). Membership is decided by the data,
   which is *objective* — unlike "feature", which is a moving, subjective target.

2. **Uniform seam.** Units must compose through one interface (Unix text streams, SQL's closed
   algebra, GraphQL's typed graph traversal, function composition `T => U`). This is what keeps
   the count of *connection mechanisms* at one instead of n², and it's why the namespace scales
   with the number of *types* rather than the number of *operation-pairs*.

**Clearest single example: GraphQL.** It makes the invariant literal. A field/resolver lives on
the object type it belongs to (home = operand); the entire surface composes through one uniform
mechanism — typed graph traversal from a type to its fields' types. The contrast case is built
into the ecosystem: the anemic flat-`Query`-root schema (all operations on one root, grouped by
feature) is *named as the failure*, and the fix is *exactly* "move fields onto the types they
return-from." It demonstrates both clauses and its own counter-example in one system.

---

## The strongest case AGAINST the invariant

**Unix (and, in the same spirit, SQL's relational algebra) is where "home = operand" fails —
and deliberately so.** Unix tools are emphatically *not* grouped by the data type they act on.
`grep`, `sort`, `sed`, `wc` are universal: they work on *any* text stream regardless of what the
bytes mean. There is no `String` module, no per-type home; the operand type is intentionally
erased into one universal interface. SQL is the same: the relational operators are a small fixed
set that apply to *every* relation — you don't write per-table operations.

This is a genuine counter-example to clause 1, and it reveals the invariant's real shape: there
are **two stable equilibria**, and the unhealthy state is *between* them.

- **Equilibrium A (many types, few uniform ops):** Unix/SQL. Erase the operand into a universal
  interface; keep the operation set tiny and closed; let *data* carry all the variety.
- **Equilibrium B (rich per-type operation sets):** OO/stdlib/GraphQL/DDD. Give each type a
  cohesive home and grow operations *per type*, held together by composition.

Both avoid sprawl. What sprawls is the **middle**: many operations *and* no operand-keyed home
*and* no uniform seam — i.e. free functions that are neither universal-over-a-uniform-interface
nor docked to the type they act on. The invariant, stated to survive the counter-example, is:

> **Avoid the middle. Either make operations universal over one uniform interface (few ops, the
> data varies), or dock every operation to the type it transforms and compose the docked units
> uniformly (ops per type, the types vary). Sprawl is the failure to commit to either.**

For a `T => U` function core, clause-2 (uniform seam) is *already given* — composition is the
universal interface. The open design choice is therefore **clause 1**: dock each operation to a
primary type (Equilibrium B, the OO/stdlib/GraphQL shape) so the namespace is indexed by type,
turning a flat function sprawl into a set of cohesive, type-keyed operation clusters.

---

## Sources

- [Structure by Type vs Feature — maestros](https://maestros.io/structure-by-type-vs-feature)
- [Organizing modules in a project — F# for fun and profit](https://fsharpforfunandprofit.com/posts/recipe-part3/)
- [Bounded Contexts: Behavior Over Data Structures](https://ricofritzsche.me/bounded-contexts-behavior-over-data-structures/)
- [Sapiensworks — Identifying Bounded Contexts and Aggregates](https://blog.sapiensworks.com/post/2014/10/31/DDD-Identifying-Bounded-Contexts-and-Aggregates-Entities-and-Value-Objects.aspx)
- [Resolvers — Apollo GraphQL Docs](https://www.apollographql.com/docs/apollo-server/data/resolvers)
- [Schemas and Types — GraphQL](https://graphql.org/learn/schema/)
- [Basics of the Unix Philosophy](https://cscie2x.dce.harvard.edu/hw/ch01s06.html)
- [Deconstructing the "Unix philosophy" — Ted Inski](https://www.tedinski.com/2018/05/08/case-study-unix-philosophy.html)
- [Where the Unix philosophy breaks down — John D. Cook](https://www.johndcook.com/blog/2010/06/30/where-the-unix-philosophy-breaks-down/)
- [Clients and Servers — Learn You Some Erlang](https://learnyousomeerlang.com/clients-and-servers)
- [gen_server Behaviour — erlang.org](https://www.erlang.org/docs/22/design_principles/gen_server_concepts.html)
- [Capability-based security — Wikipedia](https://en.wikipedia.org/wiki/Capability-based_security)
