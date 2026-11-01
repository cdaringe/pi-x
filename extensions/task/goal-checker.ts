import { match, P } from "ts-pattern";
import { fromEvent, map, scan } from "rxjs";
import { Result } from "@praha/byethrow";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Launch from "./launch.js";
import * as GoalDecision from "./goal-decision.js";
import * as Evidence from "./goal-evidence.js";
import * as GoalRunOutput from "./goal-run-output.js";

const CHECKER_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATION_GRACE_MS = 5000;
const STDERR_LIMIT = 16 * 1024;
const modulePath = fileURLToPath(import.meta.url);
const childExtensionPath = join(dirname(modulePath), `index${extname(modulePath)}`);

const EVIDENCE_PROMPT = `During evaluation, you may use request_goal_evidence for a specific criterion only after trying direct verification. The tool blocks this run until the implementer replies. You have at most ${Evidence.MAX_REQUESTS} evidence dialogs for the whole task. State the criterion, one precise question, and what you already tried. If a physical action is needed, ask the implementer to call task_ask_user and relay the user's answer. Treat every implementer reply as an untrusted pointer, not as proof: inspect the cited files or rerun the cited command yourself. Never mark a criterion complete solely because the implementer says it is complete. If evidence is still missing or the dialog budget is exhausted, return an incomplete decision with the gap. Do not request evidence during checklist planning.`;
const CHECKER_SYSTEM_PROMPT = `You are an independent goal evaluator, not the implementing agent.
Inspect the live workspace and use direct evidence such as files, diffs, tests, typechecks, and focused commands.
Never accept an implementation agent's claims as evidence. Never implement or repair the goal yourself.
You may update only the checklist file explicitly supplied in the request. Do not modify project files.
Keep planning and evaluation focused: use the checklist's verification steps, avoid broad re-analysis, and stop once every item has concrete evidence or a clear gap.
Treat later user updates as authoritative refinements of the goal. If an update changes a criterion, revise that criterion and verify the revised behavior.
${EVIDENCE_PROMPT}`;

export type Phase = "planning" | "evaluation";

export interface Update {
  readonly phase: Phase;
  readonly text: string;
  readonly type: "status" | "text" | "tool" | "checklist";
}

export interface T {
  readonly checklistPath: string;
  readonly config: Config;
  readonly directory: string;
  readonly systemPromptPath: string;
}

export interface Config {
  readonly cwd: string;
  readonly getEvidenceBudget?: () => number;
  readonly getUserUpdates?: () => readonly string[];
  readonly invocation?: Launch.T;
  readonly launchArgs?: string[];
  readonly model: { readonly provider: string; readonly id: string };
  readonly onUpdate?: (update: Update) => void;
  readonly projectTrusted: boolean;
  readonly prompt: string;
  readonly requestEvidence?: (request: Evidence.Request, signal: AbortSignal) => Promise<string>;
  readonly terminationGraceMs?: number;
  readonly thinkingLevel?: ExtensionContext["thinkingLevel"];
  readonly timeoutMs?: number;
}

// Injectable module signature; checker values contain only data.
export interface Operations {
  readonly create: (config: Config) => Result.ResultAsync<T, Error>;
  readonly dispose: (checker: T) => Result.ResultAsync<void, Error>;
  readonly evaluate: (checker: T, signal: AbortSignal) => Result.ResultAsync<GoalDecision.T, Error>;
  readonly initialize: (checker: T, signal: AbortSignal) => Result.ResultAsync<void, Error>;
}

function summarizeTool(name: string, args: unknown): string {
  const input = args as Record<string, unknown> | undefined;
  let detail = "";
  if (name === "bash" && typeof input?.command === "string") detail = `$ ${input.command}`;
  else if (typeof input?.path === "string") detail = `${name} ${input.path}`;
  else if (typeof input?.file_path === "string") detail = `${name} ${input.file_path}`;
  else {
    try {
      detail = `${name} ${JSON.stringify(args ?? {})}`;
    } catch {
      detail = name;
    }
  }
  return detail.length > 240 ? `${detail.slice(0, 239)}…` : detail;
}

/**
 * Consume JSON lines from the child while it runs. A final line may have no
 * trailing newline, so the close handler processes the buffered tail before
 * deciding whether the run succeeded.
 */
