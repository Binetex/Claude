import "dotenv/config";
/**
 * Разовая переприязка уже сохранённых коммуникаций QUO к заказам.
 *
 * Зачем: привязка события считается ОДИН раз, при приёме (ingest.ts). Всё, что не привязалось
 * тогда, остаётся сиротой навсегда — даже если сегодня матчинг ответил бы однозначно. Так
 * получилось после двух причин: неоплаченный дубль заказа делал ответы клиента `ambiguous`
 * (см. NON_ACTIVE_STATUSES в matching.ts) и сообщения, пришедшие раньше самого заказа.
 *
 * Скрипт НИЧЕГО не решает сам: он переспрашивает `matchCommunicationToOrder` — тот же судья,
 * что и в приёме, — и записывает только однозначный результат.
 *
 * Гарантии:
 *  - трогает ТОЛЬКО строки с orderId IS NULL и ignoredAt IS NULL (условие продублировано в
 *    самом UPDATE, а не только в выборке) — уже привязанное и вручную проигнорированное
 *    не перебивается даже при гонке;
 *  - пишет РОВНО два поля: orderId и partyRole;
 *  - `ambiguous`/`no_candidate` оставляет как было — наугад не привязывает;
 *  - по умолчанию DRY-RUN. Запись только с --apply.
 *
 * Запуск:
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/quo-relink-unlinked.ts [--days=90]
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/quo-relink-unlinked.ts --apply
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { toE164 } from "@/lib/phone";
import { findCandidateOrdersByPhone } from "@/integrations/quo/ingest";
import { matchCommunicationToOrder } from "@/integrations/quo/matching";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const APPLY = process.argv.includes("--apply");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 90);

type Plan = { id: string; orderId: string; partyRole: "CUSTOMER" | "RECIPIENT"; label: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5);
  console.log(`Режим: ${APPLY ? "ЗАПИСЬ (--apply)" : "DRY-RUN"}; окно: ${DAYS} дней`);

  const linkedBefore = await prisma.orderCommunication.count({ where: { provider: "QUO", orderId: { not: null } } });
  const unlinkedBefore = await prisma.orderCommunication.count({ where: { provider: "QUO", orderId: null, ignoredAt: null } });
  console.log(`До: привязано ${linkedBefore}, не привязано (без игнора) ${unlinkedBefore}`);

  const orphans = await prisma.orderCommunication.findMany({
    where: { provider: "QUO", orderId: null, ignoredAt: null, createdAt: { gte: since }, externalPhoneNormalized: { not: "" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, direction: true, externalPhoneNormalized: true, providerPhoneNumberId: true, occurredAt: true, createdAt: true },
  });

  // Кандидаты зависят только от (телефон, сайт) — считаем один раз на пару, а не на событие.
  const candCache = new Map<string, Awaited<ReturnType<typeof findCandidateOrdersByPhone>>>();
  const siteCache = new Map<string, { id: string; quoEnabled: boolean } | null>();
  const plan: Plan[] = [];
  const skipped: Record<string, number> = {};
  const bump = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);

  for (const c of orphans) {
    const e164 = toE164(c.externalPhoneNormalized);
    if (!e164) { bump("телефон события не распознан"); continue; }
    if (!c.providerPhoneNumberId) { bump("событие без phoneNumberId"); continue; }

    if (!siteCache.has(c.providerPhoneNumberId)) {
      siteCache.set(
        c.providerPhoneNumberId,
        await prisma.site.findFirst({ where: { quoPhoneNumberId: c.providerPhoneNumberId }, select: { id: true, quoEnabled: true } })
      );
    }
    const site = siteCache.get(c.providerPhoneNumberId)!;
    if (!site) { bump("номер QUO не привязан ни к одному Site"); continue; }
    if (!site.quoEnabled) { bump("магазин выключен (quoEnabled=false)"); continue; }

    const key = `${e164}|${site.id}`;
    if (!candCache.has(key)) candCache.set(key, await findCandidateOrdersByPhone(prisma, e164, site.id));
    const candidates = candCache.get(key)!;

    const m = matchCommunicationToOrder(e164, new Date(c.occurredAt ?? c.createdAt), candidates);
    if (!m.matched) { bump(`матчер не привязывает: ${m.reason}`); continue; }
    plan.push({ id: c.id, orderId: m.orderId, partyRole: m.partyRole, label: `${c.type} ${c.direction} …${e164.slice(-4)}` });
  }

  console.log(`\nПроверено сирот: ${orphans.length}; будет привязано: ${plan.length}`);
  console.log("Оставлены как есть:");
  for (const [k, v] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

  // Группировка по заказам — чтобы глазами увидеть, куда именно поедет переписка.
  const byOrder = new Map<string, Plan[]>();
  for (const p of plan) byOrder.set(p.orderId, [...(byOrder.get(p.orderId) ?? []), p]);
  const numbers = await prisma.order.findMany({
    where: { id: { in: [...byOrder.keys()] } },
    select: { id: true, orderNumber: true, orderStatus: true, paymentStatus: true },
  });
  const nameOf = new Map(numbers.map((o) => [o.id, `${o.orderNumber} (${o.orderStatus}/${o.paymentStatus})`]));
  console.log(`\nЗаказов затронуто: ${byOrder.size}`);
  for (const [orderId, items] of [...byOrder.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
    console.log(`  ${nameOf.get(orderId) ?? orderId}: +${items.length} (${items.map((i) => i.partyRole).join(", ")})`);
  }

  // ИНВАРИАНТ: ни один заказ из плана не должен быть неоплаченным дублем — матчер обязан был
  // предпочесть живой заказ. Проверяем явно: неоплаченные допустимы только если это ЕДИНСТВЕННЫЙ
  // кандидат по телефону (тогда переписка по нему тоже нужна).
  const unpaidTargets = numbers.filter((o) => o.orderStatus === "AWAITING_PAYMENT");
  if (unpaidTargets.length) {
    console.log(`\nВНИМАНИЕ: среди целей есть неоплаченные заказы (${unpaidTargets.map((o) => o.orderNumber).join(", ")}) — проверьте, что у них нет живого двойника.`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN: ничего не записано. Для записи добавьте --apply");
    return;
  }

  let attached = 0;
  for (const p of plan) {
    // Условия orderId/ignoredAt продублированы в UPDATE — защита от гонки с ручной привязкой.
    const res = await prisma.orderCommunication.updateMany({
      where: { id: p.id, orderId: null, ignoredAt: null },
      data: { orderId: p.orderId, partyRole: p.partyRole },
    });
    attached += res.count;
  }

  const linkedAfter = await prisma.orderCommunication.count({ where: { provider: "QUO", orderId: { not: null } } });
  const unlinkedAfter = await prisma.orderCommunication.count({ where: { provider: "QUO", orderId: null, ignoredAt: null } });
  console.log(`\nПривязано: ${attached}`);
  console.log(`После: привязано ${linkedAfter}, не привязано (без игнора) ${unlinkedAfter}`);
  console.log(
    linkedAfter - linkedBefore === attached && unlinkedBefore - unlinkedAfter === attached
      ? "ИНВАРИАНТ ОК: прирост привязанных равен убыли непривязанных и равен числу записей."
      : `ИНВАРИАНТ НАРУШЕН: +${linkedAfter - linkedBefore} привязано, −${unlinkedBefore - unlinkedAfter} непривязано, записей ${attached}. Разберитесь до дальнейших действий.`
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
