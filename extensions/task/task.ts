import { match } from "ts-pattern";
import type * as GoalDecision from "./goal-decision.js";

interface Goal {
  readonly checkerAttempts: number;
  readonly prompt: string;
  readonly runs: number;
}

export type Planning = Goal & { readonly phase: "planning" };
export type Working = Goal & { readonly phase: "working" };
export type Checking = Goal & { readonly phase: "checking" };
export type Backoff = Goal & {
  readonly phase: "backoff";
  readonly feedback: string;
  readonly delayMs: number;
};
export type CheckerRetry = Goal & {
  readonly phase: "checker-retry";
  readonly target: "planning" | "checking";
  readonly delayMs: number;
  readonly error: string;
};
export type T = Planning | Working | Checking | Backoff | CheckerRetry;

export const create = ({ prompt }: { readonly prompt: string }): Planning => ({
  checkerAttempts: 0,
  phase: "planning",
  prompt,
  runs: 0,
});

export const work = (task: Planning | Backoff): Working => ({
  checkerAttempts: 0,
  phase: "working",
  prompt: task.prompt,
  runs: task.runs,
});

export const steer = (task: Checking | Backoff | CheckerRetry): Working => ({
  checkerAttempts: 0,
  phase: "working",
  prompt: task.prompt,
  runs: task.runs,
});

export const check = (task: Working): Checking => ({
  ...task,
  phase: "checking",
  runs: task.runs + 1,
});

export const scheduleBackoff = (task: Checking, decision: Extract<GoalDecision.T, { complete: false }>): Backoff => ({
  ...task,
  checkerAttempts: 0,
  delayMs: Math.min(1000 * 2 ** Math.min(task.runs - 1, 16), 60_000),
  feedback: decision.feedback,
  phase: "backoff",
});

// Retry the checker without starting another implementing-agent run.
export const retryChecker = (task: Planning | Checking, error: Error): CheckerRetry => ({
  ...task,
  checkerAttempts: task.checkerAttempts + 1,
  delayMs: Math.min(1000 * 2 ** Math.min(task.checkerAttempts, 16), 60_000),
  error: error.message,
  phase: "checker-retry",
  target: task.phase,
});

export const resumeChecker = (task: CheckerRetry): Planning | Checking =>
  task.target === "planning"
    ? {
        checkerAttempts: task.checkerAttempts,
        phase: "planning",
        prompt: task.prompt,
        runs: task.runs,
      }
    : {
        checkerAttempts: task.checkerAttempts,
        phase: "checking",
        prompt: task.prompt,
        runs: task.runs,
      };

export function formatStatus(task: T): string {
  return match(task)
    .with({ phase: "planning" }, () => "↻ task goal planning")
    .with({ phase: "working" }, ({ runs }) => `↻ task goal ${runs + 1}`)
    .with({ phase: "checking" }, ({ runs }) => `↻ task goal checking (${runs})`)
    .with(
      { phase: "checker-retry" },
      ({ checkerAttempts, delayMs }) => `↻ task goal checker retrying in ${delayMs / 1000}s (${checkerAttempts})`,
    )
    .with({ phase: "backoff" }, ({ runs, delayMs }) => `↻ task goal retrying in ${delayMs / 1000}s (${runs})`)
    .exhaustive();
}

function keepTail(text: string): string {
  const limit = 8000;
  return text.length <= limit ? text : `… [truncated ${text.length - limit} chars from start]\n${text.slice(-limit)}`;
}

const USER_DIALOG_INSTRUCTION =
  "When progress requires information or a physical action from the user, call task_ask_user and wait for the answer. Treat later user updates as authoritative changes to the goal.";

export const buildContinuation = (task: Backoff, updates: readonly string[] = []): string =>
  [
    task.prompt,
    ...updates.flatMap((update) => ["", `User update: ${update}`]),
    "",
    "The independent goal evaluator determined that the goal is not complete.",
    "",
    keepTail(task.feedback),
    "",
    "Continue working on the goal. Address the evidence-based gaps, then verify your work before returning.",
    USER_DIALOG_INSTRUCTION,
  ].join("\n");

export const buildStartPrompt = (task: Planning, updates: readonly string[]): string =>
  [task.prompt, ...updates.flatMap((update) => ["", `User update: ${update}`]), "", USER_DIALOG_INSTRUCTION].join("\n");
