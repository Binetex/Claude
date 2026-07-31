/**
 * Константы пагинации списка заказов. Отдельный обычный модуль (НЕ "use client") специально:
 * их читает и серверная страница, и клиентский пейджер. Экспорты "use client"-модуля на сервере
 * подменяются client-reference прокси, поэтому массив оттуда пришёл бы заглушкой без .includes.
 */
export const PER_PAGE_OPTIONS = [20, 50, 100, 200] as const;
export const DEFAULT_PER_PAGE = 20;

/**
 * Разбор page/perPage из URL. Общий для всех трёх списков заказов (владелец, колл-центр,
 * флорист) — иначе они разъезжаются в мелочах вроде «что считать первой страницей».
 *
 * perPage берётся ТОЛЬКО из белого списка: произвольное число из URL означало бы
 * «отдай всю базу одним запросом».
 */
export function resolvePaging(sp: Record<string, string | undefined>): { page: number; perPage: number } {
  const requestedPerPage = Number(sp.perPage);
  const perPage = (PER_PAGE_OPTIONS as readonly number[]).includes(requestedPerPage) ? requestedPerPage : DEFAULT_PER_PAGE;
  const requestedPage = Number(sp.page);
  const page = Number.isFinite(requestedPage) && requestedPage > 1 ? Math.floor(requestedPage) : 1;
  return { page, perPage };
}

/**
 * URL последней существующей страницы, если запрошенная вышла за пределы выборки
 * (ссылка из старого состояния, «назад» в браузере), иначе null. Показывать пустой экран
 * в таком случае хуже, чем увести на последнюю страницу.
 */
export function outOfRangePageUrl(
  sp: Record<string, string | undefined>,
  basePath: string,
  args: { total: number; page: number; perPage: number }
): string | null {
  const lastPage = Math.max(1, Math.ceil(args.total / args.perPage));
  if (args.page <= lastPage) return null;
  const p = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
  p.set("page", String(lastPage));
  return `${basePath}?${p.toString()}`;
}
