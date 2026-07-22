"use server";
import { revalidatePath } from "next/cache";
import { requireOrderEditor } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { syncOrderToShopify } from "@/integrations/shopify/pushUpdate";
import { onOrderDeliveryChangeSafe } from "@/integrations/delivery/burq/scheduleService";
import { scheduleDeliveryTodayTrigger } from "@/modules/automations/lifecycle";
import { updateOrderBlock, type OrderBlock, type BlockFormData } from "./updateOrderBlock";
import { findUnlinkedCommunicationsForOrderPhone, attachUnlinkedCommunicationsToOrder, type OrderPhoneSide } from "@/integrations/quo/communicationsService";

/**
 * ЕДИНЫЙ путь редактирования блока заказа для всех редакторов (owner/call-center/florist).
 * Тонкая обёртка: role guard + владение (для флориста) + OCC-сервис + побочные эффекты + revalidate.
 * Финансовые действия и назначение флориста сюда НЕ входят — они остаются OWNER-only.
 */

export type SaveOrderBlockResult =
  | { status: "ok"; updatedAt: string }
  | { status: "conflict"; current: Record<string, string>; updatedAt: string }
  | { status: "forbidden" }
  | { status: "notfound" }
  | { status: "invalid"; error: string };

// Побочные эффекты после успешного сохранения блока (как в owner-actions).
// Внешние вызовы не должны «ронять» уже закоммиченное сохранение — оборачиваем безопасно.
async function runPostSave(block: OrderBlock, orderId: string) {
  try {
    if (block === "contacts") {
      await syncOrderToShopify(orderId);
      await onOrderDeliveryChangeSafe(prisma, orderId); // адрес/телефон получателя = dropoff
    } else if (block === "delivery") {
      await onOrderDeliveryChangeSafe(prisma, orderId); // дата/окно влияют на availableAt/dropoff_at
      await scheduleDeliveryTodayTrigger(prisma, orderId); // триггер «Доставка сегодня» — на новый день
    } else if (block === "cardNote") {
      await syncOrderToShopify(orderId); // cardMessage уходит в Shopify note
    }
  } catch (e) {
    console.error(`[saveOrderBlock] post-save hook failed (block=${block}, order=${orderId})`, e);
  }
}

function revalidateOrder(orderId: string) {
  // Один заказ виден на трёх дашбордах — обновляем все, чтобы не было рассинхрона.
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath("/dashboard/orders");
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/cc/${orderId}`);
  revalidatePath("/dashboard/cc");
  revalidatePath(`/dashboard/f/${orderId}`);
  revalidatePath("/dashboard/f");
}

export async function saveOrderBlock(
  orderId: string,
  block: OrderBlock,
  expectedUpdatedAt: string,
  data: BlockFormData
): Promise<SaveOrderBlockResult> {
  const user = await requireOrderEditor();

  // Флорист может редактировать ТОЛЬКО назначенный на него заказ (rbac не знает orderId).
  if (user.role === "FLORIST") {
    const own = await prisma.order.findUnique({ where: { id: orderId }, select: { currentFloristId: true } });
    if (!own || !user.floristId || own.currentFloristId !== user.floristId) {
      return { status: "forbidden" };
    }
  }

  const res = await updateOrderBlock({
    orderId,
    block,
    expectedUpdatedAt,
    data,
    actor: { userId: user.id, role: user.role },
  });

  if (res.status === "ok") {
    await runPostSave(block, orderId);
    revalidateOrder(orderId);
    return { status: "ok", updatedAt: res.updatedAt };
  }
  return res;
}

/** Редактор + (для флориста) владение заказом. Возвращает false, если нет прав. */
async function canEditOrder(orderId: string): Promise<boolean> {
  const user = await requireOrderEditor();
  if (user.role === "FLORIST") {
    const own = await prisma.order.findUnique({ where: { id: orderId }, select: { currentFloristId: true } });
    if (!own || !user.floristId || own.currentFloristId !== user.floristId) return false;
  }
  return true;
}

/**
 * Сколько НЕПРИВЯЗАННЫХ QUO-сообщений есть по телефону стороны заказа (в рамках QUO-номера сайта).
 * Вызывается после смены senderPhone/recipientPhone, чтобы предложить привязку. Ничего не меняет.
 */
export async function checkUnlinkedComms(orderId: string, side: OrderPhoneSide): Promise<{ count: number }> {
  if (!(await canEditOrder(orderId))) return { count: 0 };
  const { ids } = await findUnlinkedCommunicationsForOrderPhone(prisma, orderId, side);
  return { count: ids.length };
}

/**
 * Привязывает найденные непривязанные сообщения к заказу с ролью стороны. Идемпотентно
 * (updateMany строго по orderId=null), чужие/уже привязанные не трогает, дублей не создаёт.
 */
export async function attachUnlinkedComms(orderId: string, side: OrderPhoneSide): Promise<{ attached: number }> {
  if (!(await canEditOrder(orderId))) return { attached: 0 };
  const r = await attachUnlinkedCommunicationsToOrder(prisma, orderId, side);
  if (r.attached > 0) revalidateOrder(orderId);
  return r;
}
