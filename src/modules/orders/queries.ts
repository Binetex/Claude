import "server-only";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OrderStatus } from "@/generated/prisma/enums";
import { DEFAULT_STORE_TZ, utcDayRangeForLocalToday } from "@/lib/tz";
import { IN_WORK_ORDER_STATUSES } from "@/lib/statuses";
import {
  orderInclude,
  serializeForOwner,
  serializeForCallCenter,
  serializeForFlorist,
} from "./serialize";

export type OrderFilters = {
  preset?: "today" | "tomorrow" | "all" | "done";
  date?: string; // YYYY-MM-DD
  from?: string;
  to?: string;
  status?: OrderStatus;
  siteId?: string;
  floristId?: string;
  search?: string;
  sortBy?: "deliveryDate" | "createdAt" | "orderStatus";
  sortDir?: "asc" | "desc";
  /** Пагинация. Без perPage выборка не ограничивается (поведение прежних вызовов). */
  page?: number;
  perPage?: number;
};

const DONE_STATUSES: OrderStatus[] = [
  "READY",
  "AWAITING_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
];

/** Границы календарного дня «YYYY-MM-DD» в UTC — под формат хранения deliveryDate. */
const utcDayStart = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const utcDayEnd = (ymd: string) => new Date(`${ymd}T23:59:59.999Z`);

