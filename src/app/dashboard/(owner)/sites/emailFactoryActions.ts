"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { saveEmailFactoryToken, clearEmailFactoryToken, resolveEmailFactoryToken } from "@/integrations/emailFactory/token";
import { listDomains } from "@/integrations/emailFactory/client";

export type ActionResult = { ok?: true; message?: string; error?: string };

/**
 * Токен — ОДИН на аккаунт (он видит все домены), поэтому живёт на странице списка сайтов, а не
 * внутри каждого. Выбор домена, наоборот, у каждого магазина свой — см. ownerSetSiteEmailFactoryDomain.
 */
export async function ownerSaveEmailFactoryToken(token: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const res = await saveEmailFactoryToken(prisma, token);
  if ("error" in res) return { error: res.error };
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Токен сохранён." };
}

export async function ownerClearEmailFactoryToken(): Promise<ActionResult> {
  await requireRole("OWNER");
  await clearEmailFactoryToken(prisma);
  revalidatePath("/dashboard/sites");
  return { ok: true, message: "Токен удалён." };
}

/** Домены аккаунта для выпадающего списка. Спрашиваются у Email Factory, у нас не хранятся. */
export async function ownerListEmailFactoryDomains(): Promise<{ domains?: { domain: string; email: string }[]; error?: string }> {
  await requireRole("OWNER");
  const token = await resolveEmailFactoryToken(prisma);
  if (!token) return { error: "Токен Email Factory не задан." };
  const res = await listDomains(token);
  if (!res.ok) return { error: res.detail ?? res.code };
  // Только готовые: выбрать неподтверждённый домен значит настроить отправку, которая не работает.
  return { domains: res.data.filter((d) => d.status.toUpperCase() === "READY").map((d) => ({ domain: d.domain, email: d.email })) };
}

export async function ownerSetSiteEmailFactoryDomain(siteId: string, domain: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const value = domain.trim();
  // Пустая строка — осознанный сброс «не выбран», а не ошибка ввода.
  if (value !== "") {
    // Сверяем со списком аккаунта: форма отдаёт только подтверждённые домены, но server action
    // вызывается и напрямую. Иначе на экране было бы зелёное «домен выбран», а первое письмо
    // упиралось бы в domain_not_ready — ошибка всплыла бы там, где её не ждут.
    const token = await resolveEmailFactoryToken(prisma);
    if (!token) return { error: "Токен Email Factory не задан." };
    const res = await listDomains(token);
    if (!res.ok) return { error: res.detail ?? res.code };
    const known = res.data.some((d) => d.domain.toLowerCase() === value.toLowerCase() && d.status.toUpperCase() === "READY");
    if (!known) return { error: `Домен ${value} не подтверждён в Email Factory.` };
  }
  await prisma.site.update({ where: { id: siteId }, data: { emailFactoryDomain: value === "" ? null : value } });
  revalidatePath(`/dashboard/sites/${siteId}`);
  return { ok: true, message: value === "" ? "Домен снят." : `Домен ${value} сохранён.` };
}
