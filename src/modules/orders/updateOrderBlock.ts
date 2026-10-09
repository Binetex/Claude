import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { parseHm, parseWindowText, windowFields } from "@/lib/deliveryWindow";
import type { OrderStatus, Role } from "@/generated/prisma/enums";
import { COURIER_NOTE_MAX } from "@/lib/courierNote";
import { normalizePhone } from "@/lib/phone";
import { recomputeDaysForOrder } from "@/modules/finance/orderDayHook";
import { manualOrderStatuses } from "@/lib/statuses";
import { localDateStr, parseLocalDayToUtcMidnight } from "@/lib/tz";
import { mergeNoteEdit } from "@/lib/noteMerge";

/**
 * Общий сервис редактирования ОДНОГО блока заказа с аудитом в одной транзакции. Используется
 * тонкими server actions (owner/call-center/florist), чтобы был ЕДИНЫЙ путь обновления заказа.
 *
 * Пишутся ТОЛЬКО присланные поля, и формы присылают только то, что человек изменил. Сверки
 * версии строки («заказ изменён другим пользователем») НЕТ (владелец 07.10.2026): версия была
 * одна на весь заказ, а заказ всё время трогает сама система — синхронизация с сайтом, Burq, ИИ,
 * финансы, — и почти каждое сохранение кончалось ложным конфликтом. Кто что менял — в аудите.
 *
 * `changed` в аудите — только реально изменившиеся поля (before/after), без секретов/паролей
 * (в этих блоках их нет).
 */

export type OrderBlock = "contacts" | "sender" | "status" | "delivery" | "cardNote" | "courierNote";

/** Значения полей блока в «плоском» строковом виде — как их отдаёт/принимает форма UI. */
export type BlockFormData = Record<string, string | null | undefined>;

export type OrderBlockChange = { from: unknown; to: unknown };

export type UpdateOrderBlockResult =
  | { status: "ok"; changed: Record<string, OrderBlockChange> }
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
  delivery: { deliveryDate: true, deliveryWindow: true, windowFrom: true, windowTo: true },
  cardNote: { cardMessage: true, customerNote: true },
  courierNote: { courierNote: true },
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
          // Тем же разбором, что и приём заказов: день берётся как написан, без участия
          // таймзоны сервера (Order.deliveryDate = UTC-полночь локального дня).
          const d = parseLocalDayToUtcMidnight(raw);
          if (!d) return { error: "Некорректная дата доставки." };
          out.deliveryDate = d;
        }
      }
      if (has("windowFrom") || has("windowTo")) {
        // Окно строго «с — до» из выбора времени; текст окна пишет система одним форматом.
        const from = parseHm(str("windowFrom"));
        const to = parseHm(str("windowTo"));
        if (from == null && to == null) Object.assign(out, windowFields(null));
        else if (from == null || to == null || !(from < to)) return { error: "Время «с» должно быть раньше «до»." };
        else Object.assign(out, windowFields({ from, to }));
      } else if (has("deliveryWindow")) {
        // Старый путь — текстом: разбираем тем же разбором, что и приём заказов.
        const range = parseWindowText(str("deliveryWindow"));
        Object.assign(out, range ? windowFields(range) : { deliveryWindow: str("deliveryWindow"), windowFrom: null, windowTo: null });
      }
      return { data: out };
    }
    case "cardNote": {
      const out: Prisma.OrderUpdateInput = {};
      if (has("cardMessage")) out.cardMessage = str("cardMessage");
      if (has("customerNote")) out.customerNote = str("customerNote");
      return { data: out };
    }
    case "courierNote": {
      const out: Prisma.OrderUpdateInput = {};
      // Курьер читает это в приложении доставки: длинный текст там обрезается, поэтому
      // предел жёсткий, на сервере, а не только в форме.
      if (has("courierNote")) {
        const v = str("courierNote").trim();
        if (v.length > COURIER_NOTE_MAX) return { error: `Инструкция курьеру длиннее ${COURIER_NOTE_MAX} символов` };
        out.courierNote = v;
      }
      return { data: out };
    }
  }
}

/** Нормализует значение поля к сравнимому виду для diff и для отдачи в форму (даты → строки). */
function fieldToString(key: string, value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    // deliveryDate форматируем как в форме (yyyy-MM-dd), остальные даты — ISO.
    // deliveryDate — UTC-полночь местного дня: читаем именно UTC-части, иначе зона
    // процесса сдвинет день на сутки (date-fns форматировал по зоне сервера).
    return key === "deliveryDate" ? localDateStr(value, "UTC") : value.toISOString();
  }
  return String(value);
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
  data: BlockFormData;
  actor: { userId: string; role: Role };
}): Promise<UpdateOrderBlockResult> {
  const built = buildUpdateData(input.block, input.data);
  if ("error" in built) return { status: "invalid", error: built.error };

  const select = BLOCK_SELECT[input.block];

  // Дни, чей финансовый итог изменился этой правкой. Заполняются внутри транзакции, а
  // пересчёт запускается ПОСЛЕ коммита: он читает заказ из базы и внутри транзакции увидел
  // бы ещё не зафиксированные данные.
  const affectedDays: Date[] = [];

  // Тип возврата указан явно: без него литеральные "ok"/"notfound" расширяются до string,
  // потому что результат больше не возвращается напрямую из функции.
  const result = await prisma.$transaction(async (tx): Promise<UpdateOrderBlockResult> => {
    const before = await tx.order.findUnique({ where: { id: input.orderId }, select });
    if (!before) return { status: "notfound" };

    // Заметку, пока её правили, система могла дополнить сверху (ИИ, доплата, перенос): присланная
    // `customerNoteBase` — какой заметка была в начале правки, и дописанное с тех пор остаётся.
    const data = { ...built.data };
    const base = input.data.customerNoteBase;
    if (input.block === "cardNote" && typeof data.customerNote === "string" && typeof base === "string") {
      data.customerNote = mergeNoteEdit(String((before as { customerNote?: string | null }).customerNote ?? ""), base, data.customerNote);
    }
    const after = await tx.order.update({ where: { id: input.orderId }, data, select });
    const afterRest = after as Record<string, unknown>;
    const changed = diffChanged(input.block, before as Record<string, unknown>, afterRest);

    // Что меняет состав финансового дня: статус (заказ входит в день по «Доставлен») и дата
    // доставки (заказ переезжает — пересчитать надо ОБА дня, откуда ушёл и куда пришёл).
    if (input.block === "status" && "orderStatus" in changed) {
      const day = await tx.order.findUnique({ where: { id: input.orderId }, select: { deliveryDate: true } });
      if (day) affectedDays.push(day.deliveryDate);
    }
    if (input.block === "delivery" && "deliveryDate" in changed) {
      const from = (before as { deliveryDate?: Date }).deliveryDate;
      const to = (afterRest as { deliveryDate?: Date }).deliveryDate;
      if (from) affectedDays.push(from);
      if (to) affectedDays.push(to);
    }

    await tx.orderAudit.create({
      data: {
        orderId: input.orderId,
        userId: input.actor.userId,
        role: input.actor.role,
        block: input.block,
        changed: changed as Prisma.InputJsonValue,
      },
    });

    return { status: "ok", changed };
  });

  if (result.status === "ok" && affectedDays.length > 0) {
    await recomputeDaysForOrder(prisma, input.orderId, affectedDays);
  }
  return result;
}
