import "server-only";
/**
 * Загрузка заказов для печати открыток, с контролем доступа.
 *  - FLORIST → только назначенные ему (currentFloristId);
 *  - OWNER → все; прочие роли (в т.ч. CALL_CENTER) → нет доступа к массовой печати.
 * Источник текста — Order.cardMessage (не customerNote). Явный выбор по ids: все статусы,
 * пустой текст тоже (плейсхолдер на рендере). «Все на сегодня»: deliveryDate=сегодня по
 * Site.timezone; исключаются CANCELLED, DELIVERED, полностью REFUNDED и заказы без текста.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { deliveryDayBucket } from "@/lib/tz";
import { isBlankCardMessage } from "@/lib/print/cardText";
import { formatOrderNumber } from "@/lib/format";

export type PrintOrder = {
  orderId: string;
  siteId: string;
  orderNumber: string;
  recipientName: string;
  recipientPhone: string;
  addressLine: string;
  apartment: string | null;
  city: string;
  state: string | null; // отдельно не хранится в Order → null (см. отчёт)
  zip: string;
  deliveryDate: string; // "July 18, 2026"
  deliveryWindow: string;
  cardMessage: string; // сырой текст (может быть пустым)
  hasCardMessage: boolean;
  siteName: string;
};

const SELECT = {
  id: true,
  siteId: true,
  orderNumber: true,
  recipientName: true,
  recipientPhone: true,
  addressLine: true,
  apartment: true,
  city: true,
  zip: true,
  deliveryDate: true,
  deliveryWindow: true,
  cardMessage: true,
  site: { select: { name: true, timezone: true } },
} satisfies Prisma.OrderSelect;

type Row = Prisma.OrderGetPayload<{ select: typeof SELECT }>;

const fmtDeliveryDate = (d: Date): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(d);

function toPrintOrder(o: Row): PrintOrder {
  return {
    orderId: o.id,
    siteId: o.siteId,
    orderNumber: formatOrderNumber(o.orderNumber),
    recipientName: o.recipientName,
    recipientPhone: o.recipientPhone,
    addressLine: o.addressLine,
    apartment: o.apartment,
    city: o.city,
    state: null,
    zip: o.zip,
    deliveryDate: fmtDeliveryDate(o.deliveryDate),
    deliveryWindow: o.deliveryWindow,
    cardMessage: o.cardMessage,
    hasCardMessage: !isBlankCardMessage(o.cardMessage),
    siteName: o.site.name,
  };
}

export type PrintAccessUser = { role: Role; floristId?: string | null };

/** Заказы для печати с учётом прав. Пустой массив — если доступа нет / выбор пуст. */
export async function loadPrintableCards(
  user: PrintAccessUser,
  opts: { ids?: string[]; todayAll?: boolean; siteId?: string; includeBlank?: boolean }
): Promise<PrintOrder[]> {
  const where: Prisma.OrderWhereInput = {};
  if (user.role === "FLORIST") {
    if (!user.floristId) return [];
    where.currentFloristId = user.floristId; // только свои
  } else if (user.role !== "OWNER") {
    return []; // CALL_CENTER и прочие — нет массовой печати
  }
  if (opts.siteId) where.siteId = opts.siteId;

  if (opts.ids && opts.ids.length) {
    const ids = [...new Set(opts.ids.filter(Boolean))].slice(0, 50); // дедуп + лимит 50
    if (!ids.length) return [];
    where.id = { in: ids };
    const rows = await prisma.order.findMany({ where, select: SELECT, orderBy: { deliveryDate: "asc" } });
    return rows.map(toPrintOrder); // явный выбор: все статусы, пустой текст — на рендере плейсхолдер
  }

  if (opts.todayAll) {
    // Берём широкое UTC-окно (±2 дня), затем фильтруем «сегодня» ПО Site.timezone каждого магазина.
    const now = Date.now();
    where.deliveryDate = { gte: new Date(now - 2 * 86400000), lt: new Date(now + 2 * 86400000) };
    where.orderStatus = { notIn: ["CANCELLED", "DELIVERED"] };
    where.paymentStatus = { not: "REFUNDED" }; // полностью возвращённые исключаем (PARTIALLY_REFUNDED остаётся)
    const rows = await prisma.order.findMany({ where, select: SELECT, orderBy: { deliveryDate: "asc" } });
    return rows
      .filter(
        (o) =>
          deliveryDayBucket(o.deliveryDate, o.site.timezone) === "today" &&
          (opts.includeBlank || !isBlankCardMessage(o.cardMessage)) // список вкладки показывает и пустые
      )
      .map(toPrintOrder);
  }

  return [];
}
