/**
 * Правила суммы начисления SECONDARY-флористу. Чистые функции: ни Prisma, ни «сейчас».
 *
 * Сумма НЕ пересчитывается по каталогу: берётся снимок `Order.floristTotal`, зафиксированный
 * в момент назначения. Это принципиально — начисление обязано совпадать с той цифрой,
 * которую флорист видел в карточке заказа, а не с тем, во что превратился прайс потом.
 *
 * Что в сумму НЕ входит: чаевые (деньги владельца), налог, доставка заказчика, service fee
 * и комиссии платёжных провайдеров — их в `floristTotal` нет по построению. Закупочная
 * стоимость ваз и подарков на фиксированное начисление secondary не влияет вообще.
 */
import { effectiveFloristTotal, type ItemWithFloristPrice } from "@/modules/pricing/serviceItems";

export type AccrualAssessment =
  | { status: "OK"; amountCents: number; provenance: PriceProvenance }
  | { status: "FLORIST_PRICE_MISSING"; amountCents: 0; provenance: PriceProvenance };

/** Откуда взялась сумма — попадает в metadata записи и в подсказку владельцу. */
export type PriceProvenance = "MANUAL" | "AUTO_SNAPSHOT" | "NONE";

export type AccrualOrderInput = {
  priceMode: "AUTO" | "MANUAL";
  /** Снимок суммы флориста по заказу, в долларах (Order.floristTotal). */
  floristTotal: number;
  items: ItemWithFloristPrice[];
};

const toCents = (usd: number) => Math.round(usd * 100);

/**
 * Сумма к начислению за доставленный заказ.
 *
 * Ручная цена берётся КАК ЕСТЬ: владелец ввёл её сам, уже без чаевых, и молча уменьшать
 * введённое число нельзя — что он в него заложил, из данных не выводится.
 *
 * Авто-цена проходит через `effectiveFloristTotal`: у заказов, назначенных до исправления
 * чаевых, они попали в снимок позиций, и вычесть их нужно на лету. Для новых заказов
 * поправка нулевая, поэтому одна ветка обслуживает и историю, и текущее.
 *
 * Ноль означает «цена флориста не задана»: начисление не создаётся, заказ уходит в очередь
 * на разбор владельцу. Провенанс исторической авто-цены (настоящий прайс или фолбэк на цену
 * клиента) начислению НЕ мешает — блокировать выплату из-за неизвестного прошлого хуже,
 * чем начислить по снимку, который флорист уже видел.
 */
export function assessAccrual(order: AccrualOrderInput): AccrualAssessment {
  if (order.priceMode === "MANUAL") {
    const cents = toCents(order.floristTotal);
    if (cents <= 0) return { status: "FLORIST_PRICE_MISSING", amountCents: 0, provenance: "NONE" };
    return { status: "OK", amountCents: cents, provenance: "MANUAL" };
  }

  const cents = toCents(effectiveFloristTotal(order.floristTotal, order.items));
  if (cents <= 0) return { status: "FLORIST_PRICE_MISSING", amountCents: 0, provenance: "NONE" };
  return { status: "OK", amountCents: cents, provenance: "AUTO_SNAPSHOT" };
}
