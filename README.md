# Claude Code ACP Adapter — Edit Review Fork

> A fork of [`zed-industries/claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) that restores Zed's **Review Changes** diff UI for Claude Code file edits.

## Overview

This adapter connects [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to [Zed](https://zed.dev) via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com). It adds a transparent **PostToolUse intercept** that routes file Write/Edit operations through Zed's buffer system, triggering the native **Review Changes** multibuffer where users can accept or reject each edit inline.

The upstream adapter (v0.18.0+) writes files directly to disk. This fork lets the built-in Edit/Write tools execute normally, then immediately reverts the file and routes the new content through Zed's `fs/write_text_file` ACP API, so every file change gets a diff review.

## How It Works

```
Zed ◄──ACP──► ClaudeAcpAgent ◄──Claude Agent SDK──► Claude API
                    │
                    ├── FileEditInterceptor (PostToolUse hook)
                    │   ├── Edit: revert + route through ACP → Review UI
                    │   └── Write: revert + route through ACP → Review UI
                    │
                    ├── PostToolUse onFileRead (caches content for revert)
                    │
                    └── FileChanged watcher (source-agnostic fallback)
                        └── net change to a session-start-tracked text file →
                            revert to baseline + route through ACP → Review UI
```

1. Claude calls the **built-in Edit or Write** tool — it executes normally, writing to disk
2. The **PostToolUse hook** fires and calls the `FileEditInterceptor`
3. The interceptor **reverts** the file to its pre-edit state on disk
4. The interceptor **routes** the new content through `writeTextFile` → Zed's Review Changes UI
5. The user **accepts or rejects** the change inline

This works for both main sessions and subagents — since Claude uses its built-in tools directly, there are no MCP tool access issues.

Changes that _don't_ go through the built-in Edit/Write tools — a Bash command, a formatter, an MCP tool, or a background process writing to disk — are caught by a second, **source-agnostic** path: the SDK's `FileChanged` filesystem watcher. When a file that was **Git-tracked and present at session start** picks up a net change, the interceptor reverts it to its session-start baseline and re-proposes the new content through the same Review Changes UI. Because a watcher event carries no tool-use ID, this path creates a native review entry only — it never fabricates or updates a tool-call card.

## Background

In v0.18.0 ([PR #316](https://github.com/zed-industries/claude-agent-acp/pull/316)), the upstream repo removed an earlier MCP server that provided this functionality because it had critical bugs:

- **Subagent failures** — MCP tools couldn't be accessed by subagents (Task tool), causing silent write failures
- **Stale reads** — `mcp__acp__Read` returned outdated buffer content
- **Binary file crashes** — Image and binary files broke the ACP text routing
- **Permission bypass** — Custom permissions engine conflicted with Claude Code's `.claude/settings.json`

This fork fixes all of those by using a PostToolUse intercept instead of an MCP server:

| Decision                                | Rationale                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **PostToolUse intercept, not MCP**      | Built-in tools work everywhere (main session + subagents). No MCP tool access issues.                                               |
| **Write/Edit only** (no Read, no Bash)  | Read works fine built-in. Only write operations need ACP routing for the Review UI.                                                 |
| **Read-before-edit cache**              | Files are cached when Read completes. Cache is used for reverting to the pre-edit state. Consecutive edits work without re-reading. |
| **No system prompt or PreToolUse hook** | Claude uses its built-in tools naturally. No tool redirection needed.                                                               |
| **No custom permissions**               | Relies on Claude Code's built-in `canUseTool` and settings files.                                                                   |

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Zed](https://zed.dev) (latest)
- An Anthropic API key or Claude Code authentication

### Install and Build

```bash
git clone https://github.com/rohanpatra/claude-code-zed-acp.git
cd claude-code-zed-acp
npm install
npm run build
```

### Configure in Zed

Add to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "Claude Code by Rohan Patra": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/claude-code-zed-acp/dist/index.js"]
    }
  }
}
```

Restart Zed. The custom agent will appear in the Agent Panel under the `+` menu.

#### Optional env vars

Add an `env` block to the `agent_servers` entry above to opt into extras:

- `CLAUDE_CODE_THINKING_DISPLAY=summarized` — Restore the pre-Opus-4.7 summarized thinking stream (Opus 4.7 defaults to `omitted`, which streams empty thinking blocks). Accepts `summarized` or `omitted`. Unset → SDK default.
- `MAX_THINKING_TOKENS=<number>` — Override the default thinking token budget.

## Features

Everything from the upstream adapter, plus:

### Review Changes UI for File Edits

The main feature. When Claude edits or creates a file, the change appears in Zed's **Review Changes** multibuffer with inline accept/reject controls — instead of being written directly to disk.

- **Edit review** — File edits appear in the diff viewer with accept/reject controls
- **Write review** — New file creation also flows through the diff viewer
- **Read-before-edit cache** — Files are cached when Claude reads them, so the interceptor can revert to the pre-edit state before routing through ACP. Cache is updated after each edit for consecutive edits without re-reading.
- **Subagent compatibility** — Works for both the main session and subagents (Task tool). The previous MCP-based approach failed silently for subagents.
- **No tool redirection** — Claude uses its built-in Edit/Write tools naturally. The PostToolUse hook intercepts after execution — no system prompt or PreToolUse hook needed.
- **Project-scoped** — Only files within the project directory are intercepted. Files outside the project (e.g., `~/.claude/settings.json`) are written directly by the built-in tools.
- **`.context/` bypass** — Files inside `.context/` are written directly to disk without the review UI, since these are internal working files (plans, etc.) that shouldn't require manual approval.
- **Safe fallback** — If ACP routing fails, the new content is restored to disk so the edit isn't lost. Uncached files (never explicitly Read) skip the revert step.

#### Watcher fallback for non-tool edits

Beyond the exact, tool-aware Edit/Write path above, a source-agnostic filesystem watcher surfaces changes made by anything else — Bash, formatters, MCP tools, subagents, or background processes — so they still land in Review Changes instead of silently hitting disk.

- **Scope: tracked-at-start text files only** — On session start (when the client supports `fs/write_text_file` and the cwd is inside a Git worktree), the interceptor snapshots the **current working-tree contents** of every Git-tracked file as its reject baseline. Pre-existing staged/unstaged edits are preserved as that baseline — it's the working tree, not `HEAD` or the index.
- **Net change → one proposal** — When a tracked file settles on content that differs from its baseline, the watcher reverts to the baseline and routes the new content through ACP exactly once. Rapid successive writes (e.g. a formatter rewriting a file repeatedly) are debounced to the single stable net result.
- **Deliberate boundaries** — Deletions are ignored (an `unlink` is never restored or routed). Binaries, symlinks, unreadable files, `.context/`, files outside the cwd, and files that were untracked or created after session start are all skipped — new/untracked files remain supported only through the built-in `Write` tool. The watcher path has no tool attribution, so it never draws a tool-call card.
- **Accept/reject is inferred from disk, matched to Zed's behavior** — Zed persists the proposed content to disk the moment it's routed (its `write_text_file` ends in a buffer save) and, on reject, restores the pre-proposal content to disk; an accept writes nothing further. ACP exposes no accept/reject callback, so the watcher infers the outcome from _which_ of the two the disk settles on: seeing the proposal means accept (the reject baseline advances to it optimistically), seeing the reject target means reject (the baseline rolls back). It never mistakes Zed's own routing write for a fresh change, and it coordinates with the built-in Edit/Write path so a single edit — accepted or rejected — never yields a second, reversed proposal.
- **Format-on-save is handled** — if Zed reformats a file on save (`format_on_save`), the content it persists differs from what was routed. The watcher adopts that reformatted content as the same proposal rather than re-proposing it, so a formatter can't produce a double proposal (or, if non-idempotent, an unbounded loop), and reject still restores the original. Residual gaps are narrow: if a brand-new change lands on the same file in the sub-second window before a reject is observed the reject may be missed; a manual edit whose content exactly equals a pending reject target reads as a reject; and a file simultaneously open and edited in Zed's own editor can desync the reject baseline.
- **Single-session assumption** — The filesystem protocol can't disambiguate independent sessions or adapter processes watching the same checkout, so this assumes one active ACP session per working tree.

### Background-Task Visibility

When Claude spawns background work (subagents, Bash jobs, monitors, workflows) or defers tool calls, the work continues past the ACP turn boundary. Instead of unlocking the composer while Claude is still working, this fork keeps work visible: tool cards stay spinning until the background task completes, running tasks appear in the plan panel as in-progress entries, and the turn doesn't settle until the authoritative `idle` signal (not just the first `result`). This prevents the confusing "your turn" state when the agent is still busy.

### `.context` Directory

Plan files and other context artifacts are stored in `.context/` within the project directory instead of `~/.claude/plans/`.

- **Plans directory** — Set to `.context/plans` via SDK settings so plan files live in the project rather than the global Claude config.
- **Git-excluded** — On session creation, `.context` is automatically appended to `.git/info/exclude` if not already present, keeping it out of version control without modifying `.gitignore`.
- **Review UI bypass** — Edits to files inside `.context/` are applied directly to disk, skipping the Review Changes flow.

### Session Config Options

- **Effort level selector** — When the model supports it, a "thought level" config option appears in the session config.
- **Fast mode toggle** — When the model supports it, an Off/Fast toggle appears. Server-side transitions (e.g., cooldown) are synced back to the UI.
- **Ultracode** — When the model is xhigh-capable (e.g. Opus) and the Workflows feature is enabled, an "Ultracode" entry appears at the bottom of the effort/thought-level list. Selecting it turns on the SDK's `ultracode` mode (xhigh effort + standing dynamic-workflow orchestration); selecting any normal effort level turns it back off. It's session-scoped and never persisted.

### Expanded Model Picker

The Claude Agent SDK only exposes a curated set of 4 models to ACP clients (Opus 4.8 1M as "Default", Sonnet, Sonnet 1M, Haiku) — it has no API that lists the version-pinned variants, even though the underlying CLI supports them. This fork surfaces the full Claude Code model picker instead:

- Opus 4.8 1M
- Opus 4.8
- Opus 4.7 1M
- Opus 4.7
- Opus 4.6 1M
- Sonnet 4.6
- Haiku 4.5

Setting an `availableModels` allowlist in `settings.json` overrides this with your own list (unchanged from upstream). See [CLAUDE.md](./CLAUDE.md) for how the list is built and maintained.

### Patched Claude Agent SDK

This fork depends on a [patched build of the Claude Agent SDK](https://github.com/rohan-patra/claude-agent-sdk-patch) rather than the official npm package (it keeps the same `@anthropic-ai/claude-agent-sdk` name, so it's a drop-in replacement).

The official SDK tags every `claude` CLI subprocess it spawns as programmatic Agent SDK usage (via `CLAUDE_CODE_ENTRYPOINT="sdk-ts"` and a `CLAUDE_AGENT_SDK_VERSION` stamp). But the ACP connector is just a person driving Claude Code interactively from inside Zed — so that tagging misclassifies legitimate interactive use as disallowed Agent SDK usage. The patch normalizes the spawned CLI's environment to match an ordinary interactive session (`CLAUDE_CODE_ENTRYPOINT="cli"`, with the SDK-version stamp cleared), so the connector is treated as the legitimate Claude Code use case it is.

See [CLAUDE.md](./CLAUDE.md) for details on the patch and how to track newer SDK releases.

### All Upstream Features

Everything else works unchanged:

- Context @-mentions and images
- Tool calls with permission requests
- Interactive and background terminals
- TODO lists and plan mode
- Custom slash commands
- Client MCP servers

## Development

```bash
npm run build          # TypeScript compilation
npm run test:run       # Unit tests
npm run dev            # Build + start
npm run test:integration  # Integration tests (requires RUN_INTEGRATION_TESTS=true)
```

## Keeping Up with Upstream

This fork is designed for easy merges. All changes are additive:

| File               | Change                                                                                                                                                                                                                                                                                                                                                                                       | Merge notes                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/acp-agent.ts` | `FileEditInterceptor` creation + wiring in `createSession()`, forwarding in `toAcpNotifications`/`streamEventToAcpNotifications`, session config options for effort/fast mode, `.context` git-exclude on session creation, `plansDirectory` setting, background-task visibility (Session fields, consumer handlers, plan-combiner wiring, deferred-settlement logic in result/idle handlers) | All changes are purely additive insertion blocks; see CLAUDE.md for background-task merge notes                                                                                                                                                                                      |
| `src/tools.ts`     | `fs` import, `extractReadContent`, `isToolError`, `FileEditInterceptor` interface + `createFileEditInterceptor` factory appended at EOF, `onFileRead` option added to `createPostToolUseHook`, `.context/` bypass in interceptor, background-task helpers (`RunningTask`, `runningTaskLabel`, `runningTaskPlanEntries`, `buildMergedPlanEntries`, `suppressBackgroundToolResults`)           | Additions at end of file; shouldn't conflict; route new plan emits through the combiner                                                                                                                                                                                              |
| `src/lib.ts`       | 2 export lines (`createFileEditInterceptor`, `FileEditInterceptor` type) + 5 new exports for background-task helpers                                                                                                                                                                                                                                                                         | Re-add if upstream changes exports                                                                                                                                                                                                                                                   |
| `package.json`     | `@anthropic-ai/claude-agent-sdk` repointed to the patched fork (`github:rohan-patra/claude-agent-sdk-patch#<sha>`)                                                                                                                                                                                                                                                                           | Keep our git spec on merge — don't accept upstream's npm version; bump the SHA to track a newer SDK. For lockfile conflicts on an SDK bump, `git checkout --theirs package-lock.json && npm install` resolves cleanly. See [CLAUDE.md](./CLAUDE.md) for the full SDK-bump procedure. |

See [CLAUDE.md](./CLAUDE.md) for detailed merge instructions and architecture documentation.

## License

Apache-2.0 (same as upstream)

---

# Upstream README

# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40agentclientprotocol%2Fclaude-agent-acp)](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients!

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
