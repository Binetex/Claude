"use server";
/**
 * Email-настройки магазина (owner-only).
 *
 * Общий API key Brevo здесь НЕ фигурирует: он живёт только в env, в формы не приходит и наружу
 * не отдаётся. Действия меняют лишь per-Site поля: отправитель, reply-to, sender ID, шаблоны.
 *
 * Тестовое письмо — единственное место этапа 1, которое реально обращается к Brevo, и только по
 * явному нажатию владельца.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { createBrevoProvider } from "@/integrations/email/brevo";
import { saveSiteEmailSettings, saveSiteEmailTemplate } from "@/integrations/email/settings";
import { sendSiteTestEmail } from "@/integrations/email/testSend";

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
  const res = await sendSiteTestEmail(prisma, createBrevoProvider(), { siteId, to });
  revalidatePath("/dashboard/sites");
  return res.ok
    ? { ok: true, message: `Письмо отправлено${res.providerMessageId ? "" : " (Brevo не вернул messageId)"}` }
    : { error: res.safeError };
}
