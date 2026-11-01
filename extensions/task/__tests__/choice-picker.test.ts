import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import * as ChoicePicker from "../choice-picker.js";

function createHarness(choices: string[], rows: number) {
  const controller = new AbortController();
  const terminal = { rows };
  const tui = { requestRender: vi.fn(), terminal };
  const theme = { fg: (_color: string, text: string) => text };
  let component:
    | {
        render: (width: number) => string[];
        handleInput: (data: string) => void;
        dispose?: () => void;
      }
    | undefined;
  const custom = vi.fn(
    (factory: (...args: any[]) => typeof component) =>
      new Promise<string | undefined>((resolve) => {
        component = factory(tui, theme, getKeybindings(), resolve);
      }),
  );
  const ctx = { mode: "tui", ui: { custom } } as unknown as ExtensionContext;
  const picked = ChoicePicker.choose({
    choices,
    ctx,
    searchPlaceholder: "provider/model",
    searchTitle: "Search model IDs",
    signal: controller.signal,
    title: "Select implementer model",
  });
  return { component: () => component!, controller, custom, picked, terminal, tui };
}

describe("ChoicePicker", () => {
  const choices = Array.from({ length: 30 }, (_, index) => `test/model${index + 1}`);

  it("fits the terminal, resizes, and scrolls through the catalog with Page Down", async () => {
    const harness = createHarness(choices, 24);
    const component = harness.component();
    const initial = component.render(80);
    expect(initial.filter((line) => line.includes("test/model"))).toHaveLength(17);
    expect(initial.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(component.render(12).every((line) => visibleWidth(line) <= 12)).toBe(true);

    harness.terminal.rows = 12;
    expect(component.render(80).filter((line) => line.includes("test/model"))).toHaveLength(5);
    harness.terminal.rows = 30;
    expect(component.render(80).filter((line) => line.includes("test/model"))).toHaveLength(23);

    harness.terminal.rows = 24;
    component.render(80);
    component.handleInput("\u001b[6~");
    expect(component.render(80).join("\n")).toContain("test/model18");
    component.handleInput("\r");
    expect(await harness.picked).toBe("test/model18");
    component.dispose?.();
  });

  it("filters as the user types and selects a distant match", async () => {
    const harness = createHarness(choices, 24);
    const component = harness.component();
    component.handleInput("2");
    component.handleInput("9");
    expect(component.render(80).join("\n")).toContain("test/model29");
    expect(component.render(80).join("\n")).not.toContain("test/model28");
    component.handleInput("\r");
    expect(await harness.picked).toBe("test/model29");
    component.dispose?.();
  });

  it("closes when model selection is aborted", async () => {
    const harness = createHarness(choices, 24);
    harness.controller.abort();
    expect(await harness.picked).toBeUndefined();
    harness.component().dispose?.();
  });
});
