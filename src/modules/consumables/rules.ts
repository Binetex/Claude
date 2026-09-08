/**
 * Что и сколько израсходовано на заказ — по СНИМКУ его позиций.
 *
 * Правила выведены из боевых данных и сверены с таблицей владельца за 1–6 сентября: числа
 * сошлись во все проверенные дни. Ничего не хранится: количество считается на лету, а ручная
 * правка живёт отдельной строкой и перебивает расчёт (приём OrderCommunication.topicManual).
 * Поэтому правило можно уточнять задним числом, не переписывая историю.
 */

/** Позиция заказа в том виде, в каком её видит правило: только снимки, без каталога. */
export type ConsumableItemInput = {
  name: string;
  variantName: string | null;
  /** Название вазы из каталога, если букет связан с вазой, а в тексте её типа нет. */
  linkedVaseName?: string | null;
  quantity: number;
};

export const VASE_KEYS = [
  "LARGE_GLASS", "CLEAR_GLASS", "WHITE_MATTE", "CHOCOLATE", "SAGE", "BUD",
  "BEIGE", "CONTOUR_RIB", "TEXTURED", "SAND", "FOREST", "MERCURY", "SILVER",
] as const;
export type VaseKey = (typeof VASE_KEYS)[number];

export const VASE_LABEL: Record<VaseKey, string> = {
  LARGE_GLASS: "Large Glass Vase",
  CLEAR_GLASS: "Clear Glass Vase",
  WHITE_MATTE: "White Matte Vase",
  CHOCOLATE: "Chocolate Vase",
  SAGE: "Sage Vase",
  BUD: "Bud Vase",
  BEIGE: "Beige Vase",
  CONTOUR_RIB: "Contour Rib Vase",
  TEXTURED: "Textured Vase",
  SAND: "Sand Vase",
  FOREST: "Forest Vase",
  MERCURY: "Mercury Vase",
  SILVER: "Silver Vase",
};

/**
 * Порядок важен: «Large Clear Glass Vase» обязан проверяться РАНЬШЕ «Clear Glass Vase»,
 * иначе крупная ваза уедет в обычную. Слово vase в каждом шаблоне обязательно — без него
 * «Sage Bouquet» без вазы попал бы в Sage Vase.
 */
const VASE_TYPE_RULES: { key: VaseKey; re: RegExp }[] = [
  { key: "LARGE_GLASS", re: /\blarge\s+clear\s+glass\s+vase\b/i },
  { key: "CLEAR_GLASS", re: /\bclear\s+glass\s+(?:cylinder\s+)?vase\b/i },
  { key: "WHITE_MATTE", re: /\bwhite\s+matte\s+(?:glass\s+)?vase\b/i },
  { key: "CHOCOLATE", re: /\bchocolate\s+(?:matte\s+)?(?:glass\s+)?vase\b/i },
  { key: "SAGE", re: /\bsage\s+(?:sculptural\s+)?vase\b/i },
  { key: "BUD", re: /\bbud\s+vase\b/i },
  { key: "BEIGE", re: /\bbeige\s+(?:sculptural\s+)?vase\b/i },
  { key: "CONTOUR_RIB", re: /\bcontour\s+rib(?:bed)?\s+vase\b/i },
  { key: "TEXTURED", re: /\btextured\s+vase\b/i },
  { key: "SAND", re: /\bsand\s+(?:matte\s+)?vase\b/i },
  { key: "FOREST", re: /\bforest\s+(?:matte\s+)?vase\b/i },
  { key: "MERCURY", re: /\bmercury\s+(?:glass\s+)?vase\b/i },
  { key: "SILVER", re: /\bsilver\s+(?:glass\s+)?vase\b/i },
];

/**
 * «No Vase» — это ОТСУТСТВИЕ вазы, хотя слово vase в строке есть.
 *
 * За 90 дней таких позиций 17 из 154 («Pink Floyd Roses - Standard, No Vase»). Без этой
 * проверки каждая девятая позиция получила бы записку про вазу там, где вазы нет.
 */
const NO_VASE = /\bno\b[\s\p{P}]*\bvase\b/iu;
const HAS_VASE = /\bvase\b/i;

function textOf(item: ConsumableItemInput): string {
  return [item.name, item.variantName].filter(Boolean).join(" | ");
}

/** Есть ли в позиции ваза. Отрицание проверяется ПЕРВЫМ. */
export function itemHasVase(item: ConsumableItemInput): boolean {
  const txt = textOf(item);
  if (NO_VASE.test(txt)) return false;
  return HAS_VASE.test(txt);
}

/**
 * Тип вазы: сначала по тексту позиции, затем по названию связанной вазы из каталога.
 *
 * Текст сильнее каталога: в заказе продано то, что написано в строке, а связь в каталоге
 * владелец может поменять завтра — тогда прошлые дни пересчитались бы задним числом.
 */
export function vaseTypeOf(item: ConsumableItemInput): VaseKey | null {
  if (!itemHasVase(item)) return null;
  const txt = textOf(item);
  for (const r of VASE_TYPE_RULES) if (r.re.test(txt)) return r.key;
  if (item.linkedVaseName) {
    for (const r of VASE_TYPE_RULES) if (r.re.test(item.linkedVaseName)) return r.key;
  }
  return null;
}

export type OrderConsumables = {
  /** Сколько ваз ушло на заказ (по количеству позиций, а не по числу строк). */
  vaseCount: number;
  /** Разбивка ваз по типам; null-ключ — ваза есть, тип не распознан. */
  vasesByType: Map<VaseKey | "UNKNOWN", number>;
  /** Донышки: по одному на вазу. */
  vaseBottoms: number;
  /** Какую записку класть. null — магазин без своей упаковки. */
  careGuide: "VASE" | "BOUQUET" | null;
  /** Брендированный конверт — только у магазина со своей упаковкой. */
  brandedEnvelope: number;
};

export type OrderInput = {
  items: ConsumableItemInput[];
  /** У магазина своя брендированная упаковка (записка и конверт). Галочка в справочнике. */
  storeHasBranding: boolean;
};

/**
 * Расход по одному заказу.
 *
 * Care Guide — РОВНО ОДИН на заказ, а не на букет: так сходятся числа владельца
 * (2 сентября: 6 заказов, 0 записок для букета и 3 для вазы — это три вазных заказа TheFlow
 * и три заказа других магазинов, где записок не кладут вовсе).
 */
export function consumablesForOrder(order: OrderInput): OrderConsumables {
  const vasesByType = new Map<VaseKey | "UNKNOWN", number>();
  let vaseCount = 0;

  for (const item of order.items) {
    if (!itemHasVase(item)) continue;
    const qty = Math.max(1, item.quantity || 1);
    vaseCount += qty;
    const key = vaseTypeOf(item) ?? "UNKNOWN";
    vasesByType.set(key, (vasesByType.get(key) ?? 0) + qty);
  }

  return {
    vaseCount,
    vasesByType,
    vaseBottoms: vaseCount,
    careGuide: order.storeHasBranding ? (vaseCount > 0 ? "VASE" : "BOUQUET") : null,
    brandedEnvelope: order.storeHasBranding ? 1 : 0,
  };
}
