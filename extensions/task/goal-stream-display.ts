import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { match } from "ts-pattern";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type * as GoalChecker from "./goal-checker.js";

type Part = Readonly<{ id?: string; text: string; type: "line" | "result" | "text" }>;
export type Role = "none" | "implementer" | "evaluator" | "dialog";
type Theme = Pick<ExtensionContext["ui"]["theme"], "fg">;

export interface State {
  readonly active: Role;
  readonly checkerVisible: boolean;
  readonly frame: number;
  readonly history?: Readonly<{ parts: readonly Part[]; workerParts: readonly Part[] }>;
  readonly parts: readonly Part[];
  readonly phase: GoalChecker.Phase;
  readonly reveal: number;
  readonly scroll: number;
  readonly workerParts: readonly Part[];
}

// Timer and render callback belong to the UI boundary; state transitions stay pure.
export interface T {
  animation?: ReturnType<typeof setInterval>;
  readonly ctx: ExtensionContext;
  requestRender?: () => void;
  state: State;
  timer?: ReturnType<typeof setTimeout>;
  viewportRows?: number;
}

const key = "task-goal-stream";
const frames = ["◐", "◓", "◑", "◒"];
const MAX_PARTS = 120;

export const createState = (): State => ({
  active: "none",
  checkerVisible: false,
  frame: 0,
  history: undefined,
  parts: [],
  phase: "planning",
  reveal: 0,
  scroll: 0,
  workerParts: [],
});

export function create(ctx: ExtensionContext): T {
  const display: T = { ctx, state: createState() };
  if (ctx.mode === "tui")
    ctx.ui.setWidget(key, (tui, theme) => {
      display.requestRender = () => tui.requestRender();
      return {
        handleMouse: (event) => {
          if (event.type !== "wheel" || !event.wheelDelta || !display.state.checkerVisible) return undefined;
          scroll(display, -event.wheelDelta);
          return { handled: true };
        },
        invalidate: () => undefined,
        render: (width) => {
          display.viewportRows = Math.max(4, tui.terminal.rows - 12);
          return render({
            height: display.viewportRows,
            markdownTheme: getMarkdownTheme(),
            mouseWheel: tui.mode === "fullscreen",
            state: display.state,
            theme,
            width,
          });
        },
      };
    });
  return display;
}

function appendText(parts: readonly Part[], text: string): readonly Part[] {
  const last = parts.at(-1);
  return last?.type === "text"
    ? [...parts.slice(0, -1), { text: (last.text + text).slice(-12000), type: "text" }]
    : [...parts, { text: text.slice(-12000), type: "text" as const }].slice(-MAX_PARTS);
}

function recordToolOutput(parts: readonly Part[], update: GoalChecker.Update): readonly Part[] {
  const part: Part = { ...(update.id ? { id: update.id } : {}), text: update.text, type: "result" };
  const index = update.id ? parts.findIndex((item) => item.id === update.id) : -1;
  return index < 0
    ? [...parts, part].slice(-MAX_PARTS)
    : parts.map((item, position) => (position === index ? part : item));
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
      parts: [...parts, { text: `→ ${text}`, type: "line" as const }].slice(-MAX_PARTS),
      phase,
    }))
    .with({ type: "result" }, (result) => ({
      ...state,
      parts: recordToolOutput(parts, result),
      phase: result.phase,
    }))
    .with({ type: "checklist" }, ({ phase, text }) => ({
      ...state,
      parts: [...parts, { text: "Checklist:", type: "line" as const }, { text, type: "text" as const }].slice(
        -MAX_PARTS,
      ),
      phase,
    }))
    .with({ type: "status" }, ({ phase, text }) => ({
      ...state,
      parts: [...parts, { text: `${text}…`, type: "line" as const }].slice(-MAX_PARTS),
      phase,
    }))
    .exhaustive();
}

export const focus = (state: State, active: Role): State => ({
  ...state,
  active,
  checkerVisible: active === "dialog" || (active === "evaluator" && state.active !== "dialog" && state.checkerVisible),
  frame: 0,
  history: undefined,
  reveal: 0,
  scroll: 0,
  workerParts:
    (active === "implementer" && state.active !== "implementer") || (active === "dialog" && state.active !== "dialog")
      ? []
      : state.workerParts,
});

export const recordWorkerText = (state: State, text: string): State => ({
  ...state,
  workerParts: appendText(state.workerParts, text).slice(-MAX_PARTS),
});

const recordWorkerTool = (state: State, text: string): State => ({
  ...state,
  workerParts: [...state.workerParts, { text, type: "line" as const }].slice(-MAX_PARTS),
});

export function moveScroll(state: State, lines: number): State {
  const scroll = Math.max(0, state.scroll + lines);
  return {
    ...state,
    history: scroll ? (state.history ?? { parts: state.parts, workerParts: state.workerParts }) : undefined,
    scroll,
  };
}

const toggleEvaluator = (state: State): State => ({ ...state, checkerVisible: !state.checkerVisible });

function renderLines({
  height,
  markdownTheme,
  parts,
  scroll,
  width,
}: {
  height: number;
  markdownTheme?: MarkdownTheme;
  parts: readonly Part[];
  scroll: number;
  width: number;
}): string[] {
  const lines = parts.flatMap((part) =>
    part.type === "text" && markdownTheme
      ? new Markdown(part.text, 0, 0, markdownTheme).render(Math.max(1, width))
      : part.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))),
  );
  const end = Math.max(Math.min(height, lines.length), lines.length - scroll);
  return lines.slice(Math.max(0, end - height), end);
}

