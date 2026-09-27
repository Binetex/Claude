import "server-only";
/**
 * Загрузка утра из базы: по флористам на один день доставки.
 *
 * Читают двое: страница «График доставки» у владельца и ассистент, решающий, обещать ли клиенту
 * утро. Считают они ОДНИМ кодом — иначе админка показывала бы «место есть», а ассистент отвечал
 * бы «утро занято».
 *
 * Дата — бизнес-день «YYYY-MM-DD», как лежит в Order.deliveryDate (UTC-полночь местного дня):
 * через таймзону её не прогоняем, день съехал бы на сутки.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getAvailableFloristIds } from "@/modules/assignments/service";
import { isFloristAvailable } from "@/modules/assignments/availability";
import { formatDeliveryWindow } from "@/lib/timeWindow";
import { localClock, DEFAULT_STORE_TZ } from "@/lib/tz";
import {
  orderPoints, isBigOrder, isMorningOrder, readyTimeWishes, wishIsMorning, parseTimes, morningVerdict, adjustForNow,
  DEFAULT_MORNING_CAPACITY, type MorningVerdict,
} from "./morning";

/** Неоплаченные попытки и отменённые — не заказы: места у флориста они не занимают. */
const NOT_ORDERS = ["CANCELLED", "AWAITING_PAYMENT"] as const;

export type ScheduleOrder = {
  id: string;
  orderNumber: string;
  site: string;
  window: string;
  /** Последнее пожелание времени от клиента (из заметки), если было. */
  wish: string | null;
  bouquets: string;
  points: number;
  big: boolean;
  morning: boolean;
  status: string;
  /** Фактическое время доставки по часам LA, «HH:MM». */
  deliveredAt: string | null;
  /** Доставлен позже окна или обещанного клиенту времени. */
  late: boolean;
};

export type FloristDay = {
  id: string;
  name: string;
  capacity: number;
  /** Выходной по графику флориста. */
  dayOff: boolean;
  morningPoints: number;
  /** Что ассистент сейчас скажет новому клиенту с маленьким букетом на этого флориста. */
  verdict: MorningVerdict;
  morning: ScheduleOrder[];
  later: ScheduleOrder[];
};

export type DaySchedule = {
  day: string;
  closure: { note: string | null } | null;
  florists: FloristDay[];
  unassigned: ScheduleOrder[];
};

function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** Поправка вердикта на «который сейчас час», если день — сегодня по часам LA. */
function forNow(verdict: MorningVerdict, day: string, now: Date): MorningVerdict {
  const clock = localClock(DEFAULT_STORE_TZ, now);
  const [h, m] = clock.timeStr.split(":").map(Number);
  return adjustForNow(verdict, clock.dateStr === day, h * 60 + m);
}

type RawOrder = Awaited<ReturnType<typeof loadDayOrders>>[number];

