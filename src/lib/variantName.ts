/**
 * Имя варианта товара, пригодное для показа человеку.
 *
 * У товара без вариаций Shopify всё равно заводит один вариант и называет его «Default Title».
 * Это служебная заглушка платформы, а не название: в карточке заказа она выглядела как
 * настоящий вариант букета (THEFLOW #005, «Field of Dreams / Default Title»).
 *
 * Правило одно на всю систему. До этого оно жило строковым литералом в трёх местах приёма
 * Shopify, а в подборе товара для РУЧНОГО заказа его не было вовсе — оттуда заглушка и
 * попадала в заказ.
 */

/** Заглушки платформы, которые названием варианта не являются. */
const PLACEHOLDERS = new Set(["default title", "default"]);

export function displayVariantName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim();
  if (!name) return null;
  return PLACEHOLDERS.has(name.toLowerCase()) ? null : name;
}
