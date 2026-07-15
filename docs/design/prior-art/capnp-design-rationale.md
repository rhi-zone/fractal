# Cap'n Proto: design rationale, as a "second attempt" at protobuf

## Provenance and framing

Cap'n Proto was created by Kenton Varda, who was "the primary author of Protocol
Buffers version 2, which is the version that Google released open source." In his
own words, on the Cap'n Proto site's introduction page:

> "Why do you pick on Protocol Buffers so much? Because it's easy to pick on
> myself. :) I, Kenton Varda, was the primary author of Protocol Buffers version 2
> ... Cap'n Proto is the result of years of experience working on Protobufs,
> listening to user feedback, and thinking about how things could be done
> better." (capnproto.org)

This is the single load-bearing fact for treating Cap'n Proto as evidence: it is
not "another schema IDL" competing for market share, it is the same designer
re-deriving the problem after watching the first design fail at Google's scale,
in production, over years. Where the two designs diverge, the divergence is a
recorded lesson, not a stylistic preference. Note also that Cap'n Proto is
explicitly *not* Google-affiliated — it was built independently, which is part
of why the FAQ can be this candid about protobuf's failure modes ("Things like
this have actually happened. At Google. Many times.").

The headline architectural bet, stated on the intro page: **there is no
encoding/decoding step**. The wire format *is* the in-memory format. "Cap'n
Proto gets a perfect score [in benchmarks] because there is no
encoding/decoding step. The Cap'n Proto encoding is appropriate both as a data
interchange format and an in-memory representation, so once your structure is
built, you can simply write the bytes straight out to disk!" Every other design
decision below is either a consequence of this bet or a fix for a specific
protobuf production failure.

Sources fetched directly for this document: `capnproto.org/faq.html`,
`capnproto.org/language.html`, `capnproto.org/encoding.html`,
`capnproto.org/rpc.html`, and `capnproto.org/` (introduction). Quotes below are
verbatim from these pages unless otherwise marked.

---

## 1. The `required` field disaster — and why validation was ripped out of the schema layer entirely

This is the most concrete, most-cited lesson, and it comes with a specific
incident narrative in the Cap'n Proto FAQ (question: *"How do I make a field
'required', like in Protocol Buffers?"*):

> "You don't. You may find this surprising, but the 'required' keyword in
> Protocol Buffers turned out to be a horrible mistake."

The mechanism of failure, as described:

- `required` fields were encoded identically to optional ones — the *only*
  difference was that the generated parser raised an error if a required field
  was absent. Validation was baked into the deserializer, not layered on top of
  it.
- Requirements are contextual: "different applications — or different parts of
  the same application, or different versions of the same application — place
  different requirements on the same protocol." A field required by one
  consumer may be irrelevant to another; an application may legitimately want
  to construct or forward a partially-complete message.
- Because the check lives in the parser, there is no way to relax it locally —
  "A field declared required, unfortunately, is required everywhere." The only
  fix is to change the schema itself from `required` to `optional`.

The incident: Alice and Bob exchange messages through a message-bus
infrastructure that parses every message just to read routing envelope fields,
without caring about payload content. Alice's team deprecates a required field
deep in a nested message and marks it optional; they update Bob and test
Alice↔Bob directly — but the *bus* in the test environment happens to run a
newer build than the one in production. In prod, the bus still runs an older
protobuf definition that still marks the field required. The moment Alice
stops sending it:

> "the whole message failed to parse, envelope and all. And to make matters
> worse, any other messages that happened to be in the same batch also failed
> to parse, causing errors in seemingly-unrelated systems that share the bus.
> Things like this have actually happened. At Google. Many times."

The design principle extracted from this: **schema-level required-ness
couples every future intermediary, forever, to every producer's current
completeness guarantees** — a single-writer, single-reader assumption baked
into a multi-party wire format. The fix Cap'n Proto adopts is not "make
required fields safer," it's structural: remove the concept, and push all
semantic validation into application code that actually understands the data
it's checking:

> "The right answer is for applications to do validation as-needed in
> application-level code. If you want to detect when a client fails to set a
> particular field, give the field an invalid default value and then check for
> that value on the server. Low-level infrastructure that doesn't care about
> message content should not validate it at all."

