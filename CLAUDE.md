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

The patch tracks upstream: its `upstream` branch holds pristine npm tarballs (tagged `upstream-<version>`) and `main` carries the env-normalization patch merged on top. To pick up a newer SDK release, bump the pinned commit SHA to a newer `main` commit (see the patch repo's own `CLAUDE.md` for its re-merge workflow). The fork currently tracks SDK `0.3.207` (upstream `v0.58.1` pins `0.3.205`; the patch repo vendors `0.3.207`, which is ≥ upstream's pin per the "matching-or-newer → take latest `main`" rule).

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

2. **`fast_mode` toggle** — _(fork version removed)_ The fork originally added its own Fast mode select (a `fastModeState` "off"/"cooldown"/"on" field + a `"fast_mode"` config option). Upstream later shipped a first-class Fast mode config (#828, config id `"fast"`, boolean `fastModeEnabled`, `createFastModeConfigOption`, `syncFastModeState`, `fastModeStateEnabled`, boolean-option support via `clientSupportsBooleanConfigOptions`). Per the "prefer upstream's reimplementation" rule, the fork's version was dropped entirely in the v0.54.1 merge — Fast mode is now **upstream's** feature and needs no fork maintenance.

2b. **`ultracode` (effort-list entry)** — Ultracode is the SDK's session-scoped flag meaning "xhigh effort + standing dynamic-workflow orchestration" (see `Settings.ultracode`). Rather than a separate toggle, it appears as an extra **`"ultracode"` entry at the bottom of the existing Effort (`thought_level`) dropdown**, mirroring the native Claude Code thinking-level menu. The entry is added only when the current model is xhigh-capable (`ModelInfo.supportedEffortLevels` includes `"xhigh"`) **and** the Workflows feature is enabled. Selection is handled in the `effort` branch of `applyConfigOptionValue()`: choosing `"ultracode"` calls `query.applyFlagSettings({ ultracode: true })`; choosing any real effort level (or `"default"`) calls `applyFlagSettings({ effortLevel, ultracode: false })` to turn it back off and apply the chosen level in one call. It is **not** a real effort level (the SDK effort enum stays `low/medium/high/xhigh/max`) and is **never persisted** (session-scoped). Gating details:

- **Workflows-enabled** is inferred at `createSession()` as "enabled unless explicitly disabled" — `settings.disableWorkflows !== true && settings.enableWorkflows !== false && !process.env.CLAUDE_CODE_DISABLE_WORKFLOWS` — because the SDK exposes no control call that reports the plan-default state. Stored on the session as `workflowsEnabled`.
- **Initial state** seeds from `settings.ultracode` (the SDK already applied that itself, so no `applyFlagSettings` at init — we only mirror it into the effort dropdown's `currentValue`, and the init effort-apply skips the `"ultracode"` value), tracked on the session as `ultracode`.
- On model switch to a **non-xhigh** model the entry disappears and `session.ultracode` is reset to `false` locally; the effort-sync clears the SDK flag (`ultracode: false`) when the switch turned it off.

3. **Model capability tracking** — `Session` stores `modelInfos: ModelInfo[]` (the raw SDK model list). When the user switches models via `setSessionConfigOption("model", ...)`, `buildConfigOptions()` is called to rebuild the config options, showing or hiding effort/fast/ultracode options based on the new model's capabilities.

> **Note:** A fork-specific `context_display` ("Context") dropdown previously lived here. It was **removed** once Zed added a native context-window display — keeping ours would double up. The removal dropped `src/context-display.ts`, the `contextDisplayView`/`contextDisplayState` Session fields, the `buildConfigOptions()` `contextDisplay` param, the `pushContextDisplayOption()` method, the `getContextUsage()`-at-init fetch (reverted to upstream's `inferContextWindowFromModel` seed for `contextWindowSize`), and the `result`/`compact_boundary`/model-switch hooks. `contextWindowSize`/`inferContextWindowFromModel`/`getContextUsage` are upstream-shared and stay.

**Modified areas in `src/acp-agent.ts`:**

- `Session` type: added `ultracode`, `workflowsEnabled`, `effortLevel`, `modelInfos` fields (Fast mode's `fastModeEnabled` is upstream's, not ours)
- `buildConfigOptions()`: accepts optional `modelInfos`, `currentEffortLevel`, and `ultracode` (`{ workflowsEnabled, state }`) params; conditionally pushes the `effort_level` option. The `ultracode` param adds an `"ultracode"` entry to the effort option (and makes it the effort `currentValue` when on) — it is not a separate option. **The `ultracode` param is kept LAST in the signature (after upstream's `agents`/`currentAgent`/`fastMode`)** so upstream's positional call sites/tests don't shift on re-merge
- `applyConfigOptionValue()`: handles the `effort_level` config ID (the if/else chain that `setSessionConfigOption()` and `updateConfigOption()` both call); the `effort` branch special-cases the `"ultracode"` value (toggling the SDK `ultracode` flag); model handler rebuilds config options and resets `ultracode` for non-xhigh models (clearing the SDK flag via the effort-sync)
- `createSession()`: initializes new session fields (including `modelInfos` from `initializationResult.models` and the `workflowsEnabled`/`ultracode` gating state), passes them to `buildConfigOptions()`

### Expanded Model Picker

Upstream surfaces whatever the SDK's model list returns. We verified empirically that **both** `query.supportedModels()` and `initializationResult().models` only ever return the same 4 curated entries (`default` → Opus 4.8 1M, `sonnet`, `sonnet[1m]`, `haiku`). The SDK control API has no call that enumerates the version-pinned variants (Opus 4.7, Opus 4.6 1M, …), even though the bundled `claude` binary's model registry knows them and `setModel` accepts their IDs. So "pull every model from the SDK verbatim" is not possible — there is no fuller list to pull. This fork instead defines the picker explicitly to mirror the Claude Code native model picker.

**Changes in `src/acp-agent.ts`:**

1. **`FORK_MODEL_PICKER`** — A constant `ReadonlyArray` of the 7 picker entries in native-picker order, each with `value` / `displayName` / `description` / `family`. The `value`s are real model IDs/aliases verified to exist in the bundled binary's registry: `fable` (Fable 5), `opus[1m]` (Opus 4.8 1M), `claude-opus-4-7[1m]` (Opus 4.7 1M), `claude-opus-4-6[1m]` (Opus 4.6 1M), `sonnet` (Sonnet 5), `claude-sonnet-4-6` (Sonnet 4.6), `haiku` (Haiku 4.5). The first entry (`fable`) is the default selection; it carries `family: "opus"` so it donates the SDK `default` (flagship) capability template. (Fable was dropped when Anthropic briefly removed the model and re-added here once it returned to the bundled binary's registry.) **1M-only policy:** where a model has both a 1M and a non-1M variant, only the 1M entry is listed (the non-1M `opus`/`claude-opus-4-7` entries were removed) since 1M is a strict superset; a model with no 1M variant (e.g. `sonnet`, `claude-sonnet-4-6`, `haiku`) is listed as-is.

2. **`FORK_MODEL_CAPABILITY_FALLBACK`** — Per-family (`opus`/`sonnet`/`haiku`) capability flags used when the SDK doesn't surface a family template to copy from (e.g. a stripped-down test mock). Mirrors the live SDK's per-family shape.

3. **`buildForkModelList(sdkModels)`** (exported) — Builds `FORK_MODEL_PICKER` into a `ModelInfo[]`, carrying each entry's display info verbatim and donating capability flags (effort levels, fast/auto mode, adaptive thinking) from the matching SDK **family template** (`default` → Opus, `sonnet`/`haiku` for the others), falling back to `FORK_MODEL_CAPABILITY_FALLBACK`. This keeps effort/fast/auto gating in `buildConfigOptions()` accurate. (Older Opus variants inherit the latest-Opus family flags — a small approximation the CLI re-validates at turn time.)

4. **`createSession()` wiring** — When the user has **not** set an `availableModels` allowlist, `allowedModels` is `buildForkModelList(initializationResult.models)` (the fork picker). When they **have**, the original `applyAvailableModelsAllowlist(initializationResult.models, …)` behavior is kept verbatim (the user opted into a specific list). `initializationResult.models` (the SDK's real list) is still passed to `getAvailableModels()` as the skip-`setModel` reference, so pinning a fork-only ID like `claude-opus-4-7[1m]` correctly issues a `setModel` call while a value the SDK already surfaced is skipped.

**Maintenance:** because the picker is now an explicit list, a new Fable/Opus/Sonnet/Haiku generation won't appear automatically — update `FORK_MODEL_PICKER` (and bump the bundled SDK so the new IDs resolve). The default selection is the first entry (currently `fable`); if Anthropic moves the recommended default, update the list's first entry. Covered by `src/tests/fork-model-list.test.ts`; the resolution/allowlist/auto-mode cases live in `src/tests/acp-agent-settings.test.ts`.

### Background-Task Visibility

The SDK ends the ACP turn (`result` → `end_turn`) when a foreground model invocation finishes, but background work (subagents, Bash, monitors, workflows) and auto-continuations keep running. Rather than hold the turn open (which upstream rejects and ACP v2 removes), this fork surfaces ongoing work and settles the turn at the authoritative `idle` signal instead, fixing a UX gap where the composer unlocks while Claude is still working.

**Three additive features:**

1. **Backgrounded tool cards stay `in_progress`** — When a tool_result carries `deferred_tool_use` or the SDK marks a task backgrounded, the corresponding ACP tool-call card stays spinning instead of immediately finishing. The card finalizes late when the background task terminates (via a terminal `task_notification`/`task_updated` event). This keeps the user aware the work continues. Foreground subagents get a brief `in_progress` flicker then finalize on their terminal edge — an accepted side effect.

2. **Running tasks appear in the plan panel** — Background tasks are mirrored into the ACP plan as `in_progress` entries with human-readable labels: `subagent: <type>`, `shell: <command>`, or the task's description for other/unknown `task_type`s (no emoji — the `in_progress` status already renders a spinner in the client; see `runningTaskLabel`). The plan is the sole surface — rows persist across turns while work continues, and disappear when the task settles. This is achieved via a single-owner combiner (`buildMergedPlanEntries`) that unions todo-plan entries with running-task plan entries.

3. **Turn settles at `idle`, not a non-terminal `result`** — When a `result` carries `deferred_tool_use` (the only cleanly-detectable non-terminal case), the fork does **not** settle the turn; instead, the turn remains pending until the final result or the authoritative `idle` signal. This fixes the unlock-too-early symptom for deferred-tool turns. Normal single-result turns still unlock immediately (no #773 regression). Pure auto-continuations (undetectable at result-time) are out of scope.

**Files modified:**

- `src/tools.ts` — `RunningTask` type; `runningTaskLabel()`, `runningTaskPlanEntries()`, `buildMergedPlanEntries()`, `suppressBackgroundToolResults()` helpers; `runningTasks?` added to `toAcpNotifications`/`streamEventToAcpNotifications` options.
- `src/acp-agent.ts` — Session fields `runningTasks` (Map) and `runningTaskByToolUseId` (reverse index); consumer handlers `task_started`, `task_notification`, `task_updated`, `background_tasks_changed`; private methods `emitPlan()` and `finalizeRunningTask()`; suppression wiring at the consolidated tool-result emit; plan-combiner integration at `createTaskHook` onChange and TodoWrite/Task* plan-emit sites; `Turn.settleAtIdle` flag for deferred-result logic; `result` handler checks `deferred_tool_use` to defer settlement; `idle` handler branch for settlement-at-idle (precedence: cancel > owed-decrement > deferred-settle > #825 no_result); requires_action/running no-op branch documents paused-turn correctness.

**Merge-maintenance notes:**

- **Single plan-emit owner** — The combiner `buildMergedPlanEntries` is the only producer of ACP plan entries. Every `sessionUpdate: "plan"` must route through it (two sites in acp-agent.ts + one in toAcpNotifications). If you add a new plan-emit, wire it through the combiner.
- **`settleAtIdle` turn-lifecycle hook** — A fork-only per-turn flag that defers settlement from a non-terminal `result` to the `idle` handler. If upstream reworks the result/idle handlers, re-anchor this hook to the new structure.
- **`background_tasks_changed` handler** — Previously a no-op `break`. Now splits its own branch (REPLACE-reconcile the `backgrounded` flag against the SDK payload, synthesize missing entries, emit plan). If upstream changes the consumer switch structure, keep this logic.
- **owed-accounting adjustment** — When a result carries `deferred_tool_use`, it does not increment the owed counter (no trailing idle of its own). The deferred-settle branch in the idle handler keeps the accounting correct across sequences (normal → deferred→final → idle → deferred→idle).

#### If Zed Changes Behavior

These features depend on specific Zed rendering behavior (verified as of this work in Zed `crates/acp_thread/src/acp_thread.rs`). Document what to do if Zed changes:

**Dependency 1: Zed applies session updates regardless of turn state**

- Current: Zed processes `tool_call`, `tool_call_update`, `plan` updates even after `end_turn` (no running-turn guard). This is how late `finalizeRunningTask()` and post-turn plan updates render.
- If Zed starts dropping updates outside an active turn: Feature A's late card finalization and Feature B's post-turn plan updates stop rendering. Mitigation: keep the turn open via deferred settlement (Feature C-style) or migrate to an ACP v2 mechanism when it ships. Affected code: the `finalizeRunningTask()` late-emit in `background_tasks_changed` and the final `emitPlan()` call in both terminal task edges.

**Dependency 2: Zed keeps in_progress cards spinning indefinitely**

- Current: Zed does not auto-cancel or auto-finalize `in_progress` tool cards on a clean `end_turn`. Cards spin forever until a `tool_call_update` with a terminal status (`completed`, `failed`, etc.) arrives.
- If Zed adds an inactivity timeout (e.g., auto-cancel after 5 min idle): add the deferred heartbeat — emit `tool_call_update{status:"in_progress"}` from the `task_progress` handler (acp-agent.ts:2461, already fires for a different tool id) on a cadence (e.g., every 30 sec). If Zed starts marking in_progress cards Canceled/Failed on `end_turn`: Feature A breaks; card finalization would need a different surface (e.g., UI toast, new ACP message type, or a "deferred" card status).

**Dependency 3: Zed keeps in_progress plan entries across turns**

- Current: Zed only snapshots/clears a plan when nothing is pending/in_progress (having a running-task `in_progress` entry counts as pending). This is why running-task rows persist across turns until the task settles.
- If Zed changes plan-clear semantics: running-task rows may vanish mid-turn or a finished todo plan may freeze with a stale running-task row. Mitigation: switch to a dedicated surface (UI pane, toast, or terminal output) instead of piggybacking on the plan panel.

**Dependency 4 (edge case): User Stop during a later turn**

- Current: User hits Stop during turn N+1. Zed marks all outstanding `in_progress` cards Canceled. But the SDK task lives on (stop only cancels the main turn). When the background task terminates, the fork emits `tool_call_update{status:"completed"}` to overwrite the Canceled status.
- If Zed stops honoring late `tool_call_update` overwrites: the card remains Canceled even though the task succeeded. Workaround: require user to manually accept Canceled cards-that-succeeded, or document the gap.

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
   - Session config improvements: `buildConfigOptions()` extended with model capability params, `applyConfigOptionValue()` handles `effort_level` (the `effort` branch special-cases `"ultracode"`). **Fast mode is upstream's now** (fork version removed in the v0.54.1 merge — see the "`fast_mode` toggle" note above); don't reintroduce the fork's `fastModeState`/`"fast_mode"` option. **Param-order note:** upstream owns the leading `buildConfigOptions()` params (`…, currentEffortLevel, agents, currentAgent, fastMode`). The fork's single remaining `ultracode?` param is kept **LAST** in the signature so upstream's positional call sites/tests never shift on re-merge. If you add another fork-only param, append it at the end too.
   - `ultracode` (effort-list entry): `Session` fields `ultracode`/`workflowsEnabled`, the `ultracode` param on `buildConfigOptions()` that adds an `"ultracode"` entry to the effort option (gated on xhigh-capability + workflows enabled), the `"ultracode"` handling in the `applyConfigOptionValue()` `effort` branch + the non-xhigh reset in the model branch, the `"ultracode"`-skip in the init effort-apply, and the `workflowsEnabled`/`initialUltracode` computation in `createSession()`. Covered by `src/tests/session-config-options.test.ts` and `src/tests/acp-agent-settings.test.ts`
   - `/btw <question>` side-question: a fork-only feature (upstream has no `/btw`). It is dispatched from `prompt()` (before the turn is enqueued) to `handleBtwQuestion()`, which spawns an ephemeral non-persisted `query()` and serializes behind the main turn via `session.idleResolvers`. **Ported onto upstream's `turnQueue`/consumer model:** the "main busy" check uses `session.activeTurn`/`turnQueue` (not the removed `promptRunning`), and `idleResolvers` are drained by `maybeReleaseIdleWaiters()` from the consumer's `settleActive`/`failActive` paths (not an old `prompt()` finally block). `cancel()` also drains `idleResolvers` and interrupts `session.btwQuery`. Session fields: `btwQuery?`, `idleResolvers`, `hasRunMainPrompt`. If upstream reworks the consumer/turn model again, re-anchor these hooks rather than reintroducing `promptRunning`.
   - `CLAUDE_CODE_THINKING_DISPLAY` env-var opt-in (~8 lines in `createSession()` near `maxThinkingTokens`): reads `process.env.CLAUDE_CODE_THINKING_DISPLAY` (`"summarized"` or `"omitted"`), spreads `thinking: { type: "adaptive", display }` into `Options` only when set. Opus 4.7 defaults `display` to `"omitted"`; this restores populated thinking streams when users opt in via Zed's `agent_servers.env`.
   - Expanded model picker: `FORK_MODEL_PICKER` / `FORK_MODEL_CAPABILITY_FALLBACK` constants + `buildForkModelList()` (defined just before `applyAvailableModelsAllowlist`), and the `createSession()` `allowedModels` branch that uses `buildForkModelList(initializationResult.models)` when no `availableModels` allowlist is set. If upstream changes the `allowedModels`/`getAvailableModels` block, keep our no-allowlist branch pointed at `buildForkModelList`.
   - Background-task visibility: `Session` fields `runningTasks`/`runningTaskByToolUseId` init (~2 lines in `createSession()`); consumer handlers `task_started`/`task_notification`/`task_updated`/`background_tasks_changed` with upserts and terminal edges; `emitPlan()` and `finalizeRunningTask()` helper methods; plan-combiner wiring at `createTaskHook` onChange (both blocks use `buildMergedPlanEntries`); suppresssion at the consolidated tool-result emit (~5 lines, `suppressBackgroundToolResults` wraps `toAcpNotifications`); `Turn.settleAtIdle` flag; result handler checks `deferred_tool_use` (few lines after `isTaskNotification`); owed-increment guard excludes deferred results; deferred-settlement path in the idle handler (branch C, after owed-decrement, before #825 fail); requires_action/running no-op branch. Covered by new tests in `src/tests/acp-agent.test.ts`.

   If upstream modifies `createSession()`, `toAcpNotifications()`, `streamEventToAcpNotifications()`, `buildConfigOptions()`, `setSessionConfigOption()`, `applyConfigOptionValue()`, or the consumer `runConsumer` switch structure, our blocks need to stay in the same logical positions.

2. **`src/tools.ts`** — Our changes are:
   - `fs` import addition at the top
   - `extractReadContent`, `isToolError`, `FileEditInterceptor`, `createFileEditInterceptor`, `createPreToolUseHook` appended at end of file
   - `.context/` bypass check inside `isInScope` (used by both `onPreWrite` and `interceptEditWrite`)
   - `onFileRead` option added to `createPostToolUseHook`
   - `onPreWrite` option on `createPreToolUseHook`; `nonExistentFiles` set in the interceptor's closure
   - Background-task helpers appended at end of file: `RunningTask` type, `runningTaskLabel()`, `runningTaskPlanEntries()`, `buildMergedPlanEntries()`, `suppressBackgroundToolResults()`; `runningTasks?` parameter added to `toAcpNotifications` and `streamEventToAcpNotifications` options types and threaded through.

   If upstream adds new tool handling or modifies plan emission, our additions are all at the end of the file and shouldn't conflict. When wiring new plan emits, route through `buildMergedPlanEntries` (the single combiner).

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
