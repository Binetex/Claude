import { format } from "date-fns";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OrderStatus, Role } from "@/generated/prisma/enums";
import { normalizePhone } from "@/lib/phone";
import { manualOrderStatuses } from "@/lib/statuses";

/**
 * Общий сервис редактирования ОДНОГО блока заказа с оптимистической блокировкой (OCC) и
 * аудитом в одной транзакции. Используется тонкими server actions (owner/call-center/florist),
 * чтобы был ЕДИНЫЙ путь обновления заказа.
 *
 * OCC: атомарный updateMany по (id + updatedAt = expectedUpdatedAt). Если строку уже изменил
 * другой пользователь — count === 0 → CONFLICT (без записи, без audit), возвращаем свежие значения
 * из БД, чтобы UI показал их пользователю. Никакого silent overwrite.
 *
 * Обновляются ТОЛЬКО поля выбранного блока. `changed` в аудите — только реально изменившиеся
 * поля (before/after), без секретов/паролей (в этих блоках их нет).
 */

export type OrderBlock = "contacts" | "sender" | "status" | "delivery" | "cardNote";

/** Значения полей блока в «плоском» строковом виде — как их отдаёт/принимает форма UI. */
export type BlockFormData = Record<string, string | null | undefined>;

export type OrderBlockChange = { from: unknown; to: unknown };

export type UpdateOrderBlockResult =
  | { status: "ok"; updatedAt: string; changed: Record<string, OrderBlockChange> }
  | { status: "conflict"; current: Record<string, string>; updatedAt: string }
  | { status: "notfound" }
  | { status: "invalid"; error: string };

// Поля, читаемые/пишущиеся для каждого блока (Prisma select).
const BLOCK_SELECT: Record<OrderBlock, Prisma.OrderSelect> = {
  contacts: {
    recipientName: true, recipientPhone: true, recipientEmail: true,
    addressLine: true, apartment: true, city: true, zip: true,
  },
  sender: { senderName: true, senderPhone: true, senderEmail: true },
  status: { orderStatus: true },
  delivery: { deliveryDate: true, deliveryWindow: true },
  cardNote: { cardMessage: true, customerNote: true },
};

/** Строит Prisma-`data` только из присланных полей блока (нормализация телефонов/дат). */
function buildUpdateData(block: OrderBlock, data: BlockFormData): { data: Prisma.OrderUpdateInput } | { error: string } {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(data, k);
  const str = (k: string) => (data[k] ?? "").toString();
  const strOrNull = (k: string) => {
    const v = (data[k] ?? "").toString().trim();
    return v === "" ? null : v;
  };

  switch (block) {
    case "contacts": {
      const out: Prisma.OrderUpdateInput = {};
      if (has("recipientName")) out.recipientName = str("recipientName");
      if (has("recipientPhone")) out.recipientPhone = normalizePhone(str("recipientPhone"));
      if (has("recipientEmail")) out.recipientEmail = strOrNull("recipientEmail");
      if (has("addressLine")) out.addressLine = str("addressLine");
      if (has("apartment")) out.apartment = strOrNull("apartment");
      if (has("city")) out.city = str("city");
      if (has("zip")) out.zip = str("zip");
      return { data: out };
    }
    case "sender": {
      const out: Prisma.OrderUpdateInput = {};
      if (has("senderName")) out.senderName = str("senderName");
      if (has("senderPhone")) out.senderPhone = normalizePhone(str("senderPhone"));
      if (has("senderEmail")) out.senderEmail = strOrNull("senderEmail");
      return { data: out };
    }
    case "status": {
      const status = str("orderStatus") as OrderStatus;
      if (!manualOrderStatuses.includes(status)) return { error: "Недопустимый статус." };
      return { data: { orderStatus: status } };
    }
    case "delivery": {
      const out: Prisma.OrderUpdateInput = {};
      if (has("deliveryDate")) {
        const raw = str("deliveryDate");
        if (raw) {
          const d = new Date(raw);
          if (Number.isNaN(d.getTime())) return { error: "Некорректная дата доставки." };
          out.deliveryDate = d;
        }
      }
      if (has("deliveryWindow")) out.deliveryWindow = str("deliveryWindow");
      return { data: out };
    }
    case "cardNote": {
      const out: Prisma.OrderUpdateInput = {};
      if (has("cardMessage")) out.cardMessage = str("cardMessage");
      if (has("customerNote")) out.customerNote = str("customerNote");
      return { data: out };
    }
  }
}

