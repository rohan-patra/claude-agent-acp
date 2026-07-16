# Tracked-File Watcher Fallback — Known Limitations

This document records the known limitations of the **tracked-file watcher fallback**
for Zed's Review Changes UI (see the "Tracked-File Watcher Fallback" section of
`CLAUDE.md` and the "Watcher fallback for non-tool edits" section of `README.md`
for how the feature works).

## Context

Two paths route file changes into Zed's Review Changes UI:

1. **Exact built-in `Edit`/`Write` interception** — tool-aware, includes new files
   and structured tool-card diffs. Authoritative for the built-in tools.
2. **Source-agnostic watcher fallback** — catches net changes to files that were
   **Git-tracked and present at session start**, from any source (Bash,
   formatters, MCP tools, subagents, background processes), by reverting to a
   session-start baseline and re-proposing through ACP `writeTextFile`.

Because ACP exposes **no accept/reject callback**, the watcher infers the user's
decision purely from later disk state — Zed persists a proposal to disk at route
time (its `write_text_file` ends in `save_buffer`), restores the pre-proposal
content on reject, and writes nothing on accept. The limitations below fall out of
that inference model, the revert-based approach, deliberate scope boundaries, and
external assumptions.

Verified against the Zed source (`crates/acp_thread/src/acp_thread.rs`,
`crates/action_log/src/action_log.rs`) and the pinned Claude Agent SDK.

---

## Inference gaps (inherent to having no accept/reject callback)

### 1. A file open + edited in Zed's own editor can desync the reject baseline

- **Trigger:** `foo.ts` is open in a Zed editor tab (possibly with unsaved edits),
  and a Bash command / formatter also modifies `foo.ts` on disk.
- **Mechanism:** Zed's `write_text_file` diffs the proposed content against the
  **live buffer snapshot**, not disk (`acp_thread.rs`), and on reject restores the
  buffer's tracked base. The watcher reverted disk to its own `committed` baseline
  first, but Zed's "before" is the buffer, which can differ — so `pending.rejectTarget`
  and what Zed actually restores can disagree.
- **Effect:** On reject, disk may land on content the watcher doesn't recognize as
  the reject target and treats as a fresh change → a spurious extra review entry.
  No data loss.
- **Severity:** Low–moderate; only when the same file is concurrently open + dirty
  in the editor.
- **Fixable?** Not cleanly from the adapter — it's about Zed's buffer state vs disk.

### 2. A new change within the sub-second window before a reject is observed can mask it

- **Trigger:** A proposal is outstanding; the user rejects it, but a background
  process writes the same file again within ~one debounce interval (~50 ms) of the
  reject.
- **Mechanism:** The watcher re-reads live disk at settle time. If the reject-restore
  write and a genuine new write coalesce, it observes only the final content (not the
  reject target), so the reject is never recognized and `committed` stays
  optimistically advanced to the rejected proposal.
- **Effect:** The next routed change reverts to the rejected proposal instead of the
  pre-proposal content — the reject is effectively swallowed.
- **Severity:** Low; requires a write racing a reject within tens of milliseconds.
- **Fixable?** No — inherent to disk-only inference.

### 3. Content-collision misclassification

- **Trigger:** While a proposal is pending, a process writes the file to content that
  exactly equals either the pending proposal or its reject target.
- **Mechanism:** Accept/reject is inferred by content equality
  (`content === pending.proposal` vs `=== pending.rejectTarget`). The watcher can't
  tell "user clicked accept" from "another process produced identical bytes."
- **Effect:** A manual/external edit whose content equals the reject target reads as a
  reject (baseline rolls back); one equal to the proposal reads as an accept.
- **Severity:** Very low.
- **Fixable?** No — inherent to content-only inference.

---

## Consequences of the revert-based approach

### 4. Brief revert window exposes stale content to concurrent readers

