import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";

export type ContextDisplayView = "percent" | "numeric" | "until_compact";

export interface ContextDisplayState {
  /** totalTokens from the latest result; null before any turn has completed. */
  used: number | null;
  /** rawMaxTokens — the model's hard context window (e.g. 200_000, 1_000_000). */
  rawMax: number;
  /** SDK's `maxTokens` — the effective capacity before auto-compact fires.
   *  Null when auto-compact is disabled, the SDK call hasn't completed yet, or
   *  the model just changed and we haven't re-fetched. */
  effectiveMax: number | null;
}

export function buildContextDisplayOption(
  view: ContextDisplayView,
  state: ContextDisplayState,
): SessionConfigOption {
  const options: SessionConfigSelectOption[] = [
    {
      value: "percent",
      name: formatPercent(state),
      description: "Percentage of context window used",
    },
    {
      value: "numeric",
      name: formatNumeric(state),
      description: "Tokens used / context window size",
    },
    {
      value: "until_compact",
      name: formatUntilCompact(state),
      description: "Tokens remaining before auto-compaction triggers",
    },
  ];

  return {
    id: "context_display",
    name: "Context",
    description: "How context usage is shown",
    category: "model",
    type: "select",
    currentValue: view,
    options,
  };
}

export function formatPercent(state: ContextDisplayState): string {
  if (state.used === null || state.rawMax <= 0) return "-%";
  const pct = Math.round((state.used / state.rawMax) * 100);
  return `${pct}%`;
}

export function formatNumeric(state: ContextDisplayState): string {
  const maxLabel = state.rawMax > 0 ? formatTokens(state.rawMax) : "-";
  if (state.used === null) return `-/${maxLabel}`;
  return `${formatTokens(state.used)}/${maxLabel}`;
}

export function formatUntilCompact(state: ContextDisplayState): string {
  if (state.used === null || state.effectiveMax === null) return "-";
  const remaining = state.effectiveMax - state.used;
  if (remaining <= 0) return "at compact";
  return `${formatTokens(remaining)} to compact`;
}

/** Abbreviate a non-negative token count using k/M suffixes.
 *
 *  - `n < 1_000`           → raw integer ("347").
 *  - `1_000 ≤ n < 10_000`  → one decimal with trailing `.0` stripped ("1.3k", "9.9k").
 *  - `10_000 ≤ n < 1M`     → integer k ("112k"); promotes to the M bracket if it
 *                            would round to 1_000k (e.g. `999_999 → "1M"`).
 *  - `n ≥ 1_000_000`       → up to 2 decimals, trailing zeros trimmed ("1M", "1.2M", "1.23M").
 *
 *  Negatives and non-finite values clamp to 0. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;

  if (n < 1_000) return Math.floor(n).toString();

  if (n < 10_000) {
    const s = (n / 1_000).toFixed(1);
    return (s.endsWith(".0") ? s.slice(0, -2) : s) + "k";
  }

  if (n < 1_000_000) {
    const k = Math.round(n / 1_000);
    if (k < 1_000) return `${k}k`;
    // Fall through to M bracket so we never emit "1000k".
  }

  const m = (n / 1_000_000).toFixed(2);
  const trimmed = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
  return `${trimmed}M`;
}
