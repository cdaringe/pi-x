import { match } from "ts-pattern";
import { Result } from "@praha/byethrow";
import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as TaskArgs from "./arguments.js";
import * as GoalChecker from "./goal-checker.js";
import * as Evidence from "./goal-evidence.js";
import * as GoalUser from "./goal-user.js";
import * as GoalStore from "./goal-store.js";
import * as GoalRoleEntry from "./goal-role-entry.js";
import * as GoalStreamDisplay from "./goal-stream-display.js";
import * as ChoicePicker from "./choice-picker.js";
import * as Launch from "./launch.js";
import * as Task from "./task.js";
import * as TaskModels from "./task-models.js";
import * as Session from "./task-session.js";

const USAGE = [
  "Task usage:",
  '  /task --goal "<prompt>"',
  '  /task --goal "<prompt>" --implementer-model provider/id --checker-model provider/id',
  '  /task --goal "<prompt>" -d',
  "  /task --status",
  "  /task --evaluator  (toggle evaluator detail; Ctrl+Alt+E)",
  "  /task --list",
  "  /task --resume [id]",
  "  /task --stop",
  "Omitted models are selected interactively; -d/--defaults uses the current model for the implementer and that model for the checker.",
  "Only goal tasks are supported. Unmet goals continue with exponential backoff (1–60s).",
].join("\n");

export interface Options {
  readonly goalChecker?: GoalChecker.Operations;
  readonly goalStore?: GoalStore.Operations;
  // SDK hosts can explicitly provide the child process resource flags.
  readonly launchArgs?: string[];
}

interface Runtime {
  readonly checkerModule: GoalChecker.Operations;
  readonly launchArgv: string[];
  readonly launchCwd: string;
  modelRestore?: Promise<void>;
  readonly options: Options;
  readonly pi: ExtensionAPI;
  selection?: AbortController;
  startupProvider?: string;
  readonly store: GoalStore.Operations;
  task?: Session.T;
}

type Notice = Readonly<{
  message: string;
  type?: "info" | "warning" | "error";
}>;
type ActiveContext = Readonly<{ active: Session.T; ctx: ExtensionContext }>;
function notify(ctx: ExtensionContext, { message, type = "info" }: Notice): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

function setStatus(ctx: ExtensionContext, task?: Task.T): void {
  if (ctx.hasUI) ctx.ui.setStatus("task", task ? ctx.ui.theme.fg("accent", Task.formatStatus(task)) : undefined);
}

function showTaskRole(runtime: Runtime, { active, ctx, role }: ActiveContext & { role: GoalStreamDisplay.Role }): void {
  const previous = active.display.state.active;
  if (previous === role) return;
  if (ctx.mode === "tui") {
    if (previous === "implementer" || previous === "dialog")
      GoalRoleEntry.mark(runtime.pi, { edge: "end", kind: previous === "dialog" ? "evidence" : "work" });
    if (role === "implementer" || role === "dialog")
      GoalRoleEntry.mark(runtime.pi, { edge: "start", kind: role === "dialog" ? "evidence" : "work" });
  }
  GoalStreamDisplay.showRole(active.display, role);
}

function saveRecord(
  runtime: Runtime,
  { active, ctx }: ActiveContext,
  changes: Partial<Pick<GoalStore.T, "updates" | "models" | "status">>,
): void {
  const record = GoalStore.revise(active.record, changes);
  const saved = runtime.store.write(record);
  if (Result.isSuccess(saved)) active.record = record;
  else notify(ctx, { message: `Task goal: could not save resume state — ${saved.error.message}`, type: "warning" });
}

async function restoreModel(runtime: Runtime, active: Session.T): Promise<boolean> {
  if (
    active.modelSwitch &&
    (await active.modelSwitch) &&
    active.models.original &&
    !TaskModels.matches(active.models.original, active.models.implementer)
  )
    return runtime.pi.setModel(active.models.original);
  return true;
}

