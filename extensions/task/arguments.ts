import { Result } from "@praha/byethrow";
export interface T {
  readonly checkerModel?: string;
  readonly defaults: boolean;
  readonly implementerModel?: string;
  readonly kind: "goal";
  readonly prompt: string;
}

export type ParseResult = Result.Result<T, string>;

type TokenizeResult = Result.Result<readonly string[], string>;

// Small shell-like tokenizer for quoted flag values. It does not expand variables.
function tokenize(input: string): TokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = undefined;
        started = true;
      } else if (char === "\\" && quote === '"') {
        index += 1;
        if (index >= input.length) return Result.fail("unfinished escape sequence");
        current += input[index];
        started = true;
      } else {
        current += char;
        started = true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      index += 1;
      if (index >= input.length) return Result.fail("unfinished escape sequence");
      current += input[index];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) return Result.fail(`unterminated ${quote} quote`);
  if (started) tokens.push(current);
  return Result.succeed(tokens);
}

export function parse(input: string): ParseResult {
  const tokenized = tokenize(input.trim());
  if (Result.isFailure(tokenized)) return tokenized;
  const tokens = tokenized.value;

  let prompt: string | undefined;
  let implementerModel: string | undefined;
  let checkerModel: string | undefined;
  let defaults = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equal = token.indexOf("=");
    const name = equal >= 0 ? token.slice(0, equal) : token;
    if (name === "--defaults" || name === "-d") {
      if (equal >= 0) return Result.fail(`${name} does not take a value`);
      if (defaults) return Result.fail("--defaults was specified more than once");
      defaults = true;
      continue;
    }
    if (name !== "--goal" && name !== "-g" && name !== "--implementer-model" && name !== "--checker-model") {
      return Result.fail(
        token.startsWith("-")
          ? `unknown flag ${JSON.stringify(name)}`
          : 'positional arguments are not supported; use --goal "<prompt>" and quote values containing spaces',
      );
    }
    const field = name === "--goal" || name === "-g" ? "goal" : name;
    if (
      (field === "goal" && prompt !== undefined) ||
      (field === "--implementer-model" && implementerModel !== undefined) ||
      (field === "--checker-model" && checkerModel !== undefined)
    )
      return Result.fail(`${field === "goal" ? "--goal" : field} was specified more than once`);

    let value: string | undefined;
    if (equal >= 0) {
      value = token.slice(equal + 1);
    } else {
      value = tokens[index + 1];
      if (value?.startsWith("-")) value = undefined;
      index += 1;
    }
    if (!value?.trim())
      return Result.fail(
        field === "goal"
          ? '--goal requires a non-empty value; use --goal "<prompt>"'
          : `${field} requires a provider/model value`,
      );
    if (field === "goal") prompt = value.trim();
    else if (field === "--implementer-model") implementerModel = value.trim();
    else checkerModel = value.trim();
  }

  if (prompt === undefined) return Result.fail('--goal is required; use --goal "<prompt>"');

  return Result.succeed({
    checkerModel,
    defaults,
    implementerModel,
    kind: "goal",
    prompt,
  });
}
