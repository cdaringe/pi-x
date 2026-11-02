import { match } from "ts-pattern";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Session from "./task-session.js";

export type T =
  | "goal-update"
  | "implementer"
  | "implementer-backoff"
  | "implementer-checking"
  | "implementer-evidence"
  | "implementer-retry";

const key = "task-input-route";

export function select(session: Pick<Session.T, "evidence" | "state">): T {
  if (session.evidence) return "implementer-evidence";
  return match(session.state)
    .with({ phase: "planning" }, () => "goal-update" as const)
    .with({ phase: "working" }, () => "implementer" as const)
    .with({ phase: "checking" }, () => "implementer-checking" as const)
    .with({ phase: "backoff" }, () => "implementer-backoff" as const)
    .with({ phase: "checker-retry", target: "planning" }, () => "goal-update" as const)
    .with({ phase: "checker-retry", target: "checking" }, () => "implementer-retry" as const)
    .exhaustive();
}

function format(route: T): { readonly detail: string; readonly recipient: string } {
  return match(route)
    .with("goal-update", () => ({ detail: "queued for the planner", recipient: "You → Goal update" }))
    .with("implementer", () => ({ detail: "main Pi conversation", recipient: "You → Implementer" }))
    .with("implementer-checking", () => ({
      detail: "sending interrupts evaluator verification",
      recipient: "You → Implementer",
    }))
    .with("implementer-evidence", () => ({
      detail: "evaluator waits for the implementer's evidence reply",
      recipient: "You → Implementer",
    }))
    .with("implementer-backoff", () => ({
      detail: "sending resumes work now",
      recipient: "You → Implementer",
    }))
    .with("implementer-retry", () => ({
      detail: "sending cancels the evaluator retry",
      recipient: "You → Implementer",
    }))
    .exhaustive();
}

export function show(ctx: ExtensionContext, route: T): void {
  if (!ctx.hasUI) return;
  const { detail, recipient } = format(route);
  const label = `${ctx.ui.theme.fg("accent", recipient)}${ctx.ui.theme.fg("muted", ` · ${detail}`)}`;
  if (ctx.mode === "tui") ctx.ui.setWidget(key, [label], { placement: "belowEditor" });
  else ctx.ui.setStatus(key, label);
}

export function clear(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (ctx.mode === "tui") ctx.ui.setWidget(key, undefined);
  else ctx.ui.setStatus(key, undefined);
}
