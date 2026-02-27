# claude-code-zed-acp (Fork)

This is a fork of [`zed-industries/claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) that restores Zed's **Review Changes** diff UI for Claude Code file edits.

## Why This Fork Exists

In v0.18.0 (PR #316), the upstream repo removed an in-process MCP server that previously routed Claude Code's file Write/Edit operations through Zed's ACP filesystem APIs (`fs/write_text_file`). This removal eliminated the "Review Changes" multibuffer UI where users could accept/reject edits inline within Zed.

The MCP server was removed because it had critical bugs:
- Subagents (Task tool) couldn't access MCP tools, causing Write/Edit to silently fail
- `mcp__acp__Read` returned stale buffer content
- Image/binary file handling was broken
- Claude Code's `.claude/settings.json` permissions were bypassed

This fork restores the Review Changes UI using a **PostToolUse intercept** pattern instead of an MCP server, which fixes all of those bugs.

## What This Fork Changes

All changes are additive — no upstream code is modified in a breaking way. The fork makes **small additions** to three existing files.

### Modified: `src/tools.ts`

Additions appended at end of file:

1. **Imports** — `fs`, `path`, `diff`, and `CLAUDE_CONFIG_DIR` from `./acp-agent.js`.

2. **`internalPath(filePath)`** — Returns `true` for paths under `~/.claude/` (except `settings.json` and `session-env`). These bypass ACP interception so agent state persistence works.

3. **`applyEditContent(fileContent, oldString, newString, replaceAll?)`** — Pure string replacement logic extracted from the Edit tool. Returns just the new content string (no patch computation). Validates that `old_string` is non-empty, exists in the file, and is unique (unless `replace_all` is set).

4. **`applyEdit(fileContent, filePath, oldString, newString, replaceAll?)`** — Wraps `applyEditContent` and adds a unified diff via `diff.createPatch()`. Used by `toolUpdateFromEditToolResponse` for Zed's diff display.

5. **`extractReadContent(toolResponse)`** — Extracts file content directly from the Read tool's `tool_response` string, avoiding a redundant ACP round-trip.

6. **`isToolError(toolResponse)`** — Checks if a tool response indicates an error (the response contains `is_error: true`).

7. **`FileEditInterceptor` interface** — Two methods:
   - `onFileRead(filePath, content)` — Caches file content when Read completes.
   - `interceptEditWrite(toolName, toolInput, toolResponse, writeTextFile)` — Reverts the disk write and routes through ACP.

8. **`createFileEditInterceptor(logger)`** — Factory that returns a `FileEditInterceptor`. Contains a `fileContentCache` Map in its closure. The interceptor:
   - Lets the built-in Edit/Write tool execute normally (writing to disk)
   - Determines the new content (from `applyEditContent` for Edit, from `input.content` for Write)
   - Reverts the file to its pre-edit state (or skips revert for uncached files)
   - Routes the new content through `writeTextFile` → Zed's Review Changes UI
   - Updates the cache for consecutive edits

9. **`createPostToolUseHook()` `onFileRead` option** — Extended with an optional `onFileRead(filePath, content)` callback that fires when the built-in Read tool completes, feeding the interceptor's cache via `extractReadContent`.

Key design decisions:
- **PostToolUse intercept, not MCP** — Built-in Edit/Write execute normally, then the PostToolUse hook intercepts, reverts, and routes through ACP. This works for both main sessions and subagents (subagents use built-in tools directly, which the PostToolUse hook can intercept).
- **No system prompt or PreToolUse hook needed** — Claude uses its built-in Edit/Write tools naturally. No tool redirection or MCP tool names to worry about.
- **No `@modelcontextprotocol/sdk` dependency** — The MCP server is gone entirely.
- **Internal paths bypass ACP** — Paths under `~/.claude/` (except settings files) go directly to the filesystem.
- **Read-before-edit guard** — The `fileContentCache` enables staleness detection. If a file was read and then modified externally before Claude edits it, the interceptor uses the cached content for `applyEditContent` and reverts to the cached version. Uncached files fall back to reading the new content from disk and skip revert.
- **Cache update after edit** — After a successful ACP route, the cache is updated with the new content so consecutive edits to the same file work without re-reading.

### Modified: `src/acp-agent.ts`

Changes in `createSession()`:

1. **`FileEditInterceptor` creation**: When `clientCapabilities.fs.writeTextFile` is available, calls `createFileEditInterceptor(this.logger)` and stores the result on the session object.

2. **PostToolUse `onFileRead` wiring**: Passes `fileEditInterceptor.onFileRead` to `createPostToolUseHook()` so that when the built-in Read tool completes, `extractReadContent` extracts the file content and caches it.

Changes in `toAcpNotifications()` and `streamEventToAcpNotifications()`:

3. **`fileEditInterceptor` option**: Both functions accept an optional `fileEditInterceptor` in their options. In the `onPostToolUseHook` callback, if the tool is Edit or Write, the interceptor's `interceptEditWrite` is called with `client.writeTextFile` before the normal notification logic runs.

New imports at top of file:
```typescript
import { createFileEditInterceptor, type FileEditInterceptor } from "./tools.js";
```

Session type addition:
```typescript
fileEditInterceptor?: FileEditInterceptor;
```

### Modified: `src/lib.ts`

Added exports:
```typescript
export { ..., createFileEditInterceptor, type FileEditInterceptor } from "./tools.js";
```

### Modified: `package.json`

- `diff` — For `diff.createPatch()` in `applyEdit`
- `@types/diff` (devDependency) — TypeScript types for diff
- Removed `@modelcontextprotocol/sdk` (no longer needed)

## How to Merge Upstream Updates

When pulling changes from `zed-industries/claude-agent-acp`:

1. **`src/acp-agent.ts`** — Our changes are two isolated insertion blocks:
   - `createFileEditInterceptor` block (~5 lines in `createSession()` after capabilities check)
   - PostToolUse `onFileRead` wiring (~3 lines in the `createPostToolUseHook` options)
   - `fileEditInterceptor` forwarding in `toAcpNotifications` and `streamEventToAcpNotifications`

   If upstream modifies `createSession()`, these blocks just need to stay in the same logical positions.

2. **`src/tools.ts`** — Our changes are:
   - Import additions at the top (`fs`, `path`, `diff`, `CLAUDE_CONFIG_DIR`)
   - `internalPath`, `applyEditContent`, `applyEdit`, `extractReadContent`, `isToolError`, `FileEditInterceptor`, `createFileEditInterceptor` appended at end of file
   - `onFileRead` option added to `createPostToolUseHook`

   If upstream adds new tool handling, our additions are all at the end of the file and shouldn't conflict.

3. **`src/lib.ts`** — Export lines. Straightforward to re-add if upstream modifies exports.

4. **`package.json`** — Keep `diff` and `@types/diff` as dependencies.

## Architecture

```
Zed <──ACP (ndjson/stdio)──> ClaudeAcpAgent <──Claude Agent SDK──> Claude API
                                    │
                                    ├── FileEditInterceptor (PostToolUse hook)
                                    │   ├── Edit: applyEditContent → revert → writeTextFile → Review UI
                                    │   └── Write: revert → writeTextFile → Review UI
                                    │
                                    └── PostToolUse onFileRead (caches content for staleness detection)
```

### Flow: Edit/Write (Main Session and Subagents)
1. Claude calls the built-in Edit or Write tool
2. The tool executes normally, writing to disk
3. PostToolUse hook fires → `interceptEditWrite` is called
4. Interceptor determines the new content (from cache + `applyEditContent` for Edit, from input for Write)
5. Interceptor reverts the file to its pre-edit state on disk
6. Interceptor routes the new content through `writeTextFile` → Zed's Review Changes UI
7. Zed shows the change in **Review Changes** multibuffer with accept/reject controls
8. User accepts or rejects inline
9. Cache is updated with the new content for consecutive edits

### Flow: Uncached File Edit
1. Claude edits a file it never explicitly Read (e.g., found via Grep)
2. No cached content → interceptor reads the new content from disk (already written by built-in tool)
3. No original content to revert to → revert is skipped
4. New content is routed through ACP as usual

## Testing

```bash
npm run build          # TypeScript compilation
npm run test:run       # Unit tests (95 tests)
npm run test:integration  # Integration tests (requires RUN_INTEGRATION_TESTS=true)
```

## Setup in Zed

Build, then point Zed's settings to the built output:

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
