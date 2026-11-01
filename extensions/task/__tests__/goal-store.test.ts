import { Result } from "@praha/byethrow";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as GoalStore from "../goal-store.js";

describe("GoalStore", () => {
  it("offers a goal from a process that no longer exists", () => {
    const interrupted = {
      ...GoalStore.create({
        cwd: "/workspace",
        models: { checker: "test/thorough", implementer: "test/fast" },
        prompt: "Program the device",
      }),
      ownerPid: 99_999_999,
    };
    expect(GoalStore.canResume(interrupted)).toBe(true);
    expect(GoalStore.format(interrupted)).toContain("interrupted");
  });

  it("saves and retrieves a resumable goal outside the project", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-task-store-"));
    const store = GoalStore.createOperations(directory);
    const record = GoalStore.create({
      cwd: "/workspace",
      models: { checker: "test/thorough", implementer: "test/fast" },
      prompt: "Program the device",
    });
    try {
      expect(store.write(record)).toEqual(Result.succeed(undefined));
      expect(statSync(join(directory, `${record.id}.json`)).mode & 0o777).toBe(0o600);
      expect(store.list("/workspace")).toEqual(Result.succeed([record]));
      const paused = GoalStore.revise(record, { status: "paused", updates: ["Use port 2"] });
      expect(store.write(paused)).toEqual(Result.succeed(undefined));
      expect(store.list("/workspace")).toEqual(Result.succeed([paused]));
      expect(store.list("/other-workspace")).toEqual(Result.succeed([]));
      expect(store.remove(record.id)).toEqual(Result.succeed(undefined));
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