async function stop(
  runtime: Runtime,
  { active, ctx, complete = false, ...notice }: ActiveContext & Notice & { complete?: boolean },
): Promise<void> {
  if (runtime.task !== active) return;
  runtime.task = undefined;
  showTaskRole(runtime, { active, ctx, role: "none" });
  if (complete) {
    const removed = runtime.store.remove(active.record.id);
    if (Result.isFailure(removed))
      notify(ctx, {
        message: `Task goal: could not remove completed resume state — ${removed.error.message}`,
        type: "warning",
      });
  } else saveRecord(runtime, { active, ctx }, { status: "paused", updates: active.userUpdates });
  Session.dispose(active, runtime.checkerModule);
  const finishing = restoreModel(runtime, active)
    .then((restored) => {
      if (!restored)
        notify(ctx, {
          message: "Task goal: could not restore original model",
          type: "warning",
        });
    })
    .catch((error: unknown) => {
      notify(ctx, {
        message: `Task goal: could not restore original model — ${error instanceof Error ? error.message : String(error)}`,
        type: "warning",
      });
    })
    .then(() => {
      notify(ctx, notice);
      setStatus(ctx);
    });
  // A new task waits for both model restoration and status cleanup.
  runtime.modelRestore = finishing;
  await finishing;
  if (runtime.modelRestore === finishing) runtime.modelRestore = undefined;
}

function resume(runtime: Runtime, { active, ctx }: ActiveContext): void {
  if (runtime.task !== active || active.state.phase !== "backoff") return;
  const prompt = Task.buildContinuation(active.state, Session.listUserUpdates(active));
  Session.transition(active, Task.work(active.state));
  showTaskRole(runtime, { active, ctx, role: "implementer" });
  setStatus(ctx, active.state);
  runtime.pi.sendUserMessage(prompt);
}

async function requestEvidence(
  runtime: Runtime,
  { active, ctx, request, signal }: ActiveContext & { request: Evidence.Request; signal: AbortSignal },
): Promise<string> {
  if (runtime.task !== active || active.state.phase !== "checking")
    return "Evidence dialog is available only during verification.";
  const answer = Session.openEvidence(active, signal);
  if (Result.isFailure(answer)) return answer.error.message;
  showTaskRole(runtime, { active, ctx, role: "dialog" });
  if (ctx.hasUI)
    ctx.ui.setStatus(
      "task",
      ctx.ui.theme.fg("accent", `↻ task goal evidence request ${active.evidenceRequests}/${Evidence.MAX_REQUESTS}`),
    );
  runtime.pi.sendUserMessage(
    [
      "The independent verifier paused its current run to request evidence.",
      `Criterion: ${request.criterion}`,
      `Question: ${request.question}`,
      `Already tried: ${request.attempted}`,
      "Answer with concrete file paths, commands, or other evidence pointers. If this requires the user to act, call task_ask_user and relay their answer. Do not modify project files during this reply. The verifier will independently check your answer; claims alone do not count.",
    ].join("\n\n"),
  );
  const response = await answer.value;
  if (runtime.task === active) {
    showTaskRole(runtime, { active, ctx, role: "evaluator" });
    setStatus(ctx, active.state);
  }
  return response;
}

type CheckerFailure = ActiveContext & {
  readonly failed: Task.Planning | Task.Checking;
  readonly error: Error;
  readonly resume: (state: Task.Planning | Task.Checking) => void;
};

function scheduleCheckerRetry(runtime: Runtime, { active, ctx, failed, error, resume }: CheckerFailure): void {
  if (runtime.task !== active) return;
  const waiting = Task.retryChecker(failed, error);
  Session.transition(active, waiting);
  showTaskRole(runtime, { active, ctx, role: "none" });
  setStatus(ctx, waiting);
  notify(ctx, {
    message: `Task goal: checker ${waiting.target} failed — ${waiting.error}; retrying in ${waiting.delayMs / 1000}s`,
    type: "warning",
  });
  Session.scheduleRetry(active, () => {
    if (runtime.task !== active || active.state.phase !== "checker-retry") return;
    const resumed = Task.resumeChecker(active.state);
    Session.transition(active, resumed);
    setStatus(ctx, resumed);
    resume(resumed);
  });
}

