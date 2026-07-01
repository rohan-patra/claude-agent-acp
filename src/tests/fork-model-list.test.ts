import { describe, it, expect } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { buildForkModelList } from "../acp-agent.js";

// Mirrors the live SDK's curated 4-model response (see the probe in CLAUDE.md's
// "All Available Models" section): only default/sonnet/sonnet[1m]/haiku.
const SDK_MODELS: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 4.8 with 1M context · Most capable for complex work",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Sonnet 4.6 · Best for everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet[1m]",
    displayName: "Sonnet (1M context)",
    description: "Sonnet 4.6 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  { value: "haiku", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
];

describe("buildForkModelList", () => {
  it("surfaces the full Claude Code picker in order, replacing the SDK's 4-model list", () => {
    const models = buildForkModelList(SDK_MODELS);
    expect(models.map((m) => [m.value, m.displayName])).toEqual([
      ["fable", "Fable 5"],
      ["opus[1m]", "Opus 4.8 1M"],
      ["opus", "Opus 4.8"],
      ["claude-opus-4-7[1m]", "Opus 4.7 1M"],
      ["claude-opus-4-7", "Opus 4.7"],
      ["claude-opus-4-6[1m]", "Opus 4.6 1M"],
      ["sonnet", "Sonnet 4.6"],
      ["haiku", "Haiku 4.5"],
    ]);
  });

  it("donates Opus capability flags from the SDK `default` template to every Opus entry", () => {
    const models = buildForkModelList(SDK_MODELS);
    for (const value of [
      "opus[1m]",
      "opus",
      "claude-opus-4-7[1m]",
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
    ]) {
      const m = models.find((x) => x.value === value)!;
      expect(m.supportsEffort).toBe(true);
      expect(m.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(m.supportsFastMode).toBe(true);
      expect(m.supportsAutoMode).toBe(true);
      expect(m.supportsAdaptiveThinking).toBe(true);
    }
  });

  it("donates Sonnet/Haiku capability flags from their SDK templates", () => {
    const models = buildForkModelList(SDK_MODELS);
    const sonnet = models.find((m) => m.value === "sonnet")!;
    expect(sonnet.supportedEffortLevels).toEqual(["low", "medium", "high", "max"]);
    expect(sonnet.supportsFastMode).toBeUndefined();
    expect(sonnet.supportsAutoMode).toBe(true);

    const haiku = models.find((m) => m.value === "haiku")!;
    expect(haiku.supportsEffort).toBeUndefined();
    expect(haiku.supportsFastMode).toBeUndefined();
    expect(haiku.supportsAutoMode).toBeUndefined();
  });

  it("falls back to baked capability flags when the SDK omits a family", () => {
    // Only Sonnet present — Opus and Haiku must still resolve via fallbacks.
    const models = buildForkModelList([SDK_MODELS[1]]);
    const opus = models.find((m) => m.value === "opus[1m]")!;
    expect(opus.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(opus.supportsFastMode).toBe(true);

    const haiku = models.find((m) => m.value === "haiku")!;
    expect(haiku.supportsEffort).toBeUndefined();
  });

  it("uses an Opus-shaped fallback when even `default` is absent but an opus entry exists", () => {
    const opusOnly: ModelInfo[] = [
      {
        value: "claude-opus-4-8",
        displayName: "Opus",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
        supportsFastMode: true,
      },
    ];
    const models = buildForkModelList(opusOnly);
    const opus = models.find((m) => m.value === "opus")!;
    // Picked up the opus-matching template, not the baked fallback.
    expect(opus.supportedEffortLevels).toEqual(["low", "high"]);
  });
});
