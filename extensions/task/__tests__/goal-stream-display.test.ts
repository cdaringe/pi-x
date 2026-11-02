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

  it("keeps streamed activity and the resulting checklist in order", () => {
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
    expect(checklist.parts).toEqual([
      { text: "", type: "line" },
      { text: "→ $ npm test", type: "line" },
      { text: "Checklist:", type: "line" },
      { text: "- [x] Tests pass", type: "text" },
    ]);
  });

  it("collapses the idle evaluator and shows both roles in responsive columns during dialog", () => {
    const theme = { fg: (_color: string, text: string) => text };
    const worker = Display.focus(Display.createState(), "implementer");
    const checker = Display.applyUpdate(Display.focus(worker, "evaluator"), {
      phase: "evaluation",
      text: "Need proof",
      type: "text",
    });
    expect(Display.render({ height: 30, state: { ...checker, reveal: 7 }, theme, width: 100 })).toEqual([]);

    const dialog = Display.recordWorkerText(Display.focus(checker, "dialog"), "Answering the evidence request");
    const wide = Display.render({ height: 30, state: { ...dialog, reveal: 7 }, theme, width: 100 });
    expect(wide.join("\n")).toContain("Implementer");
    expect(wide.join("\n")).toContain("Evaluator");
    expect(wide.join("\n")).toContain("Answering the evidence request");
    expect(wide[2]).toContain("○ Evaluator");
    expect(wide.every((line) => visibleWidth(line) <= 100)).toBe(true);

    const narrow = Display.render({ height: 30, state: { ...dialog, reveal: 7 }, theme, width: 40 });
    expect(narrow[0]).toContain("Evidence exchange");
    expect(narrow[2]).toContain("Implementer");
    expect(narrow.some((line) => line.includes("○ Evaluator"))).toBe(true);
    expect(Display.render({ height: 30, state: Display.focus(dialog, "evaluator"), theme, width: 100 })).toEqual([]);
  });

  it("fills the available actor pane and scrolls its buffered tool output", () => {
    const theme = { fg: (_color: string, text: string) => text };
    const lines = Array.from({ length: 35 }, (_, index) => `result ${index}`).join("\n");
    const state = Display.applyUpdate(Display.focus(Display.createState(), "evaluator"), {
      phase: "evaluation",
      text: lines,
      type: "result",
    });
    const expanded = { ...state, checkerVisible: true, reveal: 7 };
    const latest = Display.render({ height: 26, state: expanded, theme, width: 80 });
    expect(latest.length).toBe(26);
    expect(latest.join("\n")).toContain("result 34");
    expect(latest.join("\n")).not.toContain("result 0\n");
    const older = Display.render({ height: 26, state: Display.moveScroll(expanded, 11), theme, width: 80 });
    expect(older[0]).toContain("History");
    expect(older.join("\n")).toContain("result 0");
    expect(older.join("\n")).not.toContain("result 34");
    const whileStreaming = Display.applyUpdate(Display.moveScroll(expanded, 11), {
      phase: "evaluation",
      text: "new activity",
      type: "tool",
    });
    expect(Display.render({ height: 26, state: whileStreaming, theme, width: 80 }).join("\n")).not.toContain(
      "new activity",
    );
    expect(
      Display.render({ height: 26, state: Display.moveScroll(whileStreaming, -11), theme, width: 80 }).join("\n"),
    ).toContain("new activity");
  });

  it("collapses evaluator history when implementation resumes and labels manual inspection idle", () => {
    const theme = { fg: (_color: string, text: string) => text };
    const evaluator = Display.applyUpdate(
      { ...Display.focus(Display.createState(), "evaluator"), checkerVisible: true },
      { phase: "evaluation", text: "Verified files", type: "text" },
    );
    const implementer = Display.focus(evaluator, "implementer");
    expect(implementer.checkerVisible).toBe(false);
    expect(Display.render({ height: 20, state: implementer, theme, width: 80 })).toEqual([]);

    const reopened = Display.render({
      height: 20,
      state: { ...implementer, checkerVisible: true, reveal: 7 },
      theme,
      width: 80,
    });
    expect(reopened[0]).toContain("Evaluator idle · last run");
    expect(reopened[1]).toContain("○ Evaluator");
    expect(reopened.join("\n")).toContain("Verified files");
  });

  it("replaces partial tool output with the final result in the same actor view", () => {
    const partial = Display.applyUpdate(Display.createState(), {
      id: "tool-1",
      phase: "evaluation",
      text: "  Running tests",
      type: "result",
    });
    const complete = Display.applyUpdate(partial, {
      id: "tool-1",
      phase: "evaluation",
      text: "  108 tests passed",
      type: "result",
    });
    expect(complete.parts).toEqual([
      { text: "", type: "line" },
      { id: "tool-1", text: "  108 tests passed", type: "result" },
    ]);
  });

  it("pages within the open evaluator view using its rendered height", () => {
    const ctx = { hasUI: true, mode: "tui" } as ExtensionContext;
    const display: Display.T = {
      ctx,
      state: { ...Display.createState(), checkerVisible: true },
      viewportRows: 30,
    };
    Display.scrollPage(display, "up");
    expect(display.state.scroll).toBe(27);
    Display.scrollPage(display, "down");
    expect(display.state.scroll).toBe(0);
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
    expect(setStatus).toHaveBeenCalledWith("task-roles", expect.stringContaining("Evaluator running ▸"));
    Display.toggle(display);
    expect(setWidget).toHaveBeenLastCalledWith("task-goal-stream", expect.arrayContaining(["Inspecting files"]));
    expect(setStatus).toHaveBeenCalledWith("task-roles", expect.stringContaining("/task --evaluator"));
    Display.clear(display);
  });
});
