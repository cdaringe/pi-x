import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import * as Route from "../goal-input-route.js";
import * as Task from "../task.js";

describe("GoalInputRoute", () => {
  const planning = Task.create({ prompt: "Program the device" });
  const working = Task.work(planning);
  const checking = Task.check(working);

  it("identifies where user input goes in each task phase", () => {
    const routes = [
      [planning, "goal-update"],
      [working, "implementer"],
      [checking, "implementer-checking"],
      [Task.scheduleBackoff(checking, { complete: false, feedback: "Need proof" }), "implementer-backoff"],
      [Task.retryChecker(planning, new Error("unavailable")), "goal-update"],
      [Task.retryChecker(checking, new Error("unavailable")), "implementer-retry"],
    ] as const;
    expect(routes.map(([state]) => Route.select({ state }))).toEqual(routes.map(([, recipient]) => recipient));
    expect(
      Route.select({
        evidence: {
          abort: () => undefined,
          resolve: () => undefined,
          signal: new AbortController().signal,
          userUpdateCount: 0,
        },
        state: checking,
      }),
    ).toBe("implementer-evidence");
  });

  it("pins the destination below the editor and removes it when the task stops", () => {
    const setWidget = vi.fn();
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { setWidget, theme: { fg: (_color: string, text: string) => text } },
    } as unknown as ExtensionContext;
    Route.show(ctx, "implementer-checking");
    expect(setWidget).toHaveBeenCalledWith(
      "task-input-route",
      [expect.stringContaining("You → Implementer · sending interrupts evaluator verification")],
      { placement: "belowEditor" },
    );
    Route.clear(ctx);
    expect(setWidget).toHaveBeenLastCalledWith("task-input-route", undefined);
  });
});
