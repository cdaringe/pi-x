import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import * as Display from "../goal-stream-display.js";

describe("GoalStreamDisplay.applyUpdate", () => {
  it("appends streamed text without mutating previous content", () => {
    const initial: Display.State = Object.freeze({
      ...Display.createState(),
      parts: Object.freeze([Object.freeze({ text: "Inspecting", type: "text" as const })]),
      phase: "planning",
    });
    const next = Display.applyUpdate(initial, {
      phase: "planning",
      text: " files",
      type: "text",
    });
    expect(initial.parts[0].text).toBe("Inspecting");
    expect(next.parts).toEqual([{ text: "Inspecting files", type: "text" }]);
  });

  it("replaces streamed activity with the checklist for the current phase", () => {
    const initial: Display.State = Display.createState();
    const activity = Display.applyUpdate(initial, {
      phase: "evaluation",
      text: "$ npm test",
      type: "tool",
    });
    const checklist = Display.applyUpdate(activity, {
      phase: "evaluation",
      text: "- [x] Tests pass",
      type: "checklist",
    });
    expect(activity.parts).toEqual([
      { text: "", type: "line" },
      { text: "→ $ npm test", type: "line" },
    ]);
    expect(checklist).toEqual({
      ...Display.createState(),
      parts: [
        { text: "Checklist:", type: "line" },
        { text: "- [x] Tests pass", type: "text" },
      ],
      phase: "evaluation",
    });
  });

  it("collapses the idle evaluator and shows both roles in responsive columns during dialog", () => {
    const theme = { fg: (_color: string, text: string) => text };
    const worker = Display.focus(Display.createState(), "implementer");
    const checker = Display.applyUpdate(Display.focus(worker, "evaluator"), {
      phase: "evaluation",
      text: "Need proof",
      type: "text",
    });
    expect(Display.render({ ...checker, reveal: 7 }, 100, theme)).toEqual([]);

    const dialog = Display.recordWorkerText(Display.focus(checker, "dialog"), "Answering the evidence request");
    const wide = Display.render({ ...dialog, reveal: 7 }, 100, theme);
    expect(wide.join("\n")).toContain("Implementer");
    expect(wide.join("\n")).toContain("Evaluator");
    expect(wide.join("\n")).toContain("Answering the evidence request");
    expect(wide[1]).toContain("○ Evaluator");
    expect(wide.every((line) => visibleWidth(line) <= 100)).toBe(true);

    const narrow = Display.render({ ...dialog, reveal: 7 }, 40, theme);
    expect(narrow[0]).toContain("Evidence exchange");
    expect(narrow[1]).toContain("Implementer");
    expect(narrow.some((line) => line.includes("○ Evaluator"))).toBe(true);
    expect(Display.render(Display.focus(dialog, "evaluator"), 100, theme)).toEqual([]);
  });

  it("keeps evaluator activity collapsed until expanded in RPC", () => {
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const ctx = {
      hasUI: true,
      mode: "rpc",
      ui: { setStatus, setWidget, theme: { fg: (_color: string, text: string) => text } },
    } as unknown as ExtensionContext;
    const display = Display.create(ctx);
    Display.update(display, { phase: "planning", text: "Inspecting files", type: "text" });
    Display.showRole(display, "evaluator");
    expect(setWidget).toHaveBeenLastCalledWith("task-goal-stream", undefined);
    expect(setStatus).toHaveBeenCalledWith("task-roles", expect.stringContaining("Evaluator ▸"));
    Display.toggle(display);
    expect(setWidget).toHaveBeenLastCalledWith("task-goal-stream", expect.arrayContaining(["Inspecting files"]));
    expect(setStatus).toHaveBeenCalledWith("task-roles", expect.stringContaining("/task --evaluator"));
    Display.clear(display);
  });
});