async function checkWorkspace(
  runtime: Runtime,
  { active, ctx, checking }: ActiveContext & { checking: Task.Checking },
): Promise<void> {
  if (!active.checker) return;
  showTaskRole(runtime, { active, ctx, role: "evaluator" });
  const run = Session.beginCheckerRun(active);
  const pending = runtime.checkerModule.evaluate(active.checker, run.signal);
  Session.trackCheckerRun(active, pending);
  const result = await pending;
  Session.finishCheckerRun(active, run.controller);
  if (runtime.task !== active || active.state !== checking) return;
  return match(result)
    .with({ type: "Failure" }, ({ error }) =>
      scheduleCheckerRetry(runtime, {
        active,
        ctx,
        error,
        failed: checking,
        resume: (state) => {
          if (state.phase === "checking") void checkWorkspace(runtime, { active, checking: state, ctx });
        },
      }),
    )
    .with({ type: "Success", value: { complete: true } }, () =>
      stop(runtime, {
        active,
        complete: true,
        ctx,
        message: `Task goal: independently verified after ${checking.runs} run(s)`,
      }),
    )
    .with({ type: "Success", value: { complete: false } }, ({ value }) => {
      Session.transition(active, Task.scheduleBackoff(checking, value));
      showTaskRole(runtime, { active, ctx, role: "none" });
      setStatus(ctx, active.state);
      Session.scheduleRetry(active, () => resume(runtime, { active, ctx }));
    })
    .exhaustive();
}

async function evaluate(runtime: Runtime, { active, ctx }: ActiveContext): Promise<void> {
  await Session.waitCheckerRun(active);
  if (runtime.task !== active) return;
  if (active.state.phase !== "working") return;
  const checking = Task.check(active.state);
  Session.transition(active, checking);
  if (!active.checker)
    return stop(runtime, {
      active,
      ctx,
      message: "Task goal: checker is unavailable",
      type: "error",
    });
  setStatus(ctx, checking);
  await checkWorkspace(runtime, { active, checking, ctx });
}

function buildCheckerConfig(
  runtime: Runtime,
  { active, ctx }: ActiveContext,
): Result.Result<GoalChecker.Config, Error> {
  const model = active.models.checker;
  const launchArgs = runtime.options.launchArgs
    ? Result.succeed(runtime.options.launchArgs)
    : Launch.inheritArgs({
        argv: runtime.launchArgv,
        currentProvider: model.provider,
        cwd: runtime.launchCwd,
        startupProvider: runtime.startupProvider,
      });
  if (Result.isFailure(launchArgs)) return launchArgs;
  return Result.try({
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    try: (): GoalChecker.Config => ({
      cwd: ctx.cwd,
      getEvidenceBudget: () => Math.max(0, Evidence.MAX_REQUESTS - active.evidenceRequests),
      getUserUpdates: () => Session.listUserUpdates(active),
      launchArgs: launchArgs.value,
      model: { id: model.id, provider: model.provider },
      onUpdate: (update) => {
        if (runtime.task === active) GoalStreamDisplay.update(active.display, update);
      },
      projectTrusted: ctx.isProjectTrusted(),
      prompt: active.state.prompt,
      requestEvidence: (request, signal) => requestEvidence(runtime, { active, ctx, request, signal }),
      thinkingLevel: ctx.thinkingLevel,
    }),
  });
}

async function initialize(runtime: Runtime, { active, ctx }: ActiveContext): Promise<void> {
  showTaskRole(runtime, { active, ctx, role: "evaluator" });
  const revision = active.userRevision;
  const config = buildCheckerConfig(runtime, { active, ctx });
  if (Result.isFailure(config))
    return stop(runtime, {
      active,
      ctx,
      message: `Task goal: could not initialize checker — ${config.error.message}`,
      type: "error",
    });
  const created = active.checker ? Result.succeed(active.checker) : await runtime.checkerModule.create(config.value);
  if (runtime.task !== active) {
    if (Result.isSuccess(created) && !active.checker) await runtime.checkerModule.dispose(created.value);
    return;
  }
  if (active.state.phase !== "planning") return;
  if (Result.isFailure(created))
    return scheduleCheckerRetry(runtime, {
      active,
      ctx,
      error: created.error,
      failed: active.state,
      resume: (state) => {
        if (state.phase === "planning") void initialize(runtime, { active, ctx });
      },
    });
  const checker = created.value;
  if (!active.checker) Session.attachChecker(active, checker);
  const initialized = await runtime.checkerModule.initialize(checker, active.controller.signal);
  if (runtime.task !== active || active.state.phase !== "planning") return;
  if (Result.isFailure(initialized))
    return scheduleCheckerRetry(runtime, {
      active,
      ctx,
      error: initialized.error,
      failed: active.state,
      resume: (state) => {
        if (state.phase === "planning") void initialize(runtime, { active, ctx });
      },
    });
  if (active.userRevision !== revision) return initialize(runtime, { active, ctx });
  GoalStreamDisplay.flush(active.display);
  if (!TaskModels.matches(ctx.model, active.models.implementer)) {
    active.modelSwitch = runtime.pi.setModel(active.models.implementer).catch(() => false);
    const switched = await active.modelSwitch;
    if (runtime.task !== active) return;
    if (!switched)
      return stop(runtime, {
        active,
        ctx,
        message: `Task goal: could not switch to implementer model ${TaskModels.format(active.models.implementer)}`,
        type: "error",
      });
  }
  if (active.userRevision !== revision) return initialize(runtime, { active, ctx });
  if (active.resuming) {
    const checking = Task.check(Task.work(active.state));
    Session.transition(active, checking);
    setStatus(ctx, checking);
    return checkWorkspace(runtime, { active, checking, ctx });
  }
  const prompt = Task.buildStartPrompt(active.state, Session.listUserUpdates(active));
  const images = Session.takeQueuedImages(active);
  Session.transition(active, Task.work(active.state));
  showTaskRole(runtime, { active, ctx, role: "implementer" });
  setStatus(ctx, active.state);
  runtime.pi.sendUserMessage(images.length ? [{ text: prompt, type: "text" }, ...images] : prompt);
}

