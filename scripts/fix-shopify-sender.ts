import "dotenv/config";
/**
 * Разовая починка заказчика у Shopify-заказов, принятых по старому правилу.
 *
 * Старое правило брало имя и телефон из платёжного адреса, а `customer` шёл лишь запасным.
 * Платёжный адрес заполнен почти всегда, поэтому у заказов, где клиент подставил туда
 * данные ПОЛУЧАТЕЛЯ, телефон заказчика не сохранялся вовсе (PAR-41318).
 *
 * Правка приёма чинит только новые заказы и те, по которым придёт вебхук. Этот скрипт
 * догоняет уже принятые: перечитывает заказ в Shopify и применяет то же самое правило —
 * своей логики здесь нет, вызывается общий `extractSenderIdentity`.
 *
 *   npx tsx scripts/fix-shopify-sender.ts                      # DRY-RUN
 *   npx tsx scripts/fix-shopify-sender.ts --live --confirm     # записать
 *   npx tsx scripts/fix-shopify-sender.ts --order PAR-41318    # один заказ
 *
 * DRY-RUN по умолчанию. Правятся РОВНО ДВА поля — `senderName` и `senderPhone`.
 *
 * ЧТО НЕ ПРАВИТСЯ — и это проверяется, а не подразумевается: получатель, адрес и деньги
 * снимаются до записи и сверяются после. Заказ, у которого сошлось не всё, считается
 * нарушением инварианта и печатается отдельно.
 */
import { prisma } from "@/lib/db";
import { resolveShopifyAccessToken } from "@/integrations/shopify/customApp/credentials";
import { extractSenderIdentity } from "@/integrations/shopify/orderFields";
import { toE164 } from "@/lib/phone";

const args = process.argv.slice(2);
const live = args.includes("--live") && args.includes("--confirm");
const only = args.includes("--order") ? args[args.indexOf("--order") + 1] : undefined;

type ShopifyOrderPayload = Parameters<typeof extractSenderIdentity>[0];

/** Поля, которые скрипт не имеет права изменить. Снимок до и после — доказательство. */
const UNTOUCHED = {
  recipientName: true, recipientPhone: true, recipientEmail: true,
  addressLine: true, apartment: true, city: true, zip: true,
  itemsTotal: true, tax: true, tip: true, discount: true,
  deliveryCustomerCost: true, customerTotal: true, floristTotal: true,
} as const;

type Candidate = {
  id: string;
  orderNumber: string;
  oldName: string;
  newName: string;
  oldPhone: string;
  newPhone: string;
  recipientPhone: string;
  source: string;
};

const fingerprint = (o: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.keys(UNTOUCHED).map((k) => [k, String(o[k] ?? "")])));

