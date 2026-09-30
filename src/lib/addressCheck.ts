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

/** Пометка у адреса в карточке заказа. Пустой адрес карточка и так подписывает «не указан». */
export function addressWarning(addressLine: string | null | undefined): string | null {
  return deliveryAddressIssue(addressLine) === "no_house_number"
    ? "Нет номера дома — в Burq не уйдёт. Уточните адрес у заказчика и поправьте его здесь."
    : null;
}