function listSaved(runtime: Runtime, ctx: ExtensionContext): void {
  const listed = runtime.store.list(ctx.cwd);
  if (Result.isFailure(listed))
    return notify(ctx, { message: `Task goal: could not list saved goals — ${listed.error.message}`, type: "error" });
  notify(ctx, {
    message: listed.value.length
      ? `Saved goals in ${ctx.cwd}:\n${listed.value.map(GoalStore.format).join("\n")}\nUse /task --resume <id>.`
      : `Task goal: no saved goals in ${ctx.cwd}`,
  });
}

async function resumeSaved(runtime: Runtime, { id, ctx }: { id?: string; ctx: ExtensionContext }): Promise<void> {
  if (runtime.task)
    return notify(ctx, {
      message: "Task: a task is already running. Use /task --stop to end it first.",
      type: "warning",
    });
  if (runtime.selection)
    return notify(ctx, { message: "Task: model selection is already in progress.", type: "warning" });
  const listed = runtime.store.list(ctx.cwd);
  if (Result.isFailure(listed))
    return notify(ctx, { message: `Task goal: could not list saved goals — ${listed.error.message}`, type: "error" });
  const available = listed.value.filter(GoalStore.canResume);
  if (!available.length && !id)
    return notify(ctx, { message: "Task goal: no goals available to resume in this workspace" });
  const selection = new AbortController();
  runtime.selection = selection;
  if (runtime.modelRestore) await runtime.modelRestore;
  if (runtime.selection !== selection) return;
  const choice =
    !id && ctx.hasUI
      ? await ChoicePicker.choose({
          choices: available.map(GoalStore.format),
          ctx,
          searchPlaceholder: "goal text or ID",
          searchTitle: "Search goals",
          signal: selection.signal,
          title: "Resume goal",
        })
      : undefined;
  if (runtime.selection !== selection) return;
  const selected = id
    ? GoalStore.find(listed.value, id)
    : choice
      ? GoalStore.find(available, choice.slice(0, 8))
      : Result.fail(new Error(ctx.hasUI ? "resume cancelled" : "pass a task ID from /task --list to --resume"));
  if (Result.isFailure(selected)) {
    runtime.selection = undefined;
    return notify(ctx, { message: `Task goal: ${selected.error.message}`, type: "warning" });
  }
  const record = selected.value;
  if (!GoalStore.canResume(record)) {
    runtime.selection = undefined;
    return notify(ctx, {
      message: `Task goal: ${record.id.slice(0, 8)} is still running in another Pi process`,
      type: "warning",
    });
  }
  const storedModels = await TaskModels.choose({
    args: {
      checkerModel: record.models.checker,
      defaults: false,
      implementerModel: record.models.implementer,
      kind: "goal",
      prompt: record.prompt,
    },
    ctx,
    signal: selection.signal,
  });
  const models =
    Result.isFailure(storedModels) && storedModels.error.message.includes("unavailable") && ctx.hasUI
      ? await TaskModels.choose({
          args: { defaults: false, kind: "goal", prompt: record.prompt },
          ctx,
          signal: selection.signal,
        })
      : storedModels;
  if (runtime.selection !== selection) return;
  runtime.selection = undefined;
  if (Result.isFailure(models)) return notify(ctx, { message: `Task goal: ${models.error.message}`, type: "warning" });
  const running = GoalStore.revise(record, {
    models: {
      checker: TaskModels.format(models.value.checker),
      implementer: TaskModels.format(models.value.implementer),
    },
    status: "running",
  });
  const saved = runtime.store.write(running);
  if (Result.isFailure(saved))
    return notify(ctx, { message: `Task goal: could not save resume state — ${saved.error.message}`, type: "error" });
  const active = Session.create({ ctx, models: models.value, record: running, resuming: true });
  runtime.task = active;
  notify(ctx, { message: "Task goal: resuming by rebuilding the checklist and verifying the current workspace." });
  setStatus(ctx, active.state);
  await initialize(runtime, { active, ctx });
}

