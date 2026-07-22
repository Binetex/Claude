"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { getQuoConfig } from "@/integrations/quo/config";
import { featureFlags } from "@/lib/featureFlags";
import { createQuoClient } from "@/integrations/quo/client";

/**
 * Привязка QUO-номера к магазину (owner-only). API-ключ QUO глобальный/секретный и НИКОГДА не
 * возвращается в client props — сюда попадают только id/номер/лейбл. Ошибка проверки НЕ стирает
 * текущую рабочую привязку. Один phoneNumberId нельзя привязать к двум Site.
 */

export type QuoNumberOption = { id: string; number: string | null; label: string };
type Result = { ok?: true; error?: string };

/** «+1 310 …8421 — PN…»: читаемый номер (частично) + Phone Number ID для диагностики. */
function numberLabel(number: string | null | undefined, id: string): string {
  const digits = (number ?? "").replace(/[^\d+]/g, "");
  if (digits.length >= 5) {
    const cc = digits.startsWith("+") ? digits.slice(0, digits.length - 10) : "";
    const last4 = digits.slice(-4);
    const area = digits.slice(digits.length - 10, digits.length - 7);
    const pretty = [cc, area, `…${last4}`].filter(Boolean).join(" ").trim();
    return `${pretty || number} — ${id}`;
  }
  return number ? `${number} — ${id}` : id;
}

function quoClientOrNull() {
  const cfg = getQuoConfig();
  if (!cfg || !featureFlags.quo) return null;
  return createQuoClient({ ...cfg, maxRetries: 0 });
}

/** Read-only список доступных номеров аккаунта QUO. Без секретов. При сбое — ошибка, БД не трогаем. */
export async function ownerQuoListNumbers(): Promise<{ numbers?: QuoNumberOption[]; error?: string }> {
  await requireRole("OWNER");
  const client = quoClientOrNull();
  if (!client) return { error: "QUO не настроен на сервере (QUO_API_KEY / QUO_ENABLED)." };
  try {
    const nums = await client.listPhoneNumbers();
    return { numbers: nums.map((n) => ({ id: n.id, number: n.number ?? null, label: numberLabel(n.number, n.id) })) };
  } catch {
    return { error: "Не удалось получить список номеров из QUO. Попробуйте позже." };
  }
}

/** Один phoneNumberId — не более чем у одного Site. */
async function isNumberTakenByOther(phoneNumberId: string, siteId: string): Promise<boolean> {
  const other = await prisma.site.findFirst({ where: { quoPhoneNumberId: phoneNumberId, id: { not: siteId } }, select: { id: true } });
  return !!other;
}

/**
 * Сохранение из списка: server-side проверяем, что phoneNumberId реально есть в QUO, берём его
 * фактический номер, включаем QUO. При любой ошибке проверки — НЕ трогаем текущую привязку.
 */
export async function ownerQuoSaveNumber(siteId: string, phoneNumberId: string): Promise<Result> {
  await requireRole("OWNER");
  const id = phoneNumberId.trim();
  if (!id) return { error: "Не выбран номер." };
  if (await isNumberTakenByOther(id, siteId)) return { error: "Этот номер уже привязан к другому магазину." };

  const client = quoClientOrNull();
  if (!client) return { error: "QUO не настроен на сервере." };

  let numbers: { id: string; number?: string }[];
  try {
    numbers = await client.listPhoneNumbers();
  } catch {
    return { error: "Не удалось проверить номер в QUO (список недоступен). Привязка не изменена." };
  }
  const match = numbers.find((n) => n.id === id);
  if (!match) return { error: "Phone Number ID не найден в аккаунте QUO. Привязка не изменена." };

  await prisma.site.update({
    where: { id: siteId },
    data: {
      quoPhoneNumberId: id,
      quoPhoneNumber: match.number ?? null,
      quoEnabled: true,
      quoLastCheckAt: new Date(),
      quoConnectionError: null,
    },
  });
  revalidatePath("/dashboard/sites");
  return { ok: true };
}

/**
 * Ручной ввод (fallback, если list endpoint недоступен): сохраняем id+номер как есть, БЕЗ проверки
 * через API. Уникальность номера всё равно проверяется. Помечаем, что проверки не было.
 */
export async function ownerQuoSaveManual(siteId: string, phoneNumberId: string, phoneNumber: string): Promise<Result> {
  await requireRole("OWNER");
  const id = phoneNumberId.trim();
  const num = phoneNumber.trim();
  if (!id) return { error: "Укажите Phone Number ID." };
  if (await isNumberTakenByOther(id, siteId)) return { error: "Этот номер уже привязан к другому магазину." };

  await prisma.site.update({
    where: { id: siteId },
    data: {
      quoPhoneNumberId: id,
      quoPhoneNumber: num || null,
      quoEnabled: true,
      quoLastCheckAt: null,
      quoConnectionError: "Сохранено вручную без проверки через QUO API.",
    },
  });
  revalidatePath("/dashboard/sites");
  return { ok: true };
}

/** Проверка подключения: жив ли привязанный номер в QUO. Обновляет lastCheck/error, привязку не стирает. */
export async function ownerQuoCheckConnection(siteId: string): Promise<Result> {
  await requireRole("OWNER");
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { quoPhoneNumberId: true } });
  if (!site?.quoPhoneNumberId) return { error: "Номер не привязан — нечего проверять." };

  const client = quoClientOrNull();
  if (!client) return { error: "QUO не настроен на сервере." };

  let numbers: { id: string; number?: string }[];
  try {
    numbers = await client.listPhoneNumbers();
  } catch {
    await prisma.site.update({ where: { id: siteId }, data: { quoConnectionError: "QUO API недоступен при проверке." } });
    revalidatePath("/dashboard/sites");
    return { error: "QUO API недоступен. Привязка сохранена." };
  }
  const match = numbers.find((n) => n.id === site.quoPhoneNumberId);
  if (!match) {
    await prisma.site.update({ where: { id: siteId }, data: { quoConnectionError: "Номер не найден в аккаунте QUO." } });
    revalidatePath("/dashboard/sites");
    return { error: "Номер не найден в аккаунте QUO. Привязка сохранена." };
  }
  await prisma.site.update({
    where: { id: siteId },
    data: { quoPhoneNumber: match.number ?? undefined, quoLastCheckAt: new Date(), quoConnectionError: null },
  });
  revalidatePath("/dashboard/sites");
  return { ok: true };
}

/** Включить/выключить QUO для магазина. Включить можно только при привязанном номере. */
export async function ownerQuoSetEnabled(siteId: string, enabled: boolean): Promise<Result> {
  await requireRole("OWNER");
  if (enabled) {
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { quoPhoneNumberId: true } });
    if (!site?.quoPhoneNumberId) return { error: "Сначала привяжите номер QUO." };
  }
  await prisma.site.update({ where: { id: siteId }, data: { quoEnabled: enabled } });
  revalidatePath("/dashboard/sites");
  return { ok: true };
}

/** Отвязать номер: чистим привязку и выключаем QUO у ЭТОГО магазина. Историю коммуникаций не трогаем. */
export async function ownerQuoUnlink(siteId: string): Promise<Result> {
  await requireRole("OWNER");
  await prisma.site.update({
    where: { id: siteId },
    data: { quoPhoneNumberId: null, quoPhoneNumber: null, quoEnabled: false, quoLastCheckAt: null, quoConnectionError: null },
  });
  revalidatePath("/dashboard/sites");
  return { ok: true };
}
