import "server-only";
/**
 * Подбор «опоздавших» коммуникаций при появлении заказа.
 *
 * Привязка события QUO к заказу считается ОДИН раз — в момент приёма события (см. ingest.ts).
 * Если клиент написал или позвонил ДО того, как заказ попал в Floremart (вебхук магазина
 * опоздал, ручной ввод, backfill), сообщение остаётся сиротой навсегда: повторно его никто не
 * пересматривает. За 30 дней так потерялось 39 событий — они привязались бы, если бы матчинг
 * просто переспросили позже.
 *
 * Ключевая деталь: спрашиваем ИМЕННО МАТЧЕР (`matchCommunicationToOrder`), а не привязываем к
 * новому заказу по совпадению телефона. Иначе сироты уехали бы в первый попавшийся заказ с этим
 * номером — а он вполне может быть неоплаченным дублем, созданным на 53 секунды раньше
 * настоящего (см. NON_ACTIVE_STATUSES в matching.ts). Матчер — единственный судья, кому
 * принадлежит сообщение; здесь мы лишь даём ему второй шанс.
 *
 * Свои ошибки ГЛОТАЕТ: приём заказа не имеет права падать из-за истории переписки (то же
 * правило, что у финансового хука `recomputeDayForOrder`).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { toE164 } from "@/lib/phone";
import { findCandidateOrdersByPhone } from "./ingest";
import { matchCommunicationToOrder } from "./matching";

/** Сколько сирот максимум разбираем за один заказ — защита от неожиданно большой выборки. */
const MAX_ORPHANS_PER_ORDER = 50;

export async function adoptOrphanCommunicationsForNewOrder(
  prisma: PrismaClient,
  orderId: string
): Promise<{ attached: number }> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        siteId: true,
        senderPhone: true,
        recipientPhone: true,
        site: { select: { quoPhoneNumberId: true, quoEnabled: true } },
      },
    });
    // Нет QUO-номера у магазина или он выключен — сирот этого магазина не существует.
    if (!order?.site?.quoPhoneNumberId || !order.site.quoEnabled) return { attached: 0 };

    const phones = [...new Set([toE164(order.senderPhone), toE164(order.recipientPhone)].filter((p): p is string => !!p))];
    if (phones.length === 0) return { attached: 0 };

    // Строго в рамках QUO-номера этого магазина: чужую переписку не трогаем.
    const orphans = await prisma.orderCommunication.findMany({
      where: {
        orderId: null,
        ignoredAt: null,
        provider: "QUO",
        providerPhoneNumberId: order.site.quoPhoneNumberId,
        externalPhoneNormalized: { in: phones },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ORPHANS_PER_ORDER,
      select: { id: true, externalPhoneNormalized: true, occurredAt: true, createdAt: true },
    });
    if (orphans.length === 0) return { attached: 0 };

    // Кандидаты зависят только от телефона и сайта, а телефонов максимум два — считаем их один раз.
    const candidatesByPhone = new Map<string, Awaited<ReturnType<typeof findCandidateOrdersByPhone>>>();
    for (const p of phones) candidatesByPhone.set(p, await findCandidateOrdersByPhone(prisma, p, order.siteId));

    let attached = 0;
    for (const o of orphans) {
      const e164 = toE164(o.externalPhoneNormalized);
      if (!e164) continue;
      const candidates = candidatesByPhone.get(e164);
      if (!candidates?.length) continue;

      const m = matchCommunicationToOrder(e164, o.occurredAt ?? o.createdAt, candidates);
      if (!m.matched) continue; // ambiguous/no_candidate — оставляем в «Нераспознанных», как и было

      // Условие orderId=null — защита от гонки: если событие успели привязать вручную, не перебиваем.
      const res = await prisma.orderCommunication.updateMany({
        where: { id: o.id, orderId: null, ignoredAt: null },
        data: { orderId: m.orderId, partyRole: m.partyRole },
      });
      attached += res.count;
    }
    return { attached };
  } catch (err) {
    console.error(`[quo] подбор опоздавших коммуникаций для заказа ${orderId} не удался:`, err instanceof Error ? err.message : String(err));
    return { attached: 0 };
  }
}
