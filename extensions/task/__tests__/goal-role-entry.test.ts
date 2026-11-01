import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import * as GoalRoleEntry from "../goal-role-entry.js";

describe("GoalRoleEntry.render", () => {
  const theme = { fg: (_color: string, text: string) => text };

  it("brackets implementer work and identifies the main transcript", () => {
    const start = GoalRoleEntry.render({ edge: "start", kind: "work" }, 80, theme);
    const end = GoalRoleEntry.render({ edge: "end", kind: "work" }, 80, theme);
    expect(start[0]).toContain("IMPLEMENTER · WORK · PI TRANSCRIPT");
    expect(end[0]).toContain("╰─ IMPLEMENTER");
    expect(GoalRoleEntry.render({ edge: "start", kind: "evidence" }, 80, theme)[0]).toContain("EVIDENCE REPLY");
    expect(
      GoalRoleEntry.render({ edge: "start", kind: "work" }, 12, theme).every((line) => visibleWidth(line) <= 12),
    ).toBe(true);
  });
});