async function start(runtime: Runtime, { args, ctx }: { args: string; ctx: ExtensionContext }): Promise<void> {
  if (args.trim() === "--stop" || args.trim() === "-s") {
    if (runtime.task)
      return stop(runtime, {
        active: runtime.task,
        ctx,
        message: `Task goal: paused; resume with /task --resume ${runtime.task.record.id.slice(0, 8)}`,
      });
    if (runtime.selection) {
      runtime.selection.abort();
      runtime.selection = undefined;
      return notify(ctx, { message: "Task goal: model selection stopped" });
    }
    return notify(ctx, { message: "Task: no active goal to stop", type: "warning" });
  }
  if (args.trim() === "--status")
    return notify(ctx, {
      message: runtime.task ? Task.formatStatus(runtime.task.state) : "Task: no active goal",
    });
  if (args.trim() === "--evaluator") {
    if (!runtime.task) return notify(ctx, { message: "Task: no active goal", type: "warning" });
    GoalStreamDisplay.toggle(runtime.task.display);
    return;
  }
  if (args.trim() === "--list") return listSaved(runtime, ctx);
  const resume = /^--resume(?:=(\S+)|\s+(\S+))?$/.exec(args.trim());
  if (resume) return resumeSaved(runtime, { ctx, id: resume[1] ?? resume[2] });
  if (args.trim() === "--help" || !args.trim())
    return notify(ctx, {
      message: USAGE,
      type: args.trim() ? "info" : "warning",
    });
  if (runtime.task)
    return notify(ctx, {
      message: "Task: a task is already running. Use /task --stop to end it first.",
      type: "warning",
    });
  const parsed = TaskArgs.parse(args);
  if (Result.isFailure(parsed))
    return notify(ctx, {
      message: `Task: ${parsed.error}\n\n${USAGE}`,
      type: "warning",
    });
  if (runtime.selection)
    return notify(ctx, {
      message: "Task: model selection is already in progress.",
      type: "warning",
    });
  const selection = new AbortController();
  runtime.selection = selection;
  if (runtime.modelRestore) await runtime.modelRestore;
  if (runtime.selection !== selection) return;
  const models = await TaskModels.choose({
    args: parsed.value,
    ctx,
    signal: selection.signal,
  });
  if (runtime.selection !== selection) return;
  runtime.selection = undefined;
  if (Result.isFailure(models))
    return notify(ctx, {
      message: `Task goal: ${models.error.message}`,
      type: "warning",
    });
  const record = GoalStore.create({
    cwd: ctx.cwd,
    models: {
      checker: TaskModels.format(models.value.checker),
      implementer: TaskModels.format(models.value.implementer),
    },
    prompt: parsed.value.prompt,
  });
  const saved = runtime.store.write(record);
  if (Result.isFailure(saved))
    return notify(ctx, { message: `Task goal: could not create resume state — ${saved.error.message}`, type: "error" });
  const active = Session.create({
    ctx,
    models: models.value,
    record,
  });
  runtime.task = active;
  notify(ctx, {
    message:
      "Task goal: creating an independent verification checklist before implementation starts. Send messages to refine the goal; use /task --stop to pause it.",
  });
  setStatus(ctx, active.state);
  await initialize(runtime, { active, ctx });
}

async function handleSettled(
  runtime: Runtime,
  { aborted, ctx }: { aborted: boolean; ctx: ExtensionContext },
): Promise<void> {
  const active = runtime.task;
  if (!active) return;
  if (aborted)
    return stop(runtime, {
      active,
      ctx,
      message: "Task goal: agent run was aborted",
      type: "warning",
    });
  if (active.evidence) return Session.closeEvidence(active);
  if (active.state.phase !== "working") return;
  await evaluate(runtime, { active, ctx });
}

