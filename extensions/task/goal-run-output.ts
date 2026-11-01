import { Result } from "@praha/byethrow";

interface Assistant {
  readonly errorMessage?: string;
  readonly stopReason?: string;
  readonly text: string;
}

export interface T {
  readonly aborted: boolean;
  readonly assistant?: Assistant;
  readonly settled: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTextPart = (value: unknown): value is { type: "text"; text: string } =>
  isRecord(value) && value.type === "text" && typeof value.text === "string";

function readAssistant(message: unknown): Assistant | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(isTextPart)
            .map((part) => part.text)
            .join("")
        : "";
  return {
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    text,
  };
}

export const create = (): T => ({ aborted: false, settled: false });

export function accept(output: T, event: unknown): T {
  if (!isRecord(event)) return output;
  if (event.type === "agent_settled") return { ...output, aborted: event.aborted === true, settled: true };
  const assistant = event.type === "message_end" ? readAssistant(event.message) : undefined;
  return assistant ? { ...output, assistant } : output;
}

export function finish(output: T): Result.Result<string, Error> {
  if (!output.settled) return Result.fail(new Error("goal checker exited before Pi settled"));
  if (output.aborted) return Result.fail(new Error("goal checker run was aborted"));
  const assistant = output.assistant;
  if (!assistant) return Result.fail(new Error("goal checker returned no final assistant message"));
  if (assistant.stopReason !== "stop")
    return Result.fail(
      new Error(assistant.errorMessage ?? `goal checker ended with ${assistant.stopReason ?? "unknown"}`),
    );
  return assistant.text.trim()
    ? Result.succeed(assistant.text)
    : Result.fail(new Error("goal checker returned no final response"));
}
