import { Result } from "@praha/byethrow";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { getPackageDir, parseArgs } from "@earendil-works/pi-coding-agent";

export interface T {
  readonly args: readonly string[];
  readonly command: string;
}

// Use this host's installation, never an unrelated `pi` found on PATH.
function resolveHostRaw(execPath = process.execPath): T {
  if (!/^(node|bun)(\.exe)?$/i.test(basename(execPath))) return { args: [], command: execPath };
  const cli = join(getPackageDir(), "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("Cannot locate this host's Pi CLI");
  return { args: [cli], command: execPath };
}

/**
 * Inherit only resource and restriction flags. Forwarding the host's prompt,
 * session target, or one-shot action would give the checker unrelated work.
 * Resolve relative resources against the host's launch directory.
 */
function inheritArgsRaw({
  argv,
  cwd,
  currentProvider,
  startupProvider,
}: {
  argv: string[];
  cwd: string;
  currentProvider?: string;
  startupProvider?: string;
}): string[] {
  const parsed = parseArgs(argv);
  if (parsed.diagnostics.some((item) => item.type === "error")) {
    throw new Error("Cannot safely inherit invalid Pi launch arguments");
  }
  const args: string[] = [];
  const appendValue = (flag: string, data: string | undefined) => {
    if (data !== undefined) args.push(flag, data);
  };
  const resolveResource = (input: string) => {
    if (/^(builtin:|npm:|git:|https?:|~)/.test(input) || isAbsolute(input)) return input;
    return resolve(cwd, input);
  };
  const resolvePromptValue = (input: string) => (existsSync(resolve(cwd, input)) ? resolve(cwd, input) : input);
  if (parsed.apiKey) {
    /**
     * A CLI API key is scoped to the startup provider. The foreground agent
     * may switch providers, so inheriting the key after a switch could expose
     * it to the wrong provider.
     */
    const keyProvider = startupProvider ?? parsed.provider;
    if (!keyProvider || !currentProvider)
      throw new Error("Cannot safely scope the inherited CLI API key to a provider");
    if (keyProvider === currentProvider) appendValue("--api-key", parsed.apiKey);
  }
  appendValue(
    "--system-prompt",
    parsed.systemPrompt === undefined ? undefined : resolvePromptValue(parsed.systemPrompt),
  );
  for (const prompt of parsed.appendSystemPrompt ?? [])
    appendValue("--append-system-prompt", resolvePromptValue(prompt));
  for (const [flag, items] of [
    ["--extension", parsed.extensions],
    ["--skill", parsed.skills],
    ["--prompt-template", parsed.promptTemplates],
    ["--theme", parsed.themes],
  ] as const)
    for (const item of items ?? []) appendValue(flag, resolveResource(item));
  for (const [flag, enabled] of [
    ["--no-extensions", parsed.noExtensions],
    ["--no-mcp", parsed.noMcp],
    ["--no-tools", parsed.noTools],
    ["--no-builtin-tools", parsed.noBuiltinTools],
    ["--no-skills", parsed.noSkills],
    ["--no-prompt-templates", parsed.noPromptTemplates],
    ["--no-themes", parsed.noThemes],
    ["--no-context-files", parsed.noContextFiles],
    ["--offline", parsed.offline],
  ] as const)
    if (enabled) args.push(flag);
  if (parsed.tools) appendValue("--tools", parsed.tools.join(","));
  if (parsed.excludeTools) appendValue("--exclude-tools", parsed.excludeTools.join(","));
  if (parsed.projectTrustOverride !== undefined) args.push(parsed.projectTrustOverride ? "--approve" : "--no-approve");
  for (const [name, data] of parsed.unknownFlags) {
    /**
     * Unknown extension flags can contain credentials. Preserve their parsed
     * values for the child without including them in diagnostics or status.
     */
    args.push(typeof data === "string" ? `--${name}=${data}` : `--${name}`);
  }
  return args;
}

const normalizeError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
export const resolveHost = Result.fn({
  catch: normalizeError,
  try: resolveHostRaw,
});
export const inheritArgs = Result.fn({
  catch: normalizeError,
  try: inheritArgsRaw,
});