- **Trigger:** A tracked file is changed, and *during* the watcher's handling another
  process (or the agent's next Bash command) reads it.
- **Mechanism:** To make Zed render a `committed → proposed` diff, the watcher writes
  the old `committed` content back to disk, then calls `writeTextFile`. Between those
  two steps the file momentarily holds the *old* content.
- **Effect:** A read landing in that window sees the pre-change content. The final
  state is correct. (Also affects the pre-existing built-in Edit/Write path.)
- **Severity:** Low; sub-second window.
- **Fixable?** No — the revert is required to produce the diff.

---

## Scale / resource

### 5. Startup snapshots every tracked text file into memory

- **Trigger:** Opening a session in a large repo / monorepo.
- **Mechanism:** Init runs `git ls-files` and reads the full working-tree content of
  every tracked, text, in-scope file into an in-memory `committed` baseline (needed to
  revert to the exact session-start content, including pre-existing dirty edits). The
  tempting alternative — store hashes and reconstruct baselines from git on demand — is
  **unsafe**: `.gitattributes` smudge/clean filters (autocrlf, LFS) make
  `git show :path` differ from the working-tree bytes, corrupting the reject baseline.
- **Effect:** Memory ≈ total tracked text size, plus a `git ls-files` + full-tree read
  at session start; noticeable on huge monorepos.
- **Severity:** Low for typical repos; can matter on very large ones.
- **Fixable?** Not cleanly (the safe reconstruction path doesn't exist due to git
  filters). A size cap per file is a possible mitigation but changes coverage.

### 6. Narrow format-on-save residual (after the fix)

- **Context:** Zed's own `format_on_save` reformatting **is handled** — the watcher
  adopts the reformatted content as the same proposal rather than re-proposing it, so a
  formatter can't cause a double proposal or (if non-idempotent) an unbounded loop, and
  reject still restores the original.
- **Trigger:** An **external** file-watcher/formatter (not Zed's `format_on_save`)
  reformats the file within ~one debounce of the watcher routing a proposal.
- **Mechanism:** The fix adopts the *first* post-routing disk observation as the
  proposal. Zed's own format-on-save is inside the awaited save, so that first
  observation is reliably Zed's result — but a separate external reformatter writing
  just after routing could be adopted instead.
- **Effect:** The adopted proposal / disk content and Zed's review entry can briefly
  diverge.
- **Severity:** Very low; requires an external reformatter racing the route within tens
  of milliseconds.
- **Fixable?** No clean signal distinguishes it from Zed's own reformat.

---

## By-design boundaries (intentional scope limits, not bugs)

### 7. Deletions and renames are never routed

- A tracked file deleted, or renamed (surfacing as `unlink` + `add`): `unlink` is a
  hard no-op — the watcher never restores or routes a deletion. For a rename the `add`
  side (new path, if tracked) may surface, but the old path is left deleted with no
  review. Deleting/renaming a tracked file via Bash bypasses Review Changes entirely.

### 8. Only files tracked *and present at session start* are watched

- The tracked set is snapshotted once at init from `git ls-files`. Files created after
  the session began (including via mid-session `git add`) or brand-new Bash-created
  files aren't in it, so watcher changes to them are ignored. (New files are still
  covered when written through the built-in `Write` tool — just not via the watcher.)

### 9. Binaries, symlinks, out-of-cwd, and `.context/` are skipped

- Text detection is content-based (skip if a NUL byte is present or the bytes aren't
  valid UTF-8); symlinks are skipped via `lstat`; scope is enforced by `isInScope`
  (outside `cwd` or under `.context/`). **Caveat:** a semantically-binary file that is
  valid UTF-8 with no NUL bytes would be treated as text.

### 10. Only `Edit`/`Write` are coordinated; other built-in file writers aren't

- The explicit-mutation handshake only marks `Edit`/`Write`. A tool like `NotebookEdit`
  writing a tracked file is handled by the watcher as if external — it still surfaces in
  Review Changes, but without tool coordination/attribution. Marking such tools *without*
  an interceptor for them would suppress them with nothing to route (worse), so this is
  left as-is.

### 11. Watcher changes carry no tool-call card

- `FileChanged` has no tool-use ID, so the fallback deliberately creates only the native
  Zed review entry — no fabricated or updated tool card, and no attribution of which
  action caused the change.

---

## External assumptions

### 12. One active ACP session per working tree

- The filesystem protocol can't disambiguate which session caused a given disk change,
  so two Zed/ACP sessions (or another adapter process) watching the same checkout can
  produce duplicate/competing proposals.

### 13. Depends on undocumented SDK watcher internals

- The SDK's debounce/coalescing and whether it suppresses its own tool writes are
  undocumented. The design is robust to arbitrary event *timing*, but not to a semantic
  change — e.g. if the SDK stopped emitting `FileChanged` for external writes, or started
  suppressing editor-driven saves, the fallback would silently stop working. Re-check
  when bumping the pinned SDK.

---

## Summary

| # | Limitation | Category | Cleanly fixable? |
|---|---|---|---|
| 1 | Open-buffer reject-baseline desync | Inference | No (Zed buffer vs disk) |
| 2 | Reject masked by racing write | Inference | No |
| 3 | Content-collision misclassification | Inference | No |
| 4 | Revert window exposes stale content | Revert approach | No |
| 5 | Startup memory ∝ tracked text size | Scale | Not cleanly (git filters) |
| 6 | External-reformatter race residual | Format-on-save | No |
| 7 | Deletions/renames not routed | By design | Intentional |
| 8 | Only start-tracked files watched | By design | Intentional |
| 9 | Binaries/symlinks/out-of-scope skipped | By design | Intentional |
| 10 | Non-Edit/Write writers uncoordinated | By design | Intentional |
| 11 | No tool-call card for watcher changes | By design | Intentional |
| 12 | Single-session-per-worktree assumption | External | No |
| 13 | Undocumented SDK watcher dependency | External | No |

The two with plausible (but non-trivial, risk-carrying) mitigations are **#1**
(open-buffer divergence) and **#5** (large-repo memory). The rest are inherent to the
no-callback inference model, the revert approach, deliberate scope, or external
constraints.
