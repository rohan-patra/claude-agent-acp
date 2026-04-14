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
                    └── PostToolUse onFileRead (caches content for revert)
```

1. Claude calls the **built-in Edit or Write** tool — it executes normally, writing to disk
2. The **PostToolUse hook** fires and calls the `FileEditInterceptor`
3. The interceptor **reverts** the file to its pre-edit state on disk
4. The interceptor **routes** the new content through `writeTextFile` → Zed's Review Changes UI
5. The user **accepts or rejects** the change inline

This works for both main sessions and subagents — since Claude uses its built-in tools directly, there are no MCP tool access issues.

## Background

In v0.18.0 ([PR #316](https://github.com/zed-industries/claude-agent-acp/pull/316)), the upstream repo removed an earlier MCP server that provided this functionality because it had critical bugs:

- **Subagent failures** — MCP tools couldn't be accessed by subagents (Task tool), causing silent write failures
- **Stale reads** — `mcp__acp__Read` returned outdated buffer content
- **Binary file crashes** — Image and binary files broke the ACP text routing
- **Permission bypass** — Custom permissions engine conflicted with Claude Code's `.claude/settings.json`

This fork fixes all of those by using a PostToolUse intercept instead of an MCP server:

| Decision | Rationale |
|----------|-----------|
| **PostToolUse intercept, not MCP** | Built-in tools work everywhere (main session + subagents). No MCP tool access issues. |
| **Write/Edit only** (no Read, no Bash) | Read works fine built-in. Only write operations need ACP routing for the Review UI. |
| **Read-before-edit cache** | Files are cached when Read completes. Cache is used for reverting to the pre-edit state. Consecutive edits work without re-reading. |
| **No system prompt or PreToolUse hook** | Claude uses its built-in tools naturally. No tool redirection needed. |
| **No custom permissions** | Relies on Claude Code's built-in `canUseTool` and settings files. |

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

### `.context` Directory

Plan files and other context artifacts are stored in `.context/` within the project directory instead of `~/.claude/plans/`.

- **Plans directory** — Set to `.context/plans` via SDK settings so plan files live in the project rather than the global Claude config.
- **Git-excluded** — On session creation, `.context` is automatically appended to `.git/info/exclude` if not already present, keeping it out of version control without modifying `.gitignore`.
- **Review UI bypass** — Edits to files inside `.context/` are applied directly to disk, skipping the Review Changes flow.

### Session Config Options

- **Effort level selector** — When the model supports it, a "thought level" config option appears in the session config.
- **Fast mode toggle** — When the model supports it, an Off/Fast toggle appears. Server-side transitions (e.g., cooldown) are synced back to the UI.

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

| File | Change | Merge notes |
|------|--------|-------------|
| `src/acp-agent.ts` | `FileEditInterceptor` creation + wiring in `createSession()`, forwarding in `toAcpNotifications`/`streamEventToAcpNotifications`, session config options for effort/fast mode, `.context` git-exclude on session creation, `plansDirectory` setting | All changes are purely additive insertion blocks |
| `src/tools.ts` | `fs` import, `extractReadContent`, `isToolError`, `FileEditInterceptor` interface + `createFileEditInterceptor` factory appended at EOF, `onFileRead` option added to `createPostToolUseHook`, `.context/` bypass in interceptor | Additions at end of file; shouldn't conflict |
| `src/lib.ts` | 2 export lines (`createFileEditInterceptor`, `FileEditInterceptor` type) | Re-add if upstream changes exports |
| `package.json` | No changes | — |

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
