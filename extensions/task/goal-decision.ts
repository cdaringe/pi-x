import { Result } from "@praha/byethrow";
export type T = Readonly<{ complete: true; feedback: string } | { complete: false; feedback: string }>;

export type ParseResult = Result.Result<T, string>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const INVALID_DECISION = "goal checker did not return a valid completion decision";

function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parse(text: string): ParseResult {
  const parsed = Result.try({
    catch: () => INVALID_DECISION,
    try: (): unknown => JSON.parse(unwrapFence(text)),
  });
  if (Result.isFailure(parsed)) return Result.fail(INVALID_DECISION);
  const value = parsed.value;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.complete !== "boolean" ||
    typeof value.feedback !== "string" ||
    !value.feedback.trim()
  )
    return Result.fail(INVALID_DECISION);
  const feedback = value.feedback.trim();
  return Result.succeed(value.complete ? { complete: true, feedback } : { complete: false, feedback });
}
