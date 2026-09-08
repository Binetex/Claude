/**
 * Ссылка возврата в список, который человек видел до перехода.
 *
 * Список параметризуется адресом (дата, статус, магазин, флорист, страница), а карточка о нём не
 * знала: кнопка «Назад» вела на голый список, и разбор пачки из десяти заказов стоил тридцати
 * лишних кликов на восстановление фильтров.
 *
 * Запрос ПЕРЕСОБИРАЕТСЯ через URLSearchParams, а не подставляется как есть: значение пришло из
 * адресной строки, и так в ссылку попадут только нормальные пары key=value, а путь останется
 * нашим. Тот же приём уже работает в каталоге товаров — здесь он общий на три роли.
 */
export function backToList(basePath: string, back: string | undefined | null): string {
  const qs = new URLSearchParams(back ?? "").toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Запрос текущего списка → строка для параметра `back`. Пустой список параметров — пустая строка. */
export function listQuery(sp: Record<string, string | string[] | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && v !== "") qs.set(k, v);
  }
  return qs.toString();
}