And structurally, the problem is foreclosed a second way: "Cap'n Proto doesn't
have any parsing step during which to check for required fields. :)" — because
there is no eager parse pass at all (see §4), there is no natural place to
smuggle schema-level validation back in.

Proto3 later independently arrived at the same conclusion and removed
`required` from the language — corroborating this wasn't an idiosyncratic call.

## 2. No `optional` either — optionality is pushed to the type system's actual primitives, not a keyword

Directly following from #1, Cap'n Proto also declines to give scalar fields a
first-class "is this field present" bit by default:

> "Cap'n Proto has no notion of 'optional' fields. A primitive field always
> takes space on the wire whether you set it or not (although default-valued
> fields will be compressed away if you enable packing)."

Instead, the FAQ offers two composable mechanisms, and is explicit that they
have different costs:

- **Union with `Void`**: `union { age @0 :Int32; ageUnknown @1 :Void; }` — this
  is *true* presence/absence, distinguishable from any valid value, but "still
  takes space on the wire, and in fact takes an extra 16 bits of space for the
  union tag."
- **Sentinel default value**: give the field "a bogus default value and
  interpret that value to mean 'not present'" — cheaper, but conflates "unset"
  with "explicitly set to the sentinel," which is exactly the kind of ambiguity
  nullable-scalar designs usually want to avoid.
- **Pointer fields are different in kind**: they start out `null`
  unconditionally, and nullness is queryable via a generated `hasFoo()`
  accessor. Critically: `getFoo()` on a null pointer *silently returns the
  default value* — "which is indistinguishable from a legitimate value, so
  checking `hasFoo()` is in fact the only way to detect nullness." This is a
  sharp, documented wart: the ergonomic accessor and the presence check are two
  different API surfaces, and using only the former silently discards
  presence information.

The lesson for a type IR: protobuf's history shows that a single overloaded
"optional" bit invites exactly the ambiguity described above (is "optional"
schema validation, or wire presence, or default-value elision?). Cap'n Proto's
answer is to decompose "optional" into the orthogonal concerns it's actually
made of — wire presence (pointer nullability), semantic absence (union +
Void), and default-value elision (packing) — and require the schema author to
pick explicitly which one they mean, rather than offering one keyword that
silently means "some blend of the above."

## 3. Unions: deliberately *not* first-class types, and why