async function main() {
  const orders = await prisma.order.findMany({
    where: { platform: "SHOPIFY", externalId: { not: null }, ...(only ? { orderNumber: only } : {}) },
    select: { id: true, orderNumber: true, externalId: true, siteId: true, senderName: true, senderPhone: true, ...UNTOUCHED },
    orderBy: { externalCreatedAt: "desc" },
  });
  console.log(`Shopify-заказов к проверке: ${orders.length}\n`);

  const bySite = new Map<string, typeof orders>();
  for (const o of orders) bySite.set(o.siteId, [...(bySite.get(o.siteId) ?? []), o]);

  const planned: Candidate[] = [];
  const skipped: { orderNumber: string; reason: string }[] = [];
  const before = new Map<string, string>();

  for (const [siteId, siteOrders] of bySite) {
    let creds: { shopDomain: string; accessToken: string };
    try {
      creds = await resolveShopifyAccessToken(siteId);
    } catch (e) {
      for (const o of siteOrders) skipped.push({ orderNumber: o.orderNumber, reason: `нет доступа к магазину: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    for (const o of siteOrders) {
      const r = await fetch(`https://${creds.shopDomain}/admin/api/2025-01/orders/${o.externalId}.json`, {
        headers: { "X-Shopify-Access-Token": creds.accessToken },
      });
      if (!r.ok) {
        // 404 у Shopify — заказ старше 60 дней без scope read_all_orders. Не чиним.
        skipped.push({ orderNumber: o.orderNumber, reason: `Shopify ${r.status} (старше 60 дней — нет доступа)` });
        continue;
      }
      const { order } = (await r.json()) as { order: ShopifyOrderPayload };
      const next = extractSenderIdentity(order);

      // 1) телефон должен реально отличаться ПОСЛЕ нормализации
      if (toE164(next.senderPhone) === toE164(o.senderPhone)) {
        if (next.senderName !== o.senderName) skipped.push({ orderNumber: o.orderNumber, reason: "телефон тот же — имя одно не правим" });
        continue;
      }
      // 2) источник — только сам заказчик, платёжный адрес не основание
      if (next.senderPhoneSource !== "order" && next.senderPhoneSource !== "customer") {
        skipped.push({ orderNumber: o.orderNumber, reason: `источник телефона «${next.senderPhoneSource}», а не order/customer` });
        continue;
      }
      // 3) пустым номером затирать нельзя
      if (!next.senderPhone.trim()) {
        skipped.push({ orderNumber: o.orderNumber, reason: "новый телефон пустой" });
        continue;
      }

      before.set(o.id, fingerprint(o));
      planned.push({
        id: o.id,
        orderNumber: o.orderNumber,
        oldName: o.senderName,
        newName: next.senderName,
        oldPhone: o.senderPhone || "—",
        newPhone: next.senderPhone,
        recipientPhone: o.recipientPhone || "—",
        source: next.senderPhoneSource,
      });
    }
  }

  console.log(`К изменению: ${planned.length}\n`);
  for (const p of planned) {
    const nameChanged = p.oldName !== p.newName;
    console.log(`  ${p.orderNumber}${nameChanged ? "   ★ меняется и имя" : ""}`);
    console.log(`    имя заказчика:      ${p.oldName}  →  ${p.newName}`);
    console.log(`    телефон заказчика:  ${p.oldPhone}  →  ${p.newPhone}   (источник: ${p.source})`);
    console.log(`    телефон получателя: ${p.recipientPhone}   (не меняется)`);
  }

  if (skipped.length) {
    console.log(`\nПропущено: ${skipped.length}`);
    const byReason = new Map<string, string[]>();
    for (const s of skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.orderNumber]);
    for (const [reason, list] of byReason) console.log(`  ${reason} — ${list.length}: ${list.slice(0, 8).join(", ")}${list.length > 8 ? " …" : ""}`);
  }

  if (!live) {
    console.log("\nDRY-RUN. Для записи: --live --confirm");
    return;
  }

  for (const p of planned) {
    await prisma.order.update({ where: { id: p.id }, data: { senderName: p.newName, senderPhone: p.newPhone } });
  }
  console.log(`\nОбновлено: ${planned.length}`);

  // ── Проверки после записи ────────────────────────────────────────────────────────────
  const after = await prisma.order.findMany({
    where: { id: { in: planned.map((p) => p.id) } },
    select: { id: true, orderNumber: true, senderName: true, senderPhone: true, ...UNTOUCHED },
  });

  const drifted = after.filter((a) => fingerprint(a) !== before.get(a.id));
  const swapped = after.filter((a) => {
    const p = planned.find((x) => x.id === a.id)!;
    // Перепутать местами — значит записать в заказчика телефон получателя или наоборот.
    return a.senderPhone !== p.newPhone || toE164(a.recipientPhone) !== toE164(p.recipientPhone);
  });

  console.log(`\nПроверка: получатель/адрес/деньги изменились у ${drifted.length} (ожидается 0)`);
  console.log(`Проверка: телефоны перепутаны местами у ${swapped.length} (ожидается 0)`);
  for (const d of drifted) console.error(`  ИЗМЕНИЛОСЬ ЛИШНЕЕ: ${d.orderNumber}`);
  for (const s of swapped) console.error(`  ПЕРЕПУТАНЫ ТЕЛЕФОНЫ: ${s.orderNumber}`);

  const nameChanged = planned.filter((p) => p.oldName !== p.newName);
  console.log(`\nИз них изменилось и имя заказчика: ${nameChanged.length}`);
  for (const p of nameChanged) console.log(`  ${p.orderNumber}: ${p.oldName} → ${p.newName}`);

  if (drifted.length || swapped.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
