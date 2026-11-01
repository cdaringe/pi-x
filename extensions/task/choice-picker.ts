import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PAGE_SIZE = 4;
const NEXT = "Next page →";
const PREVIOUS = "← Previous page";

interface T {
  readonly page: number;
  readonly query: string;
}

export interface Config {
  readonly choices: readonly string[];
  readonly clearLabel?: string;
  readonly ctx: ExtensionContext;
  readonly searchLabel?: string;
  readonly searchPlaceholder?: string;
  readonly searchTitle?: string;
  readonly signal: AbortSignal;
  readonly state?: T;
  readonly title: string;
}

function filterChoices(choices: readonly string[], query: string): string[] {
  const term = query.toLocaleLowerCase();
  return query ? choices.filter((choice) => choice.toLocaleLowerCase().includes(term)) : [...choices];
}

async function pick({
  ctx,
  title,
  choices,
  signal,
  searchTitle = "Search models…",
  searchPlaceholder = "provider/model",
  searchLabel = "Search models…",
  clearLabel = "Show all models",
  state = { page: 0, query: "" },
}: Config): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  const filtered = filterChoices(choices, state.query);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(state.page, pageCount - 1);
  const options = [
    ...filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    ...(page > 0 ? [PREVIOUS] : []),
    ...(page < pageCount - 1 ? [NEXT] : []),
    searchLabel,
    ...(state.query ? [clearLabel] : []),
  ];
  const queryLabel = state.query.length > 24 ? `${state.query.slice(0, 23)}…` : state.query;
  const label = state.query
    ? `${title} · “${queryLabel}” · ${page + 1}/${pageCount}`
    : `${title} · ${page + 1}/${pageCount}`;
  const selection = await ctx.ui.select(label, options, { signal });
  if (!selection || signal.aborted) return undefined;
  const config = { choices, clearLabel, ctx, searchLabel, searchPlaceholder, searchTitle, signal, title };
  if (selection === NEXT) return pick({ ...config, state: { ...state, page: page + 1 } });
  if (selection === PREVIOUS) return pick({ ...config, state: { ...state, page: page - 1 } });
  if (selection === clearLabel) return pick(config);
  if (selection === searchLabel) {
    const query = await ctx.ui.input(searchTitle, searchPlaceholder, { signal });
    return pick({ ...config, state: query === undefined ? state : { page: 0, query: query.trim() } });
  }
  return filtered.includes(selection) ? selection : undefined;
}

export function choose(config: Config): Promise<string | undefined> {
  const { ctx, title, choices, signal } = config;
  return choices.length <= PAGE_SIZE ? ctx.ui.select(title, [...choices], { signal }) : pick(config);
}
