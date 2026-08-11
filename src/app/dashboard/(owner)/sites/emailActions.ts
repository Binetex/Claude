"use server";
/**
 * Email-настройки магазина (owner-only).
 *
 * Действия здесь делятся на два уровня: per-Site (отправитель, reply-to, sender ID, шаблоны —
 * ownerSaveSiteEmail и т.п.) и общий Brevo API key на весь workspace (ownerSaveBrevoApiKey и
 * т.п., см. accountKey.ts). Ключ хранится зашифрованным в БД, полное значение из формы в
 * ответ НИКОГДА не возвращается и не логируется — только маска.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { createBrevoProvider, verifyBrevoSender, verifyBrevoTemplate } from "@/integrations/email/brevo";
import { saveSiteEmailSettings, saveSiteEmailTemplate } from "@/integrations/email/settings";
import { sendSiteTestEmail } from "@/integrations/email/testSend";
import { resolveBrevoApiKey, saveBrevoApiKey, clearBrevoApiKey, verifyAndRecordBrevoConnection } from "@/integrations/email/accountKey";

type Result = { ok?: true; message?: string; error?: string };

/** Пустая строка в форме = «очистить поле», поэтому отличаем её от отсутствующего ключа. */
function str(fd: FormData, key: string): string | null | undefined {
  if (!fd.has(key)) return undefined;
  const v = String(fd.get(key) ?? "").trim();
  return v === "" ? null : v;
}

export async function ownerSaveSiteEmail(_prev: unknown, fd: FormData): Promise<Result> {
  await requireRole("OWNER");
  const siteId = String(fd.get("siteId") ?? "");
  if (!siteId) return { error: "Не указан магазин." };

  const res = await saveSiteEmailSettings(prisma, siteId, {
    senderEmail: str(fd, "senderEmail"),
    senderName: str(fd, "senderName"),
    replyTo: str(fd, "replyTo"),
    brevoSenderId: str(fd, "brevoSenderId"),
    domainVerified: fd.get("domainVerified") === "1",
  });
  if ("error" in res) return { error: res.error };

  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Настройки сохранены" };
}

/** Включение/выключение Email у магазина. Гейты (отправитель + домен) проверяет settings.ts. */
export async function ownerToggleSiteEmail(siteId: string, enabled: boolean): Promise<Result> {
  await requireRole("OWNER");
  const res = await saveSiteEmailSettings(prisma, siteId, { enabled });
  if ("error" in res) return { error: res.error };
  revalidatePath("/dashboard/sites");
  return { ok: true, message: enabled ? "Email включён" : "Email выключен" };
}

/** Один Brevo Template ID для события. Пустое значение убирает шаблон. */
export async function ownerSaveSiteEmailTemplate(siteId: string, triggerType: string, rawId: string): Promise<Result> {
  await requireRole("OWNER");
  const trimmed = rawId.trim();
  if (trimmed === "") {
    const res = await saveSiteEmailTemplate(prisma, siteId, triggerType, null);
    if ("error" in res) return { error: res.error };
    revalidatePath("/dashboard/sites");
    return { ok: true, message: "Шаблон убран" };
  }

  const id = Number(trimmed);
  if (!Number.isInteger(id) || id <= 0) return { error: "Template ID — целое положительное число." };

  const res = await saveSiteEmailTemplate(prisma, siteId, triggerType, id);
  if ("error" in res) return { error: res.error };
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Шаблон сохранён" };
}

/**
 * Тестовое письмо на адрес владельца. Идёт по той же цепочке, что будущие автоматизации, поэтому
 * успех подтверждает и отправителя, и шаблон именно этого магазина.
 */
export async function ownerSendSiteTestEmail(siteId: string, to: string): Promise<Result> {
  await requireRole("OWNER");
  const apiKey = await resolveBrevoApiKey(prisma, siteId);
  const res = await sendSiteTestEmail(prisma, createBrevoProvider(apiKey), {
    siteId,
    to,
    // Спрашиваем Brevo, разрешён ли этот отправитель. Без этого «тест прошёл» означает лишь
    // «Brevo принял запрос» — а письмо при неподтверждённом домене никуда не уходит.
    verifySender: apiKey
      ? async (senderEmail) => {
          const r = await verifyBrevoSender(apiKey, senderEmail);
          return r.ok ? { verified: r.verified } : null;
        }
      : undefined,
    verifyTemplate: apiKey
      ? async (templateId) => {
          const r = await verifyBrevoTemplate(apiKey, templateId);
          return r.ok ? { exists: r.exists, active: r.active, name: r.name } : null;
        }
      : undefined,
  });
  revalidatePath("/dashboard/sites");
  return res.ok
    ? { ok: true, message: `Письмо отправлено${res.providerMessageId ? "" : " (Brevo не вернул messageId)"}` }
    : { error: res.safeError };
}