function shutdown(runtime: Runtime, ctx: ExtensionContext): void {
  runtime.selection?.abort();
  runtime.selection = undefined;
  const active = runtime.task;
  runtime.task = undefined;
  if (active) {
    saveRecord(runtime, { active, ctx }, { status: "paused", updates: active.userUpdates });
    Session.dispose(active, runtime.checkerModule);
  }
}

// Pi's extension loader discovers this module through its default export.
export default function registerTaskExtension(pi: ExtensionAPI, options: Options = {}): void {
  if (process.env.PI_TASK_GOAL_CHILD === "1") return Evidence.register(pi);
  GoalRoleEntry.register(pi);
  const runtime: Runtime = {
    checkerModule: options.goalChecker ?? GoalChecker,
    launchArgv: process.argv.slice(2),
    launchCwd: process.cwd(),
    options,
    pi,
    store: options.goalStore ?? GoalStore.createOperations(),
  };
  GoalUser.register(pi, {
    getTaskSignal: () => runtime.task?.controller.signal,
    recordAnswer: (request, answer, ctx) => {
      const active = runtime.task;
      if (!active) return;
      Session.recordUserUpdate(active, `Task question: ${request.question}\n${answer}`);
      saveRecord(runtime, { active, ctx }, { updates: active.userUpdates });
    },
  });
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup") runtime.startupProvider ??= ctx.model?.provider;
  });
  pi.on("input", async (event, ctx) => {
    const active = runtime.task;
    if (!active || event.source === "extension") return { action: "continue" };
    if (!(event.text ?? "").trim() && !event.images?.length) return { action: "continue" };
    Session.recordUserUpdate(
      active,
      [event.text, event.images?.length ? "User attached an image to this task." : ""].filter(Boolean).join("\n"),
    );
    saveRecord(runtime, { active, ctx }, { updates: active.userUpdates });
    return match(active.state)
      .with({ phase: "planning" }, () => {
        Session.queueImages(active, event.images ?? []);
        notify(ctx, { message: "Task goal: update queued for the planner" });
        return { action: "handled" as const };
      })
      .with({ phase: "checker-retry", target: "planning" }, () => {
        Session.queueImages(active, event.images ?? []);
        notify(ctx, { message: "Task goal: update queued for planning retry" });
        return { action: "handled" as const };
      })
      .with({ phase: "checking" }, (state) => {
        if (active.evidence) return { action: "continue" as const };
        Session.cancelCheckerRun(active);
        Session.transition(active, Task.steer(state));
        showTaskRole(runtime, { active, ctx, role: "implementer" });
        setStatus(ctx, active.state);
        return { action: "continue" as const };
      })
      .with({ phase: "backoff" }, (state) => {
        Session.cancelRetry(active);
        Session.transition(active, Task.steer(state));
        showTaskRole(runtime, { active, ctx, role: "implementer" });
        setStatus(ctx, active.state);
        return { action: "continue" as const };
      })
      .with({ phase: "checker-retry", target: "checking" }, (state) => {
        Session.cancelRetry(active);
        Session.transition(active, Task.steer(state));
        showTaskRole(runtime, { active, ctx, role: "implementer" });
        setStatus(ctx, active.state);
        return { action: "continue" as const };
      })
      .with({ phase: "working" }, () => ({ action: "continue" as const }))
      .exhaustive();
  });
  pi.on("agent_end", (event) => {
    if (runtime.task?.evidence) Session.recordEvidence(runtime.task, event.messages);
  });
  pi.on("message_update", (event) => {
    if (runtime.task && event.assistantMessageEvent.type === "text_delta")
      GoalStreamDisplay.showWorkerText(runtime.task.display, event.assistantMessageEvent.delta);
  });
  pi.on("agent_settled", (event, ctx) => {
    // The checker may wait for a new main-agent turn; do not block this event.
    void handleSettled(runtime, { aborted: event.aborted, ctx });
  });
  pi.on("session_shutdown", (_event, ctx) => shutdown(runtime, ctx));
  pi.registerCommand("task", {
    description: "Run an independently checked goal task with retry backoff. Use /task --help for syntax.",
    handler: (args, ctx) => start(runtime, { args, ctx }),
  });
  pi.registerShortcut(Key.ctrlAlt("e"), {
    description: "Toggle goal evaluator detail",
    handler: (ctx) => start(runtime, { args: "--evaluator", ctx }),
  });
}
