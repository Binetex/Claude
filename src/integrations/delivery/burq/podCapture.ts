/**
 * Чистая логика Proof of Delivery. Burq: `proof_of_delivery_image_urls` (массив строк) +
 * `signature_image_url` (строка). Первая версия — храним Burq URL как есть (без копирования).
 *
 * Правила: пустой массив/отсутствие — НЕ ошибка (до delivered фото может не быть); пустое НЕ
 * обнуляет уже сохранённое; повтор одинаковых URL не дублирует (массив заменяется, не добавляется).
 */
import { isDeliveredStatus } from "./statusMap";
import type { DeliveryProviderStatus } from "@/generated/prisma/enums";

/** Нормализует список POD-URL: только валидные http(s)-строки, без дублей и пустых. */
export function normalizePodUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (typeof u === "string" && /^https?:\/\//i.test(u.trim()) && !seen.has(u.trim())) {
      seen.add(u.trim());
      out.push(u.trim());
    }
  }
  return out;
}

export function normalizeSignatureUrl(u: unknown): string | null {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

export type PodUpdate =
  | { apply: true; proofOfDeliveryUrls?: string[]; signatureImageUrl?: string }
  | { apply: false };

/**
 * Что записать в Delivery: только НЕпустые значения (пустое не затирает старое). Возвращает
 * apply:false, если сохранять нечего.
 */
export function decidePodUpdate(incoming: { proofOfDeliveryUrls?: string[]; signatureImageUrl?: string | null }): PodUpdate {
  const urls = normalizePodUrls(incoming.proofOfDeliveryUrls);
  const sig = normalizeSignatureUrl(incoming.signatureImageUrl);
  const patch: { proofOfDeliveryUrls?: string[]; signatureImageUrl?: string } = {};
  if (urls.length > 0) patch.proofOfDeliveryUrls = urls;
  if (sig) patch.signatureImageUrl = sig;
  if (patch.proofOfDeliveryUrls || patch.signatureImageUrl) return { apply: true, ...patch };
  return { apply: false };
}

/** delivered-статус, но фото ещё нет → нужен один отложенный refetch. */
export function isDeliveredWithoutPhoto(status: DeliveryProviderStatus, proofOfDeliveryUrls: string[] | null | undefined): boolean {
  return isDeliveredStatus(status) && normalizePodUrls(proofOfDeliveryUrls).length === 0;
}
