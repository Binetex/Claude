/**
 * Телефон в dropoff для Burq. Пустым он быть не может: Burq отвечает 400, черновик умирает в
 * dead-letter после восьми попыток, и заказ остаётся без доставки молча (THEFLOW-20315, -20429).
 *
 * Порядок подстановки — от самого полезного курьеру к запасному:
 *  1. телефон ПОЛУЧАТЕЛЯ — по этому номеру курьер и должен звонить у двери;
 *  2. телефон ЗАКАЗЧИКА — он оплатил заказ и обычно на связи;
 *  3. номер МАГАЗИНА — курьер дозвонится хотя бы до нас, и мы найдём получателя;
 *  4. общий номер, если у магазина своего нет.
 *
 * Это подстановка ТОЛЬКО для Burq. В самом заказе ничего не меняется: пустой телефон получателя
 * остаётся пустым и виден в карточке — иначе выдуманный номер выглядел бы как настоящий и
 * никто бы его не исправил.
 */

/** Общий запасной номер: TheFlow, он же основной номер поддержки. */
export const DEFAULT_DROPOFF_PHONE = "+13238008421";

/** Номер считается пригодным, только если в нём есть хоть одна цифра. */
function usable(phone: string | null | undefined): boolean {
  return !!phone && /\d/.test(phone);
}

export function resolveDropoffPhone(input: {
  recipientPhone: string | null | undefined;
  senderPhone: string | null | undefined;
  storePhone: string | null | undefined;
}): string {
  for (const candidate of [input.recipientPhone, input.senderPhone, input.storePhone]) {
    if (usable(candidate)) return candidate!.trim();
  }
  return DEFAULT_DROPOFF_PHONE;
}
