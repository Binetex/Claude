/**
 * Изображения позиции заказа. Единая точка для fallback и дедупликации, чтобы правила не
 * расползались по компонентам.
 *
 * Модель данных (снимки, см. OrderItem):
 *  - parentImageUrl  — фото родительского товара;
 *  - variantImageUrl — фото выбранной вариации, если у неё своё;
 *  - image           — LEGACY эффективное фото старых заказов (variant ?? product).
 *
 * Правила:
 *  - основное фото = parentImageUrl ?? image. Для новых заказов это всегда родительское; для
 *    старых — прежнее фото, потому что исторически parent там уже не восстановить.
 *  - дополнительное фото вариации показывается, если оно есть и отличается от основного
 *    (одинаковые URL не дублируем).
 */
export type OrderItemImageSource = {
  image?: string | null;
  parentImageUrl?: string | null;
  variantImageUrl?: string | null;
};

export type OrderItemImages = {
  /** Основное фото для любого места UI. null — фото нет вовсе. */
  primary: string | null;
  /** Фото вариации (например, вазы), если у неё своё. null, если нечего показывать. */
  variant: string | null;
};

/** Пустая строка/пробелы считаются отсутствием URL. */
function clean(v: string | null | undefined): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

export function getOrderItemImages(item: OrderItemImageSource): OrderItemImages {
  const primary = clean(item.parentImageUrl) ?? clean(item.image);
  const variant = clean(item.variantImageUrl);
  return {
    primary,
    // Совпадает с основным (или основного нет) → второй раз не показываем.
    variant: variant && variant !== primary ? variant : null,
  };
}

/**
 * Все фотографии заказа для отправки наружу — карточка флориста в Telegram и всё, что появится
 * дальше.
 *
 * Для каждой позиции берётся товар и СРАЗУ ЗА НИМ его вариация: ваза приходит следом за
 * букетом, а не в конце списка. Раньше сюда попадали только основные фото, и флорист, который
 * работает по телеграму, вазу не видел вовсе — хотя в панели заказа она есть (THEFLOW-20598).
 *
 * Повторы убираются: две одинаковые позиции не должны давать две одинаковые картинки, а
 * вариация, совпадающая с товаром, уже отсеяна в `getOrderItemImages`.
 */
export function orderPhotoUrls(items: OrderItemImageSource[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const { primary, variant } = getOrderItemImages(item);
    if (primary) seen.add(primary);
    if (variant) seen.add(variant);
  }
  return [...seen];
}
