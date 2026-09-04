/**
 * Кому нести черновик: владельцу или флористу заказа.
 *
 * Решение владельца: до полудня по времени магазина отвечает он сам, после — флорист, который
 * везёт этот заказ. Час — не мелочь: утром владелец разбирает почту и телефон, днём он занят, а
 * флорист в это время уже с букетом в руках и знает про заказ больше всех.
 *
 * Чистая функция без БД: правило простое, а проверять его на живых заказах дорого.
 */

/** До этого часа по времени магазина черновик идёт владельцу. */
export const OWNER_UNTIL_HOUR = 12;

export type Recipient = "OWNER" | "FLORIST";

export function pickRecipient(args: { storeHour: number; hasFlorist: boolean }): Recipient {
  if (args.storeHour < OWNER_UNTIL_HOUR) return "OWNER";
  // Флориста на заказе может не быть (редко, но бывает) — тогда некому, кроме владельца.
  return args.hasFlorist ? "FLORIST" : "OWNER";
}

/** Час по календарю магазина. Сравнивать с часом сервера нельзя: он в UTC. */
export function storeHour(tz: string | null | undefined, now: Date): number {
  const zone = tz || "America/Los_Angeles";
  const hh = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hour12: false }).format(now);
  return Number(hh);
}
