import "server-only";
/**
 * Выборки для модели времени — из фактических доставок Burq за 60 дней.
 *
 * По каждой доставке: вызов курьера (SCHEDULED) → «забрал» (первое PICKED_UP или IN_TRANSIT) →
 * доставлено (deliveredAt). Расстояние — от точки забора этой доставки до индекса заказа. Сборка —
 * интервалы между вызовами курьеров у одного флориста в один день. «Разгон» — первый вызов в дни,
 * когда у флориста было 2+ утренних заказа.
 *
 * Пересчёт на лету с кэшем на 6 часов в памяти процесса (research R3): без таблицы и без задачи в
 * воркере. Любой сбой — стартовые значения: оценка времени не имеет права ронять ответ клиенту.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { zipDistanceMiles } from "@/modules/reviews/zipGeo";
import { normalizeZip } from "@/modules/reviews/locationPick";
import { localClock, DEFAULT_STORE_TZ } from "@/lib/tz";
import { windowOf } from "@/lib/deliveryWindow";
import { MORNING_END_HOUR, BIG_BOUQUET_PRICE } from "./day";
import { computeModel, DEFAULT_MODEL, type TimeModel, type DeliverySample, type PrepSample, type FirstDispatchSample } from "./model";

const WINDOW_DAYS = 60;
const CACHE_MS = 6 * 3_600_000;

let cached: { model: TimeModel; at: number } | null = null;

/** Модель времени: из кэша, если ему меньше 6 часов, иначе пересчёт. */
export async function loadTimeModel(prisma: PrismaClient, now: Date = new Date()): Promise<TimeModel> {
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.model;
  try {
    const model = await buildModel(prisma, now);
    cached = { model, at: now.getTime() };
    return model;
  } catch (err) {
    console.error("[timing] модель времени не посчиталась, беру стартовые значения:", err instanceof Error ? err.message : String(err));
    return DEFAULT_MODEL;
  }
}

/** Для тестов и скриптов: забыть кэш. */
export function resetTimeModelCache(): void {
  cached = null;
}

function minutesLA(d: Date): number {
  const [h, m] = localClock(DEFAULT_STORE_TZ, d).timeStr.split(":").map(Number);
  return h * 60 + m;
}

async function buildModel(prisma: PrismaClient, now: Date): Promise<TimeModel> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const deliveries = await prisma.delivery.findMany({
    where: { status: "DELIVERED", deliveredAt: { gte: since, not: null } },
    select: {
      id: true, floristId: true, pickupLocationId: true, deliveredAt: true,
      order: {
        select: {
          zip: true, deliveryDate: true, windowFrom: true, windowTo: true, deliveryWindow: true,
          items: { select: { externalPrice: true } },
        },
      },
    },
  });
  const ids = deliveries.map((d) => d.id);
  const events = ids.length
    ? await prisma.deliveryStatusEvent.groupBy({
        by: ["deliveryId", "normalizedStatus"],
        where: { deliveryId: { in: ids }, normalizedStatus: { in: ["SCHEDULED", "PICKED_UP", "IN_TRANSIT"] } },
        _min: { occurredAt: true, receivedAt: true },
      })
    : [];
  const firstAt = new Map<string, number>();
  for (const e of events) {
    const t = (e._min.occurredAt ?? e._min.receivedAt)?.getTime();
    if (t != null) firstAt.set(`${e.deliveryId}|${e.normalizedStatus}`, t);
  }
  const locs = new Map((await prisma.floristPickupLocation.findMany({ select: { id: true, zip: true } })).map((l) => [l.id, l.zip]));
  const florists = await prisma.florist.findMany({ select: { id: true, workStartMin: true } });

  const samples: DeliverySample[] = [];
  const dispatches = new Map<string, { t: number; big: boolean; morning: boolean }[]>();
  for (const d of deliveries) {
    const sched = firstAt.get(`${d.id}|SCHEDULED`) ?? null;
    const pickedCandidates = [firstAt.get(`${d.id}|PICKED_UP`), firstAt.get(`${d.id}|IN_TRANSIT`)].filter((v): v is number => v != null);
    const picked = pickedCandidates.length ? Math.min(...pickedCandidates) : null;
    const delivered = d.deliveredAt!.getTime();
    const from = normalizeZip(d.pickupLocationId ? locs.get(d.pickupLocationId) : null);
    const to = normalizeZip(d.order.zip);
    samples.push({
      miles: from && to ? zipDistanceMiles(from, to) : null,
      waitMin: sched != null && picked != null && picked > sched ? (picked - sched) / 60_000 : null,
      driveMin: picked != null && delivered > picked ? (delivered - picked) / 60_000 : null,
    });
    if (d.floristId && sched != null) {
      const key = `${d.floristId}|${d.order.deliveryDate.toISOString().slice(0, 10)}`;
      const w = windowOf(d.order);
      const list = dispatches.get(key) ?? dispatches.set(key, []).get(key)!;
      list.push({
        t: sched,
        big: d.order.items.some((i) => Number(i.externalPrice) >= BIG_BOUQUET_PRICE),
        morning: !!w && w.to <= MORNING_END_HOUR * 60,
      });
    }
  }

  const prep: PrepSample[] = [];
  const firstDispatch: FirstDispatchSample[] = [];
  for (const [key, list] of dispatches) {
    const floristId = key.split("|")[0];
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) prep.push({ floristId, big: list[i].big, min: (list[i].t - list[i - 1].t) / 60_000 });
    if (list.filter((x) => x.morning).length >= 2) firstDispatch.push({ floristId, min: minutesLA(new Date(list[0].t)) });
  }

  return computeModel({
    deliveries: samples,
    prep,
    firstDispatch,
    workStart: Object.fromEntries(florists.map((f) => [f.id, f.workStartMin])),
    since: since.toISOString().slice(0, 10),
    computedAt: now.toISOString(),
  });
}
