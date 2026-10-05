import "server-only";
/**
 * Расписание флориста на день из базы — одно на график и на ассистента.
 *
 * Заказ дня → задание очереди: размер букета, крайний срок (конец окна), начало окна, дорога от
 * точки флориста до адреса. Уже готовые и уехавшие букеты в очередь сборки не входят. Линия
 * флориста сегодня свободна с max(начало работы + разгон, «сейчас»); на другой день — с начала
 * работы, а если ранний заказ иначе не успеть — раньше (заказ заранее можно и очень рано).
 *
 * Отсюда же — самое раннее время, к которому успеваем конкретный заказ или нового клиента
 * магазина: его ассистент называет клиенту, раньше него соглашаться нельзя.
 *
 * День — «YYYY-MM-DD» (UTC-полночь местного дня в Order.deliveryDate): через таймзону не гоняем.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getAvailableFloristIds } from "@/modules/assignments/service";
import { isFloristAvailable } from "@/modules/assignments/availability";
import { zipDistanceMiles } from "@/modules/reviews/zipGeo";
import { normalizeZip } from "@/modules/reviews/locationPick";
import { formatDeliveryWindow } from "@/lib/timeWindow";
import { windowOf, DAY_END_MIN, type WindowRange } from "@/lib/deliveryWindow";
import { localClock, DEFAULT_STORE_TZ } from "@/lib/tz";
import { loadTimeModel } from "./stats";
import { driveMin, prepMin, setupMin, DEFAULT_WORK_START_MIN, type TimeModel } from "./model";
import { planDay, earliestBy, type PlanJob, type PlanParams } from "./planner";
import {
  isBigOrder, readyTimeWishes, isPriorityShop, withClosure, sameDayFallback, asClosureLevel, morningOverload,
  NERVOUS_MIN_INBOUND, LATE_TOLERANCE_MIN, BIG_BOUQUET_PRICE, BOUQUET_MIN_PRICE, SAME_DAY_CUTOFF_MIN, CLOSURE_OPEN_FROM, type ClosureLevel,
} from "./day";

/** Неоплаченные попытки и отменённые — не заказы: места у флориста они не занимают. */
const NOT_ORDERS = ["CANCELLED", "AWAITING_PAYMENT"] as const;
/** Букет уже собран или уехал: в очередь сборки не входит. */
const DONE_STATUSES = new Set(["READY", "AWAITING_COURIER", "IN_TRANSIT", "DELIVERED"]);
/** Раньше этого часа линию не начинаем даже ради заказа заранее. */
const EARLIEST_LINE_START = 6 * 60;

function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function nowParts(now: Date): { day: string; min: number } {
  const c = localClock(DEFAULT_STORE_TZ, now);
  const [h, m] = c.timeStr.split(":").map(Number);
  return { day: c.dateStr, min: h * 60 + m };
}

const ORDER_SELECT = {
  id: true, orderNumber: true, orderStatus: true, deliveryWindow: true, windowFrom: true, windowTo: true,
  customerNote: true, zip: true, currentFloristId: true, sortIndex: true,
  site: { select: { shortName: true, timezone: true } },
  items: { select: { externalPrice: true, quantity: true } },
  pickupLocationOverride: { select: { zip: true } },
  deliveries: { orderBy: { createdAt: "desc" as const }, take: 1, select: { status: true, deliveredAt: true, isCurrentAttempt: true } },
} as const;

type DayOrder = Awaited<ReturnType<typeof loadOrders>>[number];

/** Сколько входящих от сторон заказа считаем: «написывает» клиент сейчас, а не неделю назад. */
const INBOUND_LOOKBACK_MS = 24 * 3_600_000;

/**
 * Входящие (SMS, звонки) по каждому заказу за сутки — одним запросом на весь день. По ним видно
 * клиента, который «написывает» (`day.ts::NERVOUS_MIN_INBOUND`).
 */
async function withInbound<T extends { id: string }>(prisma: PrismaClient, orders: T[], now: Date): Promise<(T & { inbound: number })[]> {
  if (!orders.length) return [];
  const rows = await prisma.orderCommunication.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orders.map((o) => o.id) }, direction: "INBOUND", occurredAt: { gte: new Date(now.getTime() - INBOUND_LOOKBACK_MS) } },
    _count: { _all: true },
  });
  const count = new Map(rows.map((r) => [r.orderId, r._count._all]));
  return orders.map((o) => ({ ...o, inbound: count.get(o.id) ?? 0 }));
}

