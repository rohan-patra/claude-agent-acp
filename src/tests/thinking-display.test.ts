import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

// Fork-only: covers the CLAUDE_CODE_THINKING_DISPLAY override and how it composes
// with the MAX_THINKING_TOKENS-derived `thinking` config. `display` is valid on
// both adaptive and enabled thinking, so it attaches to whatever config is active
// rather than replacing it (and is ignored when thinking is disabled).
let capturedOptions: Options | undefined;
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Options }) => {
      capturedOptions = args.options;
      return {
        initializationResult: async () => ({
          models: [
            { value: "claude-sonnet-4-6", displayName: "Claude Sonnet", description: "Fast" },
          ],
        }),
        setModel: async () => {},
        setPermissionMode: async () => {},
        applyFlagSettings: async () => {},
        supportedCommands: async () => [],
        [Symbol.asyncIterator]: async function* () {},
      };
    },
  };
});

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return { ...actual, registerHookCallback: vi.fn() };
});

describe("CLAUDE_CODE_THINKING_DISPLAY composition", () => {
  let agent: ClaudeAcpAgentType;
  let originalDisplay: string | undefined;
  let originalMaxThinking: string | undefined;

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  beforeEach(async () => {
    capturedOptions = undefined;
    originalDisplay = process.env.CLAUDE_CODE_THINKING_DISPLAY;
    originalMaxThinking = process.env.MAX_THINKING_TOKENS;
    delete process.env.MAX_THINKING_TOKENS;
    vi.resetModules();
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    agent = new ClaudeAcpAgent(createMockClient());
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    };
    restore("CLAUDE_CODE_THINKING_DISPLAY", originalDisplay);
    restore("MAX_THINKING_TOKENS", originalMaxThinking);
  });

  it("uses adaptive+display when only the display var is set", async () => {
    process.env.CLAUDE_CODE_THINKING_DISPLAY = "summarized";
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(capturedOptions!.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("composes the display onto a MAX_THINKING_TOKENS budget", async () => {
    process.env.CLAUDE_CODE_THINKING_DISPLAY = "omitted";
    process.env.MAX_THINKING_TOKENS = "12000";
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(capturedOptions!.thinking).toEqual({
      type: "enabled",
      budgetTokens: 12000,
      display: "omitted",
    });
  });

  it("leaves thinking disabled (no display) when MAX_THINKING_TOKENS=0", async () => {
    process.env.CLAUDE_CODE_THINKING_DISPLAY = "summarized";
    process.env.MAX_THINKING_TOKENS = "0";
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(capturedOptions!.thinking).toEqual({ type: "disabled" });
  });

  it("leaves thinking unset when neither var is set", async () => {
    delete process.env.CLAUDE_CODE_THINKING_DISPLAY;
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(capturedOptions!.thinking).toBeUndefined();
  });
});
