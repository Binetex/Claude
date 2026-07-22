/**
 * Объединение dropoff-инструкций для Burq draft: стандартный текст магазина
 * (Site.burqDefaultDropoffInstructions) + инструкция конкретного заказа.
 * Чистая функция (без сети/БД) — тестируема.
 *
 * Правила:
 *  - оба пустые → null (в запрос Burq `notes` не попадёт);
 *  - только один → он;
 *  - оба → стандартный текст магазина ПЕРВЫМ, затем инструкция заказа (через пустую строку);
 *  - одинаковый текст или один содержит другой → без дублирования.
 */
export function combineDropoffNotes(
  siteDefault: string | null | undefined,
  orderInstructions: string | null | undefined
): string | null {
  const site = (siteDefault ?? "").trim();
  const order = (orderInstructions ?? "").trim();
  if (!site && !order) return null;
  if (!site) return order;
  if (!order) return site;
  if (site === order) return site;
  if (site.includes(order)) return site;
  if (order.includes(site)) return order;
  return `${site}\n${order}`;
}
