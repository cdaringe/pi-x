import { fromEvent, Subscription, takeUntil, timer } from "rxjs";
import { Result } from "@praha/byethrow";
import type { ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import type * as GoalChecker from "./goal-checker.js";
import type * as GoalStore from "./goal-store.js";
import type * as TaskModels from "./task-models.js";
import * as Evidence from "./goal-evidence.js";
import * as GoalStreamDisplay from "./goal-stream-display.js";
import * as Task from "./task.js";

// Owns effectful resources and the current immutable task state.
export interface T {
  checker?: GoalChecker.T;
  checkerRun?: AbortController;
  checkerSettled?: Promise<void>;
  readonly controller: AbortController;
  readonly display: GoalStreamDisplay.T;
  evidence?: {
    readonly resolve: (answer: string) => void;
    readonly signal: AbortSignal;
    readonly abort: () => void;
    readonly userUpdateCount: number;
    answer?: string;
  };
  evidenceRequests: number;
  modelSwitch?: Promise<boolean>;
  readonly models: TaskModels.T;
  queuedImages: NonNullable<InputEvent["images"]>;
  record: GoalStore.T;
  readonly resuming: boolean;
  retrySubscription?: Subscription;
  state: Task.T;
  userRevision: number;
  userUpdates: string[];
}

export const create = ({
  record,
  ctx,
  models,
  resuming = false,
}: {
  record: GoalStore.T;
  ctx: ExtensionContext;
  models: TaskModels.T;
  resuming?: boolean;
}): T => ({
  controller: new AbortController(),
  display: GoalStreamDisplay.create(ctx),
  evidenceRequests: 0,
  models,
  queuedImages: [],
  record,
  resuming,
  state: Task.create({ prompt: record.prompt }),
  userRevision: 0,
  userUpdates: [...record.updates],
});

export function recordUserUpdate(session: T, text: string): void {
  const update = text.trim().slice(0, 4000);
  if (!update) return;
  session.userUpdates = [...session.userUpdates, update];
  session.userRevision += 1;
}

export const listUserUpdates = (session: T): readonly string[] => session.userUpdates;

export function queueImages(session: T, images: NonNullable<InputEvent["images"]>): void {
  session.queuedImages = [...session.queuedImages, ...images];
}

export function takeQueuedImages(session: T): NonNullable<InputEvent["images"]> {
  const images = session.queuedImages;
  session.queuedImages = [];
  return images;
}

export function beginCheckerRun(session: T): { controller: AbortController; signal: AbortSignal } {
  const controller = new AbortController();
  session.checkerRun = controller;
  return { controller, signal: AbortSignal.any([session.controller.signal, controller.signal]) };
}

export function trackCheckerRun(session: T, pending: Promise<unknown>): void {
  session.checkerSettled = pending.then(
    () => undefined,
    () => undefined,
  );
}

export function finishCheckerRun(session: T, controller: AbortController): void {
  if (session.checkerRun === controller) session.checkerRun = undefined;
}

export function cancelCheckerRun(session: T): void {
  session.checkerRun?.abort();
  session.checkerRun = undefined;
}

export async function waitCheckerRun(session: T): Promise<void> {
  await session.checkerSettled;
}

export function cancelRetry(session: T): void {
  session.retrySubscription?.unsubscribe();
  session.retrySubscription = undefined;
}

export function openEvidence(session: T, signal: AbortSignal): Result.Result<Promise<string>, Error> {
  if (session.evidenceRequests >= Evidence.MAX_REQUESTS)
    return Result.fail(
      new Error(
        `The ${Evidence.MAX_REQUESTS}-request evidence dialog limit has been reached. Decide from independently verified evidence; report unresolved criteria as incomplete.`,
      ),
    );
  if (session.evidence) return Result.fail(new Error("Another evidence dialog is still pending."));
  if (signal.aborted) return Result.fail(new Error("Evidence dialog was cancelled."));
  session.evidenceRequests += 1;
  return Result.succeed(
    new Promise<string>((resolve) => {
      const abort = () => closeEvidence(session, "Evidence dialog was cancelled.");
      session.evidence = { abort, resolve, signal, userUpdateCount: session.userUpdates.length };
      signal.addEventListener("abort", abort, { once: true });
    }),
  );
}

export function recordEvidence(session: T, messages: readonly unknown[]): void {
  if (session.evidence) session.evidence.answer = Evidence.extractAnswer(messages);
}

export function closeEvidence(session: T, answer?: string): void {
  const pending = session.evidence;
  if (!pending) return;
  session.evidence = undefined;
  pending.signal.removeEventListener("abort", pending.abort);
  const updates = session.userUpdates.slice(pending.userUpdateCount);
  pending.resolve(
    [
      answer ?? pending.answer ?? "The implementer returned no evidence pointer.",
      ...updates.flatMap((update) => ["", `Authoritative user update during this dialog: ${update}`]),
    ].join("\n"),
  );
}

export function transition(session: T, state: Task.T): void {
  session.state = state;
}

export function attachChecker(session: T, checker: GoalChecker.T): void {
  session.checker = checker;
}

export function scheduleRetry(session: T, resume: () => void): void {
  if (session.state.phase !== "backoff" && session.state.phase !== "checker-retry") return;
  session.retrySubscription?.unsubscribe();
  session.retrySubscription = timer(session.state.delayMs)
    .pipe(takeUntil(fromEvent(session.controller.signal, "abort")))
    .subscribe(() => {
      session.retrySubscription = undefined;
      resume();
    });
}

export function dispose(session: T, checkerModule: GoalChecker.Operations): void {
  closeEvidence(session, "Task was cancelled.");
  session.controller.abort();
  cancelCheckerRun(session);
  cancelRetry(session);
  GoalStreamDisplay.clear(session.display);
  if (session.checker) void checkerModule.dispose(session.checker);
}