async function loadOrders(prisma: PrismaClient, where: { deliveryDate: Date; currentFloristId?: string | null }, now: Date) {
  const orders = await prisma.order.findMany({
    where: { ...where, orderStatus: { notIn: [...NOT_ORDERS] } },
    select: ORDER_SELECT,
  });
  return withInbound(prisma, orders, now);
}

/** Основная точка забора флориста — «где он находится» для расчёта дороги. */
async function floristZips(prisma: PrismaClient): Promise<Map<string, string>> {
  const locs = await prisma.floristPickupLocation.findMany({
    where: { isActive: true },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { floristId: true, zip: true },
  });
  const out = new Map<string, string>();
  for (const l of locs) if (!out.has(l.floristId)) out.set(l.floristId, normalizeZip(l.zip));
  return out;
}

function itemsOf(o: { items: { externalPrice: unknown; quantity: number }[] }) {
  return o.items.map((i) => ({ price: Number(i.externalPrice), quantity: i.quantity }));
}

/** Расстояние от точки флориста (назначенной заказу или основной) до адреса. */
function milesFor(o: { zip: string; pickupLocationOverride: { zip: string } | null }, floristZip: string | null | undefined): number | null {
  const from = o.pickupLocationOverride ? normalizeZip(o.pickupLocationOverride.zip) : floristZip ?? null;
  const to = normalizeZip(o.zip);
  return from && to ? zipDistanceMiles(from, to) : null;
}

function isDone(o: DayOrder): boolean {
  if (DONE_STATUSES.has(o.orderStatus)) return true;
  const d = o.deliveries[0];
  return !!d && d.isCurrentAttempt && !["DRAFT_PENDING", "DRAFT_CREATED", "CANCELLED", "FAILED"].includes(d.status);
}

function toJob(o: DayOrder, model: TimeModel, floristZip: string | null | undefined): PlanJob {
  const w = windowOf(o);
  return {
    id: o.id,
    big: isBigOrder(itemsOf(o)),
    deadline: w?.to ?? DAY_END_MIN,
    windowFrom: w?.from ?? 0,
    driveMin: driveMin(model, milesFor(o, floristZip)),
    fixed: isDone(o),
    priority: isPriorityShop(o.site.shortName),
    nervous: o.inbound >= NERVOUS_MIN_INBOUND,
  };
}

/** Параметры линии флориста на день: когда свободна для первого букета и можно ли раньше. */
function lineParams(model: TimeModel, florist: { id: string; workStartMin: number | null }, day: string, now: Date): PlanParams {
  const start = (florist.workStartMin ?? DEFAULT_WORK_START_MIN) + setupMin(model, florist.id);
  const n = nowParts(now);
  const isToday = day === n.day;
  return {
    lineStart: isToday ? Math.max(start, n.min) : start,
    courierMin: model.courierMin,
    prepMin: (big) => prepMin(model, florist.id, big),
    earliestLineStart: day > n.day ? EARLIEST_LINE_START : null,
  };
}

/** Замок дня из «Графика доставки»: утро, только вечер или весь день; null — день открыт. */
async function closureOf(prisma: PrismaClient, day: string): Promise<ClosureLevel | null> {
  const row = await prisma.morningClosure.findUnique({ where: { day }, select: { level: true } });
  return row ? asClosureLevel(row.level) ?? "MORNING" : null;
}

/**
 * Плановое время доставки ЭТОГО заказа по графику флориста (минуты) — ровно то, что «График
 * доставки» показывает у заказа (`plannedAt`): место в очереди, сборка, курьер и дорога, не раньше
 * начала окна. Его называет ИИ по принятому заказу (владелец 05.10.2026, FLWBR-91183): прежнее
 * «самое раннее, если втиснуть» давало 12:00 там, где по графику выходило ~16:00, и получатель
 * услышал «около 12». Букет уже собран или уехал — «сейчас + курьер + дорога». Флориста нет — тот,
 * кому заказ достался бы по приоритету; нет и такого — undefined: судить не по чему.
 */
