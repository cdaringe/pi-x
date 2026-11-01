import { Result } from "@praha/byethrow";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as TaskArgs from "./arguments.js";
import * as ChoicePicker from "./choice-picker.js";

type Model = NonNullable<ExtensionContext["model"]>;

export interface T {
  readonly checker: Model;
  readonly implementer: Model;
  readonly original?: Model;
}

export const format = (model: Model): string => `${model.provider}/${model.id}`;

export const matches = (left: Model | undefined, right: Model): boolean =>
  left?.provider === right.provider && left.id === right.id;

function list(ctx: ExtensionContext, preferred?: Model): readonly Model[] {
  const available = ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }) => model)
    : ctx.modelRegistry.getAvailable();
  return [
    ...new Map(
      [preferred, ...available]
        .filter((model): model is Model => model !== undefined)
        .map((model) => [format(model), model]),
    ).values(),
  ];
}

async function chooseOne({
  ctx,
  role,
  reference,
  preferred,
  defaults,
  signal,
}: {
  ctx: ExtensionContext;
  role: "implementer" | "checker";
  reference?: string;
  preferred?: Model;
  defaults: boolean;
  signal: AbortSignal;
}): Promise<Result.Result<Model, Error>> {
  const models = list(ctx, preferred);
  if (reference) {
    const chosen = models.find((model) => format(model) === reference);
    return chosen
      ? Result.succeed(chosen)
      : Result.fail(new Error(`${role} model ${JSON.stringify(reference)} is unavailable`));
  }
  if (defaults)
    return preferred ? Result.succeed(preferred) : Result.fail(new Error(`no default ${role} model is available`));
  if (!ctx.hasUI) return Result.fail(new Error(`select a ${role} model with --${role}-model or pass -d`));
  const choices = models.map(format);
  if (!choices.length) return Result.fail(new Error(`no ${role} models are available`));
  try {
    const title = preferred ? `Select ${role} model (default: ${format(preferred)})` : `Select ${role} model`;
    const choice = await ChoicePicker.choose({
      choices,
      ctx,
      searchPlaceholder: "provider/model",
      searchTitle: "Search model IDs",
      signal,
      title,
    });
    const chosen = models.find((model) => format(model) === choice);
    return chosen ? Result.succeed(chosen) : Result.fail(new Error("model selection cancelled"));
  } catch (error) {
    return Result.fail(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function choose({
  args,
  ctx,
  signal,
}: {
  args: TaskArgs.T;
  ctx: ExtensionContext;
  signal: AbortSignal;
}): Promise<Result.Result<T, Error>> {
  const implementer = await chooseOne({
    ctx,
    defaults: args.defaults,
    preferred: ctx.model,
    reference: args.implementerModel,
    role: "implementer",
    signal,
  });
  if (Result.isFailure(implementer)) return implementer;
  const checker = await chooseOne({
    ctx,
    defaults: args.defaults,
    preferred: implementer.value,
    reference: args.checkerModel,
    role: "checker",
    signal,
  });
  return Result.isFailure(checker)
    ? checker
    : Result.succeed({
        checker: checker.value,
        implementer: implementer.value,
        original: ctx.model,
      });
}
