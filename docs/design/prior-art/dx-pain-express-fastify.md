# DX Pain Points — Express.js and Fastify

Documented complaints from actual users: GitHub issues, Hacker News/Reddit threads, and
blog posts. Grouped by theme. No editorializing or solution-proposing — just what hurts,
with sourcing.

## Async / Error Handling

- **Rejected promises in route handlers don't reach Express's error handling.** Express 4/5
  middleware does not automatically catch rejections thrown inside `async` route handlers;
  an unhandled rejection inside a route causes the request to hang until timeout rather than
  surfacing an error, "leaving no trace in error logs."
  Source: [expressjs/express#3604 — Support catching rejected promises in middleware functions](https://github.com/expressjs/express/issues/3604);
  discussed further in [expressjs/express#6917 — Documentation: async/await error handling guide](https://github.com/expressjs/express/issues/6917).
- Every async endpoint has to be manually wrapped (`catchAsync`, try/catch, or a wrapper
  helper) to avoid this — called out repeatedly as a missing built-in on Hacker News:
  "Express is not integrated with Promises/async-await... requiring developers to wrap every
  async endpoint with custom error handling, or risk unhandled errors hanging connections
  forever without responses."
  Source: [Hacker News discussion on Express.js](https://news.ycombinator.com/item?id=32530604).
- The underlying Node behavior compounds this: an unhandled promise rejection can produce a
  504 Gateway Timeout for the affected client while the server keeps serving everyone else,
  with no crash and no obvious log signal.
  Source: [nodejs/help#4286 — Unhandled promise rejection when promise is not currently being awaited](https://github.com/nodejs/help/issues/4286).

## Middleware Ordering and Silent Failures

- Middleware order in Express is significant but enforced only by convention, not the type
  system or the framework — misordering doesn't crash immediately, it produces bugs that
  "surface unpredictably, often only under specific conditions in production, making them
  some of the hardest problems to diagnose."
  Source: [Express.js Middleware Order Mistakes That Cause Silent API Bugs — TechKoala](https://medium.techkoalainsights.com/express-js-middleware-order-mistakes-that-cause-silent-api-bugs-e3503ff291f1).
- Calling `next()` after a response has already been sent produces the classic
  `Cannot set headers after they are sent to the client` error — "sporadic crashes that are
  incredibly hard to trace" back to the offending middleware.
  Source: same TechKoala article; corroborated by [The Express Middleware Order That Silently Swallows Your Errors — Medium](https://medium.com/@mehran.khanjan/the-express-middleware-order-that-silently-swallows-your-errors-18f89d7c2eec).
- Placing the error-handling middleware before route definitions (rather than after) is a
  common, easy-to-make mistake that silently disables error handling — again because
  ordering rules are implicit rather than checked.
  Source: TechKoala article above.

## No Security/Validation Defaults

- Express ships with no protective defaults at all: "does not set protective HTTP headers,
  does not validate input, and does not rate-limit requests — leaving your application
  exposed to the full spectrum of web attacks" out of the box.
  Source: [Production Best Practices: Security — Express.js docs](https://expressjs.com/en/advanced/best-practice-security/), summarized via community security writeups (e.g. [Securing a MEAN Stack App — Medium](https://medium.com/@mukesh.ram/securing-a-mean-stack-app-a-guide-to-https-cors-and-helmet-js-1e77381c6617)).
- Every project independently bolts on `helmet`, `cors`, and rate-limiting packages;
  misconfiguring `cors` is called out as "one of the most common security mistakes" seen in
  production Express apps.
  Source: same security writeups above.
- Input validation is entirely the developer's responsibility with no framework-level
  primitive for it — every project reinvents its own validation layer (`joi`, `zod`,
  `express-validator`, hand-rolled checks) with no canonical approach.
  Source: same.

## Request/Response Object Typing (TypeScript)

- Extending `Request`/`Response` with custom properties (e.g. `req.userId` set by an auth
  middleware) requires manual TypeScript declaration-merging into
  `express-serve-static-core`, which is finicky: the `.d.ts` file path must match the
  original declaration's path/name for merging to work, and a `.d.ts` with no
  imports/exports is treated as a global script where `declare module` silently fails to
  merge instead of erroring.
  Source: [Extend Express's Request Object with TypeScript Declaration Merging — DEV Community](https://dev.to/kwabenberko/extend-express-s-request-object-with-typescript-declaration-merging-1nn5) and its comments thread; [Module Augmentation in TypeScript: Three Patterns and One Foot-Gun — DEV Community](https://dev.to/gabrielanhaia/module-augmentation-in-typescript-three-patterns-and-one-foot-gun-474h).
- Once augmented, the `Request` interface becomes a global grab-bag: "you have a bloated
  interface and lose the power of TypeScript because you don't know which middlewares were
  executed before handler/controller, and you don't know if the required data was attached" —
  i.e. the type system can't express "this property exists only after middleware X ran."
  Source: same DEV Community article.

## Deprecation / Package Churn Confusion

- `body-parser` was pulled out of Express 4.0 into a separate package, then its
  functionality was folded back into Express core as `express.json()` /
  `express.urlencoded()` starting in 4.16.0 — but the standalone `body-parser` package is
  still published and still shows up in tutorials, so developers hit conflicting advice
  about which one to use and get deprecation warnings when following older guides.
  Source: [bodyParser is deprecated in Express 4: What to do? — CodeForGeek](https://codeforgeek.com/body-parser-deprecated/); [How to Fix 'body-parser deprecated undefined extended' Error — codegenes.net](https://www.codegenes.net/blog/express-throws-error-as-body-parser-deprecated-undefined-extended/).

## Maintenance Cadence / Governance

- IBM's stewardship of Express (pre-OpenJS handoff) is cited as having "disillusioned key
  maintainers like Doug Wilson," with the company described as "inflexible at fixing those
  mistakes, ultimately forcing abandonment by some contributors."
  Source: [Ask HN: What happened to Express.js?](https://news.ycombinator.com/item?id=10482069); [Is Express.js dying? — Hacker News](https://news.ycombinator.com/item?id=10919502).
- Express 5 took roughly a decade from its first PR (2014) to release (October 2024);
  during that window Express 4 received only defect/CVE-level fixes, and there was a long
  dead period after an alpha release with no follow-up.
  Source: [Express 5.0 – Last Push — Hacker News](https://news.ycombinator.com/item?id=40218896); [Express | endoflife.date](https://endoflife.date/express).
- Express does not publish formal EOL dates or an LTS window the way Node.js or Angular do;
  there's no official sunset calendar, which complicates upgrade planning for teams that
  need to justify timing to stakeholders.
  Source: [Express 3 is EOL, Express 4 is Next: The 2026 Support Reference — HeroDevs](https://www.herodevs.com/blog-posts/express-3-is-eol-express-4-is-next-the-2026-support-reference).

## Express 5 Migration Friction

- Even though Express 5's public API is billed as "mostly compatible" with 4, real breaking
  changes trip people up in practice: unmatched route params are now omitted from
  `req.params` instead of being empty strings, `req.query` became a read-only getter with a
  different default parser ("simple" instead of "extended", so numbers/objects that used to
  parse now arrive as plain strings), `app.del()` was removed, and `express.static`'s
  `dotfiles` option now defaults to `"ignore"`.
  Source: [Express v5 migration guide — Express.js](https://expressjs.com/en/guide/migrating-5/); [Express.js 5 migration guide — LogRocket](https://blog.logrocket.com/express-js-5-migration-guide/).
- Large downstream projects treat the 4→5 jump as a nontrivial, trackable migration effort
  in its own right rather than a drop-in upgrade.
  Source: [Feature: Migrate to express v5 — backstage/backstage#27808](https://github.com/backstage/backstage/issues/27808).

## Memory Leaks Attributed to Middleware/Closures

- Users report Express processes' memory climbing steadily over the course of a day under
  load until a restart is needed; root-caused in practice to middleware that captures
  per-request state in a closure and never releases it (e.g. request-logging middleware
  retaining references).
  Source: [Memory Leak — expressjs/express#3552](https://github.com/expressjs/express/issues/3552); [Possible memory leak — expressjs/express#3413](https://github.com/expressjs/express/issues/3413).
- A specific historical case: promises cached on the `req` object (as done by Sentry's
  Express integration) were not garbage collected on Node 9/10/11, a leak that was hard to
  attribute because it looked like a Sentry problem, an Express problem, and a Node problem
  all at once.
  Source: [Memory leak when a Promise is stored on an Express request added to a domain — nodejs/node#23862](https://github.com/nodejs/node/issues/23862).
- The general shape of the complaint: "the leak is usually present at low traffic too but is
  just small enough that garbage collection keeps up; high traffic doesn't create the leak
  but exposes how bad it already was" — meaning the bug ships invisibly and only manifests
  under production load, well after code review.
  Source: [How to Fix Memory Leaks in Node.js Applications Under High Traffic](https://www.needsomefun.net/how-to-fix-memory-leaks-in-node-js-applications-under-high-traffic/).

---

# Fastify

## Plugin Encapsulation Model Is Hard to Build a Mental Model Of

- Multiple separate GitHub threads are just "I don't understand encapsulation" —
  not edge cases, the basic mental model: "A developer stated they couldn't understand how
  encapsulation works in Fastify and expressed wanting to use plugin encapsulation but not
  knowing how."
  Source: [Question about encapsulation — fastify/help#148](https://github.com/fastify/help/issues/148).
- A separate user reported difficulty understanding "what happens with `NODE_ENV`" and
  whether functions declared outside a plugin's scope are visible to routes registered
  inside it — the encapsulation boundary isn't obvious from reading the code.
  Source: [Plugin encapsulation — fastify/fastify discussion #2735](https://github.com/fastify/fastify/discussions/2735).
- The core confusion has a specific shape: `register()` creates a new encapsulation scope so
  anything decorated inside isn't visible outside it, but the official `fastify-plugin`
  wrapper exists specifically to *break* that scoping — so the same API surface has both an
  encapsulation feature and a first-party way to opt out of it, and users report not being
  able to tell which to reach for.
  Source: [Plugins best practices — fastify/fastify#1448](https://github.com/fastify/fastify/issues/1448).
- Relying on `fastify-plugin` to share code across boundaries also makes unit testing
  harder, since every test now has to supply all the plugin's transitive dependencies and
  their configs to construct a working instance.
  Source: same issue, #1448.
- Decorators added inside a plugin aren't available until after `.listen()`, `.inject()`,
  or `.ready()` is called — because Fastify defers plugin loading to that point — which
  surprises people who expect decorators to be usable immediately after `.register()`
  returns.
  Source: [Fastify Decorators reference docs](https://fastify.dev/docs/latest/Reference/Decorators/); illustrated by [Question: fastify.decorate() works at runtime, can we use it? — fastify/fastify#1707](https://github.com/fastify/fastify/issues/1707).
- A concrete bug from this same area: non-function request decorators stopped being checked
  correctly by `checkDependencies` after an internal change (v3.21.6+), so Fastify would
  throw "The decorator is missing dependency" even when `hasRequestDecorator` correctly
  reported the dependency as present — a case where the encapsulation/dependency-tracking
  machinery itself had a bug that manifested as a confusing, incorrect error.
  Source: [Dependency checking fails for non-function type Request Decorators — fastify/fastify#3517](https://github.com/fastify/fastify/issues/3517).

## Validation Error Messages Are Cryptic

- Passing a response schema without nesting it under a status code produces an error like
  `"Failed building the serialization schema for GET: /meters, due to error schema is
  invalid: data.properties should be object"` — a message about AJV's internal schema
  compilation rather than the actual mistake (forgetting to nest under a status code).
  Source: [schema.response without a status code throws a cryptic error message — fastify/fastify#3932](https://github.com/fastify/fastify/issues/3932).
- Default validation error messages are concatenated, AJV-shaped strings like
  `"body/lastName Required property, body/DoB Required property"` — reported as difficult
  to parse or present on a frontend without extra formatting work.
  Source: [Handling @fastify/type-provider-typebox schema validation errors on the frontend — fastify/help#1026](https://github.com/fastify/help/issues/1026).
- The error-formatting logic is tightly coupled to AJV specifically; teams that swap in a
  different validation library (e.g. for TypeBox-driven workflows) get "odd or incomplete
  error messages" because `schemaErrorFormatter` was written assuming AJV's error shape.
  Source: [Fastify Validation-and-Serialization reference docs](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

## TypeScript + JSON Schema Friction

- `FastifySchema`'s fields are typed as `unknown` by default; even when a type provider
  (e.g. `json-schema-to-ts`, TypeBox) supplies concrete types for a schema, there's no
  first-class way to have those types flow into the schema fields themselves for
  autocomplete — raised as an open feature request rather than something the framework
  already does.
  Source: [Typing of FastifySchema — fastify/fastify#5671](https://github.com/fastify/fastify/issues/5671).
- Getting real type inference at all requires adopting one of several separate, competing
  add-on packages (`json-schema-to-ts` with the `as const` pattern, `@fastify/type-provider-json-schema-to-ts`,
  or TypeBox) — there isn't a single blessed path, so teams have to research and choose.
  Source: [fastify/fastify-type-provider-json-schema-to-ts](https://github.com/fastify/fastify-type-provider-json-schema-to-ts); [TypeScript reference — Fastify docs](https://fastify.dev/docs/latest/Reference/TypeScript/).

## Plugin Version Pinning Blocks Upgrades

- Fastify enforces semver-range checks between plugins and core at load time; a plugin
  built against an older core can outright fail to load against a newer one with an error
  like `"fastify-plugin: fastify-cookie - expected '>=3' fastify version, '4.0.0-alpha.3' is
  installed"` — even in cases where the plugin would actually work fine, because the check
  is on declared version ranges, not actual compatibility.
  Source: [Is it possible to ignore fastify plugin version incompatibility errors? — fastify/help#668](https://github.com/fastify/help/issues/668).
- Upgrading Fastify major versions is described as needing a manual audit of which
  community plugins have been updated for the new major yet, since not all maintainers
  update in lockstep with core releases.
  Source: [Fastify v3 plugin upgrade list — fastify/fastify#2217](https://github.com/fastify/fastify/issues/2217).
- Fastify v5 in particular is called out as "extremely light on new features but extremely
  heavy on breaking changes" — the migration guide lists roughly 20 breaking changes for a
  release whose only headline new feature was Diagnostic Channel API support, which some
  users found "disappointing" and insufficient to justify the migration cost.
  Source: [Fastify v5 breaking changes: worth the upgrade? — Encore Blog](https://encore.dev/blog/fastify-v5); mirrored in [Fastify v5 vs v4 — vs Encore.ts — DEV Community](https://dev.to/encore/fastify-v5-breaking-changes-should-you-upgrade-2e6d).
- Downstream frameworks built on Fastify (e.g. NestJS's Fastify adapter) have to track
  these major bumps as their own tracked upgrade issues, another sign the breakage
  propagates beyond Fastify's own user base into everything layered on top.
  Source: [Fastify V5 Upgrade — nestjs/nest#14068](https://github.com/nestjs/nest/issues/14068).

## Smaller Ecosystem Than Express

- Fastify's plugin ecosystem is repeatedly described as meaningfully smaller than Express's
  middleware ecosystem, pushing developers toward either writing custom plugins for
  common needs or reaching for the `@fastify/express` compatibility layer to reuse Express
  middleware — which itself adds runtime overhead, partially undercutting Fastify's
  performance pitch.
  Source: [Express.js vs Fastify: An In-Depth Framework Comparison — Better Stack Community](https://betterstack.com/community/guides/scaling-nodejs/fastify-express/); [Express vs Fastify: Node.js Framework Choice 2026 — PkgPulse](https://www.pkgpulse.com/guides/express-vs-fastify-2026).
- The download-count gap is large in practice — cited as roughly 104M weekly downloads for
  Express versus 7.6M for Fastify (~13.7x) — which correlates with fewer community
  Stack Overflow answers, blog posts, and battle-tested plugins to draw on when something
  goes wrong.
  Source: [Express vs Fastify — NPM Package Comparison — PkgPulse](https://www.pkgpulse.com/compare/express-vs-fastify).

## Logger Coupling to Pino

- Fastify's logger is Pino specifically, not a pluggable interface for "any logger" —
  users who want a different logging library run into friction; one long-standing request
  was simply to support loggers other than Pino at all.
  Source: [only pino supported as logger — fastify/fastify#799](https://github.com/fastify/fastify/issues/799).
- Passing a pre-constructed Pino instance as the `logger` option broke in Fastify 5.0.0,
  and separately broke when going through `fastify-cli` after an unrelated internal change
  (#4520) — the "bring your own configured Pino instance" path has repeatedly regressed
  across releases rather than being a stable, tested surface.
  Source: [Passing a pino instance to fastify's logger option causes error using 5.0.0 — fastify/fastify#5747](https://github.com/fastify/fastify/issues/5747); [Logger validation fails when passing pino logger via fastify-cli — fastify/fastify#4657](https://github.com/fastify/fastify/issues/4657).
- A separate proposal to remove the "pass a custom logger instance" option entirely
  surfaced pushback from users who depend on that exact capability for centralized
  logging setups — indicating the feature's future is unsettled even for people
  currently relying on it.
  Source: [Removal of Custom Logger Instance Option in Fastify Logger — fastify/fastify#5703](https://github.com/fastify/fastify/issues/5703).
