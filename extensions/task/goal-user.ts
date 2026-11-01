import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface T {
  readonly hint?: string;
  readonly kind: "confirm" | "input";
  readonly question: string;
}

const parameters = Type.Object({
  hint: Type.Optional(Type.String({ description: "Short input placeholder" })),
  kind: Type.Union([Type.Literal("confirm"), Type.Literal("input")]),
  question: Type.String({ description: "Specific question or action for the user", minLength: 1 }),
});

async function ask(ctx: ExtensionContext, request: T, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return "Goal task was stopped while waiting for the user.";
  if (!ctx.hasUI)
    return "User dialog is unavailable in this Pi mode. State what user action is needed and leave the goal incomplete.";
  if (request.kind === "confirm") {
    const confirmed = await ctx.ui.confirm("Goal task needs your action", request.question, { signal });
    return signal?.aborted
      ? "Goal task was stopped while waiting for the user."
      : confirmed
        ? `User confirmed: ${request.question}`
        : `User did not confirm: ${request.question}`;
  }
  const answer = await ctx.ui.input(request.question, request.hint, { signal });
  return signal?.aborted
    ? "Goal task was stopped while waiting for the user."
    : answer?.trim()
      ? `User replied: ${answer.trim()}`
      : "User dismissed the question without an answer.";
}

export function register(
  pi: ExtensionAPI,
  {
    getTaskSignal,
    recordAnswer,
  }: {
    getTaskSignal: () => AbortSignal | undefined;
    recordAnswer?: (request: T, answer: string, ctx: ExtensionContext) => void;
  },
): void {
  pi.registerTool({
    description:
      "Pause the current goal task run to ask the user for information or a physical action. Use confirm for actions such as turning on a device; use input for free-text details. Do not assume an action happened until the user confirms it.",
    async execute(_toolCallId, request, signal, _onUpdate, ctx) {
      const taskSignal = getTaskSignal();
      const answer = taskSignal
        ? await ask(ctx, request, signal ? AbortSignal.any([signal, taskSignal]) : taskSignal)
        : "No goal task is active. Ask the user in the normal conversation instead.";
      if (/^User (?:confirmed:|did not confirm:|replied:|dismissed)/.test(answer)) recordAnswer?.(request, answer, ctx);
      return { content: [{ text: answer, type: "text" }], details: { answer, request } };
    },
    executionMode: "sequential",
    label: "Ask goal task user",
    name: "task_ask_user",
    parameters,
  });
}