function loadDayOrders(prisma: PrismaClient, day: string) {
  return prisma.order.findMany({
    where: { deliveryDate: dayDate(day), orderStatus: { notIn: [...NOT_ORDERS] } },
    select: {
      id: true, orderNumber: true, deliveryWindow: true, customerNote: true, orderStatus: true,
      currentFloristId: true, sortIndex: true,
      site: { select: { shortName: true, timezone: true } },
      items: { select: { externalPrice: true, quantity: true } },
      deliveries: { where: { deliveredAt: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, select: { deliveredAt: true } },
    },
  });
}

function itemsOf(o: RawOrder) {
  return o.items.map((i) => ({ price: Number(i.externalPrice), quantity: i.quantity }));
}

function toScheduleOrder(o: RawOrder): ScheduleOrder {
  const items = itemsOf(o);
  const wish = readyTimeWishes(o.customerNote)[0] ?? null;
  const morning = isMorningOrder({ window: o.deliveryWindow, customerNote: o.customerNote });
  const deliveredDate = o.deliveries[0]?.deliveredAt ?? null;
  const deliveredAt = deliveredDate ? localClock(o.site.timezone ?? DEFAULT_STORE_TZ, deliveredDate).timeStr : null;

  // Опоздание: позже обещанного клиенту утреннего времени, а если его нет — позже конца окна.
  const deadlineSource = wish && wishIsMorning(wish) ? wish : o.deliveryWindow;
  const deadlineTimes = parseTimes(deadlineSource);
  const deadline = deadlineTimes.length ? deadlineTimes[deadlineTimes.length - 1] : null;
  const [hh, mm] = (deliveredAt ?? "").split(":").map(Number);
  const late = deliveredAt != null && deadline != null && hh * 60 + mm > deadline;

  return {
    id: o.id,
    orderNumber: o.orderNumber,
    site: o.site.shortName ?? "",
    window: formatDeliveryWindow(o.deliveryWindow) || "—",
    wish,
    bouquets: items.filter((i) => i.price >= 100).map((i) => `$${Math.round(i.price)}${i.quantity > 1 ? `×${i.quantity}` : ""}`).join(" + ") || "—",
    points: orderPoints(items),
    big: isBigOrder(items),
    morning,
    status: o.orderStatus,
    deliveredAt,
    late,
  };
}

/** Порядок внутри колонки: как везли (по факту доставки), остальное — по ручному порядку дня. */
function byDelivery(a: ScheduleOrder & { sortIndex?: number | null }, b: ScheduleOrder & { sortIndex?: number | null }) {
  if (a.deliveredAt && b.deliveredAt) return a.deliveredAt.localeCompare(b.deliveredAt);
  if (a.deliveredAt) return -1;
  if (b.deliveredAt) return 1;
  return (a.sortIndex ?? 999) - (b.sortIndex ?? 999);
}

export async function loadDaySchedule(prisma: PrismaClient, day: string, now: Date = new Date()): Promise<DaySchedule> {
  const [orders, closure, florists] = await Promise.all([
    loadDayOrders(prisma, day),
    prisma.morningClosure.findUnique({ where: { day }, select: { note: true } }),
    prisma.florist.findMany({
      where: { active: true, user: { active: true } },
      select: { id: true, morningCapacity: true, weekendDays: true, daysOff: true, user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const rows = orders.map((o) => ({ ...toScheduleOrder(o), floristId: o.currentFloristId, sortIndex: o.sortIndex }));
  const floristDays: FloristDay[] = florists
    .map((f) => {
      const mine = rows.filter((r) => r.floristId === f.id);
      const morningPoints = mine.filter((r) => r.morning).reduce((s, r) => s + r.points, 0);
      return {
        id: f.id,
        name: f.user.name ?? "Флорист",
        capacity: f.morningCapacity ?? DEFAULT_MORNING_CAPACITY,
        dayOff: !isFloristAvailable(f, dayDate(day)),
        morningPoints,
        verdict: forNow(morningVerdict({ taken: morningPoints, own: 1, capacity: f.morningCapacity, closed: !!closure }), day, now),
        morning: mine.filter((r) => r.morning).sort(byDelivery),
        later: mine.filter((r) => !r.morning).sort(byDelivery),
      };
    })
    // Флорист без заказов в свой выходной — шум; с заказами показываем всегда.
    .filter((f) => !f.dayOff || f.morning.length + f.later.length > 0);

  return {
    day,
    closure: closure ? { note: closure.note } : null,
    florists: floristDays,
    unassigned: rows.filter((r) => !r.floristId).sort(byDelivery),
  };
}

/** Сводка по нескольким дням для полосы дат: баллы утра по флористам и закрытие. */
export async function loadWeekStrip(prisma: PrismaClient, days: string[]) {
  const [orders, closures, florists] = await Promise.all([
    prisma.order.findMany({
      where: { deliveryDate: { in: days.map(dayDate) }, orderStatus: { notIn: [...NOT_ORDERS] } },
      select: { deliveryDate: true, deliveryWindow: true, customerNote: true, currentFloristId: true, items: { select: { externalPrice: true, quantity: true } } },
    }),
    prisma.morningClosure.findMany({ where: { day: { in: days } }, select: { day: true } }),
    prisma.florist.findMany({ where: { active: true, user: { active: true } }, select: { id: true, morningCapacity: true } }),
  ]);
  const closed = new Set(closures.map((c) => c.day));
  const cap = new Map(florists.map((f) => [f.id, f.morningCapacity]));
  return days.map((day) => {
    const byFlorist = new Map<string, number>();
    let total = 0;
    for (const o of orders) {
      if (o.deliveryDate.toISOString().slice(0, 10) !== day) continue;
      total++;
      if (!o.currentFloristId || !isMorningOrder({ window: o.deliveryWindow, customerNote: o.customerNote })) continue;
      const pts = orderPoints(o.items.map((i) => ({ price: Number(i.externalPrice), quantity: i.quantity })));
      byFlorist.set(o.currentFloristId, (byFlorist.get(o.currentFloristId) ?? 0) + pts);
    }
    // День «забит», если утро закрыто или все, у кого есть утренние заказы, упёрлись в лимит.
    const loads = [...byFlorist.entries()].map(([id, pts]) => ({ pts, cap: cap.get(id) ?? DEFAULT_MORNING_CAPACITY }));
    const fullest = loads.reduce((m, l) => Math.max(m, l.pts / Math.max(1, l.cap)), 0);
    return { day, total, closed: closed.has(day), fullest };
  });
}

/**
 * Утро для КОНКРЕТНОГО заказа: у его флориста, без него самого. Флориста нет — берём того, кому
 * заказ достался бы по приоритету магазина.
 */
export async function morningForOrder(prisma: PrismaClient, orderId: string, now: Date = new Date()): Promise<MorningVerdict | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      siteId: true, deliveryDate: true, currentFloristId: true, deliveryWindow: true, customerNote: true,
      items: { select: { externalPrice: true, quantity: true } },
    },
  });
  if (!order) return null;
  const day = order.deliveryDate.toISOString().slice(0, 10);
  const floristId = order.currentFloristId ?? (await getAvailableFloristIds(order.siteId, order.deliveryDate))[0] ?? null;
  const own = orderPoints(order.items.map((i) => ({ price: Number(i.externalPrice), quantity: i.quantity })));
  const v = await verdictFor(prisma, day, floristId, own, orderId);
  if (!v) return null;
  // Заказ УЖЕ утренний (клиент купил окно до 15:00): «утро занято, раньше трёх не выйдет» было
  // бы неправдой про его же окно. Перегрузка значит только «к полудню не обещаем».
  const committed = isMorningOrder({ window: order.deliveryWindow, customerNote: order.customerNote });
  const adjusted = forNow(committed && v === "FULL" ? "AVAILABLE" : v, day, now);
  // Утренний заказ сегодня после 14:00 и ещё не у клиента: что-либо обещать про время уже
  // нечестно — ни «13–15», ни «раньше трёх не выйдет». Пусть отвечает человек (прежнее правило).
  if (committed && adjusted === "FULL") return null;
  return adjusted;
}

/** Утро для НОВОГО клиента магазина на день: флорист по приоритету, букет считаем маленьким. */
export async function morningForNewOrder(prisma: PrismaClient, siteId: string, day: string, now: Date = new Date()): Promise<MorningVerdict | null> {
  const floristId = (await getAvailableFloristIds(siteId, dayDate(day)))[0] ?? null;
  const v = await verdictFor(prisma, day, floristId, 1, null);
  return v && forNow(v, day, now);
}

async function verdictFor(prisma: PrismaClient, day: string, floristId: string | null, own: number, exceptOrderId: string | null): Promise<MorningVerdict | null> {
  const closure = await prisma.morningClosure.findUnique({ where: { day }, select: { day: true } });
  if (closure) return "FULL";
  // Флориста нет ни на заказе, ни в приоритете — судить не по чему: пусть решает человек.
  if (!floristId) return null;
  const [florist, orders] = await Promise.all([
    prisma.florist.findUnique({ where: { id: floristId }, select: { morningCapacity: true } }),
    prisma.order.findMany({
      where: {
        deliveryDate: dayDate(day),
        currentFloristId: floristId,
        orderStatus: { notIn: [...NOT_ORDERS] },
        ...(exceptOrderId ? { id: { not: exceptOrderId } } : {}),
      },
      select: { deliveryWindow: true, customerNote: true, items: { select: { externalPrice: true, quantity: true } } },
    }),
  ]);
  const taken = orders
    .filter((o) => isMorningOrder({ window: o.deliveryWindow, customerNote: o.customerNote }))
    .reduce((s, o) => s + orderPoints(o.items.map((i) => ({ price: Number(i.externalPrice), quantity: i.quantity }))), 0);
  return morningVerdict({ taken, own, capacity: florist?.morningCapacity ?? DEFAULT_MORNING_CAPACITY, closed: false });
}
