import "server-only";
/**
 * Ссылки на оплату Airwallex «на ходу»: клиент попросил счёт — вписал название и сумму, отдал
 * ссылку. Раньше это делалось в кабинете Airwallex, и владелец справедливо назвал это долгим.
 *
 * Своей таблицы ссылок НЕТ и заводить её нельзя — по той же причине, что у возвратов: правда
 * живёт у Airwallex, включая ссылки, созданные мимо нас в их кабинете, и их оплаты. Своя копия
 * молча разошлась бы, и «оплачено» стало бы враньём в самом неудобном месте.
 *
 * **Налог Airwallex не считает.** В запросе создания нет ни одного налогового поля (проверено на
 * живом API 24.09.2026): сколько передали — столько и спишут. CA tax владелец закладывает в
 * сумму сам, как делал и руками.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { AirwallexClient, type AirwallexPaymentLink } from "@/integrations/airwallex/client";
import { resolveAirwallexCreds } from "@/integrations/airwallex/settings";

export type PaymentLinksAccount = { siteId: string; siteName: string; client: AirwallexClient };

/**
 * Магазин, чьими ключами создаём ссылку. Ключи Airwallex есть не у всех: сейчас только у
 * TheFlow. Берём ПЕРВЫЙ настроенный по порядку имени — выбора из одного не предлагаем, а
 * когда магазинов с ключами станет больше, здесь появится явный выбор.
 */
export async function resolvePaymentLinksAccount(prisma: PrismaClient): Promise<PaymentLinksAccount | null> {
  const sites = await prisma.site.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  for (const s of sites) {
    const creds = await resolveAirwallexCreds(prisma, s.id).catch(() => null);
    if (creds) return { siteId: s.id, siteName: s.name, client: new AirwallexClient(creds) };
  }
  return null;
}

export type CreateLinkInput = { title: string; amount: string };
export type CreateLinkResult = { ok?: true; url?: string; error?: string };

/** Сумма из поля формы → число в долларах. Запятая допускается: её набирают чаще точки. */
export function parseAmount(raw: string): number | null {
  const n = Number(String(raw).trim().replace(",", ".").replace(/\s+/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  // Два знака после запятой — больше Airwallex не примет, а округление здесь честнее отказа.
  return Math.round(n * 100) / 100;
}

export async function createPaymentLink(prisma: PrismaClient, input: CreateLinkInput): Promise<CreateLinkResult> {
  const title = input.title.trim();
  if (!title) return { error: "Впишите название — его увидит клиент на странице оплаты." };
  const amount = parseAmount(input.amount);
  if (amount === null) return { error: "Сумма должна быть положительным числом." };

  const account = await resolvePaymentLinksAccount(prisma);
  if (!account) return { error: "Ключи Airwallex не настроены ни у одного магазина." };

  const res = await account.client.createPaymentLink({ title, amountMajor: amount, currency: "USD" });
  if (!res.ok) {
    if (res.code === "unauthorized") return { error: "Airwallex не принял ключи — проверьте их в настройках магазина." };
    // Текст валидации Airwallex точнее нашего пересказа: он называет само поле.
    return { error: res.message ?? "Airwallex не создал ссылку. Попробуйте ещё раз." };
  }
  return { ok: true, url: res.link.url };
}

export async function listPaymentLinks(prisma: PrismaClient): Promise<AirwallexPaymentLink[]> {
  const account = await resolvePaymentLinksAccount(prisma);
  if (!account) return [];
  const res = await account.client.listPaymentLinks(20);
  return res.ok ? res.links : [];
}
