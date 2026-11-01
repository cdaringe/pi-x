import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface Request {
  readonly attempted: string;
  readonly criterion: string;
  readonly id: string;
  readonly question: string;
  readonly type: "task_evidence_request";
}

export const MAX_REQUESTS = 5;

export interface Response {
  readonly answer: string;
  readonly id: string;
  readonly type: "task_evidence_response";
}

const parameters = Type.Object({
  attempted: Type.String({
    description: "What you already inspected or ran",
    maxLength: 2000,
    minLength: 1,
  }),
  criterion: Type.String({
    description: "Checklist criterion needing evidence",
    maxLength: 1000,
    minLength: 1,
  }),
  question: Type.String({
    description: "One specific evidence question",
    maxLength: 2000,
    minLength: 1,
  }),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function parseRequest(value: unknown): Request | undefined {
  if (!isRecord(value) || value.type !== "task_evidence_request") return;
  if (
    typeof value.id !== "string" ||
    typeof value.criterion !== "string" ||
    typeof value.question !== "string" ||
    typeof value.attempted !== "string"
  )
    return;
  if (!value.criterion.trim() || !value.question.trim() || !value.attempted.trim()) return;
  return {
    attempted: value.attempted.trim().slice(0, 2000),
    criterion: value.criterion.trim().slice(0, 1000),
    id: value.id,
    question: value.question.trim().slice(0, 2000),
    type: "task_evidence_request",
  };
}

function parseResponse(value: unknown): Response | undefined {
  if (!isRecord(value) || value.type !== "task_evidence_response") return;
  if (typeof value.id !== "string" || typeof value.answer !== "string") return;
  return { answer: value.answer, id: value.id, type: "task_evidence_response" };
}

export const reply = (request: Request, answer: string): Response => ({
  answer,
  id: request.id,
  type: "task_evidence_response",
});

function readAssistantText(value: unknown): string | undefined {
  if (!isRecord(value) || value.role !== "assistant" || !("content" in value)) return;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return;
  return value.content
    .flatMap((part: unknown) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

export function extractAnswer(messages: readonly unknown[]): string {
  const answer = messages
    .map(readAssistantText)
    .filter((text): text is string => Boolean(text?.trim()))
    .at(-1)
    ?.trim();
  if (!answer) return "The implementer returned no evidence pointer.";
  return answer.length <= 8000
    ? answer
    : `Implementer reply truncated to final 8000 characters:\n${answer.slice(-8000)}`;
}

async function request(
  fields: Pick<Request, "criterion" | "question" | "attempted">,
  signal?: AbortSignal,
): Promise<string> {
  if (!process.send) return "Evidence dialog is unavailable. Decide from independently verified evidence.";
  const message: Request = {
    id: randomUUID(),
    type: "task_evidence_request",
    ...fields,
  };
  return new Promise<string>((resolve) => {
    const finish = (answer: string) => {
      process.off("message", receive);
      process.off("disconnect", disconnect);
      signal?.removeEventListener("abort", abort);
      resolve(answer);
    };
    const receive = (value: unknown) => {
      const response = parseResponse(value);
      if (response?.id === message.id) finish(response.answer);
    };
    const disconnect = () => finish("Evidence dialog disconnected. Treat this criterion as unresolved.");
    const abort = () => finish("Evidence dialog cancelled. Treat this criterion as unresolved.");
    process.on("message", receive);
    process.once("disconnect", disconnect);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      process.send?.(message);
    } catch {
      disconnect();
    }
  });
}

export function register(pi: ExtensionAPI): void {
  pi.registerTool({
    description:
      "Ask the implementer for a specific evidence pointer. Its reply is a claim, never proof; inspect the workspace and reproduce it before completing the goal.",
    async execute(_toolCallId, fields, signal) {
      const answer = await request(fields, signal);
      return {
        content: [
          {
            text: `Untrusted implementer reply. Verify independently before accepting any claim:\n${answer}`,
            type: "text",
          },
        ],
        details: {},
      };
    },
    executionMode: "sequential",
    label: "Request goal evidence",
    name: "request_goal_evidence",
    parameters,
  });
  pi.on("session_start", () => pi.setActiveTools([...new Set([...pi.getActiveTools(), "request_goal_evidence"])]));
}
