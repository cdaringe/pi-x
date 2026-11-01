import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import * as Evidence from "../goal-evidence.js";

describe("GoalEvidence", () => {
  it("registers a sequential evidence tool in the checker child", () => {
    const registerTool = vi.fn();
    const on = vi.fn();
    const setActiveTools = vi.fn();
    const pi = {
      getActiveTools: () => ["read"],
      on,
      registerTool,
      setActiveTools,
    } as unknown as ExtensionAPI;
    Evidence.register(pi);
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "sequential",
        name: "request_goal_evidence",
      }),
    );
    const sessionStart = on.mock.calls.find(([name]) => name === "session_start")?.[1];
    expect(sessionStart).toBeTypeOf("function");
    sessionStart();
    expect(setActiveTools).toHaveBeenCalledWith(["read", "request_goal_evidence"]);
  });

  it("extracts the final assistant answer and caps its size", () => {
    expect(
      Evidence.extractAnswer([
        { content: [{ text: "first", type: "text" }], role: "assistant" },
        { content: "ignored", role: "toolResult" },
        { content: [{ text: "final", type: "text" }], role: "assistant" },
      ]),
    ).toBe("final");
    expect(Evidence.extractAnswer([{ content: "x".repeat(9000), role: "assistant" }])).toContain(
      "truncated to final 8000 characters",
    );
  });
});