/**
 * Магазин мог исчезнуть, пока страница была открыта в соседней вкладке. Без этой проверки
 * запись упёрлась бы в внешний ключ и вернулась в интерфейс необработанным исключением.
 */
async function requireSite(siteId: string): Promise<Result | null> {
  if (!siteId) return { error: "Не указан магазин." };
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  return site ? null : { error: "Магазин не найден — возможно, он удалён. Обновите страницу." };
}

/**
 * Короткая приписка про отправителя к результату проверки подключения. Молчит, когда отправитель
 * ещё не задан или Brevo не ответил: догадки хуже отсутствия строки.
 */
async function describeSenderState(siteId: string): Promise<string> {
  const settings = await prisma.siteEmailSettings.findUnique({ where: { siteId }, select: { senderEmail: true } });
  const senderEmail = settings?.senderEmail?.trim();
  if (!senderEmail) return " Отправитель ещё не задан.";

  const apiKey = await resolveBrevoApiKey(prisma, siteId);
  if (!apiKey) return "";

  const r = await verifyBrevoSender(apiKey, senderEmail);
  if (!r.ok) return "";
  return r.verified
    ? ` Отправитель ${senderEmail} подтверждён.`
    : ` ВНИМАНИЕ: отправитель ${senderEmail} НЕ подтверждён в этом аккаунте — письма будут приняты и заблокированы на доставке.`;
}

/** Аудит действий с ключом магазина БЕЗ значения (только маска) — по образцу QUO signing secrets. */
function auditBrevoKeyAction(event: "saved" | "cleared", userId: string, siteId: string, maskedSuffix: string | null) {
  console.info(JSON.stringify({ scope: "integration-secret", provider: "BREVO", kind: "api_key", event, userId, siteId, maskedSuffix }));
}

/** Сохраняет/заменяет Brevo API key МАГАЗИНА. Полное значение не логируется и не возвращается. */
export async function ownerSaveBrevoApiKey(_prev: unknown, fd: FormData): Promise<Result> {
  const user = await requireRole("OWNER");
  const siteId = String(fd.get("siteId") ?? "");
  const bad = await requireSite(siteId);
  if (bad) return bad;
  const raw = String(fd.get("apiKey") ?? "");
  const res = await saveBrevoApiKey(prisma, siteId, raw);
  if (!res.ok) return { error: res.error };
  auditBrevoKeyAction("saved", user.id, siteId, res.maskedSuffix);
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "API key сохранён. Проверьте подключение перед включением рассылок." };
}

/** Удаляет ключ магазина. Запасного ключа нет — после этого Email магазина не отправляется. */
export async function ownerClearBrevoApiKey(siteId: string): Promise<Result> {
  const user = await requireRole("OWNER");
  const bad = await requireSite(siteId);
  if (bad) return bad;
  await clearBrevoApiKey(prisma, siteId);
  auditBrevoKeyAction("cleared", user.id, siteId, null);
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Ключ удалён. Email этого магазина отправляться не будет." };
}

/** GET /v3/account — подтверждает, что ключ реально работает, без отправки писем. */
export async function ownerVerifyBrevoConnection(siteId: string): Promise<Result> {
  await requireRole("OWNER");
  const bad = await requireSite(siteId);
  if (bad) return bad;
  const res = await verifyAndRecordBrevoConnection(prisma, siteId);
  revalidatePath("/dashboard/sites");
  if (!res.ok) return { error: res.error };

  // Живой ключ ещё не значит, что с нашего адреса разрешено слать. Спрашиваем отдельно —
  // именно на этом молча терялись письма из нового аккаунта.
  const senderNote = await describeSenderState(siteId);
  return { ok: true, message: `Подключение подтверждено${res.accountEmail ? ` (аккаунт: ${res.accountEmail})` : ""}.${senderNote}` };
}
