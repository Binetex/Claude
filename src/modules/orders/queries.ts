import "server-only";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OrderStatus } from "@/generated/prisma/enums";
import { startOfDay, endOfDay, addDays } from "date-fns";
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
};

const DONE_STATUSES: OrderStatus[] = [
  "READY",
  "AWAITING_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
];

function buildWhere(f: OrderFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};

  // Дата доставки
  if (f.date) {
    const d = new Date(f.date + "T00:00:00");
    where.deliveryDate = { gte: startOfDay(d), lte: endOfDay(d) };
  } else if (f.from || f.to) {
    where.deliveryDate = {
      ...(f.from ? { gte: startOfDay(new Date(f.from + "T00:00:00")) } : {}),
      ...(f.to ? { lte: endOfDay(new Date(f.to + "T00:00:00")) } : {}),
    };
  } else if (f.preset === "today") {
    const now = new Date();
    where.deliveryDate = { gte: startOfDay(now), lte: endOfDay(now) };
  } else if (f.preset === "tomorrow") {
    const t = addDays(new Date(), 1);
    where.deliveryDate = { gte: startOfDay(t), lte: endOfDay(t) };
  }

  if (f.preset === "done") where.orderStatus = { in: DONE_STATUSES };
  else if (f.status) where.orderStatus = f.status;

  if (f.siteId) where.siteId = f.siteId;
  if (f.floristId) where.currentFloristId = f.floristId;

  if (f.search) {
    const q = f.search.trim();
    where.OR = [
      { orderNumber: { contains: q, mode: "insensitive" } },
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
  if (f.sortBy === "orderStatus") return [{ orderStatus: dir }, { deliveryDate: "desc" }];
  if (f.sortBy === "deliveryDate") return [{ deliveryDate: dir }, { externalCreatedAt: "desc" }];
  if (f.sortBy === "createdAt") return [{ externalCreatedAt: dir }]; // «Дата создания» = дата размещения заказа
  return [{ deliveryDate: "desc" }, { externalCreatedAt: "desc" }]; // дефолт: ближайшие к доставке сверху
}

// ─────────── ВЛАДЕЛЕЦ ───────────
export async function listForOwner(f: OrderFilters = {}) {
  const orders = await prisma.order.findMany({
    where: buildWhere(f),
    include: orderInclude,
    orderBy: buildOrderBy(f),
  });
  return orders.map(serializeForOwner);
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
  });
  return orders.map(serializeForCallCenter);
}

export async function getForCallCenter(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
  return order ? serializeForCallCenter(order) : null;
}

// ─────────── ФЛОРИСТ ───────────
// Строго только заказы, где флорист является ТЕКУЩИМ исполнителем.
export async function listForFlorist(floristId: string, f: OrderFilters = {}) {
  const where = buildWhere({ ...f, floristId: undefined });
  where.currentFloristId = floristId;
  const orders = await prisma.order.findMany({
    where,
    include: orderInclude,
    orderBy: buildOrderBy(f),
  });
  return orders.map(serializeForFlorist);
}

export async function getForFlorist(id: string, floristId: string) {
  const order = await prisma.order.findFirst({
    where: { id, currentFloristId: floristId },
    include: orderInclude,
  });
  return order ? serializeForFlorist(order) : null;
}
