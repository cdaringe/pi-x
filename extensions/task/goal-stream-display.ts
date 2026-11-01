import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { match } from "ts-pattern";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as GoalChecker from "./goal-checker.js";

type Part = Readonly<{ text: string; type: "line" | "text" }>;
export type Role = "none" | "implementer" | "evaluator" | "dialog";
type Theme = Pick<ExtensionContext["ui"]["theme"], "fg">;

export interface State {
  readonly active: Role;
  readonly checkerVisible: boolean;
  readonly frame: number;
  readonly parts: readonly Part[];
  readonly phase: GoalChecker.Phase;
  readonly reveal: number;
  readonly workerParts: readonly Part[];
}

// Timer and render callback belong to the UI boundary; state transitions stay pure.
export interface T {
  animation?: ReturnType<typeof setInterval>;
  readonly ctx: ExtensionContext;
  requestRender?: () => void;
  state: State;
  timer?: ReturnType<typeof setTimeout>;
}

const key = "task-goal-stream";
const frames = ["◐", "◓", "◑", "◒"];

export const createState = (): State => ({
  active: "none",
  checkerVisible: false,
  frame: 0,
  parts: [],
  phase: "planning",
  reveal: 0,
  workerParts: [],
});

export function create(ctx: ExtensionContext): T {
  const display: T = { ctx, state: createState() };
  if (ctx.mode === "tui")
    ctx.ui.setWidget(key, (tui, theme) => {
      display.requestRender = () => tui.requestRender();
      return {
        invalidate: () => undefined,
        render: (width) => render(display.state, width, theme),
      };
    });
  return display;
}

function appendText(parts: readonly Part[], text: string): readonly Part[] {
  const last = parts.at(-1);
  return last?.type === "text"
    ? [...parts.slice(0, -1), { text: (last.text + text).slice(-12000), type: "text" }]
    : [...parts, { text: text.slice(-12000), type: "text" }];
}

export function applyUpdate(state: State, update: GoalChecker.Update): State {
  const parts: readonly Part[] =
    update.phase === state.phase ? state.parts : [...state.parts, { text: "", type: "line" }];
  return match(update)
    .with({ type: "text" }, ({ phase, text }) => ({
      ...state,
      parts: appendText(parts, text),
      phase,
    }))
    .with({ type: "tool" }, ({ phase, text }) => ({
      ...state,
      parts: [...parts, { text: `→ ${text}`, type: "line" as const }].slice(-50),
      phase,
    }))
    .with({ type: "checklist" }, ({ phase, text }) => ({
      ...state,
      parts: [
        { text: "Checklist:", type: "line" as const },
        { text, type: "text" as const },
      ],
      phase,
    }))
    .with({ type: "status" }, ({ phase, text }) => ({
      ...state,
      parts: [...parts, { text: `${text}…`, type: "line" as const }].slice(-50),
      phase,
    }))
    .exhaustive();
}

export const focus = (state: State, active: Role): State => ({
  ...state,
  active,
  checkerVisible: active === "dialog" || (active !== "none" && state.active !== "dialog" && state.checkerVisible),
  frame: 0,
  reveal: 0,
  workerParts:
    (active === "implementer" && state.active !== "implementer") || (active === "dialog" && state.active !== "dialog")
      ? []
      : state.workerParts,
});

export const recordWorkerText = (state: State, text: string): State => ({
  ...state,
  workerParts: appendText(state.workerParts, text).slice(-50),
});

const toggleEvaluator = (state: State): State => ({ ...state, checkerVisible: !state.checkerVisible });

function renderLines(parts: readonly Part[], width: number): string[] {
  return parts
    .flatMap((part) => part.text.split("\n"))
    .slice(-10)
    .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))
    .slice(-7);
}

function renderPanel({
  active,
  parts,
  state,
  theme,
  title,
  width,
}: {
  active: boolean;
  parts: readonly Part[];
  state: State;
  theme: Theme;
  title: string;
  width: number;
}): string[] {
  const indicator = active ? `${frames[state.frame % frames.length]} ` : "○ ";
  const color = active ? (title === "Implementer" ? "success" : "accent") : "muted";
  const heading = theme.fg(color, `${indicator}${title}`);
  const lines = renderLines(parts, width);
  const visible = active ? (state.reveal ? lines.slice(-state.reveal) : []) : lines;
  return [truncateToWidth(heading, width), ...visible.map((line) => truncateToWidth(line, width))];
}