function buildWhere(f: OrderFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};

  // Дата доставки. deliveryDate хранится как UTC-полночь ЛОКАЛЬНОГО дня доставки, поэтому
  // границы считаем строго в UTC («T00:00:00Z»), а не через локальный день процесса: иначе
  // при сервере не в UTC выборка съезжала бы на сутки. Сейчас прод в UTC — поведение то же.
  if (f.date) {
    where.deliveryDate = { gte: utcDayStart(f.date), lte: utcDayEnd(f.date) };
  } else if (f.from || f.to) {
    where.deliveryDate = {
      ...(f.from ? { gte: utcDayStart(f.from) } : {}),
      ...(f.to ? { lte: utcDayEnd(f.to) } : {}),
    };
  } else if (f.preset === "today" || f.preset === "tomorrow") {
    // «Сегодня»/«Завтра» — по календарному дню в таймзоне магазина, как считают дашборд и
    // список закупки. Раньше здесь брался день ПРОЦЕССА (сервер в UTC), и каждый вечер после
    // 17:00 по Лос-Анджелесу вкладки показывали на сутки вперёд: UTC уже перешёл на новый
    // день, а у магазина он ещё не наступил.
    const { gte, lt } = utcDayRangeForLocalToday(DEFAULT_STORE_TZ);
    const shift = f.preset === "tomorrow" ? 24 * 60 * 60 * 1000 : 0;
    where.deliveryDate = { gte: new Date(gte.getTime() + shift), lt: new Date(lt.getTime() + shift) };
  }

  if (f.preset === "done") where.orderStatus = { in: DONE_STATUSES };
  // Фильтр «В работе» ищет всю группу: пользователь выбирает смысл, а не значение enum.
  else if (f.status && IN_WORK_ORDER_STATUSES.includes(f.status)) where.orderStatus = { in: IN_WORK_ORDER_STATUSES };
  else if (f.status) where.orderStatus = f.status;

  if (f.siteId) where.siteId = f.siteId;
  if (f.floristId) where.currentFloristId = f.floristId;

  if (f.search) {
    const q = f.search.trim();
    // В списке номер показан как «#20211», а в БД лежит «THEFLOW-20211»: скопированный из
    // интерфейса номер с решёткой не находился. Ищем и по введённому тексту, и по варианту
    // без ведущих «#»/«№» — второй нужен только для номера заказа.
    const bare = q.replace(/^[#№]+\s*/, "");
    where.OR = [
      { orderNumber: { contains: q, mode: "insensitive" } },
      ...(bare && bare !== q ? [{ orderNumber: { contains: bare, mode: "insensitive" as const } }] : []),
      { senderName: { contains: q, mode: "insensitive" } },
      { recipientName: { contains: q, mode: "insensitive" } },
      { recipientPhone: { contains: q, mode: "insensitive" } },
      { senderPhone: { contains: q, mode: "insensitive" } },
      { addressLine: { contains: q, mode: "insensitive" } },
    ];
  }

  return where;
}

/**
 * Дефолт (без явного sortBy) — по ДАТЕ ДОСТАВКИ, по убыванию: сверху заказы с ближайшей/
 * недавней датой доставки (которые вот-вот нужно доставлять), внизу — доставленные давно.
 * Тай-брейк — по дате размещения заказа (externalCreatedAt), новее выше.
 * Явный выбор сортировки в фильтрах имеет приоритет.
 */
function buildOrderBy(f: OrderFilters): Prisma.OrderOrderByWithRelationInput[] {
  const dir = f.sortDir ?? "asc";
  // id в конце — тай-брейк: без него заказы с одинаковой датой могут переставляться между
  // страницами (порядок неустойчив), и один и тот же заказ попадёт на две страницы либо ни на одну.
  const tail: Prisma.OrderOrderByWithRelationInput = { id: "desc" };
  if (f.sortBy === "orderStatus") return [{ orderStatus: dir }, { deliveryDate: "desc" }, tail];
  if (f.sortBy === "deliveryDate") return [{ deliveryDate: dir }, { externalCreatedAt: "desc" }, tail];
  if (f.sortBy === "createdAt") return [{ externalCreatedAt: dir }, tail]; // «Дата создания» = дата размещения заказа
  return [{ deliveryDate: "desc" }, { externalCreatedAt: "desc" }, tail]; // дефолт: ближайшие к доставке сверху
}

/** take/skip только когда задан perPage — иначе выборка полная, как раньше. */
function buildPage(f: OrderFilters): { take?: number; skip?: number } {
  if (!f.perPage || f.perPage < 1) return {};
  return { take: f.perPage, skip: (Math.max(1, f.page ?? 1) - 1) * f.perPage };
}

// ─────────── ВЛАДЕЛЕЦ ───────────
export async function listForOwner(f: OrderFilters = {}) {
  const orders = await prisma.order.findMany({
    where: buildWhere(f),
    include: orderInclude,
    orderBy: buildOrderBy(f),
    ...buildPage(f),
  });
  return orders.map(serializeForOwner);
}

/** Сколько заказов под фильтр всего — для пейджера и счётчика в заголовке. */
export async function countOrders(f: OrderFilters = {}) {
  return prisma.order.count({ where: buildWhere(f) });
}

export async function getForOwner(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
  return order ? serializeForOwner(order) : null;
}

// ─────────── КОЛЛ-ЦЕНТР ───────────
export async function listForCallCenter(f: OrderFilters = {}) {
  const orders = await prisma.order.findMany({
    where: buildWhere(f),
    include: orderInclude,
    orderBy: buildOrderBy(f),
    ...buildPage(f),
  });
  return orders.map(serializeForCallCenter);
}

export async function getForCallCenter(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
  return order ? serializeForCallCenter(order) : null;
}

// ─────────── ФЛОРИСТ ───────────
// Строго только заказы, где флорист является ТЕКУЩИМ исполнителем.
/** Условие «заказы, где этот флорист — ТЕКУЩИЙ исполнитель». Общее для списка и счётчика,
 *  чтобы пейджер не разошёлся с выборкой. */
function floristWhere(floristId: string, f: OrderFilters): Prisma.OrderWhereInput {
  const where = buildWhere({ ...f, floristId: undefined });
  where.currentFloristId = floristId;
  return where;
}

export async function listForFlorist(floristId: string, f: OrderFilters = {}) {
  const orders = await prisma.order.findMany({
    where: floristWhere(floristId, f),
    include: orderInclude,
    orderBy: buildOrderBy(f),
    ...buildPage(f),
  });
  return orders.map(serializeForFlorist);
}

/** Сколько заказов флориста под фильтр всего — для пейджера и счётчика в заголовке. */
export async function countForFlorist(floristId: string, f: OrderFilters = {}) {
  return prisma.order.count({ where: floristWhere(floristId, f) });
}

export async function getForFlorist(id: string, floristId: string) {
  const order = await prisma.order.findFirst({
    where: { id, currentFloristId: floristId },
    include: orderInclude,
  });
  return order ? serializeForFlorist(order) : null;
}
