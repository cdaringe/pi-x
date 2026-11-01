import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vitest";
import * as GoalRunOutput from "../goal-run-output.js";

describe("GoalRunOutput", () => {
  it("uses the final assistant message after tools and automatic recovery settle", () => {
    const output = [
      { message: { content: "temporary", role: "assistant", stopReason: "toolUse" }, type: "message_end" },
      { message: { content: "failed", role: "assistant", stopReason: "error" }, type: "message_end" },
      {
        message: {
          content: [
            { text: "check", type: "thinking" },
            { text: '{"complete":', type: "text" },
            { text: 'true,"feedback":"verified"}', type: "text" },
          ],
          role: "assistant",
          stopReason: "stop",
        },
        type: "message_end",
      },
      { aborted: false, type: "agent_settled" },
    ].reduce(GoalRunOutput.accept, GoalRunOutput.create());
    expect(GoalRunOutput.finish(output)).toEqual(Result.succeed('{"complete":true,"feedback":"verified"}'));
  });

  it.each([
    [{ message: { content: "{}", role: "assistant", stopReason: "stop" }, type: "message_end" }],
    [
      { message: { content: "{}", role: "assistant", stopReason: "length" }, type: "message_end" },
      { aborted: false, type: "agent_settled" },
    ],
    [
      { message: { content: "{}", role: "assistant", stopReason: "stop" }, type: "message_end" },
      { aborted: true, type: "agent_settled" },
    ],
  ])("rejects an unsettled, truncated, or aborted run", (...events) => {
    const output = events.reduce(GoalRunOutput.accept, GoalRunOutput.create());
    expect(Result.isFailure(GoalRunOutput.finish(output))).toBe(true);
  });
});