Cap'n Proto unions are syntactically a property of a struct's fields, not a
free-standing type — `union { ... }` can only be declared inside a struct.
The FAQ/language doc anticipates the objection ("Wait, why aren't unions
first-class types?") and gives three reasons, each tied to a Protobuf-era
regret:

1. **Layout stability under evolution.** If unions were free-standing, their
   members would need independent numbering, and "the compiler, when deciding
   how to position the union in its containing struct, would have to
   conservatively assume that any kind of new field might be added to the
   union in the future. To support this, all unions would have to be allocated
   as separate objects embedded by pointer, wasting space." Embedding the
   union inside the struct's own field-number space lets the compiler compute
   a fixed, in-place layout.

2. **Free-standing unions are an evolution dead end.** Worked example given: a
   parser-token type is naturally a union (keyword | identifier | numeric
   literal | quoted string | ...). If it's a top-level type, and later you need
   to attach a line/column number to *every* token instance regardless of
   variant, "this is impossible without updating all users of the type,
   because the new information ought to apply to all token instances, not just
   specific members of the union." An embedded union lives inside a struct
   that can always grow new sibling fields — "it is always possible to add new
   fields to the struct later on."

3. **Retroactive unionization.** Because union members share the parent
   struct's field-number space, an *existing*, already-shipped field can later
   be absorbed into a newly-declared union (as long as it becomes the
   lowest-numbered — hence default — member and every other union member is
   new) "without changing its layout. This allows you to continue being able
   to read old data without wasting space when writing new data." This is a
   migration path protobuf categorically cannot offer, because protobuf has no
   unions with wire-compatible retrofitting.

The doc's closing claim is strong and worth flagging as an assertion to
weigh rather than a proven universal: "aside from being slightly unintuitive,
it is strictly superior" to first-class unions. The tradeoff it's eliding is
ergonomic — you can't pass "a union" around as an independent value; you always
carry the enclosing struct. Cap'n Proto's answer to that ergonomic gap is: "where
you would conventionally define a free-standing union type, in Cap'n Proto you
may simply define a struct type that contains only that union" — i.e. the
free-standing case is still expressible, just via a one-field wrapper struct,
so nothing is lost, only the accidental generality of "unions don't need a
container" is removed.

Union defaults: "By default, when a struct is initialized, the
lowest-numbered field in the union is 'set'." If no default variant is wanted,
convention is to declare an explicit lowest-numbered `unset` member.

## 4. Groups: reintroducing a feature Protobuf deprecated, but for a narrower reason

Protobuf's `group` feature was widely considered a mistake and was removed
going into proto3. Cap'n Proto brings groups back, and the docs address this
head-on (*"Wait, weren't groups considered a misfeature in Protobufs? Why did
you do this again?"*):

> "They are useful in unions, which Protobufs did not have. Meanwhile, you
> cannot have a 'repeated group' in Cap'n Proto, which was the case that got
> into the most trouble with Protobufs."

So the diagnosis is precise: it wasn't "groups" as a namespacing concept that
was the problem, it was specifically *repeated* groups (an ambiguous,
poorly-specified interaction between grouping and list-of-message semantics).
Cap'n Proto keeps the namespacing utility and removes the one composition that
caused trouble.

A group is explicitly *not* a separate object — "a group is not a separate
object from its containing struct: the fields are numbered in the same space
as the containing struct's fields, and are laid out exactly the same as if
they hadn't been grouped at all. Essentially, a group is just a namespace."
Its main use is pairing with unions so a variant can carry more than one field
(e.g. `circle :group { radius @1 :Float64; }` inside a union), which also
buys a second evolution path: a union variant declared as a group can grow
additional fields later without breaking wire compatibility — the doc's
`square` → `rectangle` example shows a variant literally renamed and given an
extra `height` field while remaining wire-compatible with old data (old
readers just see `height` as zero).

## 5. Generics: pointer-only, and why

`struct Map(Key, Value) { ... }`-style generics exist, restricted to pointer
types (structs, lists, blobs, interfaces) as parameters — "much like in Java."
The stated reason is purely a layout-stability argument, not a taste
preference: "allowing parameters to have non-pointer types would mean that
different parameterizations of a struct could have completely different
layouts, which would excessively complicate the Cap'n Proto implementation."
Since every pointer type is uniformly one word wide on the wire regardless of
what it points to, a generic struct's *own* layout is identical no matter what
it's parameterized with — the type parameter only affects how the pointed-to
data is interpreted, never where the pointer itself sits in the parent
struct. This is the same "layout must be computable from lower-numbered
fields alone" invariant driving the union design in §3, applied to generics.

Wire-compatibility follow-on: omitting parameters on a generic type reference
is equivalent to substituting `AnyPointer`, and such an unparameterized
reference is wire-compatible with any concrete parameterization — which is
what licenses the evolution rule "a non-generic type can be made generic ...
retaining backwards-compatibility" (§7), since a generic type's encoding is
defined to be byte-identical to the manually-specialized version.

## 6. Default values and the XOR-with-default encoding trick

Struct data-section fields are stored **XOR'd with their schema-declared
default value**, so that "a default struct is always all-zeros." Three
reasons given, and they compound:

1. Packing (Cap'n Proto's built-in cheap compression) deflates runs of zero
   bytes, so default-heavy messages compress well for free.
2. "Newly-allocated structs only need to be zero-initialized" — no per-field
   default-writing loop, and it requires no knowledge of the struct's type
   beyond its byte size.
3. **This is the schema-evolution payoff**: "If a newly-added field is placed
   in space that was previously padding, messages written by old binaries
   that do not know about this field will still have its default value set
   correctly — because it is always zero." Old writers, ignorant of the new
   field, leave that byte range as zero padding; because zero *is* XOR'd
   default, that reads back as "unset → default" for free, with no explicit
   versioning logic required at read time.

This is a case where a wire-format micro-decision (XOR-with-default) is
doing double duty as the mechanism that makes forward-compatible reads free.

## 7. Schema evolution: an explicit, exhaustively enumerated safety contract

Cap'n Proto's `language.html` has a section, *"Evolving Your Protocol,"* that
is unusually precise for an IDL doc — it draws three separate tiers rather
than a vague "additive changes are fine":

**Tier 1 — safe, and canonical-encoding-preserving:**
- New types/constants/aliases anywhere (no encoding effect).
- New fields/enumerants/methods, provided each new member's ordinal number is
  strictly greater than all previous members' numbers.
- New method parameters, appended at the end, required to carry default
  values.
- Source-level member reordering, as long as the *declared numbers* don't
  move — the number is the real identity, not declaration position.
- Renaming any symbolic name, as long as the numeric ID stays fixed (an
  explicit ID can be pinned via `capnp compile -ocapnp` if renaming a type
  that previously relied on an implicit, name-derived ID — see §8).
- Moving a type to a different lexical scope, if its ID is explicit.
- Moving an *existing* field into a **new** group or union, provided all
  other members of that group/union are new — with an explicitly flagged
  forward-compat caveat: an old reader that doesn't know about the new union
  wrapper may see garbage or throw if it tries to read the original field
  directly on a message where a *new* union member was set instead. The
  advice given is operational: only use the new members when talking to
  peers known to understand the union.
- Promoting a non-generic type to generic, or adding new generic parameters,
  provided all existing use sites are rewritten to bind the new parameter(s)
  explicitly to what they previously hardcoded.

**Tier 2 — safe for wire compatibility but *not* canonicalization-preserving**
(flagged as unsafe specifically for consumers relying on canonical form, e.g.
cryptographic signing over canonical bytes):
- `List(T)` for primitive/blob/list `T` may be upgraded to `List(U)` where `U`
  is a struct whose `@0` field has type `T` — a documented escape hatch for
  "I forgot to let each list element carry extra data," avoiding the
  "parallel lists" anti-pattern. Explicit carve-out: `List(Bool)` may *not* be
  upgraded this way — "implementing this for bit lists has proven
  unreasonably expensive" (a scar from an actual implementation attempt, not
  a design purity argument).

**Tier 3 — explicitly unsafe, enumerated rather than left implicit:**
- Changing a field/method/enumerant's number.
- Changing a field or parameter's type or default value.
- Changing a type's ID.
- Renaming a type that lacks an explicit ID (implicit IDs are name-derived).
- Moving a type to a new scope/file without an explicit ID (implicit IDs are
  scope-derived too).
- Moving an existing field into or out of an *existing* (already-shipped)
  union, or merging two or more existing fields into one new union.

The document also flags that these guarantees are native-encoding-only:
"these rules only apply to the Cap'n Proto native encoding. It is sometimes
useful to transcode Cap'n Proto types to other formats, like JSON, which may
have different rules (e.g., field names cannot change in JSON)" — i.e. the
evolution contract is a property of the wire format, and any lossy/renaming
projection to another representation (JSON, a REST API, etc.) must define and
honor its *own*, generally stricter, evolution contract. This is directly
relevant to a type IR that projects to multiple targets — compatibility
guarantees don't transitively survive a projection unless the projection is
specifically designed to preserve them.

## 8. Explicit numeric IDs instead of relying on names — and why

Every field/enumerant/method carries an explicit ordinal number (assigned at
declaration, `@N`), and every top-level type/file carries a 64-bit ID (either
explicit or implicitly derived by hashing parent-scope-ID + declared name).
The rationale given for *not* relying on a purely symbolic namespace (the more
conventional "package.Type" approach most IDLs use):

> "Programmers often feel the need to change symbolic names and organization
> in order to make their code cleaner, but the renamed code should still work
> with existing encoded data. It's easy for symbolic names to collide, and
> these collisions could be hard to detect in a large distributed system with
> many different binaries using different versions of protocols. Fully-
> qualified type names may be large and waste space when transmitted on the
> wire."

This generalizes the field-numbering discipline (numbers, not names, are wire
identity — see the union-numbering note in §3: "the purpose of the numbers is
to indicate the evolution order of the struct") up to the level of whole
types. The identity that must survive refactors is a stable, small, ideally
random-collision-resistant integer; the name is a presentation-layer
convenience layered on top, freely renamable as long as the ID is either
implicit-and-untouched or pinned explicitly across the rename.

## 9. Wire format: struct-of-fixed-data-plus-pointers, and why no per-field tags

Contrasted implicitly throughout (protobuf uses tag-prefixed,
varint-length-delimited fields; Cap'n Proto does not), the encoding spec
explains the struct layout directly: a struct value is "a pointer to its
content. The content is split into two sections: data and pointers, with the
pointer section appearing immediately after the data section. This split
allows structs to be traversed (e.g., copied) without knowing their type" —
i.e. generic, type-blind traversal/copying is a first-class design goal, not
an accident, because it's what makes zero-copy operations like "forward this
substructure to another RPC call without touching it" cheap and safe.

Field positions are computed by the compiler at schema-compile time rather
than tagged at runtime, under an invariant that directly mirrors the union
design: "The position of each field depends only on its definition and the
definitions of lower-numbered fields, never on the definitions of
higher-numbered fields. This ensures backwards-compatibility when new fields
are added." This single invariant is what makes §6 (XOR-default padding
reuse) and §7 (additive evolution) both work — it recurs as the load-bearing
rule across nearly every "why is X safe to evolve" answer in the docs.

The introduction page states the tradeoff plainly rather than hiding it:
fixed-width fields, unset-optional slots, and padding *do* waste wire bytes
relative to protobuf's tag/varint scheme — "Yes." — but Cap'n Proto ships a
purpose-built zero-allocation "packing" compression pass that specifically
targets these zero-byte runs, claiming parity or better vs. protobuf's size
while remaining faster than protobuf's own encode/decode. The framing: don't
pay the CPU cost of variable-width encoding to save bytes you can instead
recover for free via a compression pass targeted at exactly this format's
waste pattern.

## 10. Security posture as a first-class design constraint, not an afterthought

Because messages contain raw pointers/offsets that are read directly off the
wire, the FAQ addresses the obvious objection ("Aren't messages that contain
pointers a huge security problem?") directly: "Not at all. Cap'n Proto
bounds-checks each pointer when it is read and throws an exception or returns
a safe dummy value (your choice) if the pointer is out-of-bounds." And on
whether this reintroduces the "eliminated" parsing cost by another name: "No.
Compared to Protobuf decoding, the time spent validating pointers while
traversing a Cap'n Proto message is negligible." This is a quantitative claim
about the cost model, not just a correctness claim — the design bet is that
*bounds-checking pointers lazily as they're followed* is asymptotically
cheaper than protobuf's eager full-message parse, while still being
memory-safe.

## 11. RPC design is a direct extension of the type system, not a bolt-on

This is the part most relevant to how a schema/type IR should think about
"the type system" as encompassing more than data shapes.

**Interfaces are pass-by-reference capabilities, structs are pass-by-value.**
From `rpc.html`: "Structs (and primitive types) are passed over RPC by value,
but interfaces are passed by reference. So when `Directory.list` is called
remotely, the content of a `List(Entry)` ... is transmitted back, but for the
`node` field, only a reference to some remote `Node` object is sent." Interface
references double as capabilities: "it both designate an object to call and
confer permission to call it. When a new object is created, only the creator
is initially able to call it. When the object is passed over a network
connection, the receiver gains permission to make calls — but no one else
does." This is presented as a security property that falls directly out of
the type system's value/reference distinction, not a separately-bolted-on ACL
layer — "you almost don't need to think about access control at all" is the
claimed payoff.

**Promise pipelining is the actual reason the RPC layer exists in this shape.**
The core problem statement, illustrated with a filesystem interface example
at 1000ms latency: a clean four-call sequence (`open` → `open` → `size` →
`read`) costs four network round trips under naive RPC, which creates
pressure to flatten elegant object interfaces into a single "God" interface
taking path strings (`Filesystem.read(path, ...)`) purely to avoid the
latency — at the cost of reimplementing path parsing, caching, and ad hoc
authorization by hand. Cap'n Proto's fix is that every call returns a promise
immediately, and a promise supports being used as the *target or argument* of
a further call before it resolves — the client can send `bar()` addressed to
"whatever `foo()` will return" in the same round trip as `foo()` itself,
letting a dependent call chain collapse to one round trip regardless of depth
or fan-out ("diamond dependencies and everything").

The doc explicitly rejects "isn't this just sugar for combining methods"
(introducing a `foobar()` that fuses `foo()+bar()`) as the wrong fix, because
"this kind of arbitrary combining of orthogonal features quickly turns
elegant object-oriented protocols into ad-hoc messes" — i.e. hand-merging
methods to dodge round-trip cost is the same failure mode as the
`Filesystem`-god-interface anti-pattern, just at smaller scale, and doesn't
scale to arbitrary call graphs the way pipelining does.

**Why not just make remote calls look like local calls (the CORBA question).**
Addressed head-on: "CORBA failed for many reasons, with the usual problems of
design-by-committee being a big one. However, the biggest reason for CORBA's
failure is that it tried to make remote calls look the same as local calls.
Cap'n Proto does NOT do this – remote calls have a different kind of API
involving promises, and accounts for the presence of a network introducing
latency and unreliability. ... If remote calls look the same as local calls,
there is no opportunity to introduce promise pipelining, and latency is
inevitable." This is a strong, falsifiable claim worth flagging explicitly as
an opinionated position rather than settled consensus: that transparent
RPC-as-local-calls is not just an ergonomics tradeoff but a *categorical*
dead end for latency, because the promise/pipelining API surface is
irreducibly different from a synchronous local-call surface.

**Object identity and lifecycle are RPC-level concerns, not schema-level
ones, but the schema's generic/interface machinery is what makes them
expressible**: capabilities can be embedded in structs and lists and passed
as ordinary parameters (§5's generics apply to interface types too), and
disconnect/GC semantics ("when all references to an object have been
'dropped' ... the object will be closed") are defined in terms of capability
reference counting that rides on the same pointer mechanics as regular
struct fields.

---

## Synthesis: recurring meta-patterns across all ten decisions

A few structural moves repeat across almost every section above, which is
worth naming explicitly since they're the transferable lessons for a type IR
design, independent of Cap'n Proto's specific syntax:

1. **Push semantic validation out of the schema/wire layer, into application
   code that has the context to interpret it correctly** (required fields,
   §1). A schema-level constraint that's enforced uniformly for every
   consumer — including infrastructure that doesn't care about payload
   semantics — becomes a distributed coupling hazard the moment any two
   consumers legitimately disagree about what's required.

2. **Decompose an overloaded convenience keyword into its orthogonal
   primitives, and make the author pick explicitly** (optional, §2). "Optional"
   in protobuf silently blended presence-tracking, validation, and
   default-elision; Cap'n Proto forces those apart into union+Void, sentinel
   defaults, and pointer-nullability, each with visible, different costs.

3. **A single layout invariant, applied uniformly, is what backs almost every
   evolution guarantee**: "a member's position/identity depends only on its
   own declaration and earlier-numbered members, never later ones" recurs
   as the justification for union safety (§3), generic-parameter safety (§5),
   default-value backfill via padding (§6), and the wire format's
   traversability (§9). This suggests a type IR benefits from picking *one*
   such ordering/identity invariant early and deriving every "is this change
   safe" rule from it mechanically, rather than special-casing safety per
   construct.

4. **Where an older, deprecated feature (groups) is resurrected, the
   rationale names the *specific* narrow failure mode of the old version
   (repeated groups) rather than re-litigating the feature wholesale** (§4).
   This is a useful discipline: "X was a mistake" claims decay into folklore
   unless someone writes down exactly which composition of X was the
   problem.

5. **Every "this seems dangerous" objection (raw pointers, capability
   security, CORBA-style RPC) gets a direct, named rebuttal in the docs
   rather than being deflected** — the FAQ format itself ("Wait, why...",
   "Isn't this...", "Didn't CORBA prove...") is structured around
   anticipated objections. This is a documentation-generation lesson as much
   as a design one: recording *why the obvious alternative was rejected*,
   next to the design, is what makes the rationale durable instead of tribal
   knowledge that erodes as the original team moves on.
