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
 *  - дополнительное фото вариации показывается ТОЛЬКО если оно есть и отличается от основного
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
  /** Фото вариации — только для страницы конкретного заказа. null, если нечего показывать. */
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
