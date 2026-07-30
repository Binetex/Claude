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
import { createBrevoProvider } from "@/integrations/email/brevo";
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
  const apiKey = await resolveBrevoApiKey(prisma);
  const res = await sendSiteTestEmail(prisma, createBrevoProvider(apiKey), { siteId, to });
  revalidatePath("/dashboard/sites");
  return res.ok
    ? { ok: true, message: `Письмо отправлено${res.providerMessageId ? "" : " (Brevo не вернул messageId)"}` }
    : { error: res.safeError };
}

/** Аудит действий с общим ключом БЕЗ значения (только маска) — по образцу QUO signing secrets. */
function auditBrevoKeyAction(event: "saved" | "cleared", userId: string, maskedSuffix: string | null) {
  console.info(JSON.stringify({ scope: "integration-secret", provider: "BREVO", kind: "api_key", event, userId, maskedSuffix }));
}

/** Сохраняет/заменяет общий Brevo API key (весь workspace, не per-Site). Полное значение не логируется и не возвращается. */
export async function ownerSaveBrevoApiKey(_prev: unknown, fd: FormData): Promise<Result> {
  const user = await requireRole("OWNER");
  const raw = String(fd.get("apiKey") ?? "");
  const res = await saveBrevoApiKey(prisma, raw);
  if (!res.ok) return { error: res.error };
  auditBrevoKeyAction("saved", user.id, res.maskedSuffix);
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "API key сохранён. Проверьте подключение перед включением рассылок." };
}

/** Удаляет ключ из БД (после этого действует только env, если он задан). */
export async function ownerClearBrevoApiKey(): Promise<Result> {
  const user = await requireRole("OWNER");
  await clearBrevoApiKey(prisma);
  auditBrevoKeyAction("cleared", user.id, null);
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Ключ удалён из БД." };
}

/** GET /v3/account — подтверждает, что ключ реально работает, без отправки писем. */
export async function ownerVerifyBrevoConnection(): Promise<Result> {
  await requireRole("OWNER");
  const res = await verifyAndRecordBrevoConnection(prisma);
  revalidatePath("/dashboard/sites");
  return res.ok
    ? { ok: true, message: `Подключение подтверждено${res.accountEmail ? ` (аккаунт: ${res.accountEmail})` : ""}` }
    : { error: res.error };
}
