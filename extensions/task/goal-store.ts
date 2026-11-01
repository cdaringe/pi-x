import { Result } from "@praha/byethrow";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface T {
  readonly createdAt: string;
  readonly cwd: string;
  readonly id: string;
  readonly models: { readonly implementer: string; readonly checker: string };
  readonly ownerPid: number;
  readonly prompt: string;
  readonly status: "running" | "paused";
  readonly updatedAt: string;
  readonly updates: readonly string[];
  readonly version: 1;
}

export interface Operations {
  readonly list: (cwd: string) => Result.Result<readonly T[], Error>;
  readonly remove: (id: string) => Result.Result<void, Error>;
  readonly write: (record: T) => Result.Result<void, Error>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTask = (value: unknown): value is T =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.id === "string" &&
  /^[0-9a-f-]{36}$/.test(value.id) &&
  typeof value.cwd === "string" &&
  typeof value.prompt === "string" &&
  Array.isArray(value.updates) &&
  value.updates.every((update: unknown) => typeof update === "string") &&
  isRecord(value.models) &&
  typeof value.models.implementer === "string" &&
  typeof value.models.checker === "string" &&
  (value.status === "running" || value.status === "paused") &&
  typeof value.ownerPid === "number" &&
  typeof value.createdAt === "string" &&
  typeof value.updatedAt === "string";

const normalizeError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export function create({ cwd, prompt, models }: { cwd: string; prompt: string; models: T["models"] }): T {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    cwd: resolve(cwd),
    id: randomUUID(),
    models,
    ownerPid: process.pid,
    prompt,
    status: "running",
    updatedAt: now,
    updates: [],
    version: 1,
  };
}

export function revise(record: T, changes: Partial<Pick<T, "updates" | "models" | "status">>): T {
  return { ...record, ...changes, ownerPid: process.pid, updatedAt: new Date().toISOString() };
}

export function find(records: readonly T[], prefix: string): Result.Result<T, Error> {
  const matches = records.filter((record) => record.id.startsWith(prefix));
  return matches.length === 1
    ? Result.succeed(matches[0])
    : Result.fail(new Error(matches.length ? `task ID ${prefix} is ambiguous` : `no resumable task matches ${prefix}`));
}

export function canResume(record: T): boolean {
  if (record.status === "paused") return true;
  try {
    process.kill(record.ownerPid, 0);
    return false;
  } catch (error) {
    return isRecord(error) && error.code === "ESRCH";
  }
}

export function format(record: T): string {
  const prompt = record.prompt.replace(/\s+/g, " ").slice(0, 42);
  const status = record.status === "running" && canResume(record) ? "interrupted" : record.status;
  return `${record.id.slice(0, 8)} · ${prompt} · ${status}`;
}

export function createOperations(directory = join(getAgentDir(), "task-goals")): Operations {
  const file = (id: string): string => join(directory, `${id}.json`);
  return {
    list: (cwd) =>
      Result.try({
        catch: normalizeError,
        try: (): readonly T[] =>
          existsSync(directory)
            ? readdirSync(directory)
                .filter((name) => name.endsWith(".json"))
                .flatMap((name) => {
                  const read = Result.try({
                    catch: normalizeError,
                    try: (): unknown => JSON.parse(readFileSync(join(directory, name), "utf8")),
                  });
                  return Result.isSuccess(read) && isTask(read.value) ? [read.value] : [];
                })
                .filter((record) => record.cwd === resolve(cwd))
                .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            : [],
      }),
    remove: (id) =>
      Result.try({
        catch: normalizeError,
        try: () => rmSync(file(id), { force: true }),
      }),
    write: (record) =>
      Result.try({
        catch: normalizeError,
        try: () => {
          mkdirSync(directory, { mode: 0o700, recursive: true });
          const temp = join(directory, `.${record.id}.${randomUUID()}.tmp`);
          try {
            writeFileSync(temp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
            renameSync(temp, file(record.id));
          } finally {
            rmSync(temp, { force: true });
          }
        },
      }),
  };
}
