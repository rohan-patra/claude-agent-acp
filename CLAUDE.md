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

1. **Import** — `fs` from `node:fs`.

2. **`extractReadContent(toolResponse)`** — Extracts file content directly from the Read tool's `tool_response` string, avoiding a redundant ACP round-trip.

3. **`isToolError(toolResponse)`** — Checks if a tool response indicates an error (the response contains `is_error: true`).

4. **`FileEditInterceptor` interface** — Three methods:
   - `onFileRead(filePath, content)` — Caches file content when Read completes.
   - `onPreWrite(filePath)` — Captures pre-Write file state (existence + content) so new-file Writes can be reverted by deleting, and uncached overwrites can be reverted from disk.
   - `interceptEditWrite(toolName, toolInput, toolResponse, writeTextFile)` — Reverts the disk write and routes through ACP.

5. **`createFileEditInterceptor(logger)`** — Factory that returns a `FileEditInterceptor`. Contains a `fileContentCache` Map and `nonExistentFiles` Set in its closure. The interceptor:
   - Lets the built-in Edit/Write tool execute normally (writing to disk)
   - Determines the new content (from disk for Edit, from `input.content` for Write)
   - Reverts the file to its pre-edit state. For Write, if PreToolUse captured non-existence, the file is deleted; if PreToolUse captured existing disk content, that's restored. For Edit, the read-cache is used.
   - Routes the new content through `writeTextFile` → Zed's Review Changes UI
   - Updates the cache for consecutive edits

6. **`createPostToolUseHook()` `onFileRead` option** — Extended with an optional `onFileRead(filePath, content)` callback that fires when the built-in Read tool completes, feeding the interceptor's cache via `extractReadContent`.

7. **`createPreToolUseHook()` factory** — A PreToolUse hook factory parallel to `createPostToolUseHook`. Accepts an optional `onPreWrite(filePath)` callback that fires for `tool_name === "Write"`, feeding the interceptor's pre-existence/content cache.

Key design decisions:
- **PostToolUse intercept, not MCP** — Built-in Edit/Write execute normally, then the PostToolUse hook intercepts, reverts, and routes through ACP. This works for both main sessions and subagents (subagents use built-in tools directly, which the PostToolUse hook can intercept).
- **PreToolUse for Write only** — Edit relies on a prior Read (the built-in Edit tool requires it), so the read-cache is sufficient. Write doesn't require Read, so we capture pre-existence/content via PreToolUse. This lets us correctly revert Write of a brand-new file (delete) vs. overwrite of an existing file (restore).
- **No system prompt needed** — Claude uses its built-in Edit/Write tools naturally. No tool redirection or MCP tool names to worry about.
- **No `@modelcontextprotocol/sdk` dependency** — The MCP server is gone entirely.
- **Read-before-edit cache** — The `fileContentCache` tracks what the agent last Read. Edits read the new content from disk (already written by the built-in Edit tool). If the file was modified externally since the last Read, the built-in Edit tool will fail on its own (`old_string` not found). Uncached files fall back to reading from disk and skip revert.
- **Cache update after edit** — After a successful ACP route, the cache is updated with the new content so consecutive edits to the same file work without re-reading.

### Modified: `src/acp-agent.ts`

Changes in `createSession()`:

1. **`FileEditInterceptor` creation**: When `clientCapabilities.fs.writeTextFile` is available, calls `createFileEditInterceptor(this.logger)` and stores the result on the session object.

2. **PostToolUse `onFileRead` wiring**: Passes `fileEditInterceptor.onFileRead` to `createPostToolUseHook()` so that when the built-in Read tool completes, `extractReadContent` extracts the file content and caches it.

3. **PreToolUse `onPreWrite` wiring**: Adds a `PreToolUse` hooks block that calls `createPreToolUseHook()` with `fileEditInterceptor.onPreWrite`. This fires before the built-in Write tool executes so the interceptor can capture pre-existence and original disk content for correct revert.

Changes in `toAcpNotifications()` and `streamEventToAcpNotifications()`:

4. **`fileEditInterceptor` option**: Both functions accept an optional `fileEditInterceptor` in their options. In the `onPostToolUseHook` callback, if the tool is Edit or Write, the interceptor's `interceptEditWrite` is called with `client.writeTextFile` before the normal notification logic runs.

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

### Modified: `package.json` — patched Claude Agent SDK