/** Нормализует значение поля к сравнимому виду для diff и для отдачи в форму (даты → строки). */
function fieldToString(key: string, value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    // deliveryDate форматируем как в форме (yyyy-MM-dd), остальные даты — ISO.
    return key === "deliveryDate" ? format(value, "yyyy-MM-dd") : value.toISOString();
  }
  return String(value);
}

/** Приводит строку заказа к «плоскому» виду, который понимает форма UI. */
function toFormShape(block: OrderBlock, row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(BLOCK_SELECT[block])) {
    out[key] = fieldToString(key, row[key]);
  }
  return out;
}

/** Только реально изменившиеся поля блока: { field: { from, to } }. */
function diffChanged(block: OrderBlock, before: Record<string, unknown>, after: Record<string, unknown>) {
  const changed: Record<string, OrderBlockChange> = {};
  for (const key of Object.keys(BLOCK_SELECT[block])) {
    const from = fieldToString(key, before[key]);
    const to = fieldToString(key, after[key]);
    if (from !== to) changed[key] = { from: before[key] instanceof Date ? from : before[key] ?? null, to: after[key] instanceof Date ? to : after[key] ?? null };
  }
  return changed;
}

export async function updateOrderBlock(input: {
  orderId: string;
  block: OrderBlock;
  expectedUpdatedAt: string;
  data: BlockFormData;
  actor: { userId: string; role: Role };
}): Promise<UpdateOrderBlockResult> {
  const built = buildUpdateData(input.block, input.data);
  if ("error" in built) return { status: "invalid", error: built.error };

  const select = BLOCK_SELECT[input.block];
  const selectWithTs = { ...select, updatedAt: true } as Prisma.OrderSelect;
  const expected = new Date(input.expectedUpdatedAt);
  if (Number.isNaN(expected.getTime())) return { status: "invalid", error: "Некорректная версия записи." };

  return prisma.$transaction(async (tx) => {
    const before = await tx.order.findUnique({ where: { id: input.orderId }, select });
    if (!before) return { status: "notfound" };

    // Атомарная OCC: обновит строку только если updatedAt всё ещё равен ожидаемому.
    const upd = await tx.order.updateMany({
      where: { id: input.orderId, updatedAt: expected },
      data: built.data,
    });

    if (upd.count === 0) {
      // Кто-то изменил заказ раньше — читаем СВЕЖИЕ значения (не before, оно могло устареть).
      const fresh = await tx.order.findUnique({ where: { id: input.orderId }, select: selectWithTs });
      if (!fresh) return { status: "notfound" };
      const { updatedAt, ...rest } = fresh as Record<string, unknown> & { updatedAt: Date };
      return { status: "conflict", current: toFormShape(input.block, rest), updatedAt: updatedAt.toISOString() };
    }

    const after = await tx.order.findUnique({ where: { id: input.orderId }, select: selectWithTs });
    const { updatedAt, ...afterRest } = after as Record<string, unknown> & { updatedAt: Date };
    const changed = diffChanged(input.block, before as Record<string, unknown>, afterRest);

    await tx.orderAudit.create({
      data: {
        orderId: input.orderId,
        userId: input.actor.userId,
        role: input.actor.role,
        block: input.block,
        changed: changed as Prisma.InputJsonValue,
      },
    });

    return { status: "ok", updatedAt: updatedAt.toISOString(), changed };
  });
}
