import "server-only";
/**
 * Доплата к заказу (владелец 29.09.2026: «клиент в последний момент решил доплатить за другой
 * букет»). У ЛЮБОГО заказа, не только ручного.
 *
 * Сумма ложится в «Сумму товаров» и «Итог заказчика»: из них считаются прибыль, дневные финансы и
 * эквайринг, и отдельная строка денег потребовала бы править каждую формулу. Сколько из суммы
 * товаров — доплата, помнит журнал правок (OrderAudit, block "surcharge"): по нему карточка и
 * пишет «в т.ч. доплата». Синхронизация с Shopify и WooCommerce суммы после создания заказа не
 * трогает, так что правка не затрётся (в отличие от налога и чаевых — см. manualCharges.ts).
 *
 * Что изменилось — строкой в заметку заказа (её видит флорист в карточке) и, по желанию, сообщением
 * флористу в Telegram. Саму сумму флорист не видит: деньги заказа — только владельцу. Цена флористу
 * этим не меняется: за букет дороже она правится отдельно, в «Цене флористу».
 */
import { Prisma, type Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { fmtStoreDayTime } from "@/lib/tz";
import { recomputeEstimatedProfit } from "@/modules/pricing/service";
import { recomputeDayForOrder } from "@/modules/finance/orderDayHook";
import { publishTelegramNotification } from "@/integrations/telegram/events";

/** Больше этого — почти наверняка лишний ноль: такую доплату вписывают заказом, а не правкой. */
const MAX_SURCHARGE = 5000;
const NOTE_MAX = 300;

export type SurchargeResult = { ok: true } | { ok: false; error: string };

export async function addOrderSurcharge(
  orderId: string,
  input: { amount: number; note: string; notifyFlorist: boolean },
  actor: { userId: string; role: Role }
): Promise<SurchargeResult> {
  const amount = Math.round(input.amount * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Сумма доплаты должна быть больше нуля." };
  if (amount > MAX_SURCHARGE) return { ok: false, error: `Больше $${MAX_SURCHARGE} доплатой не вписываем — проверьте сумму.` };
  const note = input.note.trim().replace(/\s+/g, " ");
  if (!note) return { ok: false, error: "Напишите, что изменилось, — это увидит флорист." };
  if (note.length > NOTE_MAX) return { ok: false, error: `Не длиннее ${NOTE_MAX} символов.` };

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { itemsTotal: true, customerTotal: true, customerNote: true, currentFloristId: true, site: { select: { timezone: true } } },
  });
  if (!order) return { ok: false, error: "Заказ не найден." };

  const itemsTotal = { from: Number(order.itemsTotal), to: Number(order.itemsTotal) + amount };
  const customerTotal = { from: Number(order.customerTotal), to: Number(order.customerTotal) + amount };
  const line = `${fmtStoreDayTime(new Date(), order.site?.timezone)} · Изменение заказа: ${note}`;

  const audit = await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        itemsTotal: new Prisma.Decimal(itemsTotal.to.toFixed(2)),
        customerTotal: new Prisma.Decimal(customerTotal.to.toFixed(2)),
        customerNote: order.customerNote.trim() ? `${line}\n${order.customerNote}` : line,
      },
    });
    const row = await tx.orderAudit.create({
      data: { orderId, userId: actor.userId, role: actor.role, block: "surcharge", changed: { itemsTotal, customerTotal, surcharge: { amount, note } } },
      select: { id: true },
    });
    await recomputeEstimatedProfit(tx, orderId);
    return row;
  });

  // Вне транзакции: пересчёт дня ходит по своим таблицам и не должен держать блокировки заказа.
  await recomputeDayForOrder(prisma, orderId).catch(() => {
    // Финансы не имеют права уронить сохранение доплаты — тот же принцип, что у orderDayHook.
  });

  if (input.notifyFlorist && order.currentFloristId) {
    await publishTelegramNotification(prisma, {
      type: "order.florist_note",
      orderId,
      floristId: order.currentFloristId,
      occurrenceKey: `${orderId}:${order.currentFloristId}:note:${audit.id}`,
      // occurrence — в ключ сообщения: каждое изменение флорист получает НОВЫМ сообщением.
      context: { text: note, occurrence: audit.id },
    });
  }
  return { ok: true };
}

/** Сколько всего доплатили по заказу — из журнала правок. */
export async function orderSurchargeTotal(orderId: string): Promise<number> {
  const rows = await prisma.orderAudit.findMany({ where: { orderId, block: "surcharge" }, select: { changed: true } });
  const cents = rows.reduce((sum, r) => {
    const amount = (r.changed as { surcharge?: { amount?: unknown } } | null)?.surcharge?.amount;
    return sum + (typeof amount === "number" ? Math.round(amount * 100) : 0);
  }, 0);
  return cents / 100;
}
