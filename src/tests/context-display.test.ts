import { describe, it, expect } from "vitest";
import type { SessionConfigSelectGroup, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import {
  buildContextDisplayOption,
  formatNumeric,
  formatPercent,
  formatTokens,
  formatUntilCompact,
  type ContextDisplayState,
} from "../context-display.js";

// SessionConfigSelect's options array may contain groups or flat options;
// `buildContextDisplayOption` only emits flat options.
function flatOptions(
  opts: ReadonlyArray<SessionConfigSelectOption | SessionConfigSelectGroup>,
): SessionConfigSelectOption[] {
  return opts.filter((o): o is SessionConfigSelectOption => "value" in o);
}

const emptyState: ContextDisplayState = {
  used: null,
  rawMax: 1_000_000,
  effectiveMax: null,
};

describe("formatTokens", () => {
  it("renders < 1k as raw integer", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(347)).toBe("347");
    expect(formatTokens(999)).toBe("999");
  });

  it("renders 1k-10k with one trimmed decimal", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_300)).toBe("1.3k");
    expect(formatTokens(9_876)).toBe("9.9k");
  });

  it("promotes the 9999 edge cleanly (crosses bracket on rounding)", () => {
    expect(formatTokens(9_999)).toBe("10k");
  });

  it("renders 10k-1M as integer k", () => {
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(45_678)).toBe("46k");
    expect(formatTokens(112_000)).toBe("112k");
    expect(formatTokens(128_000)).toBe("128k");
    expect(formatTokens(999_499)).toBe("999k");
  });

  it("promotes to M when k-bracket would round to 1000k", () => {
    expect(formatTokens(999_500)).toBe("1M");
    expect(formatTokens(999_999)).toBe("1M");
  });

  it("renders >= 1M with up to 2 decimals, trailing zeros stripped", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(1_230_000)).toBe("1.23M");
    expect(formatTokens(1_234_567)).toBe("1.23M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });

  it("clamps negatives and non-finite to 0", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
    expect(formatTokens(Infinity)).toBe("0");
  });
});

describe("formatPercent", () => {
  it("returns '-%' when used is null", () => {
    expect(formatPercent(emptyState)).toBe("-%");
  });

  it("returns '-%' when rawMax <= 0", () => {
    expect(formatPercent({ used: 100, rawMax: 0, effectiveMax: null })).toBe("-%");
  });

  it("rounds to nearest whole percent (no prefix)", () => {
    expect(formatPercent({ used: 45_000, rawMax: 200_000, effectiveMax: null })).toBe("23%");
    expect(formatPercent({ used: 92_345, rawMax: 200_000, effectiveMax: null })).toBe("46%");
  });

  it("does not clamp over 100%", () => {
    expect(formatPercent({ used: 250_000, rawMax: 200_000, effectiveMax: null })).toBe("125%");
  });
});

describe("formatNumeric", () => {
  it("shows '-/{rawMax}' when used is null but rawMax is known", () => {
    expect(formatNumeric(emptyState)).toBe("-/1M");
    expect(formatNumeric({ used: null, rawMax: 200_000, effectiveMax: null })).toBe("-/200k");
  });

  it("shows '-/-' when both sides are unknown", () => {
    expect(formatNumeric({ used: null, rawMax: 0, effectiveMax: null })).toBe("-/-");
  });

  it("uses k/M suffixes on both sides, no prefix", () => {
    expect(formatNumeric({ used: 347, rawMax: 1_000_000, effectiveMax: null })).toBe("347/1M");
    expect(formatNumeric({ used: 1_300, rawMax: 1_000_000, effectiveMax: null })).toBe("1.3k/1M");
    expect(formatNumeric({ used: 112_000, rawMax: 128_000, effectiveMax: null })).toBe("112k/128k");
  });
});

describe("formatUntilCompact", () => {
  it("returns '-' when effectiveMax is null", () => {
    expect(formatUntilCompact({ used: 100, rawMax: 1_000_000, effectiveMax: null })).toBe("-");
  });

  it("returns '-' when used is null", () => {
    expect(formatUntilCompact({ used: null, rawMax: 1_000_000, effectiveMax: 920_000 })).toBe("-");
  });

  it("renders remaining = effectiveMax - used, no prefix", () => {
    expect(formatUntilCompact({ used: 45_000, rawMax: 1_000_000, effectiveMax: 920_000 })).toBe(
      "875k to compact",
    );
    expect(formatUntilCompact({ used: 33_000, rawMax: 1_000_000, effectiveMax: 967_000 })).toBe(
      "934k to compact",
    );
  });

  it("shows 'at compact' when used has reached or exceeded effectiveMax", () => {
    expect(formatUntilCompact({ used: 920_000, rawMax: 1_000_000, effectiveMax: 920_000 })).toBe(
      "at compact",
    );
    expect(formatUntilCompact({ used: 950_000, rawMax: 1_000_000, effectiveMax: 920_000 })).toBe(
      "at compact",
    );
  });
});

describe("buildContextDisplayOption", () => {
  it("always emits three options", () => {
    const optNoData = buildContextDisplayOption("percent", emptyState);
    if (optNoData.type !== "select") throw new Error("expected select");
    expect(flatOptions(optNoData.options).map((o) => o.value)).toEqual([
      "percent",
      "numeric",
      "until_compact",
    ]);

    const optWithData = buildContextDisplayOption("percent", {
      used: 45_000,
      rawMax: 200_000,
      effectiveMax: 184_000,
    });
    if (optWithData.type !== "select") throw new Error("expected select");
    expect(flatOptions(optWithData.options).map((o) => o.value)).toEqual([
      "percent",
      "numeric",
      "until_compact",
    ]);
  });

  it("renders terse placeholders when there is no data (rawMax still shown in numeric)", () => {
    const opt = buildContextDisplayOption("percent", emptyState);
    if (opt.type !== "select") throw new Error("expected select");
    const byValue = Object.fromEntries(flatOptions(opt.options).map((o) => [o.value, o.name]));
    expect(byValue["percent"]).toBe("-%");
    expect(byValue["numeric"]).toBe("-/1M");
    expect(byValue["until_compact"]).toBe("-");
  });

  it("renders numeric values (no prefix) when data is present", () => {
    const opt = buildContextDisplayOption("percent", {
      used: 45_000,
      rawMax: 200_000,
      effectiveMax: 184_000,
    });
    if (opt.type !== "select") throw new Error("expected select");
    const byValue = Object.fromEntries(flatOptions(opt.options).map((o) => [o.value, o.name]));
    expect(byValue["percent"]).toBe("23%");
    expect(byValue["numeric"]).toBe("45k/200k");
    // effectiveMax - used = 184_000 - 45_000 = 139_000
    expect(byValue["until_compact"]).toBe("139k to compact");
  });

  it("preserves stored view even when data for it is missing", () => {
    // Previously we fell back to 'percent' when the selected view was
    // unavailable. Now all 3 options are always present, so the view passes
    // through untouched.
    const opt = buildContextDisplayOption("until_compact", emptyState);
    if (opt.type !== "select") throw new Error("expected select");
    expect(opt.currentValue).toBe("until_compact");
  });
});
