import { describe, expect, it } from "vitest";
import * as Task from "../task.js";

describe("Task", () => {
  it("transitions without mutating earlier states or retaining stale retry feedback", () => {
    const planning = Object.freeze(Task.create({ prompt: "fix checkout" }));
    const working = Object.freeze(Task.work(planning));
    const checking = Object.freeze(Task.check(working));
    const waiting = Object.freeze(
      Task.scheduleBackoff(checking, {
        complete: false,
        feedback: "Payment test fails.",
      }),
    );
    const resumed = Task.work(waiting);

    expect([planning, working, checking, waiting].map(Task.formatStatus)).toEqual([
      "↻ task goal planning",
      "↻ task goal 1",
      "↻ task goal checking (1)",
      "↻ task goal retrying in 1s (1)",
    ]);
    expect(resumed).toEqual({
      checkerAttempts: 0,
      phase: "working",
      prompt: "fix checkout",
      runs: 1,
    });
    expect(Task.check(resumed).runs).toBe(2);
    expect(Task.buildContinuation(waiting)).toContain("Payment test fails.");
  });

  it("bounds evaluator feedback without truncating the original goal", () => {
    const prompt = "p".repeat(9000);
    const waiting = Task.scheduleBackoff(Task.check(Task.work(Task.create({ prompt }))), {
      complete: false,
      feedback: "x".repeat(8100) + "remaining gap",
    });
    const continuation = Task.buildContinuation(waiting);
    expect(continuation.startsWith(prompt)).toBe(true);
    expect(continuation).toContain("truncated 113 chars");
    expect(continuation).toContain("remaining gap");
  });

  it("caps repeated checker failures and preserves the phase being retried", () => {
    const initial = Task.check(Task.work(Task.create({ prompt: "fix checkout" })));
    const retries = Array.from({ length: 9 }).reduce<{
      state: Task.Checking;
      delays: number[];
    }>(
      ({ state, delays }) => {
        const waiting = Task.retryChecker(state, new Error("checker exited"));
        const resumed = Task.resumeChecker(waiting);
        if (resumed.phase !== "checking") throw new Error("expected a checking retry");
        return { delays: [...delays, waiting.delayMs], state: resumed };
      },
      { delays: [], state: initial },
    );
    expect(retries.delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(retries.state.runs).toBe(1);
  });
});
