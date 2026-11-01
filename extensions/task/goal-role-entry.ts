import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type T = Readonly<{
  edge: "start" | "end";
  kind: "work" | "evidence";
}>;

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg">;

const key = "task-implementer-boundary";

export function render(entry: T, width: number, theme: Theme): string[] {
  if (width < 1) return [];
  const label = entry.kind === "evidence" ? "IMPLEMENTER · EVIDENCE REPLY" : "IMPLEMENTER · WORK";
  const line = entry.edge === "start" ? `╭─ ${label} · PI TRANSCRIPT` : "╰─ IMPLEMENTER";
  return [truncateToWidth(theme.fg(entry.edge === "start" ? "success" : "muted", line), width)];
}

export function register(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<T>(key, (entry, _options, theme) => ({
    invalidate: () => undefined,
    render: (width) => render(entry.data ?? { edge: "start", kind: "work" }, width, theme),
  }));
}

export function mark(pi: ExtensionAPI, entry: T): void {
  pi.appendEntry<T>(key, entry);
}
