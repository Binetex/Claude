/**
 * Служебные позиции заказа — строки, которые НЕ являются работой флориста.
 *
 * Сейчас это только чаевые. Shopify присылает их отдельной строкой line_items, поэтому в
 * заказе появляется OrderItem «Tip» с ценой клиента. Чаевые целиком принадлежат владельцу:
 * в заработок и долг флориста они не входят никогда (см. computeEstimatedProfit — там они
 * остаются в доходе). WooCommerce чаевые кладёт в fee_lines → Order.tip, отдельной позиции
 * не создаёт, поэтому этот модуль на Woo-заказы не влияет.
 *
 * Признака «тип позиции» в модели OrderItem нет, поэтому определяем составным условием:
 * точное служебное имя И отсутствие связи с каталогом. Только по имени ориентироваться
 * нельзя — товар «Tulip Tips Bouquet» обязан остаться обычным товаром; поэтому имя
 * сравнивается целиком, а не подстрокой, и позиция, сопоставленная с товаром или вариантом
 * каталога, служебной не считается никогда.
 */

const TIP_NAMES = new Set(["tip", "tips", "gratuity", "чаевые"]);

export type ItemIdentity = {
  name: string;
  productId?: string | null;
  variantId?: string | null;
};

export type ItemWithFloristPrice = ItemIdentity & { floristItemPrice: number };

/** Позиция-чаевые: служебная строка, за которую флористу не платят. */
export function isTipItem(item: ItemIdentity): boolean {
  // Связана с каталогом → это настоящий товар, как бы он ни назывался.
  if (item.productId || item.variantId) return false;
  return TIP_NAMES.has(item.name.trim().toLowerCase());
}

/** Позиции, за которые флористу действительно платят. */
export function compensableItems<T extends ItemIdentity>(items: T[]): T[] {
  return items.filter((i) => !isTipItem(i));
}

/**
 * Сумма цен флориста, ошибочно записанных в служебные позиции. У заказов, назначенных до
 * исправления, чаевые попали в снимок floristItemPrice — это то, что нужно вычесть на лету.
 */
export function tipFloristAmount(items: ItemWithFloristPrice[]): number {
  const sum = items.reduce((acc, i) => (isTipItem(i) ? acc + i.floristItemPrice : acc), 0);
  return Math.round(sum * 100) / 100;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Сумма к оплате флористу с исключёнными чаевыми. Работает и для новых заказов (там чаевые
 * уже 0, поправка нулевая), и для исторических — поэтому переписывать старые данные не нужно.
 *
 * Вычитаем ТОЛЬКО когда сумма заказа доказуемо собрана из снимков позиций: тогда чаевые
 * заведомо внутри неё. Ручную сумму, которую владелец ввёл сам, не трогаем — что он в неё
 * заложил, из данных не выводится, а молча уменьшать введённое число хуже, чем оставить как
 * есть. Новые ручные цены проблемы не создают: при их сохранении снимок чаевых обнуляется.
 */
export function effectiveFloristTotal(storedTotal: number, items: ItemWithFloristPrice[]): number {
  const tip = tipFloristAmount(items);
  if (tip === 0) return cents(storedTotal);

  const snapshotSum = cents(items.reduce((acc, i) => acc + i.floristItemPrice, 0));
  if (Math.abs(snapshotSum - storedTotal) > 0.005) return cents(storedTotal);

  return Math.max(0, cents(storedTotal - tip));
}
