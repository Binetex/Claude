/**
 * Сверка расписания с жизнью: как расписание (modules/timing) спланировало бы прошедшие дни с утра
 * и когда букеты приехали на самом деле. Только чтение — ничего не пишет.
 *
 * Грубая мерка: расписание знает все заказы дня с утра, а в жизни часть приходит днём. Главное, что
 * она показывает, — не обещает ли расписание слишком рано (факт намного позже плана) и видит ли оно
 * заранее дни, когда мы опоздали.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/timing-backtest.ts [--days 14]
 */
import { prisma } from "../src/lib/db";
import { loadTimeModel } from "../src/modules/timing/stats";
import { driveMin, prepMin, setupMin, percentile, DEFAULT_WORK_START_MIN } from "../src/modules/timing/model";
import { planDay, type PlanJob } from "../src/modules/timing/planner";
import { isBigOrder, LATE_TOLERANCE_MIN } from "../src/modules/timing/day";
import { windowOf, DAY_END_MIN } from "../src/lib/deliveryWindow";
import { zipDistanceMiles } from "../src/modules/reviews/zipGeo";
import { normalizeZip } from "../src/modules/reviews/locationPick";
import { localClock, todayStrInTz, DEFAULT_STORE_TZ } from "../src/lib/tz";

function minutesLA(d: Date): number {
  const [h, m] = localClock(DEFAULT_STORE_TZ, d).timeStr.split(":").map(Number);
  return h * 60 + m;
}

async function main() {
  const at = process.argv.indexOf("--days");
  const days = at > 0 ? Number(process.argv[at + 1]) : 14;
  const model = await loadTimeModel(prisma);
  const florists = await prisma.florist.findMany({ select: { id: true, workStartMin: true, user: { select: { name: true } } } });
  const locs = await prisma.floristPickupLocation.findMany({
    where: { isActive: true },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { floristId: true, zip: true },
  });
  const zipOf = new Map<string, string>();
  for (const l of locs) if (!zipOf.has(l.floristId)) zipOf.set(l.floristId, normalizeZip(l.zip));

  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const diffs: number[] = [];
  const readyDiffs: number[] = [];
  const travelDiffs: number[] = [];
  let total = 0, late = 0, risk = 0, warned = 0, optimistic = 0;
  for (let k = days; k >= 1; k--) {
    const day = new Date(Date.parse(`${today}T00:00:00Z`) - k * 86_400_000).toISOString().slice(0, 10);
    const orders = await prisma.order.findMany({
      where: { deliveryDate: new Date(`${day}T00:00:00Z`), orderStatus: "DELIVERED", currentFloristId: { not: null } },
      select: {
        id: true, zip: true, windowFrom: true, windowTo: true, deliveryWindow: true, currentFloristId: true,
        items: { select: { externalPrice: true } },
        pickupLocationOverride: { select: { zip: true } },
        deliveries: { where: { deliveredAt: { not: null } }, orderBy: { deliveredAt: "desc" }, take: 1, select: { id: true, deliveredAt: true } },
      },
    });
    // Когда букет был готов на деле — первый вызов курьера (SCHEDULED): так же считает модель.
    const called = new Map(
      (
        await prisma.deliveryStatusEvent.groupBy({
          by: ["deliveryId"],
          where: { deliveryId: { in: orders.flatMap((o) => o.deliveries.map((d) => d.id)) }, normalizedStatus: "SCHEDULED" },
          _min: { occurredAt: true },
        })
      ).map((e) => [e.deliveryId, e._min.occurredAt])
    );
    const parts: string[] = [];
    for (const f of florists) {
      const mine = orders.filter((o) => o.currentFloristId === f.id && o.deliveries[0]);
      if (!mine.length) continue;
      const jobs: PlanJob[] = mine.map((o) => {
        const w = windowOf(o);
        const from = o.pickupLocationOverride ? normalizeZip(o.pickupLocationOverride.zip) : zipOf.get(f.id) ?? null;
        const to = normalizeZip(o.zip);
        return {
          id: o.id,
          big: isBigOrder(o.items.map((i) => ({ price: Number(i.externalPrice) }))),
          deadline: w?.to ?? DAY_END_MIN,
          windowFrom: w?.from ?? 0,
          driveMin: driveMin(model, from && to ? zipDistanceMiles(from, to) : null),
        };
      });
      const plan = planDay(jobs, {
        lineStart: (f.workStartMin ?? DEFAULT_WORK_START_MIN) + setupMin(model, f.id),
        courierMin: model.courierMin,
        prepMin: (big) => prepMin(model, f.id, big),
      });
      let dayLate = 0, dayRisk = 0;
      for (const it of plan.items) {
        const d = mine.find((o) => o.id === it.id)!.deliveries[0];
        const actual = minutesLA(d.deliveredAt!);
        const calledAt = called.get(d.id);
        if (calledAt) {
          readyDiffs.push(minutesLA(calledAt) - it.readyAt!);
          travelDiffs.push(actual - minutesLA(calledAt) - (it.etaAt! - it.readyAt!));
        }
        const diff = actual - it.etaAt!;
        diffs.push(diff);
        const isLate = actual - it.deadline > LATE_TOLERANCE_MIN;
        total++;
        if (diff > LATE_TOLERANCE_MIN) optimistic++;
        if (isLate) { late++; dayLate++; }
        if (it.risk) { risk++; dayRisk++; }
        if (isLate && it.risk) warned++;
      }
      parts.push(`${f.user.name}: ${mine.length}, опоздали ${dayLate}, риск по плану ${dayRisk}`);
    }
    if (parts.length) console.log(`${day}  ${parts.join(" | ")}`);
  }
  if (!total) {
    console.log("Доставок за период нет.");
  } else {
    const abs = diffs.map(Math.abs);
    console.log(`\nМодель: ${model.sample.measured ? `замер по ${model.sample.deliveries} доставкам с ${model.sample.since}` : "стартовые значения"}.`);
    console.log(`Доставок: ${total}. Факт минус план: медиана ${percentile(diffs, 0.5)!.toFixed(0)} мин, у 80% расхождение не больше ${percentile(abs, 0.8)!.toFixed(0)} мин.`);
    console.log(`Приехали позже плана больше чем на ${LATE_TOLERANCE_MIN} мин: ${optimistic} из ${total} (${Math.round((optimistic / total) * 100)}%).`);
    console.log(`Опоздали по окну: ${late}; расписание видело риск: ${risk}; из опоздавших заранее видно: ${warned}.`);
    const q = (xs: number[]) => [0.2, 0.5, 0.8].map((p) => percentile(xs, p)!.toFixed(0)).join(" / ");
    console.log(`Готовность (вызов курьера) минус план, 20/50/80%: ${q(readyDiffs)} мин.`);
    console.log(`Курьер + дорога минус план, 20/50/80%: ${q(travelDiffs)} мин.`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