function renderColumns(state: State, width: number, theme: Theme): string[] {
  const divider = " │ ";
  const leftWidth = Math.floor((width - visibleWidth(divider)) / 2);
  const rightWidth = width - leftWidth - visibleWidth(divider);
  const left = renderPanel({
    active: true,
    parts: state.workerParts,
    state,
    theme,
    title: "Implementer",
    width: leftWidth,
  });
  const right = renderPanel({
    active: false,
    parts: state.parts,
    state,
    theme,
    title: "Evaluator",
    width: rightWidth,
  });
  return Array.from(
    { length: Math.max(left.length, right.length) },
    (_, index) =>
      `${truncateToWidth(left[index] ?? "", leftWidth, "", true)}${theme.fg("muted", divider)}${right[index] ?? ""}`,
  );
}

export function render(state: State, width: number, theme: Theme): string[] {
  if (width < 1 || (state.active === "none" && !state.checkerVisible)) return [];
  if (state.active === "dialog")
    return [
      truncateToWidth(theme.fg("muted", "Evidence exchange · Implementer answering · Evaluator waiting"), width),
      ...(width >= 72
        ? renderColumns(state, width, theme)
        : [
            ...renderPanel({ active: true, parts: state.workerParts, state, theme, title: "Implementer", width }),
            ...renderPanel({ active: false, parts: state.parts, state, theme, title: "Evaluator", width }),
          ]),
    ];
  return state.checkerVisible
    ? renderPanel({ active: state.active === "evaluator", parts: state.parts, state, theme, title: "Evaluator", width })
    : [];
}

function updateStatus(display: T): void {
  if (!display.ctx.hasUI) return;
  const control = display.ctx.mode === "tui" ? "Ctrl+Alt+E" : "/task --evaluator";
  const indicator = frames[display.state.frame % frames.length];
  const label = match(display.state.active)
    .with(
      "implementer",
      () => `${indicator} Implementer · Evaluator ${display.state.checkerVisible ? "▾" : "▸"} ${control}`,
    )
    .with("evaluator", () => `${indicator} Evaluator ${display.state.checkerVisible ? "▾" : "▸"} ${control}`)
    .with("dialog", () => `${indicator} Implementer answering · ○ Evaluator waiting`)
    .with("none", () => `Evaluator ${display.state.checkerVisible ? "▾" : "▸"} ${control}`)
    .exhaustive();
  display.ctx.ui.setStatus(
    "task-roles",
    display.ctx.ui.theme.fg(display.state.active === "none" ? "muted" : "accent", label),
  );
}

function tick(display: T): void {
  display.state = {
    ...display.state,
    frame: display.state.frame + 1,
    reveal: Math.min(display.state.reveal + 1, 7),
  };
  updateStatus(display);
  display.requestRender?.();
}

function animate(display: T): void {
  clearInterval(display.animation);
  display.animation = undefined;
  if (display.ctx.mode !== "tui" || display.state.active === "none") return;
  display.animation = setInterval(() => tick(display), 120);
  display.animation.unref?.();
}

export function flush(display: T): void {
  clearTimeout(display.timer);
  display.timer = undefined;
  if (!display.ctx.hasUI) return;
  if (display.ctx.mode === "tui") display.requestRender?.();
  else {
    const lines = render(display.state, 80, display.ctx.ui.theme);
    display.ctx.ui.setWidget(key, lines.length ? lines : undefined);
  }
}

export function showRole(display: T, role: Role): void {
  if (!display.ctx.hasUI || display.state.active === role) return;
  const focused = focus(display.state, role);
  display.state = display.ctx.mode === "tui" ? focused : { ...focused, reveal: 7 };
  updateStatus(display);
  animate(display);
  flush(display);
}

export function showWorkerText(display: T, text: string): void {
  if (!display.ctx.hasUI || display.state.active !== "dialog") return;
  display.state = recordWorkerText(display.state, text);
  if (!display.timer) display.timer = setTimeout(() => flush(display), 40);
  display.timer?.unref?.();
}

export function update(display: T, update: GoalChecker.Update): void {
  if (!display.ctx.hasUI) return;
  display.state = applyUpdate(display.state, update);
  if (update.type === "checklist") return flush(display);
  if (!display.timer) display.timer = setTimeout(() => flush(display), 40);
  display.timer?.unref?.();
}

export function toggle(display: T): void {
  if (!display.ctx.hasUI) return;
  display.state = toggleEvaluator(display.state);
  updateStatus(display);
  flush(display);
}

export function clear(display: T): void {
  clearTimeout(display.timer);
  clearInterval(display.animation);
  display.timer = undefined;
  display.animation = undefined;
  if (display.ctx.hasUI) {
    display.ctx.ui.setStatus("task-roles", undefined);
    display.ctx.ui.setWidget(key, undefined);
  }
}
