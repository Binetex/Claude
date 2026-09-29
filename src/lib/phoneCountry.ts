import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/core";
// Данные о странах подключаются явно: общий вход пакета под tsx (так работает воркер) их не видит.
import phoneMetadata from "libphonenumber-js/metadata.min.json";

/**
 * Номер без «+» у заказчика из другой страны: код страны — из страны его платёжного адреса.
 *
 * Повод — THEFLOW-20861 (28.09.2026): мексиканский номер 8712647484 получал «+1», Quo отвергал его,
 * и заказчик не получил ни одного сообщения. Так же не доходили израильские 050…, австралийские
 * 04…, британские 07… (решение владельца 29.09.2026: «да, делай»). Ставится ПРИ ПРИЁМЕ заказа, чтобы
 * правильный номер лежал в самом заказе: по нему идут SMS, сопоставление звонков и ассистент.
 *
 * США и неизвестная страна — как было (дальше «+1» ставит normalizePhone). Номер, который для этой
 * страны не складывается в настоящий (американский номер при британском платёжном адресе), тоже
 * остаётся как был: лучше прежнее поведение, чем выдуманный номер.
 */
export function withCountryCode(raw: string | null | undefined, country: string | null | undefined): string {
  const value = (raw ?? "").trim();
  const cc = (country ?? "").trim().toUpperCase();
  if (!value || value.startsWith("+") || !/^[A-Z]{2}$/.test(cc) || cc === "US") return value;
  try {
    const parsed = parsePhoneNumberFromString(value, cc as CountryCode, phoneMetadata);
    return parsed && parsed.isValid() ? parsed.number : value;
  } catch {
    return value;
  }
}
