/**
 * Годится ли адрес доставки курьеру (владелец 30.09.2026, THEFLOW-20867: заказчица не указала
 * номер дома, в Burq ушло «Steddom Drive, Rosemead», и курьер поехал «куда-то на улицу»).
 *
 * В Burq уходит только строка улицы с городом и индексом, поэтому номер дома обязан быть в ней:
 * номер, записанный во вторую строку («квартира»: «4338», «2025 Corinth Ave»), курьер не увидит.
 * Отсюда правило — в строке улицы есть хоть одна цифра. За 90 дней до 30.09.2026 правило нашло
 * шесть настоящих случаев из 674 заказов и ни одного ложного.
 */
export type AddressIssue = "empty" | "no_house_number";

export function deliveryAddressIssue(addressLine: string | null | undefined): AddressIssue | null {
  const street = (addressLine ?? "").trim();
  if (!street) return "empty";
  return /\d/.test(street) ? null : "no_house_number";
}

/**
 * Указана ли во второй строке адреса квартира, офис или юнит — а не просто район. Чекаут TheFlow сам
 * кладёт туда район из автоподстановки адреса («Central LA», «Mar Vista», «Venice»; 15.10.2026,
 * THEFLOW-21254), и правило «Апартаменты» спрашивало у частного дома, как курьеру войти внутрь.
 * Квартира — это номер («Central LA apt 7», «1a», «#402», «Room 802») или слово юнита без номера
 * («Unit B», «Suite A»). Район, «Frnt», «The Roxy» — нет.
 */
export function hasUnit(apartment: string | null | undefined): boolean {
  const s = (apartment ?? "").trim();
  if (!s) return false;
  return /[\d#]/.test(s) || /\b(apt|apto|apartments?|unit|suite|ste|room|rm|ph|penthouse|floor|bldg|building)\b/i.test(s);
}

/** Пометка у адреса в карточке заказа. Пустой адрес карточка и так подписывает «не указан». */
export function addressWarning(addressLine: string | null | undefined): string | null {
  return deliveryAddressIssue(addressLine) === "no_house_number"
    ? "Нет номера дома — в Burq не уйдёт. Уточните адрес у заказчика и поправьте его здесь."
    : null;
}
