import "server-only";
/**
 * Оплаченный заказ с адресом, который курьеру не отдать (владелец 30.09.2026, THEFLOW-20867:
 * «забыла указать номер дома, и заказ ушёл в Burq хуй пойми куда»).
 *
 * В Burq такой заказ сам не уйдёт (`burq/eligibility.ts`, причина `address_incomplete`) — а
 * значит, люди обязаны узнать сразу, пока до доставки есть время: владельцу и колл-центру
 * уходит сигнал с адресом и телефоном заказчика. Заказчика просит дописать адрес правило
 * автоматизаций на триггер `ORDER_ADDRESS_INCOMPLETE`: текст, каналы и выключатель — у владельца,
 * а ответ приходит в переписку заказа. Пустой адрес заказчику НЕ пишем: это может быть самовывоз,
 * и просить у него «номер дома» нелепо, — людям сигнал уходит и тогда.
 *
 * Вызывается один раз — на переходе заказа в оплаченный (`automations/lifecycle.ts`). Best-effort:
 * сбой сигнала не ломает приём заказа.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { deliveryAddressIssue } from "@/lib/addressCheck";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAutomationTrigger } from "@/modules/automations/events";

export async function flagIncompleteAddress(prisma: PrismaClient, args: { orderId: string; siteId: string }): Promise<void> {
  try {
    const order = await prisma.order.findUnique({ where: { id: args.orderId }, select: { addressLine: true } });
    if (!order) return;
    const issue = deliveryAddressIssue(order.addressLine);
    if (!issue) return;
    for (const type of ["order.address_incomplete", "order.address_incomplete_cc"] as const) {
      await publishTelegramNotification(prisma, { type, orderId: args.orderId, occurrenceKey: args.orderId, context: { issue } });
    }
    if (issue === "no_house_number") {
      await publishAutomationTrigger(new PrismaOutboxRepository(prisma), {
        orderId: args.orderId,
        siteId: args.siteId,
        triggerType: "ORDER_ADDRESS_INCOMPLETE",
        occurrenceKey: `${args.orderId}:ORDER_ADDRESS_INCOMPLETE`,
      });
    }
  } catch (err) {
    console.error(`[orders] сигнал «адрес без номера дома» по заказу ${args.orderId} не ушёл:`, err instanceof Error ? err.message : String(err));
  }
}