export async function orderPlanned(prisma: PrismaClient, orderId: string, now: Date = new Date()): Promise<number | undefined> {
  const found = await prisma.order.findUnique({ where: { id: orderId }, select: { ...ORDER_SELECT, siteId: true, deliveryDate: true } });
  if (!found) return undefined;
  const [order] = await withInbound(prisma, [found], now);
  const day = order.deliveryDate.toISOString().slice(0, 10);
  const floristId = order.currentFloristId ?? (await getAvailableFloristIds(order.siteId, order.deliveryDate))[0] ?? null;
  if (!floristId) return undefined;
  const [model, florist, zips, others] = await Promise.all([
    loadTimeModel(prisma, now),
    prisma.florist.findUnique({ where: { id: floristId }, select: { id: true, workStartMin: true } }),
    floristZips(prisma),
    loadOrders(prisma, { deliveryDate: order.deliveryDate, currentFloristId: floristId }, now),
  ]);
  if (!florist) return undefined;
  const own = toJob(order, model, zips.get(floristId));
  // Букет уже собран или уехал: очередь ему не мешает — «сейчас + курьер + дорога».
  if (own.fixed) return day === nowParts(now).day ? nowParts(now).min + model.courierMin + own.driveMin : undefined;
  // Та же очередь, что на «Графике доставки»: заказы флориста на день, и этот среди них.
  const jobs = [...others.filter((o) => o.id !== order.id), order].map((o) => toJob(o, model, zips.get(floristId)));
  return planDay(jobs, lineParams(model, florist, day, now)).items.find((i) => i.id === order.id)?.etaAt ?? undefined;
}

/**
 * Самое раннее время для НОВОГО клиента магазина в этот день: маленький букет, адрес неизвестен,
 * флорист — первый в приоритете магазина. undefined — судить не по чему (нет флориста).
 *
 * На сегодня до 13:00 заказ берём всегда (владелец 29.09.2026): места по графику нет — вечером.
 * Что после 13:00 сегодняшний заказ решает человек, говорит ассистент — здесь только время.
 */
export async function siteEarliest(prisma: PrismaClient, siteId: string, day: string, now: Date = new Date()): Promise<number | null | undefined> {
  const floristId = (await getAvailableFloristIds(siteId, dayDate(day)))[0] ?? null;
  if (!floristId) return undefined;
  const [model, florist, zips, orders, closure, site] = await Promise.all([
    loadTimeModel(prisma, now),
    prisma.florist.findUnique({ where: { id: floristId }, select: { id: true, workStartMin: true } }),
    floristZips(prisma),
    loadOrders(prisma, { deliveryDate: dayDate(day), currentFloristId: floristId }, now),
    closureOf(prisma, day),
    prisma.site.findUnique({ where: { id: siteId }, select: { shortName: true } }),
  ]);
  if (!florist) return undefined;
  const jobs = orders.map((o) => toJob(o, model, zips.get(floristId)));
  const fresh = { id: "__new__", big: false, windowFrom: 0, driveMin: model.unknownDriveMin, priority: isPriorityShop(site?.shortName) };
  const planned = earliestBy(jobs, fresh, lineParams(model, florist, day, now));
  const n = nowParts(now);
  return withClosure(day === n.day ? sameDayFallback(planned, n.min) : planned, closure, true);
}

/** Сегодня после 13:00: новый заказ на сегодня не обещаем и не отклоняем сами — решает человек. */
export function sameDayNeedsCheck(day: string, now: Date = new Date()): boolean {
  const n = nowParts(now);
  return day === n.day && n.min >= SAME_DAY_CUTOFF_MIN;
}

// ─────────────────────────  «ГРАФИК ДОСТАВКИ»  ─────────────────────────

export type ScheduleOrder = {
  id: string;
  orderNumber: string;
  site: string;
  window: string;
  /** Последнее пожелание времени от клиента из заметки («after 5pm»), если было — как есть. */
  wish: string | null;
  /** Входящих от заказчика и получателя за сутки; от NERVOUS_MIN_INBOUND — «клиент пишет», букет вперёд. */
  inbound: number;
  bouquets: string;
  big: boolean;
  status: string;
  /** Место в очереди сборки; у готовых и уехавших — null. */
  seq: number | null;
  /** Плановое время доставки по расписанию (минуты); у готовых — null. */
  plannedAt: number | null;
  /** По расписанию не успеваем к сроку больше чем на допуск. */
  atRisk: boolean;
  /** Фактическое время доставки по часам LA, «HH:MM». */
  deliveredAt: string | null;
  deliveredMin: number | null;
  /** Обещание — окно заказа. От него считается опоздание. */
  promised: WindowRange | null;
  /** На сколько позже обещанного доставили (0 — вовремя). */
  lateMin: number;
  late: boolean;
};

