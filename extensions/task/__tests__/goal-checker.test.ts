import { Result } from "@praha/byethrow";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as GoalChecker from "../goal-checker.js";

describe("GoalChecker", () => {
  it("runs an isolated checker process for planning and evaluation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-checker-fixture-"));
    const fixture = join(directory, "checker.mjs");
    await writeFile(
      fixture,
      `import { writeFile } from "node:fs/promises";
const request = process.argv.at(-1) ?? "";
const match = request.match(/Checklist file: ("[^\\n]+")/);
if (!match) process.exit(2);
const checklist = JSON.parse(match[1]);
const planning = request.includes("Create the independent acceptance checklist");
if (planning) await writeFile(checklist, "# Checklist\\n- [ ] Run the integration test\\n  - Verify: npm test\\n");
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: planning ? "Planning…" : "Checking…" } }));
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }));
const text = planning
  ? '{"ready":true}'
  : '{"complete":false,"feedback":"The integration test has not passed."}';
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
`,
      "utf8",
    );

    const updates: Array<{ phase: string; type: string; text: string }> = [];
    const created = await GoalChecker.create({
      cwd: directory,
      invocation: { args: [fixture], command: process.execPath },
      launchArgs: [],
      model: { id: "model", provider: "test" },
      onUpdate: (update) => updates.push(update),
      projectTrusted: false,
      prompt: "Implement the feature",
    });
    if (Result.isFailure(created)) throw created.error;
    const checker = created.value;
    try {
      expect(await readFile(checker.systemPromptPath, "utf8")).toContain(
        "Never mark a criterion complete solely because the implementer says it is complete",
      );
      expect(await GoalChecker.initialize(checker, new AbortController().signal)).toEqual(Result.succeed(undefined));
      await expect(GoalChecker.evaluate(checker, new AbortController().signal)).resolves.toEqual(
        Result.succeed({
          complete: false,
          feedback: "The integration test has not passed.",
        }),
      );
      expect(updates).toEqual(
        expect.arrayContaining([
          { phase: "planning", text: "Planning…", type: "text" },
          { phase: "planning", text: "$ npm test", type: "tool" },
          expect.objectContaining({ phase: "planning", type: "checklist" }),
          { phase: "evaluation", text: "Checking…", type: "text" },
          { phase: "evaluation", text: "$ npm test", type: "tool" },
        ]),
      );
    } finally {
      await GoalChecker.dispose(checker);
      await rm(directory, { force: true, recursive: true });
    }
  });
  it("returns an implementer reply to the same checker process and run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-evidence-fixture-"));
    const fixture = join(directory, "checker.mjs");
    await writeFile(
      fixture,
      `import { writeFile } from "node:fs/promises";
const request = process.argv.at(-1) ?? "";
const path = JSON.parse(request.match(/Checklist file: ("[^\\n]+")/)[1]);
if (request.includes("Create the independent acceptance checklist")) {
  await writeFile(path, "# Checklist\\n- [ ] Verify the implementation with a direct command\\n");
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "{\\"ready\\":true}", stopReason: "stop" } }));
  console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
} else {
  process.send({ type: "task_evidence_request", id: "one", criterion: "Run test", question: "Which command?", attempted: "Looked for test scripts" });
  process.on("message", (answer) => {
    if (answer.type !== "task_evidence_response" || answer.id !== "one") return;
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: JSON.stringify({ complete: false, feedback: answer.answer }), stopReason: "stop" } }));
    console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
    process.exit(0);
  });
}
`,
    );
    const requests: string[] = [];
    const created = await GoalChecker.create({
      cwd: directory,
      invocation: { args: [fixture], command: process.execPath },
      model: { id: "model", provider: "test" },
      projectTrusted: false,
      prompt: "Verify the feature",
      requestEvidence: async (request) => {
        requests.push(request.question);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return "npm test -- --run feature";
      },
      timeoutMs: 1000,
    });
    if (Result.isFailure(created)) throw created.error;
    try {
      expect(await GoalChecker.initialize(created.value, new AbortController().signal)).toEqual(
        Result.succeed(undefined),
      );
      expect(await GoalChecker.evaluate(created.value, new AbortController().signal)).toEqual(
        Result.succeed({
          complete: false,
          feedback: "npm test -- --run feature",
        }),
      );
      expect(requests).toEqual(["Which command?"]);
    } finally {
      await GoalChecker.dispose(created.value);
      await rm(directory, { force: true, recursive: true });
    }
  });
  it("rejects malformed Pi JSONL even when a valid final message follows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-checker-jsonl-"));
    const fixture = join(directory, "checker.mjs");
    await writeFile(
      fixture,
      `import { writeFile } from "node:fs/promises";
const request = process.argv.at(-1) ?? "";
const path = JSON.parse(request.match(/Checklist file: ("[^\\n]+")/)[1]);
await writeFile(path, "# Checklist\\n- [ ] Verify with a command\\n");
process.stdout.write("not-json\\n");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: '{"ready":true}', stopReason: "stop" } }));
console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
`,
    );
    const created = await GoalChecker.create({
      cwd: directory,
      invocation: { args: [fixture], command: process.execPath },
      model: { id: "model", provider: "test" },
      projectTrusted: false,
      prompt: "Verify the feature",
    });
    if (Result.isFailure(created)) throw created.error;
    try {
      const initialized = await GoalChecker.initialize(created.value, new AbortController().signal);
      expect(Result.isFailure(initialized)).toBe(true);
      if (Result.isFailure(initialized)) expect(initialized.error.message).toContain("not-json");
    } finally {
      await GoalChecker.dispose(created.value);
      await rm(directory, { force: true, recursive: true });
    }
  });
  it("times out when a descendant holds the checker output pipe open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-checker-pipe-"));
    const fixture = join(directory, "checker.mjs");
    const pidPath = join(directory, "linger.pid");
    await writeFile(
      fixture,
      `import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const linger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
linger.unref();
await writeFile(process.argv[2], String(linger.pid));
process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ready" } }) + "\\n", () => process.exit(0));
`,
    );
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const created = await GoalChecker.create({
      cwd: directory,
      invocation: { args: [fixture, pidPath], command: process.execPath },
      model: { id: "model", provider: "test" },
      onUpdate: (update) => {
        if (update.type === "text" && update.text === "ready") markReady();
      },
      projectTrusted: false,
      prompt: "Check the goal",
      terminationGraceMs: 30,
      timeoutMs: 1000,
    });
    if (Result.isFailure(created)) throw created.error;
    const checker = created.value;
    try {
      const checking = GoalChecker.initialize(checker, new AbortController().signal);
      await ready;
      const result = await checking;
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.error.message).toContain("timed out");
    } finally {
      const pid = Number(await readFile(pidPath, "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Process already exited. */
      }
      await GoalChecker.dispose(checker);
      await rm(directory, { force: true, recursive: true });
    }
  });
});
