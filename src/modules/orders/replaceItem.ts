import "server-only";
/**
 * Замена букета в заказе на другой из каталога (владелец 30.09.2026: «полная замена букета»).
 * У любого заказа: позиции после создания синхронизация с Shopify и WooCommerce не трогает, так
 * что замена не затрётся (сам заказ на витрине остаётся прежним).
 *
 * Позиция получает снимок нового товара — название, вариант, фото, состав, как у ручного заказа
 * (`manualOrder.ts`), — и новую цену клиенту. Разница цены ложится в «Сумму товаров» и «Итог
 * заказчика»: из них считаются прибыль, день и эквайринг. Цена флористу пересчитывается ТОЛЬКО у
 * этой позиции (снимок остальных сделан при назначении), а сумма флористу — только при авто-цене:
 * ручную владелец правит сам. Флорист получает НОВУЮ карточку с новым фото (`order.item_replaced`) —
 * править старую нельзя: фото у сообщения Telegram не меняется, осталась бы подпись к чужому фото.
 */
import { Prisma, type Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { fmtStoreDayTime } from "@/lib/tz";
import { displayVariantName } from "@/lib/variantName";
import { recomputeEstimatedProfit, snapshotItemFloristPrice } from "@/modules/pricing/service";
import { recomputeDayForOrder } from "@/modules/finance/orderDayHook";
import { publishTelegramNotification } from "@/integrations/telegram/events";

/** Больше этого за штуку — почти наверняка лишний ноль. */
const MAX_UNIT_PRICE = 5000;

export type ReplaceItemInput = {
  productId: string;
  variantId: string | null;
  /** Цена клиенту за штуку. */
  customerPrice: number;
  /** Состав — снимок ЭТОГО заказа; пусто — берём из каталога. */
  composition: string | null;
  notifyFlorist: boolean;
};

export type ReplaceItemResult = { ok: true } | { ok: false; error: string };

const label = (name: string, variant: string | null) => (variant ? `${name}, ${variant}` : name);
const money = (n: number) => new Prisma.Decimal(n.toFixed(2));

export async function replaceOrderItem(
  orderId: string,
  itemId: string,
  input: ReplaceItemInput,
  actor: { userId: string; role: Role }
): Promise<ReplaceItemResult> {
  const unit = Math.round(input.customerPrice * 100) / 100;
  if (!Number.isFinite(unit) || unit < 0) return { ok: false, error: "Цена клиенту — число не меньше нуля." };
  if (unit > MAX_UNIT_PRICE) return { ok: false, error: `Больше $${MAX_UNIT_PRICE} за штуку — проверьте цену.` };

  const [order, item] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: {
        siteId: true, itemsTotal: true, customerTotal: true, floristTotal: true, priceMode: true, currentFloristId: true,
        customerNote: true, site: { select: { timezone: true } },
      },
    }),
    prisma.orderItem.findUnique({ where: { id: itemId }, select: { orderId: true, name: true, variantName: true, quantity: true, externalPrice: true, floristItemPrice: true } }),
  ]);
  if (!order || !item || item.orderId !== orderId) return { ok: false, error: "Позиция заказа не найдена — обновите страницу." };

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: {
      id: true, siteId: true, name: true, image: true, externalId: true,
      variants: { where: { id: input.variantId ?? "" }, select: { id: true, title: true, sku: true, image: true, externalId: true, floristComposition: true } },
    },
  });
  // Товар чужого магазина — почти наверняка ошибка выбора: у каждого магазина свой каталог и цены.
  if (!product || product.siteId !== order.siteId) return { ok: false, error: "Товар не найден в каталоге этого магазина." };
  const variant = input.variantId ? product.variants[0] : undefined;
  if (input.variantId && !variant) return { ok: false, error: "Вариант товара не найден — обновите страницу." };

  const diff = (unit - Number(item.externalPrice)) * item.quantity;
  const itemsTotal = { from: Number(order.itemsTotal), to: Number(order.itemsTotal) + diff };
  const customerTotal = { from: Number(order.customerTotal), to: Number(order.customerTotal) + diff };
  if (customerTotal.to < 0) return { ok: false, error: "Итог заказчика ушёл бы в минус — проверьте цену." };

  // «Default Title» Shopify — заглушка платформы, а не вариант (правило одно: lib/variantName).
  const variantName = displayVariantName(variant?.title);
  const before = label(item.name, item.variantName);
  const after = label(product.name, variantName);
  const line = `${fmtStoreDayTime(new Date(), order.site?.timezone)} · Букет заменён: ${before} → ${after}`;

  const audit = await prisma.$transaction(async (tx) => {
    await tx.orderItem.update({
      where: { id: itemId },
      data: {
        productId: product.id,
        variantId: variant?.id ?? null,
        productExternalId: product.externalId,
        variantExternalId: variant?.externalId ?? null,
        name: product.name,
        variantName,
        sku: variant?.sku ?? null,
        image: variant?.image ?? product.image,
        parentImageUrl: product.image,
        variantImageUrl: variant?.image ?? null,
        floristCompositionSnapshot: input.composition?.trim() || variant?.floristComposition || null,
        externalPrice: money(unit),
        // Финансовый тип — от нового товара из каталога, а не прежний снимок ручной позиции.
        financialTypeSnapshot: null,
        purchaseCostSnapshotCents: null,
        // Без флориста цена фиксируется при назначении; до него — ноль, как у всех позиций.
        ...(order.currentFloristId ? {} : { floristItemPrice: new Prisma.Decimal(0) }),
      },
    });

    let floristTotal: { from: number; to: number } | null = null;
    if (order.currentFloristId) {
      const newLine = await snapshotItemFloristPrice(tx, itemId, order.currentFloristId);
      // Ручную цену флористу владелец правит сам — сумму заказа трогаем только при авто-цене.
      if (order.priceMode === "AUTO") {
        const to = Number(order.floristTotal) - Number(item.floristItemPrice) + Number(newLine);
        floristTotal = { from: Number(order.floristTotal), to };
        await tx.order.update({ where: { id: orderId }, data: { floristTotal: money(to) } });
      }
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        itemsTotal: money(itemsTotal.to),
        customerTotal: money(customerTotal.to),
        customerNote: order.customerNote.trim() ? `${line}\n${order.customerNote}` : line,
      },
    });
    const row = await tx.orderAudit.create({
      data: {
        orderId, userId: actor.userId, role: actor.role, block: "item_replace",
        changed: { item: { from: before, to: after }, itemsTotal, customerTotal, ...(floristTotal ? { floristTotal } : {}) },
      },
      select: { id: true },
    });
    await recomputeEstimatedProfit(tx, orderId);
    return row;
  });

  // Вне транзакции: пересчёт дня ходит по своим таблицам и не должен держать блокировки заказа.
  await recomputeDayForOrder(prisma, orderId).catch(() => {
    // Финансы не имеют права уронить замену — тот же принцип, что у orderDayHook.
  });

  if (input.notifyFlorist && order.currentFloristId) {
    await publishTelegramNotification(prisma, {
      type: "order.item_replaced",
      orderId,
      floristId: order.currentFloristId,
      occurrenceKey: `${orderId}:${order.currentFloristId}:replaced:${audit.id}`,
      // occurrence — в ключ сообщения: без него вторая замена молча правила бы первую карточку
      // (под фото прежнего букета), а флорист не узнал бы о ней вовсе.
      context: { replacedFrom: before, occurrence: audit.id },
    });
  }
  return { ok: true };
}
