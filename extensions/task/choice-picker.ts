import {
  Input,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  type SelectItem,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

export interface Config {
  readonly choices: readonly string[];
  readonly ctx: ExtensionContext;
  readonly searchPlaceholder?: string;
  readonly searchTitle?: string;
  readonly signal: AbortSignal;
  readonly title: string;
}

const fitRows = (terminalRows: number, choiceCount: number): number =>
  Math.max(1, Math.min(choiceCount, terminalRows - 7));

const filterChoices = (choices: readonly string[], query: string): readonly string[] =>
  choices.filter((choice) => choice.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

function createList({
  choices,
  done,
  theme,
  visible,
}: {
  choices: readonly string[];
  done: (value: string | undefined) => void;
  theme: Theme;
  visible: number;
}): SelectList {
  const items: SelectItem[] = choices.map((value) => ({ label: value, value }));
  const list = new SelectList(items, visible, {
    description: (text) => theme.fg("muted", text),
    noMatch: () => theme.fg("warning", "  No matching choices"),
    scrollInfo: (text) => theme.fg("dim", text),
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
  });
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done(undefined);
  return list;
}

function chooseTerminal({
  choices,
  ctx,
  searchPlaceholder,
  searchTitle,
  signal,
  title,
}: Config): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const input = new Input({
      placeholder: searchPlaceholder ?? "type to filter",
      placeholderStyle: (text) => theme.fg("dim", text),
      prompt: `${searchTitle ?? "Filter"}: `,
    });
    input.focused = true;
    let filtered = filterChoices(choices, "");
    let visible = fitRows(tui.terminal.rows, filtered.length);
    let list = createList({ choices: filtered, done, theme, visible });

    const rebuild = (query: string, selected?: string): void => {
      filtered = filterChoices(choices, query);
      visible = fitRows(tui.terminal.rows, filtered.length);
      list = createList({ choices: filtered, done, theme, visible });
      if (selected) list.setSelectedIndex(Math.max(0, filtered.indexOf(selected)));
    };
    const cancel = (): void => done(undefined);
    signal.addEventListener("abort", cancel, { once: true });

    return {
      dispose: () => signal.removeEventListener("abort", cancel),
      focused: true,
      handleInput(data: string): void {
        if (signal.aborted) return;
        if (keybindings.matches(data, "tui.select.cancel")) {
          if (matchesKey(data, Key.escape) && input.getValue()) {
            input.setValue("");
            rebuild("");
            tui.requestRender();
          } else done(undefined);
          return;
        }
        if (keybindings.matches(data, "tui.select.pageUp") || keybindings.matches(data, "tui.select.pageDown")) {
          const selected = list.getSelectedItem()?.value;
          const current = selected ? filtered.indexOf(selected) : 0;
          const step = keybindings.matches(data, "tui.select.pageDown") ? visible : -visible;
          list.setSelectedIndex(Math.max(0, Math.min(filtered.length - 1, current + step)));
          tui.requestRender();
          return;
        }
        if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm")
        ) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        const previous = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== previous) rebuild(input.getValue());
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.y < 2) return;
        const result = list.handleMouse({ ...event, y: event.y - 2 });
        if (result?.render) tui.requestRender();
        return result;
      },
      invalidate(): void {
        input.invalidate();
        list.invalidate();
      },
      render(width: number): string[] {
        if (width < 1) return [];
        const nextVisible = fitRows(tui.terminal.rows, filtered.length);
        if (nextVisible !== visible) rebuild(input.getValue(), list.getSelectedItem()?.value);
        const count =
          filtered.length === choices.length
            ? `${choices.length} choices`
            : `${filtered.length}/${choices.length} matches`;
        return [
          truncateToWidth(theme.fg("accent", `${title} · ${count}`), width),
          ...input.render(width).map((line) => truncateToWidth(line, width)),
          ...list.render(width),
          truncateToWidth(theme.fg("dim", "↑↓ scroll · PgUp/PgDn jump · Enter select · Esc clear/close"), width),
        ];
      },
    };
  });
}

export function choose(config: Config): Promise<string | undefined> {
  if (config.signal.aborted) return Promise.resolve(undefined);
  return config.ctx.mode === "tui"
    ? chooseTerminal(config)
    : config.ctx.ui.select(config.title, [...config.choices], { signal: config.signal });
}
