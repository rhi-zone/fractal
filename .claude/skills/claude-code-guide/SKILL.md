---
name: claude-code-guide
description: Answer questions about Claude Code (the CLI tool), Claude Agent SDK, Claude API, Claude Tag (Slack), plugin eval, and related tooling. Use when the user asks how Claude Code or the Agent SDK works, wants to understand a Claude API concept, or has a question about Claude Tag or plugin eval.
allowed-tools: [Read, Grep, Glob, Bash, WebFetch, WebSearch]
---

# claude-code-guide

Look things up and explain what's found — don't answer from memory alone when the source is checkable. Training data about Claude Code commands, flags, and settings can be out of date; prefer fetching current docs over recalling them. If a fetch fails or docs don't cover it, say so plainly and note the answer may be stale, rather than quietly falling back to memory.

## the five domains, and where they blur together

1. **Claude Code** (the CLI tool) — installation, hooks, skills, MCP servers, IDE integrations, settings, keyboard shortcuts, subagents, plugins, sandboxing.

2. **Claude Agent SDK** — Claude Code packaged as a library (`claude-agent-sdk` for Python, `@anthropic-ai/claude-agent-sdk` for TypeScript) for building custom agents on your own infrastructure. Ships the full harness (agent loop, context management, sessions, hooks, subagents, permissions, MCP) plus built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch) — you host and deploy it yourself. Its docs live alongside the Claude Code docs, not the Claude API docs.

3. **Claude API** (formerly "Anthropic API") — spans three distinct surfaces, easy to conflate:
   - **Messages API**: direct request/response.
   - **Tool Runner** (`client.beta.messages.tool_runner`) / manual tool-use loops: an agentic loop over tools *you* define, with per-turn hooks for approval gates, error interception, result modification, retries — no built-in tools, and it's not a bare loop (approval/interception don't require dropping to manual).
   - **Managed Agents**: server-hosted, stateful, Anthropic-managed sandbox — create an agent once, start sessions against it.
   Do not conflate the Tool Runner with the Agent SDK (domain 2) — different products, different hosting model. Do not conflate the Agent SDK with Managed Agents either — Agent SDK is harness-only, self-hosted; Managed Agents is Anthropic-hosted.

4. **Claude Tag** (Claude in Slack) — Claude as a Slack teammate, each thread backed by a remote Claude Code session. Enabled via Admin settings → Claude Tag, `@Claude connect` in Slack, or `/install-slack-app` (only available in Claude.ai-subscriber sessions). Newer than most training data and replaces the older per-user "Claude in Slack" app — treat memory as unreliable here, fetch first.

5. **Plugin eval and skill diagnostics** — the `claude plugin eval` / `claude plugin eval init` CLI (eval cases, graders, running suites, the results JSON/HTML report, the eval sandbox, CI use, early-access enablement) and the `/skill-doctor` usage report. Early access, no public docs page as of this writing — if asked and the answer isn't independently verifiable, say so rather than guessing at flags, enablement variable names, or behavior.

## approach

1. Work out which domain(s) the question touches — questions often straddle two (e.g. "Agent SDK vs Tool Runner" is a domain-2-vs-domain-3 question).
2. Fetch the relevant docs (Claude Code + Agent SDK docs live together at code.claude.com/docs; Claude API docs live at platform.claude.com; Claude Tag docs live on the claude.com docs domain — start from its overview page) rather than answering from memory.
3. Fetch the specific page(s) once you've found the right doc-map entry.
4. If docs don't cover it, fall back to WebSearch before answering from memory — and flag the answer as unverified if you still end up guessing.
5. Check local project files (CLAUDE.md, `.claude/`) too when the question is about how *this* project is configured, not just how the tool works in general.

## guidelines

- Cite the doc/URL an answer came from when you give one.
- If you can't reach docs at all, tell the user that plainly, give the best answer you have, and flag it as possibly stale rather than presenting it as current.
- When something's unclear, ask rather than guessing at what the user means.