function renderPanel({
  active,
  height,
  markdownTheme,
  parts,
  state,
  theme,
  title,
  width,
}: {
  active: boolean;
  height: number;
  markdownTheme?: MarkdownTheme;
  parts: readonly Part[];
  state: State;
  theme: Theme;
  title: string;
  width: number;
}): string[] {
  const indicator = active ? `${frames[state.frame % frames.length]} ` : "○ ";
  const color = active ? (title === "Implementer" ? "success" : "accent") : "muted";
  const heading = theme.fg(color, `${indicator}${title}`);
  const lines = renderLines({ height: height - 1, markdownTheme, parts, scroll: state.scroll, width });
  const visible = active ? (state.reveal ? lines : []) : lines;
  const rendered = [truncateToWidth(heading, width), ...visible.map((line) => truncateToWidth(line, width))];
  return [...rendered, ...Array.from({ length: Math.max(0, height - rendered.length) }, () => "")];
}

function renderColumns({
  height,
  markdownTheme,
  state,
  theme,
  width,
}: {
  height: number;
  markdownTheme?: MarkdownTheme;
  state: State;
  theme: Theme;
  width: number;
}): string[] {
  const divider = " │ ";
  const leftWidth = Math.floor((width - visibleWidth(divider)) / 2);
  const rightWidth = width - leftWidth - visibleWidth(divider);
  const left = renderPanel({
    active: true,
    height,
    markdownTheme,
    parts: state.history?.workerParts ?? state.workerParts,
    state,
    theme,
    title: "Implementer",
    width: leftWidth,
  });
  const right = renderPanel({
    active: false,
    height,
    markdownTheme,
    parts: state.history?.parts ?? state.parts,
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

export function render({
  height,
  markdownTheme,
  mouseWheel = false,
  state,
  theme,
  width,
}: {
  height: number;
  markdownTheme?: MarkdownTheme;
  mouseWheel?: boolean;
  state: State;
  theme: Theme;
  width: number;
}): string[] {
  if (width < 1 || (state.active === "none" && !state.checkerVisible)) return [];
  if (!state.checkerVisible) return [];
  const activity =
    state.active === "implementer" || state.active === "none"
      ? `Evaluator idle · ${state.scroll ? "History" : "last run"}`
      : state.scroll
        ? "History"
        : "Live";
  const heading = truncateToWidth(
    theme.fg("muted", `${activity} · ${mouseWheel ? "Wheel / " : ""}Alt+PgUp/PgDn page · Ctrl+Alt+E close`),
    width,
  );
  if (state.active === "dialog")
    return [
      truncateToWidth(theme.fg("muted", "Evidence exchange · Implementer answering · Evaluator waiting"), width),
      heading,
      ...(width >= 72
        ? renderColumns({ height: height - 2, markdownTheme, state, theme, width })
        : [
            ...renderPanel({
              active: true,
              height: Math.floor((height - 2) / 2),
              markdownTheme,
              parts: state.history?.workerParts ?? state.workerParts,
              state,
              theme,
              title: "Implementer",
              width,
            }),
            ...renderPanel({
              active: false,
              height: Math.ceil((height - 2) / 2),
              markdownTheme,
              parts: state.history?.parts ?? state.parts,
              state,
              theme,
              title: "Evaluator",
              width,
            }),
          ]),
    ];
  return [
    heading,
    ...renderPanel({
      active: state.active === "evaluator",
      height: height - 1,
      markdownTheme,
      parts: state.history?.parts ?? state.parts,
      state,
      theme,
      title: "Evaluator",
      width,
    }),
  ];
}

function updateStatus(display: T): void {
  if (!display.ctx.hasUI) return;
  const control = display.ctx.mode === "tui" ? "Ctrl+Alt+E" : "/task --evaluator";
  const indicator = frames[display.state.frame % frames.length];
  const label = match(display.state.active)
    .with(
      "implementer",
      () => `${indicator} Active: Implementer · Evaluator idle ${display.state.checkerVisible ? "▾" : "▸"} ${control}`,
    )
    .with(
      "evaluator",
      () => `${indicator} Active: Evaluator running ${display.state.checkerVisible ? "▾" : "▸"} ${control}`,
    )
    .with("dialog", () => `${indicator} Active: Implementer answering · ○ Evaluator waiting`)
    .with("none", () => `Evaluator idle ${display.state.checkerVisible ? "▾" : "▸"} ${control}`)
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
    const lines = render({ height: 10, state: display.state, theme: display.ctx.ui.theme, width: 80 });
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

export function showWorkerTool(display: T, text: string): void {
  if (!display.ctx.hasUI || display.state.active !== "dialog") return;
  display.state = recordWorkerTool(display.state, text);
  if (!display.timer) display.timer = setTimeout(() => flush(display), 40);
  display.timer?.unref?.();
}

export function scroll(display: T, lines: number): void {
  if (!display.ctx.hasUI || !display.state.checkerVisible) return;
  display.state = moveScroll(display.state, lines);
  flush(display);
}

export function scrollPage(display: T, direction: "down" | "up"): void {
  const lines = Math.max(1, (display.viewportRows ?? 12) - 3);
  scroll(display, direction === "up" ? lines : -lines);
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