export type FloristDay = {
  id: string;
  name: string;
  workStartMin: number;
  /** Ранний заказ заранее: расписание начинается раньше обычного — с этой минуты; иначе null. */
  earlyStartMin: number | null;
  /** Выходной по графику флориста. */
  dayOff: boolean;
  /** Самое раннее, к чему успеем нового клиента (маленький букет); null — сегодня уже нет. */
  newClientEarliest: number | null;
  /** Очередь по расписанию: сначала по месту в очереди, готовые — по факту доставки. */
  orders: ScheduleOrder[];
};

export type DaySchedule = {
  day: string;
  closure: { note: string | null; level: ClosureLevel } | null;
  /**
   * Автозамок утра: замка владельца нет, а утренний заказ TheFlow по графику не успеваем на час и
   * больше — сайты закрывают утро сами (`siteDayClosures`). Самый опаздывающий заказ; иначе null.
   */
  autoClose: { id: string; orderNumber: string; lateMin: number } | null;
  /** Сегодня после 13:00: новый заказ на сегодня — только после проверки человеком. */
  sameDayCheck: boolean;
  florists: FloristDay[];
  unassigned: ScheduleOrder[];
};

function toScheduleOrder(o: DayOrder, planned: { seq: number | null; etaAt: number | null; risk: boolean } | null): ScheduleOrder {
  const items = itemsOf(o);
  const wish = readyTimeWishes(o.customerNote)[0] ?? null;
  const range = windowOf(o);
  const deliveredDate = o.deliveries[0]?.deliveredAt ?? null;
  const deliveredAt = deliveredDate ? localClock(o.site.timezone ?? DEFAULT_STORE_TZ, deliveredDate).timeStr : null;
  const [hh, mm] = (deliveredAt ?? "").split(":").map(Number);
  const deliveredMin = deliveredAt ? hh * 60 + mm : null;
  const lateMin = deliveredMin != null && range ? Math.max(0, deliveredMin - range.to) : 0;
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    site: o.site.shortName ?? "",
    window: formatDeliveryWindow(o.deliveryWindow) || "—",
    wish,
    inbound: o.inbound,
    bouquets: items.filter((i) => i.price >= BOUQUET_MIN_PRICE).map((i) => `$${Math.round(i.price)}${i.quantity > 1 ? `×${i.quantity}` : ""}`).join(" + ") || "—",
    big: items.some((i) => i.price >= BIG_BOUQUET_PRICE),
    status: o.orderStatus,
    seq: planned?.seq ?? null,
    plannedAt: planned?.etaAt ?? null,
    atRisk: planned?.risk ?? false,
    deliveredAt,
    deliveredMin,
    promised: range,
    lateMin,
    late: lateMin > LATE_TOLERANCE_MIN,
  };
}

/** Порядок в карточке: сначала очередь сборки, потом готовые/уехавшие — по факту доставки. */
function byQueue(a: ScheduleOrder & { sortIndex?: number | null }, b: ScheduleOrder & { sortIndex?: number | null }) {
  if (a.seq != null && b.seq != null) return a.seq - b.seq;
  if (a.seq != null) return 1;
  if (b.seq != null) return -1;
  if (a.deliveredAt && b.deliveredAt) return a.deliveredAt.localeCompare(b.deliveredAt);
  if (a.deliveredAt) return -1;
  if (b.deliveredAt) return 1;
  return (a.sortIndex ?? 999) - (b.sortIndex ?? 999);
}

