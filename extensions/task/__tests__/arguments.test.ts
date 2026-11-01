import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vitest";
import * as TaskArgs from "../arguments.js";

describe("parseTaskArgs", () => {
  it.each([
    '--goal "implement and verify checkout"',
    "--goal 'implement and verify checkout'",
    '--goal="implement and verify checkout"',
    '-g "implement and verify checkout"',
    '-g="implement and verify checkout"',
  ])("accepts an explicit goal: %s", (input) => {
    expect(TaskArgs.parse(input)).toEqual(
      Result.succeed({
        checkerModel: undefined,
        defaults: false,
        implementerModel: undefined,
        kind: "goal",
        prompt: "implement and verify checkout",
      }),
    );
  });

  it("preserves whitespace and escaped quotes in the goal", () => {
    expect(
      TaskArgs.parse(String.raw`--goal "fix the \"cart\"  feature
and verify it"`),
    ).toEqual(
      Result.succeed({
        checkerModel: undefined,
        defaults: false,
        implementerModel: undefined,
        kind: "goal",
        prompt: 'fix the "cart"  feature\nand verify it',
      }),
    );
  });

  it("accepts flag-like goal text through the equals form", () => {
    expect(TaskArgs.parse('--goal="--repair the parser"')).toEqual(
      Result.succeed({
        checkerModel: undefined,
        defaults: false,
        implementerModel: undefined,
        kind: "goal",
        prompt: "--repair the parser",
      }),
    );
  });

  it("accepts independent model flags and defaults mode", () => {
    expect(
      TaskArgs.parse('--goal "repair checkout" --implementer-model openai/gpt-a --checker-model=anthropic/claude-b -d'),
    ).toEqual(
      Result.succeed({
        checkerModel: "anthropic/claude-b",
        defaults: true,
        implementerModel: "openai/gpt-a",
        kind: "goal",
        prompt: "repair checkout",
      }),
    );
  });

  it.each(["finish it", '--goal "finish" it', "--goal finish it"])("rejects positional arguments: %s", (input) => {
    expect(TaskArgs.parse(input)).toEqual(
      Result.fail('positional arguments are not supported; use --goal "<prompt>" and quote values containing spaces'),
    );
  });

  it.each(["--oracle", "--focus", "--verify true", "--limit 2", "--type goal", "--kind goal", "-t goal", "--"])(
    "rejects removed options: %s",
    (option) => {
      expect(Result.isFailure(TaskArgs.parse(`${option} --goal "finish it"`))).toBe(true);
    },
  );

  it.each(["--goal", "-g", "--goal=", '--goal ""', '--goal "   "', "--goal --help", "--goal --goal"])(
    "rejects missing or empty goal values: %s",
    (input) => {
      expect(TaskArgs.parse(input)).toEqual(Result.fail('--goal requires a non-empty value; use --goal "<prompt>"'));
    },
  );

  it.each([
    ["--goal work -g more", "--goal was specified more than once"],
    ["--goal work --checker-model a/x --checker-model b/y", "--checker-model was specified more than once"],
    ["--goal work --implementer-model", "--implementer-model requires a provider/model value"],
    ["--goal work --defaults=1", "--defaults does not take a value"],
    ['--goal "unfinished', 'unterminated " quote'],
    ["", '--goal is required; use --goal "<prompt>"'],
  ])("rejects malformed input: %s", (input, error) => {
    expect(TaskArgs.parse(input)).toEqual(Result.fail(error));
  });
});