The `@anthropic-ai/claude-agent-sdk` dependency is repointed from the official npm release to a **patched vendored fork** at [`rohan-patra/claude-agent-sdk-patch`](https://github.com/rohan-patra/claude-agent-sdk-patch), pinned to a specific commit:

```json
"@anthropic-ai/claude-agent-sdk": "github:rohan-patra/claude-agent-sdk-patch#<commit-sha>"
```

**Why:** The official SDK tags every `claude` CLI subprocess it spawns as programmatic Agent SDK usage (`CLAUDE_CODE_ENTRYPOINT="sdk-ts"` plus a `CLAUDE_AGENT_SDK_VERSION` stamp on the child env). For the ACP connector — which is just a person driving Claude Code interactively from inside Zed — that tagging misclassifies legitimate interactive use as disallowed Agent SDK usage. The patch normalizes the spawned CLI's child-process environment so it matches an ordinary interactive session:

- `CLAUDE_CODE_ENTRYPOINT` is set to `"cli"` (the value a real interactive session uses) instead of `"sdk-ts"`.
- `CLAUDE_AGENT_SDK_VERSION` is `delete`d from the child env (clearing both the SDK's assignment and any value inherited from the host `process.env`).

**Drop-in by design:** The patch repo keeps the package name `@anthropic-ai/claude-agent-sdk` and the same exports/peer deps, so every `import … from "@anthropic-ai/claude-agent-sdk"` in our source is unchanged — only the dependency spec in `package.json` differs. It ships prebuilt bundles (`sdk.mjs`, etc.) with no `prepare`/`postinstall` step, so the git install works directly. Because it's a `git+ssh` spec, clones/CI need GitHub SSH access.

The patch tracks upstream: its `upstream` branch holds pristine npm tarballs (tagged `upstream-<version>`) and `main` carries the env-normalization patch merged on top. To pick up a newer SDK release, bump the pinned commit SHA to a newer `main` commit (see the patch repo's own `CLAUDE.md` for its re-merge workflow). The fork currently tracks SDK `0.3.170` (upstream `v0.43.0` pins `0.3.169`; the patch repo vendors `0.3.170`, one patch ahead).

**Checking for available patch-repo updates (use when an upstream merge bumps the SDK):**

```bash
# Currently-pinned SHA in our package.json:
grep claude-agent-sdk-patch package.json

# Recent patch-repo commits on main (look for "vendor: @anthropic-ai/claude-agent-sdk@<version>"):
gh api repos/rohan-patra/claude-agent-sdk-patch/commits -q '.[] | .sha + " " + (.commit.message | split("\n")[0])' | head -10
```

If the patch repo already has a `vendor:` commit matching (or newer than) the SDK version upstream just bumped to, take the latest `main` SHA. If not, you must advance the patch repo first (per its own `CLAUDE.md`) before bumping here — otherwise the connector will be running an older SDK than upstream's code targets, and any new SDK-API uses in upstream's merge will fail at runtime.

**SDK-bump merge procedure (when upstream's `package.json` shows a new `@anthropic-ai/claude-agent-sdk` version):**

1. Find the corresponding patch-repo `main` SHA that vendors that SDK version (see commands above).
2. Run `git merge upstream/main`. Expect conflicts in at least `package.json` and `package-lock.json`.
3. In `package.json`, drop both conflict sides for the `@anthropic-ai/claude-agent-sdk` line and replace with our git spec pinned to the SHA from step 1. Keep upstream's other dep bumps.
4. For `package-lock.json`, the fastest clean resolution is `git checkout --theirs package-lock.json && npm install` — that takes upstream's lockfile, then `npm install` regenerates the `@anthropic-ai/claude-agent-sdk` entry to point at our git spec while leaving every other dep at upstream's resolved versions.
5. Resolve any `src/` conflicts (see below), then `git add` everything and commit.

**Source-file merge gotcha:** Upstream occasionally reorganizes code adjacent to our additions. Recent example (v0.38.0): upstream moved the "Compacting completed." session-update text emission from the `compact_boundary` case to the `status` case (keyed on `compact_result === "success"`). Our fork had also added it in `compact_boundary` for our `contextDisplayState` reset path, so we ended up with a textual conflict. Resolution: keep our fork-specific addition (the `contextDisplayState` reset + `pushContextDisplayOption` call) but drop the duplicate text emission since upstream now handles that in `status`. The general rule: when a conflict hunk shows upstream removing a line that our fork also added nearby, check whether upstream just relocated it — if so, drop our copy.

### `.context` Directory Support

This fork stores plan files in `.context/plans/` within the project directory instead of the default `~/.claude/plans/`.

Changes in `src/acp-agent.ts`:

1. **`fs` import** — `import * as fs from "node:fs"` added at the top.

2. **`plansDirectory` setting** — In `createSession()`, the SDK `Options` object includes `settings: { plansDirectory: ".context/plans" }`, which overrides the default plans directory via the highest-priority "flag settings" layer.

3. **`.git/info/exclude` auto-update** — In `createSession()`, after `settingsManager.initialize()`, reads `.git/info/exclude` and appends `.context` if not already present. Silently skips if the file doesn't exist (non-git repos).

Changes in `src/tools.ts`:

4. **`.context/` bypass in `FileEditInterceptor`** — Files inside `<cwd>/.context/` skip the Review Changes UI and are written directly to disk. This is checked in `interceptEditWrite` right after the project-scope check.

### Session Config Improvements

In addition to the FileEditInterceptor, this fork adds model-aware session config options:

1. **`effort_level` selector** — When the current model supports effort levels (`ModelInfo.supportsEffort`), a "thought_level" category select appears in the session config. Uses `query.applyFlagSettings({ effortLevel })` to apply changes.

2. **`fast_mode` toggle** — When the current model supports fast mode (`ModelInfo.supportsFastMode`), a "model" category select appears with Off/Fast options. Uses `query.applyFlagSettings({ fastMode })`. The SDK's `fast_mode_state` from result messages is synced back to the session so the UI reflects server-side transitions (e.g., cooldown).

2b. **`ultracode` (effort-list entry)** — Ultracode is the SDK's session-scoped flag meaning "xhigh effort + standing dynamic-workflow orchestration" (see `Settings.ultracode`). Rather than a separate toggle, it appears as an extra **`"ultracode"` entry at the bottom of the existing Effort (`thought_level`) dropdown**, mirroring the native Claude Code thinking-level menu. The entry is added only when the current model is xhigh-capable (`ModelInfo.supportedEffortLevels` includes `"xhigh"`) **and** the Workflows feature is enabled. Selection is handled in the `effort` branch of `applyConfigOptionValue()`: choosing `"ultracode"` calls `query.applyFlagSettings({ ultracode: true })`; choosing any real effort level (or `"default"`) calls `applyFlagSettings({ effortLevel, ultracode: false })` to turn it back off and apply the chosen level in one call. It is **not** a real effort level (the SDK effort enum stays `low/medium/high/xhigh/max`) and is **never persisted** (session-scoped). Gating details:
   - **Workflows-enabled** is inferred at `createSession()` as "enabled unless explicitly disabled" — `settings.disableWorkflows !== true && settings.enableWorkflows !== false && !process.env.CLAUDE_CODE_DISABLE_WORKFLOWS` — because the SDK exposes no control call that reports the plan-default state. Stored on the session as `workflowsEnabled`.
   - **Initial state** seeds from `settings.ultracode` (the SDK already applied that itself, so no `applyFlagSettings` at init — we only mirror it into the effort dropdown's `currentValue`, and the init effort-apply skips the `"ultracode"` value), tracked on the session as `ultracode`.
   - On model switch to a **non-xhigh** model the entry disappears and `session.ultracode` is reset to `false` locally; the effort-sync clears the SDK flag (`ultracode: false`) when the switch turned it off.

3. **Model capability tracking** — `Session` stores `modelInfos: ModelInfo[]` (the raw SDK model list). When the user switches models via `setSessionConfigOption("model", ...)`, `buildConfigOptions()` is called to rebuild the config options, showing or hiding effort/fast/ultracode options based on the new model's capabilities.

4. **`context_display` dropdown** — A "Context" select in the "model" category, always present with three always-visible options. Each option's `name` is a live-rendered label; `currentValue` picks which one shows on the closed button. Labels fall back to terse placeholders (with the window size still shown when known) when data is missing:
   - `percent` — `"23%"` / `"-%"` (no data)
   - `numeric` — `"45k/1M"` / `"-/1M"` (no usage yet; `rawMax` is known from `inferContextWindowFromModel` at session creation) / `"-/-"` (no window info). k/M abbreviations via `formatTokens` in `src/context-display.ts`.
   - `until_compact` — `"139k to compact"` (`effectiveMax - used`) / `"at compact"` (remainder ≤ 0) / `"-"` (no data).

   Backing data comes from `query.getContextUsage()`, called at session init (to seed `rawMax`/`effectiveMax` before any turn — SDK-authoritative, works correctly for variants like Opus 1M where the `inferContextWindowFromModel` regex would otherwise fall back to 200k) and on every `result`. `ctx.totalTokens`, `ctx.rawMaxTokens`, and `ctx.maxTokens` (when `ctx.isAutoCompactEnabled`) populate `used`, `rawMax`, and `effectiveMax` respectively — the SDK's `maxTokens` already accounts for auto-compact, so the agent never interprets `autoCompactThreshold` itself. On SDK errors the fallback is `inferContextWindowFromModel` at init / per-turn `lastAssistantTotalUsage` + `session.contextWindowSize` on `result`, with `effectiveMax` left null (until_compact shows `-`). On model change `effectiveMax` is invalidated (the next turn re-fetches). `pushContextDisplayOption` sends `config_option_update` on every `result` and `compact_boundary`, with a structural-equality short-circuit to skip no-op pushes.

**Modified areas in `src/acp-agent.ts`:**
- `Session` type: added `fastModeState`, `ultracode`, `workflowsEnabled`, `effortLevel`, `modelInfos`, `contextDisplayView`, `contextDisplayState` fields
- `buildConfigOptions()`: accepts optional `modelInfos`, `currentEffortLevel`, `fastModeState`, `contextDisplay`, `ultracode` (`{ workflowsEnabled, state }`) params; conditionally pushes `effort_level`, `fast_mode`, and (always) `context_display` options. The `ultracode` param adds an `"ultracode"` entry to the effort option (and makes it the effort `currentValue` when on) — it is not a separate option
- `applyConfigOptionValue()`: handles `fast_mode`, `effort_level`, and `context_display` config IDs (the if/else chain that `setSessionConfigOption()` and `updateConfigOption()` both call); the `effort` branch special-cases the `"ultracode"` value (toggling the SDK `ultracode` flag); model handler rebuilds config options, resets `ultracode` for non-xhigh models (clearing the SDK flag via the effort-sync), and re-derives `contextDisplayState.rawMax`
- `pushContextDisplayOption()`: private method — rebuilds the `context_display` option from current session state and fires `config_option_update`
- `prompt()` result handler: syncs `fast_mode_state` from SDK result messages; updates `contextDisplayState` (and fetches `autoCompactThreshold` on first turn) then calls `pushContextDisplayOption()`
- `prompt()` `compact_boundary` handler: resets `contextDisplayState.used = 0` and calls `pushContextDisplayOption()`
- `createSession()`: initializes new session fields (including `modelInfos` from `initializationResult.models`, the `workflowsEnabled`/`ultracode` gating state, and the initial context-display state), passes them to `buildConfigOptions()`

**New file:** `src/context-display.ts` — pure formatters (`formatPercent`, `formatNumeric`, `formatUntilCompact`, `formatTokens`) and the `buildContextDisplayOption()` option builder. Covered by `src/tests/context-display.test.ts`.

### Expanded Model Picker

Upstream surfaces whatever the SDK's model list returns. We verified empirically that **both** `query.supportedModels()` and `initializationResult().models` only ever return the same 4 curated entries (`default` → Opus 4.8 1M, `sonnet`, `sonnet[1m]`, `haiku`). The SDK control API has no call that enumerates the version-pinned variants (Opus 4.7, Opus 4.6 1M, …), even though the bundled `claude` binary's model registry knows them and `setModel` accepts their IDs. So "pull every model from the SDK verbatim" is not possible — there is no fuller list to pull. This fork instead defines the picker explicitly to mirror the Claude Code native model picker.

**Changes in `src/acp-agent.ts`:**

1. **`FORK_MODEL_PICKER`** — A constant `ReadonlyArray` of the 7 picker entries in native-picker order, each with `value` / `displayName` / `description` / `family`. The `value`s are real model IDs verified to exist in the bundled binary's registry: `opus[1m]` (Opus 4.8 1M), `opus` (Opus 4.8), `claude-opus-4-7[1m]` (Opus 4.7 1M), `claude-opus-4-7` (Opus 4.7), `claude-opus-4-6[1m]` (Opus 4.6 1M), `sonnet` (Sonnet 4.6), `haiku` (Haiku 4.5).

2. **`FORK_MODEL_CAPABILITY_FALLBACK`** — Per-family (`opus`/`sonnet`/`haiku`) capability flags used when the SDK doesn't surface a family template to copy from (e.g. a stripped-down test mock). Mirrors the live SDK's per-family shape.

3. **`buildForkModelList(sdkModels)`** (exported) — Builds `FORK_MODEL_PICKER` into a `ModelInfo[]`, carrying each entry's display info verbatim and donating capability flags (effort levels, fast/auto mode, adaptive thinking) from the matching SDK **family template** (`default` → Opus, `sonnet`/`haiku` for the others), falling back to `FORK_MODEL_CAPABILITY_FALLBACK`. This keeps effort/fast/auto gating in `buildConfigOptions()` accurate. (Older Opus variants inherit the latest-Opus family flags — a small approximation the CLI re-validates at turn time.)

4. **`createSession()` wiring** — When the user has **not** set an `availableModels` allowlist, `allowedModels` is `buildForkModelList(initializationResult.models)` (the fork picker). When they **have**, the original `applyAvailableModelsAllowlist(initializationResult.models, …)` behavior is kept verbatim (the user opted into a specific list). `initializationResult.models` (the SDK's real list) is still passed to `getAvailableModels()` as the skip-`setModel` reference, so pinning a fork-only ID like `claude-opus-4-7` correctly issues a `setModel` call while a value the SDK already surfaced is skipped.

**Maintenance:** because the picker is now an explicit list, a new Opus/Sonnet/Haiku generation won't appear automatically — update `FORK_MODEL_PICKER` (and bump the bundled SDK so the new IDs resolve). The default selection is pinned to `opus[1m]`; if Anthropic moves the recommended default, update the list's first entry. Covered by `src/tests/fork-model-list.test.ts`; the resolution/allowlist/auto-mode cases live in `src/tests/acp-agent-settings.test.ts`.

## How to Merge Upstream Updates

When pulling changes from `zed-industries/claude-agent-acp`:

1. **`src/acp-agent.ts`** — Our changes are isolated insertion blocks:
   - `fs` import at the top
   - `createFileEditInterceptor` block (~5 lines in `createSession()` after capabilities check)
   - `.context` git-exclude block (~8 lines in `createSession()` after `settingsManager.initialize()`)
   - `settings: { plansDirectory: ".context/plans" }` in the `Options` object
   - PostToolUse `onFileRead` wiring (~3 lines in the `createPostToolUseHook` options)
   - PreToolUse hooks block calling `createPreToolUseHook` with `onPreWrite` (sibling to PostToolUse block)
   - `fileEditInterceptor` forwarding in `toAcpNotifications` and `streamEventToAcpNotifications`
   - Session config improvements: `buildConfigOptions()` extended with model capability params, `applyConfigOptionValue()` handles `fast_mode`/`effort_level` (the `effort` branch special-cases `"ultracode"`), `prompt()` result handler syncs `fast_mode_state`
   - `ultracode` (effort-list entry): `Session` fields `ultracode`/`workflowsEnabled`, the `ultracode` param on `buildConfigOptions()` that adds an `"ultracode"` entry to the effort option (gated on xhigh-capability + workflows enabled), the `"ultracode"` handling in the `applyConfigOptionValue()` `effort` branch + the non-xhigh reset in the model branch, the `"ultracode"`-skip in the init effort-apply, and the `workflowsEnabled`/`initialUltracode` computation in `createSession()`. Covered by `src/tests/session-config-options.test.ts` and `src/tests/acp-agent-settings.test.ts`
   - `context_display` dropdown: import from `./context-display.js`, `Session` fields (`contextDisplayView`, `contextDisplayState`), `buildConfigOptions()` `contextDisplay` param, `pushContextDisplayOption()` method, `prompt()` result-handler state update + one-shot `getContextUsage()` fetch, `compact_boundary` reset, `applyConfigOptionValue()` `context_display` branch, `applyConfigOptionValue()` model branch re-derives `contextDisplayState.rawMax`
   - `CLAUDE_CODE_THINKING_DISPLAY` env-var opt-in (~8 lines in `createSession()` near `maxThinkingTokens`): reads `process.env.CLAUDE_CODE_THINKING_DISPLAY` (`"summarized"` or `"omitted"`), spreads `thinking: { type: "adaptive", display }` into `Options` only when set. Opus 4.7 defaults `display` to `"omitted"`; this restores populated thinking streams when users opt in via Zed's `agent_servers.env`.
   - Expanded model picker: `FORK_MODEL_PICKER` / `FORK_MODEL_CAPABILITY_FALLBACK` constants + `buildForkModelList()` (defined just before `applyAvailableModelsAllowlist`), and the `createSession()` `allowedModels` branch that uses `buildForkModelList(initializationResult.models)` when no `availableModels` allowlist is set. If upstream changes the `allowedModels`/`getAvailableModels` block, keep our no-allowlist branch pointed at `buildForkModelList`.

   If upstream modifies `createSession()`, `toAcpNotifications()`, `streamEventToAcpNotifications()`, `buildConfigOptions()`, `setSessionConfigOption()`, or `applyConfigOptionValue()`, our blocks need to stay in the same logical positions.

2. **`src/tools.ts`** — Our changes are:
   - `fs` import addition at the top
   - `extractReadContent`, `isToolError`, `FileEditInterceptor`, `createFileEditInterceptor`, `createPreToolUseHook` appended at end of file
   - `.context/` bypass check inside `isInScope` (used by both `onPreWrite` and `interceptEditWrite`)
   - `onFileRead` option added to `createPostToolUseHook`
   - `onPreWrite` option on `createPreToolUseHook`; `nonExistentFiles` set in the interceptor's closure

   If upstream adds new tool handling, our additions are all at the end of the file and shouldn't conflict.

3. **`src/lib.ts`** — Export lines. Straightforward to re-add if upstream modifies exports.

4. **`package.json` and `package-lock.json`** — The `@anthropic-ai/claude-agent-sdk` dependency must stay pointed at the patched fork (`github:rohan-patra/claude-agent-sdk-patch#<sha>`), **not** the version that upstream's `package.json` declares. When merging an upstream bump, keep our git spec — don't accept upstream's npm version. To track a newer SDK, first advance the patch repo (vendor the new upstream tarball + re-apply the env-normalization patch on its `main`), then bump the pinned SHA here. See the **Modified: `package.json`** section above for the full step-by-step (including the `git checkout --theirs package-lock.json && npm install` shortcut for resolving the lockfile conflict).

## Architecture

```
Zed <──ACP (ndjson/stdio)──> ClaudeAcpAgent <──Claude Agent SDK──> Claude API
                                    │
                                    ├── FileEditInterceptor (PostToolUse hook)
                                    │   ├── Edit: read from disk → revert → writeTextFile → Review UI
                                    │   └── Write: revert → writeTextFile → Review UI
                                    │
                                    └── PostToolUse onFileRead (caches content for revert)
```

### Flow: Edit/Write (Main Session and Subagents)
1. Claude calls the built-in Edit or Write tool
2. The tool executes normally, writing to disk
3. PostToolUse hook fires → `interceptEditWrite` is called
4. Interceptor determines the new content (from disk for Edit, from input for Write)
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

## Creating and Updating Releases

GitHub Actions is not enabled on this fork, so releases are created manually via `gh`. Use the `-custom` suffix to distinguish from upstream versions (e.g., `v0.19.2-custom`). Always specify `--repo <owner>/<repo>` (matching this fork's `origin` remote) to avoid hitting the upstream repo.

### Version numbering

- **Standard release**: When upstream tags a new version (e.g., `v0.20.2`), our corresponding fork release is `v0.20.2-custom`.
- **Interstitial release**: When we merge upstream commits that haven't been included in an upstream release yet, use a patch-level increment: `v<upstream>.<patch>-custom`. For example, if the latest upstream release is `v0.20.2` and we merge newer upstream commits, tag as `v0.20.2.1-custom`, `v0.20.2.2-custom`, etc. When upstream eventually tags their next release, our next `-custom` release resets to match it (e.g., `v0.20.3-custom`).

### New release

```bash
git tag v<version>
git push origin v<version>
gh release create v<version> --title "v<version>" --generate-notes --repo <owner>/<repo>
```

### Updating an existing release to the current commit

This deletes the old release and its remote tag, moves the local tag, and recreates the release at HEAD:

```bash
gh release delete v<version> --yes --cleanup-tag --repo <owner>/<repo>
git tag -d v<version>
git tag v<version> HEAD
git push origin v<version>
gh release create v<version> --title "v<version>" --generate-notes --repo <owner>/<repo>
```

## Testing

```bash
npm run build          # TypeScript compilation
npm run test:run       # Unit tests (95 tests)
npm run test:integration  # Integration tests (requires RUN_INTEGRATION_TESTS=true)
```

## README Structure

The `README.md` is structured in two parts separated by a horizontal rule (`---`):

1. **Fork section** (top) — Our user-facing documentation: overview, how it works, background, setup, features, development, and merge compatibility table.
2. **Upstream README** (bottom) — The full upstream `README.md` reproduced verbatim under an "Upstream README" heading.

When merging upstream updates, check if the upstream `README.md` changed and update the bottom section to match. The fork section at the top should only change when our fork's functionality changes.

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