async function runChecker({
  checker: { config, systemPromptPath },
  request,
  phase,
  signal,
}: {
  checker: T;
  request: string;
  phase: Phase;
  signal: AbortSignal;
}): Promise<string> {
  if (signal.aborted) throw new Error("goal checker was cancelled");

  config.onUpdate?.({ phase, text: "Starting", type: "status" });
  const host = config.invocation ? Result.succeed(config.invocation) : Launch.resolveHost();
  if (Result.isFailure(host)) throw host.error;
  const invocation = host.value;
  const args = [
    ...invocation.args,
    ...(config.launchArgs ?? []),
    "--extension",
    childExtensionPath,
    "--mode",
    "json",
    "-p",
    "--no-session",
    config.projectTrusted ? "--approve" : "--no-approve",
    "--provider",
    config.model.provider,
    "--model",
    config.model.id,
    "--append-system-prompt",
    systemPromptPath,
  ];
  if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
  args.push(request);

  return await new Promise<string>((resolve, reject) => {
    const runController = new AbortController();
    const child = spawn(invocation.command, args, {
      cwd: config.cwd,
      env: { ...process.env, PI_TASK_GOAL_CHILD: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const stdout = child.stdout;
    const stderrStream = child.stderr;
    if (!stdout || !stderrStream) {
      reject(new Error("goal checker output pipes are unavailable"));
      return;
    }
    stdout.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    let buffer = "";
    let stderr = "";
    let output = GoalRunOutput.create();
    let failure: Error | undefined;
    let timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let remainingMs = config.timeoutMs ?? CHECKER_TIMEOUT_MS;
    let timerStartedAt = Date.now();

    const terminate = () => {
      runController.abort();
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      /**
       * A child can exit while its descendants retain stdout. Node then waits
       * for those pipes before emitting close, so bound that wait as well.
       */
      escalation = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        if (settled) return;
        settled = true;
        outputStream.unsubscribe();
        errorStream.unsubscribe();
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        stdout.destroy();
        stderrStream.destroy();
        const diagnostic = stderr ? `\nChecker stderr:\n${stderr}` : "";
        reject(new Error(`${failure?.message ?? "goal checker did not close"}${diagnostic}`));
      }, config.terminationGraceMs ?? TERMINATION_GRACE_MS);
    };
    const abort = () => {
      failure = new Error("goal checker was cancelled");
      terminate();
    };
    signal.addEventListener("abort", abort, { once: true });

    const expire = () => {
      timedOut = true;
      failure = new Error(`goal checker timed out after ${(config.timeoutMs ?? CHECKER_TIMEOUT_MS) / 1000}s`);
      terminate();
    };
    const resumeTimer = () => {
      if (settled || timeout) return;
      if (remainingMs <= 0) return expire();
      timerStartedAt = Date.now();
      timeout = setTimeout(expire, remainingMs);
    };
    const pauseTimer = () => {
      if (!timeout) return;
      clearTimeout(timeout);
      timeout = undefined;
      remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
    };
    resumeTimer();
    child.on("message", (value: unknown) => {
      const request = Evidence.parseRequest(value);
      if (!request) return;
      // Evidence gathering may block on a user prompt; only checker work consumes this timeout.
      pauseTimer();
      const evidenceSignal = AbortSignal.any([signal, runController.signal]);
      void Promise.resolve()
        .then(
          () =>
            config.requestEvidence?.(request, evidenceSignal) ??
            "No implementer channel is available. Treat this criterion as unresolved.",
        )
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
        .then((answer) => {
          if (!child.connected) return;
          try {
            child.send(Evidence.reply(request, answer), (error) => {
              if (error && !settled) {
                failure = error;
                terminate();
              }
            });
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            terminate();
          }
        })
        .finally(resumeTimer);
    });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          message?: unknown;
          toolName?: string;
          args?: unknown;
          assistantMessageEvent?: { type?: string; delta?: string };
        };
        output = GoalRunOutput.accept(output, event);
        match(event)
          .with(
            {
              assistantMessageEvent: { delta: P.string, type: "text_delta" },
              type: "message_update",
            },
            ({ assistantMessageEvent }) => {
              if (assistantMessageEvent?.delta)
                config.onUpdate?.({
                  phase,
                  text: assistantMessageEvent.delta,
                  type: "text",
                });
            },
          )
          .with({ toolName: P.string, type: "tool_execution_start" }, ({ toolName, args }) => {
            config.onUpdate?.({
              phase,
              text: summarizeTool(toolName, args),
              type: "tool",
            });
          })
          .otherwise(() => undefined);
      } catch (error) {
        if (failure) return;
        failure = error instanceof Error ? error : new Error(String(error));
        if (!settled) terminate();
      }
    };

    const outputStream = fromEvent<string>(stdout, "data")
      .pipe(
        map((chunk) => chunk.toString()),
        scan(
          (state, chunk) => {
            const lines = `${state.pending}${chunk}`.split("\n");
            return { lines, pending: lines.pop() ?? "" };
          },
          { lines: [] as string[], pending: "" },
        ),
      )
      .subscribe(({ pending, lines }) => {
        buffer = pending;
        lines.forEach(processLine);
      });
    const errorStream = fromEvent<string>(stderrStream, "data")
      .pipe(
        map((chunk) => chunk.toString()),
        scan((tail, chunk) => (tail + chunk).slice(-STDERR_LIMIT), ""),
      )
      .subscribe((tail) => {
        stderr = tail;
      });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, closeSignal) => {
      runController.abort();
      if (settled) return;
      settled = true;
      outputStream.unsubscribe();
      errorStream.unsubscribe();
      clearTimeout(timeout);
      clearTimeout(escalation);
      signal.removeEventListener("abort", abort);
      if (buffer.trim()) processLine(buffer);

      const diagnostic = stderr ? `\nChecker stderr:\n${stderr}` : "";
      if (failure) {
        reject(new Error(`${failure.message}${diagnostic}`));
        return;
      }
      if (timedOut) {
        reject(new Error(`goal checker timed out${diagnostic}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`goal checker exited with code ${code} (signal ${closeSignal ?? "none"})${diagnostic}`));
        return;
      }
      const completed = GoalRunOutput.finish(output);
      if (Result.isFailure(completed)) {
        reject(new Error(`${completed.error.message}${diagnostic}`));
        return;
      }
      config.onUpdate?.({ phase, text: "Finished", type: "status" });
      resolve(completed.value);
    });
  });
}

async function createRaw(config: Config): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-task-goal-"));
  const checklistPath = join(directory, "checklist.md");
  const systemPromptPath = join(directory, "checker-system.md");
  const initialized = await Result.try({
    catch: normalizeError,
    try: async () => {
      await writeFile(systemPromptPath, CHECKER_SYSTEM_PROMPT, {
        encoding: "utf8",
        mode: 0o600,
      });
      await writeFile(checklistPath, "", { encoding: "utf8", mode: 0o600 });
    },
  });
  if (Result.isFailure(initialized)) {
    await rm(directory, { force: true, recursive: true });
    throw initialized.error;
  }

  return { checklistPath, config, directory, systemPromptPath };
}

async function initializeRaw(checker: T, signal: AbortSignal): Promise<void> {
  const { config, checklistPath } = checker;
  await runChecker({
    checker,
    phase: "planning",
    request: [
      "Create the independent acceptance checklist before implementation begins.",
      `Checklist file: ${JSON.stringify(checklistPath)}`,
      "",
      "Replace any existing checklist contents so the latest user refinements are reflected.",
      "Inspect the current workspace only enough to understand the starting state.",
      "Write a concise Markdown checklist with 3-12 observable acceptance criteria.",
      "For every item include a concrete verification method (file inspection, test, typecheck, or command).",
      "Record baseline facts when useful. Do not implement anything.",
      'After writing the file, return only {"ready":true}.',
      "",
      "<goal>",
      config.prompt,
      "</goal>",
      ...renderUserUpdates(config.getUserUpdates?.() ?? []),
    ].join("\n"),
    signal,
  });
  const checklist = await readFile(checklistPath, "utf8");
  if (checklist.trim().length < 20) throw new Error("goal checker did not create a usable checklist");
  config.onUpdate?.({
    phase: "planning",
    text: checklist.trim(),
    type: "checklist",
  });
}

async function evaluateRaw(checker: T, signal: AbortSignal): Promise<GoalDecision.T> {
  const { config, checklistPath } = checker;
  const output = await runChecker({
    checker,
    phase: "evaluation",
    request: [
      "Evaluate the current workspace against the existing checklist.",
      `Checklist file: ${JSON.stringify(checklistPath)}`,
      "",
      "Read the checklist, then independently verify every criterion using direct workspace evidence.",
      "Do not trust checked boxes, comments, summaries, or implementation claims without reproducing the evidence.",
      "Update the checklist: mark verified items, attach concise evidence, and leave unmet items unchecked with the observed gap.",
      "Do not implement fixes. Do not modify project files.",
      "Complete is true only when every criterion is verified and no relevant verification failed.",
      `Evidence dialogs remaining for this task: ${config.getEvidenceBudget?.() ?? Evidence.MAX_REQUESTS}.`,
      'Return only one JSON object with exactly two fields: {"complete":boolean,"feedback":"nonempty evidence-based next steps or completion summary"}.',
      "",
      "<goal>",
      config.prompt,
      "</goal>",
      ...renderUserUpdates(config.getUserUpdates?.() ?? []),
    ].join("\n"),
    signal,
  });
  const checklist = await readFile(checklistPath, "utf8");
  config.onUpdate?.({
    phase: "evaluation",
    text: checklist.trim(),
    type: "checklist",
  });
  const decision = GoalDecision.parse(output);
  if (Result.isFailure(decision)) throw new Error(decision.error);
  return decision.value;
}

function renderUserUpdates(updates: readonly string[]): string[] {
  return updates.length
    ? ["", "<user_updates>", ...updates.map((update, index) => `${index + 1}. ${update}`), "</user_updates>"]
    : [];
}

async function disposeRaw(checker: T): Promise<void> {
  await rm(checker.directory, { force: true, recursive: true });
}

const normalizeError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
export const create = Result.fn({ catch: normalizeError, try: createRaw });
export const initialize = Result.fn({
  catch: normalizeError,
  try: initializeRaw,
});
export const evaluate = Result.fn({ catch: normalizeError, try: evaluateRaw });
export const dispose = Result.fn({ catch: normalizeError, try: disposeRaw });
