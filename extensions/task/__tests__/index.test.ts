import { Result } from "@praha/byethrow";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import taskExtension from "../index.js";
import * as GoalChecker from "../goal-checker.js";
import * as GoalStore from "../goal-store.js";

type EventHandler = (event: any, ctx: ExtensionContext) => unknown;

function createHarness(
  options: Parameters<typeof taskExtension>[1] = {},
  models = [
    { id: "model", provider: "test" },
    { id: "fast", provider: "impl" },
    { id: "thorough", provider: "audit" },
  ],
) {
  const handlers = new Map<string, EventHandler[]>();
  const registeredTools = new Map<string, any>();
  const records = new Map<string, GoalStore.T>();
  const goalStore: GoalStore.Operations = options.goalStore ?? {
    list: vi.fn((cwd) => Result.succeed([...records.values()].filter((record) => record.cwd === cwd))),
    remove: vi.fn((id) => {
      records.delete(id);
      return Result.succeed(undefined);
    }),
    write: vi.fn((record) => {
      records.set(record.id, record);
      return Result.succeed(undefined);
    }),
  };
  let command:
    | {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    | undefined;
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();
  const select = vi.fn(async (_title: string, choices: string[]): Promise<string | undefined> => choices[0]);
  let context: ExtensionContext;
  const custom = vi.fn(async (factory: (...args: any[]) => any): Promise<string | undefined> => {
    let selected: string | undefined;
    const component = await factory(
      { requestRender: vi.fn(), terminal: { rows: 24 } },
      context.ui.theme,
      { matches: (data: string, action: string) => data === "\r" && action === "tui.select.confirm" },
      (value: string | undefined) => {
        selected = value;
      },
    );
    component.render(100);
    component.handleInput("\r");
    component.dispose?.();
    return selected;
  });
  const setModel = vi.fn(async (model: NonNullable<ExtensionContext["model"]>) => {
    context.model = model;
    return true;
  });

  const pi = {
    appendEntry,
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerCommand: (_name: string, registered: typeof command) => {
      command = registered;
    },
    registerEntryRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    registerTool: (tool: { name: string }) => registeredTools.set(tool.name, tool),
    sendUserMessage,
    setModel,
  } as unknown as ExtensionAPI;

  taskExtension(pi, { ...options, goalStore });

  const notify = vi.fn();
  const input = vi.fn(async () => "done");
  const confirm = vi.fn(async (_title: string, _message: string, _options?: { signal?: AbortSignal }) => true);
  const setStatus = vi.fn();
  const setWidget = vi.fn();
  context = {
    cwd: "/workspace",
    hasUI: true,
    isProjectTrusted: () => true,
    mode: "tui",
    model: models[0],
    modelRegistry: { getAvailable: () => models },
    scopedModels: [],
    thinkingLevel: "medium",
    ui: {
      confirm,
      custom,
      input,
      notify,
      select,
      setStatus,
      setWidget,
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, context);
    await vi.advanceTimersByTimeAsync(0);
  };

  return {
    appendEntry,
    command: (args: string) => command!.handler(args, context),
    confirm,
    context,
    custom,
    emit,
    goalStore,
    input,
    notify,
    records,
    select,
    sendUserMessage,
    setModel,
    setStatus,
    setWidget,
    tool: (name: string) => registeredTools.get(name),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function createCheckerValue(config: GoalChecker.Config): GoalChecker.T {
  return {
    checklistPath: "/scratch/checklist.md",
    config,
    directory: "/scratch",
    systemPromptPath: "/scratch/system.md",
  };
}

function createChecker(): GoalChecker.Operations {
  return {
    create: vi.fn(async (config) => Result.succeed(createCheckerValue(config))),
    dispose: vi.fn().mockResolvedValue(Result.succeed(undefined)),
    evaluate: vi.fn().mockResolvedValue(Result.succeed({ complete: false, feedback: "Tests still fail." })),
    initialize: vi.fn().mockResolvedValue(Result.succeed(undefined)),
  };
}

describe("goal task loop", () => {
  it("lists a stopped goal and resumes it in a later Pi session with fresh verification", async () => {
    const first = createHarness({ goalChecker: createChecker(), launchArgs: [] });
    await first.command('--goal "program device" -d');
    await first.emit("input", { source: "interactive", text: "Use USB port 2" });
    await first.command("--stop");
    const record = [...first.records.values()][0];
    expect(record?.status).toBe("paused");
    expect(record?.updates).toEqual(["Use USB port 2"]);
    await first.command("--list");
    expect(first.notify).toHaveBeenLastCalledWith(expect.stringContaining(record!.id.slice(0, 8)), "info");

    const checker = createChecker();
    vi.mocked(checker.evaluate).mockResolvedValue(Result.succeed({ complete: true, feedback: "Verified." }));
    const second = createHarness({ goalChecker: checker, goalStore: first.goalStore, launchArgs: [] });
    await second.command(`--resume ${record!.id.slice(0, 8)}`);
    expect(checker.initialize).toHaveBeenCalledOnce();
    expect(checker.evaluate).toHaveBeenCalledOnce();
    expect(vi.mocked(checker.create).mock.calls[0]?.[0].getUserUpdates?.()).toEqual(["Use USB port 2"]);
    expect(second.sendUserMessage).not.toHaveBeenCalled();
    expect(first.records.size).toBe(0);
  });

  it("shows a resume picker and sends the latest gaps when the goal remains incomplete", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "program device" -d');
    await harness.command("--stop");
    await harness.command("--resume");
    expect(harness.custom).toHaveBeenCalledOnce();
    expect(checker.evaluate).toHaveBeenCalledOnce();
    expect(harness.sendUserMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Tests still fail."));
    await harness.command("--stop");
  });

  it("reselects models when a saved model is no longer available", async () => {
    const harness = createHarness({ goalChecker: createChecker(), launchArgs: [] });
    const record = GoalStore.revise(
      GoalStore.create({
        cwd: "/workspace",
        models: { checker: "gone/model", implementer: "gone/model" },
        prompt: "program device",
      }),
      { status: "paused" },
    );
    harness.goalStore.write(record);
    await harness.command(`--resume ${record.id.slice(0, 8)}`);
    expect(harness.custom).toHaveBeenCalledTimes(2);
    expect([...harness.records.values()][0]?.models).toEqual({
      checker: "test/model",
      implementer: "test/model",
    });
    await harness.command("--stop");
  });

  it("does not resume a goal owned by a live Pi process", async () => {
    const harness = createHarness({ goalChecker: createChecker(), launchArgs: [] });
    const record = GoalStore.create({
      cwd: "/workspace",
      models: { checker: "test/model", implementer: "test/model" },
      prompt: "program device",
    });
    harness.goalStore.write(record);
    await harness.command(`--resume ${record.id.slice(0, 8)}`);
    expect(harness.notify).toHaveBeenLastCalledWith(expect.stringContaining("still running"), "warning");
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("keeps ordinary user messages in the active goal and passes them to the checker", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "program device" -d');
    await harness.emit("input", { source: "interactive", text: "The device uses USB port 2" });
    expect(checker.dispose).not.toHaveBeenCalled();
    expect(harness.sendUserMessage).toHaveBeenCalledOnce();
    const config = vi.mocked(checker.create).mock.calls[0]?.[0];
    expect(config?.getUserUpdates?.()).toEqual(["The device uses USB port 2"]);
    await harness.command("--stop");
  });

  it("lets the implementer pause for a user action", async () => {
    const harness = createHarness({ goalChecker: createChecker(), launchArgs: [] });
    await harness.command('--goal "program device" -d');
    const tool = harness.tool("task_ask_user");
    const result = await tool.execute(
      "call",
      { kind: "confirm", question: "Turn the device on, then confirm." },
      new AbortController().signal,
      undefined,
      harness.context,
    );
    expect(harness.confirm).toHaveBeenCalledWith(
      "Goal task needs your action",
      "Turn the device on, then confirm.",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.content[0].text).toContain("User confirmed");
    await harness.command("--stop");
  });

  it("returns a user's text answer to the current implementing run", async () => {
    const harness = createHarness({ goalChecker: createChecker(), launchArgs: [] });
    await harness.command('--goal "program device" -d');
    const tool = harness.tool("task_ask_user");
    const result = await tool.execute(
      "call",
      { hint: "/dev/ttyUSB0", kind: "input", question: "Which serial port is the device on?" },
      new AbortController().signal,
      undefined,
      harness.context,
    );
    expect(harness.input).toHaveBeenCalledWith(
      "Which serial port is the device on?",
      "/dev/ttyUSB0",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.content[0].text).toBe("User replied: done");
    expect([...harness.records.values()][0]?.updates).toEqual([
      "Task question: Which serial port is the device on?\nUser replied: done",
    ]);
    await harness.command("--stop");
  });

  it("cancels a pending user dialog when the goal stops", async () => {
    const harness = createHarness({ goalChecker: createChecker(), launchArgs: [] });
    await harness.command('--goal "program device" -d');
    harness.confirm.mockImplementationOnce(
      async (_title, _message, options) =>
        new Promise<boolean>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(false), { once: true }),
        ),
    );
    const pending = harness
      .tool("task_ask_user")
      .execute(
        "power",
        { kind: "confirm", question: "Turn on the device, then confirm." },
        new AbortController().signal,
        undefined,
        harness.context,
      );
    await harness.command("--stop");
    const result = await pending;
    expect(result.content[0].text).toContain("stopped while waiting");
  });

  it("invalidates a checker result when the user adds information during verification", async () => {
    const checker = createChecker();
    let finish!: (value: Result.Result<{ complete: true; feedback: string }, Error>) => void;
    vi.mocked(checker.evaluate)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(Result.succeed({ complete: true, feedback: "Verified new goal" }));
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "program device" -d');
    await harness.emit("agent_settled", { aborted: false });
    const signal = vi.mocked(checker.evaluate).mock.calls[0]?.[1];
    await harness.emit("input", { source: "interactive", text: "Use firmware version 3" });
    expect(signal?.aborted).toBe(true);
    finish(Result.succeed({ complete: true, feedback: "Old result" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(checker.dispose).not.toHaveBeenCalled();
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).toHaveBeenCalledTimes(2);
    expect(checker.dispose).toHaveBeenCalledOnce();
  });

  it("queues updates during planning and replans before implementation starts", async () => {
    const checker = createChecker();
    let finish!: () => void;
    vi.mocked(checker.initialize)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return Result.succeed(undefined);
      })
      .mockResolvedValueOnce(Result.succeed(undefined));
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    const starting = harness.command('--goal "program device" -d');
    await vi.advanceTimersByTimeAsync(0);
    await harness.emit("input", { source: "interactive", text: "Use firmware version 3" });
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    finish();
    await starting;
    expect(checker.initialize).toHaveBeenCalledTimes(2);
    expect(harness.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("User update: Use firmware version 3"),
    );
    await harness.command("--stop");
  });

  it("delivers images received during planning to the first implementing turn", async () => {
    const checker = createChecker();
    let finish!: () => void;
    vi.mocked(checker.initialize).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return Result.succeed(undefined);
    });
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    const starting = harness.command('--goal "program device" -d');
    await vi.advanceTimersByTimeAsync(0);
    const image = { data: "encoded-image", mimeType: "image/png", type: "image" };
    await harness.emit("input", { images: [image], source: "interactive", text: "This is the wiring" });
    finish();
    await starting;
    expect(harness.sendUserMessage).toHaveBeenCalledWith([
      expect.objectContaining({ text: expect.stringContaining("This is the wiring"), type: "text" }),
      image,
    ]);
    await harness.command("--stop");
  });

  it("cancels backoff when the user steers the goal", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "program device" -d');
    await harness.emit("agent_settled", { aborted: false });
    await harness.emit("input", { source: "interactive", text: "Use USB port 2" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sendUserMessage).toHaveBeenCalledOnce();
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).toHaveBeenCalledTimes(2);
    await harness.command("--stop");
  });

  it("passes a new user update through a blocked evidence dialog", async () => {
    const checker = createChecker();
    let received = "";
    vi.mocked(checker.evaluate).mockImplementation(async (value, signal) => {
      received = await value.config.requestEvidence!(
        {
          attempted: "Checked device status",
          criterion: "Device ready",
          id: "one",
          question: "Is it powered on?",
          type: "task_evidence_request",
        },
        signal,
      );
      return Result.succeed({ complete: false, feedback: "Need direct proof" });
    });
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "program device" -d');
    await harness.emit("agent_settled", { aborted: false });
    const widget = harness.setWidget.mock.calls[0]?.[1]({ requestRender: vi.fn() }, harness.context.ui.theme);
    expect(harness.setStatus).toHaveBeenCalledWith("task-roles", expect.stringContaining("Implementer answering"));
    expect(widget.render(100)[0]).toContain("Evidence exchange");
    expect(widget.render(100)[1]).toContain("Implementer");
    expect(widget.render(100)[1]).toContain("Evaluator");
    await harness.emit("message_update", {
      assistantMessageEvent: { delta: "Checking the device", type: "text_delta" },
    });
    await vi.advanceTimersByTimeAsync(840);
    expect(widget.render(100).join("\n")).toContain("Checking the device");
    await harness.emit("input", { source: "interactive", text: "I turned it on" });
    await harness.emit("agent_end", { messages: [{ content: "The device is now on", role: "assistant" }] });
    await harness.emit("agent_settled", { aborted: false });
    expect(received).toContain("The device is now on");
    expect(received).toContain("Authoritative user update during this dialog: I turned it on");
    expect(checker.evaluate).toHaveBeenCalledOnce();
    await harness.command("--stop");
  });

  it("lets the verifier request a user action through the implementer without restarting its check", async () => {
    const checker = createChecker();
    let received = "";
    vi.mocked(checker.evaluate).mockImplementation(async (value, signal) => {
      received = await value.config.requestEvidence!(
        {
          attempted: "Queried the device and got no response",
          criterion: "Device powered on",
          id: "power",
          question: "Is the device on?",
          type: "task_evidence_request",
        },
        signal,
      );
      return Result.succeed({ complete: false, feedback: "Need a fresh device query" });
    });
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "program device" -d');
    await harness.emit("agent_settled", { aborted: false });
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("Is the device on?"));
    const answer = await harness
      .tool("task_ask_user")
      .execute(
        "power",
        { kind: "confirm", question: "Turn on the device, then confirm." },
        new AbortController().signal,
        undefined,
        harness.context,
      );
    await harness.emit("agent_end", { messages: [{ content: answer.content, role: "assistant" }] });
    await harness.emit("agent_settled", { aborted: false });
    expect(received).toContain("User confirmed: Turn on the device, then confirm.");
    expect(checker.evaluate).toHaveBeenCalledOnce();
    await harness.command("--stop");
  });

  it("relays up to five evidence dialogs within the current checker evaluation", async () => {
    const checker = createChecker();
    const answers: string[] = [];
    vi.mocked(checker.evaluate).mockImplementation(async (value, signal) => {
      for (const index of Array.from({ length: 6 }, (_, number) => number)) {
        answers.push(
          await value.config.requestEvidence!(
            {
              attempted: "Inspected the workspace",
              criterion: `Criterion ${index + 1}`,
              id: String(index),
              question: `Where is evidence ${index + 1}?`,
              type: "task_evidence_request",
            },
            signal,
          ),
        );
      }
      return Result.succeed({ complete: false, feedback: "Still unverified" });
    });
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests" -d');
    await harness.emit("agent_settled", { aborted: false });
    for (const index of Array.from({ length: 5 }, (_, number) => number)) {
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.sendUserMessage).toHaveBeenCalledTimes(index + 2);
      expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
        expect.stringContaining(`Where is evidence ${index + 1}?`),
      );
      await harness.emit("agent_end", {
        messages: [
          {
            content: [{ text: `src/file${index}.ts`, type: "text" }],
            role: "assistant",
          },
        ],
      });
      await harness.emit("agent_settled", { aborted: false });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(checker.evaluate).toHaveBeenCalledOnce();
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(6);
    expect(answers.slice(0, 5)).toEqual(Array.from({ length: 5 }, (_, index) => `src/file${index}.ts`));
    expect(answers[5]).toContain("5-request evidence dialog limit");
    await harness.emit("session_shutdown");
  });

  it("cancels a blocked evidence dialog without starting another run", async () => {
    const checker = createChecker();
    vi.mocked(checker.evaluate).mockImplementation(async (value, signal) => {
      const answer = await value.config.requestEvidence!(
        {
          attempted: "Inspected test directories",
          criterion: "Run tests",
          id: "one",
          question: "Where is the test?",
          type: "task_evidence_request",
        },
        signal,
      );
      return Result.succeed({ complete: false, feedback: answer });
    });
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests" -d');
    await harness.emit("agent_settled", { aborted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
    await harness.command("--stop");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checker.evaluate).toHaveBeenCalledOnce();
    expect(checker.dispose).toHaveBeenCalledOnce();
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("uses separate checker and implementer models, then restores the session model", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests" --implementer-model impl/fast --checker-model audit/thorough');
    expect(harness.select).not.toHaveBeenCalled();
    expect(checker.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "thorough", provider: "audit" },
      }),
    );
    expect(harness.setModel).toHaveBeenCalledWith({
      id: "fast",
      provider: "impl",
    });
    expect(harness.sendUserMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("fix tests"));
    await harness.command("--stop");
    expect(harness.setModel).toHaveBeenLastCalledWith({
      id: "model",
      provider: "test",
    });
  });

  it("restores the prior model after independent verification completes", async () => {
    const checker = createChecker();
    vi.mocked(checker.evaluate).mockResolvedValueOnce(Result.succeed({ complete: true, feedback: "Verified." }));
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests" --implementer-model impl/fast --checker-model audit/thorough');
    await harness.emit("agent_settled", { aborted: false });
    expect(harness.setModel.mock.calls.map(([model]) => model.id)).toEqual(["fast", "model"]);
  });

  it("does not send work when switching to the implementer model fails", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    harness.setModel.mockResolvedValueOnce(false);
    await harness.command('--goal "fix tests" --implementer-model impl/fast -d');
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(checker.dispose).toHaveBeenCalledOnce();
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Task goal: could not switch to implementer model impl/fast",
      "error",
    );
  });

  it("waits for the prior model to be restored before starting another task", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "first" --implementer-model impl/fast -d');
    let finishRestore: (() => void) | undefined;
    harness.setModel.mockImplementationOnce(async (model: NonNullable<ExtensionContext["model"]>) => {
      await new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      harness.context.model = model;
      return true;
    });
    const stopping = harness.command("--stop");
    await vi.advanceTimersByTimeAsync(0);
    const starting = harness.command('--goal "second" -d');
    expect(checker.create).toHaveBeenCalledTimes(1);
    finishRestore?.();
    await stopping;
    await starting;
    expect(checker.create).toHaveBeenCalledTimes(2);
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("second"));
    await harness.emit("session_shutdown");
  });

  it("asks for both omitted models in interactive mode", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    harness.context.mode = "rpc";
    harness.select.mockResolvedValueOnce("impl/fast").mockResolvedValueOnce("audit/thorough");
    await harness.command('--goal "fix tests"');
    expect(harness.select).toHaveBeenCalledTimes(2);
    expect(harness.select).toHaveBeenNthCalledWith(
      1,
      "Select implementer model (default: test/model)",
      ["test/model", "impl/fast", "audit/thorough"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.select).toHaveBeenNthCalledWith(
      2,
      "Select checker model (default: impl/fast)",
      ["impl/fast", "test/model", "audit/thorough"],
      expect.anything(),
    );
    expect(checker.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "thorough", provider: "audit" },
      }),
    );
    await harness.emit("session_shutdown");
  });

  it("passes the full model catalog to an RPC selector", async () => {
    const models = [
      { id: "base", provider: "test" },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `model${index + 1}`, provider: "test" })),
    ];
    const harness = createHarness({ goalChecker: createChecker(), launchArgs: [] }, models);
    harness.context.mode = "rpc";
    harness.select.mockResolvedValueOnce("test/model7");
    await harness.command('--goal "fix tests" --checker-model test/base');
    expect(harness.select).toHaveBeenCalledOnce();
    expect(harness.select.mock.calls[0]?.[1]).toHaveLength(13);
    expect(harness.select.mock.calls[0]?.[1]).toContain("test/model7");
    expect(harness.setModel).toHaveBeenCalledWith({ id: "model7", provider: "test" });
    await harness.command("--stop");
  });

  it("lets an RPC client choose a distant model directly", async () => {
    const models = [
      { id: "base", provider: "test" },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `model${index + 1}`, provider: "test" })),
    ];
    const harness = createHarness({ goalChecker: createChecker(), launchArgs: [] }, models);
    harness.context.mode = "rpc";
    harness.select.mockResolvedValueOnce("test/model12");
    await harness.command('--goal "fix tests" --checker-model test/base');
    expect(harness.input).not.toHaveBeenCalled();
    expect(harness.select).toHaveBeenCalledOnce();
    expect(harness.setModel).toHaveBeenCalledWith({ id: "model12", provider: "test" });
    await harness.command("--stop");
  });

  it("uses the chosen implementer for omitted checker model with -d", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests" --implementer-model impl/fast -d');
    expect(harness.select).not.toHaveBeenCalled();
    expect(checker.create).toHaveBeenCalledWith(expect.objectContaining({ model: { id: "fast", provider: "impl" } }));
    await harness.emit("session_shutdown");
  });

  it("uses the current model for both roles with -d", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests" -d');
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(checker.create).toHaveBeenCalledWith(expect.objectContaining({ model: { id: "model", provider: "test" } }));
    await harness.emit("session_shutdown");
  });

  it("does not start when model selection is cancelled", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    harness.context.mode = "rpc";
    harness.select.mockResolvedValueOnce(undefined);
    await harness.command('--goal "fix tests"');
    expect(checker.create).not.toHaveBeenCalled();
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenLastCalledWith("Task goal: model selection cancelled", "warning");
  });

  it("requires explicit model choices or -d without an interactive UI", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    harness.context.hasUI = false;
    harness.context.mode = "print";
    await harness.command('--goal "fix tests"');
    expect(checker.create).not.toHaveBeenCalled();
    expect(harness.select).not.toHaveBeenCalled();
    await harness.command('--goal "fix tests" -d');
    expect(checker.create).toHaveBeenCalledOnce();
    await harness.emit("session_shutdown");
  });

  it("accepts both explicit models without an interactive UI", async () => {
    const checker = createChecker();
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    harness.context.hasUI = false;
    harness.context.mode = "print";
    await harness.command('--goal "fix tests" --implementer-model impl/fast --checker-model audit/thorough');
    expect(harness.select).not.toHaveBeenCalled();
    expect(checker.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "thorough", provider: "audit" },
      }),
    );
    expect(harness.sendUserMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("fix tests"));
    await harness.emit("session_shutdown");
  });

  it("initializes a goal checker before starting and uses its independent decision", async () => {
    const order: string[] = [];
    let streamUpdate: ((update: any) => void) | undefined;
    const checker: GoalChecker.Operations = {
      create: vi.fn(async (config) => {
        streamUpdate = config.onUpdate;
        return Result.succeed(createCheckerValue(config));
      }),
      dispose: vi.fn(async () => {
        order.push("dispose");
        return Result.succeed(undefined);
      }),
      evaluate: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("evaluate-incomplete");
          return Result.succeed({
            complete: false,
            feedback: "The integration test still fails.",
          });
        })
        .mockImplementationOnce(async () => {
          order.push("evaluate-complete");
          return Result.succeed({
            complete: true,
            feedback: "All checks pass.",
          });
        }),
      initialize: vi.fn(async () => {
        order.push("initialize");
        streamUpdate?.({
          phase: "planning",
          text: "Inspecting the repository…",
          type: "text",
        });
        streamUpdate?.({
          phase: "planning",
          text: "# Checklist\n- [ ] Run integration tests",
          type: "checklist",
        });
        return Result.succeed(undefined);
      }),
    };
    const harness = createHarness({
      goalChecker: checker,
      launchArgs: [],
    });
    harness.sendUserMessage.mockImplementation(() => order.push("send"));

    await harness.command('--goal "implement checkout"');
    expect(order.slice(0, 2)).toEqual(["initialize", "send"]);
    expect(harness.appendEntry).toHaveBeenCalledWith("task-implementer-boundary", {
      edge: "start",
      kind: "work",
    });
    expect(harness.setWidget).toHaveBeenCalledWith("task-goal-stream", expect.any(Function));
    const widget = harness.setWidget.mock.calls[0]?.[1]({ requestRender: vi.fn() }, harness.context.ui.theme);
    expect(widget.render(120)).toEqual([]);
    expect(harness.setStatus).toHaveBeenCalledWith("task-roles", expect.stringContaining("Implementer"));
    await harness.emit("tool_execution_start", { toolName: "read" });
    expect(widget.render(120)).toEqual([]);

    await harness.command("--evaluator");
    expect(widget.render(120).join("\n")).toContain("- [ ] Run integration tests");

    await harness.emit("agent_settled", { aborted: false });
    expect(order).toContain("evaluate-incomplete");
    expect(harness.appendEntry).toHaveBeenCalledWith("task-implementer-boundary", {
      edge: "end",
      kind: "work",
    });
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("The integration test still fails."),
    );

    await harness.emit("agent_settled", { aborted: false });
    expect(order).toContain("evaluate-complete");
    expect(checker.dispose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.notify).toHaveBeenLastCalledWith("Task goal: independently verified after 2 run(s)", "info");
  });

  it("backs off exponentially up to 60 seconds and keeps continuing", async () => {
    const checker = createChecker();
    const harness = createHarness({
      goalChecker: checker,
      launchArgs: [],
    });
    await harness.command('--goal "fix tests"');

    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) {
      await harness.emit("agent_settled", { aborted: false });
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "task",
        `↻ task goal retrying in ${delay / 1000}s (${index + 1})`,
      );
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(harness.sendUserMessage).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.sendUserMessage).toHaveBeenCalledTimes(index + 2);
      expect(harness.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("Tests still fail."));
    }
    await harness.emit("session_shutdown");
  });

  it.each(["stop", "session_shutdown"])("cancels pending retries on %s", async (event) => {
    const checker = createChecker();
    const harness = createHarness({
      goalChecker: checker,
      launchArgs: [],
    });
    await harness.command('--goal "fix tests"');
    await harness.emit("agent_settled", { aborted: false });
    if (event === "stop") await harness.command("--stop");
    else await harness.emit("session_shutdown");
    await vi.advanceTimersByTimeAsync(60000);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(checker.dispose).toHaveBeenCalledOnce();
    expect([...harness.records.values()][0]?.status).toBe("paused");
  });

  it("ignores extension input and duplicate settled events during backoff", async () => {
    const checker = createChecker();
    const harness = createHarness({
      goalChecker: checker,
      launchArgs: [],
    });
    await harness.command('--goal "fix tests"');
    await harness.emit("input", { source: "extension" });
    await harness.emit("agent_settled", { aborted: false });
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
    await harness.emit("session_shutdown");
  });

  it("stops an active evaluation without scheduling a retry", async () => {
    const checker = createChecker();
    let signal: AbortSignal | undefined;
    vi.mocked(checker.evaluate).mockImplementation(async (_checker, value) => {
      signal = value;
      return await new Promise((resolve) => {
        value.addEventListener("abort", () => resolve(Result.succeed({ complete: false, feedback: "Cancelled" })), {
          once: true,
        });
      });
    });
    const harness = createHarness({
      goalChecker: checker,
      launchArgs: [],
    });
    await harness.command('--goal "fix tests"');
    const settling = harness.emit("agent_settled", { aborted: false });
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).toHaveBeenCalledOnce();
    await harness.command("--stop");
    await settling;
    await vi.advanceTimersByTimeAsync(60000);
    expect(signal?.aborted).toBe(true);
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining("Task goal: paused; resume with /task --resume "),
      "info",
    );
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not evaluate an unrelated settled event during planning", async () => {
    const checker = createChecker();
    let finish!: () => void;
    vi.mocked(checker.initialize).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return Result.succeed(undefined);
    });
    const harness = createHarness({
      goalChecker: checker,
      launchArgs: [],
    });
    const starting = harness.command('--goal "fix tests"');
    await vi.advanceTimersByTimeAsync(0);
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).not.toHaveBeenCalled();
    await harness.command("--stop");
    finish();
    await starting;
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("starts a replacement task with fresh backoff and cancels the old retry", async () => {
    const harness = createHarness({
      goalChecker: createChecker(),
      launchArgs: [],
    });
    await harness.command('--goal "old goal"');
    await harness.emit("agent_settled", { aborted: false });
    await harness.command("--stop");
    await harness.command('--goal "new goal"');
    await harness.emit("agent_settled", { aborted: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(3);
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("new goal"));
    await harness.emit("session_shutdown");
  });

  it("stops on an aborted agent run", async () => {
    const checker = createChecker();
    const harness = createHarness({
      goalChecker: checker,
      launchArgs: [],
    });
    await harness.command('--goal "fix tests"');
    await harness.emit("agent_settled", { aborted: true });
    await vi.advanceTimersByTimeAsync(60000);
    expect(checker.evaluate).not.toHaveBeenCalled();
    expect(checker.dispose).toHaveBeenCalledOnce();
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("retries failed evaluations without another implementing run", async () => {
    const checker = createChecker();
    vi.mocked(checker.evaluate)
      .mockResolvedValueOnce(Result.fail(new Error("checker exited")))
      .mockResolvedValueOnce(Result.fail(new Error("checker timed out")))
      .mockResolvedValueOnce(Result.succeed({ complete: true, feedback: "Verified." }));
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests"');
    await harness.emit("agent_settled", { aborted: false });
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.setStatus).toHaveBeenLastCalledWith("task", "↻ task goal checker retrying in 1s (1)");
    await vi.advanceTimersByTimeAsync(1000);
    expect(checker.evaluate).toHaveBeenCalledTimes(2);
    expect(harness.setStatus).toHaveBeenLastCalledWith("task", "↻ task goal checker retrying in 2s (2)");
    await vi.advanceTimersByTimeAsync(2000);
    expect(checker.evaluate).toHaveBeenCalledTimes(3);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.notify).toHaveBeenLastCalledWith("Task goal: independently verified after 1 run(s)", "info");
    expect(checker.dispose).toHaveBeenCalledOnce();
  });

  it("retries planning failures before sending work to the implementing agent", async () => {
    const checker = createChecker();
    vi.mocked(checker.initialize)
      .mockResolvedValueOnce(Result.fail(new Error("planner exited")))
      .mockResolvedValueOnce(Result.succeed(undefined));
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests"');
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.setStatus).toHaveBeenLastCalledWith("task", "↻ task goal checker retrying in 1s (1)");
    await vi.advanceTimersByTimeAsync(1000);
    expect(checker.initialize).toHaveBeenCalledTimes(2);
    expect(checker.create).toHaveBeenCalledOnce();
    expect(harness.sendUserMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("fix tests"));
    await harness.emit("session_shutdown");
  });

  it("retries checker creation and cancels a pending retry on user input", async () => {
    const checker = createChecker();
    vi.mocked(checker.create)
      .mockResolvedValueOnce(Result.fail(new Error("spawn failed")))
      .mockImplementation(async (config) => Result.succeed(createCheckerValue(config)));
    const harness = createHarness({ goalChecker: checker, launchArgs: [] });
    await harness.command('--goal "fix tests"');
    await harness.command("--stop");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checker.create).toHaveBeenCalledOnce();
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });
});
