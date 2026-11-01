import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vitest";
import * as GoalDecision from "../goal-decision.js";

describe("GoalDecision.parse", () => {
  it("accepts strict JSON", () => {
    expect(GoalDecision.parse('{"complete":false,"feedback":"The typecheck still fails."}')).toEqual(
      Result.succeed({
        complete: false,
        feedback: "The typecheck still fails.",
      }),
    );
  });

  it("accepts one whole-response JSON fence", () => {
    expect(GoalDecision.parse('```json\n{"complete":true,"feedback":"All checklist items verified."}\n```')).toEqual(
      Result.succeed({
        complete: true,
        feedback: "All checklist items verified.",
      }),
    );
  });

  it("rejects an incomplete decision without actionable feedback", () => {
    expect(GoalDecision.parse('{"complete":false,"feedback":""}')).toEqual(
      Result.fail("goal checker did not return a valid completion decision"),
    );
  });

  it.each([
    'Evaluation result: {"complete":true,"feedback":"Looks good."}',
    '{"complete":true,"feedback":"Looks good."}\n{"complete":false,"feedback":"Actually no."}',
    '```json\n{"complete":true,"feedback":"Looks good."}\n```\nExtra commentary',
    '{"complete":true,"feedback":"Looks good.","example":{"complete":false}}',
    '{"complete":true,"feedback":""}',
  ])("rejects ambiguous or malformed output: %s", (output) => {
    expect(GoalDecision.parse(output)).toEqual(Result.fail("goal checker did not return a valid completion decision"));
  });
});
