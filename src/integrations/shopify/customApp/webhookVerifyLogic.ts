/**
 * Чистая логика проверки подписи Shopify webhook для нескольких независимых магазинов.
 * Каждый Site имеет СВОЙ Client Secret (secret его собственного custom app). Поддерживается
 * короткое окно ротации: старый secret валиден до `previousValidUntil`.
 *
 * HMAC считается по СЫРОМУ телу (до JSON.parse). Сравнение — constant-time.
 * Без БД/шифрования — секреты приходят уже расшифрованными. Полностью тестируемо.
 */
import crypto from "crypto";

/** Собирает список секретов для проверки: текущий + previous (пока валиден по времени). */
export function secretsForVerification(params: {
  currentSecret: string | null;
  previousSecret?: string | null;
  previousValidUntil?: Date | null;
  now?: Date;
}): string[] {
  const now = params.now ?? new Date();
  const secrets: string[] = [];
  if (params.currentSecret) secrets.push(params.currentSecret);
  if (params.previousSecret && params.previousValidUntil && now.getTime() < params.previousValidUntil.getTime()) {
    secrets.push(params.previousSecret);
  }
  return secrets;
}

/** base64(HMAC-SHA256(rawBody, secret)). */
export function computeWebhookHmac(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Проверяет подпись против набора секретов (текущий, при ротации — и предыдущий).
 * Возвращает true, если ЛЮБОЙ секрет даёт совпадение (constant-time сравнение).
 */
export function verifyWebhookHmac(rawBody: string, hmacHeader: string | null | undefined, secrets: string[]): boolean {
  if (!hmacHeader || secrets.length === 0) return false;
  for (const secret of secrets) {
    if (timingSafeEqualStr(computeWebhookHmac(rawBody, secret), hmacHeader)) return true;
  }
  return false;
}

/**
 * Защита от применения устаревших событий (out-of-order): true, если входящее событие
 * СТАРШЕ уже применённого состояния и его нельзя применять (иначе откатит заказ назад).
 */
export function isStaleUpdate(
  incomingUpdatedAt: Date | null | undefined,
  storedUpdatedAt: Date | null | undefined
): boolean {
  if (!incomingUpdatedAt || !storedUpdatedAt) return false; // нет данных — не блокируем
  return incomingUpdatedAt.getTime() < storedUpdatedAt.getTime();
}

/** Запрещённые «откаты» внутреннего статуса заказа при поздней доставке старого события. */
const FORBIDDEN_BACKWARD: Record<string, string[]> = {
  CANCELLED: ["CONFIRMED", "IN_PROGRESS", "ASSIGNED", "FLORIST_ACCEPTED"],
  DELIVERED: ["CONFIRMED", "IN_PROGRESS", "ASSIGNED", "FLORIST_ACCEPTED", "AWAITING_PAYMENT"],
  REFUNDED: ["IN_PROGRESS", "CONFIRMED"],
};

/** true, если переход current→next запрещён как откат (напр. CANCELLED→CONFIRMED). */
export function isForbiddenStatusTransition(currentStatus: string, nextStatus: string): boolean {
  return FORBIDDEN_BACKWARD[currentStatus]?.includes(nextStatus) ?? false;
}