export async function loadDaySchedule(prisma: PrismaClient, day: string, now: Date = new Date()): Promise<DaySchedule> {
  const [orders, closure, florists, model, zips] = await Promise.all([
    loadOrders(prisma, { deliveryDate: dayDate(day) }, now),
    prisma.morningClosure.findUnique({ where: { day }, select: { note: true, level: true } }),
    prisma.florist.findMany({
      where: { active: true, user: { active: true } },
      select: { id: true, workStartMin: true, weekendDays: true, daysOff: true, user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    loadTimeModel(prisma, now),
    floristZips(prisma),
  ]);

  const level = closure ? asClosureLevel(closure.level) ?? "MORNING" : null;
  const n = nowParts(now);
  const floristDays: FloristDay[] = florists
    .map((f) => {
      const mine = orders.filter((o) => o.currentFloristId === f.id);
      const params = lineParams(model, f, day, now);
      const jobs = mine.map((o) => toJob(o, model, zips.get(f.id)));
      const plan = planDay(jobs, params);
      const byId = new Map(plan.items.map((i) => [i.id, i]));
      // Чип показывает время для клиента главного магазина — ровно то, что ИИ назовёт в TheFlow.
      const first = earliestBy(jobs, { id: "__new__", big: false, windowFrom: 0, driveMin: model.unknownDriveMin, priority: true }, params);
      return {
        id: f.id,
        name: f.user.name ?? "Флорист",
        workStartMin: f.workStartMin ?? DEFAULT_WORK_START_MIN,
        earlyStartMin: plan.lineStart < params.lineStart ? plan.lineStart : null,
        dayOff: !isFloristAvailable(f, dayDate(day)),
        newClientEarliest: withClosure(day === n.day ? sameDayFallback(first, n.min) : first, level, true),
        orders: mine
          .map((o) => {
            const it = byId.get(o.id);
            return { ...toScheduleOrder(o, it ? { seq: it.seq, etaAt: it.etaAt, risk: it.risk } : null), sortIndex: o.sortIndex };
          })
          .sort(byQueue),
      };
    })
    // Флорист без заказов в свой выходной — шум; с заказами показываем всегда.
    .filter((f) => !f.dayOff || f.orders.length > 0);

  return {
    day,
    closure: closure && level ? { note: closure.note, level } : null,
    autoClose: level ? null : morningOverload(floristDays.flatMap((f) => f.orders)),
    sameDayCheck: sameDayNeedsCheck(day, now),
    florists: floristDays,
    unassigned: orders.filter((o) => !o.currentFloristId).map((o) => toScheduleOrder(o, null)),
  };
}

/** Автозамок считается на те же три дня, что показывает «График доставки». */
const AUTO_CLOSE_DAYS = 3;

function addDays(day: string, n: number): string {
  const d = dayDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Замки дней для сайтов с плагином доставки (`/api/public/morning-closures`): день → с какой
 * минуты открыт (null — закрыт целиком). Замки владельца — как есть. К ним на ближайшие три дня
 * добавляется утро, которое по графику уже не успеваем (владелец 01.10.2026: «чтобы бот сам
 * закрывал утренний слот — когда уже прям точно не успеваем на 1–2 часа»).
 *
 * Автозамок нигде не хранится, а считается в момент запроса сайта: разгрузится график (перенесли,
 * отменили, собрали) — утро откроется само. ИИ его отдельно не читает: новому клиенту он и так
 * называет время по тому же графику, а перегруженное утро там уже занято.
 */
export async function siteDayClosures(prisma: PrismaClient, now: Date = new Date()): Promise<Record<string, number | null>> {
  const today = nowParts(now).day;
  const rows = await prisma.morningClosure.findMany({ where: { day: { gte: today } }, select: { day: true, level: true } });
  const openFrom: Record<string, number | null> = {};
  for (const r of rows) openFrom[r.day] = CLOSURE_OPEN_FROM[asClosureLevel(r.level) ?? "MORNING"];
  // Дни параллельно: сайт ждёт ответ 3 секунды, а не дождался — не закрывает ничего.
  const days = Array.from({ length: AUTO_CLOSE_DAYS }, (_, i) => addDays(today, i)).filter((day) => !(day in openFrom));
  const overloaded = await Promise.all(
    days.map((day) =>
      loadDaySchedule(prisma, day, now).then(
        (s) => !!s.autoClose,
        (err) => {
          // Сбой расчёта не должен ронять ответ: сайт при ошибке не закрывает НИЧЕГО, и вместе с
          // автозамком пропали бы замки владельца.
          console.error(`[timing] автозамок утра ${day} не посчитан:`, err instanceof Error ? err.message : String(err));
          return false;
        }
      )
    )
  );
  days.forEach((day, i) => {
    if (overloaded[i]) openFrom[day] = CLOSURE_OPEN_FROM.MORNING;
  });
  return openFrom;
}

/** Модель времени для блока «Как считаем время» на графике. */
export { loadTimeModel } from "./stats";
