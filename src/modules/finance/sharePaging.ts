/**
 * Размеры страницы списка дней доли.
 *
 * Обычный модуль: без "use client" и без "server-only". Значение нужно и серверной
 * странице, и клиентскому селектору, а держать его в любом из них означало бы протащить
 * server-only в браузер либо client-reference на сервер (см. finance/clientBoundary).
 */
export const PER_PAGE_OPTIONS = [20, 50, 100] as const;
export type PerPage = (typeof PER_PAGE_OPTIONS)[number];
